//! SQL Server: moves backups between the server's disk and this computer.
//! BACKUP and RESTORE only use files the server can reach, so they travel over
//! the connection. Downloads load the file with OPENROWSET(BULK … SINGLE_BLOB)
//! into a temp table and read it in chunks; uploads send chunks into a temp
//! table and write them out with OLE Automation's ADODB.Stream, which only
//! Windows servers with "Ole Automation Procedures" turned on have.

use std::future::Future;
use std::path::Path;

use tiberius::Client;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
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

/* ---------- Uploads ---------- */

/// Uploaded files are named with this, and only such files are deleted.
const UPLOAD_PREFIX: &str = "dbms-tool-upload-";

/// A local backup made readable by the server.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    /// The path RESTORE reads
    pub path: String,
    /// Copied to the server, to delete once restored
    pub uploaded: bool,
}

/// The first row of a query, or None if it fails or returns none.
async fn first_row(client: &mut Tds, sql: &str) -> Option<tiberius::Row> {
    let rows = client
        .simple_query(sql)
        .await
        .ok()?
        .into_first_result()
        .await
        .ok()?;
    rows.into_iter().next()
}

fn text(row: Option<tiberius::Row>) -> Option<String> {
    row?.get::<&str, _>(0).map(str::to_string)
}

async fn run(client: &mut Tds, sql: String) -> AppResult<()> {
    client.simple_query(sql).await?.into_results().await?;
    Ok(())
}

/// Whether the connection goes to SQL Server on this computer.
fn on_this_computer(server: &Server) -> bool {
    if server.config.tunneled.is_some() {
        return false;
    }
    let host = server.config.host.trim().to_ascii_lowercase();
    // `host\INSTANCE` names an instance on `host`
    let host = host.split('\\').next().unwrap_or_default();
    let machine = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        host,
        "" | "localhost" | "127.0.0.1" | "::1" | "." | "(local)"
    ) || (!machine.is_empty() && host == machine)
}

/// Why `upload` failed, and whether it may have left its copy on the server.
pub struct UploadFailed {
    pub error: AppError,
    /// A copy the server may still hold, which couldn't be deleted
    pub leftover: Option<String>,
}

impl From<AppError> for UploadFailed {
    fn from(error: AppError) -> Self {
        Self {
            error,
            leftover: None,
        }
    }
}

