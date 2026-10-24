//! Live-database tests. Each runs only when its connection is configured:
//!
//! ```text
//! DBMS_TEST_PG=localhost:5432:postgres:password
//! DBMS_TEST_MYSQL=localhost:3306:root:password
//! DBMS_TEST_MSSQL=localhost:1433:sa:Password!23
//! DBMS_TEST_BABELFISH=localhost:1434:babelfish_user:password
//! DBMS_TEST_MONGO=mongodb://localhost:27017
//! ```
//!
//! `scripts/test-databases.sh` starts matching containers.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::config::{AuthMode, ConnectionConfig, Engine, SslMode};
use crate::drivers::mongo::MongoRequest;
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
        save_password: false,
        read_only: false,
        color: String::new(),
        group: String::new(),
        last_used: None,
        cloud: None,
        ssh: None,
        tunneled: None,
    };
    if engine == Engine::Mongo {
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
    assert_eq!(set.rows[0][4], json!("2024-01-02 03:04:05.678"));
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
            assert!(
                p.params[1].data_type.starts_with("nvarchar"),
                "{var}: {p:?}"
            );
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
    m.close("sqlite-tx");
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
    m.close("ssh-tunnel");
}
