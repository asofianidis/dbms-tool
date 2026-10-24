import type { Ejson } from './api'

/**
 * MongoDB users and custom roles. Both live in a database (the user's authentication
 * database, the role's database) and are managed with usersInfo, createUser, updateUser,
 * dropUser and their role counterparts.
 */

export interface MongoRoleRef {
  role: string
  db: string
}

export interface MongoPrivilege {
  resource: Record<string, Ejson>
  actions: string[]
}

export interface MongoUser {
  user: string
  db: string
  roles: MongoRoleRef[]
  mechanisms: string[]
}

export interface MongoRole {
  role: string
  db: string
  builtin: boolean
  /** Roles this role inherits from */
  roles: MongoRoleRef[]
  privileges: MongoPrivilege[]
}

/** A user or custom role, as the explorer lists them. */
export interface MongoPrincipal {
  kind: 'user' | 'role'
  name: string
  db: string
}

export const mongoPrincipalKey = (p: { name: string; db: string }): string => `${p.name}@${p.db}`
export const roleRefKey = (r: MongoRoleRef): string => `${r.role}@${r.db}`

/**
 * Built-in roles. Database roles apply to the database they're granted on; the others
 * exist only in admin.
 */
export const BUILTIN_DATABASE_ROLES = ['read', 'readWrite', 'dbAdmin', 'dbOwner', 'userAdmin']
export const BUILTIN_ADMIN_ROLES = [
  'readAnyDatabase',
  'readWriteAnyDatabase',
  'userAdminAnyDatabase',
  'dbAdminAnyDatabase',
  'clusterMonitor',
  'clusterManager',
  'hostManager',
  'clusterAdmin',
  'backup',
  'restore',
  'root'
]

/** The privilege actions offered when writing a role's privileges. */
export const COMMON_ACTIONS = [
  'find',
  'insert',
  'update',
  'remove',
  'createCollection',
  'dropCollection',
  'createIndex',
  'dropIndex',
  'collMod',
  'listCollections',
  'listIndexes',
  'dbStats',
  'collStats',
  'changeStream',
  'killCursors'
]

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

function parseRoleRefs(v: unknown): MongoRoleRef[] {
  return arr(v).map((r) => ({ role: str(obj(r).role), db: str(obj(r).db) }))
}

function parsePrivileges(v: unknown): MongoPrivilege[] {
  return arr(v).map((p) => ({
    resource: obj(obj(p).resource) as Record<string, Ejson>,
    actions: arr(obj(p).actions).map(str)
  }))
}

/** Reads a usersInfo reply. */
export function parseUsersInfo(reply: Ejson): MongoUser[] {
  return arr(obj(reply).users).map((u) => ({
    user: str(obj(u).user),
    db: str(obj(u).db),
    roles: parseRoleRefs(obj(u).roles),
    mechanisms: arr(obj(u).mechanisms).map(str)
  }))
}

/** Reads a rolesInfo reply, or documents from admin.system.roles. */
export function parseRoles(roles: unknown[]): MongoRole[] {
  return roles.map((r) => ({
    role: str(obj(r).role),
    db: str(obj(r).db),
    builtin: obj(r).isBuiltin === true,
    roles: parseRoleRefs(obj(r).roles),
    privileges: parsePrivileges(obj(r).privileges)
  }))
}

export const parseRolesInfo = (reply: Ejson): MongoRole[] => parseRoles(arr(obj(reply).roles))

/** Users first, then roles, each by database and name. */
export function sortPrincipals(list: MongoPrincipal[]): MongoPrincipal[] {
  const rank = (p: MongoPrincipal): number => (p.kind === 'user' ? 0 : 1)
  return [...list].sort(
    (a, b) => rank(a) - rank(b) || a.db.localeCompare(b.db) || a.name.localeCompare(b.name)
  )
}

/* ---------- Commands ---------- */

/** A command and the database it runs in. */
export interface MongoCommand {
  database: string
  command: Record<string, Ejson>
}

export interface MongoUserDraft {
  name: string
  db: string
  /** A new password; '' keeps the current one */
  password: string
  roles: MongoRoleRef[]
  /** The user as loaded; null when creating one */
  original: MongoUser | null
}

export interface MongoRoleDraft {
  name: string
  db: string
  roles: MongoRoleRef[]
  /** Privileges as JSON text, an array of { resource, actions } */
  privileges: string
  original: MongoRole | null
}

const MASK = '********'

