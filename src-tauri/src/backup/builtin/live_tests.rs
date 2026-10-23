//! Round trips through live servers: back a database up with the built-in
//! engine, restore it into a fresh one, and compare the two. Each test runs
//! only when its `DBMS_TEST_*` variable is set (see integration_tests.rs).

use std::path::PathBuf;
use std::sync::Arc;

use mongodb::bson::{Document, doc};
use mysql_async::prelude::*;

use super::{execute, session};
use crate::backup::{Job, Jobs, Outcome};
use crate::config::{AuthMode, ConnectionConfig, Engine, SslMode};
use crate::drivers::Session;
use crate::manager::{Manager, Server};

fn config(engine: Engine, var: &str) -> Option<(ConnectionConfig, Option<String>)> {
    let raw = std::env::var(var).ok()?;
    let mut c = ConnectionConfig {
        id: format!("builtin-{var}"),
        name: var.into(),
        engine,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: String::new(),
        auth: AuthMode::Password,
        ssl: SslMode::Prefer,
        trust_server_certificate: true,
        uri: String::new(),
        auth_source: String::new(),
        save_password: false,
        read_only: false,
        color: String::new(),
        group: String::new(),
        last_used: None,
        cloud: None,
    };
    if engine == Engine::Mongo {
        c.uri = raw;
        return Some((c, None));
    }
    let parts: Vec<&str> = raw.splitn(4, ':').collect();
    c.host = parts[0].into();
    c.port = parts[1].parse().unwrap();
    c.user = parts[2].into();
    Some((c, parts.get(3).map(|s| s.to_string())))
}

async fn open(engine: Engine, var: &str) -> Option<Arc<Server>> {
    let (c, password) = config(engine, var)?;
    let manager = Manager::default();
    manager.open(c.clone(), password).await.expect("connect");
    Some(manager.get(&c.id).unwrap())
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("dbms-tool-builtin-tests");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    if path.is_dir() {
        std::fs::remove_dir_all(&path).unwrap();
    } else if path.exists() {
        std::fs::remove_file(&path).unwrap();
    }
    path
}

async fn run(server: &Server, job: serde_json::Value) -> Outcome {
    let job: Job = serde_json::from_value(job).unwrap();
    let outcome = execute(None, &Jobs::default(), "test", server, &job)
        .await
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(!outcome.cancelled);
    outcome
}

/* ---------- PostgreSQL ---------- */

async fn pg(server: &Server, database: &str) -> crate::drivers::postgres::PgSession {
    match session(server, database).await.unwrap() {
        Session::Pg(s) => s,
        _ => unreachable!(),
    }
}

const PG_SCHEMA: &str = r#"
CREATE SCHEMA app;
CREATE TYPE app.mood AS ENUM ('sad', 'ok', 'happy');
CREATE DOMAIN app.positive AS integer DEFAULT 1 NOT NULL CONSTRAINT positive_check CHECK (VALUE > 0);
CREATE TYPE app.pair AS (a integer, b text);
CREATE SEQUENCE app.ticket_seq START 100 INCREMENT 5;
CREATE TABLE app.customers (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    email text UNIQUE,
    mood app.mood DEFAULT 'ok',
    score app.positive,
    tags text[],
    profile jsonb,
    photo bytea,
    ticket integer DEFAULT nextval('app.ticket_seq'),
    name_upper text GENERATED ALWAYS AS (upper(name)) STORED,
    CONSTRAINT name_not_blank CHECK (name <> '')
);
COMMENT ON TABLE app.customers IS 'People who buy things';
COMMENT ON COLUMN app.customers.email IS 'Where receipts go';
CREATE TABLE app.orders (
    id serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES app.customers (id) ON DELETE CASCADE,
    total numeric(10,2) NOT NULL DEFAULT 0,
    placed timestamptz DEFAULT now(),
    note text
);
CREATE INDEX orders_customer ON app.orders (customer_id, placed DESC);
CREATE INDEX orders_big ON app.orders (total) WHERE total > 100;
CREATE TABLE app.events (id integer, at date NOT NULL, body text) PARTITION BY RANGE (at);
CREATE TABLE app.events_2025 PARTITION OF app.events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE app.events_2026 PARTITION OF app.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE INDEX events_at ON app.events (at);
CREATE FUNCTION app.customer_orders(c app.customers) RETURNS SETOF app.orders LANGUAGE sql STABLE
    AS $$ SELECT * FROM app.orders WHERE customer_id = c.id $$;
