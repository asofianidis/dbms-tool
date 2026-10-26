//! MongoDB via the official driver. Documents cross the IPC boundary as
//! Extended JSON, typed precisely enough that editing a document and saving it
//! back never changes a field's BSON type.

use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use mongodb::Client;
use mongodb::bson::{Bson, Document, doc};
use mongodb::options::{
    ClientOptions, Collation, Credential, Hint, ReadConcern, ReadPreference, SelectionCriteria,
    Tls, TlsOptions,
};
use mongodb::results::CollectionType;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::config::{ConnectionConfig, SslMode};
use crate::error::{AppError, AppResult};
use crate::model::*;

pub fn describe_error(e: &mongodb::error::Error) -> String {
    use mongodb::error::ErrorKind;
    match e.kind.as_ref() {
        ErrorKind::Command(c) => format!("{} ({}): {}", c.code_name, c.code, c.message),
        ErrorKind::Write(mongodb::error::WriteFailure::WriteError(w)) => {
            format!("Write error {}: {}", w.code, w.message)
        }
        ErrorKind::ServerSelection { message, .. } => {
            format!(
                "Could not reach the server: {}",
                server_selection_cause(message)
            )
        }
        _ => e.to_string(),
    }
}

/// The driver's server-selection message dumps the whole topology; keep the first server's cause.
fn server_selection_cause(message: &str) -> &str {
    message
        .split("Error: ")
        .nth(1)
        .map(|rest| rest.split(", labels:").next().unwrap_or(rest))
        .map(|rest| {
            rest.trim_start_matches("Kind: ")
                .trim_start_matches("I/O error: ")
        })
        .map(|rest| {
            rest.split(" (os error")
                .next()
                .unwrap_or(rest)
                .trim_end_matches('.')
        })
        .unwrap_or("no server responded")
}

/// The host field as a seed list: `a,b:27018` → `a:27017,b:27018`. A replica
/// set or a group of mongos routers is entered as several comma-separated hosts.
pub fn host_list(cfg: &ConnectionConfig) -> String {
    let port = if cfg.port == 0 { 27017 } else { cfg.port };
    let hosts: Vec<String> = cfg
        .host
        .split(',')
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .map(|h| {
            let has_port = if h.starts_with('[') {
                h.contains("]:")
            } else {
                h.matches(':').count() == 1
            };
            if has_port {
                h.to_string()
            } else if h.contains(':') && !h.starts_with('[') {
                format!("[{h}]:{port}")
            } else {
                format!("{h}:{port}")
            }
        })
        .collect();
    if hosts.is_empty() {
        format!("localhost:{port}")
    } else {
        hosts.join(",")
    }
}

fn read_preference(mode: &str) -> AppResult<Option<ReadPreference>> {
    Ok(Some(match mode.trim() {
        "" => return Ok(None),
        "primary" => ReadPreference::Primary,
        "primaryPreferred" => ReadPreference::PrimaryPreferred { options: None },
        "secondary" => ReadPreference::Secondary { options: None },
        "secondaryPreferred" => ReadPreference::SecondaryPreferred { options: None },
        "nearest" => ReadPreference::Nearest { options: None },
        other => {
            return Err(AppError::msg(format!("Unknown read preference '{other}'")));
        }
    }))
}

/// Pooled sockets idle longer than this are closed instead of reused.
const MAX_IDLE: Duration = Duration::from_secs(60);

pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<Client> {
    // The driver's TLS library (rustls) always checks the host name, and can
    // only check the one it connects to
    if cfg.ssl == SslMode::VerifyCa {
        return Err(AppError::Unsupported(
            "MongoDB connections can't verify the certificate without its host name; use Verify full"
                .into(),
        ));
    }
    if cfg.ssl.verifies() && cfg.tunneled.is_some() {
        return Err(AppError::Unsupported(
            "MongoDB can't verify the server certificate through an SSH tunnel (it would be checked              against 127.0.0.1); use Require instead"
                .into(),
        ));
    }
    let client_cert = super::tls::combined_pem_cert(cfg)?;
    let uri = cfg.uri.trim();
    let mut opts = if uri.is_empty() {
        let mut opts = ClientOptions::parse(format!("mongodb://{}/", host_list(cfg))).await?;
        if !cfg.replica_set.trim().is_empty() {
            opts.repl_set_name = Some(cfg.replica_set.trim().to_string());
        }
        if !cfg.user.is_empty() {
            opts.credential = Some(
                Credential::builder()
                    .username(cfg.user.clone())
                    .password(password.map(str::to_string))
                    .source(
                        (!cfg.auth_source.is_empty())
                            .then(|| cfg.auth_source.clone())
                            .or_else(|| Some("admin".into())),
                    )
                    .build(),
            );
        }
        opts.tls = cfg
            .ssl
            .required()
            .then(|| Tls::Enabled(TlsOptions::default()));
        // Through a tunnel, replica set discovery would find members by their
        // own (unreachable) names, so talk to the one the tunnel reaches
        if cfg.tunneled.is_some() {
            opts.direct_connection = Some(true);
            opts.repl_set_name = None;
        }
        opts
    } else {
        let mut opts = ClientOptions::parse(super::mongo_srv::expand(uri).await?).await?;
        // A password typed into the dialog fills in a URI that only names the user
        if let (Some(cred), Some(p)) = (opts.credential.as_mut(), password)
            && cred.password.is_none()
            && !p.is_empty()
        {
            cred.password = Some(p.to_string());
        }
        // Prefer leaves TLS to the string (on for mongodb+srv); the others override it
        match cfg.ssl {
            SslMode::Disable => opts.tls = Some(Tls::Disabled),
            ssl if ssl.required() && !matches!(opts.tls, Some(Tls::Enabled(_))) => {
                opts.tls = Some(Tls::Enabled(TlsOptions::default()))
            }
            _ => {}
        }
        opts
    };
    if opts.default_database.is_none() {
        // The host form leaves `admin` in the credential when no auth database is set
        let auth_source = match uri {
            "" => Some(cfg.auth_source.as_str()),
            _ => opts.credential.as_ref().and_then(|c| c.source.as_deref()),
        };
        opts.default_database = fallback_database(&cfg.database, auth_source);
    }
    if let Some(Tls::Enabled(tls)) = opts.tls.as_mut() {
        if cfg.ssl.verifies() {
            tls.allow_invalid_certificates = Some(false);
        } else if cfg.trust_server_certificate {
            tls.allow_invalid_certificates = Some(true);
        }
        // Replaces the built-in roots rather than adding to them
        if let Some(ca) = cfg.root_cert() {
            super::tls::read_file(ca, "CA certificate")?;
            tls.ca_file_path = Some(ca.into());
        }
        if let Some(cert) = client_cert {
            super::tls::read_file(cert, "client certificate")?;
            tls.cert_key_file_path = Some(cert.into());
        }
    }
    if let Some(pref) = read_preference(&cfg.read_preference)? {
        opts.selection_criteria = Some(pref.into());
    }
    opts.app_name = Some("dbms-tool".into());
    opts.server_selection_timeout = Some(crate::limits::connect_timeout());
    opts.connect_timeout = Some(crate::limits::connect_timeout());
    // A ping checks one pooled socket; the rest may have gone half-open while
    // idle too, so they're closed rather than reused (unless the URI says otherwise)
    if opts.max_idle_time.is_none() {
        opts.max_idle_time = Some(MAX_IDLE);
    }
    let client = Client::with_options(opts)?;
    client
        .database("admin")
        .run_command(doc! { "ping": 1 })
        .await?;
    Ok(client)
}

