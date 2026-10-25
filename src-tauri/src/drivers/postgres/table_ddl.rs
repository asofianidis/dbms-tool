//! "Script as CREATE" for PostgreSQL tables, rebuilt from the catalog the way
//! pg_dump does it: identity and generated columns, every constraint kind with
//! its flags, partitioning and inheritance, storage options, indexes that no
//! constraint owns, row security, comments and triggers. Names and literals
//! are quoted by the server (`quote_ident`, `quote_literal`, `format('%I')`).

use tokio_postgres::Row;
use tokio_postgres::types::Oid;

use crate::error::AppResult;

use super::{PgSession, compat};

/// Columns: oid, relkind, relpersistence, qualified name, parent (partitions),
/// partition bound, partition key, INHERITS parents, access method, reloptions,
/// TOAST reloptions, tablespace, comment, row security, forced row security,
/// replica identity, replica identity index.
const TABLE_SQL: &str = "SELECT c.oid, c.relkind::text, c.relpersistence::text, \
       format('%I.%I', n.nspname, c.relname), \
       (SELECT format('%I.%I', pn.nspname, p.relname) FROM pg_inherits i \
          JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = p.relnamespace \
          WHERE i.inhrelid = c.oid AND c.relispartition), \
       pg_get_expr(c.relpartbound, c.oid, true), \
       CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END, \
       ARRAY(SELECT format('%I.%I', pn.nspname, p.relname) FROM pg_inherits i \
          JOIN pg_class p ON p.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = p.relnamespace \
          WHERE i.inhrelid = c.oid AND NOT c.relispartition ORDER BY i.inhseqno), \
       am.amname::text, coalesce(c.reloptions, '{}'), coalesce(t.reloptions, '{}'), \
       quote_ident(ts.spcname), quote_literal(obj_description(c.oid, 'pg_class')), \
       c.relrowsecurity, c.relforcerowsecurity, c.relreplident::text, \
       (SELECT quote_ident(ic.relname) FROM pg_index x JOIN pg_class ic ON ic.oid = x.indexrelid \
          WHERE x.indrelid = c.oid AND x.indisreplident) \
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
     LEFT JOIN pg_am am ON am.oid = c.relam \
     LEFT JOIN pg_class t ON t.oid = c.reltoastrelid \
     LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace \
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')";

/// Columns: name (quoted, raw), type, not null, identity, generated, default,
/// collation (when it isn't the type's), comment, local, the partition parent's
/// not null and default, and the sequence the column owns (serial or identity):
/// qualified name, raw name, type, start, increment, min, max, cache, cycle,
/// and whether the default is `nextval` of it.
fn columns_sql(version: i32) -> String {
    format!(
        "SELECT quote_ident(a.attname), a.attname::text, \
       format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity::text, \
       {}, pg_get_expr(d.adbin, d.adrelid, true), \
       CASE WHEN a.attcollation <> t.typcollation AND co.oid IS NOT NULL THEN format('%I.%I', cn.nspname, co.collname) END, \
       quote_literal(col_description(a.attrelid, a.attnum)), a.attislocal, \
       pa.attnotnull, pg_get_expr(pd.adbin, pd.adrelid, true), \
       CASE WHEN sq.oid IS NOT NULL THEN format('%I.%I', sq.nspname, sq.relname) END, sq.relname::text, s.seqtypid::regtype::text, \
       s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle, \
       pg_get_expr(d.adbin, d.adrelid) = format('nextval(%L::regclass)', sq.oid::regclass::text) \
     FROM pg_attribute a \
     JOIN pg_class rc ON rc.oid = a.attrelid \
     JOIN pg_type t ON t.oid = a.atttypid \
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
     LEFT JOIN pg_collation co ON co.oid = a.attcollation \
     LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace \
     LEFT JOIN pg_inherits pi ON pi.inhrelid = rc.oid AND rc.relispartition \
     LEFT JOIN pg_attribute pa ON pa.attrelid = pi.inhparent AND pa.attname = a.attname \
     LEFT JOIN pg_attrdef pd ON pd.adrelid = pa.attrelid AND pd.adnum = pa.attnum \
     LEFT JOIN LATERAL (SELECT sc.oid, sc.relname, sn.nspname FROM pg_depend dep \
          JOIN pg_class sc ON sc.oid = dep.objid AND sc.relkind = 'S' \
          JOIN pg_namespace sn ON sn.oid = sc.relnamespace \
          WHERE dep.classid = 'pg_class'::regclass AND dep.refclassid = 'pg_class'::regclass \
            AND dep.refobjid = a.attrelid AND dep.refobjsubid = a.attnum AND dep.deptype IN ('a', 'i') \
          LIMIT 1) sq ON true \
     LEFT JOIN pg_sequence s ON s.seqrelid = sq.oid \
     WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
        compat::generated_kind(version)
    )
}

