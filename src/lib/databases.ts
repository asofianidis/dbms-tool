import type { Engine } from './api'
import { literal, quoteIdent } from './sql'

/** Engines whose databases are created, renamed and dropped with the database dialog. */
export type DatabaseEngine = 'postgres' | 'mssql' | 'babelfish'

export function isDatabaseEngine(engine: Engine): engine is DatabaseEngine {
  return engine === 'postgres' || engine === 'mssql' || engine === 'babelfish'
}

/** Babelfish can't rename databases (ALTER DATABASE … MODIFY NAME isn't supported). */
export const canRenameDatabase = (engine: DatabaseEngine): boolean => engine !== 'babelfish'

export interface NewDatabase {
  name: string
  /** PostgreSQL: owning role, '' for the current user */
  owner: string
  /** PostgreSQL: database to copy, '' for template1 */
  template: string
  /** PostgreSQL: character encoding, '' for the template's */
  encoding: string
  /** SQL Server: default collation, '' for the server's */
  collation: string
  /** PostgreSQL: COMMENT ON DATABASE, '' for none */
  comment: string
}

export const emptyDatabase = (): NewDatabase => ({
  name: '',
  owner: '',
  template: '',
  encoding: '',
  collation: '',
  comment: ''
})

const SYSTEM: Record<DatabaseEngine, string[]> = {
  postgres: ['template0', 'template1'],
  mssql: ['master', 'model', 'msdb', 'tempdb'],
  babelfish: ['master', 'msdb', 'tempdb']
}

/** Databases the server needs, which the dialog won't rename or drop. */
export function isSystemDatabase(engine: DatabaseEngine, name: string): boolean {
  return SYSTEM[engine].includes(engine === 'postgres' ? name : name.toLowerCase())
}

/** Why a name can't be used for a new (or renamed) database, or null. */
export function databaseNameProblem(
  engine: DatabaseEngine,
  name: string,
  existing: string[]
): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Enter a database name'
  // PostgreSQL truncates identifiers to 63 bytes; SQL Server allows 128 characters
  if (engine === 'postgres' && new TextEncoder().encode(trimmed).length > 63)
    return 'PostgreSQL database names can be at most 63 bytes'
  if (engine !== 'postgres' && trimmed.length > 128)
    return 'Database names can be at most 128 characters'
  // Names compare case-sensitively in PostgreSQL and case-insensitively in SQL Server
  const same = (a: string): boolean =>
    engine === 'postgres' ? a === trimmed : a.toLowerCase() === trimmed.toLowerCase()
  if (existing.some(same)) return `There's already a database named ${trimmed}`
  return null
}

/** Statements creating the database, each run on its own (CREATE DATABASE can't be in a transaction). */
export function createDatabaseStatements(engine: DatabaseEngine, db: NewDatabase): string[] {
  const dialect = engine === 'postgres' ? 'postgres' : 'tsql'
  const name = quoteIdent(dialect, db.name.trim())
  if (engine === 'postgres') {
    const options = [
      db.owner && `OWNER = ${quoteIdent(dialect, db.owner)}`,
      db.template && `TEMPLATE = ${quoteIdent(dialect, db.template)}`,
      db.encoding && `ENCODING = ${literal(dialect, db.encoding)}`
    ].filter(Boolean)
    const out = [`CREATE DATABASE ${name}${options.length ? ` WITH ${options.join(' ')}` : ''}`]
    if (db.comment.trim())
      out.push(`COMMENT ON DATABASE ${name} IS ${literal(dialect, db.comment.trim())}`)
    return out
  }
  const collation = engine === 'mssql' && db.collation.trim()
  // Collation names are bare identifiers, e.g. Latin1_General_100_CI_AS_SC_UTF8
  if (collation && !/^\w+$/.test(collation)) throw new Error(`${collation} isn't a collation name`)
  return [`CREATE DATABASE ${name}${collation ? ` COLLATE ${collation}` : ''}`]
}

/** SQL Server: rolls back and disconnects everyone else so the database can be changed. */
const singleUser = (name: string): string =>
  `ALTER DATABASE ${name} SET SINGLE_USER WITH ROLLBACK IMMEDIATE`

/** PostgreSQL: ends the other sessions connected to the database. */
const terminateSessions = (database: string): string =>
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${literal('postgres', database)} AND pid <> pg_backend_pid()`

export function renameDatabaseStatements(
  engine: DatabaseEngine,
  from: string,
  to: string,
  /** Disconnect other sessions first; renaming fails while anyone is connected */
  force: boolean
): string[] {
  if (engine === 'postgres') {
    const rename = `ALTER DATABASE ${quoteIdent('postgres', from)} RENAME TO ${quoteIdent('postgres', to.trim())}`
    return force ? [terminateSessions(from), rename] : [rename]
  }
  const old = quoteIdent('tsql', from)
  const renamed = quoteIdent('tsql', to.trim())
  const rename = `ALTER DATABASE ${old} MODIFY NAME = ${renamed}`
  return force ? [singleUser(old), rename, `ALTER DATABASE ${renamed} SET MULTI_USER`] : [rename]
}

export function dropDatabaseStatements(
  engine: DatabaseEngine,
  name: string,
  /** Disconnect other sessions first; dropping fails while anyone is connected */
  force: boolean,
  /** PostgreSQL major version; 13 added DROP DATABASE … WITH (FORCE) */
  pgMajor: number | null = null
): string[] {
  if (engine === 'postgres') {
    const drop = `DROP DATABASE ${quoteIdent('postgres', name)}`
    if (!force) return [drop]
    return pgMajor !== null && pgMajor >= 13
      ? [`${drop} WITH (FORCE)`]
      : [terminateSessions(name), drop]
  }
  const q = quoteIdent('tsql', name)
  // Babelfish has no single-user mode
  return force && engine === 'mssql'
    ? [singleUser(q), `DROP DATABASE ${q}`]
    : [`DROP DATABASE ${q}`]
}

/** Major version from a PostgreSQL version string such as `16.2` or `PostgreSQL 13.4 on …`. */
export function pgMajorVersion(version: string): number | null {
  const match = /(\d+)(?:\.\d+)?/.exec(version)
  return match ? Number(match[1]) : null
}

/**
 * A database to run the statements in: never the one being renamed or dropped, which
 * PostgreSQL refuses (SQL Server always runs them from master).
 */
export function maintenanceDatabase(
  engine: DatabaseEngine,
  target: string | null,
  fallback: string
): string {
  if (engine !== 'postgres') return 'master'
  if (fallback && fallback !== target) return fallback
  return target === 'postgres' ? 'template1' : 'postgres'
}

/** MongoDB: why a database name is invalid, or null. */
export function mongoDatabaseProblem(name: string, existing: string[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Enter a database name'
  if (/[/\\. "$*<>:|?]/.test(trimmed))
    return 'Database names can\'t contain spaces or any of / \\ . " $ * < > : | ?'
  if (new TextEncoder().encode(trimmed).length > 63) return 'Database names can be at most 63 bytes'
  // MongoDB treats names differing only in case as the same database
  if (existing.some((e) => e.toLowerCase() === trimmed.toLowerCase()))
    return `There's already a database named ${trimmed}`
  return null
}