const sameRefs = (a: MongoRoleRef[], b: MongoRoleRef[]): boolean =>
  a.length === b.length && a.every((r, i) => roleRefKey(r) === roleRefKey(b[i]))

const refs = (list: MongoRoleRef[]): Ejson[] => list.map((r) => ({ role: r.role, db: r.db }))

export function userCommands(d: MongoUserDraft, mask = false): MongoCommand[] {
  const pwd = mask ? MASK : d.password
  const o = d.original
  if (!o) {
    return [
      {
        database: d.db,
        command: { createUser: d.name.trim(), pwd, roles: refs(d.roles) }
      }
    ]
  }
  const update: Record<string, Ejson> = { updateUser: o.user }
  if (d.password) update.pwd = pwd
  if (!sameRefs(o.roles, d.roles)) update.roles = refs(d.roles)
  return Object.keys(update).length > 1 ? [{ database: o.db, command: update }] : []
}

/** The privileges JSON as written, or an error message. */
export function parsePrivilegeText(textValue: string): MongoPrivilege[] | string {
  let value: unknown
  try {
    value = textValue.trim() ? JSON.parse(textValue) : []
  } catch (e) {
    return `Privileges aren't valid JSON: ${e instanceof Error ? e.message : String(e)}`
  }
  if (!Array.isArray(value)) return 'Privileges must be an array of { resource, actions }'
  for (const [i, p] of value.entries()) {
    const entry = obj(p)
    if (!entry.resource || typeof entry.resource !== 'object')
      return `Privilege ${i + 1} needs a resource, such as { "db": "app", "collection": "" }`
    if (!Array.isArray(entry.actions) || !entry.actions.length)
      return `Privilege ${i + 1} needs at least one action`
  }
  return parsePrivileges(value)
}

export const privilegeText = (privileges: MongoPrivilege[]): string =>
  JSON.stringify(privileges, null, 2)

export function roleCommands(d: MongoRoleDraft): MongoCommand[] {
  const parsed = parsePrivilegeText(d.privileges)
  const privileges = typeof parsed === 'string' ? [] : (parsed as Ejson[])
  const o = d.original
  if (!o) {
    return [
      {
        database: d.db,
        command: { createRole: d.name.trim(), privileges, roles: refs(d.roles) }
      }
    ]
  }
  const update: Record<string, Ejson> = { updateRole: o.role }
  if (JSON.stringify(privileges) !== JSON.stringify(o.privileges)) update.privileges = privileges
  if (!sameRefs(o.roles, d.roles)) update.roles = refs(d.roles)
  return Object.keys(update).length > 1 ? [{ database: o.db, command: update }] : []
}

/**
 * Grants and revokes the role for users whose membership changed. `original` and
 * `draft` are sets of mongoPrincipalKey of the users holding the role.
 */
export function roleMemberCommands(
  role: MongoRoleRef,
  users: MongoUser[],
  original: Set<string>,
  draft: Set<string>
): MongoCommand[] {
  return users.flatMap((u) => {
    const key = mongoPrincipalKey({ name: u.user, db: u.db })
    const was = original.has(key)
    const is = draft.has(key)
    if (was === is) return []
    return [
      {
        database: u.db,
        command: is
          ? { grantRolesToUser: u.user, roles: refs([role]) }
          : { revokeRolesFromUser: u.user, roles: refs([role]) }
      }
    ]
  })
}

export const dropUserCommand = (u: { name: string; db: string }): MongoCommand => ({
  database: u.db,
  command: { dropUser: u.name }
})

export const dropRoleCommand = (r: { name: string; db: string }): MongoCommand => ({
  database: r.db,
  command: { dropRole: r.name }
})

/** The commands as mongosh would run them. */
export function commandScript(commands: MongoCommand[]): string {
  return commands
    .map(
      (c) =>
        `db.getSiblingDB(${JSON.stringify(c.database)}).runCommand(${JSON.stringify(c.command, null, 2)})`
    )
    .join('\n\n')
}

export function validateUser(d: MongoUserDraft): string | null {
  if (!d.name.trim()) return 'Name the user'
  if (!d.db) return 'Pick the database the user authenticates against'
  if (!d.original && !d.password) return 'Enter a password'
  return null
}

export function validateRole(d: MongoRoleDraft): string | null {
  if (!d.name.trim()) return 'Name the role'
  if (!d.db) return 'Pick the database the role belongs to'
  const parsed = parsePrivilegeText(d.privileges)
  return typeof parsed === 'string' ? parsed : null
}
