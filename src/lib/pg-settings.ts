/**
 * PostgreSQL server settings: pg_settings with human-readable units, where each value came from,
 * what a change needs (restart, reload, new session), and the ALTER SYSTEM / ALTER DATABASE /
 * ALTER ROLE statements that change one. Also config file problems (pg_file_settings) and the
 * pg_hba.conf rules the server loaded.
 */
import type { Cell, ResultSet } from './api'
import { quoteIdent } from './sql'

/**
 * Server version, whether the signed-in role is a superuser and whether it may reload the
 * configuration (a role granted ALTER SYSTEM on a parameter can't, unless also granted EXECUTE).
 */
export const PG_SETTINGS_PROBE_SQL = `SELECT current_setting('server_version_num') AS version, r.rolsuper AS superuser,
  has_function_privilege('pg_reload_conf()', 'EXECUTE') AS can_reload
FROM pg_roles r WHERE r.rolname = current_user`

export interface PgSettingsProbe {
  /** server_version_num, e.g. 170002 */
  version: number
  superuser: boolean
  canReload: boolean
}

const truthy = (c: Cell): boolean => c === true || c === 't' || c === 'true'

export function parseProbe(set: ResultSet | null): PgSettingsProbe | null {
  const row = set?.rows[0]
  if (!set || !row) return null
  const get = (name: string): Cell => row[set.columns.findIndex((c) => c.name === name)] ?? null
  return {
    version: Number(get('version')) || 0,
    superuser: truthy(get('superuser')),
    canReload: truthy(get('can_reload'))
  }
}

/** The major version in docs URLs: 17 for 170002, 9.6 for 90624. */
export function pgMajor(version: number): string {
  return version >= 100000
    ? String(Math.floor(version / 10000))
    : `${Math.floor(version / 10000)}.${Math.floor(version / 100) % 100}`
}

/**
 * Every setting. On PG15+ also whether the current role may ALTER SYSTEM it, which a superuser
 * can GRANT per parameter.
 */
export function pgSettingsSql(version: number): string {
  const privilege =
    version >= 150000 ? `has_parameter_privilege(name, 'ALTER SYSTEM')` : 'NULL::boolean'
  return `SELECT name, setting, unit, category, short_desc, extra_desc, context, vartype, source,
  min_val, max_val, array_to_json(enumvals)::text AS enumvals, boot_val, reset_val,
  sourcefile, sourceline, pending_restart, ${privilege} AS can_alter_system
FROM pg_settings
ORDER BY category, name`
}

export type PgContext =
  'internal' | 'postmaster' | 'sighup' | 'superuser-backend' | 'backend' | 'superuser' | 'user'

export interface PgSetting {
  name: string
  setting: string
  unit: string | null
  category: string
  shortDesc: string
  extraDesc: string | null
  context: PgContext | string
  vartype: 'bool' | 'integer' | 'real' | 'string' | 'enum' | string
  source: string
  minVal: string | null
  maxVal: string | null
  enumvals: string[]
  bootVal: string | null
  resetVal: string | null
  sourcefile: string | null
  sourceline: number | null
  pendingRestart: boolean
  /** has_parameter_privilege(…, 'ALTER SYSTEM') on PG15+, null before */
  canAlterSystem: boolean | null
}

