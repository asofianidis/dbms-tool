//! PostgreSQL: a plain SQL dump built from the system catalogs, in the order
//! pg_dump uses (types and functions, tables, data, then constraints, indexes
//! and triggers), with data streamed through COPY; and a psql-style runner
//! for plain scripts, COPY blocks and `\connect` included.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Cursor, Write};
use std::path::Path;
use std::pin::Pin;

use futures_util::{SinkExt as _, StreamExt as _};
use tokio_postgres::{Client, CopyInSink};

use super::split::{Dialect, Item, Splitter};
use super::{Output, Report, excerpt, open_input, session};
use crate::backup::{Content, PgDumpJob, PsqlJob};
use crate::drivers::Session;
use crate::drivers::postgres::{PgSession, describe_error};
use crate::error::{AppError, AppResult};
use crate::manager::Server;

async fn connect(server: &Server, database: &str) -> AppResult<PgSession> {
    match session(server, database).await? {
        Session::Pg(s) => Ok(s),
        _ => Err(AppError::msg("Not a PostgreSQL connection")),
    }
}

/// A SQL string literal.
fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// A double-quoted identifier, the way `quote_ident` would always quote it.
fn ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/* ---------- What's in scope ---------- */

enum Scope {
    All,
    Schemas(HashSet<String>),
    /// Chosen tables, views and sequences by OID
    Relations(HashSet<u32>),
}

impl Scope {
    /// Schema-level objects (types, functions, schemas themselves).
    fn schema(&self, schema: &str) -> bool {
        match self {
            Scope::All => true,
            Scope::Schemas(s) => s.contains(schema),
            Scope::Relations(_) => false,
        }
    }

    fn relation(&self, oid: u32, schema: &str) -> bool {
        match self {
            Scope::Relations(r) => r.contains(&oid),
            _ => self.schema(schema),
        }
    }
}

const USER_SCHEMA: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') \
     AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'";

/// Leaves out objects that belong to an extension, which CREATE EXTENSION brings back.
fn not_extension_member(catalog: &str, oid: &str) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = '{catalog}'::regclass \
         AND e.objid = {oid} AND e.deptype = 'e')"
    )
}

/// Orders items so each comes after the ones it depends on; cycles keep their input order.
fn topo_order<K: Copy + Eq + std::hash::Hash>(keys: &[K], deps: &HashMap<K, Vec<K>>) -> Vec<K> {
    let present: HashSet<K> = keys.iter().copied().collect();
    let mut done: HashSet<K> = HashSet::new();
    let mut visiting: HashSet<K> = HashSet::new();
    let mut out = Vec::with_capacity(keys.len());
    fn visit<K: Copy + Eq + std::hash::Hash>(
        k: K,
        deps: &HashMap<K, Vec<K>>,
        present: &HashSet<K>,
        done: &mut HashSet<K>,
        visiting: &mut HashSet<K>,
        out: &mut Vec<K>,
    ) {
        if done.contains(&k) || !visiting.insert(k) {
            return;
        }
        for &d in deps.get(&k).into_iter().flatten() {
            if present.contains(&d) {
                visit(d, deps, present, done, visiting, out);
            }
        }
        visiting.remove(&k);
        done.insert(k);
        out.push(k);
    }
    for &k in keys {
        visit(k, deps, &present, &mut done, &mut visiting, &mut out);
    }
    out
}

/* ---------- Catalog ---------- */

struct Relation {
    oid: u32,
    schema: String,
    name: String,
    qname: String,
    /// r, p (partitioned), v, m (materialized view), S (sequence)
    kind: String,
    unlogged: bool,
    owner: String,
    partition_bound: Option<String>,
    partition_key: Option<String>,
    comment: Option<String>,
    rls: bool,
    force_rls: bool,
    /// View or materialized view definition
    definition: Option<String>,
    populated: bool,
}

struct Column {
    rel: u32,
    name: String,
    typ: String,
    not_null: bool,
    default: Option<String>,
    /// a (always) or d (by default) for identity columns
    identity: String,
    /// s for stored generated columns
    generated: String,
    local: bool,
    collation: Option<String>,
    comment: Option<String>,
}

struct Constraint {
    rel: u32,
    name: String,
    definition: String,
    /// c, p, u, x, f
    kind: String,
    local: bool,
    /// The table an FK points at
    references: u32,
}

struct Sequence {
    oid: u32,
    schema: String,
    name: String,
    qname: String,
    owner: String,
    definition: String,
    /// Table and column whose serial default owns it
    owned_by: Option<(u32, String)>,
    /// Backs an identity column, so the table creates it
    identity_of: Option<u32>,
}

struct Function {
    schema: String,
    signature: String,
    kind: String,
    definition: String,
    owner: String,
    /// Takes or returns a table's row type, so it's created after the tables
    late: bool,
    oid: u32,
}

struct TypeDef {
    schema: String,
    qname: String,
    /// e, c, d, r
    kind: String,
    body: String,
    owner: String,
}

struct Grant {
    oid: u32,
    grantee: String,
    privilege: String,
    grantable: bool,
}

struct Catalog {
    relations: Vec<Relation>,
    columns: Vec<Column>,
    parents: HashMap<u32, Vec<u32>>,
    constraints: Vec<Constraint>,
    indexes: Vec<(u32, String)>,
    triggers: Vec<(u32, String)>,
    policies: Vec<(u32, String)>,
    sequences: Vec<Sequence>,
    functions: Vec<Function>,
    types: Vec<TypeDef>,
    schemas: Vec<(String, String, Option<String>)>,
    extensions: Vec<(String, String)>,
    view_deps: HashMap<u32, Vec<u32>>,
    relation_grants: Vec<Grant>,
    function_grants: Vec<Grant>,
    function_acl: HashSet<u32>,
    schema_grants: Vec<(String, Grant)>,
}

