//! Live-database tests. Each runs only when its connection is configured:
//!
//! ```text
//! DBMS_TEST_PG=localhost:5432:postgres:password
//! DBMS_TEST_PGVECTOR=localhost:55452:postgres:password   (pgvector/pgvector image)
//! DBMS_TEST_POSTGIS=localhost:55453:postgres:password    (postgis/postgis image)
//! DBMS_TEST_MYSQL=localhost:3306:root:password
//! DBMS_TEST_MARIADB=localhost:3307:root:password
//! DBMS_TEST_MARIADB_AUTH=localhost:3308:root:password   # disposable: loads plugins, creates users
//! DBMS_TEST_MARIADB_REPLICA=localhost:53329:root:password
//! DBMS_TEST_MYSQL_REPLICA=localhost:53331:root:password
//! DBMS_TEST_MSSQL=localhost:1433:sa:Password!23
//! DBMS_TEST_BABELFISH=localhost:1434:babelfish_user:password
//! DBMS_TEST_MONGO=mongodb://localhost:27017
//! DBMS_TEST_REDIS=redis://localhost:6379
//! ```
//!
//! `scripts/test-databases.sh` starts matching containers.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::config::{AuthMode, ConnectionConfig, Engine, SslMode};
use crate::drivers::mongo::MongoRequest;
use crate::drivers::pg_listen::NotifyBatch;
use crate::drivers::redis::RedisRequest;
use crate::manager::{META, Manager};
use crate::model::*;

fn config(engine: Engine, var: &str) -> Option<(ConnectionConfig, Option<String>)> {
    let raw = std::env::var(var).ok()?;
    let mut c = ConnectionConfig {
        id: format!("test-{var}"),
        name: var.into(),
        engine,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: String::new(),
        auth: AuthMode::Password,
        ssl: SslMode::Prefer,
        trust_server_certificate: true,
        ssl_root_cert: String::new(),
        ssl_client_cert: String::new(),
        ssl_client_key: String::new(),
        uri: String::new(),
        auth_source: String::new(),
        replica_set: String::new(),
        read_preference: String::new(),
        save_password: false,
        read_only: false,
        production: false,
        color: String::new(),
        group: String::new(),
        last_used: None,
        cloud: None,
        ssh: None,
        tunneled: None,
    };
    if engine == Engine::Mongo || engine == Engine::Redis {
        c.uri = raw;
        return Some((c, None));
    }
    let parts: Vec<&str> = raw.splitn(4, ':').collect();
    c.host = parts[0].into();
    c.port = parts[1].parse().unwrap();
    c.user = parts[2].into();
    if engine == Engine::Mssql || engine == Engine::Babelfish {
        c.ssl = SslMode::Disable;
    }
    Some((c, parts.get(3).map(|s| s.to_string())))
}

async fn open(engine: Engine, var: &str) -> Option<(Arc<Manager>, String)> {
    let (c, password) = config(engine, var)?;
    let manager = Arc::new(Manager::default());
    let info = manager.open(c.clone(), password).await.expect("connect");
    println!(
        "{var}: {} | {}",
        info.product,
        info.version.lines().next().unwrap_or("")
    );
    Some((manager, c.id))
}

fn opts() -> ExecOptions {
    ExecOptions::with_max_rows(100)
}

fn cell(out: &ExecOutput, set: usize, row: usize, col: usize) -> Value {
    out.results[set].rows[row][col].clone()
}

/// pgvector and PostGIS values as the grid gets them: the extension's type
/// name from the prepare, and the types' text output (vector text, hex EWKB).
#[tokio::test]
async fn postgres_extension_types() {
    if let Some((m, id)) = open(Engine::Postgres, "DBMS_TEST_PGVECTOR").await {
        let s = m.get(&id).unwrap();
        let setup = "CREATE EXTENSION IF NOT EXISTS vector;             DROP TABLE IF EXISTS dbms_vec;             CREATE TABLE dbms_vec (id int PRIMARY KEY, e vector(3));             INSERT INTO dbms_vec VALUES (1, '[1,2.5,-3]');             CREATE INDEX dbms_vec_e ON dbms_vec USING hnsw (e vector_cosine_ops) WITH (m = 16, ef_construction = 64)";
        let out = s.execute("tab1", "", setup, &opts()).await.unwrap();
        assert!(out.error.is_none(), "{:?}", out.error);
        let out = s
            .execute("tab1", "", "SELECT * FROM dbms_vec", &opts())
            .await
            .unwrap();
        assert_eq!(out.results[0].columns[1].type_name, "vector");
        assert_eq!(cell(&out, 0, 0, 1), json!("[1,2.5,-3]"));
        let out = s
            .execute(
                "tab1",
                "",
                "SELECT extname::text FROM pg_extension WHERE extname IN ('vector', 'postgis'); DROP TABLE dbms_vec",
                &opts(),
            )
            .await
            .unwrap();
        assert_eq!(cell(&out, 0, 0, 0), json!("vector"));
    }
    if let Some((m, id)) = open(Engine::Postgres, "DBMS_TEST_POSTGIS").await {
        let s = m.get(&id).unwrap();
        let setup = "CREATE EXTENSION IF NOT EXISTS postgis;             DROP TABLE IF EXISTS dbms_geo;             CREATE TABLE dbms_geo (id int PRIMARY KEY, g geometry(Point,4326), gg geography(Point,4326));             INSERT INTO dbms_geo VALUES (1, 'SRID=4326;POINT(-71.064544 42.28787)', 'SRID=4326;POINT(-71.06 42.28)');             UPDATE dbms_geo SET g = 'SRID=4326;POINT(1 2)'::geometry(Point,4326) WHERE id = 1";
        let out = s.execute("tab1", "", setup, &opts()).await.unwrap();
        assert!(out.error.is_none(), "{:?}", out.error);
        let out = s
            .execute("tab1", "", "SELECT * FROM dbms_geo", &opts())
            .await
            .unwrap();
        assert_eq!(out.results[0].columns[1].type_name, "geometry");
        assert_eq!(out.results[0].columns[2].type_name, "geography");
        // Hex EWKB, which the grid decodes to EWKT
        assert_eq!(
            cell(&out, 0, 0, 1),
            json!("0101000020E6100000000000000000F03F0000000000000040")
        );
        assert_eq!(
            cell(&out, 0, 0, 2),
            json!("0101000020E6100000A4703D0AD7C351C0A4703D0AD7234540")
        );
        let out = s
            .execute("tab1", "", "DROP TABLE dbms_geo", &opts())
            .await
            .unwrap();
        assert!(out.error.is_none(), "{:?}", out.error);
    }
}

#[tokio::test]
async fn postgres_end_to_end() {
    let Some((m, id)) = open(Engine::Postgres, "DBMS_TEST_PG").await else {
        return;
    };
    let s = m.get(&id).unwrap();
    let setup = "DROP TABLE IF EXISTS dbms_t; \
        CREATE TABLE dbms_t (id serial PRIMARY KEY, name text NOT NULL, amount numeric(10,2), data jsonb, at timestamptz DEFAULT now()); \
        COMMENT ON TABLE dbms_t IS 'test table'; \
        INSERT INTO dbms_t (name, amount, data) VALUES ('a', 1.5, '{\"x\":1}'), ('b', NULL, NULL); \
        DO $$ BEGIN RAISE NOTICE 'hello from plpgsql'; END $$; \
        SELECT * FROM dbms_t ORDER BY id; SELECT 1 AS one, 'two' AS two";
    let out = s.execute("tab1", "", setup, &opts()).await.unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(out.results.len(), 2);
    assert_eq!(out.results[0].rows.len(), 2);
    assert_eq!(cell(&out, 0, 0, 1), json!("a"));
    assert_eq!(cell(&out, 0, 1, 2), Value::Null);
    assert!(
        out.messages
            .iter()
            .any(|m| m.text.contains("hello from plpgsql")),
        "{:?}",
        out.messages
    );
    assert!(out.messages.iter().any(|m| m.text == "(2 rows affected)"));

    // Single statement gets column types via prepare
    let out = s
        .execute("tab1", "", "SELECT id, name, amount FROM dbms_t", &opts())
        .await
        .unwrap();
    assert_eq!(out.results[0].columns[0].type_name, "int4");
    assert_eq!(out.results[0].columns[2].type_name, "numeric");

    // Errors carry a position
    let out = s
        .execute("tab1", "", "SELECT nope FROM dbms_t", &opts())
        .await
        .unwrap();
    let err = out.error.expect("error");
    assert_eq!(err.position, Some(8));

    // Truncation
    let out = s
        .execute("tab1", "", "SELECT generate_series(1, 500)", &opts())
        .await
        .unwrap();
    assert!(out.results[0].truncated);
    assert_eq!(out.results[0].rows.len(), 100);
    assert_eq!(out.results[0].row_count, 500);

    // Metadata
    let dbs = s.list_databases().await.unwrap();
    assert!(dbs.iter().any(|d| d.name == "postgres"));
    let schemas = s.list_schemas("").await.unwrap();
    assert!(schemas.iter().any(|x| x.name == "public"));
    let objects = s.list_objects("", Some("public")).await.unwrap();
    let t = objects
        .iter()
        .find(|o| o.name == "dbms_t")
        .expect("table listed");
    assert_eq!(t.comment.as_deref(), Some("test table"));
    let info = s
        .describe_table("", Some("public"), "dbms_t")
        .await
        .unwrap();
    assert_eq!(info.primary_key, vec!["id"]);
    assert!(info.columns[0].is_generated);
    // serial is a nextval() default, not an identity
    assert!(!info.columns[0].is_identity);
    assert!(!info.columns[1].nullable);
    let completion = s.completion("").await.unwrap();
    assert!(
        completion
            .iter()
            .any(|t| t.name == "dbms_t" && t.columns.len() == 5)
    );
    // public is on the default search_path
    assert!(
        completion
            .iter()
            .any(|t| t.name == "dbms_t" && t.search_rank.is_some())
    );

    // Cancel a long query
    let s2 = s.clone();
    let cancel = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        s2.cancel("tab2");
    });
    let started = std::time::Instant::now();
    let out = s
        .execute("tab2", "", "SELECT pg_sleep(30)", &opts())
        .await
        .unwrap();
    cancel.await.unwrap();
    assert!(out.cancelled);
    assert!(started.elapsed() < Duration::from_secs(10));
    // Session still usable
    let out = s.execute("tab2", "", "SELECT 42", &opts()).await.unwrap();
    assert_eq!(cell(&out, 0, 0, 0), json!("42"));

    s.execute("tab1", "", "DROP TABLE dbms_t", &opts())
        .await
        .unwrap();
}

/// "Script as CREATE" for PostgreSQL tables: every script runs in an empty
/// copy of the schema and scripts the same table again.
#[tokio::test]
async fn postgres_table_ddl_round_trip() {
    let Some((m, id)) = open(Engine::Postgres, "DBMS_TEST_PG").await else {
        return;
    };
    let s = m.get(&id).unwrap();
    let run = |db: &'static str, sql: String| {
        let s = s.clone();
        async move {
            let out = s.execute("ddl", db, &sql, &opts()).await.unwrap();
            assert!(out.error.is_none(), "{sql}\n{:?}", out.error);
        }
    };
    run("", "DROP DATABASE IF EXISTS pg_ddl WITH (FORCE)".into()).await;
    run("", "CREATE DATABASE pg_ddl".into()).await;
    let setup = r#"CREATE EXTENSION btree_gist;
