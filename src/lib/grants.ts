import type { Cell, DbObject } from './api'
import type { Dialect } from './engines'
import { literal, qualified, quoteIdent } from './sql'

/**
 * What privileges are granted on. The bulk kinds (tables, sequences, routines) are
 * PostgreSQL's ALL … IN SCHEMA forms; 'server' is MySQL's global *.* level.
 */
export type SecurableKind =
  | 'server'
  | 'database'
  | 'schema'
  | 'tables'
  | 'sequences'
  | 'routines'
  | 'table'
  | 'view'
  | 'sequence'
  | 'function'
  | 'procedure'

export interface Securable {
  kind: SecurableKind
  /** Schema holding the object, or the database itself on MySQL; null for server and database */
  schema: string | null
  /** The object, or the database for 'database'; null for schemas and bulk kinds */
  name: string | null
  /** PostgreSQL routine arguments, which tell overloads apart */
  args: string | null
}

export interface Principal {
  name: string
  /** MySQL account host; null elsewhere */
  host: string | null
  kind: 'user' | 'role' | 'group' | 'public'
  /** Predefined roles (PostgreSQL pg_*, SQL Server fixed roles) and MySQL system accounts */
  builtin: boolean
}

/**
 * How a grantee holds a privilege. 'grantable' is WITH GRANT OPTION; 'deny' is
 * SQL Server only; 'partial' describes bulk kinds where only some objects have it.
 */
export type GrantLevel = 'none' | 'grant' | 'grantable' | 'deny' | 'partial'

/** Privilege (or, for role membership, role key) → level; missing keys are 'none' */
export type GrantMap = Record<string, GrantLevel>

export interface GrantState {
  privileges: GrantMap
  /** MySQL: WITH GRANT OPTION, which covers every privilege at a level */
  grantOption: boolean
  /** PostgreSQL bulk kinds: default privileges on objects the current role creates later */
  defaults: GrantMap
  /**
   * MySQL databases: the name as the server stores the grant, when it was granted
   * without escaping _ and % (so it also matches other databases)
   */
  databasePattern?: string
}

export const emptyGrantState = (): GrantState => ({
  privileges: {},
  grantOption: false,
  defaults: {}
})

export const levelOf = (map: GrantMap, key: string): GrantLevel => map[key] ?? 'none'

export const PUBLIC_PRINCIPAL: Principal = {
  name: 'PUBLIC',
  host: null,
  kind: 'public',
  builtin: true
}

/** Identifies a principal; MySQL accounts are a user and host pair. */
export const principalKey = (p: Pick<Principal, 'name' | 'host'>): string =>
  p.host === null ? p.name : `${p.name}@${p.host}`

export function principalLabel(p: Principal): string {
  if (p.host === null) return p.name
  return p.host === '' && p.kind === 'role' ? p.name : `${p.name}@${p.host}`
}

const OBJECT_KINDS: SecurableKind[] = ['table', 'view', 'sequence', 'function', 'procedure']
const BULK_KINDS: SecurableKind[] = ['tables', 'sequences', 'routines']

export const isObjectKind = (kind: SecurableKind): boolean => OBJECT_KINDS.includes(kind)
export const isBulkKind = (kind: SecurableKind): boolean => BULK_KINDS.includes(kind)

export function securableKinds(dialect: Dialect): SecurableKind[] {
  switch (dialect) {
    case 'postgres':
      return [
        'database',
        'schema',
        'tables',
        'sequences',
        'routines',
        'table',
        'view',
        'sequence',
        'function',
        'procedure'
      ]
    case 'mysql':
      return ['server', 'database', 'table', 'view', 'function', 'procedure']
    case 'tsql':
      return ['database', 'schema', 'table', 'view', 'function', 'procedure']
    case 'sqlite':
      // SQLite has no users, roles or grants
      return []
  }
}

export const SECURABLE_LABELS: Record<SecurableKind, string> = {
  server: 'Server (all databases)',
  database: 'Database',
  schema: 'Schema',
  tables: 'All tables in schema',
  sequences: 'All sequences in schema',
  routines: 'All functions in schema',
  table: 'Table',
  view: 'View',
  sequence: 'Sequence',
  function: 'Function',
  procedure: 'Procedure'
}