async fn read_catalog(client: &Client) -> AppResult<Catalog> {
    let version: i32 = client
        .query_one("SELECT current_setting('server_version_num')::int", &[])
        .await?
        .get(0);
    if version < 100_000 {
        return Err(AppError::msg(
            "The built-in engine backs up PostgreSQL 10 and newer; install pg_dump for older servers",
        ));
    }
    let v11 = version >= 110_000;
    let prokind = if v11 {
        "p.prokind::text"
    } else {
        "CASE WHEN p.proisagg THEN 'a' WHEN p.proiswindow THEN 'w' ELSE 'f' END"
    };
    let con_root = if v11 { "c.conparentid = 0" } else { "true" };
    let generated = if version >= 120_000 {
        "a.attgenerated::text"
    } else {
        "''"
    };
    let trigger_root = if version >= 130_000 {
        "t.tgparentid = 0"
    } else {
        "true"
    };

    let relations = client
        .query(
            &format!(
                "SELECT c.oid, n.nspname::text, c.relname::text, format('%I.%I', n.nspname, c.relname), \
                   c.relkind::text, c.relpersistence = 'u', pg_get_userbyid(c.relowner)::text, \
                   CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END, \
                   CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END, \
                   obj_description(c.oid, 'pg_class'), c.relrowsecurity, c.relforcerowsecurity, \
                   CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid) END, c.relispopulated \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE c.relkind IN ('r', 'p', 'v', 'm') AND {USER_SCHEMA} AND {} \
                 ORDER BY c.oid",
                not_extension_member("pg_class", "c.oid")
            ),
            &[],
        )
        .await?
        .into_iter()
        .map(|r| Relation {
            oid: r.get(0),
            schema: r.get(1),
            name: r.get(2),
            qname: r.get(3),
            kind: r.get(4),
            unlogged: r.get(5),
            owner: r.get(6),
            partition_bound: r.get(7),
            partition_key: r.get(8),
            comment: r.get(9),
            rls: r.get(10),
            force_rls: r.get(11),
            definition: r.get(12),
            populated: r.get(13),
        })
        .collect();

    let columns = client
        .query(
            &format!(
                "SELECT a.attrelid, quote_ident(a.attname), format_type(a.atttypid, a.atttypmod), \
                   a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid), a.attidentity::text, {generated}, \
                   a.attislocal, \
                   CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation \
                     THEN format('%I.%I', cn.nspname, co.collname) END, \
                   col_description(a.attrelid, a.attnum) \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_type t ON t.oid = a.atttypid \
                 LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
                 LEFT JOIN pg_collation co ON co.oid = a.attcollation \
                 LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace \
                 WHERE c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped \
                   AND {USER_SCHEMA} \
                 ORDER BY a.attrelid, a.attnum"
            ),
            &[],
        )
        .await?
        .into_iter()
        .map(|r| Column {
            rel: r.get(0),
            name: r.get(1),
            typ: r.get(2),
            not_null: r.get(3),
            default: r.get(4),
            identity: r.get(5),
            generated: r.get(6),
            local: r.get(7),
            collation: r.get(8),
            comment: r.get(9),
        })
        .collect();

    let mut parents: HashMap<u32, Vec<u32>> = HashMap::new();
    for r in client
        .query(
            "SELECT inhrelid, inhparent FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid \
             WHERE c.relkind IN ('r', 'p') ORDER BY inhrelid, inhseqno",
            &[],
        )
        .await?
    {
        parents.entry(r.get(0)).or_default().push(r.get(1));
    }

    let constraints = client
        .query(
            &format!(
                "SELECT c.conrelid, quote_ident(c.conname), pg_get_constraintdef(c.oid), c.contype::text, \
                   c.conislocal, c.confrelid \
                 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid \
                 JOIN pg_namespace n ON n.oid = r.relnamespace \
                 WHERE c.contype IN ('c', 'p', 'u', 'x', 'f') AND {con_root} AND {USER_SCHEMA} \
                 ORDER BY c.conrelid, c.contype, c.conname"
            ),
            &[],
        )
        .await?
        .into_iter()
        .map(|r| Constraint {
            rel: r.get(0),
            name: r.get(1),
            definition: r.get(2),
            kind: r.get(3),
            local: r.get(4),
            references: r.get(5),
        })
        .collect();

    // Indexes that back no constraint and aren't a partition's copy of its parent's
    let indexes = client
        .query(
            &format!(
                "SELECT i.indrelid, pg_get_indexdef(i.indexrelid) \
                 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid \
                 JOIN pg_namespace n ON n.oid = t.relnamespace \
                 WHERE {USER_SCHEMA} \
                   AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid \
                                   AND c.contype IN ('p', 'u', 'x')) \
                   AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = i.indexrelid) \
                   AND {} \
                 ORDER BY i.indrelid, i.indexrelid",
                not_extension_member("pg_class", "i.indexrelid")
            ),
            &[],
        )
        .await?
        .into_iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();

    let triggers = client
        .query(
            &format!(
                "SELECT t.tgrelid, pg_get_triggerdef(t.oid) FROM pg_trigger t \
                 JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE NOT t.tgisinternal AND {trigger_root} AND {USER_SCHEMA} \
                 ORDER BY t.tgrelid, t.tgname"
            ),
            &[],
        )
        .await?
        .into_iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();

    let policies = client
        .query(
            "SELECT p.polrelid, \
               format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;', p.polname, n.nspname, c.relname, \
                 CASE WHEN p.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END, \
                 CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' \
                   WHEN 'd' THEN 'DELETE' ELSE 'ALL' END, \
                 (SELECT string_agg(CASE WHEN r = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(r)) END, ', ') \
                    FROM unnest(p.polroles) r), \
                 ' USING (' || pg_get_expr(p.polqual, p.polrelid) || ')', \
                 ' WITH CHECK (' || pg_get_expr(p.polwithcheck, p.polrelid) || ')') \
             FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace ORDER BY p.polrelid, p.polname",
            &[],
        )
        .await?
        .into_iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();

    let sequences = client
        .query(
            &format!(
                "SELECT c.oid, n.nspname::text, format('%I.%I', n.nspname, c.relname), \
                   pg_get_userbyid(c.relowner)::text, c.relname::text, \
                   format('CREATE SEQUENCE %I.%I AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s%s;', \
                     n.nspname, c.relname, format_type(s.seqtypid, NULL), s.seqincrement, s.seqmin, s.seqmax, \
                     s.seqstart, s.seqcache, CASE WHEN s.seqcycle THEN ' CYCLE' ELSE '' END), \
                   d.refobjid, d.deptype::text, quote_ident(a.attname) \
                 FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid \
                   AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i') \
                 LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid \
                 WHERE {USER_SCHEMA} AND {} ORDER BY c.oid",
                not_extension_member("pg_class", "c.oid")
            ),
            &[],
        )
        .await?
        .into_iter()
        .map(|r| {
            let table: Option<u32> = r.get(6);
            let dep: Option<String> = r.get(7);
            let column: Option<String> = r.get(8);
            Sequence {
                oid: r.get(0),
                schema: r.get(1),
                qname: r.get(2),
                owner: r.get(3),
                name: r.get(4),
                definition: r.get(5),
                owned_by: match (table, dep.as_deref(), column) {
                    (Some(t), Some("a"), Some(c)) => Some((t, c)),
                    _ => None,
                },
                identity_of: match (table, dep.as_deref()) {
                    (Some(t), Some("i")) => Some(t),
                    _ => None,
                },
            }
        })
        .collect();

    let functions = client
        .query(
            &format!(
                "SELECT p.oid, n.nspname::text, \
                   format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), \
                   {prokind}, pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner)::text, \
                   EXISTS (SELECT 1 FROM pg_type t JOIN pg_class r ON r.oid = t.typrelid \
                           WHERE r.relkind IN ('r', 'p', 'v', 'm', 'f') \
                             AND (t.oid = p.prorettype OR t.oid = ANY (p.proargtypes::oid[]) \
                                  OR t.oid = ANY (coalesce(p.proallargtypes, '{{}}'::oid[])))) \
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE {USER_SCHEMA} AND {} AND {prokind} IN ('f', 'p') ORDER BY p.oid",
                not_extension_member("pg_proc", "p.oid")
            ),
            &[],
        )
        .await?
        .into_iter()
        .map(|r| Function {
            oid: r.get(0),
            schema: r.get(1),
            signature: r.get(2),
            kind: r.get(3),
            definition: r.get(4),
            owner: r.get(5),
            late: r.get(6),
        })
        .collect();

    let types = client
        .query(
            &format!(
                "SELECT n.nspname::text, format('%I.%I', n.nspname, t.typname), t.typtype::text, \
                   CASE t.typtype \
                     WHEN 'e' THEN 'AS ENUM (' || coalesce((SELECT string_agg(quote_literal(e.enumlabel), ', ' \
                       ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid), '') || ')' \
                     WHEN 'c' THEN 'AS (' || coalesce((SELECT string_agg(quote_ident(a.attname) || ' ' || \
                       format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum) FROM pg_attribute a \
                       WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped), '') || ')' \
                     WHEN 'd' THEN 'AS ' || format_type(t.typbasetype, t.typtypmod) \
                       || coalesce(' DEFAULT ' || t.typdefault, '') \
                       || CASE WHEN t.typnotnull AND NOT EXISTS (SELECT 1 FROM pg_constraint n \
                            WHERE n.contypid = t.oid AND n.contype = 'n') THEN ' NOT NULL' ELSE '' END \
                       || coalesce((SELECT string_agg(' CONSTRAINT ' || quote_ident(c.conname) || ' ' || \
                         pg_get_constraintdef(c.oid), '') FROM pg_constraint c WHERE c.contypid = t.oid), '') \
                     WHEN 'r' THEN (SELECT 'AS RANGE (subtype = ' || format_type(r.rngsubtype, NULL) || ')' \
                       FROM pg_range r WHERE r.rngtypid = t.oid) \
                   END, pg_get_userbyid(t.typowner)::text \
                 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace \
                 LEFT JOIN pg_class c ON c.oid = t.typrelid \
                 WHERE {USER_SCHEMA} AND {} \
                   AND (t.typtype IN ('e', 'd', 'r') OR (t.typtype = 'c' AND c.relkind = 'c')) \
                 ORDER BY CASE t.typtype WHEN 'e' THEN 0 WHEN 'r' THEN 1 WHEN 'd' THEN 2 ELSE 3 END, t.oid",
                not_extension_member("pg_type", "t.oid")
            ),
            &[],
        )
        .await?
        .into_iter()
        .map(|r| TypeDef {
            schema: r.get(0),
            qname: r.get(1),
            kind: r.get(2),
            body: r.get::<_, Option<String>>(3).unwrap_or_default(),
            owner: r.get(4),
        })
        .collect();

    let schemas = client
        .query(
            &format!(
                "SELECT n.nspname::text, pg_get_userbyid(n.nspowner)::text, obj_description(n.oid, 'pg_namespace') \
                 FROM pg_namespace n WHERE {USER_SCHEMA} AND {} ORDER BY n.oid",
                not_extension_member("pg_namespace", "n.oid")
            ),
            &[],
        )
        .await?
        .into_iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();

    let extensions = client
        .query(
            "SELECT e.extname::text, n.nspname::text FROM pg_extension e \
             JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname <> 'plpgsql' ORDER BY e.oid",
            &[],
        )
        .await?
        .into_iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();

    let mut view_deps: HashMap<u32, Vec<u32>> = HashMap::new();
    for r in client
        .query(
            "SELECT DISTINCT w.ev_class, d.refobjid FROM pg_rewrite w \
             JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = w.oid \
               AND d.refclassid = 'pg_class'::regclass \
             WHERE d.refobjid <> w.ev_class",
            &[],
        )
        .await?
    {
        view_deps.entry(r.get(0)).or_default().push(r.get(1));
    }

    let grant = |r: &tokio_postgres::Row| Grant {
        oid: r.get(0),
        grantee: r.get(1),
        privilege: r.get(2),
        grantable: r.get(3),
    };
    // Privileges beyond the owner's own; grantee 0 is PUBLIC
    let grantee =
        "CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END";
    let relation_grants = client
        .query(
            &format!(
                "SELECT c.oid, {grantee}, a.privilege_type, a.is_grantable \
                 FROM pg_class c, aclexplode(c.relacl) a WHERE c.relacl IS NOT NULL \
                   AND a.grantee <> c.relowner AND c.relkind IN ('r', 'p', 'v', 'm', 'S')"
            ),
            &[],
        )
        .await?
        .iter()
        .map(grant)
        .collect();
    let function_rows = client
        .query(
            &format!(
                "SELECT p.oid, {grantee}, a.privilege_type, a.is_grantable \
                 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proacl IS NOT NULL AND a.grantee <> p.proowner"
            ),
            &[],
        )
        .await?;
    let function_grants = function_rows.iter().map(grant).collect();
    let function_acl = client
        .query("SELECT oid FROM pg_proc WHERE proacl IS NOT NULL", &[])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect();
    let schema_grants = client
        .query(
            &format!(
                "SELECT n.oid, {grantee}, a.privilege_type, a.is_grantable, n.nspname::text \
                 FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspacl IS NOT NULL AND a.grantee <> n.nspowner"
            ),
            &[],
        )
        .await?
        .iter()
        .map(|r| (r.get(4), grant(r)))
        .collect();

    Ok(Catalog {
        relations,
        columns,
        parents,
        constraints,
        indexes,
        triggers,
        policies,
        sequences,
        functions,
        types,
        schemas,
        extensions,
        view_deps,
        relation_grants,
        function_grants,
        function_acl,
        schema_grants,
    })
}