export function parseSettings(set: ResultSet | null): PgSetting[] {
  if (!set) return []
  const col = (name: string): number => set.columns.findIndex((c) => c.name === name)
  const idx = Object.fromEntries(
    [
      'name',
      'setting',
      'unit',
      'category',
      'short_desc',
      'extra_desc',
      'context',
      'vartype',
      'source',
      'min_val',
      'max_val',
      'enumvals',
      'boot_val',
      'reset_val',
      'sourcefile',
      'sourceline',
      'pending_restart',
      'can_alter_system'
    ].map((n) => [n, col(n)])
  )
  return set.rows.map((row) => {
    const text = (name: string): string | null => {
      const v = row[idx[name]]
      return v === null || v === undefined ? null : String(v)
    }
    let enumvals: string[] = []
    try {
      const parsed: unknown = JSON.parse(text('enumvals') ?? 'null')
      if (Array.isArray(parsed)) enumvals = parsed.map(String)
    } catch {
      // not JSON; leave the list empty
    }
    const privilege = row[idx.can_alter_system]
    return {
      name: text('name') ?? '',
      setting: text('setting') ?? '',
      unit: text('unit'),
      category: text('category') ?? '',
      shortDesc: text('short_desc') ?? '',
      extraDesc: text('extra_desc'),
      context: text('context') ?? '',
      vartype: text('vartype') ?? '',
      source: text('source') ?? '',
      minVal: text('min_val'),
      maxVal: text('max_val'),
      enumvals,
      bootVal: text('boot_val'),
      resetVal: text('reset_val'),
      sourcefile: text('sourcefile'),
      sourceline: text('sourceline') === null ? null : Number(text('sourceline')),
      pendingRestart: truthy(row[idx.pending_restart] ?? null),
      canAlterSystem: privilege === null || privilege === undefined ? null : truthy(privilege)
    }
  })
}

/* ---------- Units ---------- */

const MEMORY_UNITS: [string, number][] = [
  ['B', 1],
  ['kB', 1024],
  ['MB', 1024 ** 2],
  ['GB', 1024 ** 3],
  ['TB', 1024 ** 4]
]

const TIME_UNITS: [string, number][] = [
  ['us', 0.001],
  ['ms', 1],
  ['s', 1000],
  ['min', 60_000],
  ['h', 3_600_000],
  ['d', 86_400_000]
]

interface UnitInfo {
  kind: 'memory' | 'time'
  /** Bytes or milliseconds in one unit of the setting, e.g. 8192 for "8kB" */
  base: number
}

/** pg_settings.unit, e.g. "8kB", "ms" or "min", as bytes or milliseconds per unit. */
export function parseUnit(unit: string | null): UnitInfo | null {
  if (!unit) return null
  const m = /^(\d*)\s*([A-Za-z]+)$/.exec(unit.trim())
  if (!m) return null
  const factor = m[1] ? Number(m[1]) : 1
  const memory = MEMORY_UNITS.find(([u]) => u === m[2])
  if (memory) return { kind: 'memory', base: factor * memory[1] }
  const time = TIME_UNITS.find(([u]) => u === m[2])
  if (time) return { kind: 'time', base: factor * time[1] }
  return null
}

/** The largest unit the amount is a whole number of, like SHOW does: 134217728 B → "128 MB". */
function largestUnit(amount: number, units: [string, number][], minIndex: number): string {
  for (let i = units.length - 1; i >= minIndex; i--) {
    const [u, size] = units[i]
    const n = amount / size
    if (Number.isInteger(n) || (i === minIndex && amount >= size)) {
      return `${Number.isInteger(n) ? n : Number(n.toPrecision(6))} ${u}`
    }
  }
  return `${Number(amount.toPrecision(6))} ${units[minIndex][0]}`
}

/**
 * A value as people read it: shared_buffers 16384 (× 8kB) → "128 MB", statement_timeout
 * 300000 (ms) → "5 min". Zero and negative numbers (often "off" or "use another setting") and
 * values without a unit are shown as they are.
 */
export function formatSettingValue(value: string | null, unit: string | null): string {
  if (value === null) return ''
  const info = parseUnit(unit)
  const n = Number(value)
  if (!info || value.trim() === '' || !Number.isFinite(n) || n <= 0) {
    return unit && !info && value !== '' ? `${value} ${unit}` : value
  }
  const amount = n * info.base
  // ms is the smallest time unit pg_settings uses; fractions of it stay in ms
  return info.kind === 'memory'
    ? largestUnit(amount, MEMORY_UNITS, 0)
    : largestUnit(amount, TIME_UNITS, 1)
}