/// Whether the server answers a ping within the connect timeout. Requests on a
/// half-open socket never fail on their own, so this bounds the wait.
pub async fn is_alive(client: &Client) -> bool {
    let admin = client.database("admin");
    let ping = admin.run_command(doc! { "ping": 1 });
    matches!(
        tokio::time::timeout(crate::limits::connect_timeout(), ping).await,
        Ok(Ok(_))
    )
}

/// The database to open when the connection string names none: the one in the
/// connection settings, else the auth database. `list_databases` falls back to
/// it for users without the listDatabases privilege.
fn fallback_database(database: &str, auth_source: Option<&str>) -> Option<String> {
    [Some(database), auth_source]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|db| !db.is_empty())
        .map(str::to_string)
}

/// BSON → Extended JSON. Relaxed where lossless; Int64, Decimal128 and whole-number
/// doubles keep their type wrappers so they survive an edit round trip.
pub fn to_json(value: Bson) -> Value {
    match value {
        Bson::Document(d) => Value::Object(doc_to_map(d)),
        Bson::Array(items) => Value::Array(items.into_iter().map(to_json).collect()),
        Bson::Int32(n) => json!(n),
        Bson::Int64(n) => json!({ "$numberLong": n.to_string() }),
        Bson::Double(f) if f.is_finite() && f.fract() != 0.0 => json!(f),
        Bson::Double(f) => {
            let text = if f.is_nan() {
                "NaN".to_string()
            } else if f.is_infinite() {
                if f > 0.0 { "Infinity" } else { "-Infinity" }.to_string()
            } else {
                format!("{f:.1}")
            };
            json!({ "$numberDouble": text })
        }
        Bson::String(s) => Value::String(s),
        Bson::Boolean(b) => Value::Bool(b),
        Bson::Null => Value::Null,
        other => other.into_relaxed_extjson(),
    }
}

fn doc_to_map(doc: Document) -> Map<String, Value> {
    doc.into_iter().map(|(k, v)| (k, to_json(v))).collect()
}

fn to_bson(value: Value) -> AppResult<Bson> {
    Bson::try_from(value).map_err(|e| AppError::msg(format!("Invalid Extended JSON: {e}")))
}

fn to_doc(value: Option<Value>) -> AppResult<Document> {
    match value {
        None | Some(Value::Null) => Ok(Document::new()),
        Some(v) => match to_bson(v)? {
            Bson::Document(d) => Ok(d),
            other => Err(AppError::msg(format!(
                "Expected a document, got {:?}",
                other.element_type()
            ))),
        },
    }
}

fn to_docs(values: Vec<Value>) -> AppResult<Vec<Document>> {
    values.into_iter().map(|v| to_doc(Some(v))).collect()
}

/// Cursor modifiers from the shell: `.hint()`, `.maxTimeMS()`, `.collation()`, …
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorOptions {
    /// Index keys or an index name
    hint: Option<Value>,
    #[serde(rename = "maxTimeMS")]
    max_time_ms: Option<u64>,
    collation: Option<Value>,
    allow_disk_use: Option<bool>,
    comment: Option<Value>,
    /// `primary`, `secondaryPreferred`, …
    read_preference: Option<String>,
    /// `local`, `majority`, …
    read_concern: Option<String>,
}

/// `CursorOptions` in the driver's types, applied with `with_options!`.
#[derive(Clone, Default)]
struct DriverOptions {
    hint: Option<Hint>,
    max_time: Option<Duration>,
    collation: Option<Collation>,
    allow_disk_use: Option<bool>,
    comment: Option<Bson>,
    selection_criteria: Option<SelectionCriteria>,
    read_concern: Option<ReadConcern>,
}

impl CursorOptions {
    fn is_empty(&self) -> bool {
        self.hint.is_none()
            && self.max_time_ms.is_none()
            && self.collation.is_none()
            && self.allow_disk_use.is_none()
            && self.comment.is_none()
            && self.read_preference.is_none()
            && self.read_concern.is_none()
    }