/* ---------- Dump ---------- */

pub async fn dump(server: &Server, job: &PgDumpJob, report: &Report<'_>) -> AppResult<()> {
    let database = job.database.trim();
    let session = connect(server, database).await?;
    let client = session.client();
    // One snapshot for the whole dump, as pg_dump takes
    client
        .batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .await?;
    // With no search path, the server schema-qualifies every name it prints
    // (types, view and function bodies, defaults), as pg_dump arranges
    client
        .batch_execute("SELECT pg_catalog.set_config('search_path', '', false)")
        .await?;
    let version_text: String = client
        .query_one("SELECT current_setting('server_version')", &[])
        .await?
        .get(0);
    let encoding: String = client
        .query_one(
            "SELECT pg_encoding_to_char(encoding)::text FROM pg_database WHERE datname = current_database()",
            &[],
        )
        .await?
        .get(0);
    report.line("Reading the catalog");
    let catalog = read_catalog(client).await?;
    report.check()?;

    let scope = if !job.tables.is_empty() {
        let mut oids = HashSet::new();
        for t in &job.tables {
            let schema = t.schema.as_deref().unwrap_or("public");
            let found = catalog
                .relations
                .iter()
                .find(|r| r.schema == schema && r.name == t.name)
                .map(|r| r.oid)
                .or_else(|| {
                    catalog
                        .sequences
                        .iter()
                        .find(|s| s.schema == schema && s.name == t.name)
                        .map(|s| s.oid)
                });
            match found {
                Some(oid) => {
                    oids.insert(oid);
                }
                None => {
                    return Err(AppError::msg(format!(
                        "No table named {schema}.{} was found",
                        t.name
                    )));
                }
            }
        }
        Scope::Relations(oids)
    } else if !job.schemas.is_empty() {
        Scope::Schemas(job.schemas.iter().cloned().collect())
    } else {
        Scope::All
    };

    let path = Path::new(job.file.trim());
    let mut out = Output::create(path, false)?;
    let schema_part = job.content != Content::Data;
    let data_part = job.content != Content::Schema;
    let mut w = |text: &str| -> AppResult<()> { Ok(out.write_all(text.as_bytes())?) };

    w(&format!(
        "--\n-- PostgreSQL database dump\n--\n\n-- Dumped from database version {version_text}\n\
         -- Dumped by dbms-tool version {} (built-in engine)\n\n",
        env!("CARGO_PKG_VERSION")
    ))?;
    w(
        "SET statement_timeout = 0;\nSET lock_timeout = 0;\nSET idle_in_transaction_session_timeout = 0;\n\
       SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n\
       SELECT pg_catalog.set_config('search_path', '', false);\nSET check_function_bodies = false;\n\
       SET xmloption = content;\nSET client_min_messages = warning;\nSET row_security = off;\n\n",
    )?;

    if job.create {
        if job.clean {
            w(&format!("DROP DATABASE IF EXISTS {};\n", ident(database)))?;
        }
        w(&format!(
            "CREATE DATABASE {} WITH TEMPLATE = template0 ENCODING = {};\n\n\\connect {}\n\n",
            ident(database),
            literal(&encoding),
            ident(database)
        ))?;
        w(
            "SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n\
           SELECT pg_catalog.set_config('search_path', '', false);\nSET check_function_bodies = false;\n\n",
        )?;
    }

    let rel = |r: &&Relation| scope.relation(r.oid, &r.schema);
    let tables: Vec<&Relation> = {
        let chosen: Vec<&Relation> = catalog
            .relations
            .iter()
            .filter(|r| matches!(r.kind.as_str(), "r" | "p"))
            .filter(rel)
            .collect();
        // Parents before partitions and children
        let keys: Vec<u32> = chosen.iter().map(|r| r.oid).collect();
        let order = topo_order(&keys, &catalog.parents);
        order
            .iter()
            .filter_map(|oid| chosen.iter().find(|r| r.oid == *oid).copied())
            .collect()
    };
    let views: Vec<&Relation> = {
        let chosen: Vec<&Relation> = catalog
            .relations
            .iter()
            .filter(|r| matches!(r.kind.as_str(), "v" | "m"))
            .filter(rel)
            .collect();
        let keys: Vec<u32> = chosen.iter().map(|r| r.oid).collect();
        topo_order(&keys, &catalog.view_deps)
            .iter()
            .filter_map(|oid| chosen.iter().find(|r| r.oid == *oid).copied())
            .collect()
    };
    let table_oids: HashSet<u32> = tables.iter().map(|t| t.oid).collect();
    let sequences: Vec<&Sequence> = catalog
        .sequences
        .iter()
        .filter(|s| match &scope {
            Scope::Relations(r) => {
                r.contains(&s.oid)
                    || s.owned_by.as_ref().is_some_and(|(t, _)| r.contains(t))
                    || s.identity_of.is_some_and(|t| r.contains(&t))
            }
            _ => scope.schema(&s.schema),
        })
        .collect();
    let functions: Vec<&Function> = catalog
        .functions
        .iter()
        .filter(|f| scope.schema(&f.schema))
        .collect();
    let types: Vec<&TypeDef> = catalog
        .types
        .iter()
        .filter(|t| scope.schema(&t.schema))
        .collect();
    let schemas: Vec<&(String, String, Option<String>)> = catalog
        .schemas
        .iter()
        .filter(|(name, _, _)| scope.schema(name))
        .collect();
    let constraints_of = |oid: u32| catalog.constraints.iter().filter(move |c| c.rel == oid);
    let columns_of = |oid: u32| catalog.columns.iter().filter(move |c| c.rel == oid);
    let qname_of = |oid: u32| {
        catalog
            .relations
            .iter()
            .find(|r| r.oid == oid)
            .map(|r| r.qname.clone())
    };

    if schema_part && job.clean {
        w("--\n-- Drop what the script recreates\n--\n\n")?;
        for t in tables.iter().rev() {
            for c in constraints_of(t.oid).filter(|c| c.kind == "f" && c.local) {
                w(&format!(
                    "ALTER TABLE IF EXISTS {} DROP CONSTRAINT IF EXISTS {};\n",
                    only(t, &t.qname),
                    c.name
                ))?;
            }
        }
        for v in views.iter().rev() {
            let kind = if v.kind == "m" {
                "MATERIALIZED VIEW"
            } else {
                "VIEW"
            };
            w(&format!("DROP {kind} IF EXISTS {};\n", v.qname))?;
        }
        for f in functions.iter().filter(|f| f.late).rev() {
            w(&format!(
                "DROP {} IF EXISTS {};\n",
                routine_kind(f),
                f.signature
            ))?;
        }
        for t in tables.iter().rev() {
            w(&format!("DROP TABLE IF EXISTS {};\n", t.qname))?;
        }
        for s in sequences.iter().rev().filter(|s| s.identity_of.is_none()) {
            w(&format!("DROP SEQUENCE IF EXISTS {};\n", s.qname))?;
        }
        for f in functions.iter().filter(|f| !f.late).rev() {
            w(&format!(
                "DROP {} IF EXISTS {};\n",
                routine_kind(f),
                f.signature
            ))?;
        }
        for t in types.iter().rev() {
            let kind = if t.kind == "d" { "DOMAIN" } else { "TYPE" };
            w(&format!("DROP {kind} IF EXISTS {};\n", t.qname))?;
        }
        for (name, _, _) in schemas.iter().rev() {
            if name != "public" {
                w(&format!("DROP SCHEMA IF EXISTS {};\n", ident(name)))?;
            }
        }
        w("\n")?;
    }

    if schema_part {
        for (name, schema) in &catalog.extensions {
            if scope.schema(schema) && !matches!(scope, Scope::Relations(_)) {
                w(&format!(
                    "CREATE EXTENSION IF NOT EXISTS {} WITH SCHEMA {};\n",
                    ident(name),
                    ident(schema)
                ))?;
            }
        }
        for (name, owner, comment) in &schemas {
            if name != "public" {
                w(&format!("CREATE SCHEMA {};\n", ident(name)))?;
                if !job.no_owner {
                    w(&format!(
                        "ALTER SCHEMA {} OWNER TO {};\n",
                        ident(name),
                        ident(owner)
                    ))?;
                }
            }
            if let Some(c) = comment {
                w(&format!(
                    "COMMENT ON SCHEMA {} IS {};\n",
                    ident(name),
                    literal(c)
                ))?;
            }
        }
        w("\n")?;
        for t in &types {
            let kind = if t.kind == "d" { "DOMAIN" } else { "TYPE" };
            w(&format!("CREATE {kind} {} {};\n", t.qname, t.body))?;
            if !job.no_owner {
                w(&format!(
                    "ALTER {kind} {} OWNER TO {};\n",
                    t.qname,
                    ident(&t.owner)
                ))?;
            }
        }
        for f in functions.iter().filter(|f| !f.late) {
            write_function(&mut w, f, job.no_owner)?;
        }
        for s in sequences.iter().filter(|s| s.identity_of.is_none()) {
            w(&format!("{}\n", s.definition))?;
            if !job.no_owner {
                w(&format!(
                    "ALTER SEQUENCE {} OWNER TO {};\n",
                    s.qname,
                    ident(&s.owner)
                ))?;
            }
        }
        w("\n")?;

        for t in &tables {
            report.line(format!("creating table {}", t.qname));
            w(&create_table(
                t,
                &catalog,
                columns_of(t.oid),
                constraints_of(t.oid),
                &qname_of,
            ))?;
            if !job.no_owner {
                w(&format!(
                    "ALTER TABLE {} OWNER TO {};\n",
                    t.qname,
                    ident(&t.owner)
                ))?;
            }
            for s in sequences.iter().filter(|s| s.identity_of.is_none()) {
                if let Some((owner, column)) = &s.owned_by
                    && *owner == t.oid
                {
                    w(&format!(
                        "ALTER SEQUENCE {} OWNED BY {}.{};\n",
                        s.qname, t.qname, column
                    ))?;
                }
            }
            w("\n")?;
        }
        for f in functions.iter().filter(|f| f.late) {
            write_function(&mut w, f, job.no_owner)?;
        }
        for v in &views {
            let definition = v
                .definition
                .as_deref()
                .unwrap_or_default()
                .trim()
                .trim_end_matches(';');
            if v.kind == "m" {
                w(&format!(
                    "CREATE MATERIALIZED VIEW {} AS\n{definition}\n  WITH NO DATA;\n",
                    v.qname
                ))?;
                if !job.no_owner {
                    w(&format!(
                        "ALTER MATERIALIZED VIEW {} OWNER TO {};\n",
                        v.qname,
                        ident(&v.owner)
                    ))?;
                }
            } else {
                w(&format!("CREATE VIEW {} AS\n{definition};\n", v.qname))?;
                if !job.no_owner {
                    w(&format!(
                        "ALTER VIEW {} OWNER TO {};\n",
                        v.qname,
                        ident(&v.owner)
                    ))?;
                }
            }
            write_comments(&mut w, v, columns_of(v.oid))?;
            w("\n")?;
        }
    }

    if data_part {
        // Referenced tables first, so a data-only script loads into tables with foreign keys
        let keys: Vec<u32> = tables.iter().map(|t| t.oid).collect();
        let mut fk_deps: HashMap<u32, Vec<u32>> = HashMap::new();
        for c in catalog.constraints.iter().filter(|c| c.kind == "f") {
            fk_deps.entry(c.rel).or_default().push(c.references);
        }
        for oid in topo_order(&keys, &fk_deps) {
            let t = tables.iter().find(|t| t.oid == oid).unwrap();
            if t.kind == "p" {
                continue;
            }
            report.check()?;
            let columns: Vec<&str> = columns_of(t.oid)
                .filter(|c| c.generated.is_empty())
                .map(|c| c.name.as_str())
                .collect();
            let list = columns.join(", ");
            let rows = if job.inserts {
                let always = columns_of(t.oid).any(|c| c.identity == "a");
                insert_rows(client, &mut out, t, &columns, always).await?
            } else {
                out.write_all(format!("COPY {} ({list}) FROM stdin;\n", t.qname).as_bytes())?;
                let copy = format!("COPY {} ({list}) TO STDOUT", t.qname);
                let stream = client.copy_out(copy.as_str()).await?;
                futures_util::pin_mut!(stream);
                let mut rows = 0u64;
                let mut chunks = 0u64;
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk?;
                    rows += chunk.iter().filter(|&&b| b == b'\n').count() as u64;
                    out.write_all(&chunk)?;
                    chunks += 1;
                    if chunks.is_multiple_of(256) {
                        report.check()?;
                    }
                }
                out.write_all(b"\\.\n\n")?;
                rows
            };
            report.line(format!("dumped {rows} rows from {}", t.qname));
        }
        let mut w = |text: &str| -> AppResult<()> { Ok(out.write_all(text.as_bytes())?) };
        for s in &sequences {
            let row = client
                .query_one(
                    &format!("SELECT last_value, is_called FROM {}", s.qname),
                    &[],
                )
                .await?;
            let value: i64 = row.get(0);
            let called: bool = row.get(1);
            w(&format!(
                "SELECT pg_catalog.setval({}, {value}, {called});\n",
                literal(&s.qname)
            ))?;
        }
        w("\n")?;
    }

    let mut w = |text: &str| -> AppResult<()> { Ok(out.write_all(text.as_bytes())?) };
    if schema_part {
        for t in &tables {
            for c in constraints_of(t.oid)
                .filter(|c| matches!(c.kind.as_str(), "p" | "u" | "x") && c.local)
            {
                w(&format!(
                    "ALTER TABLE {} ADD CONSTRAINT {} {};\n",
                    only(t, &t.qname),
                    c.name,
                    c.definition
                ))?;
            }
        }
        let indexed: HashSet<u32> = tables.iter().chain(views.iter()).map(|r| r.oid).collect();
        for (rel, definition) in &catalog.indexes {
            if indexed.contains(rel) {
                // A partitioned table's index reads "ON ONLY parent"; without
                // ONLY it cascades, giving each partition its own copy again
                let definition = definition.replacen(" ON ONLY ", " ON ", 1);
                w(&format!("{definition};\n"))?;
            }
        }
        for t in &tables {
            for c in constraints_of(t.oid).filter(|c| c.kind == "f" && c.local) {
                w(&format!(
                    "ALTER TABLE {} ADD CONSTRAINT {} {};\n",
                    only(t, &t.qname),
                    c.name,
                    c.definition
                ))?;
            }
        }
        for (rel, definition) in &catalog.triggers {
            if table_oids.contains(rel) || views.iter().any(|v| v.oid == *rel) {
                w(&format!("{definition};\n"))?;
            }
        }
        for t in &tables {
            if t.rls {
                w(&format!(
                    "ALTER TABLE {} ENABLE ROW LEVEL SECURITY;\n",
                    t.qname
                ))?;
            }
            if t.force_rls {
                w(&format!(
                    "ALTER TABLE {} FORCE ROW LEVEL SECURITY;\n",
                    t.qname
                ))?;
            }
            for (rel, policy) in &catalog.policies {
                if *rel == t.oid {
                    w(&format!("{policy}\n"))?;
                }
            }
        }
        if data_part {
            for v in views.iter().filter(|v| v.kind == "m" && v.populated) {
                w(&format!("REFRESH MATERIALIZED VIEW {};\n", v.qname))?;
            }
        }
        if !job.no_privileges {
            w("\n")?;
            for g in &catalog.relation_grants {
                let Some(r) = catalog
                    .relations
                    .iter()
                    .find(|r| r.oid == g.oid)
                    .filter(|r| table_oids.contains(&r.oid) || views.iter().any(|v| v.oid == r.oid))
                    .map(|r| r.qname.clone())
                    .or_else(|| {
                        sequences
                            .iter()
                            .find(|s| s.oid == g.oid)
                            .map(|s| s.qname.clone())
                    })
                else {
                    continue;
                };
                let on = if sequences.iter().any(|s| s.oid == g.oid) {
                    "SEQUENCE"
                } else {
                    "TABLE"
                };
                w(&grant_sql(g, on, &r))?;
            }
            for f in &functions {
                if catalog.function_acl.contains(&f.oid) {
                    w(&format!(
                        "REVOKE ALL ON {} {} FROM PUBLIC;\n",
                        routine_kind(f),
                        f.signature
                    ))?;
                    for g in catalog.function_grants.iter().filter(|g| g.oid == f.oid) {
                        w(&grant_sql(g, routine_kind(f), &f.signature))?;
                    }
                }
            }
            for (schema, g) in &catalog.schema_grants {
                if schemas.iter().any(|(name, _, _)| name == schema) {
                    w(&grant_sql(g, "SCHEMA", &ident(schema)))?;
                }
            }
        }
    }
    w("\n--\n-- PostgreSQL database dump complete\n--\n\n")?;
    out.finish()?;
    // Read-only; ending it just releases the snapshot
    let _ = client.batch_execute("COMMIT").await;
    Ok(())
}

