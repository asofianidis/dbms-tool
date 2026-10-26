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
- SSH tunnels through the system's OpenSSH (agent, key file or password, jump hosts, `~/.ssh/config`
  aliases), with the host key's fingerprint shown for confirmation the first time.
- TLS modes from Disable to Verify full, with CA bundle and client certificate files.
- Query history, file open/save, and tabs that survive restarts.
- Saved queries kept apart from any connection: run them on any compatible connection and
  database, or open them in a tab and save over them.
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
- "This machine" network access looks up your public IP with
  [ipify](https://www.ipify.org/) (`api.ipify.org`), only when you choose that option. The app has
  no telemetry and sends nothing else to third parties.

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
- Query parameters (`:name`, `${name}`) filled in before a run, with error positions still mapped
  onto the text you wrote.
- Manual-commit mode per tab, and a graphical plan viewer (PostgreSQL, MySQL, SQL Server) that
  shades nodes by cost and suggests indexes.
- Designers for tables, triggers and schemas, and a permissions designer for `GRANT`, `REVOKE` and
  `DENY` (PostgreSQL, MySQL, SQL Server) with a live script preview.
- User and role management (PostgreSQL, MySQL / MariaDB, SQL Server, Babelfish): create, edit,
  rename and drop users and roles with their passwords and attributes (login, superuser,
  connection limits, account locks, default schemas, SQL logins), and assign roles from either
  side, a user's "Member of" or a role's "Members", including built-in roles such as
  `db_datareader`. Passwords are hidden in the script preview.

**Data tools**

- Export results to CSV, TSV, JSON, Markdown or `INSERT` statements. "Save as" fetches the whole
  result (up to a million rows), not just the loaded page. CSV keeps NULL and empty strings
  apart: NULL is an empty field, an empty string is `""`.
- Import CSV/TSV, JSON and JSON Lines into an existing or new table (types inferred per dialect),
  or into a MongoDB collection.
- Backup and restore with the engine's own tools (`pg_dump`, `mysqldump`, `mongodump`, …) or a
  built-in engine writing the same formats when they aren't installed; SQL Server uses server-side
  `BACKUP` / `RESTORE` with full, differential and log backups, and can copy a finished backup
  (up to 2 GB) from the server to this computer. The copy needs the ADMINISTER BULK OPERATIONS
  permission and, while it runs, about as much free tempdb space as the backup. Restores can
  start from a backup on this computer: a server running here reads it in place, and a Windows
  server with OLE Automation turned on receives a copy, deleted after the restore.
- Schema compare between two databases of the same dialect, on any connections: tables, views,
  routines and sequences, with a line diff and a dependency-ordered migration script.
- ER diagrams with automatic layout, exported as PNG, SVG or PDF.
- "Seed sample database" loads a production-shaped e-commerce dataset (about 100k to 8M rows) into
  PostgreSQL, MySQL, SQL Server, SQLite or MongoDB.

**Dashboards**

- Grids of stat, bar, line and table widgets backed by SQL or MongoDB queries, refreshed by hand
  or on a timer. Widget queries always run read-only.
- Lock, duplicate, export and import dashboards; imported ones run nothing until you review their
  queries. A built-in example dashboard needs no tables.

**Server**

- Live metrics per engine (throughput, cache hit rate, connections, lock waits, …) with a chart of
  recent history.
- Activity list that refreshes on its own, highlights blocked and blocking sessions, and cancels
  queries or kills sessions from the context menu.

**Babelfish**

- Connects over the TDS endpoint and is auto-detected from `SERVERPROPERTY('BabelfishVersion')`.
- Metadata queries fall back to `INFORMATION_SCHEMA` where Babelfish doesn't implement a catalog
  view.
- Server page lists escape hatches (`sp_babelfish_configure`); Explain uses
  `BABELFISH_SHOWPLAN_ALL` / `BABELFISH_STATISTICS PROFILE`.

**MongoDB**

- mongosh-style shell: `db.orders.find({ … }).sort({ … }).limit(20)`, `aggregate`, `insertMany`,
  `updateOne`, `createIndex`, `use`, `show dbs`, `ObjectId()`, `ISODate()`, `NumberLong()` and
  more, with completion for collections, methods and `$` operators. Cursor options (`hint`,
  `maxTimeMS`, `collation`, `allowDiskUse`, `readPref`) are sent to the server. Calls run after the
  script is read, so a script that tries to use a result (`forEach`, `.length`) is refused rather
  than silently skipped.
- Collection browser in the spirit of Compass: filter, projection and sort; list, table and JSON
  views; edit, clone, insert and delete documents with BSON types preserved.
- Aggregation pipeline builder with per-stage previews and export to shell.
- Schema analysis over a `$sample`: field paths, presence and type mix.
- Index management with usage statistics, Atlas Search and Vector Search indexes, and explain with
  collection-scan warnings.
- Users and custom roles across every database: create users with their authentication
  database, change passwords, assign built-in and custom roles, write a role's privileges and
  inherited roles, and add or remove a role's members.

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
- Seed sample database: the same e-commerce dataset as the other engines, kept the way an app
  would keep it in Redis (hashes, lists, sorted-set leaderboards, event streams with consumer
  groups, a geo index, HyperLogLogs, expiring sessions). `scripts/seed-redis.sh [container] [db]
  [scale]` loads it into a Docker container with `redis-cli --pipe`.
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

It downloads the universal build (Apple Silicon and Intel), checks it against the release's
`SHA256SUMS.txt` and, for signed builds, verifies the code signature and notarization. Then it
quits the app if it's running, replaces `/Applications/dbms-tool.app` and opens it. From a clone,
`bash scripts/install-mac.sh` does the same. You can also download the `.dmg` from
[Releases](https://github.com/asofianidis/dbms-tool/releases/latest).

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

`up` finishes by printing the host, port, user, password and connection string for each
server. Run `./scripts/test-databases.sh info` to print them again.

To work with only some engines, list them after the command (`pg`, `mysql`, `mariadb`, `mssql`,
`babelfish`, `mongo`, `redis`). Every command accepts the list:

```sh
./scripts/test-databases.sh up pg
eval "$(./scripts/test-databases.sh env pg)"
./scripts/test-databases.sh down pg
```

### CI and releases

`ci.yml` runs formatting, type checks, unit tests, clippy and the Rust tests on Windows, macOS and
Linux, plus the live database suite against all five engines. `release.yml` builds and publishes
signed installers; see [docs/RELEASING.md](docs/RELEASING.md) for channels, versioning and the
signing secrets.

### Layout

```
src/                     React frontend
  components/            UI primitives, grid, editor, dialogs, shell (title bar, tabs, status bar)
  features/              explorer, query, table, mongo, redis, server, dashboard, compare,
                         backup, import, diagram, saved, seed, settings, history, welcome
  lib/                   API bindings, SQL, Mongo and Redis helpers, stores
src-tauri/src/
  drivers/               postgres (tokio-postgres), mysql (mysql_async),
                         mssql (tiberius; SQL Server + Babelfish), mongo (official driver),
                         redis (redis-rs), sqlite (rusqlite for files, REST for Cloudflare D1)
  manager.rs             open connections and per-tab sessions, cancellation
  commands.rs            Tauri command surface
  cloud.rs               cloud CLIs (aws, gcloud, az, railway, flyctl) and REST APIs (Render,
                         Fly.io, Cloudflare) for discovery, provisioning and IAM tokens
  tunnel.rs              SSH tunnels and local proxies for private-network databases
  guard.rs               read-only check for read-only connections, dashboards and exports
  backup.rs              backup and restore, with external tools or the built-in engine
src-tauri/vendor/tiberius  tiberius 0.13 with small patches (see PATCHES.md)
```

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

MIT