CREATE SCHEMA app;
CREATE TYPE app.mood AS ENUM ('sad', 'ok', 'happy');
CREATE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
CREATE SEQUENCE app.custom_seq START 50;
CREATE TABLE app.parent (
  id int GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 5 CACHE 10) PRIMARY KEY,
  code text COLLATE "C" NOT NULL,
  CONSTRAINT parent_code_key UNIQUE (code) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE app.items (
  id bigint GENERATED BY DEFAULT AS IDENTITY,
  serial_id serial NOT NULL,
  a int NOT NULL DEFAULT 1,
  b int GENERATED ALWAYS AS (a * 2) STORED,
  "Mixed Case" text DEFAULT 'it''s',
  mood app.mood,
  price numeric(10,2) CHECK (price > 0),
  parent_id int REFERENCES app.parent (id) ON DELETE CASCADE,
  room int,
  during tstzrange,
  custom int DEFAULT nextval('app.custom_seq'),
  CONSTRAINT items_pkey PRIMARY KEY (id),
  CONSTRAINT items_ab UNIQUE (a, b),
  CONSTRAINT no_overlap EXCLUDE USING gist (room WITH =, during WITH &&),
  CONSTRAINT items_parent_fk2 FOREIGN KEY (parent_id) REFERENCES app.parent (id) DEFERRABLE
) WITH (fillfactor = 70, autovacuum_enabled = false, toast.autovacuum_enabled = false);
ALTER TABLE app.items ADD CONSTRAINT price_cap CHECK (price < 1000) NOT VALID;
CREATE INDEX items_lower ON app.items (lower("Mixed Case")) WHERE a > 0;
CREATE UNIQUE INDEX items_cov ON app.items (a) INCLUDE (price);
ALTER TABLE app.items REPLICA IDENTITY USING INDEX items_cov;
COMMENT ON TABLE app.items IS 'Items with a \ backslash and ''quote''';
COMMENT ON COLUMN app.items.b IS 'double a';
COMMENT ON CONSTRAINT no_overlap ON app.items IS 'no double booking';
COMMENT ON INDEX app.items_lower IS 'lower idx';
CREATE TRIGGER items_touch BEFORE UPDATE ON app.items FOR EACH ROW
  WHEN (OLD.a IS DISTINCT FROM NEW.a) EXECUTE FUNCTION app.touch();
CREATE TRIGGER items_off AFTER INSERT ON app.items FOR EACH STATEMENT EXECUTE FUNCTION app.touch();
ALTER TABLE app.items DISABLE TRIGGER items_off;
COMMENT ON TRIGGER items_touch ON app.items IS 'touch';
ALTER TABLE app.items ENABLE ROW LEVEL SECURITY;
CREATE POLICY items_read ON app.items AS RESTRICTIVE FOR SELECT TO PUBLIC USING (a > 0);
CREATE UNLOGGED TABLE app.scratch (k int, v text);
CREATE TABLE app.events (id int NOT NULL, at date NOT NULL, kind text DEFAULT 'x',
  PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE INDEX events_kind ON app.events (kind);
CREATE TRIGGER events_touch BEFORE UPDATE ON app.events FOR EACH ROW EXECUTE FUNCTION app.touch();
CREATE TABLE app.events_2024 PARTITION OF app.events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE app.events_rest PARTITION OF app.events (kind WITH OPTIONS NOT NULL,
  CONSTRAINT rest_kind CHECK (kind <> '')) DEFAULT PARTITION BY RANGE (at);
CREATE TABLE app.events_rest_a PARTITION OF app.events_rest
  FOR VALUES FROM ('2000-01-01') TO ('2010-01-01');
CREATE TABLE app.base (id int, note text NOT NULL DEFAULT 'x');
CREATE TABLE app.child (extra int, CHECK (extra > 0)) INHERITS (app.base);
CREATE TABLE app.ownseq (id smallserial PRIMARY KEY);
ALTER SEQUENCE app.ownseq_id_seq INCREMENT BY 3;
CREATE TABLE app."Odd ""name""" ("x.y" int GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME app.odd_ids))"#;
    run("pg_ddl", setup.into()).await;

    // Parents before children, so the scripts run in this order
    let tables = [
        "parent",
        "items",
        "scratch",
        "events",
        "events_2024",
        "events_rest",
        "events_rest_a",
        "base",
        "child",
        "ownseq",
        "Odd \"name\"",
    ];
    let script = |name: &'static str| {
        let s = s.clone();
        async move {
            s.object_definition("pg_ddl", Some("app"), name, "table", None)
                .await
                .unwrap()
                .unwrap_or_else(|| panic!("no definition for {name}"))
        }
    };
    let mut first = Vec::new();
    for name in tables {
        first.push(script(name).await);
    }
    let items = &first[1];
    for expected in [
        "id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL",
        "serial_id serial NOT NULL",
        "b integer GENERATED ALWAYS AS (a * 2) STORED",
        "CONSTRAINT no_overlap EXCLUDE USING gist (room WITH =, during WITH &&)",
        "CONSTRAINT items_ab UNIQUE (a, b)",
        "ALTER TABLE app.items ADD CONSTRAINT price_cap CHECK (price < 1000::numeric) NOT VALID;",
        "WITH (fillfactor=70, autovacuum_enabled=false, toast.autovacuum_enabled=false)",
        r"COMMENT ON TABLE app.items IS E'Items with a \\ backslash and ''quote''';",
        "ALTER TABLE app.items DISABLE TRIGGER items_off;",
    ] {
        assert!(items.contains(expected), "{expected}\n---\n{items}");
    }
    assert!(!items.contains("CREATE INDEX no_overlap"), "{items}");
    assert!(!items.contains("CREATE UNIQUE INDEX items_ab"), "{items}");
    assert!(
        first[0].contains("GENERATED ALWAYS AS IDENTITY (START WITH 100 INCREMENT BY 5 CACHE 10)"),
        "{}",
        first[0]
    );
    assert!(
        first[2].starts_with("CREATE UNLOGGED TABLE"),
        "{}",
        first[2]
    );
    assert!(
        first[5].contains(
            "PARTITION OF app.events (\n  kind WITH OPTIONS NOT NULL,\n  CONSTRAINT rest_kind"
        ),
        "{}",
        first[5]
    );
    assert!(first[8].contains("INHERITS (app.base)"), "{}", first[8]);
    assert!(
        first[9].contains("CREATE SEQUENCE app.ownseq_id_seq AS smallint INCREMENT BY 3;"),
        "{}",
        first[9]
    );

    // Rebuild from the scripts and compare what the catalog says now
    run(
        "pg_ddl",
        "DROP TABLE app.items, app.parent, app.scratch, app.events, app.child, app.base, \
         app.ownseq, app.\"Odd \"\"name\"\"\""
            .into(),
    )
    .await;
    run("pg_ddl", first.join("\n\n")).await;
    for (name, before) in tables.into_iter().zip(&first) {
        assert_eq!(&script(name).await, before, "{name}");
    }

    m.close(&id).await;
    let Some((m, id)) = open(Engine::Postgres, "DBMS_TEST_PG").await else {
        return;
    };
    let s = m.get(&id).unwrap();
    s.execute("ddl", "", "DROP DATABASE pg_ddl WITH (FORCE)", &opts())
        .await
        .unwrap();
}

/// The guard the table tab wraps around UPDATE / DELETE when it edits by ctid
/// (`expectOneRow` in row-locator.ts; its test pins the same text).
fn expect_one_row(statement: &str) -> String {
    format!(
        "DO $dbms_edit$\nDECLARE dbms_rows bigint;\nBEGIN\n  {statement};\n  \
         GET DIAGNOSTICS dbms_rows = ROW_COUNT;\n  IF dbms_rows <> 1 THEN\n    \
         RAISE EXCEPTION 'Row changed since it was loaded (it was updated, deleted or moved); refresh and retry';\n  \
         END IF;\nEND\n$dbms_edit$"
    )
}

/// Tables without a primary key are edited by ctid (tableoid + ctid when
/// partitioned); a row that changed since it was loaded rolls the commit back.
#[tokio::test]
async fn postgres_edit_by_row_location() {
    let Some((m, id)) = open(Engine::Postgres, "DBMS_TEST_PG").await else {
        return;
    };
    let s = m.get(&id).unwrap();
    let run = |session: &'static str, sql: String| {
        let s = s.clone();
        async move { s.execute(session, "", &sql, &opts()).await.unwrap() }
    };
    let setup = "DROP TABLE IF EXISTS dbms_nopk, dbms_parted; \
        CREATE TABLE dbms_nopk (a int, b text); \
        INSERT INTO dbms_nopk VALUES (1, 'x'), (1, 'x'), (2, 'y'); \
        CREATE TABLE dbms_parted (k int, v text) PARTITION BY RANGE (k); \
        CREATE TABLE dbms_parted_1 PARTITION OF dbms_parted FOR VALUES FROM (0) TO (10); \
        CREATE TABLE dbms_parted_2 PARTITION OF dbms_parted FOR VALUES FROM (10) TO (20); \
        INSERT INTO dbms_parted VALUES (1, 'a'), (11, 'b')";
    let out = run("tab", setup.into()).await;
    assert!(out.error.is_none(), "{:?}", out.error);

    // What the grid loads: the hidden ctid ahead of the table's columns
    let load = || run("tab", "SELECT ctid, *\nFROM dbms_nopk\nLIMIT 101".into());
    let ctid = |rows: &ExecOutput, row: usize| cell(rows, 0, row, 0).as_str().unwrap().to_owned();
    let rows = load().await;
    let first = ctid(&rows, 0);

    // One of two identical rows changes
    let script = format!(
        "BEGIN;\n{};\nCOMMIT;",
        expect_one_row(&format!(
            "UPDATE dbms_nopk SET b = 'z' WHERE ctid = '{first}'"
        ))
    );
    let out = run("tab", script).await;
    assert!(out.error.is_none(), "{:?}", out.error);
    let out = run(
        "tab",
        "SELECT count(*) FILTER (WHERE b = 'z'), count(*) FROM dbms_nopk".into(),
    )
    .await;
    assert_eq!(cell(&out, 0, 0, 0), json!("1"));
    assert_eq!(cell(&out, 0, 0, 1), json!("3"));

    // Another session updates a row after it was loaded: its ctid moves
    let rows = load().await;
    let y = (0..3)
        .find(|&i| cell(&rows, 0, i, 2) == json!("y"))
        .expect("row y");
    let stale = ctid(&rows, y);
    let other = (0..3).find(|&i| i != y).unwrap();
    let out = run(
        "other",
        "UPDATE dbms_nopk SET b = 'y2' WHERE b = 'y'".into(),
    )
    .await;
    assert!(out.error.is_none(), "{:?}", out.error);
    let script = format!(
        "BEGIN;\n{};\n{};\nCOMMIT;",
        expect_one_row(&format!(
            "DELETE FROM dbms_nopk WHERE ctid = '{}'",
            ctid(&rows, other)
        )),
        expect_one_row(&format!(
            "UPDATE dbms_nopk SET b = 'lost' WHERE ctid = '{stale}'"
        ))
    );
    let out = run("tab", script).await;
    let err = out.error.expect("a stale ctid fails");
    assert!(
        err.message.contains("Row changed since it was loaded"),
        "{err:?}"
    );
    // The table tab rolls back after a failed commit; nothing was applied
    run("tab", "ROLLBACK".into()).await;
    let out = run(
        "tab",
        "SELECT count(*), count(*) FILTER (WHERE b = 'lost') FROM dbms_nopk".into(),
    )
    .await;
    assert_eq!(cell(&out, 0, 0, 0), json!("3"));
    assert_eq!(cell(&out, 0, 0, 1), json!("0"));

    // Partitions repeat ctids; tableoid tells them apart
    let rows = run(
        "tab",
        "SELECT tableoid, ctid, *\nFROM dbms_parted\nORDER BY k\nLIMIT 101".into(),
    )
    .await;
    assert_eq!(
        cell(&rows, 0, 0, 1),
        cell(&rows, 0, 1, 1),
        "same ctid in both partitions"
    );
    let script = format!(
        "BEGIN;\n{};\nCOMMIT;",
        expect_one_row(&format!(
            "UPDATE dbms_parted SET v = 'A' WHERE tableoid = '{}' AND ctid = '{}'",
            cell(&rows, 0, 0, 0).as_str().unwrap(),
            cell(&rows, 0, 0, 1).as_str().unwrap()
        ))
    );
    let out = run("tab", script).await;
    assert!(out.error.is_none(), "{:?}", out.error);
    let out = run(
        "tab",
        "SELECT string_agg(v, ',' ORDER BY k) FROM dbms_parted".into(),
    )
    .await;
    assert_eq!(cell(&out, 0, 0, 0), json!("A,b"));

    run("tab", "DROP TABLE dbms_nopk, dbms_parted".into()).await;
}

