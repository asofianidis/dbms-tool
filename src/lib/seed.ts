/**
 * The "Seed sample database" dataset: the same generators as scripts/seed-sql and
 * scripts/seed-mongo.js, turned into INSERT batches and insertMany batches the app
 * sends over its own connection instead of the scripts' docker bulk loaders.
 */
import { N, PgArray, configure, genReference, plan } from '../../scripts/seed-sql/data.mjs'
import {
  COLUMNS,
  TABLES,
  postDdl,
  sqliteTablesDdl,
  tablesDdl,
  type SeedDialect
} from '../../scripts/seed-sql/schema.mjs'
import mongoScript from '../../scripts/seed-mongo.js?raw'
import mongoIndexScript from '../../scripts/seed-mongo-indexes.js?raw'
import type { Cell, Ejson } from './api'
import type { Dialect } from './engines'
import { shellHelpers, toEjson } from './ejson'
import { batchLimits, documentBatches, insertBatches, type NewColumn } from './import'
import { quoteIdent, splitStatements } from './sql'

const EXTRA_SQL = import.meta.glob<string>('../../scripts/seed-sql/schema/*.extra.sql', {
  query: '?raw',
  import: 'default',
  eager: true
})

export type SeedSize = 'small' | 'medium' | 'large'

export const SEED_SIZES: Record<
  SeedSize,
  { label: string; scale: number; metricDays: number; hint: string }
> = {
  small: { label: 'Small', scale: 0.001, metricDays: 1, hint: 'About 100k rows, under a minute' },
  medium: { label: 'Medium', scale: 0.01, metricDays: 3, hint: 'About 800k rows, a few minutes' },
  large: { label: 'Large', scale: 0.1, metricDays: 17, hint: 'About 8M rows, up to an hour' }
}

export const DEFAULT_SEED_DATABASE = 'acme_prod'

/** Tables the SQL dataset creates, plus its portable views, for replacing them on SQLite. */
export const SEED_TABLES = Object.keys(TABLES)
export const SEED_VIEWS = ['v_daily_revenue', 'v_customer_ltv']

export function seedDialect(dialect: Dialect): SeedDialect {
  switch (dialect) {
    case 'postgres':
      return 'pg'
    case 'tsql':
      return 'mssql'
    default:
      return dialect
  }
}

function extraSql(d: SeedDialect): string {
  const entry = Object.entries(EXTRA_SQL).find(([path]) => path.endsWith(`/${d}.extra.sql`))
  return entry?.[1] ?? ''
}

const statements = (sql: string, dialect: Dialect): string[] =>
  splitStatements(sql, dialect).map((s) => s.text)

/** CREATE TABLE (and Postgres CREATE TYPE) statements, run before the rows. */
export function schemaStatements(dialect: Dialect): string[] {
  const d = seedDialect(dialect)
  return statements(d === 'sqlite' ? sqliteTablesDdl() : tablesDdl(d), dialect)
}

/** Keys, indexes, foreign keys, views and engine extras, run after the rows. */
export function postStatements(dialect: Dialect): string[] {
  const d = seedDialect(dialect)
  // MySQL adds the foreign keys without re-checking the (consistent) rows
  const prelude = d === 'mysql' ? 'SET foreign_key_checks = 0;\n' : ''
  return statements(prelude + postDdl(d) + '\n' + extraSql(d), dialect)
}

/** Statements that drop `database` if it exists and create it empty. */
export function recreateDatabaseSql(dialect: Dialect, database: string, exists: boolean): string[] {
  const q = quoteIdent(dialect, database)
  switch (dialect) {
    case 'postgres':
      return [
        ...(exists ? [`DROP DATABASE IF EXISTS ${q} WITH (FORCE)`] : []),
        `CREATE DATABASE ${q}`
      ]
    case 'mysql':
      return [
        ...(exists ? [`DROP DATABASE IF EXISTS ${q}`] : []),
        `CREATE DATABASE ${q} CHARACTER SET utf8mb4`
      ]
    case 'tsql':
      return [
        ...(exists
          ? [
              `IF DB_ID(N'${database.replace(/'/g, "''")}') IS NOT NULL BEGIN ALTER DATABASE ${q} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${q}; END`
            ]
          : []),
        `CREATE DATABASE ${q}`
      ]
    default:
      return []
  }
}

/** DROP statements for seed tables and views already in a SQLite database. */
export function dropSeedObjectsSql(existing: { name: string; kind: string }[]): string[] {
  const names = new Map(existing.map((o) => [o.name.toLowerCase(), o.kind]))
  const out: string[] = []
  for (const v of SEED_VIEWS)
    if (names.has(v)) out.push(`DROP VIEW IF EXISTS ${quoteIdent('sqlite', v)}`)
  for (const t of [...SEED_TABLES].reverse())
    if (names.has(t)) out.push(`DROP TABLE IF EXISTS ${quoteIdent('sqlite', t)}`)
  return out
}

export function validDatabaseName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)
}

/* ---------- SQL rows ---------- */

const NUMERIC_SPEC = /^(pk|int|bigint|smallint|money|dec|real)\b/

const timestamp = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 23)

