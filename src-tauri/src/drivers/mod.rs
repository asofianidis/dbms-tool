pub mod mongo;
pub mod mongo_srv;
pub mod mssql;
pub mod mysql;
pub mod postgres;
pub mod sqlite;
pub mod tls;

use crate::config::{AuthMode, ConnectionConfig, Engine, SslMode};
use crate::error::{AppError, AppResult};
use crate::model::*;

/// One live SQL connection. Each editor tab gets its own so transactions,
/// temp tables and `USE` behave the way they do in SSMS or psql.
// Sessions are few and long-lived, so variant size doesn't matter
#[allow(clippy::large_enum_variant)]
pub enum Session {
    Pg(postgres::PgSession),
    My(mysql::MySession),
    Ms(mssql::MsSession),
    Sq(sqlite::SqSession),
}

impl Session {
    pub async fn connect(
        config: &ConnectionConfig,
        password: Option<&str>,
        database: &str,
    ) -> AppResult<Session> {
        // Fetched per connection (tokens expire); always over TLS, since MySQL
        // sends the token in clear text
        let token;
        let cloud_config;
        let (config, password) = if config.auth == AuthMode::Cloud {
            token = crate::cloud::database_token(config).await?;
            cloud_config = ConnectionConfig {
                // At least Require; a stricter verify mode stays
                ssl: if config.ssl.required() {
                    config.ssl
                } else {
                    SslMode::Require
                },
                ..config.clone()
            };
            (&cloud_config, Some(token.as_str()))
        } else {
            (config, password)
        };
        Ok(match config.engine {
            Engine::Postgres => Session::Pg(postgres::connect(config, password, database).await?),
            Engine::Mysql => Session::My(mysql::connect(config, password, database).await?),
            Engine::Mssql | Engine::Babelfish => {
                Session::Ms(mssql::connect(config, password, database).await?)
            }
            Engine::Sqlite => Session::Sq(sqlite::connect(config, password).await?),
            Engine::Mongo => {
                return Err(AppError::Unsupported(
                    "MongoDB doesn't use SQL sessions".into(),
                ));
            }
        })
    }

    pub fn database(&self) -> &str {
        match self {
            Session::Pg(s) => &s.database,
            Session::My(s) => &s.database,
            Session::Ms(s) => &s.database,
            Session::Sq(s) => &s.database,
        }
    }

    /// Known-bad without a round trip (closed socket, failed cancel).
    pub fn is_broken(&self) -> bool {
        match self {
            Session::Pg(s) => s.is_closed(),
            Session::My(s) => s.broken,
            Session::Ms(s) => s.broken,
            Session::Sq(_) => false,
        }
    }

    pub async fn is_alive(&mut self) -> bool {
        match self {
            Session::Pg(s) => !s.is_closed(),
            Session::My(s) => s.ping().await,
            Session::Ms(s) => s.ping().await,
            Session::Sq(_) => true,
        }
    }

    pub async fn server_info(&mut self) -> AppResult<ServerInfo> {
        match self {
            Session::Pg(s) => s.server_info().await,
            Session::My(s) => s.server_info().await,
            Session::Ms(s) => s.server_info().await,
            Session::Sq(s) => s.server_info().await,
        }
    }

    /// Whether a transaction is open (or failed and awaiting ROLLBACK); `None`
    /// when the engine can't tell.
    pub async fn in_transaction(&mut self) -> Option<bool> {
        match self {
            Session::Pg(s) => s.in_transaction().await,
            Session::My(s) => s.in_transaction().await,
            Session::Ms(s) => s.in_transaction().await,
            Session::Sq(s) => s.in_transaction(),
        }
    }

    pub async fn execute(
        &mut self,
        sql: &str,
        opts: &ExecOptions,
        cancel: &CancelSignal,
    ) -> ExecOutput {
        match self {
            Session::Pg(s) => s.execute(sql, opts, cancel).await,
            Session::My(s) => s.execute(sql, opts, cancel).await,
            Session::Ms(s) => s.execute(sql, opts, cancel).await,
            Session::Sq(s) => s.execute(sql, opts, cancel).await,
        }
    }
}
