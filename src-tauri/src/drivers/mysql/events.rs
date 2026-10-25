//! Scheduled events (`CREATE EVENT … ON SCHEDULE …`), listed in the explorer
//! beside tables and routines. MySQL and MariaDB share information_schema.EVENTS.

use mysql_async::Row;

use crate::model::DbObject;

use super::text;

/// Columns: name, status, event type, execute at, interval value, interval
/// field, starts, ends, last executed, definer, comment. Timestamps are cast to
/// text, since bound parameters switch to the binary protocol.
pub const LIST_SQL: &str = "SELECT event_name, status, event_type, CAST(execute_at AS CHAR), \
       interval_value, interval_field, CAST(starts AS CHAR), CAST(ends AS CHAR), \
       CAST(last_executed AS CHAR), definer, event_comment \
     FROM information_schema.events WHERE event_schema = ? ORDER BY event_name";

/// One row of [`LIST_SQL`], before it becomes a [`DbObject`].
#[derive(Debug, Default)]
pub struct EventFields {
    pub status: Option<String>,
    pub event_type: Option<String>,
    pub execute_at: Option<String>,
    pub interval_value: Option<String>,
    pub interval_field: Option<String>,
    pub starts: Option<String>,
    pub ends: Option<String>,
    pub last_executed: Option<String>,
    pub definer: Option<String>,
}

impl EventFields {
    /// The schedule in `CREATE EVENT` syntax: `AT …` or `EVERY n FIELD STARTS … ENDS …`
    pub fn schedule(&self) -> String {
        if self.event_type.as_deref() == Some("ONE TIME") {
            return format!("AT {}", self.execute_at.as_deref().unwrap_or("?"));
        }
        let mut parts = vec![
            "EVERY".to_string(),
            self.interval_value.clone().unwrap_or_else(|| "?".into()),
            self.interval_field.clone().unwrap_or_default(),
        ];
        if let Some(starts) = &self.starts {
            parts.push(format!("STARTS {starts}"));
        }
        if let Some(ends) = &self.ends {
            parts.push(format!("ENDS {ends}"));
        }
        parts.retain(|p| !p.is_empty());
        parts.join(" ")
    }

    /// `STATUS · schedule · last run … · definer …`; the frontend reads the
    /// status from the first part (see `src/lib/events.ts`).
    pub fn detail(&self) -> String {
        let mut parts = vec![
            self.status.clone().unwrap_or_else(|| "ENABLED".into()),
            self.schedule(),
        ];
        if let Some(last) = &self.last_executed {
            parts.push(format!("last run {last}"));
        }
        if let Some(definer) = &self.definer {
            parts.push(format!("definer {definer}"));
        }
        parts.join(" · ")
    }
}

pub fn object(r: &Row) -> DbObject {
    let fields = EventFields {
        status: text(r, 1),
        event_type: text(r, 2),
        execute_at: text(r, 3),
        interval_value: text(r, 4),
        interval_field: text(r, 5),
        starts: text(r, 6),
        ends: text(r, 7),
        last_executed: text(r, 8),
        definer: text(r, 9),
    };
    DbObject {
        schema: None,
        name: text(r, 0).unwrap_or_default(),
        kind: "event".into(),
        detail: Some(fields.detail()),
        comment: text(r, 10).filter(|c| !c.is_empty()),
        row_estimate: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Option<String> {
        Some(v.into())
    }

    #[test]
    fn recurring_event_detail() {
        let e = EventFields {
            status: s("DISABLED"),
            event_type: s("RECURRING"),
            interval_value: s("1"),
            interval_field: s("HOUR"),
            starts: s("2026-01-01 00:00:00"),
            ends: s("2030-01-01 00:00:00"),
            last_executed: s("2026-10-25 10:00:00"),
            definer: s("root@localhost"),
            ..Default::default()
        };
        assert_eq!(
            e.detail(),
            "DISABLED · EVERY 1 HOUR STARTS 2026-01-01 00:00:00 ENDS 2030-01-01 00:00:00 \
             · last run 2026-10-25 10:00:00 · definer root@localhost"
        );
    }

    #[test]
    fn one_time_event_detail() {
        let e = EventFields {
            status: s("SLAVESIDE_DISABLED"),
            event_type: s("ONE TIME"),
            execute_at: s("2030-05-01 12:00:00"),
            ..Default::default()
        };
        assert_eq!(e.detail(), "SLAVESIDE_DISABLED · AT 2030-05-01 12:00:00");
    }

    #[test]
    fn recurring_without_bounds() {
        let e = EventFields {
            event_type: s("RECURRING"),
            interval_value: s("'1:30'"),
            interval_field: s("HOUR_MINUTE"),
            ..Default::default()
        };
        assert_eq!(e.schedule(), "EVERY '1:30' HOUR_MINUTE");
    }
}