#[tokio::test]
async fn postgres_materialized_views() {
    let Some((m, id)) = open(Engine::Postgres, "DBMS_TEST_PG").await else {
        return;
    };
    let s = m.get(&id).unwrap();
    let setup = "DROP SCHEMA IF EXISTS dbms_mv CASCADE; CREATE SCHEMA dbms_mv; \
        CREATE TABLE dbms_mv.orders (id int PRIMARY KEY, region text, amount numeric); \
        INSERT INTO dbms_mv.orders SELECT g, 'r' || (g % 3), g FROM generate_series(1, 30) g; \
        CREATE MATERIALIZED VIEW dbms_mv.totals WITH (fillfactor = 80) AS \
          SELECT region, sum(amount) AS total FROM dbms_mv.orders GROUP BY region WITH NO DATA; \
        CREATE UNIQUE INDEX totals_region ON dbms_mv.totals (region); \
        COMMENT ON MATERIALIZED VIEW dbms_mv.totals IS 'per region'; \
        COMMENT ON COLUMN dbms_mv.totals.total IS 'it''s a sum'";
    let out = s.execute("mv", "", setup, &opts()).await.unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);

    let ddl = s
        .object_definition("", Some("dbms_mv"), "totals", "materialized_view", None)
        .await
        .unwrap()
        .expect("definition");
    // No DDL in the messages: CodeQL treats what this connection reads as secret
    assert!(ddl.starts_with("CREATE MATERIALIZED VIEW dbms_mv.totals WITH (fillfactor=80) AS\n"));
    assert!(ddl.contains("\nWITH NO DATA;"));
    assert!(ddl.contains("CREATE UNIQUE INDEX totals_region ON dbms_mv.totals"));
    assert!(ddl.contains("COMMENT ON MATERIALIZED VIEW dbms_mv.totals IS 'per region';"));
    assert!(ddl.contains("COMMENT ON COLUMN dbms_mv.totals.total IS 'it''s a sum';"));

    // Reading it fails until it's refreshed, with the message the table tab looks for
    let out = s
        .execute("mv", "", "SELECT * FROM dbms_mv.totals", &opts())
        .await
        .unwrap();
    let err = out.error.expect("unpopulated");
    assert!(err.message.contains("has not been populated"), "{err:?}");

    // Completion lists its columns, which information_schema.columns doesn't
    let completion = s.completion("").await.unwrap();
    let totals = completion
        .iter()
        .find(|t| t.schema.as_deref() == Some("dbms_mv") && t.name == "totals")
        .expect("matview in completion");
    assert_eq!(totals.columns, vec!["region", "total"]);

    // The DDL recreates it as it was
    let out = s
        .execute(
            "mv",
            "",
            &format!("DROP MATERIALIZED VIEW dbms_mv.totals; {ddl}"),
            &opts(),
        )
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    let again = s
        .object_definition("", Some("dbms_mv"), "totals", "materialized_view", None)
        .await
        .unwrap();
    assert_eq!(again.as_deref(), Some(ddl.as_str()));

    // Populated views drop WITH NO DATA and refresh concurrently on the unique index
    let out = s
        .execute(
            "mv",
            "",
            "REFRESH MATERIALIZED VIEW dbms_mv.totals; \
             REFRESH MATERIALIZED VIEW CONCURRENTLY dbms_mv.totals; \
             SELECT count(*) FROM dbms_mv.totals",
            &opts(),
        )
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(cell(&out, 0, 0, 0), json!("3"));
    let ddl = s
        .object_definition("", Some("dbms_mv"), "totals", "materialized_view", None)
        .await
        .unwrap()
        .unwrap();
    assert!(!ddl.contains("WITH NO DATA"));
    assert!(ddl.contains("GROUP BY region;"));

    s.execute("mv", "", "DROP SCHEMA dbms_mv CASCADE", &opts())
        .await
        .unwrap();
}

#[tokio::test]
async fn mariadb_end_to_end() {
    // MariaDB uses the MySQL engine; the frontend tells them apart by `product`
    let Some((c, password)) = config(Engine::Mysql, "DBMS_TEST_MARIADB") else {
        return;
    };
    let m = Manager::default();
    let info = m.open(c.clone(), password).await.expect("connect");
    // No message arguments: the info comes from a password-bearing connect
    assert!(info.product.starts_with("MariaDB "));
    assert!(info.version.contains("MariaDB"));
    let s = m.get(&c.id).unwrap();
    let out = s
        .execute(
            "tab1",
            "",
            "SELECT IF(VERSION() LIKE '%MariaDB%', 'yes', 'no')",
            &opts(),
        )
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(cell(&out, 0, 0, 0), json!("yes"));
    m.close(&c.id).await;
}

/// Signs in as `user`, on a connection config of its own.
async fn sign_in(
    c: &ConnectionConfig,
    user: &str,
    password: &str,
) -> Result<ServerInfo, crate::error::AppError> {
    let mut c = c.clone();
    c.id = format!("{}-{user}", c.id);
    c.user = user.into();
    let m = Manager::default();
    let result = m.open(c.clone(), Some(password.into())).await;
    m.close(&c.id).await;
    result
}