/// The table's own constraints (not inherited or cloned onto a partition), in
/// the order pg_dump lists them. NOT NULL is part of the column.
fn constraints_sql(version: i32) -> String {
    format!(
        "SELECT quote_ident(con.conname), con.contype::text, \
       pg_get_constraintdef(con.oid, true), NOT con.convalidated, \
       quote_literal(obj_description(con.oid, 'pg_constraint')) \
     FROM pg_constraint con \
     WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'x', 'c', 'f') \
       AND con.conislocal AND {} \
     ORDER BY array_position(ARRAY['p', 'u', 'x', 'c', 'f'], con.contype::text), con.conname",
        compat::constraint_not_cloned(version)
    )
}

/// Indexes no constraint owns and that aren't a partition's copy of a parent index.
const INDEXES_SQL: &str = "SELECT pg_get_indexdef(x.indexrelid, 0, true), \
       format('%I.%I', n.nspname, i.relname), quote_ident(ts.spcname), \
       quote_literal(obj_description(x.indexrelid, 'pg_class')) \
     FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid \
     JOIN pg_namespace n ON n.oid = i.relnamespace \
     LEFT JOIN pg_tablespace ts ON ts.oid = i.reltablespace \
     WHERE x.indrelid = $1 \
       AND NOT EXISTS (SELECT FROM pg_constraint con WHERE con.conindid = x.indexrelid \
         AND con.conrelid = x.indrelid AND con.contype IN ('p', 'u', 'x')) \
       AND NOT EXISTS (SELECT FROM pg_inherits h WHERE h.inhrelid = x.indexrelid) \
     ORDER BY i.relname";

/// User triggers, without the copies a partitioned table's triggers get (PG 13+).
fn triggers_sql(version: i32) -> String {
    format!(
        "SELECT pg_get_triggerdef(t.oid, true), quote_ident(t.tgname), \
       t.tgenabled::text, quote_literal(obj_description(t.oid, 'pg_trigger')) \
     FROM pg_trigger t WHERE t.tgrelid = $1 AND NOT t.tgisinternal AND {} \
     ORDER BY t.tgname",
        compat::trigger_not_cloned(version)
    )
}

const POLICIES_SQL: &str = "SELECT quote_ident(p.polname), p.polpermissive, p.polcmd::text, \
       CASE WHEN p.polroles = '{0}' THEN 'PUBLIC' ELSE (SELECT string_agg(quote_ident(r.rolname), ', ' \
         ORDER BY r.rolname) FROM pg_roles r WHERE r.oid = ANY (p.polroles)) END, \
       pg_get_expr(p.polqual, p.polrelid, true), pg_get_expr(p.polwithcheck, p.polrelid, true) \
     FROM pg_policy p WHERE p.polrelid = $1 ORDER BY p.polname";