    fn driver(self) -> AppResult<DriverOptions> {
        let hint = match self.hint {
            None | Some(Value::Null) => None,
            Some(Value::String(name)) => Some(Hint::Name(name)),
            Some(keys) => Some(Hint::Keys(to_doc(Some(keys))?)),
        };
        let collation = match self.collation {
            None | Some(Value::Null) => None,
            Some(c) => Some(
                mongodb::bson::from_document::<Collation>(to_doc(Some(c))?)
                    .map_err(|e| AppError::msg(format!("Invalid collation: {e}")))?,
            ),
        };
        let selection_criteria = match self.read_preference.as_deref() {
            None => None,
            Some(mode) => Some(SelectionCriteria::ReadPreference(match mode {
                "primary" => ReadPreference::Primary,
                "primaryPreferred" => ReadPreference::PrimaryPreferred { options: None },
                "secondary" => ReadPreference::Secondary { options: None },
                "secondaryPreferred" => ReadPreference::SecondaryPreferred { options: None },
                "nearest" => ReadPreference::Nearest { options: None },
                other => {
                    return Err(AppError::msg(format!(
                        "Unknown read preference \"{other}\"; use primary, primaryPreferred, \
                         secondary, secondaryPreferred or nearest"
                    )));
                }
            })),
        };
        Ok(DriverOptions {
            hint,
            max_time: self.max_time_ms.map(Duration::from_millis),
            collation,
            allow_disk_use: self.allow_disk_use,
            comment: self.comment.map(to_bson).transpose()?,
            selection_criteria,
            read_concern: self.read_concern.map(ReadConcern::custom),
        })
    }
}

/// Calls the builder setter for each option that's set.
macro_rules! with_options {
    ($action:expr, $options:expr; $($field:ident),*) => {{
        let mut action = $action;
        let options: &DriverOptions = &$options;
        $(if let Some(v) = options.$field.clone() {
            action = action.$field(v);
        })*
        action
    }};
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MongoRequest {
    Find {
        database: String,
        collection: String,
        filter: Option<Value>,
        projection: Option<Value>,
        sort: Option<Value>,
        skip: Option<u64>,
        limit: Option<i64>,
        /// Also count all matching documents
        #[serde(default)]
        count: bool,
        #[serde(default)]
        options: CursorOptions,
    },
    Aggregate {
        database: String,
        collection: String,
        pipeline: Vec<Value>,
        #[serde(default)]
        options: CursorOptions,
    },
    Count {
        database: String,
        collection: String,
        filter: Option<Value>,
        #[serde(default)]
        options: CursorOptions,
    },
    Distinct {
        database: String,
        collection: String,
        field: String,
        filter: Option<Value>,
    },
    InsertOne {
        database: String,
        collection: String,
        document: Value,
    },
    InsertMany {
        database: String,
        collection: String,
        documents: Vec<Value>,
    },
    UpdateOne {
        database: String,
        collection: String,
        filter: Value,
        update: Value,
        #[serde(default)]
        upsert: bool,
    },
    UpdateMany {
        database: String,
        collection: String,
        filter: Value,
        update: Value,
        #[serde(default)]
        upsert: bool,
    },
    ReplaceOne {
        database: String,
        collection: String,
        filter: Value,
        replacement: Value,
        #[serde(default)]
        upsert: bool,
    },
    DeleteOne {
        database: String,
        collection: String,
        filter: Value,
    },
    DeleteMany {
        database: String,
        collection: String,
        filter: Value,
    },
    ListIndexes {
        database: String,
        collection: String,
    },
    CreateIndex {
        database: String,
        collection: String,
        keys: Value,
        options: Option<Value>,
    },
    DropIndex {
        database: String,
        collection: String,
        name: String,
    },
    CreateCollection {
        database: String,
        collection: String,
    },
    DropCollection {
        database: String,
        collection: String,
    },
    DropDatabase {
        database: String,
    },
    RunCommand {
        database: String,
        command: Value,
    },
}

impl MongoRequest {
    /// Whether the user gave the operation a comment of their own
    fn has_comment(&self) -> bool {
        match self {
            MongoRequest::Find { options, .. }
            | MongoRequest::Aggregate { options, .. }
            | MongoRequest::Count { options, .. } => options.comment.is_some(),
            MongoRequest::RunCommand { command, .. } => command.get("comment").is_some(),
            _ => false,
        }
    }

    pub fn is_write(&self) -> bool {
        !matches!(
            self,
            MongoRequest::Find { .. }
                | MongoRequest::Count { .. }
                | MongoRequest::Distinct { .. }
                | MongoRequest::ListIndexes { .. }
        ) && !matches!(self, MongoRequest::Aggregate { pipeline, .. } if !pipeline_writes(pipeline))
            && !matches!(self, MongoRequest::RunCommand { command, .. } if is_read_command(command))
    }
}

fn pipeline_writes(pipeline: &[Value]) -> bool {
    pipeline.iter().any(|stage| {
        stage
            .as_object()
            .is_some_and(|o| o.contains_key("$out") || o.contains_key("$merge"))
    })
}

fn is_read_command(command: &Value) -> bool {
    const READS: &[&str] = &[
        "ping",
        "buildInfo",
        "buildinfo",
        "serverStatus",
        "dbStats",
        "dbstats",
        "collStats",
        "collstats",
        "listCollections",
        "listIndexes",
        "listDatabases",
        "hello",
        "isMaster",
        "ismaster",
        "connectionStatus",
        "hostInfo",
        "explain",
        "count",
        "distinct",
        "find",
        "getParameter",
        "currentOp",
        "top",
        "validate",
        "replSetGetStatus",
        "replSetGetConfig",
        "listShards",
        "balancerStatus",
        "getLog",
        "usersInfo",
        "rolesInfo",
    ];
    let Some((key, value)) = command.as_object().and_then(|o| o.iter().next()) else {
        return false;
    };
    // `{ validate: c, repair: true }` rewrites the collection
    if key == "validate" && command.get("repair").is_some_and(truthy) {
        return false;
    }
    // `{ profile: -1 }` reads the profiler level; any other level changes it
    READS.contains(&key.as_str()) || (key == "profile" && value.as_i64() == Some(-1))
}

/// Whether a command option counts as set, the way the server reads it.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoOutput {
    /// documents | value
    pub kind: &'static str,
    pub documents: Vec<Value>,
    pub value: Option<Value>,
    /// Matching documents, when counted
    pub total: Option<u64>,
    pub truncated: bool,
    pub elapsed_ms: u64,
    pub cancelled: bool,
}