/* ---------- What a change needs ---------- */

export interface ContextInfo {
  label: string
  description: string
  /** How a server-wide change takes effect */
  apply: 'restart' | 'reload' | 'new-session' | 'none'
}

const CONTEXTS: Record<string, ContextInfo> = {
  internal: {
    label: 'read-only',
    description:
      'Fixed when the server was built or the cluster was initialized; cannot be changed',
    apply: 'none'
  },
  postmaster: {
    label: 'needs restart',
    description: 'Read only at server start: a change needs a server restart',
    apply: 'restart'
  },
  sighup: {
    label: 'reload',
    description:
      'Read from the configuration files: a change takes effect on reload (pg_reload_conf()), for every session',
    apply: 'reload'
  },
  'superuser-backend': {
    label: 'new sessions',
    description:
      'Fixed when a session starts: a change applies to sessions opened after a reload; superusers can set it at connection start',
    apply: 'new-session'
  },
  backend: {
    label: 'new sessions',
    description:
      'Fixed when a session starts: a change applies to sessions opened after a reload; any user can set it at connection start',
    apply: 'new-session'
  },
  superuser: {
    label: 'per session (superuser)',
    description:
      'Superusers (or roles granted SET on it) can change it per session with SET; the server-wide value applies on reload',
    apply: 'reload'
  },
  user: {
    label: 'per session',
    description:
      'Any user can change it for their session with SET; the server-wide value applies on reload',
    apply: 'reload'
  }
}

export function contextInfo(context: string): ContextInfo {
  return CONTEXTS[context] ?? { label: context, description: context, apply: 'reload' }
}

/** Whether ALTER DATABASE / ALTER ROLE … SET accepts the setting (only session-level ones). */
export function scopedSettable(setting: PgSetting): boolean {
  return setting.context === 'user' || setting.context === 'superuser'
}

/** Where the current value came from, with the file and line for configuration file values. */
export function sourceLabel(setting: PgSetting): string {
  if (setting.source === 'configuration file' && setting.sourcefile)
    return `${setting.sourcefile}:${setting.sourceline ?? '?'}`
  return setting.source
}

/** Whether the setting differs from its built-in default. */
export function isChanged(setting: PgSetting): boolean {
  return (
    setting.context !== 'internal' &&
    setting.source !== 'default' &&
    setting.bootVal !== null &&
    setting.setting !== setting.bootVal
  )
}

/** The top-level category: "Resource Usage" for "Resource Usage / Memory". */
export function topCategory(category: string): string {
  return category.split(' / ')[0].trim()
}

const DOC_PAGES: Record<string, string> = {
  'File Locations': 'file-locations',
  'Connections and Authentication': 'connection',
  'Resource Usage': 'resource',
  'Write-Ahead Log': 'wal',
  Replication: 'replication',
  'Query Tuning': 'query',
  'Reporting and Logging': 'logging',
  // PG13 and older list it at the top level
  'Process Title': 'logging',
  Statistics: 'statistics',
  Autovacuum: 'autovacuum',
  // PG18 groups autovacuum, vacuum cost delay and freezing here
  Vacuuming: 'vacuum',
  'Client Connection Defaults': 'client',
  'Lock Management': 'locks',
  'Version and Platform Compatibility': 'compatible',
  'Error Handling': 'error-handling',
  'Preset Options': 'preset',
  'Customized Options': 'custom',
  'Developer Options': 'developer'
}

/** Settings that older servers (PG13/14) file under a category other than their docs page's. */
const NAME_PAGES: Record<string, string> = {
  lc_collate: 'preset',
  lc_ctype: 'preset',
  server_encoding: 'preset',
  tcp_keepalives_idle: 'connection',
  tcp_keepalives_interval: 'connection',
  tcp_keepalives_count: 'connection',
  tcp_user_timeout: 'connection',
  track_activity_query_size: 'statistics'
}