/**
 * Whether the kind is picked inside a schema (a database on MySQL). SQL Server lists
 * objects across every schema, so only its schema kind needs one picked.
 */
export function needsContainer(dialect: Dialect, kind: SecurableKind): boolean {
  switch (dialect) {
    case 'postgres':
      return kind !== 'database'
    case 'mysql':
      return kind !== 'server' && kind !== 'database'
    case 'tsql':
      return kind === 'schema'
    case 'sqlite':
      // SQLite has no users, roles or grants
      return false
  }
}

/** The securable kind an explorer object maps to, or null if it can't take grants here. */
export function objectSecurableKind(
  dialect: Dialect,
  kind: DbObject['kind']
): SecurableKind | null {
  switch (kind) {
    case 'table':
    case 'foreign_table':
      return 'table'
    case 'view':
    case 'materialized_view':
      return 'view'
    case 'sequence':
      return dialect === 'postgres' ? 'sequence' : null
    case 'function':
    case 'procedure':
      return kind
    default:
      return null
  }
}

export function securableFor(dialect: Dialect, database: string, obj: DbObject): Securable | null {
  const kind = objectSecurableKind(dialect, obj.kind)
  if (!kind) return null
  return {
    kind,
    schema: dialect === 'mysql' ? database : obj.schema,
    name: obj.name,
    args:
      dialect === 'postgres' && (kind === 'function' || kind === 'procedure')
        ? (obj.detail ?? '')
        : null
  }
}

/** Whether every part the securable's kind needs has been picked. */
export function securableComplete(dialect: Dialect, s: Securable): boolean {
  if (needsContainer(dialect, s.kind) && !s.schema) return false
  if ((isObjectKind(s.kind) || s.kind === 'database') && !s.name) return false
  return true
}

export function securableLabel(s: Securable): string {
  switch (s.kind) {
    case 'server':
      return 'all databases'
    case 'database':
      return `database ${s.name}`
    case 'schema':
      return `schema ${s.schema}`
    case 'tables':
    case 'sequences':
    case 'routines':
      return `${SECURABLE_LABELS[s.kind].toLowerCase()} ${s.schema}`
    default: {
      const name = s.schema ? `${s.schema}.${s.name}` : (s.name ?? '')
      return `${s.kind} ${name}${s.args !== null ? `(${s.args})` : ''}`
    }
  }
}

/* ---------- Privileges ---------- */

const PG_TABLE = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
const PG_SEQUENCE = ['USAGE', 'SELECT', 'UPDATE']

const MYSQL_TABLE = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
  'REFERENCES',
  'CREATE VIEW',
  'SHOW VIEW',
  'TRIGGER'
]
const MYSQL_DATABASE = [
  ...MYSQL_TABLE,
  'CREATE ROUTINE',
  'ALTER ROUTINE',
  'EXECUTE',
  'EVENT',
  'CREATE TEMPORARY TABLES',
  'LOCK TABLES'
]
const MYSQL_SERVER = [
  ...MYSQL_DATABASE,
  'PROCESS',
  'RELOAD',
  'SHOW DATABASES',
  'FILE',
  'SUPER',
  'REPLICATION CLIENT',
  'REPLICATION SLAVE',
  'CREATE USER',
  'CREATE TABLESPACE',
  'SHUTDOWN'
]

const TSQL_OBJECT = ['ALTER', 'CONTROL', 'VIEW DEFINITION', 'TAKE OWNERSHIP']
const TSQL_DATABASE = [
  'CONNECT',
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'EXECUTE',
  'REFERENCES',
  'VIEW DEFINITION',
  'SHOWPLAN',
  'VIEW DATABASE STATE',
  'CREATE TABLE',
  'CREATE VIEW',
  'CREATE PROCEDURE',
  'CREATE FUNCTION',
  'CREATE SCHEMA',
  'ALTER ANY SCHEMA',
  'BACKUP DATABASE',
  'ALTER',
  'CONTROL'
]
const TSQL_SCHEMA = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'EXECUTE',
  'REFERENCES',
  'CREATE SEQUENCE',
  ...TSQL_OBJECT
]

