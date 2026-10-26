//! MongoDB: writes what mongodump writes (a folder of `<db>/<coll>.bson` files
//! with `.metadata.json` beside them, or one archive, either gzipped) and
//! restores both, so backups move freely between this and the real tools.
//!
//! An archive is a magic number, a prelude (a header document, then one
//! metadata document per collection, then a terminator), then blocks: a
//! namespace header, that collection's documents and a terminator, and finally
//! an EOF header carrying the CRC-64 of the collection's documents.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use futures_util::TryStreamExt as _;
use mongodb::Database;
use mongodb::bson::{Bson, Document, RawDocumentBuf, doc, spec::BinarySubtype};
use mongodb::error::ErrorKind;

use super::{Crc64, Output, Report, open_input};
use crate::backup::{MongoDumpJob, MongoRestoreJob};
use crate::error::{AppError, AppResult};
use crate::manager::Server;

const MAGIC: [u8; 4] = [0x6d, 0xe2, 0x99, 0x81];
const TERMINATOR: [u8; 4] = [0xff, 0xff, 0xff, 0xff];
/// The server's limit is 16 MB; anything far past it is a corrupt length
const MAX_DOCUMENT: usize = 48 << 20;

fn bson_bytes(doc: &Document) -> AppResult<Vec<u8>> {
    let mut out = Vec::new();
    doc.to_writer(&mut out)
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok(out)
}