function pgArray(items: string[]): string {
  return '{' + items.map((x) => '"' + x.replace(/["\\]/g, '\\$&') + '"').join(',') + '}'
}

/** A generated value as a cell for `literal`, matching generate.mjs's CSV encoding. */
export function seedCell(dialect: Dialect, v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  if (typeof v === 'string') return v
  if (v instanceof Date) return timestamp(v)
  if (v instanceof PgArray)
    return dialect === 'postgres' ? pgArray(v.items) : JSON.stringify(v.items)
  return JSON.stringify(v)
}

function columnsOf(table: string): NewColumn[] {
  const cols = TABLES[table].cols
  return COLUMNS[table].map((name) => ({
    name,
    dataType: NUMERIC_SPEC.test(cols[name]) ? 'numeric' : 'text'
  }))
}

export interface SeedBatch {
  table: string
  sql: string
  rows: number
  /** Share of the dataset generated so far, 0–1 */
  progress: number
}

/**
 * INSERT batches for the whole dataset, generated lazily so memory stays at one
 * batch per table. Ids are explicit, so SQL Server batches turn IDENTITY_INSERT on.
 */
export function* sqlSeedBatches(
  dialect: Dialect,
  scale: number,
  metricDays: number
): Generator<SeedBatch> {
  configure(scale, metricDays)
  const limits = batchLimits(dialect)
  const buffers = new Map<string, Cell[][]>()
  const emit = (table: string, row: Record<string, unknown>): void => {
    let rows = buffers.get(table)
    if (!rows) buffers.set(table, (rows = []))
    rows.push(COLUMNS[table].map((c) => seedCell(dialect, row[c])))
  }
  const jobs = plan()
  const total = 1 + jobs.reduce((sum, [, , count]) => sum + count, 0)
  let done = 0

  function* flush(table: string): Generator<SeedBatch> {
    const rows = buffers.get(table)
    if (!rows?.length) return
    buffers.set(table, [])
    const identity = dialect === 'tsql' && Object.values(TABLES[table].cols).includes('pk')
    const q = quoteIdent(dialect, table)
    for (const batch of insertBatches(
      dialect,
      { schema: null, name: table },
      columnsOf(table),
      rows,
      false,
      limits
    )) {
      yield {
        table,
        sql: identity
          ? `SET IDENTITY_INSERT ${q} ON;\n${batch.sql};\nSET IDENTITY_INSERT ${q} OFF;`
          : batch.sql,
        rows: batch.rows,
        progress: done / total
      }
    }
  }

  genReference(emit)
  done++
  for (const table of [...buffers.keys()]) yield* flush(table)
  for (const [, gen, count] of jobs) {
    for (let i = 0; i < count; i++) {
      gen(i, emit)
      done++
      for (const [table, rows] of buffers) if (rows.length >= limits.maxRows) yield* flush(table)
    }
    for (const table of [...buffers.keys()]) yield* flush(table)
  }
}

/* ---------- Mongo documents ---------- */

type MongoScript = (
  process: { env: Record<string, string> },
  db: unknown,
  print: (...args: unknown[]) => void,
  ObjectId: (hex?: string) => unknown
) => void

let compiled: MongoScript | null = null

/** Runs scripts/seed-mongo.js for documents [start, end) of `collection`. */
function mongoDocs(
  collection: string,
  start: number,
  end: number,
  scale: number,
  metricDays: number
): unknown[] {
  // The bundled seed script, not user input; mongosh globals are passed in as shims
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  compiled ??= new Function('process', 'db', 'print', 'ObjectId', mongoScript) as MongoScript
  const out: unknown[] = []
  const db = { getCollection: () => ({ insertMany: (docs: unknown[]) => out.push(...docs) }) }
  const env = {
    COLL: collection,
    START: String(start),
    END: String(end),
    SCALE: String(scale),
    METRIC_DAYS: String(metricDays)
  }
  compiled({ env }, db, () => {}, shellHelpers.ObjectId)
  return out
}

export interface MongoSeedBatch {
  collection: string
  documents: Ejson[]
  progress: number
}

/** Collection, entity count and entities per script run, in load order. */
function mongoPlan(): [string, number, number][] {
  return [
    ['users', N.customers, 1000],
    ['products', N.products, 1000],
    ['warehouses', 1, 1],
    ['inventory', N.products, 200],
    ['orders', N.orders, 1000],
    ['reviews', N.reviews, 1000],
    ['tickets', N.tickets, 500],
    ['events', N.events, 2000],
    ['metrics', N.hosts, 1]
  ]
}

export const MONGO_TIMESERIES = {
  create: 'metrics',
  timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'minutes' }
}

/** insertMany batches for the whole Mongo dataset, generated lazily. */
export function* mongoSeedBatches(scale: number, metricDays: number): Generator<MongoSeedBatch> {
  // The SQL generator's base counts match the Mongo script's, so its scaled N serves both
  configure(scale, metricDays)
  const jobs = mongoPlan()
  // Metric hosts each produce a day's worth of documents per metric day
  const weight = (coll: string): number => (coll === 'metrics' ? 1440 * metricDays : 1)
  const total = jobs.reduce((sum, [coll, count]) => sum + count * weight(coll), 0)
  let done = 0
  for (const [collection, count, chunk] of jobs) {
    for (let start = 0; start < count; start += chunk) {
      const end = Math.min(count, start + chunk)
      const docs = mongoDocs(collection, start, end, scale, metricDays).map(toEjson)
      done += (end - start) * weight(collection)
      for (const documents of documentBatches(docs))
        yield { collection, documents, progress: done / total }
    }
  }
}

export interface MongoIndex {
  collection: string
  keys: Ejson
  options?: Ejson
}

/** The createIndex calls in scripts/seed-mongo-indexes.js. */
export function mongoSeedIndexes(): MongoIndex[] {
  const out: MongoIndex[] = []
  const add = (collection: string, keys: unknown, options?: unknown): void => {
    out.push({ collection, keys: toEjson(keys), ...(options ? { options: toEjson(options) } : {}) })
  }
  const db = new Proxy(
    {},
    {
      get: (_, name) => ({
        createIndex: (keys: unknown, options?: unknown) => add(String(name), keys, options),
        createIndexes: (list: unknown[], options?: unknown) =>
          list.forEach((keys) => add(String(name), keys, options))
      })
    }
  )
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('db', mongoIndexScript)(db)
  return out
}
