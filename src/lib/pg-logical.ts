/**
 * PostgreSQL logical replication objects for the explorer: publications (pg_publication) and
 * subscriptions (pg_subscription) of a database, their details, and the SQL to script, enable,
 * disable and refresh them. Read on the metadata session with catalog SQL.
 */
import type { Cell, ResultSet } from './api'
import { catalogRows, type CatalogQuery } from './catalog'
import { literal, quoteIdent } from './sql'

const text = (cell: Cell | undefined): string | null =>
  typeof cell === 'string' && cell !== '' ? cell : null

const flag = (cell: Cell | undefined): boolean =>
  typeof cell === 'boolean' ? cell : typeof cell === 'string' && /^(t|true|1|on)$/i.test(cell)

const count = (cell: Cell | undefined): number | null => {
  const n = Number(text(cell) ?? NaN)
  return Number.isFinite(n) ? n : null
}

const q = (name: string): string => quoteIdent('postgres', name)
const lit = (value: string): string => literal('postgres', value)

/* ---------- Publications ---------- */

export type PublishedOperation = 'insert' | 'update' | 'delete' | 'truncate'

export interface Publication {
  name: string
  owner: string | null
  allTables: boolean
  operations: PublishedOperation[]
  /** publish_via_partition_root */
  viaRoot: boolean
  /** Tables the publication covers, explicit or through ALL TABLES / TABLES IN SCHEMA */
  tableCount: number | null
  comment: string | null
}

// Columns: name, owner, all tables, insert, update, delete, truncate, via root, tables, comment
export const PUBLICATIONS_SQL = `SELECT p.pubname::text, pg_get_userbyid(p.pubowner)::text, p.puballtables,
  p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate, p.pubviaroot,
  (SELECT count(*) FROM pg_publication_tables t WHERE t.pubname = p.pubname),
  obj_description(p.oid, 'pg_publication')
FROM pg_publication p
ORDER BY 1`

export function parsePublications(rows: Cell[][]): Publication[] {
  return rows.map((r) => ({
    name: text(r[0]) ?? '',
    owner: text(r[1]),
    allTables: flag(r[2]),
    operations: (['insert', 'update', 'delete', 'truncate'] as const).filter((_, i) =>
      flag(r[3 + i])
    ),
    viaRoot: flag(r[7]),
    tableCount: count(r[8]),
    comment: text(r[9])
  }))
}

/** A table the publication covers, with its column list and row filter (PG 15+). */
export interface PublishedTable {
  schema: string
  table: string
  /** Null when every column is published */
  columns: string[] | null
  rowFilter: string | null
}

/** A table named in CREATE / ALTER PUBLICATION, as opposed to one covered by a schema. */
export interface PublicationMember {
  schema: string
  table: string
  /** Quoted column list, PG 15+ */
  columns: string | null
  rowFilter: string | null
}

export interface PublicationDetails {
  publication: Publication
  tables: PublishedTable[]
  members: PublicationMember[]
  /** TABLES IN SCHEMA (PG 15+) */
  schemas: string[]
}

/**
 * Three result sets: every table the publication covers, the tables it names explicitly, and
 * the schemas it covers. Column lists, row filters and schemas are PG 15+.
 */
export function publicationDetailsSql(name: string, version: number): string {
  const v15 = version >= 150000
  const pub = `(SELECT oid FROM pg_publication WHERE pubname = ${lit(name)})`
  const rel = `(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))::regclass`
  const tables = v15
    ? `SELECT t.schemaname::text, t.tablename::text,
  CASE WHEN r.prattrs IS NOT NULL THEN array_to_string(t.attnames, ', ') END, t.rowfilter
FROM pg_publication_tables t
LEFT JOIN pg_publication_rel r ON r.prpubid = ${pub} AND r.prrelid = ${rel}
WHERE t.pubname = ${lit(name)}
ORDER BY 1, 2`
    : `SELECT t.schemaname::text, t.tablename::text, NULL::text, NULL::text
FROM pg_publication_tables t
WHERE t.pubname = ${lit(name)}
ORDER BY 1, 2`
  const members = `SELECT n.nspname::text, c.relname::text, ${
    v15
      ? `(SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) FROM pg_attribute a
     WHERE a.attrelid = r.prrelid AND a.attnum = ANY (r.prattrs::int2[])),
  pg_get_expr(r.prqual, r.prrelid)`
      : 'NULL::text, NULL::text'
  }
FROM pg_publication_rel r
JOIN pg_class c ON c.oid = r.prrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE r.prpubid = ${pub}
ORDER BY 1, 2`
  const schemas = v15
    ? `SELECT n.nspname::text FROM pg_publication_namespace pn
JOIN pg_namespace n ON n.oid = pn.pnnspid
WHERE pn.pnpubid = ${pub}
ORDER BY 1`
    : 'SELECT NULL::text WHERE false'
  return [tables, members, schemas].join(';\n')
}