/// `ONLY` keeps ALTER TABLE off inheritance children; partitioned tables refuse it.
fn only(t: &Relation, qname: &str) -> String {
    if t.kind == "p" {
        qname.to_string()
    } else {
        format!("ONLY {qname}")
    }
}

fn routine_kind(f: &Function) -> &'static str {
    if f.kind == "p" {
        "PROCEDURE"
    } else {
        "FUNCTION"
    }
}

fn grant_sql(g: &Grant, on: &str, name: &str) -> String {
    format!(
        "GRANT {} ON {on} {name} TO {}{};\n",
        g.privilege,
        g.grantee,
        if g.grantable {
            " WITH GRANT OPTION"
        } else {
            ""
        }
    )
}

fn write_function(
    w: &mut impl FnMut(&str) -> AppResult<()>,
    f: &Function,
    no_owner: bool,
) -> AppResult<()> {
    w(&format!("{};\n", f.definition.trim_end()))?;
    if !no_owner {
        w(&format!(
            "ALTER {} {} OWNER TO {};\n",
            routine_kind(f),
            f.signature,
            ident(&f.owner)
        ))?;
    }
    w("\n")
}

fn write_comments<'a>(
    w: &mut impl FnMut(&str) -> AppResult<()>,
    r: &Relation,
    columns: impl Iterator<Item = &'a Column>,
) -> AppResult<()> {
    let kind = match r.kind.as_str() {
        "v" => "VIEW",
        "m" => "MATERIALIZED VIEW",
        _ => "TABLE",
    };
    if let Some(c) = &r.comment {
        w(&format!(
            "COMMENT ON {kind} {} IS {};\n",
            r.qname,
            literal(c)
        ))?;
    }
    for col in columns {
        if let Some(c) = &col.comment {
            w(&format!(
                "COMMENT ON COLUMN {}.{} IS {};\n",
                r.qname,
                col.name,
                literal(c)
            ))?;
        }
    }
    Ok(())
}