/** Settings the docs describe together under another setting's entry. */
const DOC_ANCHORS: Record<string, string> = {
  debug_print_rewritten: 'debug_print_parse',
  debug_print_plan: 'debug_print_parse',
  log_parser_stats: 'log_statement_stats',
  log_planner_stats: 'log_statement_stats',
  log_executor_stats: 'log_statement_stats'
}

/**
 * The setting's entry in the PostgreSQL docs, from its category. Extension settings
 * (`pg_stat_statements.max`) aren't in the core docs, so they get none.
 */
export function docsUrl(
  setting: Pick<PgSetting, 'name' | 'category'>,
  version: number
): string | null {
  const page = NAME_PAGES[setting.name.toLowerCase()] ?? DOC_PAGES[topCategory(setting.category)]
  if (!page || setting.name.includes('.') || !version) return null
  const name = DOC_ANCHORS[setting.name.toLowerCase()] ?? setting.name
  const anchor = `GUC-${name.toUpperCase().replace(/_/g, '-')}`
  return `https://www.postgresql.org/docs/${pgMajor(version)}/runtime-config-${page}.html#${anchor}`
}

/* ---------- Validation ---------- */

const BOOL_WORDS = ['on', 'off', 'true', 'false', 'yes', 'no', '1', '0']

/** Like the server's parse_bool: on/off, 1/0 and unique prefixes of true/false/yes/no. */
function isBool(input: string): boolean {
  const v = input.trim().toLowerCase()
  if (!v) return false
  if (BOOL_WORDS.includes(v)) return true
  return ['true', 'false', 'yes', 'no'].some((w) => w.startsWith(v))
}

/**
 * A number with an optional unit converted to the setting's own unit, e.g. "128MB" for
 * shared_buffers (8kB) → 16384. Returns an error message for an unknown or wrong-kind unit.
 */
export function toSettingUnits(
  input: string,
  unit: string | null
): { value: number } | { error: string } {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([A-Za-z]*)\s*$/.exec(input)
  if (!m) return { error: 'Not a number' }
  const n = Number(m[1])
  if (!m[2]) return { value: n }
  const info = parseUnit(unit)
  if (!info) return { error: 'This setting takes no unit' }
  const units = info.kind === 'memory' ? MEMORY_UNITS : TIME_UNITS
  const found = units.find(([u]) => u === m[2])
  if (!found) {
    const names = units.map(([u]) => u).join(', ')
    return { error: `Unknown unit "${m[2]}"; use one of ${names} (case-sensitive)` }
  }
  return { value: (n * found[1]) / info.base }
}

/** Why the value would be rejected, or null when it looks valid. Mirrors the server's checks. */
export function validateSettingValue(setting: PgSetting, input: string): string | null {
  switch (setting.vartype) {
    case 'bool':
      return isBool(input) ? null : 'Use on or off'
    case 'enum': {
      const v = input.trim().toLowerCase()
      return setting.enumvals.some((e) => e.toLowerCase() === v)
        ? null
        : `Use one of: ${setting.enumvals.join(', ')}`
    }
    case 'integer':
    case 'real': {
      const parsed = toSettingUnits(input, setting.unit)
      if ('error' in parsed) return parsed.error
      // The server rounds integer settings after converting units
      const value = setting.vartype === 'integer' ? Math.round(parsed.value) : parsed.value
      const min = setting.minVal === null ? null : Number(setting.minVal)
      const max = setting.maxVal === null ? null : Number(setting.maxVal)
      if ((min !== null && value < min) || (max !== null && value > max)) {
        return `Must be between ${formatBound(setting.minVal, setting.unit)} and ${formatBound(setting.maxVal, setting.unit)}`
      }
      return null
    }
    default:
      return null
  }
}

