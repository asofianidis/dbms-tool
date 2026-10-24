use serde::{Serialize, Serializer};

/// Error returned to the frontend as `{ code, message }`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),
    #[error("A password is required to connect")]
    PasswordRequired,
    #[error("Not connected")]
    NotConnected,
    #[error("Connection not found")]
    UnknownConnection,
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl AppError {
    pub fn msg(message: impl Into<String>) -> Self {
        AppError::Message(message.into())
    }

    fn code(&self) -> &'static str {
        match self {
            AppError::Message(_) => "error",
            AppError::PasswordRequired => "password_required",
            AppError::NotConnected => "not_connected",
            AppError::UnknownConnection => "unknown_connection",
            AppError::Unsupported(_) => "unsupported",
            AppError::Io(_) => "io",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

impl From<tokio_postgres::Error> for AppError {
    fn from(e: tokio_postgres::Error) -> Self {
        AppError::Message(crate::drivers::postgres::describe_error(&e))
    }
}

impl From<mysql_async::Error> for AppError {
    fn from(e: mysql_async::Error) -> Self {
        AppError::Message(crate::drivers::mysql::describe_error(&e))
    }
}

impl From<tiberius::error::Error> for AppError {
    fn from(e: tiberius::error::Error) -> Self {
        AppError::Message(crate::drivers::mssql::describe_error(&e))
    }
}

impl From<mongodb::error::Error> for AppError {
    fn from(e: mongodb::error::Error) -> Self {
        AppError::Message(crate::drivers::mongo::describe_error(&e))
    }
}

impl From<redis::RedisError> for AppError {
    fn from(e: redis::RedisError) -> Self {
        AppError::Message(crate::drivers::redis::describe_error(&e))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Message(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
