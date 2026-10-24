//! Types shared by every driver and serialized to the frontend.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use parking_lot::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Notify;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// e.g. "PostgreSQL 16.2"
    pub product: String,
    /// Full version banner
    pub version: String,
    pub current_database: String,
    pub user: String,
    /// Set when the server identifies itself as Babelfish for Aurora PostgreSQL
    pub babelfish_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    pub is_system: bool,
    pub size_bytes: Option<i64>,
    /// Keys in a Redis keyspace
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaInfo {
    pub name: String,
    pub is_system: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub schema: Option<String>,
    pub name: String,
    /// table | view | materialized_view | foreign_table | sequence | function |
    /// procedure | synonym | collection | timeseries
    pub kind: String,
    /// Function identity arguments, collection options, …
    pub detail: Option<String>,
    pub comment: Option<String>,
    pub row_estimate: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub is_primary_key: bool,
    /// Identity / auto_increment / serial / generated
    pub is_generated: bool,
    /// Identity / auto_increment only (not serial defaults or computed columns)
    pub is_identity: bool,
    pub comment: Option<String>,
    /// MySQL `EXTRA` attributes such as `on update CURRENT_TIMESTAMP`, which a
    /// `MODIFY COLUMN` has to restate
    pub extra: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    pub method: Option<String>,
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerInfo {
    pub name: String,
    /// BEFORE | AFTER | INSTEAD OF
    pub timing: String,
    /// INSERT | UPDATE | DELETE | TRUNCATE
    pub events: Vec<String>,
    /// FOR EACH ROW, as opposed to once per statement
    pub row_level: bool,
    pub enabled: bool,
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub columns: Vec<ColumnInfo>,
    pub primary_key: Vec<String>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub triggers: Vec<TriggerInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineParam {
    pub name: String,
    pub data_type: String,
    /// IN | OUT | INOUT | VARIADIC | OUTPUT (T-SQL)
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInfo {
    pub params: Vec<RoutineParam>,
    /// Return type for functions; `TABLE` for table-valued functions
    pub returns: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionTable {
    pub schema: Option<String>,
    pub name: String,
    pub columns: Vec<String>,
    /// Outgoing foreign keys, for join suggestions
    pub foreign_keys: Vec<CompletionKey>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionKey {
    pub columns: Vec<String>,
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

/// One column pair of a foreign key, as catalog queries return them: the
/// owning table's schema and name, a key id, then column and referenced column.
pub struct KeyColumn {
    pub schema: Option<String>,
    pub table: String,
    pub key: String,
    pub column: String,
    pub ref_schema: Option<String>,
    pub ref_table: String,
    pub ref_column: String,
}

/// Groups key columns (in key order) into keys on the tables they belong to.
pub fn attach_keys(tables: &mut [CompletionTable], columns: Vec<KeyColumn>) {
    let mut keys: Vec<(Option<String>, String, String, CompletionKey)> = Vec::new();
    for c in columns {
        match keys.last_mut() {
            Some((schema, table, key, k))
                if *schema == c.schema && *table == c.table && *key == c.key =>
            {
                k.columns.push(c.column);
                k.ref_columns.push(c.ref_column);
            }
            _ => keys.push((
                c.schema,
                c.table,
                c.key,
                CompletionKey {
                    columns: vec![c.column],
                    ref_schema: c.ref_schema,
                    ref_table: c.ref_table,
                    ref_columns: vec![c.ref_column],
                },
            )),
        }
    }
    for (schema, table, _, key) in keys {
        if let Some(t) = tables
            .iter_mut()
            .find(|t| t.name == table && (schema.is_none() || t.schema == schema))
        {
            t.foreign_keys.push(key);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// Driver type name, empty when the protocol doesn't report it
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<ColumnMeta>,
    /// Cells are `null`, booleans or strings (numbers stay strings to keep precision)
    pub rows: Vec<Vec<Value>>,
    /// Total rows the server produced (may exceed `rows.len()` when truncated)
    pub row_count: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// info | notice | warning | error | rows
    pub level: &'static str,
    pub text: String,
    /// Milliseconds since execution started
    pub at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    pub message: String,
    /// 1-based character offset into the submitted SQL, when the server reports one
    pub position: Option<u32>,
    /// 1-based line within the submitted SQL
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutput {
    pub results: Vec<ResultSet>,
    pub messages: Vec<Message>,
    pub error: Option<ErrorDetail>,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    /// Database the session ended up in (after `USE`)
    pub database: Option<String>,
    /// Whether the session was left inside a transaction; `None` when unknown
    pub in_transaction: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOptions {
    #[serde(default = "default_max_rows")]
    pub max_rows: usize,
    /// Apply the read-only check to this call even on a writable connection,
    /// for dashboards and export re-runs
    #[serde(default)]
    pub read_only: bool,
    /// Cancels the statement after this many seconds; `None` or 0 never times out
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Bytes of each binary cell sent to the grid; the rest is summarized
    #[serde(default = "default_max_binary")]
    pub max_binary_bytes: usize,
    /// Receives the rows of one result set instead of the output (exports)
    #[serde(skip)]
    pub sink: Option<SinkHandle>,
}

fn default_max_rows() -> usize {
    10_000
}

fn default_max_binary() -> usize {
    4096
}

impl Default for ExecOptions {
    fn default() -> Self {
        Self {
            max_rows: default_max_rows(),
            read_only: false,
            timeout_secs: None,
            max_binary_bytes: default_max_binary(),
            sink: None,
        }
    }
}

impl ExecOptions {
    #[cfg(test)]
    pub fn with_max_rows(max_rows: usize) -> Self {
        Self {
            max_rows,
            ..Self::default()
        }
    }
}

/// Where an export writes rows as the server produces them.
pub trait RowSink: Send {
    fn begin(&mut self, columns: &[ColumnMeta]) -> std::io::Result<()>;
    fn row(&mut self, row: &[Value]) -> std::io::Result<()>;
    fn finish(&mut self) -> std::io::Result<()>;
}

/// A sink and the result set (0-based) it takes; the other sets are only counted.
#[derive(Clone)]
pub struct SinkHandle {
    pub sink: Arc<Mutex<Box<dyn RowSink>>>,
    pub set: usize,
    /// The first write error, which stops the export
    pub error: Arc<Mutex<Option<String>>>,
}

impl std::fmt::Debug for SinkHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SinkHandle(set {})", self.set)
    }
}

impl SinkHandle {
    pub fn new(sink: Box<dyn RowSink>, set: usize) -> Self {
        Self {
            sink: Arc::new(Mutex::new(sink)),
            set,
            error: Arc::default(),
        }
    }

    fn record(&self, result: std::io::Result<()>) {
        if let Err(e) = result {
            self.error.lock().get_or_insert_with(|| e.to_string());
        }
    }

    pub fn failed(&self) -> bool {
        self.error.lock().is_some()
    }

    pub fn begin(&self, columns: &[ColumnMeta]) {
        let result = self.sink.lock().begin(columns);
        self.record(result);
    }

    pub fn row(&self, row: &[Value]) {
        if !self.failed() {
            let result = self.sink.lock().row(row);
            self.record(result);
        }
    }

    pub fn finish(&self) {
        let result = self.sink.lock().finish();
        self.record(result);
    }
}

/// Signalled by `query_cancel` while a statement runs.
#[derive(Default)]
pub struct CancelSignal {
    fired: AtomicBool,
    notify: Notify,
}

impl CancelSignal {
    pub fn fire(&self) {
        self.fired.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_fired(&self) -> bool {
        self.fired.load(Ordering::SeqCst)
    }

    /// Resolves once `fire` is called (immediately if it already was).
    pub async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_fired() {
                return;
            }
            notified.await;
        }
    }
}

/// Accumulates results and messages while a batch runs.
pub struct OutputBuilder {
    started: Instant,
    max_rows: usize,
    max_binary: usize,
    pub results: Vec<ResultSet>,
    pub messages: Vec<Message>,
    pub error: Option<ErrorDetail>,
    current: Option<ResultSet>,
    pub cancelled: bool,
    sink: Option<SinkHandle>,
    /// Result sets begun so far, to find the one the sink takes
    sets_begun: usize,
    sinking: bool,
}

impl OutputBuilder {
    pub fn new(opts: &ExecOptions) -> Self {
        Self {
            started: Instant::now(),
            max_rows: opts.max_rows.max(1),
            max_binary: opts.max_binary_bytes.max(1),
            results: Vec::new(),
            messages: Vec::new(),
            error: None,
            current: None,
            cancelled: false,
            sink: opts.sink.clone(),
            sets_begun: 0,
            sinking: false,
        }
    }

    /// Bytes of each binary cell to keep (see `hex_bytes_max`).
    pub fn max_binary(&self) -> usize {
        self.max_binary
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    pub fn begin_set(&mut self, columns: Vec<ColumnMeta>) {
        self.end_set(None);
        self.sinking = false;
        if let Some(sink) = &self.sink
            && sink.set == self.sets_begun
        {
            sink.begin(&columns);
            self.sinking = true;
        }
        self.sets_begun += 1;
        self.current = Some(ResultSet {
            columns,
            rows: Vec::new(),
            row_count: 0,
            truncated: false,
        });
    }

    pub fn has_open_set(&self) -> bool {
        self.current.is_some()
    }

    /// `true` while the open set still accepts rows; callers can skip decoding once full.
    pub fn wants_rows(&self) -> bool {
        self.current
            .as_ref()
            .is_some_and(|set| self.sinking || set.rows.len() < self.max_rows)
    }

    pub fn push_row(&mut self, row: Vec<Value>) {
        let max = self.max_rows;
        if let Some(set) = self.current.as_mut() {
            set.row_count += 1;
            if self.sinking {
                if let Some(sink) = &self.sink {
                    sink.row(&row);
                }
                return;
            }
            if set.rows.len() < max {
                set.rows.push(row);
            } else {
                set.truncated = true;
            }
        }
    }

    /// Counts a row that was skipped because the set is full.
    pub fn skip_row(&mut self) {
        if let Some(set) = self.current.as_mut() {
            set.row_count += 1;
            set.truncated = true;
        }
    }

    /// Closes the open result set. `rows` is the server-reported count, if any.
    pub fn end_set(&mut self, rows: Option<u64>) {
        if let Some(mut set) = self.current.take() {
            if self.sinking
                && let Some(sink) = &self.sink
            {
                sink.finish();
                self.sinking = false;
            }
            if let Some(n) = rows {
                set.row_count = set.row_count.max(n);
            }
            let n = set.row_count;
            self.results.push(set);
            self.message(
                "rows",
                format!("({n} row{} returned)", if n == 1 { "" } else { "s" }),
            );
        }
    }

    pub fn affected(&mut self, rows: u64) {
        self.message(
            "rows",
            format!("({rows} row{} affected)", if rows == 1 { "" } else { "s" }),
        );
    }

    pub fn message(&mut self, level: &'static str, text: impl Into<String>) {
        let at_ms = self.elapsed_ms();
        self.messages.push(Message {
            level,
            text: text.into(),
            at_ms,
        });
    }

    pub fn fail(&mut self, message: String, position: Option<u32>, line: Option<u32>) {
        self.end_set(None);
        self.message("error", message.clone());
        if self.error.is_none() {
            self.error = Some(ErrorDetail {
                message,
                position,
                line,
            });
        }
    }

    pub fn finish(mut self, database: Option<String>) -> ExecOutput {
        self.end_set(None);
        if self.cancelled {
            self.message("warning", "Query cancelled");
        }
        ExecOutput {
            elapsed_ms: self.elapsed_ms(),
            results: self.results,
            messages: self.messages,
            error: self.error,
            cancelled: self.cancelled,
            database,
            in_transaction: None,
        }
    }
}

/// `0xDEADBEEF`-style rendering for binary cells, capped (`ExecOptions::max_binary_bytes`)
/// so huge blobs don't flood the grid.
pub fn hex_bytes_max(bytes: &[u8], max: usize) -> String {
    use std::fmt::Write as _;
    let max = max.max(1);
    let mut out = String::with_capacity(2 + bytes.len().min(max) * 2);
    out.push_str("0x");
    for b in bytes.iter().take(max) {
        let _ = write!(out, "{b:02X}");
    }
    if bytes.len() > max {
        let _ = write!(out, "… ({} bytes)", bytes.len());
    }
    out
}
