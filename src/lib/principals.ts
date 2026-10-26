import type { Cell } from './api'
import {
  authPlugin,
  identifiedVia,
  parseAuthMethods,
  takesPassword,
  validPluginName
} from './authPlugins'
import type { Dialect } from './engines'
import {
  granteeSql,
  levelOf,
  membershipStatements,
  principalKey,
  type GrantMap,
  type Principal
} from './grants'
import { literal, quoteIdent } from './sql'

/**
 * Creating, changing and dropping users and roles: PostgreSQL roles, MySQL and MariaDB
 * accounts and roles, and SQL Server database users and roles (with their logins).
 */

export type PrincipalType = 'user' | 'role'

/** How a SQL Server database user signs in */
export type TsqlAuth = 'login' | 'none' | 'password' | 'external'

export interface PrincipalState {
  type: PrincipalType
  name: string
  /** MySQL account host; '' for MariaDB roles */
  host: string
  /* PostgreSQL role attributes */
  superuser: boolean
  createDb: boolean
  createRole: boolean
  inherit: boolean
  replication: boolean
  bypassRls: boolean
  /** PostgreSQL VALID UNTIL; '' for no expiry */
  validUntil: string
  /** PostgreSQL CONNECTION LIMIT, MySQL MAX_USER_CONNECTIONS; '' for unlimited */
  connectionLimit: string
  /** MySQL ACCOUNT LOCK */
  locked: boolean
  /** MySQL and MariaDB authentication plugins, in the order MariaDB tries them; [] for the server default */
  plugins: string[]
  /* SQL Server */
  auth: TsqlAuth
  /** Server login the user maps to */
  login: string
  /** '' for the server default (dbo) */
  defaultSchema: string
  /** Role owner (AUTHORIZATION); '' for the creator */
  owner: string
}

export interface PrincipalDraft extends PrincipalState {
  /** The principal as loaded; null when creating one */
  original: PrincipalState | null
  /** A new password; '' keeps the current one */
  password: string
  /** MySQL PASSWORD EXPIRE: a new password is needed at the next sign-in */
  expirePassword: boolean
  /** SQL Server: create the login, with the password, along with the user */
  createLogin: boolean
}

export interface PrincipalOptions {
  /** MariaDB roles have no host */
  mariadb?: boolean
  /** Babelfish users always map to a login */
  babelfish?: boolean
  /** Writes passwords as asterisks, for showing the script */
  maskPasswords?: boolean
}

const emptyState = (type: PrincipalType): PrincipalState => ({
  type,
  name: '',
  host: '',
  superuser: false,
  createDb: false,
  createRole: false,
  inherit: true,
  replication: false,
  bypassRls: false,
  validUntil: '',
  connectionLimit: '',
  locked: false,
  plugins: [],
  auth: 'login',
  login: '',
  defaultSchema: '',
  owner: ''
})

export function newPrincipalDraft(
  dialect: Dialect,
  type: PrincipalType,
  options: PrincipalOptions = {}
): PrincipalDraft {
  return {
    ...emptyState(type),
    // MySQL roles are accounts too, and default to any host
    host: dialect === 'mysql' && !(type === 'role' && options.mariadb) ? '%' : '',
    original: null,
    password: '',
    expirePassword: false,
    createLogin: true
  }
}

export function principalDraftFrom(state: PrincipalState): PrincipalDraft {
  return {
    ...state,
    original: state,
    password: '',
    expirePassword: false,
    createLogin: false
  }
}

/** The principal as GRANT and membership statements name it, after the draft is applied. */
export function draftPrincipal(dialect: Dialect, d: PrincipalState): Principal {
  return {
    name: d.name.trim(),
    host: dialect === 'mysql' ? d.host.trim() : null,
    kind: d.type,
    builtin: false
  }
}

/** MariaDB refuses to rename roles; MySQL 8 renames them like any account. */
export function canRenamePrincipal(
  dialect: Dialect,
  type: PrincipalType,
  options: PrincipalOptions = {}
): boolean {
  return !(dialect === 'mysql' && type === 'role' && options.mariadb)
}

/* ---------- Catalog queries ---------- */

const yn = (expr: string): string => `CASE WHEN ${expr} THEN 'y' ELSE 'n' END`

/**
 * Queries reading the principal's attributes, tried in order until one succeeds.
 * parsePrincipalState reads the rows.
 */
