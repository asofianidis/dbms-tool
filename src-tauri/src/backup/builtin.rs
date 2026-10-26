//! The built-in engine: backs up and restores without the client tools, for
//! when pg_dump, mysqldump or mongodump aren't installed. It writes what those
//! tools write (a plain SQL script for PostgreSQL, a mysqldump-style script, a
//! mongodump folder or archive), so its backups restore with the real tools
//! too, and it restores the tools' own backups in those formats. PostgreSQL's
//! custom, tar and directory archives still need pg_dump and pg_restore.

mod mongo;
mod mssql;
mod mysql;
mod postgres;
mod split;

use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use flate2::Compression;
use flate2::write::GzEncoder;
use serde::Serialize;
use tauri::Emitter as _;

use super::{Job, Jobs, Outcome, PROGRESS_EVENT, PgFormat, size_of};
use crate::drivers::Session;
use crate::error::{AppError, AppResult};
use crate::manager::Server;
use crate::model::CancelSignal;

pub use mongo::archive_contents as mongo_archive_contents;
pub use mongo::unescape_name as mongo_unescape_name;

/// Whether the built-in engine can run `job`, and why not when it can't.
pub fn supports(job: &Job) -> AppResult<()> {
    match job {
        Job::PgDump(j) if j.format != PgFormat::Plain => Err(AppError::msg(
            "pg_dump wasn't found. Without it, backups are written as a plain SQL script; \
             choose that format, or install the PostgreSQL client tools.",
        )),
        Job::PgRestore(_) => Err(AppError::msg(
            "pg_restore wasn't found. It's needed for custom, tar and directory backups; \
             install the PostgreSQL client tools, or choose the folder they're in.",
        )),
        _ => Ok(()),
    }
}

/// What the built-in engine will do, shown where the command line would be.
pub fn describe(job: &Job) -> String {
    let (tool, what) = match job {
        Job::PgDump(j) => (
            "pg_dump",
            format!(
                "Writes {} as a plain SQL script (data as COPY blocks{}), \
                 which restores with psql or this app.",
                j.database,
                if j.inserts {
                    ", or INSERT statements"
                } else {
                    ""
                }
            ),
        ),
        Job::Psql(j) => (
            "psql",
            format!(
                "Runs the SQL script against {}, statement by statement.",
                j.database
            ),
        ),
        Job::Mysqldump(j) => (
            "mysqldump",
            format!(
                "Writes {} as a mysqldump-style SQL script, which restores with the mysql client or this app.",
                j.database
            ),
        ),
        Job::Mysql(j) => (
            "mysql",
            format!(
                "Runs the SQL script against {}, statement by statement.",
                j.database
            ),
        ),
        Job::Mongodump(j) => (
            "mongodump",
            format!(
                "Writes {} as a mongodump {}{}, which restores with mongorestore or this app.",
                j.database,
                if j.archive { "archive" } else { "folder" },
                if j.gzip { " (gzip)" } else { "" }
            ),
        ),
        Job::Mongorestore(_) => (
            "mongorestore",
            "Reads the mongodump backup and inserts its documents, then builds its indexes.".into(),
        ),
        Job::PgRestore(_) => ("pg_restore", String::new()),
    };
    format!("Built-in engine ({tool} isn't installed)\n{what}")
}

/// The file a job reads, for progress by bytes.
fn input_size(job: &Job) -> Option<u64> {
    let path = match job {
        Job::Psql(j) => &j.file,
        Job::Mysql(j) => &j.file,
        Job::Mongorestore(j) => &j.path,
        _ => return None,
    };
    Some(size_of(Path::new(path.trim())))
}

/// The backup a job writes, measured (or removed) when it ends.
fn output_path(job: &Job) -> Option<PathBuf> {
    match job {
        Job::PgDump(j) => Some(PathBuf::from(j.file.trim())),
        Job::Mysqldump(j) => Some(PathBuf::from(j.file.trim())),
        Job::Mongodump(j) => Some(PathBuf::from(j.path.trim())),
        _ => None,
    }
}