/// A password for a test account, made up per run
fn test_password() -> String {
    format!("Pw_{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
}

/// Runs root's SQL, failing the test on an error. `what` labels the assert: the SQL can
/// hold a password, and CodeQL treats what the server returns as secret.
async fn run_sql(m: &Manager, id: &str, what: &str, sql: &str) -> ExecOutput {
    let out = m
        .get(id)
        .unwrap()
        .execute("tab1", "", sql, &opts())
        .await
        .unwrap();
    assert!(out.error.is_none(), "{what}");
    out
}

#[tokio::test]
async fn mariadb_auth_plugins() {
    // Every method signs in, through mysql_async's client_ed25519 / client_parsec for those two
    let Some((c, password)) = config(Engine::Mysql, "DBMS_TEST_MARIADB_AUTH") else {
        return;
    };
    let m = Manager::default();
    m.open(c.clone(), password).await.expect("connect");
    let plugins = "SELECT PLUGIN_NAME FROM information_schema.PLUGINS \
                   WHERE PLUGIN_TYPE = 'AUTHENTICATION' AND PLUGIN_STATUS = 'ACTIVE'";
    let s = m.get(&c.id).unwrap();
    for soname in ["auth_ed25519", "auth_parsec"] {
        // Already loaded, or not shipped (parsec is 11.6+): either is fine
        let _ = s
            .execute("tab1", "", &format!("INSTALL SONAME '{soname}'"), &opts())
            .await;
    }
    let out = run_sql(&m, &c.id, "list plugins", plugins).await;
    let active: Vec<Value> = out.results[0].rows.iter().map(|r| r[0].clone()).collect();
    assert!(active.contains(&json!("ed25519")), "{active:?}");

    let tag = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let pw = test_password();
    let users = [
        ("ed", format!("ed25519 USING PASSWORD('{pw}')")),
        ("pa", format!("parsec USING PASSWORD('{pw}')")),
        (
            "na",
            format!("mysql_native_password USING PASSWORD('{pw}')"),
        ),
        (
            "or",
            format!("unix_socket OR mysql_native_password USING PASSWORD('{pw}')"),
        ),
        // A wrong password falls through to ed25519, which used to panic the driver
        (
            "ne",
            format!(
                "mysql_native_password USING PASSWORD('{pw}') OR ed25519 USING PASSWORD('{pw}')"
            ),
        ),
    ];
    let mut created = vec![];
    for (kind, via) in &users {
        if *kind == "pa" && !active.contains(&json!("parsec")) {
            continue;
        }
        let name = format!("dbms_auth_{kind}_{tag}");
        run_sql(
            &m,
            &c.id,
            &format!("create {kind} user"),
            &format!("CREATE USER '{name}'@'%' IDENTIFIED VIA {via}"),
        )
        .await;
        created.push((*kind, name));
    }

    // Messages name the account kind only: CodeQL treats the sign-in's output as secret
    for (kind, name) in &created {
        let signed_in = sign_in(&c, name, &pw).await;
        assert!(
            signed_in.is_ok_and(|info| info.product.contains("MariaDB")),
            "{kind} user didn't sign in"
        );
    }
    // A wrong password is the server's plain refusal, whichever method gets it last
    let wrong_pw = format!("{pw}_wrong");
    for (kind, name) in &created {
        let refused = sign_in(&c, name, &wrong_pw).await;
        assert!(
            refused.is_err_and(|e| e.to_string().contains("1045")),
            "{kind} user: no ERROR 1045 for a wrong password"
        );
    }

    for (kind, name) in &created {
        run_sql(
            &m,
            &c.id,
            &format!("drop {kind} user"),
            &format!("DROP USER '{name}'@'%'"),
        )
        .await;
    }
    m.close(&c.id).await;
}

#[tokio::test]
async fn mysql_caching_sha2_sign_in() {
    let Some((c, password)) = config(Engine::Mysql, "DBMS_TEST_MYSQL") else {
        return;
    };
    let m = Manager::default();
    m.open(c.clone(), password).await.expect("connect");
    let name = format!(
        "mdb_auth_{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let pw = test_password();
    run_sql(
        &m,
        &c.id,
        "create user",
        &format!("CREATE USER '{name}'@'%' IDENTIFIED WITH caching_sha2_password BY '{pw}'"),
    )
    .await;
    let result = sign_in(&c, &name, &pw).await;
    run_sql(&m, &c.id, "drop user", &format!("DROP USER '{name}'@'%'")).await;
    m.close(&c.id).await;
    assert!(
        result.is_ok_and(|info| info.product.starts_with("MySQL")),
        "caching_sha2_password user didn't sign in"
    );
}

/// The server tab's replication panel reads these through the driver. Point the variables at
/// a replica: `DBMS_TEST_MARIADB_REPLICA=localhost:53329:root:password` (with a named
/// connection) or `DBMS_TEST_MYSQL_REPLICA=localhost:53331:root:password` (8.0.22+).
#[tokio::test]
async fn replica_status() {
    for (var, sql, running) in [
        (
            "DBMS_TEST_MARIADB_REPLICA",
            "SHOW ALL REPLICAS STATUS",
            "Slave_IO_Running",
        ),
        (
            "DBMS_TEST_MYSQL_REPLICA",
            "SHOW REPLICA STATUS",
            "Replica_IO_Running",
        ),
    ] {
        let Some((m, id)) = open(Engine::Mysql, var).await else {
            continue;
        };
        let s = m.get(&id).unwrap();
        let out = s.execute(META, "", sql, &opts()).await.unwrap();
        assert!(out.error.is_none(), "{:?}", out.error);
        let set = &out.results[0];
        assert!(!set.rows.is_empty(), "{var} is not a replica");
        let col = |name: &str| set.columns.iter().position(|c| c.name == name);
        let io = col(running).expect(running);
        assert!(
            ["Yes", "No", "Connecting"].contains(&set.rows[0][io].as_str().unwrap_or("")),
            "{:?}",
            set.rows[0][io]
        );
        // NULL lag (SQL thread stopped) arrives as null, not the string "NULL"
        let lag = col("Seconds_Behind_Master")
            .or(col("Seconds_Behind_Source"))
            .unwrap();
        for row in &set.rows {
            assert!(
                row[lag].is_null() || row[lag].as_str().is_some_and(|v| v.parse::<u64>().is_ok())
            );
        }
        m.close(&id).await;
    }
}

#[tokio::test]
async fn mariadb_sequences() {
    let Some((m, id)) = open(Engine::Mysql, "DBMS_TEST_MARIADB").await else {
        return;
    };
    let s = m.get(&id).unwrap();
    let out = s
        .execute(
            "tab1",
            "",
            "DROP DATABASE IF EXISTS mdb_sequences; CREATE DATABASE mdb_sequences; USE mdb_sequences;              CREATE SEQUENCE seq START WITH 10 INCREMENT BY 5 CACHE 20 CYCLE; CREATE TABLE t (id INT)",
            &opts(),
        )
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    let objects = s.list_objects("mdb_sequences", None).await.unwrap();
    let seq = objects.iter().find(|o| o.name == "seq").unwrap();
    assert_eq!(seq.kind, "sequence");
    assert_eq!(seq.row_estimate, None);
    assert!(objects.iter().any(|o| o.name == "t" && o.kind == "table"));
    let ddl = s
        .object_definition("mdb_sequences", None, "seq", "sequence", None)
        .await
        .unwrap()
        .unwrap();
    // No DDL in the messages: CodeQL traces the session's password into anything it returns
    assert!(ddl.starts_with("CREATE SEQUENCE `seq`"));
    assert!(ddl.contains("increment by 5") && ddl.contains(" cycle"));
    // The details view reads the sequence's single row
    let out = s
        .execute("tab1", "", "SELECT * FROM mdb_sequences.seq", &opts())
        .await
        .unwrap();
    assert_eq!(out.results[0].columns[0].name, "next_not_cached_value");
    assert_eq!(cell(&out, 0, 0, 0), json!("10"));
    s.execute("tab1", "", "DROP DATABASE mdb_sequences", &opts())
        .await
        .unwrap();
}

#[tokio::test]
async fn mariadb_column_types() {
    // INET4 / INET6 / UUID / VECTOR, INVISIBLE and COMPRESSED columns as the grid and designer see them
    let Some((m, id)) = open(Engine::Mysql, "DBMS_TEST_MARIADB").await else {
        return;
    };
    let s = m.get(&id).unwrap();
    let out = s
        .execute(
            "tab1",
            "",
            "DROP DATABASE IF EXISTS mdb_coltypes; CREATE DATABASE mdb_coltypes; USE mdb_coltypes; \
             CREATE TABLE t (id INT PRIMARY KEY, ip4 INET4, ip6 INET6, u UUID, v VECTOR(2) NOT NULL, \
               secret INT INVISIBLE, notes TEXT COMPRESSED, VECTOR INDEX vix (v)); \
             INSERT INTO t (id, ip4, ip6, u, v, secret, notes) VALUES \
               (1, '10.0.0.1', '2001:db8::1', '123e4567-e89b-12d3-a456-426614174000', VEC_FromText('[1,-2.5]'), 7, 'hi'); \
             SELECT ip4, ip6, u, v FROM t",
            &opts(),
        )
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    let set = &out.results[0];
    let types: Vec<&str> = set.columns.iter().map(|c| c.type_name.as_str()).collect();
    println!("DBMS_TEST_MARIADB: wire types {types:?}");
    assert_eq!(set.rows[0][0], json!("10.0.0.1"));
    assert_eq!(set.rows[0][1], json!("2001:db8::1"));
    assert_eq!(
        set.rows[0][2],
        json!("123e4567-e89b-12d3-a456-426614174000")
    );
    // Little-endian float32s: 1.0, -2.5
    assert_eq!(set.rows[0][3], json!("0x0000803F000020C0"));

    // SELECT * leaves invisible columns out
    let out = s
        .execute("tab1", "", "SELECT * FROM t", &opts())
        .await
        .unwrap();
    assert!(!out.results[0].columns.iter().any(|c| c.name == "secret"));

    // Edits the grid writes: hex and VEC_FromText for vectors, text for the others
    let out = s
        .execute(
            "tab1",
            "",
            "UPDATE t SET v = 0x00000040000080BF, ip6 = '::ffff:1.2.3.4' WHERE id = 1; \
             SELECT VEC_ToText(v), ip6 FROM t; \
             UPDATE t SET v = VEC_FromText('[3,4]') WHERE id = 1; SELECT VEC_ToText(v) FROM t",
            &opts(),
        )
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(cell(&out, 0, 0, 0), json!("[2,-1]"));
    assert_eq!(cell(&out, 0, 0, 1), json!("::ffff:1.2.3.4"));
    assert_eq!(cell(&out, 1, 0, 0), json!("[3,4]"));

    let info = s.describe_table("mdb_coltypes", None, "t").await.unwrap();
    let column = |name: &str| info.columns.iter().find(|c| c.name == name).unwrap();
    assert_eq!(column("secret").extra.as_deref(), Some("INVISIBLE"));
    assert_eq!(column("notes").data_type, "text /*M!100301 COMPRESSED*/");
    assert_eq!(column("v").data_type, "vector(2)");
    let vix = info.indexes.iter().find(|i| i.name == "vix").unwrap();
    assert_eq!(vix.method.as_deref(), Some("VECTOR"));

    s.execute("tab1", "", "DROP DATABASE mdb_coltypes", &opts())
        .await
        .unwrap();
}

#[tokio::test]
async fn mariadb_explain_json() {
    // The plan viewer reads MariaDB's EXPLAIN/ANALYZE FORMAT=JSON out of a single text cell
    let Some((c, password)) = config(Engine::Mysql, "DBMS_TEST_MARIADB") else {
        return;
    };
    let m = Manager::default();
    m.open(c.clone(), password.clone()).await.expect("connect");
    let s = m.get(&c.id).unwrap();
    let run = |sql: &'static str| {
        let s = s.clone();
        async move {
            let out = s.execute("tab1", "", sql, &opts()).await.unwrap();
            assert!(out.error.is_none(), "{sql}: {:?}", out.error);
            out
        }
    };
    run(
        "DROP DATABASE IF EXISTS mdb_explain; CREATE DATABASE mdb_explain; USE mdb_explain; \
         CREATE TABLE t (id INT PRIMARY KEY, a INT); \
         INSERT INTO t SELECT seq, seq % 10 FROM seq_1_to_100",
    )
    .await;
    let plan = |out: &ExecOutput| -> Value {
        let text = cell(out, 0, 0, 0);
        serde_json::from_str(text.as_str().expect("plan is a text cell")).expect("plan is JSON")
    };

    let doc = plan(&run("EXPLAIN FORMAT=JSON\nSELECT * FROM mdb_explain.t WHERE a = 3").await);
    let table = &doc["query_block"]["nested_loop"][0]["table"];
    assert_eq!(table["access_type"], json!("ALL"), "{doc}");
    assert!(table.get("r_rows").is_none(), "{doc}");

    let doc = plan(&run("ANALYZE FORMAT=JSON\nSELECT * FROM mdb_explain.t WHERE a = 3").await);
    let table = &doc["query_block"]["nested_loop"][0]["table"];
    assert_eq!(table["r_rows"].as_f64(), Some(100.0), "{doc}");
    assert_eq!(table["r_filtered"].as_f64(), Some(10.0), "{doc}");

    // ANALYZE runs the statement: a read-only connection refuses it for a write...
    let (mut ro, _) = config(Engine::Mysql, "DBMS_TEST_MARIADB").unwrap();
    ro.read_only = true;
    ro.id = "ro".into();
    m.open(ro, password).await.unwrap();
    let blocked = m
        .get("ro")
        .unwrap()
        .execute(
            "tab",
            "",
            "ANALYZE FORMAT=JSON\nDELETE FROM mdb_explain.t",
            &opts(),
        )
        .await;
    assert!(blocked.is_err());
    // ...and a writable one really deletes the rows
    let doc = plan(&run("ANALYZE FORMAT=JSON\nDELETE FROM mdb_explain.t WHERE a = 3").await);
    assert_eq!(doc["query_block"]["table"]["delete"], json!(1), "{doc}");
    let out = run("SELECT COUNT(*) FROM mdb_explain.t").await;
    assert_eq!(cell(&out, 0, 0, 0), json!("90"));

    run("DROP DATABASE mdb_explain").await;
    m.close("ro").await;
    m.close(&c.id).await;
}

#[tokio::test]
async fn mysql_end_to_end() {
    let Some((m, id)) = open(Engine::Mysql, "DBMS_TEST_MYSQL").await else {
        return;
    };
    let s = m.get(&id).unwrap();
    let out = s
        .execute(
            "tab1",
            "",
            "CREATE DATABASE IF NOT EXISTS dbms_test; USE dbms_test; DROP TABLE IF EXISTS t; \
             CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NOT NULL, b BIT(1), bin VARBINARY(4), d DATETIME(3), j JSON, INDEX ix_name (name)); \
             INSERT INTO t (name, b, bin, d, j) VALUES ('a', b'1', 0xDEAD, '2024-01-02 03:04:05.678', '{\"x\": 1}'), ('b', b'0', NULL, NULL, NULL); \
             SELECT * FROM t ORDER BY id; SELECT 1",
            &opts(),
        )
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(out.database.as_deref(), Some("dbms_test"));
    assert_eq!(out.results.len(), 2, "{:?}", out.messages);
    let set = &out.results[0];
    assert_eq!(set.rows.len(), 2);
    assert_eq!(set.rows[0][2], json!("1"));
    assert_eq!(set.rows[0][3], json!("0xDEAD"));
    assert_eq!(set.rows[0][4], json!("2024-01-02 03:04:05.678"));
    assert_eq!(set.columns[0].type_name, "int");

    let out = s.execute("tab1", "", "SELECT nope", &opts()).await.unwrap();
    assert!(out.error.unwrap().message.contains("1054"));

    let dbs = s.list_databases().await.unwrap();
    assert!(dbs.iter().any(|d| d.name == "dbms_test"));
    let objects = s.list_objects("dbms_test", None).await.unwrap();
    assert!(objects.iter().any(|o| o.name == "t" && o.kind == "table"));
    let info = s.describe_table("dbms_test", None, "t").await.unwrap();
    assert_eq!(info.primary_key, vec!["id"]);
    assert!(info.columns[0].is_identity);
    assert_eq!(info.columns[0].extra.as_deref(), Some("auto_increment"));
    assert!(info.indexes.iter().any(|i| i.name == "ix_name"));
    let ddl = s
        .object_definition("dbms_test", None, "t", "table", None)
        .await
        .unwrap()
        .unwrap();
    assert!(ddl.contains("CREATE TABLE"));

    let s2 = s.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        s2.cancel("tab2");
    });
    let started = std::time::Instant::now();
    let out = s
        .execute("tab2", "", "SELECT SLEEP(30)", &opts())
        .await
        .unwrap();
    assert!(out.cancelled);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "cancel took {:?}",
        started.elapsed()
    );
    let out = s.execute("tab2", "", "SELECT 7", &opts()).await.unwrap();
    assert_eq!(cell(&out, 0, 0, 0), json!("7"));

    // The timeout also stops a slow statement after one without results
    let started = std::time::Instant::now();
    let limited = ExecOptions {
        timeout_secs: Some(1),
        ..opts()
    };
    let out = s
        .execute("tab2", "", "DO 0; DO SLEEP(30)", &limited)
        .await
        .unwrap();
    assert!(out.cancelled);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "timeout took {:?}",
        started.elapsed()
    );
    // ...and its KILL QUERY doesn't hit what runs next
    let out = s.execute("tab2", "", "SELECT 8", &opts()).await.unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(cell(&out, 0, 0, 0), json!("8"));
    s.execute("tab1", "", "DROP DATABASE dbms_test", &opts())
        .await
        .unwrap();
}

