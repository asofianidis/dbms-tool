//! Catalog SQL that depends on the server version, and the DDL of aggregates,
//! which `pg_get_functiondef` refuses. Versions are `server_version_num`
//! (110000 = 11.0); PostgreSQL 10 is the oldest the explorer supports.

/// PostgreSQL 11 replaced `proisagg` / `proiswindow` with `prokind` and added procedures.
pub const PROKIND: i32 = 110000;
/// PostgreSQL 12 added generated columns (`pg_attribute.attgenerated`).
pub const GENERATED_COLUMNS: i32 = 120000;
/// PostgreSQL 11 added covering indexes (`INCLUDE`, `pg_index.indnkeyatts`).
pub const INCLUDE_COLUMNS: i32 = 110000;
/// PostgreSQL 11 added `pg_constraint.conparentid` (constraints cloned onto partitions).
pub const CONSTRAINT_PARENT: i32 = 110000;
/// PostgreSQL 13 added `pg_trigger.tgparentid` (triggers cloned onto partitions).
pub const TRIGGER_PARENT: i32 = 130000;

/// `pg_proc p` as an explorer kind: function | procedure | aggregate | window_function.
pub fn routine_kind(version: i32) -> &'static str {
    if version >= PROKIND {
        "CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' \
         WHEN 'w' THEN 'window_function' ELSE 'function' END"
    } else {
        "CASE WHEN p.proisagg THEN 'aggregate' WHEN p.proiswindow THEN 'window_function' \
         ELSE 'function' END"
    }
}

/// Whether `pg_attribute a` is a generated column; there are none before PostgreSQL 12.
pub fn is_generated(version: i32) -> &'static str {
    if version >= GENERATED_COLUMNS {
        "a.attgenerated <> ''"
    } else {
        "false"
    }
}

/// `pg_attribute a`'s generated kind ('' | 's' | 'v'), as text; always '' before PostgreSQL 12.
pub fn generated_kind(version: i32) -> &'static str {
    if version >= GENERATED_COLUMNS {
        "a.attgenerated::text"
    } else {
        "''::text"
    }
}

/// `pg_constraint con` isn't a partition's clone of its parent's constraint;
/// PostgreSQL 10 had no constraints to clone (and no `conparentid`).
pub fn constraint_not_cloned(version: i32) -> &'static str {
    if version >= CONSTRAINT_PARENT {
        "con.conparentid = 0"
    } else {
        "true"
    }
}

/// `pg_trigger t` isn't a partition's clone of its parent's trigger; before
/// PostgreSQL 13 (no `tgparentid`) the clones were internal, which is filtered anyway.
pub fn trigger_not_cloned(version: i32) -> &'static str {
    if version >= TRIGGER_PARENT {
        "t.tgparentid = 0"
    } else {
        "true"
    }
}

/// The result type of `pg_proc p`; NULL for procedures, which return nothing.
pub fn routine_result(version: i32) -> &'static str {
    if version >= PROKIND {
        "CASE WHEN p.prokind = 'p' THEN NULL ELSE pg_get_function_result(p.oid) END"
    } else {
        "pg_get_function_result(p.oid)"
    }
}

/// How many key columns `pg_index ix` has; before INCLUDE every column was a key.
pub fn index_key_columns(version: i32) -> &'static str {
    if version >= INCLUDE_COLUMNS {
        "ix.indnkeyatts"
    } else {
        "ix.indnatts"
    }
}