export function principalStateQueries(dialect: Dialect, p: Principal): string[] {
  const lit = (v: string): string => literal(dialect, v)
  switch (dialect) {
    case 'postgres':
      return [
        `SELECT ${yn('rolcanlogin')}, ${yn('rolsuper')}, ${yn('rolcreatedb')}, ${yn('rolcreaterole')}, \
           ${yn('rolinherit')}, ${yn('rolreplication')}, ${yn('rolbypassrls')}, rolconnlimit::text, \
           CASE WHEN rolvaliduntil IS NULL OR rolvaliduntil = 'infinity' THEN '' ELSE rolvaliduntil::text END \
         FROM pg_roles WHERE rolname = ${lit(p.name)}`
      ]
    case 'mysql': {
      const where = `WHERE User = ${lit(p.name)} AND Host = ${lit(p.host ?? '')}`
      return [
        `SELECT ${yn("account_locked = 'Y'")}, CAST(max_user_connections AS CHAR), plugin FROM mysql.user ${where}`,
        // MariaDB 10.4+ keeps account options as JSON, with every sign-in method in auth_or
        `SELECT ${yn("JSON_VALUE(Priv, '$.account_locked') IN ('1', 'true')")}, \
           COALESCE(JSON_VALUE(Priv, '$.max_user_connections'), '0'), \
           COALESCE(JSON_VALUE(Priv, '$.plugin'), ''), COALESCE(JSON_QUERY(Priv, '$.auth_or'), '') \
         FROM mysql.global_priv ${where}`,
        // Older MariaDB has no account locking
        `SELECT 'n', CAST(max_user_connections AS CHAR) FROM mysql.user ${where}`
      ]
    }
    case 'tsql': {
      const from = `FROM sys.database_principals dp \
         LEFT JOIN sys.server_principals sp ON sp.sid = dp.sid \
         LEFT JOIN sys.database_principals o ON o.principal_id = dp.owning_principal_id \
         WHERE dp.name = ${lit(p.name)}`
      const rest = "ISNULL(dp.default_schema_name, ''), ISNULL(sp.name, '')"
      return [
        `SELECT dp.type, ${rest}, ISNULL(dp.authentication_type_desc, ''), ISNULL(o.name, '') ${from}`,
        // Babelfish and older servers lack authentication_type_desc
        `SELECT dp.type, ${rest}, '', ISNULL(o.name, '') ${from}`
      ]
    }
    case 'sqlite':
      // SQLite has no users, roles or grants
      return []
  }
}

const text = (cell: Cell | undefined): string => (typeof cell === 'string' ? cell : '')

/** Reads principalStateQueries' row; null when the principal doesn't exist. */
export function parsePrincipalState(
  dialect: Dialect,
  p: Principal,
  rows: Cell[][]
): PrincipalState | null {
  const r = rows[0]
  if (!r) return null
  const base: PrincipalState = {
    ...emptyState(p.kind === 'user' ? 'user' : 'role'),
    name: p.name,
    host: p.host ?? ''
  }
  const flag = (i: number): boolean => text(r[i]) === 'y'
  switch (dialect) {
    case 'postgres': {
      const limit = text(r[7])
      return {
        ...base,
        type: flag(0) ? 'user' : 'role',
        superuser: flag(1),
        createDb: flag(2),
        createRole: flag(3),
        inherit: flag(4),
        replication: flag(5),
        bypassRls: flag(6),
        connectionLimit: limit === '-1' ? '' : limit,
        validUntil: text(r[8])
      }
    }
    case 'mysql': {
      const limit = text(r[1])
      return {
        ...base,
        locked: flag(0),
        connectionLimit: limit === '0' ? '' : limit,
        plugins: parseAuthMethods(text(r[2]), text(r[3]))
      }
    }
    case 'tsql': {
      const type = text(r[0]).trim()
      const login = text(r[2])
      const desc = text(r[3]).toUpperCase()
      const auth: TsqlAuth =
        desc === 'DATABASE'
          ? 'password'
          : desc === 'EXTERNAL' || ((type === 'E' || type === 'X') && !login)
            ? 'external'
            : login || desc === 'INSTANCE' || desc === 'WINDOWS'
              ? 'login'
              : 'none'
      return {
        ...base,
        type: type === 'R' || type === 'A' ? 'role' : 'user',
        defaultSchema: text(r[1]),
        login,
        auth,
        owner: text(r[4])
      }
    }
    case 'sqlite':
      return null
  }
}