CREATE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
    NEW.note := coalesce(NEW.note, '') || ';touched';  -- a semicolon in a string
    RETURN NEW;
END $fn$;
CREATE TRIGGER orders_touch BEFORE UPDATE ON app.orders FOR EACH ROW EXECUTE FUNCTION app.touch();
CREATE PROCEDURE app.noop(n integer) LANGUAGE plpgsql AS $$ BEGIN PERFORM n; END $$;
CREATE VIEW app.big_orders AS SELECT * FROM app.orders WHERE total > 100;
CREATE VIEW app.big_order_count AS SELECT count(*) AS n FROM app.big_orders;
CREATE MATERIALIZED VIEW app.order_totals AS SELECT customer_id, sum(total) AS total FROM app.orders GROUP BY customer_id;
CREATE UNIQUE INDEX order_totals_customer ON app.order_totals (customer_id);
ALTER TABLE app.orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_orders ON app.orders FOR SELECT USING (customer_id > 0);
DO $$ BEGIN CREATE ROLE bk_reader; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA app TO bk_reader;
GRANT SELECT ON app.orders TO bk_reader;
CREATE TABLE public.plain (k text PRIMARY KEY, v text);

INSERT INTO app.customers (name, email, mood, score, tags, profile, photo) VALUES
    ('Ada', 'ada@example.com', 'happy', 3, '{a,"b c"}', '{"x": [1, 2, {"y": null}]}', '\x00ff10'),
    (E'Tab\there; and "quotes" and \\backslash', NULL, NULL, 1, NULL, NULL, NULL),
    (E'Line\nbreak ✓ ünïcödé', 'nl@example.com', 'sad', 7, '{}', '[]', '\x');
INSERT INTO app.orders (customer_id, total, placed, note) VALUES
    (1, 250.50, '2025-03-01 10:00+00', 'first'), (1, 12.00, '2025-03-02 10:00+00', NULL),
    (2, 999.99, '2025-04-01 08:30+02', E'multi\nline'), (3, 0, '2025-05-01 00:00+00', '\.');
INSERT INTO app.events VALUES (1, '2025-06-01', 'in 2025'), (2, '2026-02-01', 'in 2026');
INSERT INTO public.plain VALUES ('a', 'x'), ('b', NULL);
SELECT nextval('app.ticket_seq');
REFRESH MATERIALIZED VIEW app.order_totals;
"#;