fn create_table<'a>(
    t: &Relation,
    catalog: &Catalog,
    columns: impl Iterator<Item = &'a Column> + Clone,
    constraints: impl Iterator<Item = &'a Constraint>,
    qname_of: &impl Fn(u32) -> Option<String>,
) -> String {
    let unlogged = if t.unlogged { "UNLOGGED " } else { "" };
    let parents: Vec<String> = catalog
        .parents
        .get(&t.oid)
        .into_iter()
        .flatten()
        .filter_map(|p| qname_of(*p))
        .collect();
    let mut sql = String::new();
    if let (Some(bound), Some(parent)) = (&t.partition_bound, parents.first()) {
        sql.push_str(&format!(
            "CREATE {unlogged}TABLE {} PARTITION OF {parent} {bound}",
            t.qname
        ));
        if let Some(key) = &t.partition_key {
            sql.push_str(&format!(" PARTITION BY {key}"));
        }
        sql.push_str(";\n");
    } else {
        let mut parts: Vec<String> = columns
            .clone()
            .filter(|c| c.local)
            .map(|c| {
                let mut def = format!("    {} {}", c.name, c.typ);
                if let Some(coll) = &c.collation {
                    def.push_str(&format!(" COLLATE {coll}"));
                }
                match (c.identity.as_str(), c.generated.as_str(), &c.default) {
                    ("a", _, _) => def.push_str(" GENERATED ALWAYS AS IDENTITY"),
                    ("d", _, _) => def.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
                    (_, "s", Some(expr)) => {
                        def.push_str(&format!(" GENERATED ALWAYS AS ({expr}) STORED"))
                    }
                    (_, _, Some(expr)) => def.push_str(&format!(" DEFAULT {expr}")),
                    _ => {}
                }
                if c.not_null {
                    def.push_str(" NOT NULL");
                }
                def
            })
            .collect();
        parts.extend(
            constraints
                .filter(|c| c.kind == "c" && c.local)
                .map(|c| format!("    CONSTRAINT {} {}", c.name, c.definition)),
        );
        sql.push_str(&format!(
            "CREATE {unlogged}TABLE {} (\n{}\n)",
            t.qname,
            parts.join(",\n")
        ));
        if !parents.is_empty() {
            sql.push_str(&format!("\nINHERITS ({})", parents.join(", ")));
        }
        if let Some(key) = &t.partition_key {
            sql.push_str(&format!("\nPARTITION BY {key}"));
        }
        sql.push_str(";\n");
    }
    let mut comments = Vec::new();
    let _ = write_comments(
        &mut |s: &str| {
            comments.push(s.to_string());
            Ok(())
        },
        t,
        columns,
    );
    sql.push_str(&comments.concat());
    sql
}

