import { setWriteGuard, type ConnectionConfig, type GuardedWrite, type MongoRequest } from './api'
import { describeRedisDanger, redisIsWrite, redisSummary } from './redis'
import { ENGINES, connectionLabel, type Dialect } from './engines'
import { dangerousStatements, skipQuoted } from './sql'
import { confirm, getConnection } from './workspace'

/** Same list as the backend's read-only guard (guard.rs). */
const WRITE_KEYWORDS = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'upsert',
  'replace',
  'truncate',
  'drop',
  'alter',
  'create',
  'rename',
  'grant',
  'revoke',
  'deny',
  'exec',
  'execute',
  'call',
  'do',
  'copy',
  'load',
  'import',
  'vacuum',
  'reindex',
  'cluster',
  'refresh',
  'lock',
  'into',
  'backup',
  'restore',
  'dbcc',
  'kill',
  'shutdown',
  'bulk',
  'writetext',
  'updatetext',
  'reassign',
  'discard',
  'optimize',
  'repair',
  'flush',
  'purge',
  'install',
  'uninstall'
])

/** The first keyword that could modify data, ignoring strings, quoted identifiers and comments. */
export function sqlWriteKeyword(sql: string, dialect: Dialect): string | null {
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    const skip = skipQuoted(sql, i, dialect)
    if (skip >= 0) {
      i = skip
    } else if (/[A-Za-z_]/.test(c)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) i++
      const word = sql.slice(start, i).toLowerCase()
      if (WRITE_KEYWORDS.has(word)) return word.toUpperCase()
    } else {
      i++
    }
  }
  return null
}

const READ_COMMANDS = new Set([
  'ping',
  'buildinfo',
  'serverstatus',
  'dbstats',
  'collstats',
  'hello',
  'ismaster',
  'listcollections',
  'listdatabases',
  'listindexes',
  'explain',
  'count',
  'distinct',
  'find',
  'getparameter',
  'hostinfo',
  'connectionstatus',
  'currentop',
  'replsetgetstatus',
  'getlog',
  'top',
  'validate',
  'usersinfo',
  'rolesinfo'
])

/** Whether a MongoDB request can modify data, like `MongoRequest::is_write` in the backend. */
export function mongoIsWrite(request: MongoRequest): boolean {
  switch (request.op) {
    case 'find':
    case 'count':
    case 'distinct':
    case 'listIndexes':
      return false
    case 'aggregate':
      return request.pipeline.some(
        (stage) => !!stage && typeof stage === 'object' && ('$out' in stage || '$merge' in stage)
      )
    case 'runCommand': {
      const command = request.command
      const name =
        command && typeof command === 'object' ? Object.keys(command as object)[0] : undefined
      // `{ validate: c, repair: true }` rewrites the collection
      if (name?.toLowerCase() === 'validate' && (command as Record<string, unknown>).repair) {
        return true
      }
      return !name || !READ_COMMANDS.has(name.toLowerCase())
    }
    default:
      return true
  }
}

/** Why a MongoDB request deserves a confirmation, or null when it's routine. */
export function describeMongoDanger(op: MongoRequest): string | null {
  const empty = (f: unknown): boolean =>
    !f || (typeof f === 'object' && Object.keys(f as object).length === 0)
  switch (op.op) {
    case 'deleteMany':
      return empty(op.filter) ? `deleteMany({}) on ${op.collection} deletes every document` : null
    case 'updateMany':
      return empty(op.filter) ? `updateMany({}) on ${op.collection} updates every document` : null
    case 'dropCollection':
      return `drop() removes the ${op.collection} collection`
    case 'dropDatabase':
      return `dropDatabase() removes ${op.database}`
    case 'runCommand': {
      const command = (op.command && typeof op.command === 'object' ? op.command : {}) as Record<
        string,
        unknown
      >
      if (typeof command.dropUser === 'string')
        return `dropUser removes the user ${command.dropUser}@${op.database}`
      if (typeof command.dropRole === 'string')
        return `dropRole removes the role ${command.dropRole}@${op.database}`
      if ('dropAllUsersFromDatabase' in command)
        return `dropAllUsersFromDatabase removes every user of ${op.database}`
      return null
    }
    default:
      return null
  }
}

export function isProduction(connection: ConnectionConfig | undefined): boolean {
  return !!connection?.production
}

interface WriteSummary {
  /** What the write does, in a few words */
  action: string
  /** Destructive parts; any of these means the name has to be typed */
  dangers: string[]
  code?: string
}

function summarize(connection: ConnectionConfig, write: GuardedWrite): WriteSummary | null {
  if ('sql' in write) {
    const dialect = ENGINES[connection.engine].dialect ?? 'postgres'
    const keyword = sqlWriteKeyword(write.sql, dialect)
    if (!keyword) return null
    const sql = write.sql
    return {
      action: `This script runs ${keyword}`,
      dangers: dangerousStatements(sql, dialect),
      code: sql.length > 2000 ? sql.slice(0, 2000) + '\n…' : sql
    }
  }
  if ('redis' in write) {
    if (!redisIsWrite(write.redis)) return null
    const danger = describeRedisDanger(write.redis)
    return { action: redisSummary(write.redis), dangers: danger ? [danger] : [] }
  }
  const { request } = write
  if (!mongoIsWrite(request)) return null
  const target =
    'collection' in request ? `${request.database}.${request.collection}` : request.database
  const danger = describeMongoDanger(request)
  return { action: `This runs ${request.op} on ${target}`, dangers: danger ? [danger] : [] }
}

/**
 * Asks before a write on a production connection; destructive ones need the connection's
 * name typed. Resolves true for anything that isn't a production write.
 */
export async function confirmProductionWrite(
  connection: ConnectionConfig | undefined,
  write: GuardedWrite | WriteSummary
): Promise<boolean> {
  if (!connection || !isProduction(connection)) return true
  const summary = 'action' in write ? write : summarize(connection, write)
  if (!summary) return true
  const label = connectionLabel(connection)
  const typed = summary.dangers.length > 0
  return confirm({
    title: `Change production database ${label}?`,
    message: `${label} is marked as production. ${summary.action}${
      typed ? `, including ${summary.dangers.join('; ')}` : ''
    }.`,
    code: summary.code,
    confirmLabel: 'Run on production',
    danger: true,
    typeToConfirm: typed ? label : undefined
  })
}

let queue: Promise<unknown> = Promise.resolve()

/** Routes every write through `confirmProductionWrite`, one dialog at a time. */
export function startProductionGuard(): () => void {
  setWriteGuard((id, write) => {
    const connection = getConnection(id)
    if (!isProduction(connection)) return Promise.resolve(true)
    const ask = queue.then(() => confirmProductionWrite(connection, write))
    queue = ask.catch(() => {})
    return ask
  })
  return () => setWriteGuard(null)
}