/// Everything that should survive a round trip, as sorted lines.
async fn pg_fingerprint(client: &tokio_postgres::Client) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let tables = client
        .query(
            "SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r', 'm') AND n.nspname IN ('app', 'public') ORDER BY 1",
            &[],
        )
        .await
        .unwrap();
    for t in tables {
        let name: String = t.get(0);
        let row = client
            .query_one(
                &format!(
                    "SELECT count(*), md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) FROM {name} t"
                ),
                &[],
            )
            .await
            .unwrap();
        lines.push(format!(
            "data {name} {} {}",
            row.get::<_, i64>(0),
            row.get::<_, String>(1)
        ));
    }
    let catalog = [
        "SELECT 'index ' || pg_get_indexdef(indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('app', 'public')",
        "SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) \
         FROM pg_constraint WHERE connamespace IN ('app'::regnamespace, 'public'::regnamespace)",
        "SELECT 'trigger ' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal",
        "SELECT 'view ' || oid::regclass || ' ' || pg_get_viewdef(oid) FROM pg_class \
         WHERE relkind IN ('v', 'm') AND relnamespace = 'app'::regnamespace",
        "SELECT 'function ' || pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace = 'app'::regnamespace",
        "SELECT 'type ' || t.typname || ' ' || t.typtype::text || ' ' || coalesce(string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder), '') \
         FROM pg_type t LEFT JOIN pg_enum e ON e.enumtypid = t.oid \
         WHERE t.typnamespace = 'app'::regnamespace AND t.typtype IN ('e', 'd', 'c') AND t.typrelid IN (0, (SELECT oid FROM pg_class WHERE relname = 'pair')) \
         GROUP BY t.typname, t.typtype",
        "SELECT 'policy ' || polname || ' ' || pg_get_expr(polqual, polrelid) FROM pg_policy",
        "SELECT 'rls ' || relname FROM pg_class WHERE relrowsecurity",
        "SELECT 'comment ' || description FROM pg_description d JOIN pg_class c ON c.oid = d.objoid \
         WHERE c.relnamespace = 'app'::regnamespace",
        "SELECT 'grant ' || relname || ' ' || array_to_string(relacl, ',') FROM pg_class \
         WHERE relacl IS NOT NULL AND relnamespace = 'app'::regnamespace",
        "SELECT 'partition ' || c.relname || ' ' || pg_get_expr(c.relpartbound, c.oid) FROM pg_class c WHERE c.relispartition \
         AND c.relkind = 'r'",
        "SELECT 'sequence app.ticket_seq ' || last_value FROM app.ticket_seq",
        "SELECT 'sequence orders ' || last_value FROM app.orders_id_seq",
        "SELECT 'identity ' || (pg_get_serial_sequence('app.customers', 'id') IS NOT NULL)::text",
    ];
    for sql in catalog {
        for r in client.query(sql, &[]).await.unwrap() {
            lines.push(r.get(0));
        }
    }
    lines.sort();
    lines
}

#[tokio::test]
async fn postgres_round_trip() {
    let Some(server) = open(Engine::Postgres, "DBMS_TEST_PG").await else {
        return;
    };
    let admin = pg(&server, "postgres").await;
    for db in ["bk_src", "bk_dst", "bk_dst_ins"] {
        for sql in [
            format!("DROP DATABASE IF EXISTS {db} WITH (FORCE)"),
            format!("CREATE DATABASE {db}"),
        ] {
            admin.client().batch_execute(&sql).await.unwrap();
        }
    }
    let src = pg(&server, "bk_src").await;
    src.client().batch_execute(PG_SCHEMA).await.unwrap();
    let expected = pg_fingerprint(src.client()).await;

    // COPY data, restored by the built-in runner
    let file = temp("pg.sql");
    let out = run(
        &server,
        serde_json::json!({ "tool": "pg_dump", "database": "bk_src", "file": file, "format": "plain" }),
    )
    .await;
    assert!(out.size.unwrap() > 1000);
    let restored = run(
        &server,
        serde_json::json!({ "tool": "psql", "database": "bk_dst", "file": file, "stopOnError": true, "singleTransaction": true }),
    )
    .await;
    assert_eq!(restored.errors, 0);
    let dst = pg(&server, "bk_dst").await;
    assert_eq!(pg_fingerprint(dst.client()).await, expected);

    // INSERT statements, with DROP … IF EXISTS run over the existing copy
    let file = temp("pg_inserts.sql");
    run(
        &server,
        serde_json::json!({ "tool": "pg_dump", "database": "bk_src", "file": file, "format": "plain", "inserts": true, "clean": true }),
    )
    .await;
    for _ in 0..2 {
        run(
            &server,
            serde_json::json!({ "tool": "psql", "database": "bk_dst_ins", "file": file, "stopOnError": true }),
        )
        .await;
    }
    let ins = pg(&server, "bk_dst_ins").await;
    assert_eq!(pg_fingerprint(ins.client()).await, expected);

    // One table, its dependent objects only
    let file = temp("pg_table.sql");
    run(
        &server,
        serde_json::json!({ "tool": "pg_dump", "database": "bk_src", "file": file, "format": "plain",
                            "tables": [{ "schema": "public", "name": "plain" }] }),
    )
    .await;
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("CREATE TABLE public.plain"));
    assert!(!text.contains("app.customers"));

    // "Create the database": the script drops and recreates bk_dst, then \connects to it
    drop(dst);
    let file = temp("pg_create.sql");
    run(
        &server,
        serde_json::json!({ "tool": "pg_dump", "database": "bk_dst", "file": file, "format": "plain",
                            "create": true, "clean": true }),
    )
    .await;
    run(
        &server,
        serde_json::json!({ "tool": "psql", "database": "postgres", "file": file, "stopOnError": true }),
    )
    .await;
    let recreated = pg(&server, "bk_dst").await;
    assert_eq!(pg_fingerprint(recreated.client()).await, expected);
}