function basePrivileges(dialect: Dialect, kind: SecurableKind): string[] {
  if (dialect === 'postgres') {
    switch (kind) {
      case 'database':
        return ['CONNECT', 'CREATE', 'TEMPORARY']
      case 'schema':
        return ['USAGE', 'CREATE']
      case 'tables':
      case 'table':
      case 'view':
        return PG_TABLE
      case 'sequences':
      case 'sequence':
        return PG_SEQUENCE
      default:
        return ['EXECUTE']
    }
  }
  if (dialect === 'mysql') {
    switch (kind) {
      case 'server':
        return MYSQL_SERVER
      case 'database':
        return MYSQL_DATABASE
      case 'function':
      case 'procedure':
        return ['EXECUTE', 'ALTER ROUTINE']
      default:
        return MYSQL_TABLE
    }
  }
  switch (kind) {
    case 'database':
      return TSQL_DATABASE
    case 'schema':
      return TSQL_SCHEMA
    case 'procedure':
      return ['EXECUTE', ...TSQL_OBJECT]
    case 'function':
      return ['EXECUTE', 'SELECT', 'REFERENCES', ...TSQL_OBJECT]
    default:
      return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', ...TSQL_OBJECT]
  }
}

/**
 * The privileges the form offers: the common ones for the kind, plus any others the
 * grantee already holds (newer or dynamic privileges such as MAINTAIN or BACKUP_ADMIN).
 */
export function privilegeOptions(
  dialect: Dialect,
  kind: SecurableKind,
  held: GrantState | null = null
): string[] {
  const base = basePrivileges(dialect, kind)
  const extra = held
    ? [...Object.keys(held.privileges), ...Object.keys(held.defaults)].filter(
        (p, i, all) => !base.includes(p) && all.indexOf(p) === i
      )
    : []
  return [...base, ...extra.sort()]
}

/* ---------- Catalog queries ---------- */

/**
 * Queries listing users and roles, tried in order until one succeeds. Each returns
 * rows of name, host, kind ('user' | 'role' | 'group') and builtin ('y' | 'n').
 * `mariadb` picks the MySQL or MariaDB query when the server is known; undefined tries both.
 */
export function principalQueries(dialect: Dialect, mariadb?: boolean): string[] {
  switch (dialect) {
    case 'postgres':
      return [
        "SELECT rolname, NULL, CASE WHEN rolcanlogin THEN 'user' ELSE 'role' END, \
           CASE WHEN rolname ~ '^pg_' THEN 'y' ELSE 'n' END \
         FROM pg_roles ORDER BY 1"
      ]
    case 'mysql': {
      const system =
        "CASE WHEN User IN ('mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys') THEN 'y' ELSE 'n' END"
      // MariaDB flags roles
      const maria = `SELECT User, Host, CASE WHEN is_role = 'Y' THEN 'role' ELSE 'user' END, ${system} FROM mysql.user ORDER BY 1, 2`
      // MySQL roles are locked accounts without a password, by convention
      const mysql = `SELECT User, Host, CASE WHEN account_locked = 'Y' AND authentication_string = '' THEN 'role' ELSE 'user' END, ${system} FROM mysql.user ORDER BY 1, 2`
      return [
        // Skipping the other server's query keeps its 'Unknown column' error out of the log
        ...(mariadb === false ? [] : [maria]),
        ...(mariadb === true ? [] : [mysql]),
        // Without access to mysql.user, the accounts that hold privileges
        "SELECT DISTINCT GRANTEE, NULL, 'user', 'n' FROM information_schema.USER_PRIVILEGES ORDER BY 1"
      ]
    }
    case 'tsql':
      return [
        "SELECT name, NULL, CASE WHEN type IN ('R', 'A') THEN 'role' WHEN type IN ('G', 'X') THEN 'group' ELSE 'user' END, \
           CASE WHEN principal_id BETWEEN 16384 AND 16393 OR name = 'public' THEN 'y' ELSE 'n' END \
         FROM sys.database_principals \
         WHERE type IN ('S', 'U', 'G', 'R', 'E', 'X', 'A') AND name NOT IN ('sys', 'INFORMATION_SCHEMA') \
         ORDER BY name"
      ]
    case 'sqlite':
      // SQLite has no users, roles or grants
      return []
  }
}

const text = (cell: Cell | undefined): string => (typeof cell === 'string' ? cell : '')