/// Makes `file`, on this computer, readable by the server: the file itself
/// when the server runs here and sees it, otherwise a copy in the server's
/// default backup folder. The copy is limited to 2 GB: it passes through
/// tempdb on its way, and the server holds all of it in memory to write it.
pub async fn upload(
    server: &Server,
    file: &Path,
    report: &Report<'_>,
) -> Result<Staged, UploadFailed> {
    let size = tokio::fs::metadata(file)
        .await
        .map_err(|e| AppError::msg(format!("Can't read {}: {e}", file.display())))?
        .len();
    let mut session = connect(server).await?;
    let client = session.client();
    let local = file.to_string_lossy().to_string();

    // A server here may still be a container that sees a different disk
    if on_this_computer(server)
        && unless_cancelled(report, async { Ok(size_on_server(client, &local).await) }).await?
            == Some(size)
    {
        report.line(format!("The server reads {local} directly"));
        return Ok(Staged {
            path: local,
            uploaded: false,
        });
    }
    if size > MAX_SIZE {
        return Err(AppError::msg(format!(
            "The backup is larger than 2 GB ({:.1} GB), the most this app sends to a server. \
             Copy the file to the server another way, then choose it under \"On the server\".",
            size as f64 / 1e9
        ))
        .into());
    }

    let platform = unless_cancelled(report, async {
        Ok(text(
            first_row(client, "SELECT host_platform FROM sys.dm_os_host_info").await,
        ))
    })
    .await?;
    if platform.as_deref() == Some("Linux") {
        return Err(AppError::msg(
            "SQL Server on Linux can't receive a backup over the connection. Copy the file \
             to the server first (for a Docker container: docker cp <file> \
             <container>:/var/opt/mssql/backup/), then choose it under \"On the server\".",
        )
        .into());
    }
    let ole = unless_cancelled(report, async {
        Ok(first_row(
            client,
            "SELECT CAST(value_in_use AS int) FROM sys.configurations \
             WHERE name = N'Ole Automation Procedures'",
        )
        .await
        .and_then(|r| r.get::<i32, _>(0)))
    })
    .await?;
    if ole != Some(1) {
        return Err(AppError::msg(
            "Sending a backup to the server writes it with OLE Automation, which is turned \
             off on this server. An administrator can turn it on with sp_configure \
             'Ole Automation Procedures', 1; or copy the file to the server and choose it \
             under \"On the server\".",
        )
        .into());
    }
    let dir = unless_cancelled(report, async { Ok(backup_folder(client).await) })
        .await?
        .ok_or_else(|| AppError::msg("The server didn't report a default backup folder"))?;
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "backup.bak".into());
    let tag: String = report
        .job
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(12)
        .collect();
    let target = format!(
        "{}\\{UPLOAD_PREFIX}{tag}-{name}",
        dir.trim_end_matches(['\\', '/'])
    );

    report.line(format!("Sending {local} to {target} on the server"));
    report.set_total(size);
    if let Err(error) = send(client, file, &target, size, report).await {
        // The write may have created the file. A session cancelled mid-insert
        // may still be busy, so it's closed and a fresh one deletes the copy
        drop(session);
        let leftover = match discard(server, &target).await {
            Ok(()) => None,
            Err(e) => {
                report.line(format!(
                    "WARNING: {target} may still be on the server and couldn't be deleted: {e}"
                ));
                Some(target)
            }
        };
        return Err(UploadFailed { error, leftover });
    }
    report.line(format!("Sent {size} bytes"));
    Ok(Staged {
        path: target,
        uploaded: true,
    })
}

/// The server's default backup folder: a server property from SQL Server
/// 2019, the instance's registry setting before that.
async fn backup_folder(client: &mut Tds) -> Option<String> {
    let usable = |d: &String| !d.trim().is_empty();
    let property = text(
        first_row(
            client,
            "SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(4000))",
        )
        .await,
    );
    if let Some(dir) = property.filter(usable) {
        return Some(dir);
    }
    let registry = "SET NOCOUNT ON;
DECLARE @dir nvarchar(4000);
EXEC master.dbo.xp_instance_regread N'HKEY_LOCAL_MACHINE',
    N'Software\\Microsoft\\MSSQLServer\\MSSQLServer', N'BackupDirectory', @dir OUTPUT;
SELECT @dir;";
    text(first_row(client, registry).await).filter(usable)
}