/// mongodump's file names: characters file systems reject become %XX.
fn escape_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if matches!(
            c,
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '%'
        ) || c.is_control()
        {
            for b in c.to_string().bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn unescape_name(name: &str) -> String {
    let bytes = name.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(hex) = bytes.get(i + 1..i + 3)
            && let Ok(hex) = std::str::from_utf8(hex)
            && let Ok(b) = u8::from_str_radix(hex, 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/* ---------- Dump ---------- */

struct Collection {
    name: String,
    view: bool,
    metadata: String,
}

/// The collection's metadata as mongodump writes it: options, indexes, uuid, name and type.
async fn metadata(db: &Database, spec: &Document) -> AppResult<Collection> {
    let name = spec.get_str("name").unwrap_or_default().to_string();
    let kind = spec.get_str("type").unwrap_or("collection").to_string();
    let view = kind == "view";
    let mut meta = Document::new();
    if let Ok(options) = spec.get_document("options")
        && !options.is_empty()
    {
        meta.insert("options", options.clone());
    }
    let indexes: Vec<Bson> = if view {
        Vec::new()
    } else {
        db.run_cursor_command(doc! { "listIndexes": &name })
            .await?
            .try_collect::<Vec<Document>>()
            .await?
            .into_iter()
            .map(Bson::Document)
            .collect()
    };
    meta.insert("indexes", indexes);
    if let Ok(info) = spec.get_document("info")
        && let Some(Bson::Binary(uuid)) = info.get("uuid")
        && uuid.subtype == BinarySubtype::Uuid
    {
        let hex: String = uuid.bytes.iter().map(|b| format!("{b:02x}")).collect();
        meta.insert("uuid", hex);
    }
    meta.insert("collectionName", &name);
    meta.insert("type", kind);
    let json = Bson::Document(meta).into_canonical_extjson().to_string();
    Ok(Collection {
        name,
        view,
        metadata: json,
    })
}

pub async fn dump(server: &Server, job: &MongoDumpJob, report: &Report<'_>) -> AppResult<()> {
    let client = server.mongo_client()?;
    let name = job.database.trim();
    let db = client.database(name);
    let specs: Vec<Document> = db
        .run_cursor_command(doc! { "listCollections": 1, "authorizedCollections": true })
        .await?
        .try_collect()
        .await?;
    let excluded: HashSet<&str> = job.exclude_collections.iter().map(String::as_str).collect();
    let mut collections = Vec::new();
    for spec in &specs {
        let coll = spec.get_str("name").unwrap_or_default();
        if coll.starts_with("system.") || excluded.contains(coll) {
            continue;
        }
        collections.push(metadata(&db, spec).await?);
    }
    // Collections first, then the views over them
    collections.sort_by(|a, b| a.view.cmp(&b.view).then(a.name.cmp(&b.name)));
    let server_version = client
        .database("admin")
        .run_command(doc! { "buildInfo": 1 })
        .await
        .ok()
        .and_then(|d| d.get_str("version").ok().map(String::from))
        .unwrap_or_default();

    let path = Path::new(job.path.trim());
    if job.archive {
        let mut out = Output::create(path, job.gzip)?;
        out.write_all(&MAGIC)?;
        out.write_all(&bson_bytes(&doc! {
            "concurrent_collections": 1_i32,
            "version": "0.1",
            "server_version": &server_version,
            "tool_version": format!("dbms-tool {}", env!("CARGO_PKG_VERSION")),
        })?)?;
        for c in &collections {
            out.write_all(&bson_bytes(&doc! {
                "db": name,
                "collection": &c.name,
                "metadata": &c.metadata,
                "size": 0_i32,
                "type": if c.view { "view" } else { "collection" },
            })?)?;
        }
        out.write_all(&TERMINATOR)?;
        for c in &collections {
            let header = |eof: bool, crc: i64| {
                bson_bytes(&doc! { "db": name, "collection": &c.name, "EOF": eof, "CRC": crc })
            };
            out.write_all(&header(false, 0)?)?;
            let mut crc = Crc64::new();
            if !c.view {
                let count = dump_documents(&db, &c.name, &mut out, Some(&mut crc), report).await?;
                report.line(format!("dumped {count} documents from {name}.{}", c.name));
            }
            out.write_all(&TERMINATOR)?;
            out.write_all(&header(true, crc.value())?)?;
            out.write_all(&TERMINATOR)?;
        }
        out.finish()?;
    } else {
        let dir = path.join(escape_name(name));
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::msg(format!("Can't create {}: {e}", dir.display())))?;
        let gz = if job.gzip { ".gz" } else { "" };
        for c in &collections {
            let base = escape_name(&c.name);
            let mut meta =
                Output::create(&dir.join(format!("{base}.metadata.json{gz}")), job.gzip)?;
            meta.write_all(c.metadata.as_bytes())?;
            meta.finish()?;
            if !c.view {
                let mut out = Output::create(&dir.join(format!("{base}.bson{gz}")), job.gzip)?;
                let count = dump_documents(&db, &c.name, &mut out, None, report).await?;
                out.finish()?;
                report.line(format!("dumped {count} documents from {name}.{}", c.name));
            }
        }
        let mut prelude = Output::create(&dir.join("prelude.json"), false)?;
        prelude.write_all(
            serde_json::json!({
                "ServerVersion": server_version,
                "ToolVersion": format!("dbms-tool {}", env!("CARGO_PKG_VERSION")),
            })
            .to_string()
            .as_bytes(),
        )?;
        prelude.finish()?;
    }
    Ok(())
}

/// The outermost of `dir` and its parents that doesn't exist yet, which is what
/// a run creates. Only a definite NotFound counts: `Path::exists` follows links
/// and says false on any error, so a broken link or junction (a backup folder
/// on a disconnected drive) would look missing and be removed with the dump.
/// Links are looked at, not through, and any other error stops the walk.
fn outermost_missing(dir: &Path) -> Option<PathBuf> {
    let mut created = None;
    let mut probe = Some(dir);
    while let Some(p) = probe.filter(|p| !p.as_os_str().is_empty()) {
        match std::fs::symlink_metadata(p) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                created = Some(p.to_path_buf());
                probe = p.parent();
            }
            _ => break,
        }
    }
    created
}

/// What a folder dump's target held before the run, so a failed or cancelled
/// run removes what it wrote and leaves everything that was there alone.
pub struct DumpFolder {
    dir: PathBuf,
    /// The outermost folder the run creates, removed whole
    created: Option<PathBuf>,
    /// Files already in `dir`
    existing: HashSet<std::ffi::OsString>,
}