impl MongoOutput {
    fn documents(documents: Vec<Value>, truncated: bool) -> Self {
        Self {
            kind: "documents",
            documents,
            value: None,
            total: None,
            truncated,
            elapsed_ms: 0,
            cancelled: false,
        }
    }

    fn value(value: Value) -> Self {
        Self {
            kind: "value",
            documents: Vec::new(),
            value: Some(value),
            total: None,
            truncated: false,
            elapsed_ms: 0,
            cancelled: false,
        }
    }
}

async fn drain(mut cursor: mongodb::Cursor<Document>, max: usize) -> AppResult<(Vec<Value>, bool)> {
    let mut docs = Vec::new();
    while let Some(doc) = cursor.try_next().await? {
        if docs.len() >= max {
            return Ok((docs, true));
        }
        docs.push(Value::Object(doc_to_map(doc)));
    }
    Ok((docs, false))
}

fn index_name(keys: &Document) -> String {
    keys.iter()
        .map(|(k, v)| {
            let dir = match v {
                Bson::String(s) => s.clone(),
                Bson::Int32(n) => n.to_string(),
                Bson::Int64(n) => n.to_string(),
                Bson::Double(f) => (*f as i64).to_string(),
                other => other.to_string(),
            };
            format!("{k}_{dir}")
        })
        .collect::<Vec<_>>()
        .join("_")
}

pub async fn execute(
    client: &Client,
    request: MongoRequest,
    opts: &ExecOptions,
    cancel: &CancelSignal,
) -> AppResult<MongoOutput> {
    let started = Instant::now();
    // Dropping the future leaves the server running the operation, so it's
    // tagged with a comment a cancel can find it by. A comment of the user's
    // own may not be unique, so those operations aren't tagged or killed.
    let tag = (!request.has_comment())
        .then(|| Bson::String(format!("dbms-tool {}", uuid::Uuid::new_v4())));
    let max = opts.max_rows.max(1);
    let result = tokio::select! {
        biased;
        _ = cancel.wait() => None,
        r = run_tagged(client, request, max, tag.as_ref()) => Some(r),
    };
    let mut out = match result {
        Some(r) => r?,
        None => {
            if let Some(tag) = &tag {
                kill_tagged(client, tag).await;
            }
            let mut out = MongoOutput::documents(Vec::new(), false);
            out.cancelled = true;
            out
        }
    };
    out.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(out)
}

/// `run`, again without the tag if the server refuses the `comment` field
/// (some MongoDB-compatible services do). The refusal comes before any work.
async fn run_tagged(
    client: &Client,
    request: MongoRequest,
    max: usize,
    tag: Option<&Bson>,
) -> AppResult<MongoOutput> {
    let Some(tag) = tag else {
        return run(client, request, max, None).await;
    };
    let untagged = request.clone();
    match run(client, request, max, Some(tag)).await {
        Err(e) if comment_refused(&e.to_string()) => run(client, untagged, max, None).await,
        r => r,
    }
}

fn comment_refused(error: &str) -> bool {
    let error = error.to_lowercase();
    error.contains("comment")
        && error.contains("field")
        && ["unknown", "unrecognized", "not supported", "unsupported"]
            .iter()
            .any(|w| error.contains(w))
}

/// Best effort: kills the server's operations tagged with `tag`, giving up
/// quietly after a few seconds or on any error (no privilege, old server).
async fn kill_tagged(client: &Client, tag: &Bson) {
    let admin = client.database("admin");
    let kill = async {
        // `$ownOps` lists the user's own operations without the inprog privilege
        let reply = admin
            .run_command(doc! {
                "currentOp": 1,
                "$ownOps": true,
                "$or": [
                    { "command.comment": tag.clone() },
                    { "comment": tag.clone() },
                    { "cursor.originatingCommand.comment": tag.clone() },
                    { "originatingCommand.comment": tag.clone() },
                ],
            })
            .await?;
        for op in reply
            .get_array("inprog")
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            // A number, or `shard:number` through mongos
            if let Some(opid) = op.as_document().and_then(|o| o.get("opid")) {
                let _ = admin
                    .run_command(doc! { "killOp": 1, "op": opid.clone() })
                    .await;
            }
        }
        Ok::<_, mongodb::error::Error>(())
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), kill).await;
}

/// Adds the cancel tag to an action that takes a comment.
macro_rules! tagged {
    ($action:expr, $tag:expr) => {{
        let action = $action;
        match $tag {
            Some(tag) => action.comment(tag.clone()),
            None => action,
        }
    }};
}