/** SQL Server server logins a database user can map to. */
export const TSQL_LOGINS_QUERY =
  "SELECT name FROM sys.server_principals WHERE type IN ('S', 'U', 'G', 'E', 'X') AND name NOT LIKE '##%' ORDER BY name"

/**
 * Queries reading a role's members, tried in order until one succeeds. Rows are member
 * name, host and admin option ('YES' | 'NO'), as parseMembershipRows reads them.
 */
export function memberQueries(dialect: Dialect, role: Principal): string[] {
  const lit = (v: string): string => literal(dialect, v)
  switch (dialect) {
    case 'postgres':
      return [
        `SELECT r.rolname, NULL, CASE WHEN bool_or(m.admin_option) THEN 'YES' ELSE 'NO' END \
         FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member \
         WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = ${lit(role.name)}) GROUP BY 1`
      ]
    case 'mysql':
      return [
        `SELECT TO_USER, TO_HOST, CASE WHEN WITH_ADMIN_OPTION = 'Y' THEN 'YES' ELSE 'NO' END \
         FROM mysql.role_edges WHERE FROM_USER = ${lit(role.name)} AND FROM_HOST = ${lit(role.host ?? '')}`,
        // MariaDB
        `SELECT User, Host, CASE WHEN Admin_option = 'Y' THEN 'YES' ELSE 'NO' END \
         FROM mysql.roles_mapping WHERE Role = ${lit(role.name)}`
      ]
    case 'tsql':
      return [
        `SELECT m.name, NULL, 'NO' FROM sys.database_role_members rm \
         JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id \
         WHERE rm.role_principal_id = DATABASE_PRINCIPAL_ID(${lit(role.name)})`
      ]
    case 'sqlite':
      // SQLite has no users, roles or grants
      return []
  }
}

/* ---------- Statements ---------- */

const MASK = '********'

function secret(dialect: Dialect, password: string, options: PrincipalOptions): string {
  // nvarchar makes T-SQL passwords Unicode, so ones outside the server's code page survive
  return literal(dialect, options.maskPasswords ? MASK : password, 'nvarchar')
}

const PG_FLAGS: [keyof PrincipalState, string][] = [
  ['superuser', 'SUPERUSER'],
  ['createDb', 'CREATEDB'],
  ['createRole', 'CREATEROLE'],
  ['inherit', 'INHERIT'],
  ['replication', 'REPLICATION'],
  ['bypassRls', 'BYPASSRLS']
]

function pgStatements(d: PrincipalDraft, options: PrincipalOptions): string[] {
  const q = (n: string): string => quoteIdent('postgres', n)
  const name = d.name.trim()
  const o = d.original
  const parts: string[] = []
  const login = d.type === 'user'
  if (!o || login !== (o.type === 'user')) parts.push(login ? 'LOGIN' : 'NOLOGIN')
  for (const [key, word] of PG_FLAGS) {
    const on = d[key] as boolean
    // New roles inherit by default, and have none of the others
    if (o ? on !== o[key] : on !== (key === 'inherit')) parts.push(on ? word : `NO${word}`)
  }
  const limit = d.connectionLimit.trim()
  if (o ? limit !== o.connectionLimit : limit) parts.push(`CONNECTION LIMIT ${limit || '-1'}`)
  if (d.password) parts.push(`PASSWORD ${secret('postgres', d.password, options)}`)
  const until = d.validUntil.trim()
  if (o ? until !== o.validUntil : until)
    parts.push(`VALID UNTIL ${literal('postgres', until || 'infinity')}`)

  const attributes = parts.length ? ` WITH ${parts.join(' ')}` : ''
  if (!o) return [`CREATE ROLE ${q(name)}${attributes}`]
  const statements: string[] = []
  if (name !== o.name) statements.push(`ALTER ROLE ${q(o.name)} RENAME TO ${q(name)}`)
  if (attributes) statements.push(`ALTER ROLE ${q(name)}${attributes}`)
  return statements
}