impl DumpFolder {
    /// None for archives, which are one file.
    pub fn before(job: &MongoDumpJob) -> Option<Self> {
        if job.archive {
            return None;
        }
        let dir = Path::new(job.path.trim()).join(escape_name(job.database.trim()));
        let created = outermost_missing(&dir);
        let existing = std::fs::read_dir(&dir)
            .map(|entries| entries.flatten().map(|e| e.file_name()).collect())
            .unwrap_or_default();
        Some(Self {
            dir,
            created,
            existing,
        })
    }

    pub fn discard(&self) {
        if let Some(created) = &self.created {
            // Only a real folder: never a link (or junction) that appeared in its place
            if std::fs::symlink_metadata(created).is_ok_and(|m| m.is_dir()) {
                let _ = std::fs::remove_dir_all(created);
            }
            return;
        }
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            if !self.existing.contains(&entry.file_name())
                && entry.file_type().is_ok_and(|t| t.is_file())
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

async fn dump_documents(
    db: &Database,
    name: &str,
    out: &mut Output,
    mut crc: Option<&mut Crc64>,
    report: &Report<'_>,
) -> AppResult<u64> {
    let mut cursor = db.collection::<RawDocumentBuf>(name).find(doc! {}).await?;
    let mut count = 0u64;
    while cursor.advance().await? {
        let bytes = cursor.current().as_bytes();
        out.write_all(bytes)?;
        if let Some(crc) = crc.as_deref_mut() {
            crc.update(bytes);
        }
        count += 1;
        if count.is_multiple_of(2000) {
            report.check()?;
        }
    }
    Ok(count)
}

/* ---------- Restore ---------- */

/// Reads the next document, or None at a clean end of input. `Ok(Some(None))` is
/// an archive terminator.
fn read_document(input: &mut impl Read) -> AppResult<Option<Option<Vec<u8>>>> {
    let mut len = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        let n = input.read(&mut len[got..])?;
        if n == 0 {
            if got == 0 {
                return Ok(None);
            }
            return Err(AppError::msg("The backup ends in the middle of a document"));
        }
        got += n;
    }
    if len == TERMINATOR {
        return Ok(Some(None));
    }
    let size = i32::from_le_bytes(len);
    if size < 5 || size as usize > MAX_DOCUMENT {
        return Err(AppError::msg(
            "The backup is damaged (a document has an invalid length)",
        ));
    }
    let mut doc = vec![0u8; size as usize];
    doc[..4].copy_from_slice(&len);
    input
        .read_exact(&mut doc[4..])
        .map_err(|_| AppError::msg("The backup ends in the middle of a document"))?;
    Ok(Some(Some(doc)))
}

fn parse_metadata(json: &str) -> Option<Document> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    match Bson::try_from(value).ok()? {
        Bson::Document(d) => Some(d),
        _ => None,
    }
}

/// Inserts batches into one collection after preparing it (dropping or
/// creating it with its options), and builds its indexes at the end.
struct Restorer<'a> {
    client: &'a mongodb::Client,
    job: &'a MongoRestoreJob,
    report: &'a Report<'a>,
    /// Existing collections per target database
    existing: HashMap<String, HashSet<String>>,
    /// Errors so far per namespace, to keep the log readable
    logged: HashMap<String, u32>,
}

/// The database `db` from the backup restores into: with a source database
/// chosen, only that one restores (as `to` when given), and nothing else.
fn target_database(from: Option<&str>, to: Option<&str>, db: &str) -> Option<String> {
    match (from, to) {
        (Some(from), _) if from != db => None,
        (_, Some(to)) => Some(to.to_string()),
        _ => Some(db.to_string()),
    }
}

const BATCH_DOCS: usize = 1000;
const BATCH_BYTES: usize = 8 << 20;

impl<'a> Restorer<'a> {
    /// Where `db.coll` from the backup goes, or None when it's not restored.
    fn target(&self, db: &str, coll: &str) -> Option<(String, String)> {
        if coll.starts_with("system.") {
            return None;
        }
        if !self.job.namespaces.is_empty()
            && !self
                .job
                .namespaces
                .iter()
                .any(|n| *n == format!("{db}.{coll}"))
        {
            return None;
        }
        let from = self
            .job
            .from_database
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let to = self
            .job
            .to_database
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        target_database(from, to, db).map(|db| (db, coll.to_string()))
    }