export function parsePublicationDetails(
  publication: Publication,
  sets: ResultSet[]
): PublicationDetails {
  const [tables, members, schemas] = sets
  return {
    publication,
    tables: (tables?.rows ?? []).map((r) => ({
      schema: text(r[0]) ?? '',
      table: text(r[1]) ?? '',
      columns: text(r[2])?.split(', ') ?? null,
      rowFilter: text(r[3])
    })),
    members: (members?.rows ?? []).map((r) => ({
      schema: text(r[0]) ?? '',
      table: text(r[1]) ?? '',
      columns: text(r[2]),
      rowFilter: text(r[3])
    })),
    schemas: (schemas?.rows ?? []).map((r) => text(r[0]) ?? '').filter(Boolean)
  }
}

const ALL_OPERATIONS: PublishedOperation[] = ['insert', 'update', 'delete', 'truncate']

function publicationOptions(p: Publication): string {
  const options = [`publish = ${lit(p.operations.join(', '))}`]
  if (p.viaRoot) options.push('publish_via_partition_root = true')
  return ` WITH (${options.join(', ')})`
}

/** CREATE PUBLICATION from its details: the tables and schemas it names, not every table it covers. */
export function createPublicationSql(d: PublicationDetails): string {
  const p = d.publication
  const table = (m: PublicationMember): string =>
    `${q(m.schema)}.${q(m.table)}${m.columns ? ` (${m.columns})` : ''}${
      // Always wrapped: WHERE needs parentheses and extra ones are harmless
      m.rowFilter ? ` WHERE (${m.rowFilter})` : ''
    }`
  const targets = [
    ...(d.members.length ? [`TABLE ${d.members.map(table).join(', ')}`] : []),
    ...(d.schemas.length ? [`TABLES IN SCHEMA ${d.schemas.map(q).join(', ')}`] : [])
  ]
  const target = p.allTables
    ? ' FOR ALL TABLES'
    : targets.length
      ? ` FOR ${targets.join(', ')}`
      : ''
  const lines = [`CREATE PUBLICATION ${q(p.name)}${target}${publicationOptions(p)};`]
  if (p.comment) lines.push(`COMMENT ON PUBLICATION ${q(p.name)} IS ${lit(p.comment)};`)
  return lines.join('\n')
}

export const dropPublicationSql = (name: string): string => `DROP PUBLICATION ${q(name)};`

/** "insert, update, delete, truncate" → "all operations" when nothing's left out. */
export const operationsLabel = (ops: PublishedOperation[]): string =>
  ops.length === ALL_OPERATIONS.length ? 'all operations' : ops.join(', ') || 'no operations'

/* ---------- Subscriptions ---------- */

export interface Subscription {
  name: string
  owner: string | null
  enabled: boolean
  publications: string[]
  /** With any password replaced by ********; null when the role can't read subconninfo */
  conninfo: string | null
  slotName: string | null
  synchronousCommit: string | null
  comment: string | null
}

const subscriptionsSql = (conninfo: string): string =>
  `SELECT s.subname::text, pg_get_userbyid(s.subowner)::text, s.subenabled,
  array_to_string(s.subpublications, ','), ${conninfo}, s.subslotname::text, s.subsynccommit,
  obj_description(s.oid, 'pg_subscription')
FROM pg_subscription s
WHERE s.subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY 1`

