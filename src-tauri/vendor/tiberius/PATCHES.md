# Local patches to tiberius 0.13.0

Vendored from crates.io so the query editor can show SSMS-style output. Changes:

- `QueryItem::Done(Option<u64>)` for every DONE / DONEINPROC / DONEPROC token, carrying the row
  count when the server sets `DONE_COUNT`.
- `QueryItem::Message(ServerMessage)` for INFO (`PRINT`, `RAISERROR` with low severity) and ERROR
  tokens, so errors in the middle of a batch don't hide earlier output.
- `QueryItem::DatabaseChanged(String)` for the database ENVCHANGE token (`USE`).
- `Client::simple_query_all`, which is `simple_query` without skipping tokens that arrive before the
  first result set.
- `TokenDone::has_count`.

Everything else is unchanged from the published crate (MIT / Apache-2.0, see the license files).