#[derive(Debug, Default)]
pub(crate) struct Table {
    /// 'r' or 'p' (partitioned)
    pub kind: String,
    pub unlogged: bool,
    pub name: String,
    /// Partitions: parent and `FOR VALUES …` / `DEFAULT`
    pub partition_of: Option<(String, String)>,
    pub partition_key: Option<String>,
    pub inherits: Vec<String>,
    pub access_method: Option<String>,
    pub options: Vec<String>,
    pub toast_options: Vec<String>,
    pub tablespace: Option<String>,
    pub comment: Option<String>,
    pub row_security: bool,
    pub force_row_security: bool,
    pub replica_identity: String,
    pub replica_index: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct Sequence {
    pub name: String,
    pub raw_name: String,
    pub data_type: String,
    pub start: i64,
    pub increment: i64,
    pub min: i64,
    pub max: i64,
    pub cache: i64,
    pub cycle: bool,
}

#[derive(Debug, Default)]
pub(crate) struct Column {
    pub name: String,
    pub raw_name: String,
    pub data_type: String,
    pub not_null: bool,
    /// "" | 'a' (ALWAYS) | 'd' (BY DEFAULT)
    pub identity: String,
    /// "" | 's' (stored) | 'v' (virtual, PG 18)
    pub generated: String,
    pub default: Option<String>,
    pub collation: Option<String>,
    pub comment: Option<String>,
    pub local: bool,
    pub parent_not_null: Option<bool>,
    pub parent_default: Option<String>,
    /// Sequence owned by the column (serial or identity)
    pub sequence: Option<Sequence>,
    /// The default is `nextval` of [`Column::sequence`]
    pub nextval_default: bool,
}

#[derive(Debug, Default)]
pub(crate) struct Constraint {
    pub name: String,
    pub definition: String,
    pub not_valid: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct Index {
    pub definition: String,
    pub name: String,
    pub tablespace: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct Trigger {
    pub definition: String,
    pub name: String,
    /// tgenabled: O (enabled), D, R (replica), A (always)
    pub enabled: String,
    pub comment: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct Policy {
    pub name: String,
    pub permissive: bool,
    pub command: String,
    pub roles: String,
    pub using: Option<String>,
    pub with_check: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct TableDdl {
    pub table: Table,
    pub columns: Vec<Column>,
    pub constraints: Vec<Constraint>,
    pub indexes: Vec<Index>,
    pub triggers: Vec<Trigger>,
    pub policies: Vec<Policy>,
}

impl PgSession {
    /// CREATE TABLE script for an ordinary or partitioned table; `None` if
    /// there's no such table.
    pub(super) async fn table_definition(
        &self,
        schema: &str,
        name: &str,
    ) -> AppResult<Option<String>> {
        let rows = self.strings(TABLE_SQL, &[&schema, &name]).await?;
        let Some(r) = rows.first() else {
            return Ok(None);
        };
        let oid: Oid = r.get(0);
        let table = Table {
            kind: r.get(1),
            unlogged: r.get::<_, String>(2) == "u",
            name: r.get(3),
            partition_of: r
                .get::<_, Option<String>>(4)
                .zip(r.get::<_, Option<String>>(5)),
            partition_key: r.get(6),
            inherits: r.get(7),
            access_method: r.get(8),
            options: r.get(9),
            toast_options: r.get(10),
            tablespace: r.get(11),
            comment: r.get(12),
            row_security: r.get(13),
            force_row_security: r.get(14),
            replica_identity: r.get(15),
            replica_index: r.get(16),
        };
        let columns = self
            .strings(&columns_sql(self.version), &[&oid])
            .await?
            .iter()
            .map(column)
            .collect();
        let constraints = self
            .strings(&constraints_sql(self.version), &[&oid])
            .await?
            .iter()
            .map(|r| Constraint {
                name: r.get(0),
                definition: r.get(2),
                not_valid: r.get(3),
                comment: r.get(4),
            })
            .collect();
        let indexes = self
            .strings(INDEXES_SQL, &[&oid])
            .await?
            .iter()
            .map(|r| Index {
                definition: r.get(0),
                name: r.get(1),
                tablespace: r.get(2),
                comment: r.get(3),
            })
            .collect();
        let triggers = self
            .strings(&triggers_sql(self.version), &[&oid])
            .await?
            .iter()
            .map(|r| Trigger {
                definition: r.get(0),
                name: r.get(1),
                enabled: r.get(2),
                comment: r.get(3),
            })
            .collect();
        let policies = self
            .strings(POLICIES_SQL, &[&oid])
            .await?
            .iter()
            .map(|r| Policy {
                name: r.get(0),
                permissive: r.get(1),
                command: r.get(2),
                roles: r.get::<_, Option<String>>(3).unwrap_or_default(),
                using: r.get(4),
                with_check: r.get(5),
            })
            .collect();
        Ok(Some(
            TableDdl {
                table,
                columns,
                constraints,
                indexes,
                triggers,
                policies,
            }
            .script(),
        ))
    }
}

fn column(r: &Row) -> Column {
    let sequence = r.get::<_, Option<String>>(14).map(|data_type| Sequence {
        name: r.get(12),
        raw_name: r.get(13),
        data_type,
        start: r.get(15),
        increment: r.get(16),
        min: r.get(17),
        max: r.get(18),
        cache: r.get(19),
        cycle: r.get(20),
    });
    Column {
        name: r.get(0),
        raw_name: r.get(1),
        data_type: r.get(2),
        not_null: r.get(3),
        identity: r.get(4),
        generated: r.get(5),
        default: r.get(6),
        collation: r.get(7),
        comment: r.get(8),
        local: r.get(9),
        parent_not_null: r.get(10),
        parent_default: r.get(11),
        sequence,
        nextval_default: r.get::<_, Option<bool>>(21).unwrap_or(false),
    }
}

/// Range of a sequence type, for telling default options apart.
fn type_range(data_type: &str) -> (i64, i64) {
    match data_type {
        "smallint" => (i16::MIN.into(), i16::MAX.into()),
        "integer" => (i32::MIN.into(), i32::MAX.into()),
        _ => (i64::MIN, i64::MAX),
    }
}

impl Sequence {
    /// Options that differ from what `CREATE SEQUENCE` picks for its type.
    fn options(&self) -> Vec<String> {
        let (low, high) = type_range(&self.data_type);
        let ascending = self.increment > 0;
        let (min, max) = if ascending { (1, high) } else { (low, -1) };
        let start = if ascending { self.min } else { self.max };
        let mut out = Vec::new();
        if self.start != start {
            out.push(format!("START WITH {}", self.start));
        }
        if self.increment != 1 {
            out.push(format!("INCREMENT BY {}", self.increment));
        }
        if self.min != min {
            out.push(format!("MINVALUE {}", self.min));
        }
        if self.max != max {
            out.push(format!("MAXVALUE {}", self.max));
        }
        if self.cache != 1 {
            out.push(format!("CACHE {}", self.cache));
        }
        if self.cycle {
            out.push("CYCLE".into());
        }
        out
    }
}

impl Column {
    /// The name PostgreSQL gives a serial or identity sequence it creates
    /// (ignoring truncation and collisions, where it's then spelled out).
    fn default_sequence_name(&self, table: &str) -> bool {
        let raw_table = table_raw_name(table);
        self.sequence
            .as_ref()
            .is_some_and(|s| s.raw_name == format!("{raw_table}_{}_seq", self.raw_name))
    }

    /// `serial`, `bigserial` or `smallserial` when the column is exactly what
    /// that shorthand creates.
    fn serial_type(&self, table: &str) -> Option<&'static str> {
        let seq = self.sequence.as_ref()?;
        if !self.identity.is_empty() || !self.nextval_default || !self.not_null {
            return None;
        }
        if seq.data_type != self.data_type
            || !seq.options().is_empty()
            || !self.default_sequence_name(table)
        {
            return None;
        }
        match self.data_type.as_str() {
            "smallint" => Some("smallserial"),
            "integer" => Some("serial"),
            "bigint" => Some("bigserial"),
            _ => None,
        }
    }

    /// A sequence owned by the column that isn't created by the column itself.
    fn owned_sequence(&self, table: &str) -> Option<&Sequence> {
        if !self.identity.is_empty() || self.serial_type(table).is_some() {
            return None;
        }
        self.sequence.as_ref()
    }

    fn definition(&self, table: &str) -> String {
        let serial = self.serial_type(table);
        let mut s = format!("{} {}", self.name, serial.unwrap_or(&self.data_type));
        if let Some(collation) = &self.collation {
            s.push_str(&format!(" COLLATE {collation}"));
        }
        match (self.generated.as_str(), &self.default) {
            ("s", Some(expr)) => s.push_str(&format!(" GENERATED ALWAYS AS ({expr}) STORED")),
            ("v", Some(expr)) => s.push_str(&format!(" GENERATED ALWAYS AS ({expr}) VIRTUAL")),
            (_, Some(expr)) if serial.is_none() => s.push_str(&format!(" DEFAULT {expr}")),
            _ => {}
        }
        if let Some(how) = match self.identity.as_str() {
            "a" => Some("ALWAYS"),
            "d" => Some("BY DEFAULT"),
            _ => None,
        } {
            s.push_str(&format!(" GENERATED {how} AS IDENTITY"));
            let mut options = Vec::new();
            if let Some(seq) = &self.sequence {
                if !self.default_sequence_name(table) {
                    options.push(format!("SEQUENCE NAME {}", seq.name));
                }
                options.extend(seq.options());
            }
            if !options.is_empty() {
                s.push_str(&format!(" ({})", options.join(" ")));
            }
        }
        if self.not_null {
            s.push_str(" NOT NULL");
        }
        s
    }

    /// `col WITH OPTIONS …` inside `PARTITION OF`, when the partition differs
    /// from its parent.
    fn partition_options(&self) -> Option<String> {
        let mut s = String::new();
        if self.default.is_some() && self.default != self.parent_default {
            s.push_str(&format!(
                " DEFAULT {}",
                self.default.as_deref().unwrap_or("")
            ));
        }
        if self.not_null && self.parent_not_null != Some(true) {
            s.push_str(" NOT NULL");
        }
        (!s.is_empty()).then(|| format!("{} WITH OPTIONS{s}", self.name))
    }
}

/// `schema.name` (both possibly quoted) → `name` as stored in the catalog.
fn table_raw_name(qualified: &str) -> String {
    // The table part follows the last dot outside quotes
    let mut in_quotes = false;
    let mut start = 0;
    for (i, ch) in qualified.char_indices() {
        match ch {
            '"' => in_quotes = !in_quotes,
            '.' if !in_quotes => start = i + 1,
            _ => {}
        }
    }
    let name = &qualified[start..];
    match name.strip_prefix('"').and_then(|n| n.strip_suffix('"')) {
        Some(inner) => inner.replace("\"\"", "\""),
        None => name.to_string(),
    }
}

/// `fillfactor=70` → `fillfactor=70`; values that aren't a plain word or
/// number are quoted.
fn storage_option(option: &str, prefix: &str) -> String {
    let (key, value) = option.split_once('=').unwrap_or((option, ""));
    let plain = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if plain {
        format!("{prefix}{key}={value}")
    } else {
        format!("{prefix}{key}='{}'", value.replace('\'', "''"))
    }
}

impl TableDdl {
    pub(crate) fn script(&self) -> String {
        let t = &self.table;
        let name = &t.name;
        let mut before = Vec::new();
        let mut after = Vec::new();

        let mut elements = Vec::new();
        for c in &self.columns {
            if t.partition_of.is_some() {
                elements.extend(c.partition_options());
                continue;
            }
            if !c.local {
                continue;
            }
            if let Some(seq) = c.owned_sequence(name) {
                let options = seq.options();
                before.push(format!(
                    "CREATE SEQUENCE {} AS {}{}{};",
                    seq.name,
                    seq.data_type,
                    if options.is_empty() { "" } else { " " },
                    options.join(" ")
                ));
                after.push(format!(
                    "ALTER SEQUENCE {} OWNED BY {name}.{};",
                    seq.name, c.name
                ));
            }
            elements.push(c.definition(name));
        }
        for con in &self.constraints {
            if con.not_valid {
                after.push(format!(
                    "ALTER TABLE {name} ADD CONSTRAINT {} {};",
                    con.name, con.definition
                ));
            } else {
                elements.push(format!("CONSTRAINT {} {}", con.name, con.definition));
            }
        }
        let body = if elements.is_empty() {
            String::new()
        } else {
            format!("\n  {}\n", elements.join(",\n  "))
        };

        let mut create = format!(
            "CREATE {}TABLE {name}",
            if t.unlogged { "UNLOGGED " } else { "" }
        );
        match &t.partition_of {
            Some((parent, bound)) => {
                create.push_str(&format!(" PARTITION OF {parent}"));
                if !body.is_empty() {
                    create.push_str(&format!(" ({body})"));
                }
                create.push_str(&format!("\n{bound}"));
            }
            None => {
                create.push_str(&format!(" ({body})"));
                if !t.inherits.is_empty() {
                    create.push_str(&format!("\nINHERITS ({})", t.inherits.join(", ")));
                }
            }
        }
        if let Some(key) = &t.partition_key {
            create.push_str(&format!("\nPARTITION BY {key}"));
        }
        if let Some(am) = t.access_method.as_deref().filter(|am| *am != "heap") {
            create.push_str(&format!("\nUSING {am}"));
        }
        let options: Vec<String> = t
            .options
            .iter()
            .map(|o| storage_option(o, ""))
            .chain(t.toast_options.iter().map(|o| storage_option(o, "toast.")))
            .collect();
        if !options.is_empty() {
            create.push_str(&format!("\nWITH ({})", options.join(", ")));
        }
        if let Some(ts) = &t.tablespace {
            create.push_str(&format!("\nTABLESPACE {ts}"));
        }
        create.push(';');

        let mut statements = before;
        statements.push(create);
        statements.extend(after);

        for ix in &self.indexes {
            let mut definition = ix.definition.clone();
            // A partitioned table's index is listed `ON ONLY`, which wouldn't
            // build it on the partitions
            if t.kind == "p" {
                definition = definition.replacen(" ON ONLY ", " ON ", 1);
            }
            statements.push(format!("{definition};"));
            if let Some(ts) = &ix.tablespace {
                statements.push(format!("ALTER INDEX {} SET TABLESPACE {ts};", ix.name));
            }
        }

        match (t.replica_identity.as_str(), &t.replica_index) {
            ("n", _) => statements.push(format!("ALTER TABLE {name} REPLICA IDENTITY NOTHING;")),
            ("f", _) => statements.push(format!("ALTER TABLE {name} REPLICA IDENTITY FULL;")),
            ("i", Some(index)) => statements.push(format!(
                "ALTER TABLE {name} REPLICA IDENTITY USING INDEX {index};"
            )),
            _ => {}
        }
        if t.row_security {
            statements.push(format!("ALTER TABLE {name} ENABLE ROW LEVEL SECURITY;"));
        }
        if t.force_row_security {
            statements.push(format!("ALTER TABLE {name} FORCE ROW LEVEL SECURITY;"));
        }
        for p in &self.policies {
            let mut s = format!("CREATE POLICY {} ON {name}", p.name);
            if !p.permissive {
                s.push_str(" AS RESTRICTIVE");
            }
            let command = match p.command.as_str() {
                "r" => "SELECT",
                "a" => "INSERT",
                "w" => "UPDATE",
                "d" => "DELETE",
                _ => "ALL",
            };
            s.push_str(&format!(" FOR {command} TO {}", p.roles));
            if let Some(using) = &p.using {
                s.push_str(&format!(" USING ({using})"));
            }
            if let Some(check) = &p.with_check {
                s.push_str(&format!(" WITH CHECK ({check})"));
            }
            s.push(';');
            statements.push(s);
        }

        let mut comments = Vec::new();
        if let Some(comment) = &t.comment {
            comments.push(format!("COMMENT ON TABLE {name} IS {comment};"));
        }
        for c in &self.columns {
            if let Some(comment) = &c.comment {
                comments.push(format!("COMMENT ON COLUMN {name}.{} IS {comment};", c.name));
            }
        }
        for con in &self.constraints {
            if let Some(comment) = &con.comment {
                comments.push(format!(
                    "COMMENT ON CONSTRAINT {} ON {name} IS {comment};",
                    con.name
                ));
            }
        }
        for ix in &self.indexes {
            if let Some(comment) = &ix.comment {
                comments.push(format!("COMMENT ON INDEX {} IS {comment};", ix.name));
            }
        }
        if !comments.is_empty() {
            statements.push(comments.join("\n"));
        }

        for tr in &self.triggers {
            statements.push(format!("{};", tr.definition));
            let state = match tr.enabled.as_str() {
                "D" => Some("DISABLE"),
                "R" => Some("ENABLE REPLICA"),
                "A" => Some("ENABLE ALWAYS"),
                _ => None,
            };
            if let Some(state) = state {
                statements.push(format!("ALTER TABLE {name} {state} TRIGGER {};", tr.name));
            }
            if let Some(comment) = &tr.comment {
                statements.push(format!(
                    "COMMENT ON TRIGGER {} ON {name} IS {comment};",
                    tr.name
                ));
            }
        }
        statements.join("\n\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Option<String> {
        Some(v.into())
    }

    fn col(name: &str, data_type: &str) -> Column {
        Column {
            name: name.into(),
            raw_name: name.into(),
            data_type: data_type.into(),
            local: true,
            ..Default::default()
        }
    }

    fn seq(name: &str, data_type: &str) -> Sequence {
        let (_, max) = type_range(data_type);
        Sequence {
            name: format!("public.{name}"),
            raw_name: name.into(),
            data_type: data_type.into(),
            start: 1,
            increment: 1,
            min: 1,
            max,
            cache: 1,
            cycle: false,
        }
    }

    fn table(name: &str) -> Table {
        Table {
            kind: "r".into(),
            name: name.into(),
            replica_identity: "d".into(),
            ..Default::default()
        }
    }

    #[test]
    fn identity_generated_and_defaults() {
        let mut id = col("id", "integer");
        id.not_null = true;
        id.identity = "a".into();
        id.sequence = Some(Sequence {
            start: 100,
            increment: 5,
            cache: 10,
            ..seq("t_id_seq", "integer")
        });
        let mut b = col("b", "integer");
        b.generated = "s".into();
        b.default = s("a * 2");
        let mut code = col("code", "text");
        code.collation = s("pg_catalog.\"C\"");
        code.default = s("'x'::text");
        code.not_null = true;
        let ddl = TableDdl {
            table: table("public.t"),
            columns: vec![id, b, code],
            constraints: vec![Constraint {
                name: "t_pkey".into(),
                definition: "PRIMARY KEY (id)".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(
            ddl.script(),
            "CREATE TABLE public.t (\n  \
             id integer GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 5 CACHE 10) NOT NULL,\n  \
             b integer GENERATED ALWAYS AS (a * 2) STORED,\n  \
             code text COLLATE pg_catalog.\"C\" DEFAULT 'x'::text NOT NULL,\n  \
             CONSTRAINT t_pkey PRIMARY KEY (id)\n);"
        );
    }

    #[test]
    fn identity_with_renamed_or_descending_sequence() {
        let mut id = col("id", "bigint");
        id.identity = "d".into();
        id.not_null = true;
        id.sequence = Some(seq("ids", "bigint"));
        assert_eq!(
            id.definition("public.t"),
            "id bigint GENERATED BY DEFAULT AS IDENTITY (SEQUENCE NAME public.ids) NOT NULL"
        );
        id.sequence = Some(Sequence {
            start: -1,
            increment: -1,
            min: i64::MIN,
            max: -1,
            ..seq("t_id_seq", "bigint")
        });
        assert_eq!(
            id.definition("public.t"),
            "id bigint GENERATED BY DEFAULT AS IDENTITY (INCREMENT BY -1) NOT NULL"
        );
    }

    #[test]
    fn serial_columns() {
        let mut id = col("id", "integer");
        id.not_null = true;
        id.default = s("nextval('t_id_seq'::regclass)");
        id.nextval_default = true;
        id.sequence = Some(seq("t_id_seq", "integer"));
        assert_eq!(id.definition("public.t"), "id serial NOT NULL");
        assert_eq!(id.definition("\"Odd\".t"), "id serial NOT NULL");

        // A changed sequence is created separately and owned afterwards
        id.sequence.as_mut().unwrap().increment = 3;
        let ddl = TableDdl {
            table: table("public.t"),
            columns: vec![id],
            ..Default::default()
        };
        assert_eq!(
            ddl.script(),
            "CREATE SEQUENCE public.t_id_seq AS integer INCREMENT BY 3;\n\n\
             CREATE TABLE public.t (\n  id integer DEFAULT nextval('t_id_seq'::regclass) NOT NULL\n);\n\n\
             ALTER SEQUENCE public.t_id_seq OWNED BY public.t.id;"
        );
    }

    #[test]
    fn constraints_indexes_and_options() {
        let ddl = TableDdl {
            table: Table {
                unlogged: true,
                options: vec!["fillfactor=70".into(), "odd=a b".into()],
                toast_options: vec!["autovacuum_enabled=false".into()],
                tablespace: s("fast"),
                comment: s("'it''s'"),
                row_security: true,
                ..table("app.t")
            },
            columns: vec![Column {
                comment: s("'c'"),
                ..col("a", "integer")
            }],
            constraints: vec![
                Constraint {
                    name: "no_overlap".into(),
                    definition: "EXCLUDE USING gist (a WITH =)".into(),
                    comment: s("'x'"),
                    ..Default::default()
                },
                Constraint {
                    name: "cap".into(),
                    definition: "CHECK (a < 10) NOT VALID".into(),
                    not_valid: true,
                    ..Default::default()
                },
            ],
            indexes: vec![Index {
                definition: "CREATE INDEX t_a ON app.t USING btree (a) WHERE a > 0".into(),
                name: "app.t_a".into(),
                tablespace: s("fast"),
                comment: s("'i'"),
            }],
            triggers: vec![Trigger {
                definition: "CREATE TRIGGER tr AFTER INSERT ON app.t FOR EACH STATEMENT EXECUTE FUNCTION f()".into(),
                name: "tr".into(),
                enabled: "D".into(),
                comment: None,
            }],
            policies: vec![Policy {
                name: "p".into(),
                permissive: false,
                command: "r".into(),
                roles: "PUBLIC".into(),
                using: s("a > 0"),
                with_check: None,
            }],
        };
        assert_eq!(
            ddl.script(),
            "CREATE UNLOGGED TABLE app.t (\n  a integer,\n  CONSTRAINT no_overlap EXCLUDE USING gist (a WITH =)\n)\n\
             WITH (fillfactor=70, odd='a b', toast.autovacuum_enabled=false)\nTABLESPACE fast;\n\n\
             ALTER TABLE app.t ADD CONSTRAINT cap CHECK (a < 10) NOT VALID;\n\n\
             CREATE INDEX t_a ON app.t USING btree (a) WHERE a > 0;\n\n\
             ALTER INDEX app.t_a SET TABLESPACE fast;\n\n\
             ALTER TABLE app.t ENABLE ROW LEVEL SECURITY;\n\n\
             CREATE POLICY p ON app.t AS RESTRICTIVE FOR SELECT TO PUBLIC USING (a > 0);\n\n\
             COMMENT ON TABLE app.t IS 'it''s';\n\
             COMMENT ON COLUMN app.t.a IS 'c';\n\
             COMMENT ON CONSTRAINT no_overlap ON app.t IS 'x';\n\
             COMMENT ON INDEX app.t_a IS 'i';\n\n\
             CREATE TRIGGER tr AFTER INSERT ON app.t FOR EACH STATEMENT EXECUTE FUNCTION f();\n\n\
             ALTER TABLE app.t DISABLE TRIGGER tr;"
        );
    }

    #[test]
    fn partitioned_tables_and_partitions() {
        let parent = TableDdl {
            table: Table {
                kind: "p".into(),
                partition_key: s("RANGE (at)"),
                ..table("public.ev")
            },
            columns: vec![col("at", "date")],
            indexes: vec![Index {
                definition: "CREATE INDEX ev_at ON ONLY public.ev USING btree (at)".into(),
                name: "public.ev_at".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(
            parent.script(),
            "CREATE TABLE public.ev (\n  at date\n)\nPARTITION BY RANGE (at);\n\n\
             CREATE INDEX ev_at ON public.ev USING btree (at);"
        );

        let mut at = col("at", "date");
        at.local = false;
        at.parent_not_null = Some(false);
        let mut kind = col("kind", "text");
        kind.local = false;
        kind.not_null = true;
        kind.parent_not_null = Some(false);
        kind.default = s("'a'::text");
        kind.parent_default = s("'a'::text");
        let partition = TableDdl {
            table: Table {
                partition_of: Some(("public.ev".into(), "DEFAULT".into())),
                ..table("public.ev_rest")
            },
            columns: vec![at, kind],
            ..Default::default()
        };
        assert_eq!(
            partition.script(),
            "CREATE TABLE public.ev_rest PARTITION OF public.ev (\n  kind WITH OPTIONS NOT NULL\n)\nDEFAULT;"
        );
    }

    #[test]
    fn inheritance_skips_inherited_columns() {
        let mut id = col("id", "integer");
        id.local = false;
        let ddl = TableDdl {
            table: Table {
                inherits: vec!["public.base".into()],
                ..table("public.child")
            },
            columns: vec![id, col("extra", "integer")],
            ..Default::default()
        };
        assert_eq!(
            ddl.script(),
            "CREATE TABLE public.child (\n  extra integer\n)\nINHERITS (public.base);"
        );
        let empty = TableDdl {
            table: table("public.e"),
            ..Default::default()
        };
        assert_eq!(empty.script(), "CREATE TABLE public.e ();");
    }

    #[test]
    fn virtual_generated_column() {
        let mut c = col("c", "integer");
        c.generated = "v".into();
        c.default = s("a + 1");
        assert_eq!(
            c.definition("public.t"),
            "c integer GENERATED ALWAYS AS (a + 1) VIRTUAL"
        );
    }

    #[test]
    fn raw_table_names() {
        assert_eq!(table_raw_name("public.t"), "t");
        assert_eq!(table_raw_name("\"a.b\".\"Odd \"\"x\"\".y\""), "Odd \"x\".y");
    }
}
