//! MySQL and MariaDB: a script in mysqldump's layout (the same session
//! settings, DROP/CREATE per table, multi-row INSERTs, DELIMITER blocks for
//! routines and triggers), and a mysql-client-style runner for such scripts.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use mysql_async::{Column, Conn, Value};

use super::split::{Dialect, Item, Splitter};
use super::{Output, Report, excerpt, open_input, session};
use crate::backup::{Content, MysqlDumpJob, MysqlRestoreJob};
use crate::drivers::Session;
use crate::drivers::mysql::{MySession, describe_error};
use crate::error::{AppError, AppResult};
use crate::manager::Server;

async fn connect(server: &Server, database: &str) -> AppResult<MySession> {
    match session(server, database).await? {
        Session::My(s) => Ok(s),
        _ => Err(AppError::msg("Not a MySQL connection")),
    }
}

fn ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// A string literal with mysqldump's escapes; bytes pass through untouched.
fn escape_into(out: &mut Vec<u8>, bytes: &[u8]) {
    out.push(b'\'');
    for &b in bytes {
        match b {
            0 => out.extend_from_slice(b"\\0"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\'' => out.extend_from_slice(b"\\'"),
            b'"' => out.extend_from_slice(b"\\\""),
            0x1a => out.extend_from_slice(b"\\Z"),
            _ => out.push(b),
        }
    }
    out.push(b'\'');
}

fn hex_into(out: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.is_empty() {
        out.extend_from_slice(b"''");
        return;
    }
    out.extend_from_slice(b"0x");
    for b in bytes {
        out.extend_from_slice(format!("{b:02X}").as_bytes());
    }
}

const BINARY_CHARSET: u16 = 63;

/// One value as SQL. The text protocol hands every value over as bytes.
fn render(out: &mut Vec<u8>, value: &Value, column: &Column, hex_blob: bool) {
    let bytes: Vec<u8> = match value {
        Value::NULL => {
            out.extend_from_slice(b"NULL");
            return;
        }
        Value::Bytes(b) => b.clone(),
        other => other.as_sql(true).into_bytes(),
    };
    use ColumnType::*;
    let binary = column.character_set() == BINARY_CHARSET;
    match column.column_type() {
        MYSQL_TYPE_TINY
        | MYSQL_TYPE_SHORT
        | MYSQL_TYPE_LONG
        | MYSQL_TYPE_INT24
        | MYSQL_TYPE_LONGLONG
        | MYSQL_TYPE_FLOAT
        | MYSQL_TYPE_DOUBLE
        | MYSQL_TYPE_DECIMAL
        | MYSQL_TYPE_NEWDECIMAL
        | MYSQL_TYPE_YEAR => out.extend_from_slice(&bytes),
        MYSQL_TYPE_BIT => hex_into(out, &bytes),
        MYSQL_TYPE_STRING
        | MYSQL_TYPE_VAR_STRING
        | MYSQL_TYPE_VARCHAR
        | MYSQL_TYPE_BLOB
        | MYSQL_TYPE_TINY_BLOB
        | MYSQL_TYPE_MEDIUM_BLOB
        | MYSQL_TYPE_LONG_BLOB
        | MYSQL_TYPE_GEOMETRY
            if binary && hex_blob =>
        {
            hex_into(out, &bytes)
        }
        _ => escape_into(out, &bytes),
    }
}

/// Statements longer than this start a new INSERT, well under max_allowed_packet.
const INSERT_LIMIT: usize = 1 << 20;

pub async fn dump(server: &Server, job: &MysqlDumpJob, report: &Report<'_>) -> AppResult<()> {
    let db = job.database.trim();
    let mut session = connect(server, db).await?;
    let conn = session.conn();
    conn.query_drop("SET NAMES utf8mb4").await?;
    // Like mysqldump's --tz-utc: TIMESTAMP values travel in UTC
    conn.query_drop("SET SESSION time_zone = '+00:00'").await?;
    if job.single_transaction {
        conn.query_drop("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .await?;
        conn.query_drop("START TRANSACTION WITH CONSISTENT SNAPSHOT")
            .await?;
    }
    let version: String = conn
        .query_first("SELECT VERSION()")
        .await?
        .unwrap_or_default();
    let host = server.config.host.trim();

    let objects: Vec<(String, String)> = conn
        .exec(
            "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
            (db,),
        )
        .await?;
    let chosen: Option<HashSet<&str>> =
        (!job.tables.is_empty()).then(|| job.tables.iter().map(String::as_str).collect());
    if let Some(chosen) = &chosen {
        for name in chosen {
            if !objects.iter().any(|(n, _)| n == name) {
                return Err(AppError::msg(format!("No table named {name} was found")));
            }
        }
    }
    let wanted = |name: &str| chosen.as_ref().is_none_or(|c| c.contains(name));
    let tables: Vec<&str> = objects
        .iter()
        .filter(|(n, t)| (t == "BASE TABLE" || t == "SYSTEM VERSIONED") && wanted(n))
        .map(|(n, _)| n.as_str())
        .collect();
    let views: Vec<&str> = objects
        .iter()
        .filter(|(n, t)| t == "VIEW" && wanted(n))
        .map(|(n, _)| n.as_str())
        .collect();

    let path = Path::new(job.file.trim());
    let mut out = Output::create(path, false)?;
    let schema_part = job.content != Content::Data;
    let data_part = job.content != Content::Schema;
    let whole = chosen.is_none();

    out.write_all(
        format!(
            "-- MySQL dump written by dbms-tool {} (built-in engine)\n--\n\
             -- Host: {}    Database: {db}\n\
             -- ------------------------------------------------------\n\
             -- Server version\t{version}\n\n",
            env!("CARGO_PKG_VERSION"),
            if host.is_empty() { "localhost" } else { host },
        )
        .as_bytes(),
    )?;
    out.write_all(
        b"/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;\n\
          /*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;\n\
          /*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;\n\
          /*!50503 SET NAMES utf8mb4 */;\n\
          /*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;\n\
          /*!40103 SET TIME_ZONE='+00:00' */;\n\
          /*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;\n\
          /*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;\n\
          /*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;\n\
          /*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;\n\n",
    )?;

    if job.create_database && whole {
        let (_, create): (String, String) = conn
            .query_first(format!("SHOW CREATE DATABASE {}", ident(db)))
            .await?
            .ok_or_else(|| AppError::msg(format!("Can't read database {db}")))?;
        let create = create.replacen(
            "CREATE DATABASE ",
            "CREATE DATABASE /*!32312 IF NOT EXISTS*/ ",
            1,
        );
        out.write_all(
            format!(
                "--\n-- Current Database: {}\n--\n\n{create};\n\nUSE {};\n\n",
                ident(db),
                ident(db)
            )
            .as_bytes(),
        )?;
    }

    for table in &tables {
        report.check()?;
        let q = ident(table);
        if schema_part {
            report.line(format!("dumping structure of {table}"));
            let (_, create): (String, String) = conn
                .query_first(format!("SHOW CREATE TABLE {}.{q}", ident(db)))
                .await?
                .ok_or_else(|| AppError::msg(format!("Can't read table {table}")))?;
            out.write_all(format!("--\n-- Table structure for table {q}\n--\n\n").as_bytes())?;
            if job.drop_tables {
                out.write_all(format!("DROP TABLE IF EXISTS {q};\n").as_bytes())?;
            }
            out.write_all(
                format!(
                    "/*!40101 SET @saved_cs_client     = @@character_set_client */;\n\
                     /*!50503 SET character_set_client = utf8mb4 */;\n{create};\n\
                     /*!40101 SET character_set_client = @saved_cs_client */;\n\n"
                )
                .as_bytes(),
            )?;
        }
        if data_part {
            let rows = dump_rows(
                conn,
                &mut out,
                db,
                table,
                job.hex_blob,
                job.extended_insert,
                report,
            )
            .await?;
            report.line(format!("dumped {rows} rows from {table}"));
        }
        if schema_part && job.triggers {
            let names: Vec<String> = conn
                .exec(
                    "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS \
                     WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY ACTION_ORDER",
                    (db, *table),
                )
                .await?;
            for name in names {
                let sql = format!("SHOW CREATE TRIGGER {}.{}", ident(db), ident(&name));
                if let Some((mode, create)) = show_create(conn, sql, 2).await? {
                    write_block(&mut out, &mode, &create)?;
                } else {
                    report.error(format!("Can't read trigger {name}; it's left out"));
                }
            }
        }
    }

    if schema_part && whole && job.routines {
        let routines: Vec<(String, String)> = conn
            .exec(
                "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES \
                 WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME",
                (db,),
            )
            .await?;
        if !routines.is_empty() {
            out.write_all(b"--\n-- Dumping routines\n--\n\n")?;
        }
        for (name, kind) in routines {
            let kind = if kind == "FUNCTION" {
                "FUNCTION"
            } else {
                "PROCEDURE"
            };
            let sql = format!("SHOW CREATE {kind} {}.{}", ident(db), ident(&name));
            match show_create(conn, sql, 2).await? {
                Some((mode, create)) => {
                    out.write_all(
                        format!("/*!50003 DROP {kind} IF EXISTS {} */;\n", ident(&name)).as_bytes(),
                    )?;
                    write_block(&mut out, &mode, &create)?;
                }
                _ => report.error(format!(
                    "Can't read {} {name} (it needs SHOW_ROUTINE or ownership); it's left out",
                    kind.to_lowercase()
                )),
            }
        }
    }

    if schema_part && whole && job.events {
        let events: Vec<String> = conn
            .exec(
                "SELECT EVENT_NAME FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME",
                (db,),
            )
            .await?;
        for name in events {
            let sql = format!("SHOW CREATE EVENT {}.{}", ident(db), ident(&name));
            match show_create(conn, sql, 3).await? {
                Some((mode, create)) => {
                    out.write_all(
                        format!("/*!50106 DROP EVENT IF EXISTS {} */;\n", ident(&name)).as_bytes(),
                    )?;
                    write_block(&mut out, &mode, &create)?;
                }
                _ => report.error(format!("Can't read event {name}; it's left out")),
            }
        }
    }

    if schema_part && !views.is_empty() {
        let mut definitions: HashMap<&str, String> = HashMap::new();
        for view in &views {
            let row: Option<mysql_async::Row> = conn
                .query_first(format!("SHOW CREATE VIEW {}.{}", ident(db), ident(view)))
                .await?;
            match row.and_then(|r| r.get::<Option<String>, _>(1).flatten()) {
                Some(create) => {
                    definitions.insert(view, create);
                }
                None => report.error(format!("Can't read view {view}; it's left out")),
            }
        }
        // Views that select from other views come after them. The server
        // leaves the database off names in the session's own database, so the
        // quoted name alone is what to look for.
        let deps: HashMap<&str, Vec<&str>> = definitions
            .iter()
            .map(|(name, create)| {
                let uses = views
                    .iter()
                    .filter(|other| *other != name && create.contains(&ident(other)))
                    .copied()
                    .collect();
                (*name, uses)
            })
            .collect();
        for view in order_views(&views, &deps) {
            let Some(create) = definitions.get(view) else {
                continue;
            };
            out.write_all(format!("--\n-- View {}\n--\n\n", ident(view)).as_bytes())?;
            if job.drop_tables {
                out.write_all(format!("DROP VIEW IF EXISTS {};\n", ident(view)).as_bytes())?;
            }
            out.write_all(format!("{create};\n\n").as_bytes())?;
        }
    }

    out.write_all(
        b"/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;\n\
          /*!40101 SET SQL_MODE=@OLD_SQL_MODE */;\n\
          /*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;\n\
          /*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;\n\
          /*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;\n\
          /*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;\n\
          /*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;\n\
          /*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;\n\n-- Dump completed\n",
    )?;
    out.finish()?;
    if job.single_transaction {
        let _ = conn.query_drop("COMMIT").await;
    }
    Ok(())
}

/// The sql_mode and statement from `SHOW CREATE TRIGGER / PROCEDURE / EVENT`,
/// whose column counts vary by kind and server; None when it's hidden from us.
async fn show_create(
    conn: &mut Conn,
    sql: String,
    column: usize,
) -> AppResult<Option<(String, String)>> {
    let row: Option<mysql_async::Row> = conn.query_first(sql).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let mode: Option<String> = row.get::<Option<String>, _>(1).flatten();
    let create: Option<String> = row.get::<Option<String>, _>(column).flatten();
    Ok(create.map(|c| (mode.unwrap_or_default(), c)))
}

/// A routine, trigger or event under its own sql_mode, between DELIMITER lines.
fn write_block(out: &mut Output, mode: &str, create: &str) -> AppResult<()> {
    out.write_all(
        format!(
            "/*!50003 SET @saved_sql_mode = @@sql_mode */;\n\
             /*!50003 SET sql_mode = '{}' */;\n\
             DELIMITER ;;\n{create} ;;\nDELIMITER ;\n\
             /*!50003 SET sql_mode = @saved_sql_mode */;\n\n",
            mode.replace('\'', "''")
        )
        .as_bytes(),
    )?;
    Ok(())
}

fn order_views<'a>(views: &[&'a str], deps: &HashMap<&str, Vec<&'a str>>) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    let mut visiting: HashSet<&str> = HashSet::new();
    fn visit<'a>(
        v: &'a str,
        deps: &HashMap<&str, Vec<&'a str>>,
        out: &mut Vec<&'a str>,
        visiting: &mut HashSet<&'a str>,
    ) {
        if out.contains(&v) || !visiting.insert(v) {
            return;
        }
        for d in deps.get(v).into_iter().flatten() {
            visit(d, deps, out, visiting);
        }
        out.push(v);
    }
    for v in views {
        visit(v, deps, &mut out, &mut visiting);
    }
    out
}