function formatBound(value: string | null, unit: string | null): string {
  if (value === null) return '?'
  const human = formatSettingValue(value, unit)
  return unit && human !== value ? `${value} (${human})` : value
}

/* ---------- SQL ---------- */

/**
 * Settings that take a comma-separated list (GUC_LIST_INPUT). A single quoted string would be
 * one element, so each element is quoted on its own.
 */
const LIST_SETTINGS = new Set([
  'datestyle',
  'search_path',
  'temp_tablespaces',
  'shared_preload_libraries',
  'session_preload_libraries',
  'local_preload_libraries',
  'unix_socket_directories',
  'log_destination',
  'debug_io_direct',
  'wal_consistency_checking',
  'synchronized_standby_slots',
  'restrict_nonsystem_relation_kind',
  'oauth_validator_libraries'
])

const stringLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** `work_mem`, or `"pg_stat_statements"."max"` style for names that need quoting. */
export function settingName(name: string): string {
  return name
    .split('.')
    .map((part) => quoteIdent('postgres', part.toLowerCase()))
    .join('.')
}

/** Splits "a, \"b,c\", d" on commas outside double quotes, dropping the quotes. */
function listElements(input: string): string[] {
  const out: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        current += '"'
        i++
      } else quoted = !quoted
    } else if (c === ',' && !quoted) {
      out.push(current.trim())
      current = ''
    } else current += c
  }
  out.push(current.trim())
  return out.filter(Boolean)
}

/** The right-hand side of `SET name = …`: a quoted literal, or one per element for lists. */
export function settingValueSql(name: string, value: string): string {
  if (LIST_SETTINGS.has(name.toLowerCase())) {
    const elements = listElements(value)
    // An empty list is written as an empty string
    return elements.length ? elements.map(stringLiteral).join(', ') : "''"
  }
  return stringLiteral(value.trim())
}

export type SettingScope =
  | { kind: 'system' }
  | { kind: 'database'; database: string }
  | { kind: 'role'; role: string }
  | { kind: 'role-in-database'; role: string; database: string }

function scopePrefix(scope: SettingScope): string {
  const id = (s: string): string => quoteIdent('postgres', s)
  switch (scope.kind) {
    case 'system':
      return 'ALTER SYSTEM'
    case 'database':
      return `ALTER DATABASE ${id(scope.database)}`
    case 'role':
      return `ALTER ROLE ${id(scope.role)}`
    case 'role-in-database':
      return `ALTER ROLE ${id(scope.role)} IN DATABASE ${id(scope.database)}`
  }
}

export interface SettingChange {
  scope: SettingScope
  name: string
  /** null resets the setting to the value it would otherwise have */
  value: string | null
  /** Run pg_reload_conf() after an ALTER SYSTEM */
  reload: boolean
}

export const RELOAD_CONF_SQL = 'SELECT pg_reload_conf()'

/**
 * The statements for a change, each run on its own: ALTER SYSTEM can't run inside the implicit
 * transaction a multi-statement query gets.
 */
export function settingChangeSql(change: SettingChange): string[] {
  const prefix = scopePrefix(change.scope)
  const name = settingName(change.name)
  const statements = [
    change.value === null
      ? `${prefix} RESET ${name}`
      : `${prefix} SET ${name} = ${settingValueSql(change.name, change.value)}`
  ]
  if (change.scope.kind === 'system' && change.reload) statements.push(RELOAD_CONF_SQL)
  return statements
}

/** What happens after the change runs, in a sentence for the dialog. */
export function applyNote(setting: PgSetting, change: SettingChange): string {
  if (change.scope.kind !== 'system')
    return 'Takes effect in sessions that connect afterwards; open sessions keep their value.'
  const info = contextInfo(setting.context)
  switch (info.apply) {
    case 'restart':
      return change.reload
        ? 'Requires a server restart to take effect. The reload only marks it pending_restart; it also applies any other edits waiting in the configuration files.'
        : 'Requires a server restart to take effect. Until then the old value stays in use.'
    case 'new-session':
      return change.reload
        ? 'Applies to sessions opened after the reload; open sessions keep their value.'
        : 'Written to postgresql.auto.conf; applies to new sessions after the next reload.'
    case 'none':
      return 'This setting cannot be changed.'
    default:
      return change.reload
        ? 'Takes effect on reload for every session that has not SET its own value.'
        : 'Written to postgresql.auto.conf; takes effect on the next reload.'
  }
}

