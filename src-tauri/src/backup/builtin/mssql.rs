//! SQL Server: copies a backup from the server's disk to this computer. BACKUP
//! only writes where the server can reach, so the file comes back over the
//! connection: OPENROWSET(BULK … SINGLE_BLOB) loads it into a temp table,
//! which is then read in chunks.

use std::future::Future;
use std::path::Path;

use tiberius::Client;
use tokio::io::AsyncWriteExt as _;
use tokio::net::TcpStream;
use tokio_util::compat::Compat;

use super::{Report, session};
use crate::drivers::Session;
use crate::drivers::mssql::MsSession;
use crate::error::{AppError, AppResult};
use crate::manager::Server;

type Tds = Client<Compat<TcpStream>>;

/// Bytes fetched per round trip.
const CHUNK: i64 = 4 << 20;

/// The most a varbinary(max), and so OPENROWSET's SINGLE_BLOB, can hold.
const MAX_SIZE: u64 = i32::MAX as u64;

async fn connect(server: &Server) -> AppResult<MsSession> {
    match session(server, "master").await? {
        Session::Ms(s) => Ok(s),
        _ => Err(AppError::msg("Not a SQL Server connection")),
    }
}

fn literal(text: &str) -> String {
    format!("N'{}'", text.replace('\'', "''"))
}

fn too_big(size: Option<u64>) -> AppError {
    let size = size
        .map(|s| format!(" ({:.1} GB)", s as f64 / 1e9))
        .unwrap_or_default();
    AppError::msg(format!(
        "The backup is larger than 2 GB{size}, the most SQL Server can send over a \
         connection as one file. Turn on compression, or copy the file from the server \
         another way."
    ))
}

/// Explains the errors a server gives when it won't read the file for us.
fn explain(e: tiberius::error::Error) -> AppError {
    let code = match &e {
        tiberius::error::Error::Server(t) => t.code(),
        _ => 0,
    };
    match code {
        // Attempting to grow LOB beyond maximum allowed size
        7119 => too_big(None),
        // No permission to use the bulk load statement
        4834 => AppError::msg(format!(
            "{}\n\nCopying a backup to this computer reads it with OPENROWSET(BULK …), \
             which needs the ADMINISTER BULK OPERATIONS permission (the sysadmin or \
             bulkadmin role). Managed services such as Amazon RDS don't allow it.",
            crate::drivers::mssql::describe_error(&e)
        )),
        _ => e.into(),
    }
}

/// Runs `work` until it finishes or the job is cancelled, whichever is first.
/// Dropping the session afterwards disconnects, which stops the query on the
/// server.
async fn unless_cancelled<T>(
    report: &Report<'_>,
    work: impl Future<Output = AppResult<T>>,
) -> AppResult<T> {
    tokio::select! {
        biased;
        _ = report.cancel.wait() => Err(AppError::msg("Cancelled")),
        result = work => result,
    }
}

/// The file's size, where the server can say (sys.dm_os_enumerate_filesystem
/// needs SQL Server 2017 and sysadmin).
async fn size_on_server(client: &mut Tds, path: &str) -> Option<u64> {
    let split = path.rfind(['/', '\\'])?;
    let (dir, name) = (&path[..split + 1], &path[split + 1..]);
    let sql = format!(
        "SELECT size_in_bytes FROM sys.dm_os_enumerate_filesystem({}, {})",
        literal(dir),
        literal(name)
    );
    let rows = client
        .simple_query(sql)
        .await
        .ok()?
        .into_first_result()
        .await
        .ok()?;
    let size: i64 = rows.first()?.get(0)?;
    u64::try_from(size).ok()
}

/// Copies `source`, a path on the server, to `file` on this computer.
pub async fn copy(
    server: &Server,
    source: &str,
    file: &Path,
    report: &Report<'_>,
) -> AppResult<()> {
    let mut session = connect(server).await?;
    let client = session.client();
    report.line(format!(
        "Copying {source} from the server to {}",
        file.display()
    ));

    let known =
        unless_cancelled(report, async { Ok(size_on_server(client, source).await) }).await?;
    if let Some(size) = known {
        if size > MAX_SIZE {
            return Err(too_big(Some(size)));
        }
        report.set_total(size);
    }
    report.check()?;

    // A session-level batch, so the temp table outlives it; the parameterised
    // reads below run through sp_executesql, one scope down
    let load = format!(
        "SET NOCOUNT ON;\n\
         CREATE TABLE #backup_copy (data varbinary(max) NOT NULL);\n\
         INSERT INTO #backup_copy (data)\n  \
           SELECT BulkColumn FROM OPENROWSET(BULK {}, SINGLE_BLOB) AS f;\n\
         SELECT DATALENGTH(data) FROM #backup_copy;",
        literal(source)
    );
    let rows = unless_cancelled(report, async {
        let stream = client.simple_query(load).await.map_err(explain)?;
        stream.into_first_result().await.map_err(explain)
    })
    .await?;
    let total = rows
        .first()
        .and_then(|r| r.get::<i64, _>(0))
        .and_then(|n| u64::try_from(n).ok())
        .unwrap_or(0);
    report.set_total(total);

    // Never someone else's file: the name is this job's own
    let mut out = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(file)
        .await
        .map_err(|e| AppError::msg(format!("Can't write {}: {e}", file.display())))?;
    let mut done: u64 = 0;
    while done < total {
        report.check()?;
        // SUBSTRING counts from 1
        let start = done as i64 + 1;
        let rows = unless_cancelled(report, async {
            let stream = client
                .query(
                    "SELECT SUBSTRING(data, @P1, @P2) FROM #backup_copy",
                    &[&start, &CHUNK],
                )
                .await?;
            Ok(stream.into_first_result().await?)
        })
        .await?;
        let chunk: &[u8] = rows.first().and_then(|r| r.get(0)).unwrap_or_default();
        if chunk.is_empty() {
            break;
        }
        out.write_all(chunk)
            .await
            .map_err(|e| AppError::msg(format!("Can't write {}: {e}", file.display())))?;
        done += chunk.len() as u64;
        report.advance(chunk.len() as u64);
    }
    out.flush().await?;
    out.sync_all().await?;
    if done != total {
        return Err(AppError::msg(format!(
            "The server sent {done} of the backup's {total} bytes"
        )));
    }
    report.line(format!("Copied {total} bytes"));
    Ok(())
}