export function parsePrincipals(rows: Cell[][]): Principal[] {
  return rows.map((r) => {
    let name = text(r[0])
    let host = typeof r[1] === 'string' ? r[1] : null
    // information_schema grantees read 'user'@'host'
    const quoted = host === null ? /^'(.*)'@'(.*)'$/.exec(name) : null
    if (quoted) [, name, host] = quoted
    const kind = text(r[2])
    return {
      name,
      host,
      kind: kind === 'role' || kind === 'group' ? kind : 'user',
      builtin: text(r[3]) === 'y'
    }
  })
}

/** A principal as written in GRANT and REVOKE. */
export function granteeSql(dialect: Dialect, p: Principal): string {
  if (p.kind === 'public' && dialect === 'postgres') return 'PUBLIC'
  if (dialect !== 'mysql') return quoteIdent(dialect, p.name)
  // MariaDB roles have no host
  if (p.host === null || (p.host === '' && p.kind === 'role')) return literal('mysql', p.name)
  return `${literal('mysql', p.name)}@${literal('mysql', p.host)}`
}

function pgRoleOid(p: Principal): string {
  return p.kind === 'public'
    ? '0'
    : `(SELECT oid FROM pg_roles WHERE rolname = ${literal('postgres', p.name)})`
}

const pgSchema = (schema: string | null): string =>
  `${literal('postgres', quoteIdent('postgres', schema ?? ''))}::regnamespace`

const RELKINDS: Partial<Record<SecurableKind, string>> = {
  tables: "('r', 'p', 'v', 'm', 'f')",
  sequences: "('S')"
}

const DEFAULT_OBJTYPE: Partial<Record<SecurableKind, string>> = {
  tables: 'r',
  sequences: 'S',
  routines: 'f'
}

/** ALTER DEFAULT PRIVILEGES object types */
const DEFAULT_OBJECTS: Partial<Record<SecurableKind, string>> = {
  tables: 'TABLES',
  sequences: 'SEQUENCES',
  routines: 'ROUTINES'
}

/**
 * The query reading what the grantee holds on the securable. PostgreSQL and MySQL rows
 * are privilege and grantable ('YES' | 'NO'); bulk kinds add how many objects hold it,
 * how many grantably and how many there are; SQL Server rows are permission and state
 * (G, W or D); MySQL routines return the account's Proc_priv set.
 */