pub async fn run(
    app: &tauri::AppHandle,
    jobs: &Jobs,
    job_id: &str,
    server: &Server,
    job: &Job,
) -> AppResult<Outcome> {
    execute(Some(app), jobs, job_id, server, job).await
}

/// Runs a job, sending progress to the app when there is one (tests print it).
async fn execute(
    app: Option<&tauri::AppHandle>,
    jobs: &Jobs,
    job_id: &str,
    server: &Server,
    job: &Job,
) -> AppResult<Outcome> {
    supports(job)?;
    let started = Instant::now();
    let cancel = jobs.register(job_id);
    let report = Report::new(app, job_id, cancel, input_size(job));
    report.line(describe(job).lines().next().unwrap_or_default());
    let folder = match job {
        Job::Mongodump(j) => mongo::DumpFolder::before(j),
        _ => None,
    };
    let result = match job {
        Job::PgDump(j) => postgres::dump(server, j, &report).await,
        Job::Psql(j) => postgres::restore(server, j, &report).await,
        Job::Mysqldump(j) => mysql::dump(server, j, &report).await,
        Job::Mysql(j) => mysql::restore(server, j, &report).await,
        Job::Mongodump(j) => mongo::dump(server, j, &report).await,
        Job::Mongorestore(j) => mongo::restore(server, j, &report).await,
        Job::PgRestore(_) => unreachable!("rejected by supports"),
    };
    jobs.unregister(job_id);
    let output = output_path(job);
    let cancelled = report.cancelled();
    if (result.is_err() || cancelled)
        && let Some(path) = &output
        && path.is_file()
    {
        let _ = std::fs::remove_file(path);
    }
    // A folder dump leaves the files it wrote so far
    if (result.is_err() || cancelled)
        && let Some(folder) = &folder
    {
        folder.discard();
    }
    if let Err(e) = &result
        && !cancelled
    {
        let text = e.to_string();
        report.line(if text.starts_with("ERROR") {
            text
        } else {
            format!("ERROR: {text}")
        });
    }
    report.flush();
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if cancelled {
        return Ok(Outcome {
            cancelled: true,
            elapsed_ms,
            size: None,
            errors: 0,
        });
    }
    result?;
    Ok(Outcome {
        cancelled: false,
        elapsed_ms,
        size: output.as_deref().map(size_of),
        errors: report.errors.load(Ordering::Relaxed),
    })
}

/// Copies a backup SQL Server wrote to its own disk into `file` on this
/// computer. It's written beside `file` first, under a name of its own, so a
/// failed copy leaves any file already there alone and two copies to the same
/// place don't write into each other.
pub async fn mssql_download(
    app: &tauri::AppHandle,
    jobs: &Jobs,
    job_id: &str,
    server: &Server,
    source: &str,
    file: &str,
) -> AppResult<Outcome> {
    let source = source.trim();
    let file = PathBuf::from(file.trim());
    if source.is_empty() || file.as_os_str().is_empty() {
        return Err(AppError::msg("Choose where to save the backup"));
    }
    let mut partial = file.clone().into_os_string();
    let tag: String = job_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(12)
        .collect();
    partial.push(format!(".{tag}.part"));
    let partial = PathBuf::from(partial);
    let started = Instant::now();
    let cancel = jobs.register(job_id);
    let report = Report::new(Some(app), job_id, cancel, None);
    let mut result = mssql::copy(server, source, &partial, &report).await;
    if result.is_ok() && !report.cancelled() {
        result = std::fs::rename(&partial, &file)
            .map_err(|e| AppError::msg(format!("Can't write {}: {e}", file.display())));
    }
    jobs.unregister(job_id);
    let cancelled = report.cancelled();
    if result.is_err() || cancelled {
        let _ = std::fs::remove_file(&partial);
    }
    if let Err(e) = &result
        && !cancelled
    {
        report.line(format!("ERROR: {e}"));
    }
    report.flush();
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if cancelled {
        return Ok(Outcome {
            cancelled: true,
            elapsed_ms,
            size: None,
            errors: 0,
        });
    }
    result?;
    Ok(Outcome {
        cancelled: false,
        elapsed_ms,
        size: Some(size_of(&file)),
        errors: 0,
    })
}