    fn fail(&mut self, ns: &str, message: String) -> AppResult<()> {
        if self.job.stop_on_error {
            return Err(AppError::msg(format!("{ns}: {message}")));
        }
        let n = self.logged.entry(ns.to_string()).or_default();
        *n += 1;
        if *n <= 10 {
            self.report.error(format!("{ns}: {message}"));
        } else {
            self.report
                .errors
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(())
    }

    async fn begin(&mut self, db: &str, coll: &str, metadata: Option<&Document>) -> AppResult<()> {
        let ns = format!("{db}.{coll}");
        let database = self.client.database(db);
        if !self.existing.contains_key(db) {
            let names: HashSet<String> = database
                .list_collection_names()
                .await?
                .into_iter()
                .collect();
            self.existing.insert(db.to_string(), names);
        }
        let exists = self.existing[db].contains(coll);
        if exists && self.job.drop {
            database.collection::<Document>(coll).drop().await?;
            self.existing.get_mut(db).unwrap().remove(coll);
        } else if exists {
            return Ok(());
        }
        let options = metadata
            .and_then(|m| m.get_document("options").ok())
            .cloned()
            .unwrap_or_default();
        let mut create = doc! { "create": coll };
        for (k, v) in options {
            create.insert(k, v);
        }
        if let Err(e) = database.run_command(create).await {
            self.fail(
                &ns,
                format!(
                    "couldn't create it: {}",
                    crate::drivers::mongo::describe_error(&e)
                ),
            )?;
        }
        self.existing.get_mut(db).unwrap().insert(coll.to_string());
        let view = metadata.and_then(|m| m.get_str("type").ok()) == Some("view");
        self.report
            .line(format!("restoring {}{ns}", if view { "view " } else { "" }));
        Ok(())
    }

    /// Inserts a batch; duplicates and other per-document errors don't stop it.
    async fn insert(
        &mut self,
        db: &str,
        coll: &str,
        docs: &mut Vec<RawDocumentBuf>,
    ) -> AppResult<u64> {
        if docs.is_empty() {
            return Ok(0);
        }
        let batch = std::mem::take(docs);
        let total = batch.len() as u64;
        let collection = self.client.database(db).collection::<RawDocumentBuf>(coll);
        match collection
            .insert_many(batch)
            .ordered(self.job.stop_on_error)
            .await
        {
            Ok(_) => Ok(total),
            Err(e) => {
                let ns = format!("{db}.{coll}");
                if let ErrorKind::InsertMany(failure) = e.kind.as_ref()
                    && failure.write_concern_error.is_none()
                    && let Some(errors) = &failure.write_errors
                {
                    for err in errors {
                        self.fail(&ns, err.message.clone())?;
                    }
                    return Ok(total - errors.len() as u64);
                }
                Err(AppError::msg(format!(
                    "{ns}: {}",
                    crate::drivers::mongo::describe_error(&e)
                )))
            }
        }
    }

    async fn end(
        &mut self,
        db: &str,
        coll: &str,
        metadata: Option<&Document>,
        restored: u64,
    ) -> AppResult<()> {
        let ns = format!("{db}.{coll}");
        let view = metadata.and_then(|m| m.get_str("type").ok()) == Some("view");
        if !view {
            self.report
                .line(format!("restored {restored} documents to {ns}"));
        }
        if self.job.no_index_restore || view {
            return Ok(());
        }
        let indexes: Vec<Bson> = metadata
            .and_then(|m| m.get_array("indexes").ok())
            .into_iter()
            .flatten()
            .filter_map(|i| i.as_document())
            .filter(|i| i.get_str("name").ok() != Some("_id_"))
            .map(|i| {
                let mut i = i.clone();
                i.remove("ns");
                Bson::Document(i)
            })
            .collect();
        if indexes.is_empty() {
            return Ok(());
        }
        let count = indexes.len();
        let command = doc! { "createIndexes": coll, "indexes": indexes };
        match self.client.database(db).run_command(command).await {
            Ok(_) => self.report.line(format!("built {count} indexes on {ns}")),
            Err(e) => self.fail(
                &ns,
                format!(
                    "couldn't build indexes: {}",
                    crate::drivers::mongo::describe_error(&e)
                ),
            )?,
        }
        Ok(())
    }
}

pub async fn restore(server: &Server, job: &MongoRestoreJob, report: &Report<'_>) -> AppResult<()> {
    let client = server.mongo_client()?;
    let mut restorer = Restorer {
        client,
        job,
        report,
        existing: HashMap::new(),
        logged: HashMap::new(),
    };
    let path = PathBuf::from(job.path.trim());
    if job.archive {
        restore_archive(&path, &mut restorer).await
    } else {
        restore_folder(&path, &mut restorer).await
    }
}

/// A collection in a mongodump folder: database, name, data file and metadata file.
type FolderEntry = (String, String, Option<PathBuf>, Option<PathBuf>);

fn folder_contents(root: &Path) -> AppResult<Vec<FolderEntry>> {
    let mut found = Vec::new();
    let mut dbs: Vec<PathBuf> = std::fs::read_dir(root)?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dbs.sort();
    for dir in dbs {
        let db = unescape_name(&dir.file_name().unwrap_or_default().to_string_lossy());
        let mut collections: HashMap<String, (Option<PathBuf>, Option<PathBuf>)> = HashMap::new();
        for entry in std::fs::read_dir(&dir)?.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            let plain = file.strip_suffix(".gz").unwrap_or(&file);
            if let Some(c) = plain.strip_suffix(".metadata.json") {
                collections.entry(unescape_name(c)).or_default().1 = Some(entry.path());
            } else if let Some(c) = plain.strip_suffix(".bson") {
                collections.entry(unescape_name(c)).or_default().0 = Some(entry.path());
            }
        }
        let mut names: Vec<String> = collections.keys().cloned().collect();
        // Collections before views, which read from them
        names.sort_by_key(|n| (collections[n].0.is_none(), n.clone()));
        for name in names {
            let (data, meta) = collections.remove(&name).unwrap();
            found.push((db.clone(), name, data, meta));
        }
    }
    Ok(found)
}