async fn run(
    client: &Client,
    request: MongoRequest,
    max: usize,
    tag: Option<&Bson>,
) -> AppResult<MongoOutput> {
    use MongoRequest::*;
    let coll = |db: &str, name: &str| client.database(db).collection::<Document>(name);
    // Cursor options carry the tag as their comment (`has_comment` is false
    // whenever there's a tag, so it never replaces the user's)
    let driver = |options: CursorOptions| -> AppResult<DriverOptions> {
        let mut options = options.driver()?;
        if options.comment.is_none() {
            options.comment = tag.cloned();
        }
        Ok(options)
    };
    Ok(match request {
        Find {
            database,
            collection,
            filter,
            projection,
            sort,
            skip,
            limit,
            count,
            options,
        } => {
            let c = coll(&database, &collection);
            let filter = to_doc(filter)?;
            let options = driver(options)?;
            let mut find = with_options!(c.find(filter.clone()), options;
                hint, max_time, collation, allow_disk_use, comment, selection_criteria, read_concern);
            let projection = to_doc(projection)?;
            if !projection.is_empty() {
                find = find.projection(projection);
            }
            let sort = to_doc(sort)?;
            if !sort.is_empty() {
                find = find.sort(sort);
            }
            if let Some(skip) = skip.filter(|s| *s > 0) {
                find = find.skip(skip);
            }
            let cap = match limit.filter(|l| *l != 0) {
                Some(l) => {
                    find = find.limit(l.abs());
                    (l.unsigned_abs() as usize).min(max)
                }
                None => max,
            };
            let (documents, truncated) = drain(find.await?, cap).await?;
            let mut out = MongoOutput::documents(documents, truncated);
            if count {
                out.total = Some(if filter.is_empty() {
                    c.estimated_document_count().await?
                } else {
                    with_options!(c.count_documents(filter), options;
                        hint, max_time, collation, comment, selection_criteria, read_concern)
                    .await?
                });
            }
            out
        }
        Aggregate {
            database,
            collection,
            pipeline,
            options,
        } => {
            let pipeline = to_docs(pipeline)?;
            let options = driver(options)?;
            let cursor = if collection.is_empty() {
                let db = client.database(&database);
                with_options!(db.aggregate(pipeline), options;
                    hint, max_time, collation, allow_disk_use, comment, selection_criteria, read_concern)
                .await?
            } else {
                let c = coll(&database, &collection);
                with_options!(c.aggregate(pipeline), options;
                    hint, max_time, collation, allow_disk_use, comment, selection_criteria, read_concern)
                .await?
            };
            let (documents, truncated) = drain(cursor, max).await?;
            MongoOutput::documents(documents, truncated)
        }
        Count {
            database,
            collection,
            filter,
            options,
        } => {
            let c = coll(&database, &collection);
            let filter = to_doc(filter)?;
            // estimatedDocumentCount reads metadata, so it can't honour a hint or collation
            let n = if filter.is_empty() && options.is_empty() {
                c.estimated_document_count().await?
            } else {
                let options = driver(options)?;
                with_options!(c.count_documents(filter), options;
                    hint, max_time, collation, comment, selection_criteria, read_concern)
                .await?
            };
            MongoOutput::value(json!(n))
        }
        Distinct {
            database,
            collection,
            field,
            filter,
        } => {
            let c = coll(&database, &collection);
            let values = tagged!(c.distinct(field, to_doc(filter)?), tag).await?;
            MongoOutput::value(Value::Array(values.into_iter().map(to_json).collect()))
        }
        InsertOne {
            database,
            collection,
            document,
        } => {
            let c = coll(&database, &collection);
            let r = tagged!(c.insert_one(to_doc(Some(document))?), tag).await?;
            MongoOutput::value(
                json!({ "acknowledged": true, "insertedId": to_json(r.inserted_id) }),
            )
        }
        InsertMany {
            database,
            collection,
            documents,
        } => {
            let c = coll(&database, &collection);
            let r = tagged!(c.insert_many(to_docs(documents)?), tag).await?;
            let mut ids: Vec<(usize, Bson)> = r.inserted_ids.into_iter().collect();
            ids.sort_by_key(|(i, _)| *i);
            MongoOutput::value(json!({
                "acknowledged": true,
                "insertedCount": ids.len(),
                "insertedIds": ids.into_iter().map(|(_, id)| to_json(id)).collect::<Vec<_>>(),
            }))
        }
        UpdateOne {
            database,
            collection,
            filter,
            update,
            upsert,
        } => {
            let c = coll(&database, &collection);
            let r = tagged!(
                c.update_one(to_doc(Some(filter))?, update_modifications(update)?),
                tag
            )
            .upsert(upsert)
            .await?;
            update_value(r)
        }
        UpdateMany {
            database,
            collection,
            filter,
            update,
            upsert,
        } => {
            let c = coll(&database, &collection);
            let r = tagged!(
                c.update_many(to_doc(Some(filter))?, update_modifications(update)?),
                tag
            )
            .upsert(upsert)
            .await?;
            update_value(r)
        }
        ReplaceOne {
            database,
            collection,
            filter,
            replacement,
            upsert,
        } => {
            let c = coll(&database, &collection);
            let r = tagged!(
                c.replace_one(to_doc(Some(filter))?, to_doc(Some(replacement))?),
                tag
            )
            .upsert(upsert)
            .await?;
            update_value(r)
        }
        DeleteOne {
            database,
            collection,
            filter,
        } => {
            let c = coll(&database, &collection);
            let r = tagged!(c.delete_one(to_doc(Some(filter))?), tag).await?;
            MongoOutput::value(json!({ "acknowledged": true, "deletedCount": r.deleted_count }))
        }
        DeleteMany {
            database,
            collection,
            filter,
        } => {
            let c = coll(&database, &collection);
            let r = tagged!(c.delete_many(to_doc(Some(filter))?), tag).await?;
            MongoOutput::value(json!({ "acknowledged": true, "deletedCount": r.deleted_count }))
        }
        ListIndexes {
            database,
            collection,
        } => {
            let reply = client
                .database(&database)
                .run_command(doc! { "listIndexes": &collection })
                .await?;
            let batch = reply
                .get_document("cursor")
                .ok()
                .and_then(|c| c.get_array("firstBatch").ok())
                .cloned()
                .unwrap_or_default();
            let documents = batch.into_iter().map(to_json).collect();
            MongoOutput::documents(documents, false)
        }
        CreateIndex {
            database,
            collection,
            keys,
            options,
        } => {
            let keys = to_doc(Some(keys))?;
            let mut index = to_doc(options)?;
            if !index.contains_key("name") {
                index.insert("name", index_name(&keys));
            }
            index.insert("key", keys);
            let mut command = doc! { "createIndexes": &collection, "indexes": [index] };
            if let Some(tag) = tag {
                command.insert("comment", tag.clone());
            }
            let reply = client.database(&database).run_command(command).await?;
            MongoOutput::value(to_json(Bson::Document(reply)))
        }
        DropIndex {
            database,
            collection,
            name,
        } => {
            let reply = client
                .database(&database)
                .run_command(doc! { "dropIndexes": &collection, "index": &name })
                .await?;
            MongoOutput::value(to_json(Bson::Document(reply)))
        }
        CreateCollection {
            database,
            collection,
        } => {
            client
                .database(&database)
                .create_collection(&collection)
                .await?;
            MongoOutput::value(json!({ "ok": 1 }))
        }
        DropCollection {
            database,
            collection,
        } => {
            coll(&database, &collection).drop().await?;
            MongoOutput::value(json!({ "ok": 1 }))
        }
        DropDatabase { database } => {
            client.database(&database).drop().await?;
            MongoOutput::value(json!({ "ok": 1 }))
        }
        RunCommand { database, command } => {
            let mut command = to_doc(Some(command))?;
            if let Some(tag) = tag {
                command.insert("comment", tag.clone());
            }
            let reply = client.database(&database).run_command(command).await?;
            MongoOutput::value(to_json(Bson::Document(reply)))
        }
    })
}