async fn tds_suite(engine: Engine, var: &str) {
    let Some((m, id)) = open(engine, var).await else {
        return;
    };
    let s = m.get(&id).unwrap();
    // Clean up after an earlier failed run
    s.execute(
        "tab1",
        "",
        "USE master;\nGO\nIF DB_ID('dbms_test') IS NOT NULL DROP DATABASE dbms_test",
        &opts(),
    )
    .await
    .unwrap();
    let script = "CREATE DATABASE dbms_test;\nGO\nUSE dbms_test;\nGO\n\
        CREATE TABLE dbo.t (id INT IDENTITY PRIMARY KEY, name NVARCHAR(50) NOT NULL, amount DECIMAL(10,2), g UNIQUEIDENTIFIER, d DATETIME2, b BIT, bin VARBINARY(4));\nGO\n\
        INSERT INTO dbo.t (name, amount, g, d, b, bin) VALUES (N'ä', 1.50, '6F9619FF-8B86-D011-B42D-00C04FC964FF', '2024-01-02 03:04:05.678', 1, 0xBEEF), ('b', NULL, NULL, NULL, 0, NULL);\n\
        PRINT 'printed';\n\
        SELECT * FROM dbo.t ORDER BY id;\n\
        GO 2\n";
    let out = s.execute("tab1", "", script, &opts()).await.unwrap();
    assert!(out.error.is_none(), "{:?}", out.messages);
    assert_eq!(out.database.as_deref(), Some("dbms_test"));
    assert_eq!(
        out.results.len(),
        2,
        "GO 2 repeats the batch: {:?}",
        out.messages
    );
    let set = &out.results[1];
    assert_eq!(set.rows.len(), 4);
    assert_eq!(set.rows[0][1], json!("ä"));
    assert_eq!(set.rows[0][2], json!("1.50"));
    assert_eq!(
        set.rows[0][3],
        json!("6F9619FF-8B86-D011-B42D-00C04FC964FF")
    );
    // datetime2 keeps its scale (7 by default)
    assert_eq!(set.rows[0][4], json!("2024-01-02 03:04:05.6780000"));
    assert_eq!(set.rows[0][5], json!("1"));
    assert_eq!(set.rows[0][6], json!("0xBEEF"));
    assert_eq!(set.columns[1].type_name, "nvarchar");
    assert!(
        out.messages.iter().any(|m| m.text == "printed"),
        "{:?}",
        out.messages
    );
    assert!(
        out.messages.iter().any(|m| m.text == "(2 rows affected)"),
        "{:?}",
        out.messages
    );

    let out = s
        .execute("tab1", "", "SELECT 1;\nSELECT nope FROM dbo.t;", &opts())
        .await
        .unwrap();
    let err = out.error.expect("error");
    assert_eq!(err.line, Some(2), "{}", err.message);
    assert_eq!(out.results.len(), 1, "results before the error survive");

    // Values keep the column's exact precision, so grid edits can match them
    let out = s
        .execute(
            "tab1",
            "",
            "SELECT CAST('2024-01-01 12:00:00.1234567' AS datetime2), \
             CAST('2024-01-01 12:00:00.12' AS datetime2(2)), \
             CAST('2024-01-01 12:00:00.123' AS datetime), \
             CAST('12:00:00.1234567' AS time), CAST('12:00:00' AS time(0)), \
             CAST('2024-01-01 12:00:00.1234567 +02:00' AS datetimeoffset), \
             CAST(5 AS decimal(10,0)), CAST(-0.05 AS decimal(10,2)), \
             CAST(922337203685477.5807 AS money), CAST(-922337203685477.5808 AS money), \
             CAST(-1.5 AS smallmoney), CAST(NULL AS money)",
            &opts(),
        )
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    // Babelfish stores times as PostgreSQL does, to the microsecond
    let frac = if engine == Engine::Babelfish {
        "1234570"
    } else {
        "1234567"
    };
    let expected = [
        json!(format!("2024-01-01 12:00:00.{frac}")),
        json!("2024-01-01 12:00:00.12"),
        json!("2024-01-01 12:00:00.123"),
        json!(format!("12:00:00.{frac}")),
        json!("12:00:00"),
        json!(format!("2024-01-01 12:00:00.{frac} +02:00")),
        json!("5"),
        json!("-0.05"),
        json!("922337203685477.5807"),
        json!("-922337203685477.5808"),
        json!("-1.5000"),
        Value::Null,
    ];
    for (i, want) in expected.iter().enumerate() {
        assert_eq!(&cell(&out, 0, 0, i), want, "column {i}");
    }

    // A string or line comment holding /* doesn't hide later GO separators
    let out = s
        .execute(
            "tab1",
            "dbms_test",
            "PRINT '/* start'\nGO\nCREATE PROCEDURE dbo.p AS SELECT 8 -- old /*\nGO\nEXEC dbo.p",
            &opts(),
        )
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    assert_eq!(cell(&out, 0, 0, 0), json!("8"));

    let dbs = s.list_databases().await.unwrap();
    assert!(dbs.iter().any(|d| d.name == "dbms_test"));
    let schemas = s.list_schemas("dbms_test").await.unwrap();
    assert!(schemas.iter().any(|x| x.name == "dbo"));
    let objects = s.list_objects("dbms_test", None).await.unwrap();
    assert!(
        objects.iter().any(|o| o.name == "t" && o.kind == "table"),
        "{objects:?}"
    );
    let info = s
        .describe_table("dbms_test", Some("dbo"), "t")
        .await
        .unwrap();
    assert_eq!(info.primary_key, vec!["id"]);
    assert!(info.columns[0].is_generated, "{:?}", info.columns[0]);
    assert!(info.columns[0].is_identity, "{:?}", info.columns[0]);
    assert!(!info.columns[1].is_identity);
    assert_eq!(info.columns[1].data_type, "nvarchar(50)");
    let completion = s.completion("dbms_test").await.unwrap();
    assert!(completion.iter().any(|t| t.name == "t"));

    s.execute(
        "tab1",
        "dbms_test",
        "CREATE OR ALTER VIEW dbo.v AS SELECT id FROM dbo.t",
        &opts(),
    )
    .await
    .unwrap();
    let def = s
        .object_definition("dbms_test", Some("dbo"), "v", "view", None)
        .await
        .unwrap();
    assert!(def.unwrap_or_default().to_lowercase().contains("select id"));

    let s2 = s.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        s2.cancel("tab2");
    });
    // Babelfish doesn't implement WAITFOR; a long loop works on both
    let slow = if engine == Engine::Babelfish {
        "DECLARE @i BIGINT = 0; WHILE @i < 1000000000 SET @i = @i + 1;"
    } else {
        "WAITFOR DELAY '00:00:30'"
    };
    let started = std::time::Instant::now();
    let out = s.execute("tab2", "", slow, &opts()).await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "cancel took {:?}",
        started.elapsed()
    );
    assert!(out.cancelled);
    let out = s.execute("tab2", "", "SELECT 7", &opts()).await.unwrap();
    assert_eq!(cell(&out, 0, 0, 0), json!("7"));

    s.execute(
        "tab1",
        "",
        "USE master;\nGO\nDROP DATABASE dbms_test",
        &opts(),
    )
    .await
    .unwrap();
    let _ = s.execute(META, "", "SELECT 1", &opts()).await;
}

#[tokio::test]
async fn mssql_end_to_end() {
    tds_suite(Engine::Mssql, "DBMS_TEST_MSSQL").await;
}

#[tokio::test]
async fn babelfish_end_to_end() {
    tds_suite(Engine::Babelfish, "DBMS_TEST_BABELFISH").await;
}

#[tokio::test]
async fn mongo_end_to_end() {
    let Some((m, id)) = open(Engine::Mongo, "DBMS_TEST_MONGO").await else {
        return;
    };
    let s = m.get(&id).unwrap();
    let run = |req: Value| {
        let s = s.clone();
        async move {
            let request: MongoRequest = serde_json::from_value(req).unwrap();
            s.mongo_execute("tab", request, &opts()).await.unwrap()
        }
    };
    run(json!({ "op": "dropDatabase", "database": "dbms_test" })).await;
    let ins = run(json!({ "op": "insertMany", "database": "dbms_test", "collection": "users", "documents": [
        { "name": "a", "age": 30, "big": { "$numberLong": "9007199254740993" }, "at": { "$date": "2024-01-02T03:04:05.678Z" }, "score": { "$numberDouble": "2.0" } },
        { "name": "b", "age": 41, "tags": ["x", "y"], "nested": { "deep": true } }
    ]}))
    .await;
    assert_eq!(ins.value.unwrap()["insertedCount"], json!(2));
    let found = run(json!({ "op": "find", "database": "dbms_test", "collection": "users", "filter": { "age": { "$gt": 35 } }, "count": true })).await;
    assert_eq!(found.documents.len(), 1);
    assert_eq!(found.total, Some(1));
    let all = run(json!({ "op": "find", "database": "dbms_test", "collection": "users", "sort": { "name": 1 } })).await;
    let a = &all.documents[0];
    assert_eq!(a["big"], json!({ "$numberLong": "9007199254740993" }));
    assert_eq!(a["score"], json!({ "$numberDouble": "2.0" }));
    assert!(a["_id"]["$oid"].is_string());

    // Round-trip edit keeps types
    let mut edited = a.clone();
    edited["name"] = json!("a2");
    let r = run(json!({ "op": "replaceOne", "database": "dbms_test", "collection": "users", "filter": { "_id": a["_id"] }, "replacement": edited })).await;
    assert_eq!(r.value.unwrap()["modifiedCount"], json!(1));
    let again = run(json!({ "op": "find", "database": "dbms_test", "collection": "users", "filter": { "_id": a["_id"] } })).await;
    assert_eq!(
        again.documents[0]["big"],
        json!({ "$numberLong": "9007199254740993" })
    );
    assert_eq!(again.documents[0]["name"], json!("a2"));

    let agg = run(json!({ "op": "aggregate", "database": "dbms_test", "collection": "users", "pipeline": [{ "$group": { "_id": null, "avg": { "$avg": "$age" } } }] })).await;
    assert_eq!(agg.documents[0]["avg"], json!(35.5));
    run(json!({ "op": "createIndex", "database": "dbms_test", "collection": "users", "keys": { "name": 1 }, "options": { "unique": true } })).await;
    let ix =
        run(json!({ "op": "listIndexes", "database": "dbms_test", "collection": "users" })).await;
    assert!(ix.documents.iter().any(|d| d["name"] == json!("name_1")));
    let colls = s.list_objects("dbms_test", None).await.unwrap();
    assert!(colls.iter().any(|c| c.name == "users"));
    let dbs = s.list_databases().await.unwrap();
    assert!(dbs.iter().any(|d| d.name == "dbms_test"));

    // Read-only connections block writes
    let (mut c, _) = config(Engine::Mongo, "DBMS_TEST_MONGO").unwrap();
    c.read_only = true;
    c.id = "ro".into();
    m.open(c, None).await.unwrap();
    let ro = m.get("ro").unwrap();
    let req: MongoRequest = serde_json::from_value(
        json!({ "op": "deleteMany", "database": "dbms_test", "collection": "users", "filter": {} }),
    )
    .unwrap();
    assert!(ro.mongo_execute("tab", req, &opts()).await.is_err());

    run(json!({ "op": "dropDatabase", "database": "dbms_test" })).await;
}