export function grantQuery(dialect: Dialect, grantee: Principal, s: Securable): string {
  const lit = (v: string): string => literal(dialect, v)
  if (dialect === 'postgres') {
    const who = pgRoleOid(grantee)
    if (isBulkKind(s.kind)) {
      const objects =
        s.kind === 'routines'
          ? `SELECT p.oid AS id, coalesce(p.proacl, acldefault('f', p.proowner)) AS acl FROM pg_proc p \
             WHERE p.pronamespace = ${pgSchema(s.schema)} AND p.prokind IN ('f', 'p')`
          : `SELECT c.oid AS id, coalesce(c.relacl, acldefault('${s.kind === 'sequences' ? 's' : 'r'}', c.relowner)) AS acl \
             FROM pg_class c WHERE c.relnamespace = ${pgSchema(s.schema)} AND c.relkind IN ${RELKINDS[s.kind]}`
      return `WITH objects AS (${objects}), \
        held AS (SELECT o.id, a.privilege_type, bool_or(a.is_grantable) AS grantable \
                 FROM objects o, aclexplode(o.acl) a WHERE a.grantee = ${who} GROUP BY 1, 2) \
        SELECT privilege_type, count(*)::text, (count(*) FILTER (WHERE grantable))::text, \
          (SELECT count(*) FROM objects)::text \
        FROM held GROUP BY 1`
    }
    let from: string
    switch (s.kind) {
      case 'database':
        from = `pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a \
          WHERE d.datname = ${lit(s.name ?? '')}`
        break
      case 'schema':
        from = `pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a \
          WHERE n.nspname = ${lit(s.schema ?? '')}`
        break
      case 'function':
      case 'procedure':
        // Identity arguments may carry names, which regprocedure doesn't accept
        from = `pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, \
          aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a \
          WHERE n.nspname = ${lit(s.schema ?? '')} AND p.proname = ${lit(s.name ?? '')} \
            AND pg_get_function_identity_arguments(p.oid) = ${lit(s.args ?? '')}`
        break
      default:
        from = `pg_class c, aclexplode(coalesce(c.relacl, acldefault('${s.kind === 'sequence' ? 's' : 'r'}', c.relowner))) a \
          WHERE c.oid = ${lit(qualified(dialect, { schema: s.schema, name: s.name ?? '' }))}::regclass`
    }
    return `SELECT a.privilege_type, CASE WHEN bool_or(a.is_grantable) THEN 'YES' ELSE 'NO' END \
      FROM ${from} AND a.grantee = ${who} GROUP BY 1`
  }

  if (dialect === 'mysql') {
    if (s.kind === 'function' || s.kind === 'procedure') {
      return `SELECT Proc_priv FROM mysql.procs_priv \
        WHERE User = ${lit(grantee.name)} AND Host = ${lit(grantee.host ?? '')} \
          AND Db = ${lit(s.schema ?? '')} AND Routine_name = ${lit(s.name ?? '')} \
          AND Routine_type = ${lit(s.kind.toUpperCase())}`
    }
    const who = lit(`'${grantee.name}'@'${grantee.host ?? ''}'`)
    if (s.kind === 'server')
      return `SELECT PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ${who}`
    if (s.kind === 'database') {
      // Database grants are stored as LIKE patterns: my\_db is the database, my_db any match
      const names = [...new Set([mysqlDatabasePattern(s.name ?? ''), s.name ?? ''])]
      return `SELECT PRIVILEGE_TYPE, IS_GRANTABLE, TABLE_SCHEMA FROM information_schema.SCHEMA_PRIVILEGES \
        WHERE GRANTEE = ${who} AND TABLE_SCHEMA IN (${names.map(lit).join(', ')})`
    }
    return `SELECT PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES \
      WHERE GRANTEE = ${who} AND TABLE_SCHEMA = ${lit(s.schema ?? '')} AND TABLE_NAME = ${lit(s.name ?? '')}`
  }

  const target =
    s.kind === 'database'
      ? 'class = 0'
      : s.kind === 'schema'
        ? `class = 3 AND major_id = SCHEMA_ID(${lit(s.schema ?? '')})`
        : `class = 1 AND minor_id = 0 AND major_id = OBJECT_ID(${lit(qualified(dialect, { schema: s.schema, name: s.name ?? '' }))})`
  return `SELECT permission_name, state FROM sys.database_permissions \
    WHERE grantee_principal_id = DATABASE_PRINCIPAL_ID(${lit(grantee.name)}) AND ${target}`
}

/** Reads grantQuery's rows. */
export function parseGrantRows(dialect: Dialect, s: Securable, rows: Cell[][]): GrantState {
  const state = emptyGrantState()
  if (dialect === 'tsql') {
    for (const r of rows) {
      const st = text(r[1])
      state.privileges[text(r[0])] = st === 'W' ? 'grantable' : st === 'D' ? 'deny' : 'grant'
    }
    return state
  }
  if (dialect === 'mysql') {
    if (s.kind === 'function' || s.kind === 'procedure') {
      for (const p of text(rows[0]?.[0]).split(',').filter(Boolean)) {
        if (p.toLowerCase() === 'grant') state.grantOption = true
        else state.privileges[p.toUpperCase()] = 'grant'
      }
      return state
    }
    // Database grants: prefer the escaped one; an unescaped one is read (and edited) as stored
    const escaped = mysqlDatabasePattern(s.name ?? '')
    const stored =
      s.kind !== 'database' || rows.some((r) => r[2] == null || text(r[2]) === escaped)
        ? escaped
        : text(rows[0]?.[2])
    const held = rows.filter((r) => r[2] == null || text(r[2]) === stored)
    if (s.kind === 'database' && held.length && stored !== escaped) state.databasePattern = stored
    for (const r of held) {
      const p = text(r[0])
      if (text(r[1]) === 'YES') state.grantOption = true
      // USAGE means "no privileges"
      if (p !== 'USAGE') state.privileges[p] = 'grant'
    }
    return state
  }
  for (const r of rows) {
    if (isBulkKind(s.kind)) {
      const [held, grantable, total] = [r[1], r[2], r[3]].map((c) => Number(text(c)))
      state.privileges[text(r[0])] =
        held < total ? 'partial' : grantable === total ? 'grantable' : 'grant'
    } else {
      state.privileges[text(r[0])] = text(r[1]) === 'YES' ? 'grantable' : 'grant'
    }
  }
  return state
}