fn update_modifications(update: Value) -> AppResult<mongodb::options::UpdateModifications> {
    use mongodb::options::UpdateModifications;
    Ok(match update {
        Value::Array(stages) => UpdateModifications::Pipeline(to_docs(stages)?),
        other => UpdateModifications::Document(to_doc(Some(other))?),
    })
}

fn update_value(r: mongodb::results::UpdateResult) -> MongoOutput {
    MongoOutput::value(json!({
        "acknowledged": true,
        "matchedCount": r.matched_count,
        "modifiedCount": r.modified_count,
        "upsertedId": r.upserted_id.map(to_json),
    }))
}

pub async fn server_info(client: &Client) -> AppResult<ServerInfo> {
    let admin = client.database("admin");
    let build = admin.run_command(doc! { "buildInfo": 1 }).await?;
    let version = build.get_str("version").unwrap_or("").to_string();
    let status = admin.run_command(doc! { "connectionStatus": 1 }).await.ok();
    let user = status
        .as_ref()
        .and_then(|s| s.get_document("authInfo").ok())
        .and_then(|a| a.get_array("authenticatedUsers").ok())
        .and_then(|users| users.first())
        .and_then(|u| u.as_document())
        .and_then(|u| u.get_str("user").ok())
        .unwrap_or("")
        .to_string();
    let hello = admin.run_command(doc! { "hello": 1 }).await.ok();
    let topology = match &hello {
        Some(h) if h.get_str("msg").ok() == Some("isdbgrid") => " (sharded)",
        Some(h) if h.contains_key("setName") => " (replica set)",
        _ => "",
    };
    let modules = build
        .get_array("modules")
        .map(|m| {
            m.iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    Ok(ServerInfo {
        product: format!("MongoDB {version}{topology}"),
        version: if modules.is_empty() {
            format!("MongoDB {version}")
        } else {
            format!("MongoDB {version} ({modules})")
        },
        current_database: client
            .default_database()
            .map(|d| d.name().to_string())
            .unwrap_or_default(),
        user,
        babelfish_version: None,
    })
}

pub async fn list_databases(client: &Client) -> AppResult<Vec<DatabaseInfo>> {
    let dbs = match client.list_databases().await {
        Ok(dbs) => dbs,
        // Users without listDatabases privilege can still use their auth database
        Err(e) => match client.default_database() {
            Some(db) => {
                return Ok(vec![DatabaseInfo {
                    name: db.name().to_string(),
                    is_system: false,
                    size_bytes: None,
                    keys: None,
                }]);
            }
            None => return Err(e.into()),
        },
    };
    Ok(dbs
        .into_iter()
        .map(|d| DatabaseInfo {
            is_system: matches!(d.name.as_str(), "admin" | "local" | "config"),
            size_bytes: Some(d.size_on_disk as i64),
            keys: None,
            name: d.name,
        })
        .collect())
}

pub async fn list_collections(client: &Client, database: &str) -> AppResult<Vec<DbObject>> {
    let db = client.database(database);
    let mut objects = match db.list_collections().await {
        Ok(cursor) => {
            let specs: Vec<_> = cursor.try_collect().await?;
            specs
                .into_iter()
                .map(|s| DbObject {
                    schema: None,
                    kind: match s.collection_type {
                        CollectionType::View => "view",
                        CollectionType::Timeseries => "timeseries",
                        _ => "collection",
                    }
                    .to_string(),
                    detail: s.options.view_on.clone(),
                    name: s.name,
                    comment: None,
                    row_estimate: None,
                })
                .collect::<Vec<_>>()
        }
        Err(_) => db
            .list_collection_names()
            .await?
            .into_iter()
            .map(|name| DbObject {
                schema: None,
                name,
                kind: "collection".into(),
                detail: None,
                comment: None,
                row_estimate: None,
            })
            .collect(),
    };
    objects.sort_by_key(|a| a.name.to_lowercase());
    Ok(objects)
}

/* ---------- Export ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    /// One JSON array (`mongoimport --jsonArray`)
    Json,
    /// One document per line (`mongoimport`'s default)
    Jsonl,
    Csv,
}

/// A whole find or pipeline result, streamed to a file instead of the grid.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub database: String,
    pub collection: String,
    pub filter: Option<Value>,
    pub projection: Option<Value>,
    pub sort: Option<Value>,
    /// Exports the pipeline's output instead of a find
    pub pipeline: Option<Vec<Value>>,
    pub format: ExportFormat,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub documents: u64,
    pub bytes: u64,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    /// CSV only: fields first seen after the header was written, left out of the file
    pub dropped_fields: Vec<String>,
}

/// Documents a CSV export reads before writing its header.
const CSV_SAMPLE: usize = 1000;

/// Turns documents into file bytes. Pure, so the formats can be tested without a server.
struct ExportWriter {
    format: ExportFormat,
    count: u64,
    columns: Vec<String>,
    header_written: bool,
    pending: Vec<Document>,
    dropped: std::collections::BTreeSet<String>,
}

impl ExportWriter {
    fn new(format: ExportFormat) -> Self {
        Self {
            format,
            count: 0,
            columns: Vec::new(),
            header_written: false,
            pending: Vec::new(),
            dropped: Default::default(),
        }
    }

    fn push(&mut self, doc: Document) -> Vec<u8> {
        self.count += 1;
        match self.format {
            ExportFormat::Json => {
                let sep = if self.count == 1 { "[\n" } else { ",\n" };
                format!("{sep}{}", Bson::Document(doc).into_relaxed_extjson()).into_bytes()
            }
            ExportFormat::Jsonl => {
                format!("{}\n", Bson::Document(doc).into_relaxed_extjson()).into_bytes()
            }
            ExportFormat::Csv if self.header_written => self.csv_row(&doc).into_bytes(),
            ExportFormat::Csv => {
                self.pending.push(doc);
                if self.pending.len() >= CSV_SAMPLE {
                    self.flush_csv()
                } else {
                    Vec::new()
                }
            }
        }
    }

    fn finish(&mut self) -> Vec<u8> {
        match self.format {
            ExportFormat::Json if self.count == 0 => b"[]\n".to_vec(),
            ExportFormat::Json => b"\n]\n".to_vec(),
            ExportFormat::Jsonl => Vec::new(),
            ExportFormat::Csv => self.flush_csv(),
        }
    }

    /// Writes the header (every field the sampled documents have) and the sampled rows.
    fn flush_csv(&mut self) -> Vec<u8> {
        if self.header_written {
            return Vec::new();
        }
        let pending = std::mem::take(&mut self.pending);
        for doc in &pending {
            for key in doc.keys() {
                if !self.columns.contains(key) {
                    self.columns.push(key.clone());
                }
            }
        }
        self.header_written = true;
        if self.columns.is_empty() {
            return Vec::new();
        }
        let header = self
            .columns
            .iter()
            .map(|c| csv_quote(c))
            .collect::<Vec<_>>()
            .join(",");
        let mut out = format!("{header}\r\n");
        for doc in &pending {
            out.push_str(&self.csv_row(doc));
        }
        out.into_bytes()
    }

    fn csv_row(&mut self, doc: &Document) -> String {
        for key in doc.keys() {
            if !self.columns.contains(key) {
                self.dropped.insert(key.clone());
            }
        }
        let cells = self
            .columns
            .iter()
            .map(|c| csv_quote(&doc.get(c).map(csv_cell).unwrap_or_default()))
            .collect::<Vec<_>>();
        format!("{}\r\n", cells.join(","))
    }
}

/// A field as spreadsheet text: plain scalars, Extended JSON for everything else.
fn csv_cell(value: &Bson) -> String {
    match value {
        Bson::Null | Bson::Undefined => String::new(),
        Bson::String(s) => s.clone(),
        Bson::Boolean(b) => b.to_string(),
        Bson::Int32(n) => n.to_string(),
        Bson::Int64(n) => n.to_string(),
        Bson::Double(f) => f.to_string(),
        Bson::Decimal128(d) => d.to_string(),
        Bson::ObjectId(id) => id.to_hex(),
        Bson::DateTime(d) => d
            .try_to_rfc3339_string()
            .unwrap_or_else(|_| d.timestamp_millis().to_string()),
        other => other.clone().into_relaxed_extjson().to_string(),
    }
}

fn csv_quote(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Streams the result to `path`, through a `.part` file that only replaces
/// `path` once every document is written.
pub async fn export(
    client: &Client,
    request: ExportRequest,
    path: &std::path::Path,
    cancel: &CancelSignal,
) -> AppResult<ExportSummary> {
    let started = Instant::now();
    let mut part = path.as_os_str().to_owned();
    part.push(".part");
    let part = std::path::PathBuf::from(part);
    match write_export(client, request, &part, cancel).await {
        Ok(Some(mut summary)) => {
            tokio::fs::rename(&part, path).await?;
            summary.elapsed_ms = started.elapsed().as_millis() as u64;
            Ok(summary)
        }
        Ok(None) => {
            let _ = tokio::fs::remove_file(&part).await;
            Ok(ExportSummary {
                cancelled: true,
                elapsed_ms: started.elapsed().as_millis() as u64,
                ..Default::default()
            })
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(e)
        }
    }
}

/// `None` when cancelled.
async fn write_export(
    client: &Client,
    request: ExportRequest,
    part: &std::path::Path,
    cancel: &CancelSignal,
) -> AppResult<Option<ExportSummary>> {
    use tokio::io::AsyncWriteExt;
    let c = client
        .database(&request.database)
        .collection::<Document>(&request.collection);
    let opened = async {
        if let Some(pipeline) = request.pipeline {
            if pipeline_writes(&pipeline) {
                return Err(AppError::msg(
                    "Remove the $out or $merge stage to export the pipeline's output",
                ));
            }
            return Ok(c.aggregate(to_docs(pipeline)?).await?);
        }
        let mut find = c.find(to_doc(request.filter)?);
        let projection = to_doc(request.projection)?;
        if !projection.is_empty() {
            find = find.projection(projection);
        }
        let sort = to_doc(request.sort)?;
        if !sort.is_empty() {
            find = find.sort(sort);
        }
        Ok(find.await?)
    };
    let mut cursor = tokio::select! {
        biased;
        _ = cancel.wait() => return Ok(None),
        c = opened => c?,
    };
    let mut file = tokio::io::BufWriter::new(tokio::fs::File::create(part).await?);
    let mut writer = ExportWriter::new(request.format);
    let mut bytes = 0u64;
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.wait() => return Ok(None),
            d = cursor.try_next() => d?,
        };
        let Some(doc) = next else { break };
        let chunk = writer.push(doc);
        bytes += chunk.len() as u64;
        file.write_all(&chunk).await?;
    }
    let tail = writer.finish();
    bytes += tail.len() as u64;
    file.write_all(&tail).await?;
    file.flush().await?;
    Ok(Some(ExportSummary {
        documents: writer.count,
        bytes,
        elapsed_ms: 0,
        cancelled: false,
        dropped_fields: writer.dropped.into_iter().collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson;

    #[test]
    fn default_database_falls_back_to_the_auth_database() {
        assert_eq!(
            fallback_database("sales", Some("admin")).as_deref(),
            Some("sales")
        );
        assert_eq!(fallback_database(" ", Some("app")).as_deref(), Some("app"));
        assert_eq!(fallback_database("", Some("")), None);
        assert_eq!(fallback_database("", None), None);
    }

    #[test]
    fn only_untagged_requests_get_the_cancel_tag() {
        let request = |v: Value| serde_json::from_value::<MongoRequest>(v).unwrap();
        let find = request(json!({ "op": "find", "database": "d", "collection": "c" }));
        assert!(!find.has_comment());
        let find = request(json!({
            "op": "find", "database": "d", "collection": "c", "options": { "comment": "mine" }
        }));
        assert!(find.has_comment());
        let command = request(json!({
            "op": "runCommand", "database": "d", "command": { "ping": 1, "comment": "x" }
        }));
        assert!(command.has_comment());
        assert!(comment_refused(
            "Location40415 (40415): BSON field 'update.comment' is an unknown field."
        ));
        assert!(comment_refused("Field 'comment' is not supported"));
        assert!(!comment_refused("unknown operator: $foo"));
        assert!(!comment_refused("E11000 duplicate key error, comment: 1"));
    }

    #[test]
    fn shortens_server_selection_errors() {
        let message = "Server selection timeout: No available servers. Topology: { Type: Unknown, Servers: [ { Address: localhost:57017, Type: Unknown, Error: Kind: I/O error: No connection could be made because the target machine actively refused it. (os error 10061), labels: {\"RetryableError\"}, source: None } ] }";
        let cause = server_selection_cause(message);
        assert_eq!(
            cause,
            "No connection could be made because the target machine actively refused it"
        );
    }

    #[test]
    fn builds_seed_lists_from_the_host_field() {
        let cfg = |host: &str, port: u16| -> ConnectionConfig {
            serde_json::from_value(json!({
                "id": "", "name": "", "engine": "mongo", "host": host, "port": port
            }))
            .unwrap()
        };
        assert_eq!(host_list(&cfg("", 0)), "localhost:27017");
        assert_eq!(
            host_list(&cfg("a, b:27018 ,c", 27019)),
            "a:27019,b:27018,c:27019"
        );
        assert_eq!(host_list(&cfg("::1,[::2]:5", 0)), "[::1]:27017,[::2]:5");
    }

    #[test]
    fn round_trips_numeric_types() {
        let doc = doc! { "i": 1i32, "l": 2i64, "d": 3.0f64, "f": 1.5f64 };
        let json = to_json(Bson::Document(doc.clone()));
        assert_eq!(json["l"], json!({ "$numberLong": "2" }));
        assert_eq!(json["d"], json!({ "$numberDouble": "3.0" }));
        let back = to_bson(json).unwrap();
        assert_eq!(back, Bson::Document(doc));
    }

    #[test]
    fn keeps_object_ids_and_dates() {
        let oid = bson::oid::ObjectId::new();
        let doc = doc! { "_id": oid, "at": bson::DateTime::from_millis(1_700_000_000_000) };
        let json = to_json(Bson::Document(doc.clone()));
        assert_eq!(json["_id"]["$oid"], json!(oid.to_hex()));
        assert_eq!(to_bson(json).unwrap(), Bson::Document(doc));
    }

    #[test]
    fn reading_the_profiler_level_is_a_read() {
        assert!(is_read_command(&json!({ "profile": -1 })));
        assert!(!is_read_command(&json!({ "profile": 1, "slowms": 100 })));
        assert!(!is_read_command(&json!({ "collMod": "users" })));
        assert!(is_read_command(&json!({ "validate": "users" })));
        assert!(is_read_command(
            &json!({ "validate": "users", "repair": false })
        ));
        assert!(!is_read_command(
            &json!({ "validate": "users", "repair": true })
        ));
        assert!(!is_read_command(
            &json!({ "validate": "users", "repair": 1 })
        ));
        assert!(is_read_command(
            &json!({ "usersInfo": { "forAllDBs": true } })
        ));
        assert!(!is_read_command(
            &json!({ "createUser": "app", "pwd": "x", "roles": [] })
        ));
    }

    #[test]
    fn exports_json_arrays_and_lines() {
        let docs = || vec![doc! { "a": 1, "b": "x" }, doc! { "a": 2 }];
        let mut json = ExportWriter::new(ExportFormat::Json);
        let mut out: Vec<u8> = docs().into_iter().flat_map(|d| json.push(d)).collect();
        out.extend(json.finish());
        let parsed: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed, json!([{ "a": 1, "b": "x" }, { "a": 2 }]));

        let mut empty = ExportWriter::new(ExportFormat::Json);
        assert_eq!(empty.finish(), b"[]\n");

        let mut lines = ExportWriter::new(ExportFormat::Jsonl);
        let out: Vec<u8> = docs().into_iter().flat_map(|d| lines.push(d)).collect();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "{\"a\":1,\"b\":\"x\"}\n{\"a\":2}\n"
        );
    }

    #[test]
    fn exports_csv_with_a_sampled_header() {
        let id = bson::oid::ObjectId::parse_str("65a1b2c3d4e5f60718293a4b").unwrap();
        let mut csv = ExportWriter::new(ExportFormat::Csv);
        let mut out = csv.push(doc! { "_id": id, "name": "a, b" });
        out.extend(csv.push(doc! { "_id": id, "tags": ["x"], "n": Bson::Null }));
        out.extend(csv.finish());
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "_id,name,tags,n\r\n65a1b2c3d4e5f60718293a4b,\"a, b\",,\r\n65a1b2c3d4e5f60718293a4b,,\"[\"\"x\"\"]\",\r\n"
        );
        assert!(csv.dropped.is_empty());
    }

    #[test]
    fn reports_csv_fields_seen_after_the_header() {
        let mut csv = ExportWriter::new(ExportFormat::Csv);
        for i in 0..CSV_SAMPLE {
            csv.push(doc! { "i": i as i32 });
        }
        let row = csv.push(doc! { "i": 1, "late": true });
        assert_eq!(row, b"1\r\n");
        assert_eq!(csv.dropped.iter().collect::<Vec<_>>(), ["late"]);
    }
}
