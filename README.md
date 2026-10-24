# dbms-tool

A free, open-source, developer-focused database client for **PostgreSQL**, **MySQL / MariaDB**,
**SQL Server**, **Babelfish for Aurora PostgreSQL**, **MongoDB**, **Redis** (and Valkey, KeyDB,
Dragonfly) and **SQLite** (local files and Cloudflare D1). Built with Tauri 2, Rust and React.

The aim is the directness of SSMS and pgAdmin, with MongoDB treated as a first-class citizen
rather than a plugin, in a fast native app that doesn't get in your way.

## Features

**Everywhere**

- Object explorer per engine: pgAdmin-style schemas for PostgreSQL, SSMS-style folders for SQL
  Server and Babelfish, databases and collections for MongoDB, keyspaces with key counts for
  Redis. Row estimates, sizes, columns,
  indexes and foreign keys inline.
- Command palette (`Ctrl+K`) that searches connections, tables, views, routines and collections.
- Every editor tab gets its own server session, so transactions, temp tables and `USE` behave the
  way they do in SSMS or psql.
- Connection colours (tinting tabs and the status bar), groups, read-only connections, and
  connection-string paste (`postgres://`, `mysql://`, `mongodb+srv://`, `redis://`, ADO.NET).
- Production connections: every write asks first, and destructive statements (`DROP`,
  `TRUNCATE`, `DELETE` without `WHERE`, `deleteMany({})`…) need the connection's name typed.
- Import connections from pgpass, DBeaver or DataGrip, and export your own as JSON without
  passwords.
- Settings for query and connect timeouts, the default commit mode for new query tabs, and the
  editor font.
- Passwords stored in the OS credential manager, never on disk.
- Query history, file open/save, and tabs that survive restarts.
- Dark and light themes (or follow the OS) with a title-bar toggle, an accent override, and a
  theme editor with live preview and JSON import/export for sharing.

**Cloud**

- Finds databases in AWS (RDS, Aurora, Babelfish, DocumentDB), Google Cloud (Cloud SQL), Azure
  (PostgreSQL and MySQL flexible servers, Azure SQL, Cosmos DB for MongoDB), Railway (PostgreSQL,
  MySQL, MongoDB), Render (PostgreSQL), Fly.io (Managed Postgres) and Cloudflare (D1), and connects
  with host, user and TLS filled in, including passwords the provider keeps (AWS Secrets Manager,
  Cosmos DB keys, Render, Railway and Fly.io credentials).
- Fly.io Managed Postgres lives on Fly's private network, so connections run through a
  `fly mpg proxy` tunnel that starts and stops with the connection.
- Passwordless sign-in ("Cloud IAM") with AWS IAM, Google Cloud IAM or Microsoft Entra ID: a
  short-lived token is fetched from the CLI for every new session instead of storing a password.
- Provisioning designer for new databases, including Aurora Babelfish clusters and Cosmos DB
  accounts: engine, version, size, storage, credentials, IAM authentication and network access
  (just this machine, anywhere, or private), with a preview of the exact CLI commands. The
  connection is saved once the database is ready.
- Deleting cloud databases, with an optional final snapshot on AWS, after typing the name to
  confirm.
- Works through the official `aws`, `gcloud`, `az`, `railway` and `flyctl` CLIs, so existing
  profiles, SSO and MFA apply; passwords reach the CLI in a temporary file, never on the command
  line. Render and Cloudflare use an API token kept in the OS credential manager and only ever
  sent to that provider's API.

**SQLite**

- Open a local `.db` / `.sqlite` file (or create an empty one), or a Cloudflare D1 database over
  its REST API. Tables, views, columns, indexes, foreign keys and triggers in the explorer, data
  editing, diagrams and the query editor work as for the other engines; there are no designers,
  users or stored routines, because SQLite has none of its own.

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

**Redis**

- Key browser: SCAN-based, so it stays fast on big keyspaces. Keys group into folders on `:` (or
  any delimiter), with type badges, TTLs, a text or glob filter, a type filter, and multi-select
  or delete-by-prefix.
- Editors for every type: strings (with JSON pretty-printing and a hex view for binary values),
  hashes, lists, sets, sorted sets, streams (with consumer groups) and RedisJSON documents. TTLs
  count down live and can be changed in place; keys can be renamed without clobbering another.
- redis-cli style console: command history, `Tab` completion, greyed-out argument hints, `help`,
  multi-line scripts, and replies printed the way redis-cli prints them.
- Pub/Sub: subscribe to channels and patterns, watch every key change through keyspace
  notifications, and publish messages.
- Server page with live ops/sec, hit rate, memory, clients and evictions, a client list you can
  kill from, and the slow log.
- Read-only connections only allow read commands; production connections confirm writes and need
  the name typed for `FLUSHDB`, `FLUSHALL` and pattern deletes. TLS (`rediss://`), ACL users and SSH
  tunnels work as they do for the other engines.

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
  features/              explorer, query, table, mongo, redis, server, settings, history, welcome
  lib/                   API bindings, SQL, Mongo and Redis helpers, stores
src-tauri/src/
  drivers/               postgres (tokio-postgres), mysql (mysql_async),
                         mssql (tiberius; SQL Server + Babelfish), mongo (official driver),
                         redis (redis-rs), sqlite (rusqlite for files, REST for Cloudflare D1)
  manager.rs             open connections and per-tab sessions, cancellation
  commands.rs            Tauri command surface
  cloud.rs               cloud CLIs (aws, gcloud, az, railway, flyctl) and REST APIs (Render,
                         Fly.io, Cloudflare) for discovery, provisioning and IAM tokens
  tunnel.rs              local tunnels for private-network databases (fly mpg proxy)
src-tauri/vendor/tiberius  tiberius 0.13 with small patches (see PATCHES.md)
```

## License

MIT
