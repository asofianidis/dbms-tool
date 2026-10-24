//! Timeouts the user can change in Settings. The frontend pushes them with
//! `limits_set` at startup and whenever they change.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const DEFAULT_CONNECT_SECS: u64 = 15;

static CONNECT_SECS: AtomicU64 = AtomicU64::new(DEFAULT_CONNECT_SECS);

/// How long opening a database connection may take, TCP connect and handshake included.
pub fn connect_timeout() -> Duration {
    Duration::from_secs(CONNECT_SECS.load(Ordering::Relaxed))
}

pub fn set_connect_timeout(secs: u64) {
    CONNECT_SECS.store(secs.clamp(1, 600), Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_timeout_is_clamped() {
        set_connect_timeout(0);
        assert_eq!(connect_timeout(), Duration::from_secs(1));
        set_connect_timeout(10_000);
        assert_eq!(connect_timeout(), Duration::from_secs(600));
        set_connect_timeout(DEFAULT_CONNECT_SECS);
    }
}