/* ---------- Progress ---------- */

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    job: &'a str,
    lines: Vec<String>,
    bytes: Option<u64>,
    total: Option<u64>,
}

/// A running job's log, progress and cancellation, sent to the wizard the
/// same way a client tool's output is.
pub(super) struct Report<'a> {
    app: Option<&'a tauri::AppHandle>,
    job: &'a str,
    cancel: Arc<CancelSignal>,
    pending: parking_lot::Mutex<Vec<String>>,
    last: parking_lot::Mutex<Instant>,
    /// Bytes of the input read so far
    bytes: Arc<AtomicU64>,
    total: parking_lot::Mutex<Option<u64>>,
    errors: AtomicU32,
}

const EMIT_EVERY: Duration = Duration::from_millis(250);

impl<'a> Report<'a> {
    fn new(
        app: Option<&'a tauri::AppHandle>,
        job: &'a str,
        cancel: Arc<CancelSignal>,
        total: Option<u64>,
    ) -> Self {
        Self {
            app,
            job,
            cancel,
            pending: Default::default(),
            last: parking_lot::Mutex::new(Instant::now()),
            bytes: Default::default(),
            total: parking_lot::Mutex::new(total),
            errors: AtomicU32::new(0),
        }
    }

    pub fn line(&self, line: impl Into<String>) {
        self.pending.lock().push(line.into());
        self.tick();
    }

    /// An error the job carries on past; counted for the outcome.
    pub fn error(&self, message: impl std::fmt::Display) {
        self.errors.fetch_add(1, Ordering::Relaxed);
        let text = message.to_string();
        // Server errors already say "ERROR: …"
        self.line(if text.starts_with("ERROR") {
            text
        } else {
            format!("ERROR: {text}")
        });
    }

    /// Wraps the input so reading it advances the progress bar.
    pub fn counting<R: Read>(&self, inner: R) -> Counting<R> {
        Counting {
            inner,
            bytes: self.bytes.clone(),
        }
    }

    /// Sets the size progress is measured against, once it's known.
    pub fn set_total(&self, total: u64) {
        *self.total.lock() = Some(total);
    }

    /// Counts `n` more bytes of the input as done.
    pub fn advance(&self, n: u64) {
        self.bytes.fetch_add(n, Ordering::Relaxed);
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.is_fired()
    }

    /// Fails with a placeholder error once the job is cancelled; `run` reports
    /// the cancellation rather than the error.
    pub fn check(&self) -> AppResult<()> {
        self.tick();
        if self.cancelled() {
            Err(AppError::msg("Cancelled"))
        } else {
            Ok(())
        }
    }

    pub fn tick(&self) {
        let mut last = self.last.lock();
        if last.elapsed() >= EMIT_EVERY {
            *last = Instant::now();
            drop(last);
            self.emit();
        }
    }

    fn flush(&self) {
        self.emit();
    }

    fn emit(&self) {
        let lines = std::mem::take(&mut *self.pending.lock());
        let total = *self.total.lock();
        let Some(app) = self.app else {
            for line in lines {
                println!("{line}");
            }
            return;
        };
        let _ = app.emit(
            PROGRESS_EVENT,
            Progress {
                job: self.job,
                lines,
                bytes: total.map(|_| self.bytes.load(Ordering::Relaxed)),
                total,
            },
        );
    }
}

pub(super) struct Counting<R> {
    inner: R,
    bytes: Arc<AtomicU64>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.bytes.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

/* ---------- Files ---------- */

/// A backup file being written, gzipped or not.
pub(super) enum Output {
    Plain(BufWriter<File>),
    Gzip(GzEncoder<BufWriter<File>>),
}

impl Output {
    pub fn create(path: &Path, gzip: bool) -> AppResult<Self> {
        let file = File::create(path)
            .map_err(|e| AppError::msg(format!("Can't write {}: {e}", path.display())))?;
        let file = BufWriter::with_capacity(1 << 20, file);
        Ok(if gzip {
            Output::Gzip(GzEncoder::new(file, Compression::default()))
        } else {
            Output::Plain(file)
        })
    }

