/**
 * Server extensions: PostgreSQL extensions (pg_available_extensions / pg_extension, one set per
 * database) and MySQL / MariaDB plugins (information_schema.PLUGINS, server-wide). MariaDB also
 * lists the plugins it could load in information_schema.ALL_PLUGINS, so they can be installed
 * without typing a library name.
 */
import type { Cell, Engine, ResultSet, ServerInfo } from './api'
import { isMariaDb } from './mariadb'
import { literal, quoteIdent } from './sql'

export type ExtensionFlavor = 'postgres' | 'mariadb' | 'mysql'

/** Which kind of extension a connection has, or null for engines without them. */
export function extensionFlavor(
  engine: Engine,
  info: Pick<ServerInfo, 'product' | 'version'> | null | undefined
): ExtensionFlavor | null {
  if (engine === 'postgres') return 'postgres'
  if (engine === 'mysql') return isMariaDb(info) ? 'mariadb' : 'mysql'
  return null
}

/**
 * Every available or installed extension, installed first. `trusted` (PostgreSQL 13+) is read
 * through to_jsonb so older servers get NULL instead of an error, and the full join keeps
 * extensions whose control file has since been removed from the server.
 */
export const PG_EXTENSIONS_SQL = `SELECT coalesce(a.name, e.extname::text) AS name,
  e.extversion AS installed_version,
  a.default_version,
  n.nspname AS schema,
  coalesce(e.extrelocatable, v.relocatable) AS relocatable,
  v.superuser,
  (to_jsonb(v) ->> 'trusted')::boolean AS trusted,
  array_to_string(v.requires, ', ') AS requires,
  (SELECT string_agg(x.version, ', ' ORDER BY x.version)
     FROM pg_available_extension_versions x WHERE x.name = a.name) AS versions,
  a.comment
FROM pg_available_extensions a
FULL JOIN pg_extension e ON e.extname = a.name
LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
LEFT JOIN pg_available_extension_versions v
  ON v.name = a.name AND v.version = coalesce(e.extversion, a.default_version)
ORDER BY e.extname IS NULL, 1`

/** ALL_PLUGINS includes the plugins in the plugin directory that aren't installed. */
export const MARIADB_PLUGINS_SQL = `SELECT PLUGIN_NAME AS name, PLUGIN_TYPE AS type, PLUGIN_STATUS AS status,
  PLUGIN_LIBRARY AS library, PLUGIN_VERSION AS version, PLUGIN_MATURITY AS maturity,
  PLUGIN_AUTH_VERSION AS auth_version, LOAD_OPTION AS load_option, PLUGIN_LICENSE AS license,
  PLUGIN_AUTHOR AS author, PLUGIN_DESCRIPTION AS description
FROM information_schema.ALL_PLUGINS
ORDER BY PLUGIN_STATUS = 'NOT INSTALLED', PLUGIN_TYPE, PLUGIN_NAME`

export const MYSQL_PLUGINS_SQL = `SELECT PLUGIN_NAME AS name, PLUGIN_TYPE AS type, PLUGIN_STATUS AS status,
  PLUGIN_LIBRARY AS library, PLUGIN_VERSION AS version, LOAD_OPTION AS load_option,
  PLUGIN_LICENSE AS license, PLUGIN_AUTHOR AS author, PLUGIN_DESCRIPTION AS description
FROM information_schema.PLUGINS
ORDER BY PLUGIN_TYPE, PLUGIN_NAME`

export function extensionsSql(flavor: ExtensionFlavor): string {
  return flavor === 'postgres'
    ? PG_EXTENSIONS_SQL
    : flavor === 'mariadb'
      ? MARIADB_PLUGINS_SQL
      : MYSQL_PLUGINS_SQL
}

export interface PgExtension {
  name: string
  installedVersion: string | null
  defaultVersion: string | null
  schema: string | null
  relocatable: boolean
  /** Installing needs a superuser, unless the extension is trusted */
  superuser: boolean | null
  trusted: boolean | null
  requires: string[]
  versions: string[]
  comment: string | null
}

export interface Plugin {
  name: string
  type: string
  /** ACTIVE, INACTIVE, DISABLED, DELETED or (MariaDB's ALL_PLUGINS) NOT INSTALLED */
  status: string
  /** The shared library; null for plugins compiled into the server */
  library: string | null
  version: string | null
  maturity: string | null
  loadOption: string | null
  description: string | null
}

const column = (set: ResultSet, name: string): number =>
  set.columns.findIndex((c) => c.name.toLowerCase() === name)

function reader(set: ResultSet): (row: Cell[], name: string) => Cell {
  const cache = new Map<string, number>()
  return (row, name) => {
    let i = cache.get(name)
    if (i === undefined) cache.set(name, (i = column(set, name)))
    return i >= 0 ? (row[i] ?? null) : null
  }
}

const text = (v: Cell): string | null => (v === null || v === '' ? null : String(v))
const bool = (v: Cell): boolean | null =>
  v === null ? null : v === true || /^(t|true|1|yes|on)$/i.test(String(v))
const list = (v: Cell): string[] =>
  text(v)
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? []