/**
 * Subscriptions of the current database (pg_subscription is cluster-wide). SELECT on
 * subconninfo is revoked from PUBLIC, so the second query leaves it out for everyone else.
 */
export const SUBSCRIPTIONS_SQL = [
  subscriptionsSql('s.subconninfo'),
  subscriptionsSql('NULL::text')
] as const

export function parseSubscriptions(rows: Cell[][]): Subscription[] {
  return rows.map((r) => {
    const conninfo = text(r[4])
    return {
      name: text(r[0]) ?? '',
      owner: text(r[1]),
      enabled: flag(r[2]),
      publications: (text(r[3]) ?? '').split(',').filter(Boolean),
      conninfo: conninfo == null ? null : maskConninfo(conninfo),
      slotName: text(r[5]),
      synchronousCommit: text(r[6]),
      comment: text(r[7])
    }
  })
}

export const MASK = '********'

/**
 * A libpq connection string with its password hidden: password=… in keyword/value form
 * (quoted or not) and user:password@ in a postgres:// URI, also a password query parameter.
 */
export function maskConninfo(conninfo: string): string {
  return (
    conninfo
      // keyword = 'quoted \' value' or bare value, outside a URI's query string
      .replace(/(?<![?&])(\bpassword\s*=\s*)('(?:[^'\\]|\\.)*'|[^\s']+)/gi, `$1${MASK}`)
      // postgres://user:secret@host
      .replace(/(\bpostgres(?:ql)?:\/\/[^:/?#@\s]*:)[^@/?#\s]*@/gi, `$1${MASK}@`)
      // ?password=secret in a URI
      .replace(/([?&]password=)[^&\s]*/gi, `$1${MASK}`)
  )
}

/**
 * CREATE SUBSCRIPTION for a subscription. The password was masked when it was read, so the
 * script says so; it creates the subscription disabled when the original is.
 */
export function createSubscriptionSql(s: Subscription): string {
  const options: string[] = []
  if (s.slotName && s.slotName !== s.name) options.push(`slot_name = ${lit(s.slotName)}`)
  else if (!s.slotName) options.push('slot_name = NONE', 'create_slot = false')
  if (!s.enabled) options.push('enabled = false')
  if (s.synchronousCommit && s.synchronousCommit !== 'off')
    options.push(`synchronous_commit = ${lit(s.synchronousCommit)}`)
  const conninfo = s.conninfo ?? 'host=… dbname=… user=… password=…'
  const lines = [
    ...(s.conninfo == null
      ? ['-- The connection string is readable only by superusers; fill it in']
      : s.conninfo.includes(MASK)
        ? [`-- The password is masked; replace ${MASK} before running`]
        : []),
    `CREATE SUBSCRIPTION ${q(s.name)}`,
    `  CONNECTION ${lit(conninfo)}`,
    `  PUBLICATION ${s.publications.map(q).join(', ') || '…'}${options.length ? `\n  WITH (${options.join(', ')})` : ''};`
  ]
  if (s.comment) lines.push(`COMMENT ON SUBSCRIPTION ${q(s.name)} IS ${lit(s.comment)};`)
  return lines.join('\n')
}

export const dropSubscriptionSql = (name: string): string =>
  `-- Also drops the replication slot on the publisher, which must be reachable.
-- If it isn't: ALTER SUBSCRIPTION ${q(name)} DISABLE; ALTER SUBSCRIPTION ${q(name)} SET (slot_name = NONE);
DROP SUBSCRIPTION ${q(name)};`

export const setSubscriptionEnabledSql = (name: string, enabled: boolean): string =>
  `ALTER SUBSCRIPTION ${q(name)} ${enabled ? 'ENABLE' : 'DISABLE'}`

/** Picks up tables added to the subscribed publications; can't run inside a transaction. */
export const refreshSubscriptionSql = (name: string): string =>
  `ALTER SUBSCRIPTION ${q(name)} REFRESH PUBLICATION`

/** One worker of a subscription: the apply worker, or a table synchronization worker. */
export interface SubscriptionWorker {
  /** apply, table synchronization, parallel apply */
  type: string
  pid: string | null
  table: string | null
  receivedLsn: string | null
  latestEndLsn: string | null
  /** Seconds since the last message from the publisher */
  lastMessage: number | null
  /** Seconds the last message took to arrive (receipt - send time) */
  transit: number | null
}

/** A subscribed table and its synchronization state. */
export interface SubscriptionTable {
  table: string
  /** i initialize, d data copy, f finished copy, s synchronized, r ready */
  state: string
  lsn: string | null
}

export interface SubscriptionDetails {
  workers: SubscriptionWorker[]
  tables: SubscriptionTable[]
  /** pg_stat_subscription_stats (PG 15+) */
  applyErrors: number | null
  syncErrors: number | null
}

/**
 * Three result sets: pg_stat_subscription workers (worker_type is PG 17+; before that a worker
 * with a relid is a table sync), pg_subscription_rel states, and PG 15+ error counts.
 */
export function subscriptionDetailsSql(name: string, version: number): string {
  const sub = `(SELECT oid FROM pg_subscription WHERE subname = ${lit(name)}
    AND subdbid = (SELECT oid FROM pg_database WHERE datname = current_database()))`
  const workers = `SELECT ${
    version >= 170000
      ? 'w.worker_type'
      : `CASE WHEN w.relid IS NULL THEN 'apply' ELSE 'table synchronization' END`
  }, w.pid, w.relid::regclass::text, w.received_lsn::text, w.latest_end_lsn::text,
  extract(epoch FROM now() - w.last_msg_receipt_time)::float8,
  extract(epoch FROM w.last_msg_receipt_time - w.last_msg_send_time)::float8
FROM pg_stat_subscription w
WHERE w.subid = ${sub}
ORDER BY w.relid NULLS FIRST, w.pid`
  const tables = `SELECT r.srrelid::regclass::text, r.srsubstate::text, r.srsublsn::text
FROM pg_subscription_rel r
WHERE r.srsubid = ${sub}
ORDER BY 1`
  const stats =
    version >= 150000
      ? `SELECT apply_error_count, sync_error_count FROM pg_stat_subscription_stats WHERE subid = ${sub}`
      : 'SELECT NULL::bigint, NULL::bigint'
  return [workers, tables, stats].join(';\n')
}

export function parseSubscriptionDetails(sets: ResultSet[]): SubscriptionDetails {
  const [workers, tables, stats] = sets
  return {
    workers: (workers?.rows ?? []).map((r) => ({
      type: text(r[0]) ?? 'apply',
      pid: text(r[1]),
      table: text(r[2]),
      receivedLsn: text(r[3]),
      latestEndLsn: text(r[4]),
      lastMessage: count(r[5]),
      transit: count(r[6])
    })),
    tables: (tables?.rows ?? []).map((r) => ({
      table: text(r[0]) ?? '',
      state: text(r[1]) ?? '',
      lsn: text(r[2])
    })),
    applyErrors: count(stats?.rows[0]?.[0]),
    syncErrors: count(stats?.rows[0]?.[1])
  }
}

export const TABLE_SYNC_STATES: Record<string, string> = {
  i: 'initializing',
  d: 'copying data',
  f: 'copy finished',
  s: 'synchronized',
  r: 'ready'
}

/* ---------- Queries ---------- */

/** Explorer queries; keyed under the connection's catalog so a refresh reloads them. */
export const logicalQueries = {
  publications: (id: string, database: string): CatalogQuery<Publication> => ({
    queryKey: ['conn', id, 'catalog', database, 'publications'],
    queryFn: async () => parsePublications(await catalogRows(id, database, [PUBLICATIONS_SQL]))
  }),
  subscriptions: (id: string, database: string): CatalogQuery<Subscription> => ({
    queryKey: ['conn', id, 'catalog', database, 'subscriptions'],
    queryFn: async () => parseSubscriptions(await catalogRows(id, database, [...SUBSCRIPTIONS_SQL]))
  })
}