fn read_metadata(path: &Path, report: &Report) -> AppResult<Option<Document>> {
    let mut text = String::new();
    open_input(path, report)?.read_to_string(&mut text)?;
    Ok(parse_metadata(&text))
}

async fn restore_folder(root: &Path, r: &mut Restorer<'_>) -> AppResult<()> {
    let contents = folder_contents(root)?;
    if contents.is_empty() {
        return Err(AppError::msg(
            "No mongodump output was found in this folder",
        ));
    }
    for (db, coll, data, meta) in contents {
        let Some((to_db, to_coll)) = r.target(&db, &coll) else {
            continue;
        };
        r.report.check()?;
        let metadata = match &meta {
            Some(p) => read_metadata(p, r.report)?,
            None => None,
        };
        r.begin(&to_db, &to_coll, metadata.as_ref()).await?;
        let mut restored = 0;
        if let Some(data) = data {
            let mut input = open_input(&data, r.report)?;
            let mut batch = Vec::new();
            let mut bytes = 0;
            while let Some(Some(doc)) = read_document(&mut input)? {
                bytes += doc.len();
                batch.push(
                    RawDocumentBuf::from_bytes(doc).map_err(|e| AppError::msg(e.to_string()))?,
                );
                if batch.len() >= BATCH_DOCS || bytes >= BATCH_BYTES {
                    restored += r.insert(&to_db, &to_coll, &mut batch).await?;
                    bytes = 0;
                    r.report.check()?;
                }
            }
            restored += r.insert(&to_db, &to_coll, &mut batch).await?;
        }
        r.end(&to_db, &to_coll, metadata.as_ref(), restored).await?;
    }
    Ok(())
}