async fn dump_rows(
    conn: &mut Conn,
    out: &mut Output,
    db: &str,
    table: &str,
    hex_blob: bool,
    extended: bool,
    report: &Report<'_>,
) -> AppResult<u64> {
    // Generated columns can't be inserted into, and SELECT * skips invisible ones
    let columns: Vec<(String, String)> = conn
        .exec(
            "SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            (db, table),
        )
        .await?;
    let stored: Vec<&str> = columns
        .iter()
        .filter(|(_, extra)| {
            let extra = extra.to_ascii_uppercase();
            !extra.contains("VIRTUAL GENERATED")
                && !extra.contains("STORED GENERATED")
                && !extra.contains("PERSISTENT GENERATED")
        })
        .map(|(n, _)| n.as_str())
        .collect();
    let explicit = stored.len() != columns.len()
        || columns
            .iter()
            .any(|(_, e)| e.to_ascii_uppercase().contains("INVISIBLE"));
    if stored.is_empty() {
        return Ok(0);
    }
    let list = stored
        .iter()
        .map(|c| ident(c))
        .collect::<Vec<_>>()
        .join(",");
    let q = ident(table);
    let select = if explicit {
        format!("SELECT {list} FROM {}.{q}", ident(db))
    } else {
        format!("SELECT * FROM {}.{q}", ident(db))
    };
    let insert = if explicit {
        format!("INSERT INTO {q} ({list}) VALUES ")
    } else {
        format!("INSERT INTO {q} VALUES ")
    };

    out.write_all(format!("--\n-- Dumping data for table {q}\n--\n\n").as_bytes())?;
    out.write_all(format!("/*!40000 ALTER TABLE {q} DISABLE KEYS */;\n").as_bytes())?;
    let mut result = conn.query_iter(select).await?;
    let meta = result.columns().unwrap_or_else(|| Vec::new().into());
    let mut statement: Vec<u8> = Vec::new();
    let mut rows = 0u64;
    while let Some(row) = result.next().await? {
        let values = row.unwrap();
        if statement.is_empty() {
            statement.extend_from_slice(insert.as_bytes());
        } else {
            statement.push(b',');
        }
        statement.push(b'(');
        for (i, value) in values.iter().enumerate() {
            if i > 0 {
                statement.push(b',');
            }
            render(&mut statement, value, &meta[i], hex_blob);
        }
        statement.push(b')');
        rows += 1;
        if !extended || statement.len() >= INSERT_LIMIT {
            statement.extend_from_slice(b";\n");
            out.write_all(&statement)?;
            statement.clear();
        }
        if rows.is_multiple_of(5000) {
            report.check()?;
        }
    }
    if !statement.is_empty() {
        statement.extend_from_slice(b";\n");
        out.write_all(&statement)?;
    }
    out.write_all(format!("/*!40000 ALTER TABLE {q} ENABLE KEYS */;\n\n").as_bytes())?;
    Ok(rows)
}

