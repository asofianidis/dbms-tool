//! Redis, Valkey, KeyDB and Dragonfly via redis-rs. The numbered keyspaces
//! (`SELECT n`) are the app's databases. Each session gets its own connection
//! per keyspace, so a blocking command or a MULTI in one console tab never
//! stalls the key browser.
//!
//! Keys and values that aren't UTF-8 cross the IPC boundary as `{"$hex": …}`
//! and come back the same way, so binary keys can still be edited and deleted.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use ::redis::aio::{ConnectionLike, MultiplexedConnection};
use ::redis::{
    AsyncConnectionConfig, Client, ConnectionAddr, ConnectionInfo, IntoConnectionInfo,
    RedisConnectionInfo, Value as RValue,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::{ConnectionConfig, SslMode};
use crate::error::{AppError, AppResult};
use crate::model::*;

pub const DEFAULT_PORT: u16 = 6379;

/// Largest string value sent whole; longer ones are cut and marked truncated.
const MAX_STRING_BYTES: usize = 1024 * 1024;
/// How long one browse page may keep scanning a sparse keyspace.
const SCAN_BUDGET: Duration = Duration::from_millis(1500);

pub fn describe_error(e: &::redis::RedisError) -> String {
    match (e.code(), e.detail()) {
        (Some(code), Some(detail)) => format!("{code} {detail}"),
        _ => e.to_string(),
    }
}

/* ---------- Binary-safe strings ---------- */

/// A key, field or value: text when it's UTF-8, hex otherwise.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Data {
    Text(String),
    Hex {
        #[serde(rename = "$hex")]
        hex: String,
    },
}

impl Data {
    fn bytes(&self) -> AppResult<Vec<u8>> {
        match self {
            Data::Text(s) => Ok(s.as_bytes().to_vec()),
            Data::Hex { hex } => {
                let hex = hex.trim();
                if hex.len() % 2 != 0 {
                    return Err(AppError::msg("Hex data needs an even number of digits"));
                }
                (0..hex.len())
                    .step_by(2)
                    .map(|i| {
                        u8::from_str_radix(&hex[i..i + 2], 16)
                            .map_err(|_| AppError::msg(format!("Invalid hex data: {hex}")))
                    })
                    .collect()
            }
        }
    }
}

/// Bytes → `"text"` or `{"$hex": "…"}`.
fn data_json(bytes: &[u8]) -> Value {
    match std::str::from_utf8(bytes) {
        Ok(s) => Value::String(s.to_string()),
        Err(_) => json!({ "$hex": bytes.iter().map(|b| format!("{b:02x}")).collect::<String>() }),
    }
}

fn value_bytes(v: &RValue) -> Option<Vec<u8>> {
    match v {
        RValue::BulkString(b) => Some(b.clone()),
        RValue::SimpleString(s) => Some(s.as_bytes().to_vec()),
        RValue::VerbatimString { text, .. } => Some(text.as_bytes().to_vec()),
        RValue::Okay => Some(b"OK".to_vec()),
        RValue::Int(n) => Some(n.to_string().into_bytes()),
        RValue::Double(f) => Some(f.to_string().into_bytes()),
        _ => None,
    }
}

fn value_text(v: &RValue) -> Option<String> {
    value_bytes(v).map(|b| String::from_utf8_lossy(&b).into_owned())
}

fn value_int(v: &RValue) -> Option<i64> {
    match v {
        RValue::Int(n) => Some(*n),
        other => value_text(other)?.trim().parse().ok(),
    }
}

fn value_float(v: &RValue) -> Option<f64> {
    match v {
        RValue::Double(f) => Some(*f),
        RValue::Int(n) => Some(*n as f64),
        other => value_text(other)?.trim().parse().ok(),
    }
}

/// Array, set or RESP3 map flattened to its items.
fn items(v: RValue) -> Vec<RValue> {
    match v {
        RValue::Array(items) | RValue::Set(items) => items,
        RValue::Map(pairs) => pairs.into_iter().flat_map(|(k, v)| [k, v]).collect(),
        RValue::Attribute { data, .. } => items(*data),
        RValue::Nil => Vec::new(),
        other => vec![other],
    }
}

/// A server reply for the console, tagged so it prints the way redis-cli would.
pub fn reply_json(v: RValue) -> Value {
    match v {
        RValue::Nil => json!({ "t": "nil" }),
        RValue::Int(n) => json!({ "t": "int", "v": n }),
        RValue::BulkString(b) => json!({ "t": "bulk", "v": data_json(&b) }),
        RValue::VerbatimString { text, .. } => json!({ "t": "bulk", "v": text }),
        RValue::SimpleString(s) => json!({ "t": "status", "v": s }),
        RValue::Okay => json!({ "t": "status", "v": "OK" }),
        RValue::Array(items) => {
            json!({ "t": "array", "v": items.into_iter().map(reply_json).collect::<Vec<_>>() })
        }
        RValue::Set(items) => {
            json!({ "t": "set", "v": items.into_iter().map(reply_json).collect::<Vec<_>>() })
        }
        RValue::Push { data, .. } => {
            json!({ "t": "array", "v": data.into_iter().map(reply_json).collect::<Vec<_>>() })
        }
        RValue::Map(pairs) => json!({
            "t": "map",
            "v": pairs
                .into_iter()
                .map(|(k, v)| json!([reply_json(k), reply_json(v)]))
                .collect::<Vec<_>>()
        }),
        RValue::Attribute { data, .. } => reply_json(*data),
        RValue::Double(f) => json!({ "t": "double", "v": f }),
        RValue::Boolean(b) => json!({ "t": "bool", "v": b }),
        RValue::BigNumber(n) => json!({ "t": "int", "v": String::from_utf8_lossy(&n) }),
        RValue::ServerError(e) => {
            let text = match e.details() {
                Some(d) => format!("{} {d}", e.code()),
                None => e.code().to_string(),
            };
            json!({ "t": "error", "v": text })
        }
        other => json!({ "t": "status", "v": format!("{other:?}") }),
    }
}

/* ---------- Connecting ---------- */

pub fn database_index(database: &str) -> AppResult<i64> {
    let db = database.trim().trim_start_matches("db");
    if db.is_empty() {
        return Ok(0);
    }
    db.parse::<i64>()
        .ok()
        .filter(|n| *n >= 0)
        .ok_or_else(|| AppError::msg(format!("\"{database}\" isn't a Redis database number")))
}