/** PostgreSQL bulk kinds: the query reading the current role's default privileges for the grantee. */
export function defaultsQuery(grantee: Principal, s: Securable): string | null {
  const objtype = DEFAULT_OBJTYPE[s.kind]
  if (!objtype) return null
  return `SELECT a.privilege_type, CASE WHEN bool_or(a.is_grantable) THEN 'YES' ELSE 'NO' END \
    FROM pg_default_acl d, aclexplode(d.defaclacl) a \
    WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user) \
      AND d.defaclnamespace = ${pgSchema(s.schema)} AND d.defaclobjtype = '${objtype}' \
      AND a.grantee = ${pgRoleOid(grantee)} \
    GROUP BY 1`
}

export function parseDefaultRows(rows: Cell[][]): GrantMap {
  return Object.fromEntries(
    rows.map((r) => [text(r[0]), text(r[1]) === 'YES' ? 'grantable' : 'grant'] as const)
  )
}

/**
 * Queries reading the roles the grantee is a member of, tried in order until one
 * succeeds. Rows are role name, host and admin option ('YES' | 'NO').
 */
export function membershipQueries(dialect: Dialect, grantee: Principal): string[] {
  const lit = (v: string): string => literal(dialect, v)
  switch (dialect) {
    case 'postgres':
      return [
        `SELECT r.rolname, NULL, CASE WHEN bool_or(m.admin_option) THEN 'YES' ELSE 'NO' END \
         FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid \
         WHERE m.member = ${pgRoleOid(grantee)} GROUP BY 1`
      ]
    case 'mysql': {
      const user = lit(grantee.name)
      const host = lit(grantee.host ?? '')
      return [
        `SELECT FROM_USER, FROM_HOST, CASE WHEN WITH_ADMIN_OPTION = 'Y' THEN 'YES' ELSE 'NO' END \
         FROM mysql.role_edges WHERE TO_USER = ${user} AND TO_HOST = ${host}`,
        // MariaDB
        `SELECT Role, '', CASE WHEN Admin_option = 'Y' THEN 'YES' ELSE 'NO' END \
         FROM mysql.roles_mapping WHERE User = ${user} AND Host = ${host}`
      ]
    }
    case 'tsql':
      return [
        `SELECT r.name, NULL, 'NO' FROM sys.database_role_members m \
         JOIN sys.database_principals r ON r.principal_id = m.role_principal_id \
         WHERE m.member_principal_id = DATABASE_PRINCIPAL_ID(${lit(grantee.name)})`
      ]
    case 'sqlite':
      // SQLite has no users, roles or grants
      return []
  }
}

/** Reads membership rows into role key → 'grant' (member) or 'grantable' (admin). */
export function parseMembershipRows(rows: Cell[][]): GrantMap {
  return Object.fromEntries(
    rows.map((r) => {
      const key = principalKey({ name: text(r[0]), host: typeof r[1] === 'string' ? r[1] : null })
      return [key, text(r[2]) === 'YES' ? 'grantable' : 'grant'] as const
    })
  )
}

/* ---------- Statements ---------- */

type Verb = 'GRANT' | 'GRANT_OPTION' | 'REVOKE' | 'REVOKE_OPTION' | 'DENY'

interface Change {
  verb: Verb
  cascade: boolean
}

/** What turns one level into another; null when nothing needs to run. */
function change(from: GrantLevel, to: GrantLevel): Change | null {
  if (to === from || to === 'partial') return null
  // A grantable privilege can't be revoked or denied without what was granted on from it
  const cascade = from === 'grantable'
  switch (to) {
    case 'none':
      return { verb: 'REVOKE', cascade }
    case 'grant':
      return from === 'grantable'
        ? { verb: 'REVOKE_OPTION', cascade: true }
        : { verb: 'GRANT', cascade: false }
    case 'grantable':
      return { verb: 'GRANT_OPTION', cascade: false }
    case 'deny':
      return { verb: 'DENY', cascade }
  }
}

const VERB_ORDER: Verb[] = ['REVOKE_OPTION', 'REVOKE', 'DENY', 'GRANT', 'GRANT_OPTION']