async fn restore_archive(path: &Path, r: &mut Restorer<'_>) -> AppResult<()> {
    let mut input = open_input(path, r.report)?;
    let mut magic = [0u8; 4];
    input
        .read_exact(&mut magic)
        .map_err(|_| AppError::msg("This file isn't a mongodump archive"))?;
    if magic != MAGIC {
        return Err(AppError::msg("This file isn't a mongodump archive"));
    }
    let damaged = || AppError::msg("The archive is damaged (its prelude is incomplete)");
    // The header, then each namespace's metadata, then a terminator
    read_document(&mut input)?.flatten().ok_or_else(damaged)?;
    let mut prelude: Vec<(String, String, Option<Document>)> = Vec::new();
    loop {
        match read_document(&mut input)?.ok_or_else(damaged)? {
            None => break,
            Some(bytes) => {
                let d = Document::from_reader(&mut bytes.as_slice())
                    .map_err(|e| AppError::msg(e.to_string()))?;
                prelude.push((
                    d.get_str("db").unwrap_or_default().to_string(),
                    d.get_str("collection").unwrap_or_default().to_string(),
                    d.get_str("metadata").ok().and_then(parse_metadata),
                ));
            }
        }
    }
    let metadata_of = |db: &str, coll: &str| {
        prelude
            .iter()
            .find(|(d, c, _)| d == db && c == coll)
            .and_then(|(_, _, m)| m.clone())
    };

    // Blocks of different collections can interleave (mongodump writes several at once)
    let mut begun: HashSet<(String, String)> = HashSet::new();
    let mut restored: HashMap<(String, String), u64> = HashMap::new();
    while let Some(header) = read_document(&mut input)? {
        let header =
            header.ok_or_else(|| AppError::msg("The archive is damaged (an empty block)"))?;
        let h = Document::from_reader(&mut header.as_slice())
            .map_err(|e| AppError::msg(e.to_string()))?;
        let db = h.get_str("db").unwrap_or_default().to_string();
        let coll = h.get_str("collection").unwrap_or_default().to_string();
        let eof = h.get_bool("EOF").unwrap_or(false);
        let target = r.target(&db, &coll);
        let metadata = metadata_of(&db, &coll);
        if let Some((to_db, to_coll)) = &target
            && begun.insert((db.clone(), coll.clone()))
        {
            r.begin(to_db, to_coll, metadata.as_ref()).await?;
        }
        let mut batch = Vec::new();
        let mut bytes = 0;
        loop {
            let Some(doc) = read_document(&mut input)? else {
                return Err(AppError::msg("The archive ends in the middle of a block"));
            };
            let Some(doc) = doc else { break };
            let Some((to_db, to_coll)) = &target else {
                continue;
            };
            bytes += doc.len();
            batch.push(RawDocumentBuf::from_bytes(doc).map_err(|e| AppError::msg(e.to_string()))?);
            if batch.len() >= BATCH_DOCS || bytes >= BATCH_BYTES {
                *restored.entry((db.clone(), coll.clone())).or_default() +=
                    r.insert(to_db, to_coll, &mut batch).await?;
                bytes = 0;
                r.report.check()?;
            }
        }
        if let Some((to_db, to_coll)) = &target {
            *restored.entry((db.clone(), coll.clone())).or_default() +=
                r.insert(to_db, to_coll, &mut batch).await?;
            if eof {
                let count = restored
                    .get(&(db.clone(), coll.clone()))
                    .copied()
                    .unwrap_or(0);
                r.end(to_db, to_coll, metadata.as_ref(), count).await?;
            }
        }
    }
    // Namespaces the prelude lists without any block still get created
    for (db, coll, metadata) in &prelude {
        if begun.contains(&(db.clone(), coll.clone())) {
            continue;
        }
        if let Some((to_db, to_coll)) = r.target(db, coll) {
            r.begin(&to_db, &to_coll, metadata.as_ref()).await?;
            r.end(&to_db, &to_coll, metadata.as_ref(), 0).await?;
        }
    }
    Ok(())
}