export function parsePgExtensions(set: ResultSet | null): PgExtension[] {
  if (!set) return []
  const get = reader(set)
  return set.rows.map((row) => ({
    name: String(get(row, 'name')),
    installedVersion: text(get(row, 'installed_version')),
    defaultVersion: text(get(row, 'default_version')),
    schema: text(get(row, 'schema')),
    relocatable: !!bool(get(row, 'relocatable')),
    superuser: bool(get(row, 'superuser')),
    trusted: bool(get(row, 'trusted')),
    requires: list(get(row, 'requires')),
    versions: list(get(row, 'versions')),
    comment: text(get(row, 'comment'))
  }))
}

export function parsePlugins(set: ResultSet | null): Plugin[] {
  if (!set) return []
  const get = reader(set)
  return set.rows.map((row) => ({
    name: String(get(row, 'name')),
    type: String(get(row, 'type') ?? ''),
    status: String(get(row, 'status') ?? '').toUpperCase(),
    library: text(get(row, 'library')),
    version: text(get(row, 'version')),
    maturity: text(get(row, 'maturity')),
    loadOption: text(get(row, 'load_option')),
    description: text(get(row, 'description'))
  }))
}

export const isInstalledPlugin = (p: Plugin): boolean => p.status !== 'NOT INSTALLED'

/** Built-in plugins have no library and can't be uninstalled. */
export const canUninstallPlugin = (p: Plugin): boolean => isInstalledPlugin(p) && !!p.library

/** An installed extension below the server's default version. */
export const pgUpdateAvailable = (e: PgExtension): boolean =>
  !!e.installedVersion && !!e.defaultVersion && e.installedVersion !== e.defaultVersion

/* ---------- Statements ---------- */

export interface CreateExtensionOptions {
  name: string
  /** Empty for the extension's own default, or the first schema on the search_path */
  schema?: string
  /** Empty for the default version */
  version?: string
  /** Also install the extensions it requires */
  cascade?: boolean
}

export function createExtensionSql(o: CreateExtensionOptions): string {
  let sql = `CREATE EXTENSION IF NOT EXISTS ${quoteIdent('postgres', o.name)}`
  if (o.schema?.trim()) sql += ` SCHEMA ${quoteIdent('postgres', o.schema.trim())}`
  if (o.version?.trim()) sql += ` VERSION ${literal('postgres', o.version.trim())}`
  if (o.cascade) sql += ' CASCADE'
  return sql
}

/** Updates to `version`, or the default version when it's omitted. */
export function updateExtensionSql(name: string, version?: string): string {
  const to = version?.trim() ? ` TO ${literal('postgres', version.trim())}` : ''
  return `ALTER EXTENSION ${quoteIdent('postgres', name)} UPDATE${to}`
}

export function moveExtensionSql(name: string, schema: string): string {
  return `ALTER EXTENSION ${quoteIdent('postgres', name)} SET SCHEMA ${quoteIdent('postgres', schema.trim())}`
}

export function dropExtensionSql(name: string, cascade = false): string {
  return `DROP EXTENSION IF EXISTS ${quoteIdent('postgres', name)}${cascade ? ' CASCADE' : ''}`
}

/** Installs one plugin from `library` (e.g. ha_rocksdb.so, or just ha_rocksdb on MariaDB). */
export function installPluginSql(name: string, library: string): string {
  return `INSTALL PLUGIN ${quoteIdent('mysql', name.trim())} SONAME ${literal('mysql', library.trim())}`
}

/** MariaDB only: installs every plugin `library` contains. */
export function installSonameSql(library: string): string {
  return `INSTALL SONAME ${literal('mysql', library.trim())}`
}

export function uninstallPluginSql(name: string): string {
  return `UNINSTALL PLUGIN ${quoteIdent('mysql', name)}`
}

/** A plain-language pointer for the errors these statements commonly hit. */
export function extensionHint(error: string, flavor: ExtensionFlavor): string | null {
  if (flavor === 'postgres') {
    if (/permission denied|must be (superuser|owner)/i.test(error))
      return 'Installing an extension that is not trusted needs a superuser; trusted ones need CREATE on the database. Dropping or updating one needs its owner.'
    if (/could not open extension control file|is not available/i.test(error))
      return "The extension's files aren't installed on the database server (its package, e.g. postgresql-contrib or postgis, has to be installed there first)."
    if (/required extension .* is not installed/i.test(error))
      return 'Tick "Also install required extensions" to install what it depends on (CASCADE).'
    if (/must be loaded via .?shared_preload_libraries/i.test(error))
      return 'This extension has to be listed in shared_preload_libraries in postgresql.conf, which needs a server restart.'
    if (/depend on it|other objects depend/i.test(error))
      return 'Objects use this extension. Drop with CASCADE to remove them too.'
    return null
  }
  if (/access denied|command denied/i.test(error))
    return 'Installing or uninstalling plugins needs INSERT or DELETE on mysql.plugin (or the SUPER privilege).'
  if (/can't open shared library|cannot open shared object|no such file/i.test(error))
    return "The library isn't in the server's plugin_dir. Check the file name, and that the plugin's package is installed on the server."
  if (/already (exists|installed)|function .* already exists/i.test(error))
    return 'That plugin is already installed.'
  return null
}