fn connection_info(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<ConnectionInfo> {
    let password = password.filter(|p| !p.is_empty());
    let uri = cfg.uri.trim();
    let info = if uri.is_empty() {
        let host = match cfg.host.trim() {
            "" => "localhost".to_string(),
            h => h.to_string(),
        };
        let port = if cfg.port == 0 {
            DEFAULT_PORT
        } else {
            cfg.port
        };
        // Redis has no opportunistic TLS, so Prefer means plain text here
        let addr = if cfg.ssl.required() {
            ConnectionAddr::TcpTls {
                host,
                port,
                insecure: !cfg.verify_certificate(),
                tls_params: None,
            }
        } else {
            ConnectionAddr::Tcp(host, port)
        };
        let mut redis = RedisConnectionInfo::default();
        if !cfg.user.is_empty() {
            redis = redis.set_username(&cfg.user);
        }
        if let Some(p) = password {
            redis = redis.set_password(p);
        }
        addr.into_connection_info()?.set_redis_settings(redis)
    } else {
        let info = uri.into_connection_info()?;
        // A password typed into the dialog fills in a URI that leaves it out
        let mut redis = info.redis_settings().clone();
        if redis.password().is_none()
            && let Some(p) = password
        {
            redis = redis.set_password(p);
        }
        // Prefer leaves TLS to the scheme (rediss://); Disable turns it off and the
        // stricter modes turn it on
        let addr = match info.addr().clone() {
            ConnectionAddr::Tcp(host, port) if cfg.ssl.required() => ConnectionAddr::TcpTls {
                host,
                port,
                insecure: !cfg.verify_certificate(),
                tls_params: None,
            },
            ConnectionAddr::TcpTls { host, port, .. } if cfg.ssl == SslMode::Disable => {
                ConnectionAddr::Tcp(host, port)
            }
            ConnectionAddr::TcpTls {
                host,
                port,
                insecure,
                tls_params,
            } => ConnectionAddr::TcpTls {
                host,
                port,
                // The verify modes override a URI's #insecure
                insecure: !cfg.ssl.verifies() && (insecure || cfg.trust_server_certificate),
                tls_params,
            },
            other => other,
        };
        info.set_addr(addr).set_redis_settings(redis)
    };
    let tls = matches!(info.addr(), ConnectionAddr::TcpTls { .. });
    if !tls {
        if cfg.root_cert().is_some() || cfg.client_cert().is_some() {
            return Err(AppError::msg(
                "Certificate files only apply over TLS; choose Require or a verify mode, or use rediss://",
            ));
        }
        return Ok(info);
    }
    if cfg.tunneled.is_some() && cfg.verify_hostname() {
        return Err(AppError::msg(
            "Redis can't verify the certificate's host name through an SSH tunnel (it would be checked against 127.0.0.1); use Verify CA or Require instead",
        ));
    }
    let info = with_certificates(cfg, info)?;
    // Verify CA checks the chain only; through a tunnel the certificate names the
    // real host, not 127.0.0.1
    if cfg.ssl == SslMode::VerifyCa || cfg.tunneled.is_some() {
        let mut addr = info.addr().clone();
        addr.set_danger_accept_invalid_hostnames(true);
        return Ok(info.set_addr(addr));
    }
    Ok(info)
}

/// Attaches the connection's CA and client certificate files, when it names any.
fn with_certificates(cfg: &ConnectionConfig, info: ConnectionInfo) -> AppResult<ConnectionInfo> {
    let root_cert = cfg
        .root_cert()
        .map(|path| super::tls::read_file(path, "CA certificate"))
        .transpose()?;
    let client_tls = match super::tls::client_cert(cfg)? {
        None => None,
        Some(super::tls::ClientCert::Pkcs12(_)) => {
            return Err(AppError::msg(
                "Redis needs the client certificate and its key as PEM files, not a .p12/.pfx bundle",
            ));
        }
        Some(super::tls::ClientCert::Pem { cert, key }) => Some(::redis::ClientTlsConfig {
            client_cert: super::tls::read_file(cert, "client certificate")?,
            client_key: super::tls::read_file(key, "client key")?,
        }),
    };
    if root_cert.is_none() && client_tls.is_none() {
        return Ok(info);
    }
    // The client keeps the parsed certificates in its connection info, which every
    // per-keyspace client is built from
    let client = Client::build_with_tls(
        info,
        ::redis::TlsCertificates {
            client_tls,
            root_cert,
        },
    )?;
    Ok(client.get_connection_info().clone())
}

pub struct RedisClient {
    info: ConnectionInfo,
    /// The keyspace a connection lands in when it names none
    pub default_db: i64,
    conns: tokio::sync::Mutex<HashMap<(String, i64), MultiplexedConnection>>,
    subscriptions: parking_lot::Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl Drop for RedisClient {
    fn drop(&mut self) {
        for handle in self.subscriptions.lock().values() {
            handle.abort();
        }
    }
}

fn connection_config() -> AsyncConnectionConfig {
    // Blocking commands (BLPOP, XREAD BLOCK) can wait indefinitely; the app's
    // own timeout and cancel button cover runaway commands
    AsyncConnectionConfig::new()
        .set_connection_timeout(Some(crate::limits::connect_timeout()))
        .set_response_timeout(None)
}

impl RedisClient {
    fn client(&self, db: i64) -> AppResult<Client> {
        let redis = self.info.redis_settings().clone().set_db(db);
        Ok(Client::open(self.info.clone().set_redis_settings(redis))?)
    }

    /// The session's connection to keyspace `db`, opened on first use.
    pub async fn connection(&self, session: &str, db: i64) -> AppResult<MultiplexedConnection> {
        let key = (session.to_string(), db);
        if let Some(conn) = self.conns.lock().await.get(&key) {
            return Ok(conn.clone());
        }
        let conn = self
            .client(db)?
            .get_multiplexed_async_connection_with_config(&connection_config())
            .await?;
        self.conns.lock().await.insert(key, conn.clone());
        Ok(conn)
    }

    /// Drops a session's connections, e.g. after cancelling a blocking command.
    pub async fn close_session(&self, session: &str) {
        self.conns.lock().await.retain(|(s, _), _| s != session);
    }

    pub fn unsubscribe(&self, id: &str) {
        if let Some(handle) = self.subscriptions.lock().remove(id) {
            handle.abort();
        }
    }
}

pub async fn connect(cfg: &ConnectionConfig, password: Option<&str>) -> AppResult<RedisClient> {
    let info = connection_info(cfg, password)?;
    let default_db = if cfg.database.trim().is_empty() {
        info.redis_settings().db()
    } else {
        database_index(&cfg.database)?
    };
    let client = RedisClient {
        info,
        default_db,
        conns: tokio::sync::Mutex::new(HashMap::new()),
        subscriptions: parking_lot::Mutex::new(HashMap::new()),
    };
    let mut conn = client.connection(crate::manager::META, default_db).await?;
    ::redis::cmd("PING")
        .query_async::<RValue>(&mut conn)
        .await?;
    Ok(client)
}

/* ---------- Server metadata ---------- */

/// `INFO` text → `field → value`, ignoring section headers.
pub fn parse_info(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

async fn info(
    conn: &mut MultiplexedConnection,
    section: &str,
) -> AppResult<HashMap<String, String>> {
    let reply: RValue = ::redis::cmd("INFO").arg(section).query_async(conn).await?;
    Ok(parse_info(&value_text(&reply).unwrap_or_default()))
}

pub async fn server_info(client: &RedisClient) -> AppResult<ServerInfo> {
    let mut conn = client
        .connection(crate::manager::META, client.default_db)
        .await?;
    let server = info(&mut conn, "server").await?;
    let (product, version) = if let Some(v) = server.get("dragonfly_version") {
        ("Dragonfly", v.trim_start_matches('v').to_string())
    } else if let Some(v) = server.get("valkey_version") {
        ("Valkey", v.clone())
    } else if server.contains_key("keydb_version") || server.contains_key("mvcc-depth") {
        (
            "KeyDB",
            server.get("redis_version").cloned().unwrap_or_default(),
        )
    } else {
        (
            "Redis",
            server.get("redis_version").cloned().unwrap_or_default(),
        )
    };
    let mode = match server.get("redis_mode").or(server.get("server_mode")) {
        Some(m) if m != "standalone" => format!(" ({m})"),
        _ => String::new(),
    };
    let user = ::redis::cmd("ACL")
        .arg("WHOAMI")
        .query_async::<RValue>(&mut conn)
        .await
        .ok()
        .and_then(|v| value_text(&v))
        .unwrap_or_else(|| "default".into());
    let os = server
        .get("os")
        .map(|os| format!(", {os}"))
        .unwrap_or_default();
    Ok(ServerInfo {
        product: format!("{product} {version}{mode}"),
        version: format!("{product} {version}{mode}{os}"),
        current_database: client.default_db.to_string(),
        user,
        babelfish_version: None,
    })
}

/// Every keyspace the server has (`CONFIG GET databases`, else 16), with key counts.
pub async fn list_databases(client: &RedisClient) -> AppResult<Vec<DatabaseInfo>> {
    let mut conn = client
        .connection(crate::manager::META, client.default_db)
        .await?;
    let keyspace = info(&mut conn, "keyspace").await.unwrap_or_default();
    // Managed services often disable CONFIG
    let configured = ::redis::cmd("CONFIG")
        .arg("GET")
        .arg("databases")
        .query_async::<RValue>(&mut conn)
        .await
        .ok()
        .and_then(|v| items(v).get(1).and_then(value_int));
    let highest = keyspace
        .keys()
        .filter_map(|k| k.strip_prefix("db")?.parse::<i64>().ok())
        .chain([client.default_db])
        .max()
        .unwrap_or(0);
    let count = configured.unwrap_or(16).max(highest + 1);
    Ok((0..count)
        .map(|n| DatabaseInfo {
            name: n.to_string(),
            is_system: false,
            size_bytes: None,
            keys: Some(
                keyspace
                    .get(&format!("db{n}"))
                    .and_then(|v| keyspace_field(v, "keys"))
                    .unwrap_or(0),
            ),
        })
        .collect())
}

/// `keys=12,expires=0,avg_ttl=0` → the named count.
fn keyspace_field(line: &str, name: &str) -> Option<i64> {
    line.split(',')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == name)
        .and_then(|(_, v)| v.parse().ok())
}

/* ---------- Requests ---------- */

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RedisRequest {
    /// A page of keys matching `pattern`, with their types and TTLs
    Scan {
        database: String,
        cursor: Option<String>,
        pattern: Option<String>,
        key_type: Option<String>,
        count: Option<usize>,
    },
    /// A key's metadata and (a page of) its value
    Get {
        database: String,
        key: Data,
        /// SCAN cursor (hash, set) or stream ID to continue from
        cursor: Option<String>,
        /// First index (list, sorted set)
        offset: Option<i64>,
        count: Option<usize>,
    },
    Set {
        database: String,
        key: Data,
        value: Data,
        ttl_ms: Option<i64>,
        #[serde(default)]
        keep_ttl: bool,
        /// Fail rather than overwrite an existing key
        #[serde(default)]
        only_new: bool,
    },
    HashSet {
        database: String,
        key: Data,
        field: Data,
        value: Data,
        #[serde(default)]
        only_new: bool,
    },
    HashDelete {
        database: String,
        key: Data,
        fields: Vec<Data>,
    },
    ListPush {
        database: String,
        key: Data,
        values: Vec<Data>,
        #[serde(default)]
        head: bool,
    },
    ListSet {
        database: String,
        key: Data,
        index: i64,
        value: Data,
    },
    ListRemove {
        database: String,
        key: Data,
        index: i64,
    },
    SetAdd {
        database: String,
        key: Data,
        members: Vec<Data>,
    },
    SetRemove {
        database: String,
        key: Data,
        members: Vec<Data>,
    },
    ZsetAdd {
        database: String,
        key: Data,
        member: Data,
        score: f64,
    },
    ZsetRemove {
        database: String,
        key: Data,
        members: Vec<Data>,
    },
    StreamAdd {
        database: String,
        key: Data,
        /// `*` (or absent) lets the server assign one
        id: Option<String>,
        fields: Vec<(Data, Data)>,
    },
    StreamDelete {
        database: String,
        key: Data,
        ids: Vec<String>,
    },
    JsonSet {
        database: String,
        key: Data,
        json: String,
    },
    /// Sets the TTL, or removes it when `ttl_ms` is absent
    Expire {
        database: String,
        key: Data,
        ttl_ms: Option<i64>,
    },
    Rename {
        database: String,
        key: Data,
        new_key: Data,
    },
    Delete {
        database: String,
        keys: Vec<Data>,
    },
    /// Unlinks every key matching `pattern`, a SCAN batch at a time
    DeleteMatching {
        database: String,
        pattern: String,
    },
    /// Empties the keyspace
    Flush {
        database: String,
    },
    /// A raw command from the console
    Command {
        database: String,
        args: Vec<String>,
    },
    /// Many commands in one round trip, e.g. seeding; a command the server rejects is
    /// reported, not fatal
    Pipeline {
        database: String,
        commands: Vec<Vec<Data>>,
    },
}

impl RedisRequest {
    pub fn database(&self) -> &str {
        use RedisRequest::*;
        match self {
            Scan { database, .. }
            | Get { database, .. }
            | Set { database, .. }
            | HashSet { database, .. }
            | HashDelete { database, .. }
            | ListPush { database, .. }
            | ListSet { database, .. }
            | ListRemove { database, .. }
            | SetAdd { database, .. }
            | SetRemove { database, .. }
            | ZsetAdd { database, .. }
            | ZsetRemove { database, .. }
            | StreamAdd { database, .. }
            | StreamDelete { database, .. }
            | JsonSet { database, .. }
            | Expire { database, .. }
            | Rename { database, .. }
            | Delete { database, .. }
            | DeleteMatching { database, .. }
            | Flush { database }
            | Command { database, .. }
            | Pipeline { database, .. } => database,
        }
    }

    pub fn is_write(&self) -> bool {
        match self {
            RedisRequest::Scan { .. } | RedisRequest::Get { .. } => false,
            RedisRequest::Command { args, .. } => !is_read_command(args),
            RedisRequest::Pipeline { commands, .. } => commands.iter().any(|c| {
                let name: Vec<String> = c
                    .iter()
                    .take(2)
                    .map(|a| match a {
                        Data::Text(t) => t.clone(),
                        Data::Hex { .. } => String::new(),
                    })
                    .collect();
                !is_read_command(&name)
            }),
            _ => true,
        }
    }
}

/// Commands that never change data, so they still run on a read-only connection.
pub fn is_read_command(args: &[String]) -> bool {
    const READS: &[&str] = &[
        "BITCOUNT",
        "BITFIELD_RO",
        "BITPOS",
        "DBSIZE",
        "DUMP",
        "ECHO",
        "EXISTS",
        "EXPIRETIME",
        "GEODIST",
        "GEOHASH",
        "GEOPOS",
        "GEORADIUSBYMEMBER_RO",
        "GEORADIUS_RO",
        "GEOSEARCH",
        "GET",
        "GETBIT",
        "GETRANGE",
        "HEXISTS",
        "HGET",
        "HGETALL",
        "HKEYS",
        "HLEN",
        "HMGET",
        "HRANDFIELD",
        "HSCAN",
        "HSTRLEN",
        "HVALS",
        "HTTL",
        "HPTTL",
        "HEXPIRETIME",
        "INFO",
        "KEYS",
        "LASTSAVE",
        "LCS",
        "LINDEX",
        "LLEN",
        "LOLWUT",
        "LPOS",
        "LRANGE",
        "MGET",
        "PEXPIRETIME",
        "PFCOUNT",
        "PING",
        "PTTL",
        "PUBSUB",
        "RANDOMKEY",
        "ROLE",
        "SCAN",
        "SCARD",
        "SDIFF",
        "SINTER",
        "SINTERCARD",
        "SISMEMBER",
        "SMEMBERS",
        "SMISMEMBER",
        "SRANDMEMBER",
        "SSCAN",
        "STRLEN",
        "SUBSTR",
        "SUNION",
        "TIME",
        "TOUCH",
        "TTL",
        "TYPE",
        "XLEN",
        "XPENDING",
        "XRANGE",
        "XREAD",
        "XREVRANGE",
        "ZCARD",
        "ZCOUNT",
        "ZDIFF",
        "ZINTER",
        "ZINTERCARD",
        "ZLEXCOUNT",
        "ZMSCORE",
        "ZRANDMEMBER",
        "ZRANGE",
        "ZRANGEBYLEX",
        "ZRANGEBYSCORE",
        "ZRANK",
        "ZREVRANGE",
        "ZREVRANGEBYLEX",
        "ZREVRANGEBYSCORE",
        "ZREVRANK",
        "ZSCAN",
        "ZSCORE",
        "JSON.GET",
        "JSON.MGET",
        "JSON.TYPE",
        "JSON.STRLEN",
        "JSON.ARRLEN",
        "JSON.OBJKEYS",
        "JSON.OBJLEN",
        "JSON.RESP",
        "FT.SEARCH",
        "FT.AGGREGATE",
        "FT.INFO",
        "FT._LIST",
        "FT.EXPLAIN",
        "FT.PROFILE",
        "TS.GET",
        "TS.MGET",
        "TS.RANGE",
        "TS.REVRANGE",
        "TS.MRANGE",
        "TS.MREVRANGE",
        "TS.INFO",
        "TS.QUERYINDEX",
        "BF.EXISTS",
        "BF.MEXISTS",
        "BF.INFO",
        "CF.EXISTS",
        "CF.INFO",
        "CMS.QUERY",
        "CMS.INFO",
        "TOPK.QUERY",
        "TOPK.LIST",
        "TOPK.INFO",
        "EVAL_RO",
        "EVALSHA_RO",
        "FCALL_RO",
        "SORT_RO",
        "WAIT",
    ];
    /// Read-only subcommands of container commands
    const READ_SUBCOMMANDS: &[(&str, &[&str])] = &[
        (
            "CLIENT",
            &["LIST", "INFO", "GETNAME", "ID", "TRACKINGINFO", "NO-EVICT"],
        ),
        ("CONFIG", &["GET"]),
        (
            "COMMAND",
            &[
                "",
                "COUNT",
                "DOCS",
                "INFO",
                "LIST",
                "GETKEYS",
                "GETKEYSANDFLAGS",
            ],
        ),
        (
            "MEMORY",
            &["USAGE", "STATS", "DOCTOR", "MALLOC-STATS", "HELP"],
        ),
        (
            "OBJECT",
            &["ENCODING", "FREQ", "IDLETIME", "REFCOUNT", "HELP"],
        ),
        ("SLOWLOG", &["GET", "LEN", "HELP"]),
        (
            "LATENCY",
            &["LATEST", "HISTORY", "DOCTOR", "GRAPH", "HISTOGRAM", "HELP"],
        ),
        (
            "ACL",
            &[
                "WHOAMI", "LIST", "USERS", "GETUSER", "CAT", "LOG", "DRYRUN", "HELP",
            ],
        ),
        ("XINFO", &["STREAM", "GROUPS", "CONSUMERS", "HELP"]),
        (
            "CLUSTER",
            &[
                "INFO",
                "NODES",
                "SLOTS",
                "SHARDS",
                "MYID",
                "KEYSLOT",
                "COUNTKEYSINSLOT",
            ],
        ),
        ("FUNCTION", &["LIST", "DUMP", "STATS"]),
        ("SCRIPT", &["EXISTS"]),
        ("MODULE", &["LIST"]),
    ];
    let Some(name) = args.first().map(|a| a.to_ascii_uppercase()) else {
        return true;
    };
    if READS.contains(&name.as_str()) {
        return true;
    }
    // `ACL LOG RESET` clears the log; `ACL LOG [count]` reads it
    if name == "ACL"
        && args.get(1).is_some_and(|a| a.eq_ignore_ascii_case("LOG"))
        && args.get(2).is_some_and(|a| a.eq_ignore_ascii_case("RESET"))
    {
        return false;
    }
    let sub = args
        .get(1)
        .map(|a| a.to_ascii_uppercase())
        .unwrap_or_default();
    READ_SUBCOMMANDS
        .iter()
        .any(|(cmd, subs)| *cmd == name && subs.contains(&sub.as_str()))
}

/// Console commands that would break the shared connection model, with what to do instead.
fn refused_command(args: &[String]) -> Option<&'static str> {
    let name = args.first()?.to_ascii_uppercase();
    Some(match name.as_str() {
        "SUBSCRIBE" | "PSUBSCRIBE" | "SSUBSCRIBE" => {
            "Use the Pub/Sub tab to subscribe to channels (right-click the connection or database)."
        }
        "MONITOR" => "MONITOR streams every command forever, so the console doesn't run it.",
        "SELECT" => "Pick the database with the database selector at the top of the console.",
        "QUIT" | "RESET" | "HELLO" | "AUTH" => {
            "The console manages its own connection; edit the connection settings instead."
        }
        "SYNC" | "PSYNC" | "REPLCONF" => "Replication commands can't run from the console.",
        _ => return None,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    pub key: Value,
    #[serde(rename = "type")]
    pub kind: String,
    /// Milliseconds left; -1 when the key never expires
    pub ttl: i64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RedisOutput {
    /// keys | key | reply | value
    pub kind: &'static str,
    /// A page of keys (scan); "0" or absent when the keyspace is exhausted
    pub keys: Vec<KeyEntry>,
    pub cursor: Option<String>,
    /// Keys the scan looked at, matching or not
    pub scanned: u64,
    /// A key's type, TTL and contents (get)
    #[serde(rename = "type")]
    pub key_type: Option<String>,
    pub ttl: Option<i64>,
    pub encoding: Option<String>,
    pub memory: Option<i64>,
    /// Characters (string), elements (collections) or entries (stream)
    pub length: Option<i64>,
    /// Whole value of a string or JSON key
    pub value: Option<Value>,
    /// Hash fields, list items, set members, sorted set members or stream entries
    pub entries: Vec<Value>,
    /// Stream consumer groups
    pub groups: Vec<Value>,
    pub truncated: bool,
    /// Console reply, or the result of a write
    pub reply: Option<Value>,
    pub elapsed_ms: u64,
    pub cancelled: bool,
}

impl RedisOutput {
    fn reply(reply: Value) -> Self {
        Self {
            kind: "reply",
            reply: Some(reply),
            ..Default::default()
        }
    }
}

fn affected(n: i64) -> RedisOutput {
    RedisOutput::reply(json!({ "t": "int", "v": n }))
}

fn ok() -> RedisOutput {
    RedisOutput::reply(json!({ "t": "status", "v": "OK" }))
}

pub async fn execute(
    client: &RedisClient,
    session: &str,
    request: RedisRequest,
    cancel: &CancelSignal,
) -> AppResult<RedisOutput> {
    let started = Instant::now();
    let db = database_index(request.database())?;
    let mut conn = client.connection(session, db).await?;
    let result = tokio::select! {
        biased;
        _ = cancel.wait() => None,
        r = run(&mut conn, request) => Some(r),
    };
    let mut out = match result {
        Some(Err(e)) => {
            // A dropped socket stays broken; reconnect on the next call
            let ping_cmd = cmd("PING");
            let ping = conn.req_packed_command(&ping_cmd);
            if !matches!(
                tokio::time::timeout(Duration::from_secs(2), ping).await,
                Ok(Ok(_))
            ) {
                client.close_session(session).await;
            }
            return Err(e);
        }
        Some(Ok(out)) => out,
        None => {
            // The server may still be blocked on the command; start over with a new connection
            client.close_session(session).await;
            RedisOutput {
                kind: "reply",
                cancelled: true,
                ..Default::default()
            }
        }
    };
    out.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(out)
}

fn cmd(name: &str) -> ::redis::Cmd {
    ::redis::cmd(name)
}

async fn query(conn: &mut MultiplexedConnection, c: &::redis::Cmd) -> AppResult<RValue> {
    Ok(c.query_async::<RValue>(conn).await?)
}

async fn run(conn: &mut MultiplexedConnection, request: RedisRequest) -> AppResult<RedisOutput> {
    use RedisRequest::*;
    Ok(match request {
        Scan {
            cursor,
            pattern,
            key_type,
            count,
            ..
        } => {
            scan(
                conn,
                cursor,
                pattern,
                key_type,
                count.unwrap_or(500).clamp(1, 10_000),
            )
            .await?
        }
        Get {
            key,
            cursor,
            offset,
            count,
            ..
        } => {
            let count = count.unwrap_or(200).clamp(1, 10_000);
            get(conn, &key.bytes()?, cursor, offset.unwrap_or(0), count).await?
        }
        Set {
            key,
            value,
            ttl_ms,
            keep_ttl,
            only_new,
            ..
        } => {
            let mut c = cmd("SET");
            c.arg(key.bytes()?).arg(value.bytes()?);
            match ttl_ms.filter(|t| *t > 0) {
                Some(ttl) => {
                    c.arg("PX").arg(ttl);
                }
                None if keep_ttl => {
                    c.arg("KEEPTTL");
                }
                None => {}
            }
            if only_new {
                c.arg("NX");
            }
            match query(conn, &c).await? {
                RValue::Nil => return Err(AppError::msg("A key with that name already exists")),
                _ => ok(),
            }
        }
        HashSet {
            key,
            field,
            value,
            only_new,
            ..
        } => {
            let mut c = cmd(if only_new { "HSETNX" } else { "HSET" });
            c.arg(key.bytes()?).arg(field.bytes()?).arg(value.bytes()?);
            let n = value_int(&query(conn, &c).await?).unwrap_or(0);
            if only_new && n == 0 {
                return Err(AppError::msg("The hash already has that field"));
            }
            affected(n)
        }
        HashDelete { key, fields, .. } => {
            let mut c = cmd("HDEL");
            c.arg(key.bytes()?);
            for f in fields {
                c.arg(f.bytes()?);
            }
            affected(value_int(&query(conn, &c).await?).unwrap_or(0))
        }
        ListPush {
            key, values, head, ..
        } => {
            let mut c = cmd(if head { "LPUSH" } else { "RPUSH" });
            c.arg(key.bytes()?);
            for v in values {
                c.arg(v.bytes()?);
            }
            affected(value_int(&query(conn, &c).await?).unwrap_or(0))
        }
        ListSet {
            key, index, value, ..
        } => {
            query(
                conn,
                cmd("LSET").arg(key.bytes()?).arg(index).arg(value.bytes()?),
            )
            .await?;
            ok()
        }
        ListRemove { key, index, .. } => {
            // Lists have no remove-by-index: mark the item, then remove the mark, in one transaction
            let key = key.bytes()?;
            let mark = format!("__dbms_tool_removed_{}__", uuid::Uuid::new_v4());
            ::redis::pipe()
                .atomic()
                .cmd("LSET")
                .arg(&key)
                .arg(index)
                .arg(&mark)
                .ignore()
                .cmd("LREM")
                .arg(&key)
                .arg(1)
                .arg(&mark)
                .ignore()
                .query_async::<()>(conn)
                .await?;
            affected(1)
        }
        SetAdd { key, members, .. } => {
            let mut c = cmd("SADD");
            c.arg(key.bytes()?);
            for m in members {
                c.arg(m.bytes()?);
            }
            affected(value_int(&query(conn, &c).await?).unwrap_or(0))
        }
        SetRemove { key, members, .. } => {
            let mut c = cmd("SREM");
            c.arg(key.bytes()?);
            for m in members {
                c.arg(m.bytes()?);
            }
            affected(value_int(&query(conn, &c).await?).unwrap_or(0))
        }
        ZsetAdd {
            key, member, score, ..
        } => {
            query(
                conn,
                cmd("ZADD")
                    .arg(key.bytes()?)
                    .arg(score)
                    .arg(member.bytes()?),
            )
            .await?;
            ok()
        }
        ZsetRemove { key, members, .. } => {
            let mut c = cmd("ZREM");
            c.arg(key.bytes()?);
            for m in members {
                c.arg(m.bytes()?);
            }
            affected(value_int(&query(conn, &c).await?).unwrap_or(0))
        }
        StreamAdd {
            key, id, fields, ..
        } => {
            if fields.is_empty() {
                return Err(AppError::msg("A stream entry needs at least one field"));
            }
            let mut c = cmd("XADD");
            c.arg(key.bytes()?)
                .arg(id.filter(|i| !i.trim().is_empty()).unwrap_or("*".into()));
            for (f, v) in fields {
                c.arg(f.bytes()?).arg(v.bytes()?);
            }
            RedisOutput::reply(reply_json(query(conn, &c).await?))
        }
        StreamDelete { key, ids, .. } => {
            let mut c = cmd("XDEL");
            c.arg(key.bytes()?).arg(ids);
            affected(value_int(&query(conn, &c).await?).unwrap_or(0))
        }
        JsonSet { key, json, .. } => {
            serde_json::from_str::<Value>(&json)
                .map_err(|e| AppError::msg(format!("Invalid JSON: {e}")))?;
            query(conn, cmd("JSON.SET").arg(key.bytes()?).arg("$").arg(json)).await?;
            ok()
        }
        Expire { key, ttl_ms, .. } => {
            let n = match ttl_ms {
                Some(ttl) if ttl > 0 => {
                    query(conn, cmd("PEXPIRE").arg(key.bytes()?).arg(ttl)).await?
                }
                _ => query(conn, cmd("PERSIST").arg(key.bytes()?)).await?,
            };
            affected(value_int(&n).unwrap_or(0))
        }
        Rename { key, new_key, .. } => {
            let renamed = query(
                conn,
                cmd("RENAMENX").arg(key.bytes()?).arg(new_key.bytes()?),
            )
            .await?;
            if value_int(&renamed) == Some(0) {
                return Err(AppError::msg("A key with the new name already exists"));
            }
            ok()
        }
        Delete { keys, .. } => {
            if keys.is_empty() {
                return Ok(affected(0));
            }
            let keys = keys
                .iter()
                .map(Data::bytes)
                .collect::<AppResult<Vec<_>>>()?;
            affected(unlink(conn, &keys).await?)
        }
        DeleteMatching { pattern, .. } => {
            if pattern.trim().is_empty() {
                return Err(AppError::msg("Enter a pattern of keys to delete"));
            }
            let mut cursor = "0".to_string();
            let mut deleted = 0;
            loop {
                let reply = query(
                    conn,
                    cmd("SCAN")
                        .arg(&cursor)
                        .arg("MATCH")
                        .arg(&pattern)
                        .arg("COUNT")
                        .arg(1000),
                )
                .await?;
                let (next, batch) = scan_reply(reply);
                let keys: Vec<Vec<u8>> = batch.iter().filter_map(value_bytes).collect();
                if !keys.is_empty() {
                    deleted += unlink(conn, &keys).await?;
                }
                cursor = next;
                if cursor == "0" {
                    break;
                }
            }
            affected(deleted)
        }
        Flush { .. } => {
            query(conn, &cmd("FLUSHDB")).await?;
            ok()
        }
        Pipeline { commands, .. } => pipeline(conn, commands).await?,
        Command { args, .. } => {
            let Some(name) = args.first() else {
                return Err(AppError::msg("Enter a command"));
            };
            if let Some(reason) = refused_command(&args) {
                return Err(AppError::msg(reason));
            }
            let mut c = cmd(name);
            for a in &args[1..] {
                c.arg(a);
            }
            // Server errors are replies the console prints, not failures
            let reply = conn.req_packed_command(&c).await?;
            RedisOutput::reply(reply_json(reply))
        }
    })
}

/// Most rejected commands a pipeline reports back.
const MAX_PIPELINE_ERRORS: usize = 20;

async fn pipeline(
    conn: &mut MultiplexedConnection,
    commands: Vec<Vec<Data>>,
) -> AppResult<RedisOutput> {
    let mut p = ::redis::pipe();
    p.ignore_errors();
    for command in &commands {
        let Some((name, args)) = command.split_first() else {
            return Err(AppError::msg("A pipeline command is empty"));
        };
        let Data::Text(name) = name else {
            return Err(AppError::msg("A command name must be text"));
        };
        if let Some(reason) = refused_command(std::slice::from_ref(name)) {
            return Err(AppError::msg(reason));
        }
        p.cmd(name);
        for a in args {
            p.arg(a.bytes()?);
        }
    }
    let results: Vec<::redis::RedisResult<RValue>> = p.query_async(conn).await?;
    let mut failed = 0i64;
    let mut errors = Vec::new();
    for (index, result) in results.into_iter().enumerate() {
        if let Err(e) = result {
            failed += 1;
            if errors.len() < MAX_PIPELINE_ERRORS {
                errors.push(json!({ "index": index, "error": describe_error(&e) }));
            }
        }
    }
    let mut out = affected(commands.len() as i64 - failed);
    out.entries = errors;
    Ok(out)
}

/// UNLINK frees memory in the background; servers before 4.0 only have DEL.
async fn unlink(conn: &mut MultiplexedConnection, keys: &[Vec<u8>]) -> AppResult<i64> {
    let reply = match query(conn, cmd("UNLINK").arg(keys)).await {
        Ok(r) => r,
        Err(_) => query(conn, cmd("DEL").arg(keys)).await?,
    };
    Ok(value_int(&reply).unwrap_or(0))
}

/// `[cursor, [items…]]` → (cursor, items)
fn scan_reply(reply: RValue) -> (String, Vec<RValue>) {
    let mut parts = items(reply).into_iter();
    let cursor = parts
        .next()
        .and_then(|c| value_text(&c))
        .unwrap_or_else(|| "0".into());
    let batch = parts.next().map(items).unwrap_or_default();
    (cursor, batch)
}

async fn scan(
    conn: &mut MultiplexedConnection,
    cursor: Option<String>,
    pattern: Option<String>,
    key_type: Option<String>,
    count: usize,
) -> AppResult<RedisOutput> {
    let pattern = pattern.filter(|p| !p.is_empty()).unwrap_or("*".into());
    let key_type = key_type.filter(|t| !t.is_empty());
    let started = Instant::now();
    let mut cursor = cursor.filter(|c| !c.is_empty()).unwrap_or("0".into());
    let mut keys: Vec<Vec<u8>> = Vec::new();
    let mut scanned = 0u64;
    // A sparse pattern can need many SCAN calls to fill a page; stop at the budget
    // and let the user load more from where this left off
    loop {
        let mut c = cmd("SCAN");
        c.arg(&cursor)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(count.max(100));
        let (next, batch) = scan_reply(query(conn, &c).await?);
        scanned += batch.len() as u64;
        keys.extend(batch.iter().filter_map(value_bytes));
        cursor = next;
        if cursor == "0" || keys.len() >= count || started.elapsed() > SCAN_BUDGET {
            break;
        }
    }
    // SCAN may return a key twice across calls
    let mut seen = std::collections::HashSet::new();
    keys.retain(|k| seen.insert(k.clone()));

    let mut entries = Vec::with_capacity(keys.len());
    for chunk in keys.chunks(500) {
        let mut p = ::redis::pipe();
        for k in chunk {
            p.cmd("TYPE").arg(k).cmd("PTTL").arg(k);
        }
        let replies: Vec<RValue> = p.query_async(conn).await?;
        for (k, pair) in chunk.iter().zip(replies.chunks(2)) {
            let kind = value_text(&pair[0]).unwrap_or_default();
            // Gone between SCAN and TYPE
            if kind == "none" {
                continue;
            }
            if key_type
                .as_deref()
                .is_some_and(|t| !t.eq_ignore_ascii_case(&kind))
            {
                continue;
            }
            entries.push(KeyEntry {
                key: data_json(k),
                kind,
                ttl: value_int(&pair[1]).unwrap_or(-1),
            });
        }
    }
    Ok(RedisOutput {
        kind: "keys",
        keys: entries,
        cursor: (cursor != "0").then_some(cursor),
        scanned,
        ..Default::default()
    })
}

async fn get(
    conn: &mut MultiplexedConnection,
    key: &[u8],
    cursor: Option<String>,
    offset: i64,
    count: usize,
) -> AppResult<RedisOutput> {
    let kind = value_text(&query(conn, cmd("TYPE").arg(key)).await?).unwrap_or_default();
    if kind == "none" {
        return Err(AppError::msg("The key no longer exists"));
    }
    let ttl = value_int(&query(conn, cmd("PTTL").arg(key)).await?).unwrap_or(-1);
    // Not every server or ACL allows these; they're extras
    let encoding = query(conn, cmd("OBJECT").arg("ENCODING").arg(key))
        .await
        .ok()
        .and_then(|v| value_text(&v));
    let memory = query(conn, cmd("MEMORY").arg("USAGE").arg(key))
        .await
        .ok()
        .and_then(|v| value_int(&v));
    let mut out = RedisOutput {
        kind: "key",
        key_type: Some(kind.clone()),
        ttl: Some(ttl),
        encoding,
        memory,
        ..Default::default()
    };
    let cursor = cursor.filter(|c| !c.is_empty());
    let last = offset + count as i64 - 1;
    match kind.as_str() {
        "string" => {
            let len = value_int(&query(conn, cmd("STRLEN").arg(key)).await?).unwrap_or(0);
            let value = if len as usize > MAX_STRING_BYTES {
                out.truncated = true;
                query(
                    conn,
                    cmd("GETRANGE")
                        .arg(key)
                        .arg(0)
                        .arg(MAX_STRING_BYTES as i64 - 1),
                )
                .await?
            } else {
                query(conn, cmd("GET").arg(key)).await?
            };
            out.length = Some(len);
            out.value = Some(
                value_bytes(&value)
                    .map(|b| data_json(&b))
                    .unwrap_or(Value::Null),
            );
        }
        "list" => {
            out.length = value_int(&query(conn, cmd("LLEN").arg(key)).await?);
            let items_ = items(query(conn, cmd("LRANGE").arg(key).arg(offset).arg(last)).await?);
            out.entries = items_
                .iter()
                .enumerate()
                .map(|(i, v)| json!({ "index": offset + i as i64, "value": bytes_json(v) }))
                .collect();
            let next = offset + out.entries.len() as i64;
            out.cursor = (next < out.length.unwrap_or(0)).then(|| next.to_string());
        }
        "hash" => {
            out.length = value_int(&query(conn, cmd("HLEN").arg(key)).await?);
            let (next, found) = scan_collection(conn, "HSCAN", key, cursor, count).await?;
            out.entries = found
                .chunks(2)
                .filter(|p| p.len() == 2)
                .map(|p| json!({ "field": bytes_json(&p[0]), "value": bytes_json(&p[1]) }))
                .collect();
            out.cursor = next;
        }
        "set" => {
            out.length = value_int(&query(conn, cmd("SCARD").arg(key)).await?);
            let (next, found) = scan_collection(conn, "SSCAN", key, cursor, count).await?;
            out.entries = found
                .iter()
                .map(|v| json!({ "value": bytes_json(v) }))
                .collect();
            out.cursor = next;
        }
        "zset" => {
            out.length = value_int(&query(conn, cmd("ZCARD").arg(key)).await?);
            let reply = query(
                conn,
                cmd("ZRANGE")
                    .arg(key)
                    .arg(offset)
                    .arg(last)
                    .arg("WITHSCORES"),
            )
            .await?;
            out.entries = zset_entries(reply, offset);
            let next = offset + out.entries.len() as i64;
            out.cursor = (next < out.length.unwrap_or(0)).then(|| next.to_string());
        }
        "stream" => {
            out.length = value_int(&query(conn, cmd("XLEN").arg(key)).await?);
            // Newest first; the next page continues below the last ID shown
            let end = match &cursor {
                Some(id) => format!("({id}"),
                None => "+".into(),
            };
            let reply = query(
                conn,
                cmd("XREVRANGE")
                    .arg(key)
                    .arg(&end)
                    .arg("-")
                    .arg("COUNT")
                    .arg(count),
            )
            .await?;
            out.entries = stream_entries(reply);
            out.cursor = (out.entries.len() == count)
                .then(|| out.entries.last()?.get("id")?.as_str().map(str::to_string))
                .flatten();
            if let Ok(groups) = query(conn, cmd("XINFO").arg("GROUPS").arg(key)).await {
                out.groups = items(groups).into_iter().map(record_json).collect();
            }
        }
        "ReJSON-RL" => {
            let reply = query(conn, cmd("JSON.GET").arg(key)).await?;
            out.value = value_text(&reply).map(Value::String);
        }
        _ => {}
    }
    Ok(out)
}

fn bytes_json(v: &RValue) -> Value {
    value_bytes(v).map(|b| data_json(&b)).unwrap_or(Value::Null)
}

/// Continues an HSCAN / SSCAN until a page is full or the collection ends.
async fn scan_collection(
    conn: &mut MultiplexedConnection,
    command: &str,
    key: &[u8],
    cursor: Option<String>,
    count: usize,
) -> AppResult<(Option<String>, Vec<RValue>)> {
    let per_item = if command == "HSCAN" { 2 } else { 1 };
    let mut cursor = cursor.unwrap_or("0".into());
    let mut found = Vec::new();
    loop {
        let reply = query(
            conn,
            cmd(command).arg(key).arg(&cursor).arg("COUNT").arg(count),
        )
        .await?;
        let (next, batch) = scan_reply(reply);
        found.extend(batch);
        cursor = next;
        if cursor == "0" || found.len() / per_item >= count {
            break;
        }
    }
    Ok(((cursor != "0").then_some(cursor), found))
}

/// `ZRANGE … WITHSCORES`: flat member/score pairs (RESP2) or [member, score] arrays (RESP3).
fn zset_entries(reply: RValue, offset: i64) -> Vec<Value> {
    let list = items(reply);
    let pairs: Vec<(RValue, RValue)> = if list.iter().all(|v| matches!(v, RValue::Array(_))) {
        list.into_iter()
            .filter_map(|p| {
                let mut p = items(p).into_iter();
                Some((p.next()?, p.next()?))
            })
            .collect()
    } else {
        let mut it = list.into_iter();
        std::iter::from_fn(|| Some((it.next()?, it.next()?))).collect()
    };
    pairs
        .into_iter()
        .enumerate()
        .map(|(i, (m, s))| {
            json!({ "rank": offset + i as i64, "value": bytes_json(&m), "score": value_float(&s) })
        })
        .collect()
}

/// `[[id, [field, value, …]], …]` → `[{id, fields: [[field, value], …]}]`
fn stream_entries(reply: RValue) -> Vec<Value> {
    items(reply)
        .into_iter()
        .filter_map(|entry| {
            let mut parts = items(entry).into_iter();
            let id = value_text(&parts.next()?)?;
            let flat = parts.next().map(items).unwrap_or_default();
            let fields: Vec<Value> = flat
                .chunks(2)
                .filter(|p| p.len() == 2)
                .map(|p| json!([bytes_json(&p[0]), bytes_json(&p[1])]))
                .collect();
            Some(json!({ "id": id, "fields": fields }))
        })
        .collect()
}

/// `[name, value, name, value…]` (or a RESP3 map) → a JSON object.
fn record_json(v: RValue) -> Value {
    let flat = items(v);
    let map = flat
        .chunks(2)
        .filter(|p| p.len() == 2)
        .filter_map(|p| {
            let value = match &p[1] {
                RValue::Int(n) => json!(n),
                RValue::Nil => Value::Null,
                other => value_text(other).map(Value::String).unwrap_or(Value::Null),
            };
            Some((value_text(&p[0])?, value))
        })
        .collect();
    Value::Object(map)
}

/* ---------- Pub/Sub ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PubSubMessage {
    pub channel: String,
    pub pattern: Option<String>,
    pub payload: Value,
    /// Unix time in milliseconds
    pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PubSubBatch {
    pub subscription: String,
    pub messages: Vec<PubSubMessage>,
    /// Messages dropped because they arrived faster than the app shows them
    pub dropped: u64,
    /// Set once when the subscription ends on its own
    pub error: Option<String>,
}

/// Most messages forwarded per batch; the rest of a burst is counted, not sent.
const MAX_BATCH: usize = 500;

/// Subscribes on a dedicated connection and hands batches of messages to `emit`
/// every 100ms until `unsubscribe` (or the connection closing) stops it.
pub async fn subscribe(
    client: &RedisClient,
    id: String,
    channels: Vec<String>,
    patterns: Vec<String>,
    emit: impl Fn(PubSubBatch) + Send + 'static,
) -> AppResult<()> {
    if channels.is_empty() && patterns.is_empty() {
        return Err(AppError::msg("Enter at least one channel or pattern"));
    }
    let connecting = async {
        let mut pubsub = client.client(client.default_db)?.get_async_pubsub().await?;
        for c in &channels {
            pubsub.subscribe(c).await?;
        }
        for p in &patterns {
            pubsub.psubscribe(p).await?;
        }
        AppResult::Ok(pubsub)
    };
    let pubsub = tokio::time::timeout(crate::limits::connect_timeout(), connecting)
        .await
        .map_err(|_| AppError::msg("Timed out subscribing"))??;
    let sub = id.clone();
    let task = tokio::spawn(async move {
        let mut stream = pubsub.into_on_message();
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        let mut pending: Vec<PubSubMessage> = Vec::new();
        let mut dropped = 0u64;
        loop {
            tokio::select! {
                msg = stream.next() => match msg {
                    Some(msg) => {
                        if pending.len() >= MAX_BATCH {
                            dropped += 1;
                            continue;
                        }
                        pending.push(PubSubMessage {
                            channel: msg.get_channel_name().to_string(),
                            pattern: msg
                                .from_pattern()
                                .then(|| msg.get_pattern::<String>().ok())
                                .flatten(),
                            payload: data_json(msg.get_payload_bytes()),
                            at: chrono::Utc::now().timestamp_millis(),
                        });
                    }
                    None => {
                        emit(PubSubBatch {
                            subscription: sub.clone(),
                            messages: std::mem::take(&mut pending),
                            dropped,
                            error: Some("The server closed the subscription".into()),
                        });
                        return;
                    }
                },
                _ = tick.tick() => {
                    if !pending.is_empty() || dropped > 0 {
                        emit(PubSubBatch {
                            subscription: sub.clone(),
                            messages: std::mem::take(&mut pending),
                            dropped: std::mem::take(&mut dropped),
                            error: None,
                        });
                    }
                }
            }
        }
    });
    if let Some(old) = client.subscriptions.lock().insert(id, task.abort_handle()) {
        old.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn classifies_read_commands() {
        assert!(is_read_command(&args("get k")));
        assert!(is_read_command(&args("HGETALL h")));
        assert!(is_read_command(&args("config get maxmemory")));
        assert!(is_read_command(&args("XINFO STREAM s")));
        assert!(!is_read_command(&args("SET k v")));
        assert!(!is_read_command(&args("config set maxmemory 1")));
        assert!(!is_read_command(&args("FLUSHALL")));
        assert!(!is_read_command(&args("EVAL return 1 0")));
        assert!(is_read_command(&args("ACL LOG")));
        assert!(is_read_command(&args("acl log 10")));
        assert!(!is_read_command(&args("ACL LOG RESET")));
        assert!(!is_read_command(&args("acl log reset")));
    }

    #[test]
    fn refuses_connection_state_commands() {
        assert!(refused_command(&args("select 2")).is_some());
        assert!(refused_command(&args("SUBSCRIBE news")).is_some());
        assert!(refused_command(&args("GET k")).is_none());
    }

    #[test]
    fn data_round_trips_binary() {
        let bytes = vec![0u8, 255, 16];
        let json = data_json(&bytes);
        assert_eq!(json, json!({ "$hex": "00ff10" }));
        let back: Data = serde_json::from_value(json).unwrap();
        assert_eq!(back.bytes().unwrap(), bytes);
        let text: Data = serde_json::from_value(json!("user:1")).unwrap();
        assert_eq!(text.bytes().unwrap(), b"user:1");
    }

    #[test]
    fn parses_database_numbers() {
        assert_eq!(database_index("").unwrap(), 0);
        assert_eq!(database_index("3").unwrap(), 3);
        assert_eq!(database_index("db12").unwrap(), 12);
        assert!(database_index("-1").is_err());
        assert!(database_index("cache").is_err());
    }

    #[test]
    fn parses_info_and_keyspace() {
        let info = parse_info(
            "# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n\r\n# Keyspace\r\ndb0:keys=12,expires=3,avg_ttl=0\r\n",
        );
        assert_eq!(info["redis_version"], "7.2.4");
        assert_eq!(keyspace_field(&info["db0"], "keys"), Some(12));
        assert_eq!(keyspace_field(&info["db0"], "expires"), Some(3));
    }

    #[test]
    fn reads_zset_replies_in_both_protocols() {
        let resp2 = RValue::Array(vec![
            RValue::BulkString(b"a".to_vec()),
            RValue::BulkString(b"1.5".to_vec()),
            RValue::BulkString(b"b".to_vec()),
            RValue::BulkString(b"2".to_vec()),
        ]);
        let entries = zset_entries(resp2, 10);
        assert_eq!(
            entries[0],
            json!({ "rank": 10, "value": "a", "score": 1.5 })
        );
        assert_eq!(entries[1]["score"], json!(2.0));
        let resp3 = RValue::Array(vec![RValue::Array(vec![
            RValue::BulkString(b"a".to_vec()),
            RValue::Double(3.0),
        ])]);
        assert_eq!(zset_entries(resp3, 0)[0]["score"], json!(3.0));
    }

    #[test]
    fn reads_stream_entries() {
        let reply = RValue::Array(vec![RValue::Array(vec![
            RValue::BulkString(b"1-0".to_vec()),
            RValue::Array(vec![
                RValue::BulkString(b"temp".to_vec()),
                RValue::BulkString(b"21".to_vec()),
            ]),
        ])]);
        assert_eq!(
            stream_entries(reply),
            vec![json!({ "id": "1-0", "fields": [["temp", "21"]] })]
        );
    }

    #[test]
    fn tags_console_replies() {
        assert_eq!(
            reply_json(RValue::Okay),
            json!({ "t": "status", "v": "OK" })
        );
        assert_eq!(reply_json(RValue::Nil), json!({ "t": "nil" }));
        assert_eq!(
            reply_json(RValue::Array(vec![
                RValue::Int(1),
                RValue::BulkString(b"x".to_vec())
            ])),
            json!({ "t": "array", "v": [{ "t": "int", "v": 1 }, { "t": "bulk", "v": "x" }] })
        );
    }

    fn cfg(extra: Value) -> ConnectionConfig {
        let mut base = json!({ "id": "x", "name": "x", "engine": "redis", "host": "cache.local" });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    fn insecure(info: &ConnectionInfo) -> Option<bool> {
        match info.addr() {
            ConnectionAddr::TcpTls { insecure, .. } => Some(*insecure),
            _ => None,
        }
    }

    #[test]
    fn maps_tls_modes() {
        // The verify modes encrypt and verify, whatever Trust server certificate says
        for mode in ["verify-full", "verify-ca"] {
            let c = cfg(json!({ "ssl": mode, "trustServerCertificate": true }));
            assert_eq!(
                insecure(&connection_info(&c, None).unwrap()),
                Some(false),
                "{mode}"
            );
        }
        let c = cfg(json!({ "ssl": "require", "trustServerCertificate": true }));
        assert_eq!(insecure(&connection_info(&c, None).unwrap()), Some(true));
        // Prefer has no opportunistic TLS on Redis; Disable overrides rediss://
        assert_eq!(
            insecure(&connection_info(&cfg(json!({})), None).unwrap()),
            None
        );
        let c = cfg(json!({ "ssl": "disable", "uri": "rediss://cache.local:6380" }));
        assert_eq!(insecure(&connection_info(&c, None).unwrap()), None);
        let c = cfg(json!({ "ssl": "verify-full", "uri": "rediss://cache.local:6380/#insecure" }));
        assert_eq!(insecure(&connection_info(&c, None).unwrap()), Some(false));
    }

    #[test]
    fn refuses_tls_settings_it_cannot_honour() {
        let c = cfg(json!({ "sslRootCert": "ca.pem" }));
        assert!(
            connection_info(&c, None).is_err(),
            "certificates without TLS"
        );
        let c = cfg(json!({ "ssl": "require", "sslClientCert": "me.p12" }));
        let err = connection_info(&c, None).unwrap_err().to_string();
        assert!(err.contains("PEM"), "{err}");
        let mut c = cfg(json!({ "ssl": "verify-full" }));
        c.tunneled = Some(("cache.local".into(), 6380));
        assert!(
            connection_info(&c, None).is_err(),
            "host name check through a tunnel"
        );
        c.ssl = SslMode::VerifyCa;
        assert!(connection_info(&c, None).is_ok());
    }

    #[test]
    fn builds_connection_info_from_fields_and_uris() {
        let mut cfg: ConnectionConfig = serde_json::from_value(json!({
            "id": "x", "name": "x", "engine": "redis", "host": "cache.local", "port": 6380,
            "user": "app", "ssl": "require", "trustServerCertificate": true
        }))
        .unwrap();
        let info = connection_info(&cfg, Some("pw")).unwrap();
        assert!(
            matches!(info.addr(), ConnectionAddr::TcpTls { host, port: 6380, insecure: true, .. } if host == "cache.local")
        );
        assert_eq!(info.redis_settings().username(), Some("app"));
        assert_eq!(info.redis_settings().password(), Some("pw"));

        cfg.ssl = SslMode::Prefer;
        cfg.uri = "redis://:secret@localhost:6379/4".into();
        let info = connection_info(&cfg, Some("ignored")).unwrap();
        assert!(matches!(info.addr(), ConnectionAddr::Tcp(_, 6379)));
        assert_eq!(info.redis_settings().password(), Some("secret"));
        assert_eq!(info.redis_settings().db(), 4);
    }
}