/* ---------- MySQL ---------- */

const MY_SCHEMA: &[&str] = &[
    "CREATE TABLE customers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        note TEXT,
        photo BLOB,
        flags BIT(6),
        kind ENUM('a','b') DEFAULT 'a',
        perms SET('r','w','x'),
        balance DECIMAL(12,4),
        ratio DOUBLE,
        born DATE,
        seen DATETIME(3),
        stamp TIMESTAMP NULL,
        data JSON,
        name_len INT AS (CHAR_LENGTH(name)) VIRTUAL,
        KEY name_idx (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    "CREATE TABLE orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_id INT NOT NULL,
        total DECIMAL(10,2),
        CONSTRAINT fk_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
    ) ENGINE=InnoDB",
    "CREATE TABLE `odd ``name`` table` (`semi;colon` INT PRIMARY KEY)",
    "INSERT INTO customers (name, note, photo, flags, kind, perms, balance, ratio, born, seen, stamp, data) VALUES
        ('Ada', 'it''s \"quoted\" \\\\ back\\nslash', 0x00FF1A27225C0A0D, b'101010', 'b', 'r,x', 1234.5678, 1.5e-7,
         '1815-12-10', '2025-01-02 03:04:05.678', '2025-01-02 03:04:05', '{\"a\": [1, \"two\", null]}'),
        ('ünïcödé ✓ 🎉', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
        ('', '', '', b'0', 'a', '', 0, 0, NULL, NULL, NULL, 'null')",
    "INSERT INTO orders (customer_id, total) VALUES (1, 10.5), (1, 20), (2, NULL)",
    "INSERT INTO `odd ``name`` table` VALUES (1), (2)",
    "CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 15",
    "CREATE VIEW a_big_order_count AS SELECT COUNT(*) AS n FROM big_orders",
    "CREATE PROCEDURE add_order(IN c INT, IN t DECIMAL(10,2))
     BEGIN
        INSERT INTO orders (customer_id, total) VALUES (c, t); -- a ; in a comment
        SELECT 'done;';
     END",
    "CREATE FUNCTION twice(x INT) RETURNS INT DETERMINISTIC RETURN x * 2",
    "CREATE TRIGGER orders_bi BEFORE INSERT ON orders FOR EACH ROW BEGIN
        IF NEW.total IS NULL THEN SET NEW.total = 0; END IF;
     END",
    "CREATE EVENT nightly ON SCHEDULE EVERY 1 DAY DISABLE DO DELETE FROM orders WHERE total < 0",
];

async fn my_fingerprint(conn: &mut mysql_async::Conn, db: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let tables: Vec<(String, String)> = conn
        .exec(
            "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
            (db,),
        )
        .await
        .unwrap();
    for (t, kind) in tables {
        let q = format!("`{db}`.`{}`", t.replace('`', "``"));
        if kind == "BASE TABLE" {
            let row: Option<mysql_async::Row> = conn
                .query_first(format!("CHECKSUM TABLE {q}"))
                .await
                .unwrap();
            let sum: Option<i64> = row.unwrap().get(1);
            let (_, create): (String, String) = conn
                .query_first(format!("SHOW CREATE TABLE {q}"))
                .await
                .unwrap()
                .unwrap();
            // The AUTO_INCREMENT counter isn't data
            let create = create
                .split(' ')
                .filter(|w| !w.starts_with("AUTO_INCREMENT="))
                .collect::<Vec<_>>()
                .join(" ");
            lines.push(format!("table {t} {sum:?} {create}"));
        } else {
            lines.push(format!("view {t}"));
        }
    }
    for (sql, label) in [
        (
            "SELECT CONCAT(ROUTINE_TYPE, ' ', ROUTINE_NAME, ' ', ROUTINE_DEFINITION) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?",
            "routine",
        ),
        (
            "SELECT CONCAT(TRIGGER_NAME, ' ', ACTION_STATEMENT) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?",
            "trigger",
        ),
        (
            "SELECT CONCAT(EVENT_NAME, ' ', EVENT_DEFINITION, ' ', STATUS) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?",
            "event",
        ),
        (
            "SELECT CONCAT(TABLE_NAME, ' ', VIEW_DEFINITION) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?",
            "view",
        ),
    ] {
        let rows: Vec<String> = conn.exec(sql, (db,)).await.unwrap();
        lines.extend(
            rows.into_iter()
                .map(|r| format!("{label} {}", r.replace(&format!("`{db}`."), ""))),
        );
    }
    lines.sort();
    lines
}

#[tokio::test]
async fn mysql_round_trip() {
    let Some(server) = open(Engine::Mysql, "DBMS_TEST_MYSQL").await else {
        return;
    };
    let mut admin = match session(&server, "").await.unwrap() {
        Session::My(s) => s,
        _ => unreachable!(),
    };
    let conn = admin.conn();
    for db in ["bk_src", "bk_dst", "bk_dst2"] {
        conn.query_drop(format!("DROP DATABASE IF EXISTS {db}"))
            .await
            .unwrap();
        conn.query_drop(format!("CREATE DATABASE {db}"))
            .await
            .unwrap();
    }
    conn.query_drop("USE bk_src").await.unwrap();
    for sql in MY_SCHEMA {
        conn.query_drop(*sql)
            .await
            .unwrap_or_else(|e| panic!("{e}\n{sql}"));
    }
    let expected = my_fingerprint(conn, "bk_src").await;

    let variants = [
        ("my.sql", "bk_dst", true, true),
        // Raw bytes in quoted strings, one row per INSERT
        ("my_raw.sql", "bk_dst2", false, false),
    ];
    for (name, target, hex_blob, extended) in variants {
        let file = temp(name);
        run(
            &server,
            serde_json::json!({
                "tool": "mysqldump", "database": "bk_src", "file": file, "routines": true, "triggers": true,
                "events": true, "dropTables": true, "singleTransaction": true, "hexBlob": hex_blob,
                "extendedInsert": extended
            }),
        )
        .await;
        let restored = run(
            &server,
            serde_json::json!({ "tool": "mysql", "database": target, "file": file }),
        )
        .await;
        assert_eq!(restored.errors, 0);
        let conn = admin.conn();
        assert_eq!(my_fingerprint(conn, target).await, expected, "{name}");
    }
}

/* ---------- MongoDB ---------- */

async fn mongo_fingerprint(client: &mongodb::Client, db: &str) -> Vec<String> {
    let database = client.database(db);
    let mut lines = Vec::new();
    let mut names = database.list_collection_names().await.unwrap();
    names.sort();
    for name in names {
        if name.starts_with("system.") {
            continue;
        }
        let specs: Vec<Document> = futures_util::TryStreamExt::try_collect(
            database
                .run_cursor_command(doc! { "listCollections": 1, "filter": { "name": &name } })
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        let mut spec = specs[0].clone();
        spec.remove("info");
        lines.push(format!("collection {spec}"));
        if spec.get_str("type") == Ok("view") {
            continue;
        }
        let mut docs: Vec<String> = futures_util::TryStreamExt::try_collect::<Vec<Document>>(
            database
                .collection::<Document>(&name)
                .find(doc! {})
                .await
                .unwrap(),
        )
        .await
        .unwrap()
        .into_iter()
        .map(|d| format!("{d}"))
        .collect();
        docs.sort();
        lines.extend(docs.into_iter().map(|d| format!("doc {name} {d}")));
        let indexes: Vec<Document> = futures_util::TryStreamExt::try_collect(
            database
                .run_cursor_command(doc! { "listIndexes": &name })
                .await
                .unwrap(),
        )
        .await
        .unwrap();
        lines.extend(indexes.into_iter().map(|i| format!("index {name} {i}")));
    }
    lines.sort();
    lines
}

#[tokio::test]
async fn mongo_round_trip() {
    let Some(server) = open(Engine::Mongo, "DBMS_TEST_MONGO").await else {
        return;
    };
    let client = server.mongo_client().unwrap();
    for db in ["bk_src", "bk_dst", "bk_dst2", "bk_dst3"] {
        client.database(db).drop().await.unwrap();
    }
    let src = client.database("bk_src");
    let oid = mongodb::bson::oid::ObjectId::parse_str("65f000000000000000000001").unwrap();
    src.collection::<Document>("orders")
        .insert_many([
            doc! { "_id": oid, "total": mongodb::bson::Decimal128::from_bytes([1; 16]), "at": mongodb::bson::DateTime::from_millis(1_700_000_000_000),
                   "items": [{ "sku": "a", "n": 2_i64 }, { "sku": "b", "n": 1 }], "blob": mongodb::bson::Binary { subtype: mongodb::bson::spec::BinarySubtype::Generic, bytes: vec![0, 255, 7] } },
            doc! { "_id": 2, "customer": "Ünïcödé", "nested": { "deep": { "x": null, "y": 1.5 } } },
        ])
        .await
        .unwrap();
    let orders = src.collection::<Document>("orders");
    orders
        .create_index(
            mongodb::IndexModel::builder()
                .keys(doc! { "customer": 1, "at": -1 })
                .build(),
        )
        .await
        .unwrap();
    orders
        .create_index(
            mongodb::IndexModel::builder()
                .keys(doc! { "items.sku": 1 })
                .options(
                    mongodb::options::IndexOptions::builder()
                        .unique(true)
                        .sparse(true)
                        .name("sku_unique".to_string())
                        .build(),
                )
                .build(),
        )
        .await
        .unwrap();
    src.run_command(doc! { "create": "capped_log", "capped": true, "size": 65536_i64 })
        .await
        .unwrap();
    src.collection::<Document>("capped_log")
        .insert_one(doc! { "_id": 1, "msg": "hi" })
        .await
        .unwrap();
    src.run_command(doc! { "create": "empty" }).await.unwrap();
    src.run_command(doc! { "create": "big_orders", "viewOn": "orders", "pipeline": [{ "$match": { "_id": 2 } }] })
        .await
        .unwrap();
    // Enough documents to span several insert batches
    let many: Vec<Document> = (0..2500)
        .map(|i| doc! { "_id": i, "v": format!("row {i}") })
        .collect();
    src.collection::<Document>("many")
        .insert_many(many)
        .await
        .unwrap();
    let expected = mongo_fingerprint(client, "bk_src").await;

    for (name, archive, gzip, target) in [
        ("mongo.archive.gz", true, true, "bk_dst"),
        ("mongo_folder", false, false, "bk_dst2"),
        ("mongo_folder_gz", false, true, "bk_dst3"),
    ] {
        let path = temp(name);
        run(
            &server,
            serde_json::json!({ "tool": "mongodump", "database": "bk_src", "path": path, "archive": archive, "gzip": gzip }),
        )
        .await;
        let restored = run(
            &server,
            serde_json::json!({ "tool": "mongorestore", "path": path, "archive": archive, "gzip": gzip,
                                "fromDatabase": "bk_src", "toDatabase": target, "stopOnError": true }),
        )
        .await;
        assert_eq!(restored.errors, 0, "{name}");
        assert_eq!(mongo_fingerprint(client, target).await, expected, "{name}");
    }

    // Restoring again without dropping skips the duplicates and counts them
    let again = run(
        &server,
        serde_json::json!({ "tool": "mongorestore", "path": temp_existing("mongo.archive.gz"), "archive": true,
                            "fromDatabase": "bk_src", "toDatabase": "bk_dst" }),
    )
    .await;
    assert!(again.errors > 0);
}

fn temp_existing(name: &str) -> PathBuf {
    std::env::temp_dir()
        .join("dbms-tool-builtin-tests")
        .join(name)
}

/// Backups the real tools made of the `bk_src` databases above, restored by the
/// built-in engine. `DBMS_TEST_TOOL_BACKUPS` names the folder holding them:
/// `pg_real.sql` (pg_dump --format=plain), `my_real.sql` (mysqldump --routines
/// --triggers --events), `mongo_real.archive.gz` (mongodump --archive --gzip)
/// and `mongo_real_dir` (mongodump --out).
#[tokio::test]
async fn restores_the_real_tools_backups() {
    let Ok(dir) = std::env::var("DBMS_TEST_TOOL_BACKUPS") else {
        return;
    };
    let dir = PathBuf::from(dir);

    if let Some(server) = open(Engine::Postgres, "DBMS_TEST_PG").await {
        let admin = pg(&server, "postgres").await;
        for sql in [
            "DROP DATABASE IF EXISTS bk_from_tool WITH (FORCE)",
            "CREATE DATABASE bk_from_tool",
        ] {
            admin.client().batch_execute(sql).await.unwrap();
        }
        let restored = run(
            &server,
            serde_json::json!({ "tool": "psql", "database": "bk_from_tool", "file": dir.join("pg_real.sql"),
                                "stopOnError": true, "singleTransaction": true }),
        )
        .await;
        assert_eq!(restored.errors, 0);
        let src = pg(&server, "bk_src").await;
        let dst = pg(&server, "bk_from_tool").await;
        assert_eq!(
            pg_fingerprint(dst.client()).await,
            pg_fingerprint(src.client()).await
        );
    }

    if let Some(server) = open(Engine::Mysql, "DBMS_TEST_MYSQL").await {
        let mut admin = match session(&server, "").await.unwrap() {
            Session::My(s) => s,
            _ => unreachable!(),
        };
        let conn = admin.conn();
        conn.query_drop("DROP DATABASE IF EXISTS bk_from_tool")
            .await
            .unwrap();
        conn.query_drop("CREATE DATABASE bk_from_tool")
            .await
            .unwrap();
        let restored = run(
            &server,
            serde_json::json!({ "tool": "mysql", "database": "bk_from_tool", "file": dir.join("my_real.sql") }),
        )
        .await;
        assert_eq!(restored.errors, 0);
        let expected = my_fingerprint(conn, "bk_src").await;
        assert_eq!(my_fingerprint(conn, "bk_from_tool").await, expected);
    }

    if let Some(server) = open(Engine::Mongo, "DBMS_TEST_MONGO").await {
        let client = server.mongo_client().unwrap();
        let expected = mongo_fingerprint(client, "bk_src").await;
        for (name, archive, target) in [
            ("mongo_real.archive.gz", true, "bk_from_tool_a"),
            ("mongo_real_dir", false, "bk_from_tool_f"),
        ] {
            client.database(target).drop().await.unwrap();
            let restored = run(
                &server,
                serde_json::json!({ "tool": "mongorestore", "path": dir.join(name), "archive": archive,
                                    "fromDatabase": "bk_src", "toDatabase": target, "stopOnError": true }),
            )
            .await;
            assert_eq!(restored.errors, 0, "{name}");
            assert_eq!(mongo_fingerprint(client, target).await, expected, "{name}");
        }
    }
}