/// `CREATE AGGREGATE` rebuilt from `pg_aggregate`, for the aggregate in schema
/// `$1` named `$2` with identity arguments `$3`. Options at their defaults are left out.
pub fn aggregate_definition(version: i32) -> String {
    let modify = |column: &str, fn_column: &str, option: &str| {
        if version >= PROKIND {
            format!(
                "CASE WHEN a.{fn_column}::oid <> 0 THEN '{option} = ' || \
                   CASE a.{column} WHEN 'r' THEN 'READ_ONLY' WHEN 's' THEN 'SHAREABLE' ELSE 'READ_WRITE' END END,"
            )
        } else {
            String::new()
        }
    };
    let func = |column: &str, option: &str| {
        format!(
            "CASE WHEN a.{column}::oid <> 0 THEN '{option} = ' || a.{column}::regproc::text END,"
        )
    };
    format!(
        "SELECT format(E'CREATE AGGREGATE %I.%I (%s) (\\n    %s\\n);', n.nspname, p.proname, \
           CASE WHEN p.pronargs = 0 THEN '*' ELSE pg_get_function_identity_arguments(p.oid) END, \
           array_to_string(ARRAY[ \
             'SFUNC = ' || a.aggtransfn::regproc::text, \
             'STYPE = ' || format_type(a.aggtranstype, NULL), \
             CASE WHEN a.aggtransspace > 0 THEN 'SSPACE = ' || a.aggtransspace END, \
             {finalfunc} \
             CASE WHEN a.aggfinalextra THEN 'FINALFUNC_EXTRA' END, \
             {finalmodify} \
             {combinefunc} {serialfunc} {deserialfunc} \
             CASE WHEN a.agginitval IS NOT NULL THEN 'INITCOND = ' || quote_literal(a.agginitval) END, \
             {msfunc} {minvfunc} \
             CASE WHEN a.aggmtransfn::oid <> 0 THEN 'MSTYPE = ' || format_type(a.aggmtranstype, NULL) END, \
             CASE WHEN a.aggmtransspace > 0 THEN 'MSSPACE = ' || a.aggmtransspace END, \
             {mfinalfunc} \
             CASE WHEN a.aggmfinalextra THEN 'MFINALFUNC_EXTRA' END, \
             {mfinalmodify} \
             CASE WHEN a.aggminitval IS NOT NULL THEN 'MINITCOND = ' || quote_literal(a.aggminitval) END, \
             (SELECT 'SORTOP = OPERATOR(' || quote_ident(os.nspname) || '.' || o.oprname || ')' \
              FROM pg_operator o JOIN pg_namespace os ON os.oid = o.oprnamespace WHERE o.oid = a.aggsortop), \
             CASE p.proparallel WHEN 's' THEN 'PARALLEL = SAFE' WHEN 'r' THEN 'PARALLEL = RESTRICTED' END, \
             CASE WHEN a.aggkind = 'h' THEN 'HYPOTHETICAL' END \
           ], E',\\n    ')) \
         FROM pg_aggregate a \
         JOIN pg_proc p ON p.oid = a.aggfnoid \
         JOIN pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = $1 AND p.proname = $2 \
           AND pg_get_function_identity_arguments(p.oid) = $3",
        finalfunc = func("aggfinalfn", "FINALFUNC"),
        finalmodify = modify("aggfinalmodify", "aggfinalfn", "FINALFUNC_MODIFY"),
        combinefunc = func("aggcombinefn", "COMBINEFUNC"),
        serialfunc = func("aggserialfn", "SERIALFUNC"),
        deserialfunc = func("aggdeserialfn", "DESERIALFUNC"),
        msfunc = func("aggmtransfn", "MSFUNC"),
        minvfunc = func("aggminvtransfn", "MINVFUNC"),
        mfinalfunc = func("aggmfinalfn", "MFINALFUNC"),
        mfinalmodify = modify("aggmfinalmodify", "aggmfinalfn", "MFINALFUNC_MODIFY"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_servers_avoid_newer_columns() {
        for v in [100000, 100023, 110022] {
            assert!(!is_generated(v).contains("attgenerated"), "{v}");
        }
        for v in [100000, 109999] {
            assert!(!routine_kind(v).contains("prokind"), "{v}");
            assert!(!routine_result(v).contains("prokind"), "{v}");
            assert_eq!(index_key_columns(v), "ix.indnatts", "{v}");
            let ddl = aggregate_definition(v);
            assert!(!ddl.contains("finalmodify"), "{v}");
            assert!(ddl.contains("COMBINEFUNC"));
        }
    }

    #[test]
    fn current_servers_use_prokind_and_attgenerated() {
        assert!(routine_kind(170000).contains("prokind"));
        assert!(routine_kind(110000).contains("'w' THEN 'window_function'"));
        assert_eq!(is_generated(120000), "a.attgenerated <> ''");
        assert!(is_generated(110000).contains("false"));
        let ddl = aggregate_definition(110000);
        assert!(ddl.contains("a.aggfinalmodify"));
        assert!(ddl.contains("a.aggmfinalmodify"));
        // Every option is a separate array element, so NULLs drop out cleanly
        assert!(!ddl.contains(",,"));
    }

    #[test]
    fn table_ddl_columns_follow_the_version() {
        for v in [100000, 110022, 120000, 129999] {
            assert!(!trigger_not_cloned(v).contains("tgparentid"), "{v}");
        }
        assert!(!constraint_not_cloned(100023).contains("conparentid"));
        assert_eq!(constraint_not_cloned(110000), "con.conparentid = 0");
        assert!(!generated_kind(110022).contains("attgenerated"));
        assert_eq!(generated_kind(120000), "a.attgenerated::text");
        assert_eq!(trigger_not_cloned(130000), "t.tgparentid = 0");
    }
}