/// The collections an archive holds, from its prelude, for when mongorestore
/// isn't there to list them: `(db, collection, type)`.
pub fn archive_contents(path: &Path) -> AppResult<Vec<(String, String, String)>> {
    let file = std::fs::File::open(path)?;
    let mut head = [0u8; 2];
    let gzip = std::fs::File::open(path)?.read(&mut head)? == 2 && head == [0x1f, 0x8b];
    let mut input: Box<dyn Read> = if gzip {
        Box::new(flate2::read::MultiGzDecoder::new(std::io::BufReader::new(
            file,
        )))
    } else {
        Box::new(std::io::BufReader::new(file))
    };
    let mut magic = [0u8; 4];
    input.read_exact(&mut magic)?;
    if magic != MAGIC {
        return Err(AppError::msg("This file isn't a mongodump archive"));
    }
    let damaged = || AppError::msg("The archive is damaged (its prelude is incomplete)");
    read_document(&mut input)?.flatten().ok_or_else(damaged)?;
    let mut out = Vec::new();
    while let Some(bytes) = read_document(&mut input)?.ok_or_else(damaged)? {
        let d = Document::from_reader(&mut bytes.as_slice())
            .map_err(|e| AppError::msg(e.to_string()))?;
        out.push((
            d.get_str("db").unwrap_or_default().to_string(),
            d.get_str("collection").unwrap_or_default().to_string(),
            d.get_str("type").unwrap_or("collection").to_string(),
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_escape_and_unescape() {
        assert_eq!(escape_name("a/b:c%"), "a%2Fb%3Ac%25");
        assert_eq!(unescape_name("a%2Fb%3Ac%25"), "a/b:c%");
        assert_eq!(unescape_name("plain"), "plain");
        assert_eq!(unescape_name("50%"), "50%");
    }

    #[test]
    fn a_chosen_source_database_is_the_only_one_restored() {
        let t = |from, to, db| target_database(from, to, db);
        assert_eq!(
            t(Some("shop"), Some("shop"), "shop").as_deref(),
            Some("shop")
        );
        assert_eq!(
            t(Some("shop"), Some("copy"), "shop").as_deref(),
            Some("copy")
        );
        assert_eq!(t(Some("shop"), Some("copy"), "other"), None);
        assert_eq!(t(Some("shop"), None, "other"), None);
        assert_eq!(t(Some("shop"), None, "shop").as_deref(), Some("shop"));
        assert_eq!(t(None, Some("copy"), "any").as_deref(), Some("copy"));
        assert_eq!(t(None, None, "any").as_deref(), Some("any"));
    }

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("dbms-mongo-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn folders_list_escaped_collections_and_views() {
        let root = temp_dir();
        let db = root.join(escape_name("my:db"));
        std::fs::create_dir_all(&db).unwrap();
        std::fs::write(db.join("a%3Ab.bson"), b"").unwrap();
        std::fs::write(db.join("a%3Ab.metadata.json"), b"").unwrap();
        std::fs::write(db.join("v.metadata.json.gz"), b"").unwrap();
        let contents = folder_contents(&root).unwrap();
        let names: Vec<(&str, &str, bool, bool)> = contents
            .iter()
            .map(|(d, c, data, meta)| (d.as_str(), c.as_str(), data.is_some(), meta.is_some()))
            .collect();
        assert_eq!(
            names,
            [("my:db", "a:b", true, true), ("my:db", "v", false, true)]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_folder_dumps_remove_only_what_they_wrote() {
        let job = |path: &Path| MongoDumpJob {
            database: "shop".into(),
            path: path.display().to_string(),
            archive: false,
            gzip: false,
            exclude_collections: Vec::new(),
        };
        // A folder the run created goes entirely
        let root = temp_dir();
        let folder = DumpFolder::before(&job(&root.join("new"))).unwrap();
        std::fs::create_dir_all(root.join("new").join("shop")).unwrap();
        std::fs::write(root.join("new").join("shop").join("a.bson"), b"").unwrap();
        folder.discard();
        assert!(!root.exists());

        // In an existing database folder, the user's files stay
        let dir = root.join("shop");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.txt"), b"keep").unwrap();
        let folder = DumpFolder::before(&job(&root)).unwrap();
        std::fs::write(dir.join("a.bson"), b"").unwrap();
        std::fs::write(dir.join("a.metadata.json"), b"").unwrap();
        folder.discard();
        let left: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(left, ["notes.txt"]);

        // Archives are one file, which the caller removes
        let mut archive = job(&root);
        archive.archive = true;
        assert!(DumpFolder::before(&archive).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn dump_job(path: &Path) -> MongoDumpJob {
        MongoDumpJob {
            database: "shop".into(),
            path: path.display().to_string(),
            archive: false,
            gzip: false,
            exclude_collections: Vec::new(),
        }
    }

    /// A directory link to `target`; false where the platform won't make one
    /// (Windows without the symlink privilege falls back to a junction).
    fn dir_link(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
                || std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(link)
                    .arg(target)
                    .output()
                    .is_ok_and(|o| o.status.success())
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (target, link);
            false
        }
    }

    #[test]
    fn a_broken_link_is_never_taken_for_a_folder_the_run_created() {
        let root = temp_dir();
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("drive");
        std::fs::create_dir_all(&target).unwrap();
        let link = root.join("Backups");
        if !dir_link(&target, &link) {
            eprintln!("skipped: this platform or user can't create directory links");
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        // The link's target goes away, as a disconnected drive does
        std::fs::remove_dir_all(&target).unwrap();
        assert!(!link.exists());
        assert!(std::fs::symlink_metadata(&link).is_ok());

        let folder = DumpFolder::before(&dump_job(&link)).unwrap();
        assert_ne!(folder.created.as_deref(), Some(link.as_path()));
        assert_ne!(folder.created.as_deref(), Some(root.as_path()));
        folder.discard();
        assert!(
            std::fs::symlink_metadata(&link).is_ok(),
            "the link was removed"
        );

        // A working link: the run only creates what's inside it
        std::fs::create_dir_all(&target).unwrap();
        let folder = DumpFolder::before(&dump_job(&link)).unwrap();
        assert_eq!(folder.created, Some(link.join("shop")));
        std::fs::create_dir_all(link.join("shop")).unwrap();
        std::fs::write(link.join("shop").join("a.bson"), b"").unwrap();
        folder.discard();
        assert!(!target.join("shop").exists());
        assert!(target.exists() && std::fs::symlink_metadata(&link).is_ok());

        // Removing the link itself doesn't touch its target
        #[cfg(windows)]
        let _ = std::fs::remove_dir(&link);
        #[cfg(not(windows))]
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn paths_that_fail_to_read_are_not_taken_for_missing_ones() {
        // An invalid path errors rather than reporting NotFound, which Path::exists treats alike
        assert_eq!(outermost_missing(Path::new("bad\0name/shop")), None);

        // A file in the way of the path
        let root = temp_dir();
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("notes.txt");
        std::fs::write(&file, b"keep").unwrap();
        let folder = DumpFolder::before(&dump_job(&file)).unwrap();
        assert_ne!(folder.created.as_deref(), Some(file.as_path()));
        assert_ne!(folder.created.as_deref(), Some(root.as_path()));
        // Unix reports NotADirectory, which stops the walk at once
        #[cfg(unix)]
        assert_eq!(folder.created, None);
        folder.discard();
        assert_eq!(std::fs::read(&file).unwrap(), b"keep");

        // Missing folders under an existing one are still the run's own
        let fresh = root.join("a").join("b");
        assert_eq!(outermost_missing(&fresh), Some(root.join("a")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn documents_and_terminators() {
        let doc = bson_bytes(&doc! { "a": 1 }).unwrap();
        let mut stream = doc.clone();
        stream.extend_from_slice(&TERMINATOR);
        let mut input = stream.as_slice();
        assert_eq!(read_document(&mut input).unwrap(), Some(Some(doc)));
        assert_eq!(read_document(&mut input).unwrap(), Some(None));
        assert_eq!(read_document(&mut input).unwrap(), None);
        assert!(read_document(&mut [1u8, 0, 0].as_slice()).is_err());
    }

    #[test]
    fn metadata_keeps_index_key_order() {
        let json = r#"{"indexes":[{"v":{"$numberInt":"2"},"key":{"b":{"$numberInt":"1"},"a":{"$numberInt":"-1"}},"name":"b_1_a_-1"}]}"#;
        let meta = parse_metadata(json).unwrap();
        let index = meta.get_array("indexes").unwrap()[0].as_document().unwrap();
        let keys: Vec<&String> = index.get_document("key").unwrap().keys().collect();
        assert_eq!(keys, ["b", "a"]);
    }
}