function mysqlStatements(d: PrincipalDraft, options: PrincipalOptions): string[] {
  const who = granteeSql('mysql', draftPrincipal('mysql', d))
  const o = d.original
  const before = o && granteeSql('mysql', draftPrincipal('mysql', o))
  // Roles have no attributes of their own. MySQL roles are accounts, so RENAME USER renames
  // them and moves them to another host; MariaDB can't rename roles
  if (d.type === 'role') {
    if (!before) return [`CREATE ROLE ${who}`]
    return before !== who && !options.mariadb ? [`RENAME USER ${before} TO ${who}`] : []
  }
  const limit = d.connectionLimit.trim()
  const tail = [
    ...((o ? limit !== o.connectionLimit : limit)
      ? [`WITH MAX_USER_CONNECTIONS ${limit || '0'}`]
      : []),
    ...(d.expirePassword ? ['PASSWORD EXPIRE'] : []),
    ...((o ? d.locked !== o.locked : d.locked)
      ? [d.locked ? 'ACCOUNT LOCK' : 'ACCOUNT UNLOCK']
      : [])
  ]
  const identified = identifiedClause(d, options)
  const rest = `${identified}${tail.length ? ` ${tail.join(' ')}` : ''}`
  if (!o) return [`CREATE USER ${who}${rest}`]
  const statements: string[] = []
  if (before !== who) statements.push(`RENAME USER ${before} TO ${who}`)
  if (rest) statements.push(`ALTER USER ${who}${rest}`)
  return statements
}

const samePlugins = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((p, i) => p === b[i])

function identifiedClause(d: PrincipalDraft, options: PrincipalOptions): string {
  const mariadb = !!options.mariadb
  const changed = d.original ? !samePlugins(d.plugins, d.original.plugins) : d.plugins.length > 0
  const password = takesPassword(d.plugins, mariadb) ? d.password : ''
  // MariaDB's IDENTIFIED BY resets the account to mysql_native_password, so a new password
  // restates the methods; MySQL's keeps the plugin
  if (changed || (password && mariadb))
    return identifiedVia(d.plugins, mariadb, secret('mysql', password, options))
  return d.password ? ` IDENTIFIED BY ${secret('mysql', d.password, options)}` : ''
}

function tsqlStatements(d: PrincipalDraft, options: PrincipalOptions): string[] {
  const q = (n: string): string => quoteIdent('tsql', n)
  const name = d.name.trim()
  const login = d.login.trim()
  const schema = d.defaultSchema.trim()
  const o = d.original
  const pwd = (): string => secret('tsql', d.password, options)

  if (d.type === 'role') {
    const owner = d.owner.trim()
    if (!o) return [`CREATE ROLE ${q(name)}${owner ? ` AUTHORIZATION ${q(owner)}` : ''}`]
    const statements: string[] = []
    if (name !== o.name) statements.push(`ALTER ROLE ${q(o.name)} WITH NAME = ${q(name)}`)
    if (owner && owner !== o.owner)
      statements.push(`ALTER AUTHORIZATION ON ROLE::${q(name)} TO ${q(owner)}`)
    return statements
  }

  if (!o) {
    const withSchema = schema ? ` WITH DEFAULT_SCHEMA = ${q(schema)}` : ''
    switch (d.auth) {
      case 'login':
        return [
          ...(d.createLogin ? [`CREATE LOGIN ${q(login)} WITH PASSWORD = ${pwd()}`] : []),
          `CREATE USER ${q(name)} FOR LOGIN ${q(login)}${withSchema}`
        ]
      case 'none':
        return [`CREATE USER ${q(name)} WITHOUT LOGIN${withSchema}`]
      case 'password':
        return [
          `CREATE USER ${q(name)} WITH PASSWORD = ${pwd()}${schema ? `, DEFAULT_SCHEMA = ${q(schema)}` : ''}`
        ]
      case 'external':
        return [`CREATE USER ${q(name)} FROM EXTERNAL PROVIDER${withSchema}`]
    }
  }

  const parts: string[] = []
  if (name !== o.name) parts.push(`NAME = ${q(name)}`)
  // A cleared schema goes back to the default
  if (schema !== o.defaultSchema) parts.push(`DEFAULT_SCHEMA = ${q(schema || 'dbo')}`)
  if (o.auth === 'login' && login && login !== o.login) parts.push(`LOGIN = ${q(login)}`)
  if (o.auth === 'password' && d.password) parts.push(`PASSWORD = ${pwd()}`)
  const statements = parts.length ? [`ALTER USER ${q(o.name)} WITH ${parts.join(', ')}`] : []
  // A login-based user's password belongs to the login
  if (o.auth === 'login' && d.password && (login || o.login) && !options.babelfish)
    statements.push(`ALTER LOGIN ${q(login || o.login)} WITH PASSWORD = ${pwd()}`)
  return statements
}

/** The statements that create the principal, or turn the original into the draft. */
export function principalStatements(
  dialect: Dialect,
  draft: PrincipalDraft,
  options: PrincipalOptions = {}
): string[] {
  switch (dialect) {
    case 'postgres':
      return pgStatements(draft, options)
    case 'mysql':
      return mysqlStatements(draft, options)
    case 'tsql':
      return tsqlStatements(draft, options)
    case 'sqlite':
      return []
  }
}