/// Sends `file` into a temp table, then has the server write it to `target`.
async fn send(
    client: &mut Tds,
    file: &Path,
    target: &str,
    size: u64,
    report: &Report<'_>,
) -> AppResult<()> {
    unless_cancelled(
        report,
        run(
            client,
            "SET NOCOUNT ON; \
             CREATE TABLE #upload (seq int PRIMARY KEY, data varbinary(max) NOT NULL);"
                .into(),
        ),
    )
    .await?;
    let mut input = tokio::fs::File::open(file)
        .await
        .map_err(|e| AppError::msg(format!("Can't read {}: {e}", file.display())))?;
    let mut buffer = vec![0u8; CHUNK as usize];
    let mut seq: i32 = 0;
    loop {
        let mut filled = 0;
        while filled < buffer.len() {
            let n = input.read(&mut buffer[filled..]).await?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        if filled == 0 {
            break;
        }
        let chunk = &buffer[..filled];
        unless_cancelled(report, async {
            client
                .execute(
                    "INSERT INTO #upload (seq, data) VALUES (@P1, @P2)",
                    &[&seq, &chunk],
                )
                .await?;
            Ok(())
        })
        .await?;
        seq += 1;
        report.advance(filled as u64);
    }

    report.line("Writing the file on the server…");
    // Each chunk leaves tempdb once it's in the stream
    let write = format!(
        "SET NOCOUNT ON;
DECLARE @stream int, @hr int = 0, @chunk varbinary(max), @seq int = 0,
    @last int = (SELECT MAX(seq) FROM #upload),
    @source nvarchar(4000), @description nvarchar(4000), @message nvarchar(4000);
EXEC @hr = sp_OACreate 'ADODB.Stream', @stream OUT;
IF @hr = 0 EXEC @hr = sp_OASetProperty @stream, 'Type', 1;
IF @hr = 0 EXEC @hr = sp_OAMethod @stream, 'Open';
WHILE @hr = 0 AND @seq <= @last
BEGIN
    SELECT @chunk = data FROM #upload WHERE seq = @seq;
    EXEC @hr = sp_OAMethod @stream, 'Write', NULL, @chunk;
    DELETE FROM #upload WHERE seq = @seq;
    SET @seq += 1;
END;
IF @hr = 0 EXEC @hr = sp_OAMethod @stream, 'SaveToFile', NULL, {path}, 2;
IF @hr <> 0 EXEC sp_OAGetErrorInfo @stream, @source OUT, @description OUT;
IF @stream IS NOT NULL EXEC sp_OADestroy @stream;
IF @hr <> 0
BEGIN
    SET @message = CONCAT(N'Couldn''t write the backup on the server: ',
        ISNULL(@description, CONVERT(nvarchar(20), CONVERT(varbinary(4), @hr), 1)));
    THROW 50000, @message, 1;
END;",
        path = literal(target)
    );
    // Not raced against Cancel: closing the connection doesn't stop the batch,
    // which could then save the file after a cleanup found nothing to delete.
    // It's bounded, the data being in tempdb already; a cancel during it is
    // honoured once it ends, and `upload` deletes the finished copy
    run(client, write).await?;
    report.check()?;
    let written =
        unless_cancelled(report, async { Ok(size_on_server(client, target).await) }).await?;
    match written {
        Some(n) if n != size => Err(AppError::msg(format!(
            "The server wrote {n} of the backup's {size} bytes"
        ))),
        _ => Ok(()),
    }
}

/// Deletes `path` on the server if it's there; fails if it can't.
async fn delete_upload(client: &mut Tds, path: &str) -> AppResult<()> {
    let sql = format!(
        "SET NOCOUNT ON;
DECLARE @fs int, @hr int, @exists int = 0,
    @source nvarchar(4000), @description nvarchar(4000), @message nvarchar(4000);
EXEC @hr = sp_OACreate 'Scripting.FileSystemObject', @fs OUT;
IF @hr = 0 EXEC @hr = sp_OAMethod @fs, 'FileExists', @exists OUT, {path};
IF @hr = 0 AND @exists <> 0 EXEC @hr = sp_OAMethod @fs, 'DeleteFile', NULL, {path};
IF @hr <> 0 EXEC sp_OAGetErrorInfo @fs, @source OUT, @description OUT;
IF @fs IS NOT NULL EXEC sp_OADestroy @fs;
IF @hr <> 0
BEGIN
    SET @message = CONCAT(N'Couldn''t delete the backup on the server: ',
        ISNULL(@description, CONVERT(nvarchar(20), CONVERT(varbinary(4), @hr), 1)));
    THROW 50000, @message, 1;
END;",
        path = literal(path)
    );
    run(client, sql).await
}

/// Deletes a backup `upload` copied to the server; succeeds if it's gone already.
pub async fn discard(server: &Server, path: &str) -> AppResult<()> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or_default();
    if !name.starts_with(UPLOAD_PREFIX) {
        return Err(AppError::msg(
            "Only backups this app sent to the server are deleted",
        ));
    }
    let mut session = connect(server).await?;
    delete_upload(session.client(), path).await
}