/** Diffs two maps and groups the keys by the change each needs, in a stable order. */
function changes(
  keys: string[],
  from: GrantMap,
  to: GrantMap
): { change: Change; keys: string[] }[] {
  const groups = new Map<string, { change: Change; keys: string[] }>()
  for (const key of keys) {
    const c = change(levelOf(from, key), levelOf(to, key))
    if (!c) continue
    const id = `${c.verb}/${c.cascade}`
    const group = groups.get(id) ?? { change: c, keys: [] }
    group.keys.push(key)
    groups.set(id, group)
  }
  return [...groups.values()].sort(
    (a, b) =>
      VERB_ORDER.indexOf(a.change.verb) - VERB_ORDER.indexOf(b.change.verb) ||
      Number(a.change.cascade) - Number(b.change.cascade)
  )
}

/** A MySQL database name as a grant pattern, with `\` and the _ and % wildcards escaped. */
export function mysqlDatabasePattern(name: string): string {
  return name.replace(/[\\_%]/g, '\\$&')
}

/** The ON clause target; null for SQL Server database permissions, which have none. */
function onTarget(dialect: Dialect, s: Securable, databasePattern?: string): string | null {
  const q = (n: string | null): string => quoteIdent(dialect, n ?? '')
  const object = qualified(dialect, { schema: s.schema, name: s.name ?? '' })
  if (dialect === 'postgres') {
    switch (s.kind) {
      case 'database':
        return `DATABASE ${q(s.name)}`
      case 'schema':
        return `SCHEMA ${q(s.schema)}`
      case 'tables':
        return `ALL TABLES IN SCHEMA ${q(s.schema)}`
      case 'sequences':
        return `ALL SEQUENCES IN SCHEMA ${q(s.schema)}`
      case 'routines':
        return `ALL ROUTINES IN SCHEMA ${q(s.schema)}`
      case 'sequence':
        return `SEQUENCE ${object}`
      case 'function':
      case 'procedure':
        return `${s.kind.toUpperCase()} ${object}(${s.args ?? ''})`
      default:
        return `TABLE ${object}`
    }
  }
  if (dialect === 'mysql') {
    switch (s.kind) {
      case 'server':
        return '*.*'
      case 'database':
        return `${q(databasePattern ?? mysqlDatabasePattern(s.name ?? ''))}.*`
      case 'function':
      case 'procedure':
        return `${s.kind.toUpperCase()} ${object}`
      default:
        return object
    }
  }
  switch (s.kind) {
    case 'database':
      return null
    case 'schema':
      return `SCHEMA::${q(s.schema)}`
    default:
      return `OBJECT::${object}`
  }
}

function render(
  { verb, cascade }: Change,
  privileges: string,
  on: string | null,
  grantee: string
): string {
  const onClause = on ? ` ON ${on}` : ''
  const tail = cascade ? ' CASCADE' : ''
  switch (verb) {
    case 'GRANT':
      return `GRANT ${privileges}${onClause} TO ${grantee}`
    case 'GRANT_OPTION':
      return `GRANT ${privileges}${onClause} TO ${grantee} WITH GRANT OPTION`
    case 'REVOKE':
      return `REVOKE ${privileges}${onClause} FROM ${grantee}${tail}`
    case 'REVOKE_OPTION':
      return `REVOKE GRANT OPTION FOR ${privileges}${onClause} FROM ${grantee}${tail}`
    case 'DENY':
      return `DENY ${privileges}${onClause} TO ${grantee}${tail}`
  }
}