#[tokio::test]
async fn redis_end_to_end() {
    let Some((m, id)) = open(Engine::Redis, "DBMS_TEST_REDIS").await else {
        return;
    };
    let s = m.get(&id).unwrap();
    let run = |req: Value| {
        let s = s.clone();
        async move {
            let request: RedisRequest = serde_json::from_value(req).unwrap();
            s.redis_execute("tab", request, &opts()).await
        }
    };
    let db = "15";
    run(json!({ "op": "flush", "database": db })).await.unwrap();

    // One key of every type, plus a binary key
    run(json!({ "op": "set", "database": db, "key": "user:1:name", "value": "Ada", "ttlMs": 60000 })).await.unwrap();
    run(json!({ "op": "hashSet", "database": db, "key": "user:1", "field": "email", "value": "ada@example.com" })).await.unwrap();
    run(json!({ "op": "listPush", "database": db, "key": "queue", "values": ["a", "b", "c"] }))
        .await
        .unwrap();
    run(json!({ "op": "setAdd", "database": db, "key": "tags", "members": ["x", "y"] }))
        .await
        .unwrap();
    run(
        json!({ "op": "zsetAdd", "database": db, "key": "scores", "member": "ada", "score": 42.5 }),
    )
    .await
    .unwrap();
    run(json!({ "op": "streamAdd", "database": db, "key": "events", "fields": [["kind", "login"]] })).await.unwrap();
    run(json!({ "op": "set", "database": db, "key": { "$hex": "00ff" }, "value": { "$hex": "deadbeef" } })).await.unwrap();

    let page = run(json!({ "op": "scan", "database": db })).await.unwrap();
    assert_eq!(page.keys.len(), 7);
    assert!(page.cursor.is_none());
    let name = page
        .keys
        .iter()
        .find(|k| k.key == json!("user:1:name"))
        .unwrap();
    assert_eq!(name.kind, "string");
    assert!(name.ttl > 0 && name.ttl <= 60000);
    let hashes = run(json!({ "op": "scan", "database": db, "keyType": "hash" }))
        .await
        .unwrap();
    assert_eq!(hashes.keys.len(), 1);
    let users = run(json!({ "op": "scan", "database": db, "pattern": "user:*" }))
        .await
        .unwrap();
    assert_eq!(users.keys.len(), 2);

    let get = |key: Value| run(json!({ "op": "get", "database": db, "key": key }));
    let v = get(json!("user:1:name")).await.unwrap();
    assert_eq!(v.value, Some(json!("Ada")));
    assert_eq!(v.length, Some(3));
    let v = get(json!({ "$hex": "00ff" })).await.unwrap();
    assert_eq!(v.value, Some(json!({ "$hex": "deadbeef" })));
    let v = get(json!("user:1")).await.unwrap();
    assert_eq!(
        v.entries,
        vec![json!({ "field": "email", "value": "ada@example.com" })]
    );
    let v = get(json!("scores")).await.unwrap();
    assert_eq!(v.entries[0]["score"], json!(42.5));
    let v = get(json!("events")).await.unwrap();
    assert_eq!(v.entries[0]["fields"], json!([["kind", "login"]]));

    // Lists remove by index, and page by offset
    run(json!({ "op": "listRemove", "database": db, "key": "queue", "index": 1 }))
        .await
        .unwrap();
    let v = run(json!({ "op": "get", "database": db, "key": "queue", "count": 1 }))
        .await
        .unwrap();
    assert_eq!(v.length, Some(2));
    assert_eq!(v.entries, vec![json!({ "index": 0, "value": "a" })]);
    assert_eq!(v.cursor.as_deref(), Some("1"));

    // TTL, rename and refusing to clobber
    run(json!({ "op": "expire", "database": db, "key": "user:1:name" }))
        .await
        .unwrap();
    assert_eq!(get(json!("user:1:name")).await.unwrap().ttl, Some(-1));
    run(json!({ "op": "rename", "database": db, "key": "tags", "newKey": "labels" }))
        .await
        .unwrap();
    assert!(
        run(json!({ "op": "rename", "database": db, "key": "labels", "newKey": "queue" }))
            .await
            .is_err()
    );
    assert!(
        run(json!({ "op": "set", "database": db, "key": "queue", "value": "x", "onlyNew": true }))
            .await
            .is_err()
    );

    // Console replies, including server errors
    let reply = |args: &[&str]| run(json!({ "op": "command", "database": db, "args": args }));
    assert_eq!(
        reply(&["DBSIZE"]).await.unwrap().reply,
        Some(json!({ "t": "int", "v": 7 }))
    );
    assert_eq!(
        reply(&["HINCRBY", "user:1", "email", "1"])
            .await
            .unwrap()
            .reply
            .unwrap()["t"],
        json!("error")
    );
    assert!(reply(&["SELECT", "1"]).await.is_err());

    // Keyspace listing counts keys
    let dbs = s.list_databases().await.unwrap();
    assert_eq!(dbs.iter().find(|d| d.name == db).unwrap().keys, Some(7));

    // Cancelling a blocking command leaves the session usable
    let blocked = {
        let s = s.clone();
        tokio::spawn(async move {
            let request: RedisRequest = serde_json::from_value(
                json!({ "op": "command", "database": db, "args": ["BLPOP", "nothing", "0"] }),
            )
            .unwrap();
            s.redis_execute("blocker", request, &opts()).await.unwrap()
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    s.cancel("blocker");
    assert!(blocked.await.unwrap().cancelled);
    let request: RedisRequest =
        serde_json::from_value(json!({ "op": "command", "database": db, "args": ["PING"] }))
            .unwrap();
    let pong = s.redis_execute("blocker", request, &opts()).await.unwrap();
    assert_eq!(pong.reply, Some(json!({ "t": "status", "v": "PONG" })));

    // Pub/Sub forwards published messages
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    s.redis_subscribe(
        "sub".into(),
        vec!["news".into()],
        vec!["alerts:*".into()],
        move |b| {
            let _ = tx.send(b);
        },
    )
    .await
    .unwrap();
    reply(&["PUBLISH", "news", "hello"]).await.unwrap();
    reply(&["PUBLISH", "alerts:disk", "full"]).await.unwrap();
    let mut got = Vec::new();
    while got.len() < 2 {
        let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
            .unwrap();
        got.extend(batch.messages);
    }
    assert_eq!(got[0].payload, json!("hello"));
    assert_eq!(got[1].pattern.as_deref(), Some("alerts:*"));
    s.redis_unsubscribe("sub");

    // Pattern deletes and read-only connections
    let n = run(json!({ "op": "deleteMatching", "database": db, "pattern": "user:*" }))
        .await
        .unwrap();
    assert_eq!(n.reply, Some(json!({ "t": "int", "v": 2 })));
    let (mut c, _) = config(Engine::Redis, "DBMS_TEST_REDIS").unwrap();
    c.read_only = true;
    c.id = "ro".into();
    m.open(c, None).await.unwrap();
    let ro = m.get("ro").unwrap();
    let write: RedisRequest = serde_json::from_value(
        json!({ "op": "command", "database": db, "args": ["DEL", "queue"] }),
    )
    .unwrap();
    assert!(ro.redis_execute("tab", write, &opts()).await.is_err());
    let read: RedisRequest = serde_json::from_value(
        json!({ "op": "command", "database": db, "args": ["LLEN", "queue"] }),
    )
    .unwrap();
    assert!(ro.redis_execute("tab", read, &opts()).await.is_ok());

    // Pipelines report rejected commands without failing the batch
    let piped = run(json!({ "op": "pipeline", "database": db, "commands": [
        ["SET", "p:1", "a"], ["HSET", "p:1", "f", "v"], ["RPUSH", "p:list", "x", "y"]
    ]}))
    .await
    .unwrap();
    assert_eq!(piped.reply, Some(json!({ "t": "int", "v": 2 })));
    assert_eq!(piped.entries.len(), 1);
    assert_eq!(piped.entries[0]["index"], json!(1));
    assert!(
        piped.entries[0]["error"]
            .as_str()
            .unwrap()
            .starts_with("WRONGTYPE")
    );
    let refused =
        run(json!({ "op": "pipeline", "database": db, "commands": [["SELECT", "2"]] })).await;
    assert!(refused.is_err());

    run(json!({ "op": "flush", "database": db })).await.unwrap();
}

/// A sharded cluster through the host-list form: `DBMS_TEST_MONGOS=host:port` of a mongos.
#[tokio::test]
async fn mongo_sharded_cluster() {
    let Ok(raw) = std::env::var("DBMS_TEST_MONGOS") else {
        return;
    };
    let (mut c, _) = config(Engine::Mongo, "DBMS_TEST_MONGOS").unwrap();
    let (host, port) = raw.rsplit_once(':').unwrap();
    c.uri = String::new();
    // The same router twice, as a seed list
    c.host = format!("{host},127.0.0.1");
    c.port = port.parse().unwrap();
    c.read_preference = "secondaryPreferred".into();
    c.read_only = true;
    let m = Manager::default();
    let info = m.open(c.clone(), None).await.expect("connect");
    assert!(info.product.ends_with("(sharded)"), "{}", info.product);
    // Cluster status commands still work on a read-only connection
    let s = m.get(&c.id).unwrap();
    for command in [json!({ "listShards": 1 }), json!({ "balancerStatus": 1 })] {
        let req: MongoRequest = serde_json::from_value(
            json!({ "op": "runCommand", "database": "admin", "command": command }),
        )
        .unwrap();
        let out = s.mongo_execute("tab", req, &opts()).await.unwrap();
        assert_eq!(out.value.unwrap()["ok"], json!({ "$numberDouble": "1.0" }));
    }
    let req: MongoRequest = serde_json::from_value(
        json!({ "op": "runCommand", "database": "admin", "command": { "balancerStop": 1 } }),
    )
    .unwrap();
    assert!(s.mongo_execute("tab", req, &opts()).await.is_err());
}

/// Procedures and functions are listed and described on every SQL engine.
#[tokio::test]
async fn routines_end_to_end() {
    let tsql = "IF OBJECT_ID('dbo.probe_proc') IS NOT NULL DROP PROCEDURE dbo.probe_proc;\n\
        IF OBJECT_ID('dbo.probe_fn') IS NOT NULL DROP FUNCTION dbo.probe_fn;\n\
        IF OBJECT_ID('dbo.probe_tvf') IS NOT NULL DROP FUNCTION dbo.probe_tvf;\nGO\n\
        CREATE PROCEDURE dbo.probe_proc @x INT, @y NVARCHAR(10) = N'a' OUTPUT AS SELECT @x;\nGO\n\
        CREATE FUNCTION dbo.probe_fn(@a INT) RETURNS INT AS BEGIN RETURN @a + 1 END;\nGO\n\
        CREATE FUNCTION dbo.probe_tvf(@a INT) RETURNS TABLE AS RETURN SELECT @a AS a;";
    let cases = [
        (
            Engine::Postgres,
            "DBMS_TEST_PG",
            "postgres",
            "DROP PROCEDURE IF EXISTS probe_proc(int); DROP PROCEDURE IF EXISTS probe_proc(int, text); \n             CREATE OR REPLACE FUNCTION probe_fn(a int, b int DEFAULT 2) RETURNS int LANGUAGE sql AS $$ SELECT a + b $$; \
             CREATE OR REPLACE PROCEDURE probe_proc(x int, INOUT y text) LANGUAGE plpgsql AS $$ BEGIN y := x::text; END $$;",
        ),
        (
            Engine::Mysql,
            "DBMS_TEST_MYSQL",
            "probe",
            "CREATE DATABASE IF NOT EXISTS probe; USE probe; DROP PROCEDURE IF EXISTS probe_proc; DROP FUNCTION IF EXISTS probe_fn; \
             CREATE PROCEDURE probe_proc(IN x INT, OUT y INT) SET y = x * 2; \
             CREATE FUNCTION probe_fn(a INT) RETURNS INT DETERMINISTIC RETURN a + 1;",
        ),
        (Engine::Mssql, "DBMS_TEST_MSSQL", "master", tsql),
        (Engine::Babelfish, "DBMS_TEST_BABELFISH", "master", tsql),
    ];
    for (engine, var, db, setup) in cases {
        let Some((m, id)) = open(engine, var).await else {
            continue;
        };
        let s = m.get(&id).unwrap();
        let setup_db = if engine == Engine::Mysql { "" } else { db };
        let out = s.execute("t", setup_db, setup, &opts()).await.unwrap();
        assert!(out.error.is_none(), "{var}: {:?}", out.error);

        let schema = (engine == Engine::Postgres).then_some("public");
        let objects = s.list_objects(db, schema).await.unwrap();
        let find = |name: &str| {
            objects
                .iter()
                .find(|o| o.name == name)
                .unwrap_or_else(|| panic!("{var}: {name} not listed"))
        };
        assert_eq!(find("probe_proc").kind, "procedure", "{var}");
        assert_eq!(find("probe_fn").kind, "function", "{var}");

        let routine_schema = if engine == Engine::Mysql {
            None
        } else {
            find("probe_fn").schema.as_deref()
        };
        let f = s
            .describe_routine(
                db,
                routine_schema,
                "probe_fn",
                "function",
                find("probe_fn").detail.as_deref(),
            )
            .await
            .unwrap();
        assert_eq!(f.params[0].mode, "IN", "{var}: {f:?}");
        assert!(
            f.returns.as_deref().is_some_and(|r| r.contains("int")),
            "{var}: {f:?}"
        );
        let p = s
            .describe_routine(
                db,
                routine_schema,
                "probe_proc",
                "procedure",
                find("probe_proc").detail.as_deref(),
            )
            .await
            .unwrap();
        assert_eq!(p.params.len(), 2, "{var}: {p:?}");
        assert!(
            matches!(p.params[1].mode.as_str(), "OUT" | "INOUT" | "OUTPUT"),
            "{var}: {p:?}"
        );
        assert!(p.returns.is_none(), "{var}: {p:?}");

        if engine == Engine::Mssql || engine == Engine::Babelfish {
            let tvf = s
                .describe_routine(db, Some("dbo"), "probe_tvf", "function", None)
                .await
                .unwrap();
            assert_eq!(tvf.returns.as_deref(), Some("TABLE"), "{var}: {tvf:?}");
            assert!(p.params[1].data_type.starts_with("nvarchar"), "{var}");
        }
        // PostgreSQL reports security and planner attributes; other engines leave them out
        if engine == Engine::Postgres {
            let attrs = f.attributes.as_ref().expect("attributes");
            assert!(!attrs.security_definer, "{attrs:?}");
            assert_eq!(attrs.volatility, "VOLATILE");
            assert_eq!(attrs.parallel, "UNSAFE");
            assert_eq!(attrs.cost, 100.0);
            let out = s
                .execute(
                    "t",
                    db,
                    "CREATE OR REPLACE FUNCTION probe_secdef() RETURNS SETOF int LANGUAGE sql \
                     IMMUTABLE STRICT PARALLEL SAFE LEAKPROOF COST 5 ROWS 20 SECURITY DEFINER \
                     SET search_path = pg_catalog, pg_temp AS 'SELECT 1'",
                    &opts(),
                )
                .await
                .unwrap();
            assert!(out.error.is_none(), "{:?}", out.error);
            let d = s
                .describe_routine(db, Some("public"), "probe_secdef", "function", Some(""))
                .await
                .unwrap();
            let attrs = d.attributes.expect("attributes");
            // Messages name the server only: CodeQL treats what this connection reads as secret
            assert!(
                attrs.security_definer && attrs.strict && attrs.leakproof,
                "{var}"
            );
            assert_eq!(attrs.volatility, "IMMUTABLE");
            assert_eq!(attrs.parallel, "SAFE");
            assert_eq!((attrs.cost, attrs.rows), (5.0, 20.0));
            assert_eq!(attrs.config, vec!["search_path=pg_catalog, pg_temp"]);
            s.execute("t", db, "DROP FUNCTION probe_secdef()", &opts())
                .await
                .unwrap();
        } else {
            assert!(f.attributes.is_none(), "{var}");
        }
        println!("{var}: fn {f:?}\n{var}: proc {p:?}");

        // Run the exact statements the Execute dialog generates (see routines.test.ts)
        let calls: &[(&str, &str)] = match engine {
            Engine::Postgres => &[
                ("SELECT *\nFROM public.probe_fn(a => 1);", "3"),
                ("CALL public.probe_proc(x => 3, y => NULL);", "3"),
            ],
            Engine::Mysql => &[(
                "CALL `probe`.`probe_proc`(2 + 2, @y);\nSELECT @y AS `y`;",
                "8",
            )],
            _ => &[
                (
                    "DECLARE @y nvarchar(10);\nEXEC [dbo].[probe_proc]\n  @x = 5,\n  @y = @y OUTPUT;\nSELECT @y AS [@y];",
                    "5",
                ),
                ("SELECT [dbo].[probe_fn](1) AS [probe_fn];", "2"),
                ("SELECT *\nFROM [dbo].[probe_tvf](3);", "3"),
            ],
        };
        for (sql, expected) in calls {
            let out = s.execute("t", db, sql, &opts()).await.unwrap();
            assert!(out.error.is_none(), "{var}: {sql}\n{:?}", out.error);
            assert_eq!(cell(&out, 0, 0, 0), json!(expected), "{var}: {sql}");
        }

        // MySQL routine bodies contain semicolons and are sent without DELIMITER
        if engine == Engine::Mysql {
            let template = "DROP PROCEDURE IF EXISTS new_procedure;\n\
                CREATE PROCEDURE new_procedure(IN p_id INT, OUT p_count INT)\nBEGIN\n  -- procedure body\n  \
                SELECT COUNT(*) INTO p_count FROM information_schema.tables WHERE table_schema = DATABASE();\nEND;\n\
                CALL new_procedure(1, @c);\nSELECT @c IS NOT NULL;";
            let out = s.execute("t", db, template, &opts()).await.unwrap();
            assert!(out.error.is_none(), "{var}: {:?}", out.error);
        }
    }
}

/// Each tab reports whether it holds a transaction open, and other sessions can
/// be ended from the server tab.
#[tokio::test]
async fn transactions_and_session_kill() {
    let engines = [
        (
            Engine::Postgres,
            "DBMS_TEST_PG",
            "BEGIN",
            "SELECT pg_backend_pid()",
        ),
        (
            Engine::Mysql,
            "DBMS_TEST_MYSQL",
            "START TRANSACTION",
            "SELECT CONNECTION_ID()",
        ),
        (
            Engine::Mssql,
            "DBMS_TEST_MSSQL",
            "BEGIN TRANSACTION",
            "SELECT @@SPID",
        ),
        (
            Engine::Babelfish,
            "DBMS_TEST_BABELFISH",
            "BEGIN TRANSACTION",
            "SELECT @@SPID",
        ),
    ];
    for (engine, var, begin, whoami) in engines {
        let Some((m, id)) = open(engine, var).await else {
            continue;
        };
        let s = m.get(&id).unwrap();
        let run = |sql: &'static str| {
            let s = s.clone();
            async move { s.execute("tx", "", sql, &opts()).await.unwrap() }
        };
        assert_eq!(run("SELECT 1").await.in_transaction, Some(false), "{var}");
        assert_eq!(run(begin).await.in_transaction, Some(true), "{var}");
        assert_eq!(run("SELECT 2").await.in_transaction, Some(true), "{var}");
        let commit = if engine == Engine::Postgres || engine == Engine::Mysql {
            "COMMIT"
        } else {
            "COMMIT TRANSACTION"
        };
        assert_eq!(run(commit).await.in_transaction, Some(false), "{var}");

        // A failed PostgreSQL transaction still needs a ROLLBACK
        if engine == Engine::Postgres {
            run("BEGIN").await;
            let out = run("SELECT 1/0").await;
            assert!(out.error.is_some());
            assert_eq!(out.in_transaction, Some(true));
            assert_eq!(run("ROLLBACK").await.in_transaction, Some(false));
        }

        // Metadata sessions aren't probed
        let meta = s.execute(META, "", "SELECT 1", &opts()).await.unwrap();
        assert_eq!(meta.in_transaction, None, "{var}");

        // Kill another session the way the server tab does
        let victim = run(whoami).await;
        let victim_id = match cell(&victim, 0, 0, 0) {
            Value::String(v) => v,
            other => other.to_string(),
        };
        let kill = match engine {
            Engine::Postgres => format!("SELECT pg_terminate_backend({victim_id})"),
            _ => format!("KILL {victim_id}"),
        };
        let out = s.execute(META, "", &kill, &opts()).await.unwrap();
        assert!(out.error.is_none(), "{var}: {:?}", out.error);
        // The killed tab reconnects on its next run
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut ok = false;
        for _ in 0..3 {
            let out = s.execute("tx", "", whoami, &opts()).await;
            if let Ok(out) = out
                && out.error.is_none()
            {
                assert_ne!(cell(&out, 0, 0, 0).to_string(), victim_id, "{var}");
                ok = true;
                break;
            }
        }
        assert!(ok, "{var}: the killed session didn't reconnect");
    }
}

#[tokio::test]
async fn sqlite_transactions() {
    let dir = std::env::temp_dir().join(format!("dbms-tx-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.db");
    std::fs::write(&path, b"").unwrap();
    let c: ConnectionConfig = serde_json::from_value(json!({
        "id": "sqlite-tx", "name": "t", "engine": "sqlite", "host": path.to_string_lossy()
    }))
    .unwrap();
    let m = Manager::default();
    m.open(c, None).await.expect("open");
    let s = m.get("sqlite-tx").unwrap();
    let run = |sql: &'static str| {
        let s = s.clone();
        async move { s.execute("tx", "", sql, &opts()).await.unwrap() }
    };
    assert_eq!(run("CREATE TABLE t (x)").await.in_transaction, Some(false));
    assert_eq!(run("BEGIN").await.in_transaction, Some(true));
    assert_eq!(
        run("INSERT INTO t VALUES (1)").await.in_transaction,
        Some(true)
    );
    assert_eq!(run("ROLLBACK").await.in_transaction, Some(false));
    m.close("sqlite-tx").await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn concurrent_first_uses_share_one_session() {
    let dir = std::env::temp_dir().join(format!("dbms-race-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.db");
    std::fs::write(&path, b"").unwrap();
    let c: ConnectionConfig = serde_json::from_value(json!({
        "id": "sqlite-race", "name": "t", "engine": "sqlite", "host": path.to_string_lossy()
    }))
    .unwrap();
    let m = Manager::default();
    m.open(c, None).await.expect("open");
    let s = m.get("sqlite-race").unwrap();
    for i in 0..20 {
        let key = format!("tab{i}");
        let (a, b) = tokio::join!(s.session(&key, ""), s.session(&key, ""));
        assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()), "{key}");
    }
    m.close("sqlite-race").await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// `DBMS_TEST_SSH=host:port:user:keyfile:dbhost` tunnels `DBMS_TEST_PG`
/// through an SSH server that reaches PostgreSQL at `dbhost`.
#[tokio::test]
async fn postgres_through_ssh_tunnel() {
    let Ok(raw) = std::env::var("DBMS_TEST_SSH") else {
        return;
    };
    let Some((mut c, password)) = config(Engine::Postgres, "DBMS_TEST_PG") else {
        return;
    };
    // The key file may hold a drive letter's colon, so the database host comes off the end
    let (rest, db_host) = raw.rsplit_once(':').unwrap();
    let parts: Vec<&str> = rest.splitn(4, ':').collect();
    c.id = "ssh-tunnel".into();
    c.host = db_host.into();
    c.ssh = Some(crate::config::SshConfig {
        enabled: true,
        host: parts[0].into(),
        port: parts[1].parse().unwrap(),
        user: parts[2].into(),
        auth: crate::config::SshAuth::Key,
        key_file: parts[3].into(),
        jump_host: String::new(),
    });
    let m = Manager::default();
    let info = m
        .open(c, password)
        .await
        .expect("connect through the tunnel");
    assert!(info.product.contains("PostgreSQL"), "{}", info.product);
    let s = m.get("ssh-tunnel").unwrap();
    let out = s
        .execute("t", "", "SELECT inet_server_addr()::text", &opts())
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    m.close("ssh-tunnel").await;
}

/// Scheduled events are listed with their status and schedule, and the scripts
/// the explorer builds for them (see events.test.ts) run on MySQL and MariaDB.
#[tokio::test]
async fn mysql_events_end_to_end() {
    for var in ["DBMS_TEST_MYSQL", "DBMS_TEST_MARIADB"] {
        let Some((m, id)) = open(Engine::Mysql, var).await else {
            continue;
        };
        let s = m.get(&id).unwrap();
        let db = "mdb_events";
        let setup = "DROP DATABASE IF EXISTS mdb_events; CREATE DATABASE mdb_events; USE mdb_events; \
            CREATE TABLE t (id INT); \
            CREATE EVENT ev_every ON SCHEDULE EVERY 1 HOUR STARTS '2026-01-01 00:00:00' ENDS '2030-01-01 00:00:00' \
              DISABLE COMMENT 'hourly cleanup' DO DELETE FROM t; \
            CREATE EVENT ev_once ON SCHEDULE AT '2030-05-01 12:00:00' DO INSERT INTO t VALUES (1);";
        let out = s.execute("t", "", setup, &opts()).await.unwrap();
        assert!(out.error.is_none(), "{var}: {:?}", out.error);

        let objects = s.list_objects(db, None).await.unwrap();
        let find = |name: &str| {
            objects
                .iter()
                .find(|o| o.name == name)
                .unwrap_or_else(|| panic!("{var}: {name} not listed"))
                .clone()
        };
        let every = find("ev_every");
        assert_eq!(every.kind, "event", "{var}");
        assert_eq!(every.comment.as_deref(), Some("hourly cleanup"), "{var}");
        let detail = every.detail.clone().unwrap_or_default();
        assert!(
            detail.starts_with(
                "DISABLED · EVERY 1 HOUR STARTS 2026-01-01 00:00:00 ENDS 2030-01-01 00:00:00"
            ),
            "{var}: {detail}"
        );
        assert!(detail.contains("definer root@"), "{var}: {detail}");
        let once = find("ev_once");
        assert!(
            once.detail
                .as_deref()
                .is_some_and(|d| d.starts_with("ENABLED · AT 2030-05-01 12:00:00")),
            "{var}: {:?}",
            once.detail
        );

        let ddl = s
            .object_definition(db, None, "ev_every", "event", None)
            .await
            .unwrap()
            .unwrap_or_default();
        // Messages name the server only: CodeQL treats what this connection reads as secret
        assert!(ddl.starts_with("CREATE DEFINER="), "{var}");
        assert!(
            ddl.contains("EVENT `ev_every` ON SCHEDULE EVERY 1 HOUR"),
            "{var}"
        );

        // Script as ALTER, then Disable, then the New event template (sent without DELIMITER)
        let alter =
            format!("ALTER{};", &ddl["CREATE".len()..]).replace("EVERY 1 HOUR", "EVERY 2 HOUR");
        let template = "CREATE EVENT new_event\nON SCHEDULE EVERY 1 DAY\nSTARTS CURRENT_TIMESTAMP + INTERVAL 1 HOUR\n\
            ON COMPLETION PRESERVE\nENABLE\nCOMMENT 'What this event does'\nDO\nBEGIN\n  \
            -- event body, e.g. DELETE FROM sessions WHERE expires_at < NOW();\n  SET @new_event_ran_at = NOW();\nEND;";
        for sql in [
            alter.as_str(),
            "ALTER EVENT `mdb_events`.`ev_once` DISABLE;",
            template,
        ] {
            let out = s.execute("t", db, sql, &opts()).await.unwrap();
            assert!(out.error.is_none(), "{var}: {sql}\n{:?}", out.error);
        }
        let objects = s.list_objects(db, None).await.unwrap();
        let detail = |name: &str| {
            objects
                .iter()
                .find(|o| o.name == name)
                .and_then(|o| o.detail.clone())
                .unwrap_or_else(|| panic!("{var}: {name} not listed"))
        };
        assert!(detail("ev_every").contains("EVERY 2 HOUR"), "{var}");
        assert!(detail("ev_once").starts_with("DISABLED"), "{var}");
        assert!(
            detail("new_event").starts_with("ENABLED · EVERY 1 DAY"),
            "{var}"
        );

        let out = s
            .execute("t", db, "SELECT @@event_scheduler", &opts())
            .await
            .unwrap();
        let scheduler = cell(&out, 0, 0, 0);
        assert!(
            ["ON", "OFF", "DISABLED"].contains(&scheduler.as_str().unwrap_or_default()),
            "{var}: {scheduler}"
        );
        println!("{var}: event_scheduler = {scheduler}");

        let out = s
            .execute("t", "", "DROP DATABASE mdb_events", &opts())
            .await
            .unwrap();
        assert!(out.error.is_none(), "{var}: {:?}", out.error);
        m.close(&id).await;
    }
}

/// Aggregates and window functions in the explorer, and catalog queries that
/// must also work on PostgreSQL 10 and 11 (`DBMS_TEST_PG_OLD`, e.g. postgres:11-alpine).
#[tokio::test]
async fn postgres_aggregates_and_old_servers() {
    for var in ["DBMS_TEST_PG", "DBMS_TEST_PG_OLD"] {
        let Some((m, id)) = open(Engine::Postgres, var).await else {
            continue;
        };
        let s = m.get(&id).unwrap();
        let db = "pg_objects";
        // DROP DATABASE can't share an (implicitly transactional) multi-statement query
        let terminate = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
            WHERE datname = 'pg_objects' AND pid <> pg_backend_pid()";
        let reset = "DROP DATABASE IF EXISTS pg_objects";
        for sql in [terminate, reset] {
            let out = s.execute("t", "", sql, &opts()).await.unwrap();
            assert!(out.error.is_none(), "{var}: {:?}", out.error);
        }
        let out = s
            .execute("t", "", "CREATE DATABASE pg_objects", &opts())
            .await
            .unwrap();
        assert!(out.error.is_none(), "{var}: {:?}", out.error);
        let setup = "CREATE TABLE t (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, n int, s serial); \
            CREATE AGGREGATE agg_sum(int) (SFUNC = int4pl, STYPE = int, INITCOND = '0', \
              COMBINEFUNC = int4pl, PARALLEL = SAFE); \
            CREATE AGGREGATE agg_moving(int) (SFUNC = int4pl, STYPE = int, INITCOND = '0', \
              MSFUNC = int4pl, MINVFUNC = int4mi, MSTYPE = int, MINITCOND = '0'); \
            CREATE AGGREGATE agg_max(int) (SFUNC = int4larger, STYPE = int, SORTOP = >); \
            CREATE AGGREGATE agg_count(*) (SFUNC = int8inc, STYPE = int8, INITCOND = '0'); \
            CREATE AGGREGATE agg_pct(float8 ORDER BY anyelement) (SFUNC = ordered_set_transition, \
              STYPE = internal, FINALFUNC = percentile_disc_final, FINALFUNC_EXTRA); \
            CREATE FUNCTION plain(a int) RETURNS int LANGUAGE sql AS $$ SELECT a $$;";
        let out = s.execute("t", db, setup, &opts()).await.unwrap();
        assert!(out.error.is_none(), "{var}: {:?}", out.error);

        let objects = s.list_objects(db, Some("public")).await.unwrap();
        let kind = |name: &str| {
            objects
                .iter()
                .find(|o| o.name == name)
                .map(|o| (o.kind.clone(), o.detail.clone().unwrap_or_default()))
                .unwrap_or_else(|| panic!("{var}: {name} not listed"))
        };
        assert_eq!(
            kind("plain"),
            ("function".into(), "a integer".into()),
            "{var}"
        );
        assert_eq!(
            kind("agg_sum"),
            ("aggregate".into(), "integer".into()),
            "{var}"
        );
        assert_eq!(
            kind("agg_count"),
            ("aggregate".into(), String::new()),
            "{var}"
        );
        assert_eq!(kind("t").0, "table", "{var}");
        let info = s.describe_table(db, Some("public"), "t").await.unwrap();
        assert_eq!(info.primary_key, vec!["id"], "{var}");
        assert!(
            info.columns[0].is_identity && info.columns[0].is_generated,
            "{var}"
        );
        assert!(!info.columns[1].is_generated, "{var}");
        assert!(info.columns[2].is_generated, "{var}");

        let catalog = s.list_objects(db, Some("pg_catalog")).await.unwrap();
        let find = |name: &str| {
            catalog
                .iter()
                .find(|o| o.name == name)
                .map(|o| o.kind.as_str())
        };
        assert_eq!(find("row_number"), Some("window_function"), "{var}");
        assert_eq!(find("count"), Some("aggregate"), "{var}");
        let ddl = s
            .object_definition(
                db,
                Some("pg_catalog"),
                "row_number",
                "window_function",
                Some(""),
            )
            .await
            .unwrap()
            .unwrap_or_default();
        // Messages name the server only: CodeQL treats what this connection reads as secret
        assert!(ddl.contains("WINDOW"), "{var}");
        let routine = s
            .describe_routine(db, Some("public"), "plain", "function", Some("a integer"))
            .await
            .unwrap();
        assert_eq!(routine.returns.as_deref(), Some("integer"), "{var}");

        // Every aggregate's DDL recreates it as it was
        for (name, args, expect) in [
            ("agg_sum", "integer", "COMBINEFUNC = int4pl"),
            ("agg_moving", "integer", "MINVFUNC = int4mi"),
            ("agg_max", "integer", "SORTOP = OPERATOR(pg_catalog.>)"),
            ("agg_count", "", "CREATE AGGREGATE public.agg_count (*)"),
            (
                "agg_pct",
                "double precision ORDER BY anyelement",
                "FINALFUNC_EXTRA",
            ),
        ] {
            let definition =
                || s.object_definition(db, Some("public"), name, "aggregate", Some(args));
            let ddl = definition().await.unwrap().unwrap_or_default();
            assert!(ddl.contains(expect), "{var}: {name}");
            let signature = if args.is_empty() { "*" } else { args };
            let sql = format!("DROP AGGREGATE public.{name}({signature}); {ddl}");
            let out = s.execute("t", db, &sql, &opts()).await.unwrap();
            assert!(out.error.is_none(), "{var}: {name}");
            assert_eq!(
                definition().await.unwrap().unwrap_or_default(),
                ddl,
                "{var}"
            );
        }
        let parallel = s
            .object_definition(db, Some("public"), "agg_sum", "aggregate", Some("integer"))
            .await
            .unwrap()
            .unwrap_or_default();
        assert!(parallel.contains("PARALLEL = SAFE"), "{var}");

        m.close(&id).await;
        let (m, id) = open(Engine::Postgres, var).await.unwrap();
        let s = m.get(&id).unwrap();
        let mut dropped = false;
        for _ in 0..10 {
            s.execute("t", "", terminate, &opts()).await.unwrap();
            let out = s.execute("t", "", reset, &opts()).await.unwrap();
            if out.error.is_none() {
                dropped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        assert!(dropped, "{var}: pg_objects not dropped");
        m.close(&id).await;
    }
}

/// Notifications show in the messages of the tab that LISTENs, and the
/// Notifications tab's own session streams them until it's closed.
#[tokio::test]
async fn postgres_listen_notify() {
    let Some((m, id)) = open(Engine::Postgres, "DBMS_TEST_PG").await else {
        return;
    };
    let s = m.get(&id).unwrap();
    let db = "pg_notify";
    for sql in [
        format!("DROP DATABASE IF EXISTS {db} WITH (FORCE)"),
        format!("CREATE DATABASE {db}"),
    ] {
        let out = s.execute(META, "", &sql, &opts()).await.unwrap();
        assert!(out.error.is_none(), "{:?}", out.error);
    }

    // An editor tab sees what arrived since its last statement, like psql
    let out = s
        .execute("ed1", db, "LISTEN pg_notify_editor", &opts())
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    s.execute("ed2", db, "NOTIFY pg_notify_editor, 'hello'", &opts())
        .await
        .unwrap();
    let pid = cell(
        &s.execute("ed2", db, "SELECT pg_backend_pid()", &opts())
            .await
            .unwrap(),
        0,
        0,
        0,
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    let out = s.execute("ed1", db, "SELECT 1", &opts()).await.unwrap();
    let line = format!(
        "NOTIFY pg_notify_editor (pid {}): hello",
        pid.as_str().unwrap()
    );
    assert!(
        out.messages.iter().any(|x| x.text == line),
        "{:?}",
        out.messages
    );
    // ...once
    let out = s.execute("ed1", db, "SELECT 1", &opts()).await.unwrap();
    assert!(!out.messages.iter().any(|x| x.text.starts_with("NOTIFY")));

    // The Notifications tab
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let emit = move |batch: NotifyBatch| {
        let _ = tx.send(batch);
    };
    let channels = s
        .pg_listen(
            "notify-tab",
            db,
            vec!["pg_notify_A".into(), "pg_notify b".into()],
            emit.clone(),
        )
        .await
        .unwrap();
    assert_eq!(channels, vec!["pg_notify b", "pg_notify_A"]);
    s.execute(
        "ed2",
        db,
        "SELECT pg_notify('pg_notify_A', '{\"n\":1}')",
        &opts(),
    )
    .await
    .unwrap();
    s.pg_notify("notify-tab", db, "pg_notify b", "", emit.clone())
        .await
        .unwrap();
    // Unquoted NOTIFY folds case, so this one goes to a channel nobody listens on
    s.execute("ed2", db, "NOTIFY pg_notify_A", &opts())
        .await
        .unwrap();
    let mut got = Vec::new();
    while got.len() < 2 {
        let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("notifications")
            .unwrap();
        assert_eq!(batch.listener, "notify-tab");
        assert!(batch.error.is_none(), "{:?}", batch.error);
        got.extend(batch.notifications);
    }
    assert_eq!(got[0].channel, "pg_notify_A");
    assert_eq!(got[0].payload, "{\"n\":1}");
    assert_eq!(got[0].pid.to_string(), pid.as_str().unwrap());
    assert_eq!(got[1].channel, "pg_notify b");
    assert_eq!(got[1].payload, "");
    assert!(
        tokio::time::timeout(Duration::from_millis(500), rx.recv())
            .await
            .is_err(),
        "nothing more arrives"
    );

    let left = s
        .pg_unlisten("notify-tab", vec!["pg_notify b".into()])
        .await
        .unwrap();
    assert_eq!(left, vec!["pg_notify_A"]);

    // Ending the listener's backend reports it, and listening again reconnects
    let out = s
        .execute(
            META,
            "",
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
             WHERE datname = 'pg_notify' AND query LIKE 'UNLISTEN%'",
            &opts(),
        )
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
    let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("disconnect reported")
        .unwrap();
    assert!(batch.error.is_some());
    // The new session listens on the old channels again
    let channels = s
        .pg_listen("notify-tab", db, vec!["pg_notify c".into()], emit.clone())
        .await
        .unwrap();
    assert_eq!(channels, vec!["pg_notify c", "pg_notify_A"]);
    s.execute("ed2", db, "NOTIFY \"pg_notify_A\", 'again'", &opts())
        .await
        .unwrap();
    let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("notification after reconnect")
        .unwrap();
    assert_eq!(batch.notifications[0].payload, "again");

    // Closing the tab ends its session
    s.close_session("notify-tab").await;
    assert!(
        s.pg_unlisten("notify-tab", Vec::new())
            .await
            .unwrap()
            .is_empty()
    );

    for tab in ["ed1", "ed2"] {
        s.close_session(tab).await;
    }
    let out = s
        .execute(
            META,
            "",
            &format!("DROP DATABASE {db} WITH (FORCE)"),
            &opts(),
        )
        .await
        .unwrap();
    assert!(out.error.is_none(), "{:?}", out.error);
}