export interface DropPrincipalOptions {
  /** PostgreSQL: DROP OWNED BY first, in the current database */
  dropOwned?: boolean
  /** SQL Server: the user's login, dropped after the user; '' keeps it */
  login?: string
  /** SQL Server: a role's members, which have to leave before it can be dropped */
  members?: Principal[]
}

export function dropPrincipalStatements(
  dialect: Dialect,
  p: Principal,
  options: DropPrincipalOptions = {}
): string[] {
  const who = granteeSql(dialect, p)
  switch (dialect) {
    case 'postgres':
      return [...(options.dropOwned ? [`DROP OWNED BY ${who}`] : []), `DROP ROLE ${who}`]
    case 'mysql':
      return [`DROP ${p.kind === 'role' ? 'ROLE' : 'USER'} ${who}`]
    case 'tsql':
      if (p.kind === 'role') {
        return [
          ...(options.members ?? []).map(
            (m) => `ALTER ROLE ${who} DROP MEMBER ${granteeSql(dialect, m)}`
          ),
          `DROP ROLE ${who}`
        ]
      }
      return [
        `DROP USER ${who}`,
        ...(options.login ? [`DROP LOGIN ${quoteIdent(dialect, options.login)}`] : [])
      ]
    case 'sqlite':
      return []
  }
}

/** A principal from its principalKey, for members that aren't in the listing. */
function principalFromKey(dialect: Dialect, key: string): Principal {
  const at = dialect === 'mysql' ? key.lastIndexOf('@') : -1
  return at < 0
    ? { name: key, host: null, kind: 'user', builtin: false }
    : { name: key.slice(0, at), host: key.slice(at + 1), kind: 'user', builtin: false }
}

/**
 * The statements that turn a role's members from the original into the draft. Keys are
 * principalKey of each member; 'grantable' means WITH ADMIN OPTION.
 */
export function memberStatements(
  dialect: Dialect,
  role: Principal,
  members: Principal[],
  original: GrantMap,
  draft: GrantMap
): string[] {
  const byKey = new Map(members.map((m) => [principalKey(m), m]))
  const roleKey = principalKey(role)
  const keys = [...new Set([...byKey.keys(), ...Object.keys(original), ...Object.keys(draft)])]
  return keys.flatMap((key) =>
    membershipStatements(
      dialect,
      byKey.get(key) ?? principalFromKey(dialect, key),
      [role],
      { [roleKey]: levelOf(original, key) },
      { [roleKey]: levelOf(draft, key) }
    )
  )
}

/** Why the draft can't be applied yet, or null. */
export function validatePrincipal(
  dialect: Dialect,
  d: PrincipalDraft,
  options: PrincipalOptions = {}
): string | null {
  const noun = d.type === 'role' ? 'role' : 'user'
  if (!d.name.trim()) return `Name the ${noun}`
  if (dialect === 'mysql' && d.type === 'user' && !d.host.trim())
    return "Enter the host the user connects from ('%' for any)"
  const limit = d.connectionLimit.trim()
  if (limit && !/^\d+$/.test(limit)) return 'The connection limit must be a whole number'
  if (dialect === 'mysql' && d.type === 'user' && d.plugins.length) {
    const mariadb = !!options.mariadb
    const bad = d.plugins.find((p) => !validPluginName(p))
    if (bad !== undefined) return bad ? `${bad} isn't a plugin name` : 'Pick a sign-in method'
    if (new Set(d.plugins).size < d.plugins.length) return 'List each sign-in method once'
    if (!mariadb && d.plugins.length > 1) return 'MySQL accounts have one authentication plugin'
    const changed = !d.original || !samePlugins(d.plugins, d.original.plugins)
    const needs = d.plugins.find((p) => authPlugin(p, mariadb).password)
    if (changed && needs && !d.password) return `Enter a password for ${needs}`
  }
  if (dialect === 'tsql' && d.type === 'user' && !d.original) {
    if (d.auth === 'login' && !d.login.trim()) return 'Pick or name a login'
    if (d.auth === 'login' && d.createLogin && !d.password) return 'Enter a password for the login'
    if (d.auth === 'password' && !d.password) return 'Enter a password'
    if (options.babelfish && d.auth !== 'login') return 'Babelfish users need a login'
  }
  return null
}