/** The GRANT, REVOKE and DENY statements that turn the original grants into the draft. */
export function grantStatements(
  dialect: Dialect,
  grantee: Principal,
  s: Securable,
  original: GrantState,
  draft: GrantState
): string[] {
  const who = granteeSql(dialect, grantee)
  const on = onTarget(dialect, s, original.databasePattern)
  const options = privilegeOptions(dialect, s.kind, original)
  const keys = [...options, ...Object.keys(draft.privileges).filter((p) => !options.includes(p))]

  if (dialect === 'mysql') {
    // MySQL's grant option belongs to the level, not to each privilege
    const added = keys.filter(
      (p) => levelOf(draft.privileges, p) !== 'none' && levelOf(original.privileges, p) === 'none'
    )
    const removed = keys.filter(
      (p) => levelOf(draft.privileges, p) === 'none' && levelOf(original.privileges, p) !== 'none'
    )
    const statements: string[] = []
    if (original.grantOption && !draft.grantOption)
      statements.push(`REVOKE GRANT OPTION ON ${on} FROM ${who}`)
    if (removed.length) statements.push(`REVOKE ${removed.join(', ')} ON ${on} FROM ${who}`)
    if (draft.grantOption && !original.grantOption) {
      // Granting what's held again WITH GRANT OPTION adds the option to the level
      const all = keys.filter((p) => levelOf(draft.privileges, p) !== 'none')
      statements.push(`GRANT ${all.join(', ') || 'USAGE'} ON ${on} TO ${who} WITH GRANT OPTION`)
    } else if (added.length) {
      statements.push(`GRANT ${added.join(', ')} ON ${on} TO ${who}`)
    }
    return statements
  }

  const statements = changes(keys, original.privileges, draft.privileges).map((g) =>
    render(g.change, g.keys.join(', '), on, who)
  )
  const objects = DEFAULT_OBJECTS[s.kind]
  if (dialect === 'postgres' && objects) {
    const prefix = `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdent(dialect, s.schema ?? '')} `
    for (const g of changes(keys, original.defaults, draft.defaults))
      statements.push(prefix + render(g.change, g.keys.join(', '), objects, who))
  }
  return statements
}

/**
 * The statements that turn the grantee's role memberships from the original into the
 * draft. Keys are principalKey of each role; 'grantable' means WITH ADMIN OPTION.
 */
export function membershipStatements(
  dialect: Dialect,
  grantee: Principal,
  roles: Principal[],
  original: GrantMap,
  draft: GrantMap
): string[] {
  const who = granteeSql(dialect, grantee)
  const byKey = new Map(roles.map((r) => [principalKey(r), r]))
  const name = (key: string): string => {
    const role = byKey.get(key)
    return role ? granteeSql(dialect, role) : quoteIdent(dialect, key)
  }
  // In the order the roles are listed, then any held role that isn't
  const keys = [...new Set([...byKey.keys(), ...Object.keys(original), ...Object.keys(draft)])]

  if (dialect === 'tsql') {
    // SQL Server roles have no admin option
    return keys.flatMap((key) => {
      const was = levelOf(original, key) !== 'none'
      const is = levelOf(draft, key) !== 'none'
      if (was === is) return []
      return [`ALTER ROLE ${name(key)} ${is ? 'ADD' : 'DROP'} MEMBER ${who}`]
    })
  }

  const statements: string[] = []
  for (const g of changes(keys, original, draft)) {
    const list = g.keys.map(name).join(', ')
    switch (g.change.verb) {
      case 'GRANT':
        statements.push(`GRANT ${list} TO ${who}`)
        break
      case 'GRANT_OPTION':
        statements.push(`GRANT ${list} TO ${who} WITH ADMIN OPTION`)
        break
      case 'REVOKE':
        statements.push(`REVOKE ${list} FROM ${who}`)
        break
      case 'REVOKE_OPTION':
        // MySQL can't revoke just the admin option, so the membership is granted again
        statements.push(
          ...(dialect === 'postgres'
            ? [`REVOKE ADMIN OPTION FOR ${list} FROM ${who}`]
            : [`REVOKE ${list} FROM ${who}`, `GRANT ${list} TO ${who}`])
        )
        break
    }
  }
  return statements
}

/** Why the draft can't be applied yet, or null. */
export function validateGrant(
  dialect: Dialect,
  grantee: Principal | null,
  s: Securable,
  draft: GrantState
): string | null {
  if (!grantee) return 'Pick a user or role'
  if (needsContainer(dialect, s.kind) && !s.schema)
    return dialect === 'mysql' ? 'Pick a database' : 'Pick a schema'
  if ((isObjectKind(s.kind) || s.kind === 'database') && !s.name)
    return `Pick a ${s.kind === 'database' ? 'database' : s.kind}`
  if (
    dialect === 'mysql' &&
    draft.grantOption &&
    !Object.values(draft.privileges).some((l) => l !== 'none') &&
    (s.kind === 'function' || s.kind === 'procedure')
  )
    return 'Grant a privilege along with the grant option'
  return null
}