/// Data as INSERT statements, quoted by the server so every type round-trips.
async fn insert_rows(
    client: &Client,
    out: &mut Output,
    t: &Relation,
    columns: &[&str],
    // GENERATED ALWAYS identity columns only take values with an override
    identity_always: bool,
) -> AppResult<u64> {
    if columns.is_empty() {
        return Ok(0);
    }
    let values = columns
        .iter()
        .map(|c| format!("quote_nullable({c})"))
        .collect::<Vec<_>>()
        .join(" || ', ' || ");
    let overriding = if identity_always {
        " OVERRIDING SYSTEM VALUE"
    } else {
        ""
    };
    let sql = format!(
        "SELECT 'INSERT INTO {} ({}){overriding} VALUES (' || {values} || ');' FROM {}",
        t.qname.replace('\'', "''"),
        columns.join(", ").replace('\'', "''"),
        only(t, &t.qname)
    );
    let params: [&(dyn tokio_postgres::types::ToSql + Sync); 0] = [];
    let stream = client.query_raw(sql.as_str(), params).await?;
    futures_util::pin_mut!(stream);
    let mut rows = 0u64;
    while let Some(row) = stream.next().await {
        let line: String = row?.get(0);
        out.write_all(line.as_bytes())?;
        out.write_all(b"\n")?;
        rows += 1;
    }
    out.write_all(b"\n")?;
    Ok(rows)
}

