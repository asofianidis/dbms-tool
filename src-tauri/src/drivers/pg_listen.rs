//! LISTEN / NOTIFY for the Notifications tab. Each tab listens on a dedicated
//! PostgreSQL session of its own, since LISTEN lasts as long as the session
//! and editor sessions come and go. Notifications reach the UI in batches.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Mutex;

use super::Session;
use super::postgres::{PgNotification, PgSession};
use crate::config::{ConnectionConfig, Engine};
use crate::error::{AppError, AppResult};

/// Longest channel name PostgreSQL keeps (NAMEDATALEN - 1); LISTEN would truncate it.
const MAX_CHANNEL: usize = 63;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyBatch {
    pub listener: String,
    pub notifications: Vec<PgNotification>,
    /// Notifications dropped because they arrived faster than the app shows them
    pub dropped: u64,
    /// Set once when the listening session ends on its own
    pub error: Option<String>,
}

struct Listener {
    session: Mutex<PgSession>,
    channels: parking_lot::Mutex<BTreeSet<String>>,
    task: tokio::task::AbortHandle,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The listening sessions of one connection, by listener id (the tab's id).
#[derive(Default)]
pub struct Listeners {
    open: Mutex<HashMap<String, Arc<Listener>>>,
}

/// `"name"`, as LISTEN takes it: case and spaces kept, like `pg_notify()`'s channel.
pub fn quote_channel(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn check_channel(name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::msg("Enter a channel name"));
    }
    if name.len() > MAX_CHANNEL {
        return Err(AppError::msg(format!(
            "Channel names are at most {MAX_CHANNEL} bytes: {name}"
        )));
    }
    Ok(())
}

fn statement(verb: &str, channels: &[String]) -> String {
    channels
        .iter()
        .map(|c| format!("{verb} {};", quote_channel(c)))
        .collect::<Vec<_>>()
        .join(" ")
}

impl Listeners {
    /// The listener `id`, opened (or reopened after its session ended) on `database`.
    async fn ensure(
        &self,
        config: &ConnectionConfig,
        password: Option<&str>,
        id: &str,
        database: &str,
        emit: impl Fn(NotifyBatch) + Send + 'static,
    ) -> AppResult<Arc<Listener>> {
        if config.engine != Engine::Postgres {
            return Err(AppError::Unsupported(
                "LISTEN / NOTIFY needs a PostgreSQL connection".into(),
            ));
        }
        // Held while connecting so two calls can't open two sessions for one tab
        let mut open = self.open.lock().await;
        if let Some(listener) = open.get(id) {
            let session = listener.session.lock().await;
            if !session.is_closed() && session.database.eq_ignore_ascii_case(database) {
                return Ok(listener.clone());
            }
        }
        // A dropped SSH or Fly tunnel comes back on the same port
        crate::tunnel::ensure(&config.id).await?;
        let Session::Pg(session) = Session::connect(config, password, database).await? else {
            return Err(AppError::Unsupported(
                "LISTEN / NOTIFY needs a PostgreSQL connection".into(),
            ));
        };
        let inbox = session.inbox();
        let listener_id = id.to_string();
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            loop {
                tick.tick().await;
                let (notifications, dropped, closed) = {
                    let mut inbox = inbox.lock();
                    let (items, dropped) = inbox.take();
                    (items, dropped, inbox.closed.clone())
                };
                if !notifications.is_empty() || dropped > 0 || closed.is_some() {
                    emit(NotifyBatch {
                        listener: listener_id.clone(),
                        notifications,
                        dropped,
                        error: closed.clone(),
                    });
                }
                if closed.is_some() {
                    return;
                }
            }
        });
        let listener = Arc::new(Listener {
            session: Mutex::new(session),
            channels: parking_lot::Mutex::new(BTreeSet::new()),
            task: task.abort_handle(),
        });
        open.insert(id.to_string(), listener.clone());
        Ok(listener)
    }

    /// Adds `channels` to what listener `id` listens on; returns them all.
    pub async fn listen(
        &self,
        config: &ConnectionConfig,
        password: Option<&str>,
        id: &str,
        database: &str,
        channels: Vec<String>,
        emit: impl Fn(NotifyBatch) + Send + 'static,
    ) -> AppResult<Vec<String>> {
        for c in &channels {
            check_channel(c)?;
        }
        let listener = self.ensure(config, password, id, database, emit).await?;
        if !channels.is_empty() {
            let session = listener.session.lock().await;
            session
                .client()
                .batch_execute(&statement("LISTEN", &channels))
                .await
                .map_err(|e| AppError::msg(super::postgres::describe_error(&e)))?;
        }
        let mut active = listener.channels.lock();
        active.extend(channels);
        Ok(active.iter().cloned().collect())
    }

    /// Stops listening on `channels`, or on everything when empty; returns what's left.
    pub async fn unlisten(&self, id: &str, channels: Vec<String>) -> AppResult<Vec<String>> {
        let Some(listener) = self.open.lock().await.get(id).cloned() else {
            return Ok(Vec::new());
        };
        let sql = if channels.is_empty() {
            "UNLISTEN *".to_string()
        } else {
            statement("UNLISTEN", &channels)
        };
        {
            let session = listener.session.lock().await;
            // A closed session listens on nothing anyway
            if !session.is_closed() {
                session
                    .client()
                    .batch_execute(&sql)
                    .await
                    .map_err(|e| AppError::msg(super::postgres::describe_error(&e)))?;
            }
        }
        let mut active = listener.channels.lock();
        if channels.is_empty() {
            active.clear();
        } else {
            for c in &channels {
                active.remove(c);
            }
        }
        Ok(active.iter().cloned().collect())
    }

    /// `pg_notify(channel, payload)` from listener `id`'s session.
    #[allow(clippy::too_many_arguments)]
    pub async fn notify(
        &self,
        config: &ConnectionConfig,
        password: Option<&str>,
        id: &str,
        database: &str,
        channel: &str,
        payload: &str,
        emit: impl Fn(NotifyBatch) + Send + 'static,
    ) -> AppResult<()> {
        check_channel(channel)?;
        let listener = self.ensure(config, password, id, database, emit).await?;
        let session = listener.session.lock().await;
        session
            .client()
            .execute("SELECT pg_notify($1, $2)", &[&channel, &payload])
            .await
            .map_err(|e| AppError::msg(super::postgres::describe_error(&e)))?;
        Ok(())
    }

    /// Unlistens and closes listener `id`'s session.
    pub async fn close(&self, id: &str) {
        let Some(listener) = self.open.lock().await.remove(id) else {
            return;
        };
        let session = listener.session.lock().await;
        if !session.is_closed() {
            // Closing the session unlistens too; this just says so to the server first
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                session.client().batch_execute("UNLISTEN *"),
            )
            .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_channels_as_identifiers() {
        assert_eq!(quote_channel("jobs"), "\"jobs\"");
        assert_eq!(quote_channel("My \"chan\""), "\"My \"\"chan\"\"\"");
        assert_eq!(
            statement("LISTEN", &["a".into(), "B c".into()]),
            "LISTEN \"a\"; LISTEN \"B c\";"
        );
    }

    #[test]
    fn checks_channel_names() {
        assert!(check_channel("jobs").is_ok());
        assert!(check_channel("").is_err());
        assert!(check_channel(&"x".repeat(63)).is_ok());
        assert!(check_channel(&"x".repeat(64)).is_err());
    }
}
