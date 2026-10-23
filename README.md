# dbms-tool

A free, open-source, developer-focused database client for **PostgreSQL**, **MySQL / MariaDB**,
**SQL Server**, **Babelfish for Aurora PostgreSQL** and **MongoDB**. Built with Tauri 2, Rust and
React.

The aim is the directness of SSMS and pgAdmin, with MongoDB treated as a first-class citizen
rather than a plugin, in a fast native app that doesn't get in your way.

## Features

**Everywhere**

- Object explorer per engine: pgAdmin-style schemas for PostgreSQL, SSMS-style folders for SQL
  Server and Babelfish, databases and collections for MongoDB. Row estimates, sizes, columns,
  indexes and foreign keys inline.
- Command palette (`Ctrl+K`) that searches connections, tables, views, routines and collections.
- Every editor tab gets its own server session, so transactions, temp tables and `USE` behave the
  way they do in SSMS or psql.
- Connection colours (tinting tabs and the status bar), groups, read-only connections, and
  connection-string paste (`postgres://`, `mysql://`, `mongodb+srv://`, ADO.NET).
- Passwords stored in the OS credential manager, never on disk.
- Query history, file open/save, and tabs that survive restarts.
- Dark and light themes (or follow the OS) with a title-bar toggle, an accent override, and a
  theme editor with live preview and JSON import/export for sharing.

**Cloud**

- Finds databases in AWS (RDS, Aurora, DocumentDB), Google Cloud (Cloud SQL) and Azure (PostgreSQL
  and MySQL flexible servers, Azure SQL) and connects with host, user and TLS filled in, including
  the master password when AWS keeps it in Secrets Manager.
- Provisioning designer for new databases: engine, version, size, storage, credentials and network
  access (just this machine, anywhere, or private), with a preview of the exact CLI commands. The
  connection is saved once the database is ready.
- Works through the official `aws`, `gcloud` and `az` CLIs, so existing profiles, SSO and MFA
  apply; passwords reach the CLI in a temporary file, never on the command line.

**SQL**

- CodeMirror editor with dialect-aware highlighting and schema completion.
- `F5` / `Ctrl+E` runs the selection or the whole script; `Ctrl+Enter` runs the statement at the
  cursor; `Ctrl+L` explains it. SQL Server scripts understand `GO` and `GO n`.
- Multiple result sets, messages (`PRINT`, `RAISE NOTICE`, row counts, warnings) and error
  positions underlined in the editor.
- Real cancellation (PostgreSQL cancel requests, MySQL `KILL QUERY`, TDS attention).
- Virtualised results grid: SSMS-style cell, row and column selection; copy as TSV, CSV, JSON,
  Markdown or `INSERT`; quick filter; value inspector with JSON pretty-printing; sum and average
  of numeric selections.
- Table browser with paging, `WHERE` filter, server-side sort, and inline editing (insert, update,
  delete) applied in one transaction after you review the generated SQL.
- Structure view, generated or server-provided DDL, and "Script as SELECT/INSERT/UPDATE/DELETE/
  CREATE/DROP".
- Stored procedures and functions: parameters (with IN/OUT modes) and return types in the
  explorer, an Execute dialog that builds the right `EXEC` / `CALL` / `SELECT` (capturing OUTPUT
  parameters), Modify (ALTER) scripts, and new procedure/function templates per engine.
- Confirmation before `DELETE`/`UPDATE` without `WHERE`, `DROP` and `TRUNCATE`.

**Babelfish**

- Connects over the TDS endpoint and is auto-detected from `SERVERPROPERTY('BabelfishVersion')`.
- Metadata queries fall back to `INFORMATION_SCHEMA` where Babelfish doesn't implement a catalog
  view.
- Server page lists escape hatches (`sp_babelfish_configure`); Explain uses
  `BABELFISH_SHOWPLAN_ALL` / `BABELFISH_STATISTICS PROFILE`.

**MongoDB**

- mongosh-style shell: `db.orders.find({ … }).sort({ … }).limit(20)`, `aggregate`, `insertMany`,
  `updateOne`, `createIndex`, `use`, `show dbs`, `ObjectId()`, `ISODate()`, `NumberLong()` and
  more, with completion for collections, methods and `$` operators.
- Collection browser in the spirit of Compass: filter, projection and sort; list, table and JSON
  views; edit, clone, insert and delete documents with BSON types preserved.
- Aggregation pipeline builder with per-stage previews and export to shell.
- Schema analysis over a `$sample`: field paths, presence and type mix.
- Index management with usage statistics, and explain with collection-scan warnings.

## Install

### macOS

Install or update to the latest release with one command:

```sh
curl -fsSL https://raw.githubusercontent.com/asofianidis/dbms-tool/main/scripts/install-mac.sh | bash
```

It downloads the universal build (Apple Silicon and Intel), quits the app if it's running,
replaces `/Applications/dbms-tool.app` and opens it. From a clone, `bash scripts/install-mac.sh`
does the same. Because the script downloads with `curl`, macOS doesn't mark the app as
quarantined, so Gatekeeper doesn't block it even when the build isn't notarized.

If you download the `.dmg` in a browser instead and macOS says it can't verify the developer, open
**System Settings → Privacy & Security** and click **Open Anyway** (or run
`xattr -dr com.apple.quarantine /Applications/dbms-tool.app`).

### Windows and Linux

Download the latest build from
[Releases](https://github.com/asofianidis/dbms-tool/releases/latest). The app updates itself;
updates are signed and verified before they install. Every download is listed in
`SHA256SUMS.txt` and has a GitHub build-provenance attestation
(`gh attestation verify <file> --repo asofianidis/dbms-tool`).

## Development

Prerequisites: Node 20+, pnpm, and Rust (stable) with the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
pnpm install
pnpm tauri dev        # run the app
pnpm test             # frontend unit tests
pnpm typecheck
pnpm test:rust        # backend unit tests
pnpm tauri build      # installer / bundle
```

### Live database tests

The backend has end-to-end tests for every engine. They run only when the matching
`DBMS_TEST_*` variable is set. `scripts/test-databases.sh` starts throwaway containers (it needs
Docker and about 4 GB of free memory for all five):

```sh
./scripts/test-databases.sh up
eval "$(./scripts/test-databases.sh env)"
cd src-tauri && cargo test -- --test-threads=1
./scripts/test-databases.sh down
```

### CI and releases

`ci.yml` runs formatting, type checks, unit tests, clippy and the Rust tests on Windows, macOS and
Linux, plus the live database suite against all five engines. `release.yml` builds and publishes
signed installers; see [docs/RELEASING.md](docs/RELEASING.md) for versioning and the signing
secrets.

### Layout

```
src/                     React frontend
  components/            UI primitives, grid, editor, dialogs, shell (title bar, tabs, status bar)
  features/              explorer, query, table, mongo, server, settings, history, welcome
  lib/                   API bindings, SQL and Mongo helpers, stores
src-tauri/src/
  drivers/               postgres (tokio-postgres), mysql (mysql_async),
                         mssql (tiberius; SQL Server + Babelfish), mongo (official driver)
  manager.rs             open connections and per-tab sessions, cancellation
  commands.rs            Tauri command surface
  cloud.rs               runs the aws / gcloud / az CLIs for cloud discovery and provisioning
src-tauri/vendor/tiberius  tiberius 0.13 with small patches (see PATCHES.md)
```

## License

MIT
