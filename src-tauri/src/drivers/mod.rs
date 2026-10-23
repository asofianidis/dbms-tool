pub mod mongo;
pub mod mssql;
pub mod mysql;
pub mod postgres;

use crate::config::{ConnectionConfig, Engine};
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
}

impl Session {
    pub async fn connect(
        config: &ConnectionConfig,
        password: Option<&str>,
        database: &str,
    ) -> AppResult<Session> {
        Ok(match config.engine {
            Engine::Postgres => Session::Pg(postgres::connect(config, password, database).await?),
            Engine::Mysql => Session::My(mysql::connect(config, password, database).await?),
            Engine::Mssql | Engine::Babelfish => {
                Session::Ms(mssql::connect(config, password, database).await?)
            }
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
        }
    }

    /// Known-bad without a round trip (closed socket, failed cancel).
    pub fn is_broken(&self) -> bool {
        match self {
            Session::Pg(s) => s.is_closed(),
            Session::My(_) => false,
            Session::Ms(s) => s.broken,
        }
    }

    pub async fn is_alive(&mut self) -> bool {
        match self {
            Session::Pg(s) => !s.is_closed(),
            Session::My(s) => s.ping().await,
            Session::Ms(s) => s.ping().await,
        }
    }

    pub async fn server_info(&mut self) -> AppResult<ServerInfo> {
        match self {
            Session::Pg(s) => s.server_info().await,
            Session::My(s) => s.server_info().await,
            Session::Ms(s) => s.server_info().await,
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
        }
    }
}