/* ---------- Restore ---------- */

type CopySink = Pin<Box<CopyInSink<Cursor<Vec<u8>>>>>;

pub async fn restore(server: &Server, job: &PsqlJob, report: &Report<'_>) -> AppResult<()> {
    let mut session = connect(server, job.database.trim()).await?;
    let single = job.single_transaction;
    let stop = job.stop_on_error || single;
    if single {
        session.client().batch_execute("BEGIN").await?;
    }
    let input = open_input(Path::new(job.file.trim()), report)?;
    let mut reader = BufReader::with_capacity(1 << 20, input);
    let mut splitter = Splitter::new(Dialect::Postgres);
    let mut copy: Option<(CopySink, String, Vec<u8>)> = None;
    let mut statements = 0u64;
    let mut line = Vec::new();

    // Reports a failure, and says whether to stop
    let fail = |report: &Report, what: &str, message: String| -> AppResult<()> {
        if stop {
            return Err(AppError::msg(format!("{message}\nIn: {}", excerpt(what))));
        }
        report.error(message);
        Ok(())
    };

    loop {
        line.clear();
        let eof = reader.read_until(b'\n', &mut line)? == 0;
        let items = if eof {
            splitter.finish().into_iter().collect()
        } else {
            splitter.push(&line)
        };
        for item in items {
            match item {
                Item::Statement(sql) => {
                    statements += 1;
                    if statements.is_multiple_of(200) {
                        report.check()?;
                    }
                    let sql = String::from_utf8_lossy(&sql);
                    if let Err(e) = session.client().batch_execute(&sql).await {
                        fail(report, &sql, describe_error(&e))?;
                    }
                }
                Item::CopyStart(sql) => match session
                    .client()
                    .copy_in::<str, Cursor<Vec<u8>>>(sql.as_str())
                    .await
                {
                    Ok(sink) => copy = Some((Box::pin(sink), sql, Vec::new())),
                    Err(e) => fail(report, &sql, describe_error(&e))?,
                },
                Item::CopyData(data) => {
                    // A COPY that failed has the rest of its data skipped
                    let mut failed = None;
                    if let Some((sink, sql, buf)) = &mut copy {
                        buf.extend_from_slice(&data);
                        if buf.len() >= 1 << 20 {
                            let chunk = std::mem::take(buf);
                            if let Err(e) = sink.send(Cursor::new(chunk)).await {
                                failed = Some((sql.clone(), describe_error(&e)));
                            }
                        }
                    }
                    if let Some((sql, message)) = failed {
                        copy = None;
                        fail(report, &sql, message)?;
                    }
                }
                Item::CopyEnd => {
                    if let Some((mut sink, sql, buf)) = copy.take() {
                        let sent = if buf.is_empty() {
                            Ok(())
                        } else {
                            sink.send(Cursor::new(buf)).await
                        };
                        match sent.and(sink.as_mut().finish().await.map(|_| ())) {
                            Ok(()) => {}
                            Err(e) => fail(report, &sql, describe_error(&e))?,
                        }
                        report.check()?;
                    }
                }
                Item::Meta(command) => {
                    let mut words = command.split_whitespace();
                    match words.next().unwrap_or_default() {
                        "\\connect" | "\\c" => {
                            let target = words
                                .find(|w| !w.starts_with('-'))
                                .map(|w| w.trim_matches('"').replace("\"\"", "\""))
                                .unwrap_or_default();
                            if single {
                                return Err(AppError::msg(
                                    "The script switches databases, which can't happen inside one transaction",
                                ));
                            }
                            report.line(format!("connecting to {target}"));
                            session = connect(server, &target).await?;
                        }
                        // pg_dump 17.6+ fences scripts with \restrict; nothing to do here
                        "\\restrict" | "\\unrestrict" | "\\set" | "\\encoding" => {}
                        other => report.line(format!("skipping psql command {other}")),
                    }
                }
            }
        }
        if eof {
            break;
        }
    }
    if copy.is_some() {
        return Err(AppError::msg(
            "The script ended inside COPY data (no \\. line)",
        ));
    }
    if single {
        session.client().batch_execute("COMMIT").await?;
    }
    report.line(format!("ran {statements} statements"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependencies_come_first() {
        let deps = HashMap::from([(3, vec![2]), (2, vec![1]), (5, vec![5])]);
        assert_eq!(topo_order(&[3, 2, 1, 5, 4], &deps), vec![1, 2, 3, 5, 4]);
        // Cycles keep going rather than loop
        let cycle = HashMap::from([(1, vec![2]), (2, vec![1])]);
        assert_eq!(topo_order(&[1, 2], &cycle).len(), 2);
    }

    #[test]
    fn quoting() {
        assert_eq!(literal("it's"), "'it''s'");
        assert_eq!(ident("a\"b"), "\"a\"\"b\"");
    }
}