/* ---------- Restore ---------- */

pub async fn restore(server: &Server, job: &MysqlRestoreJob, report: &Report<'_>) -> AppResult<()> {
    let mut session = connect(server, job.database.trim()).await?;
    let conn = session.conn();
    conn.query_drop("SET NAMES utf8mb4").await?;
    let input = open_input(Path::new(job.file.trim()), report)?;
    let mut reader = BufReader::with_capacity(1 << 20, input);
    let mut splitter = Splitter::new(Dialect::Mysql);
    let mut line = Vec::new();
    let mut statements = 0u64;
    loop {
        line.clear();
        let eof = reader.read_until(b'\n', &mut line)? == 0;
        let items: Vec<Item> = if eof {
            splitter.finish().into_iter().collect()
        } else {
            splitter.push(&line)
        };
        for item in items {
            let Item::Statement(sql) = item else {
                continue;
            };
            statements += 1;
            if statements.is_multiple_of(100) {
                report.check()?;
            }
            // Sent as bytes: binary values sit raw inside string literals
            if let Err(e) = conn.query_drop(sql.as_slice()).await {
                let message = describe_error(&e);
                if !job.force {
                    let text = String::from_utf8_lossy(&sql);
                    return Err(AppError::msg(format!("{message}\nIn: {}", excerpt(&text))));
                }
                report.error(message);
            }
        }
        if eof {
            break;
        }
    }
    report.line(format!("ran {statements} statements"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strings_escape_like_mysqldump() {
        let mut out = Vec::new();
        escape_into(&mut out, b"it's\n\"a\\b\"\0\x1a");
        assert_eq!(out, b"'it\\'s\\n\\\"a\\\\b\\\"\\0\\Z'");
        let mut hex = Vec::new();
        hex_into(&mut hex, &[0x00, 0xff]);
        assert_eq!(hex, b"0x00FF");
    }

    #[test]
    fn views_follow_the_views_they_use() {
        let deps = HashMap::from([("a", vec!["b"]), ("b", vec!["c"])]);
        assert_eq!(order_views(&["a", "b", "c"], &deps), vec!["c", "b", "a"]);
    }
}