    pub fn finish(self) -> AppResult<()> {
        match self {
            Output::Plain(mut w) => w.flush()?,
            Output::Gzip(w) => w.finish()?.flush()?,
        }
        Ok(())
    }
}

impl Write for Output {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Output::Plain(w) => w.write(buf),
            Output::Gzip(w) => w.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Output::Plain(w) => w.flush(),
            Output::Gzip(w) => w.flush(),
        }
    }
}

/// Opens a backup for reading, through gzip when it starts with gzip's magic.
pub(super) fn open_input(path: &Path, report: &Report) -> AppResult<Box<dyn Read + Send>> {
    let mut file = File::open(path)
        .map_err(|e| AppError::msg(format!("Can't read {}: {e}", path.display())))?;
    let mut magic = [0u8; 2];
    let gzip = file.read(&mut magic)? == 2 && magic == [0x1f, 0x8b];
    let file = File::open(path)?;
    let counted = report.counting(std::io::BufReader::with_capacity(1 << 20, file));
    Ok(if gzip {
        Box::new(flate2::read::MultiGzDecoder::new(counted))
    } else {
        Box::new(counted)
    })
}

/// A fresh session on `database`, the way the app's own sessions connect.
async fn session(server: &Server, database: &str) -> AppResult<Session> {
    Session::connect(&server.config, server.password(), database).await
}

/// The first line of a statement, shortened, for error messages.
pub(super) fn excerpt(sql: &str) -> String {
    let line = sql.trim().lines().next().unwrap_or_default();
    if line.chars().count() > 120 {
        format!("{}…", line.chars().take(120).collect::<String>())
    } else {
        line.to_string()
    }
}

/* ---------- CRC-64 (mongodump archives) ---------- */

/// Go's `crc64.ECMA` (CRC-64/XZ), which mongodump archives checksum each
/// collection's documents with.
pub(super) struct Crc64(u64);

static CRC64_TABLE: std::sync::LazyLock<[u64; 256]> = std::sync::LazyLock::new(|| {
    const POLY: u64 = 0xC96C_5795_D787_0F42;
    let mut table = [0u64; 256];
    for (i, entry) in table.iter_mut().enumerate() {
        let mut crc = i as u64;
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ POLY
            } else {
                crc >> 1
            };
        }
        *entry = crc;
    }
    table
});

impl Crc64 {
    pub fn new() -> Self {
        Crc64(0)
    }

    pub fn update(&mut self, data: &[u8]) {
        let table = &*CRC64_TABLE;
        let mut crc = !self.0;
        for &b in data {
            crc = table[((crc ^ b as u64) & 0xff) as usize] ^ (crc >> 8);
        }
        self.0 = !crc;
    }

    pub fn value(&self) -> i64 {
        self.0 as i64
    }
}

#[cfg(test)]
mod live_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc64_matches_go_ecma() {
        // CRC-64/XZ check value
        let mut crc = Crc64::new();
        crc.update(b"123456789");
        assert_eq!(crc.0, 0x995D_C9BB_DF19_39FA);
        // Updates chain like one pass
        let mut split = Crc64::new();
        split.update(b"1234");
        split.update(b"56789");
        assert_eq!(split.0, crc.0);
    }

    #[test]
    fn only_pg_archives_need_the_tools() {
        let job = |v: serde_json::Value| serde_json::from_value::<Job>(v).unwrap();
        let dump = |format: &str| {
            job(
                serde_json::json!({ "tool": "pg_dump", "database": "d", "file": "f", "format": format }),
            )
        };
        assert!(supports(&dump("plain")).is_ok());
        assert!(supports(&dump("custom")).is_err());
        assert!(
            supports(&job(
                serde_json::json!({ "tool": "pg_restore", "database": "d", "file": "f" })
            ))
            .is_err()
        );
        assert!(
            supports(&job(
                serde_json::json!({ "tool": "mongodump", "database": "d", "path": "p" })
            ))
            .is_ok()
        );
    }
}