/** Whether the role can change the setting server-wide with ALTER SYSTEM. */
export function canAlterSystem(setting: PgSetting, probe: PgSettingsProbe | null): boolean {
  if (setting.context === 'internal' || !probe) return false
  return probe.superuser || setting.canAlterSystem === true
}

/* ---------- Per-database / per-role values, file problems, pg_hba.conf ---------- */

export const PG_DB_ROLE_SETTINGS_SQL = `SELECT coalesce(d.datname, '') AS database, coalesce(r.rolname, '') AS role,
  array_to_json(s.setconfig)::text AS config
FROM pg_db_role_setting s
LEFT JOIN pg_database d ON d.oid = s.setdatabase
LEFT JOIN pg_roles r ON r.oid = s.setrole
ORDER BY 1, 2`

export interface ScopedValue {
  /** Empty for every database */
  database: string
  /** Empty for every role */
  role: string
  value: string
}

/** pg_db_role_setting entries by lower-cased setting name. */
export function parseScopedValues(set: ResultSet | null): Map<string, ScopedValue[]> {
  const out = new Map<string, ScopedValue[]>()
  if (!set) return out
  const col = (name: string): number => set.columns.findIndex((c) => c.name === name)
  const [db, role, config] = [col('database'), col('role'), col('config')]
  for (const row of set.rows) {
    let entries: unknown
    try {
      entries = JSON.parse(String(row[config] ?? 'null'))
    } catch {
      continue
    }
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const text = String(entry)
      const eq = text.indexOf('=')
      if (eq < 0) continue
      const name = text.slice(0, eq).toLowerCase()
      const list = out.get(name) ?? []
      list.push({
        database: String(row[db] ?? ''),
        role: String(row[role] ?? ''),
        value: text.slice(eq + 1)
      })
      out.set(name, list)
    }
  }
  return out
}

export function scopedLabel(v: ScopedValue): string {
  if (v.database && v.role) return `role ${v.role} in database ${v.database}`
  if (v.database) return `database ${v.database}`
  return `role ${v.role}`
}

/** Lines in the configuration files the server couldn't use. Superuser-only by default. */
export const PG_FILE_ERRORS_SQL = `SELECT sourcefile, sourceline, name, setting, error
FROM pg_file_settings
WHERE error IS NOT NULL
ORDER BY sourcefile, sourceline`

/** The rules pg_hba.conf holds now (PG10+), which the server uses after its next reload. */
export const PG_HBA_RULES_SQL = 'SELECT * FROM pg_hba_file_rules'

/* ---------- Filtering ---------- */

export type SettingsFilter = 'all' | 'changed' | 'pending'

export function filterSettings(
  settings: PgSetting[],
  opts: { search: string; category: string; filter: SettingsFilter }
): PgSetting[] {
  const q = opts.search.trim().toLowerCase()
  return settings.filter(
    (s) =>
      (!opts.category || topCategory(s.category) === opts.category) &&
      (opts.filter !== 'changed' || isChanged(s)) &&
      (opts.filter !== 'pending' || s.pendingRestart) &&
      (!q ||
        s.name.toLowerCase().includes(q) ||
        s.shortDesc.toLowerCase().includes(q) ||
        s.setting.toLowerCase().includes(q))
  )
}

export function categories(settings: PgSetting[]): string[] {
  return [...new Set(settings.map((s) => topCategory(s.category)))].sort()
}
