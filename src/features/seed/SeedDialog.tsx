import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Sprout, TriangleAlert } from 'lucide-react'
import { api } from '@/lib/api'
import { ENGINES, connectionLabel } from '@/lib/engines'
import { formatDuration } from '@/lib/format'
import { queries } from '@/lib/queries'
import {
  DEFAULT_SEED_DATABASE,
  MONGO_TIMESERIES,
  SEED_SIZES,
  SEED_TABLES,
  SEED_VIEWS,
  dropSeedObjectsSql,
  mongoSeedBatches,
  mongoSeedIndexes,
  postStatements,
  recreateDatabaseSql,
  schemaStatements,
  sqlSeedBatches,
  validDatabaseName,
  type SeedSize
} from '@/lib/seed'
import { createStore } from '@/lib/store'
import { toast, errorMessage } from '@/lib/toast'
import { connect, connectionsStore, refreshConnection } from '@/lib/workspace'
import { Button, ErrorText, Field, Input, Modal, Segmented } from '@/components/ui'

const seedStore = createStore<string | null>(null)

/** Opens the "Seed sample database" dialog for a connection. */
export function openSeed(connectionId: string): void {
  seedStore.set(connectionId)
}

export function SeedHost(): React.JSX.Element | null {
  const connectionId = seedStore.use()
  if (!connectionId) return null
  return <SeedDialog key={connectionId} connectionId={connectionId} />
}

class Cancelled extends Error {}

interface Job {
  state: 'running' | 'done' | 'failed' | 'cancelled'
  phase: string
  progress: number
  rows: number
  startedAt: number
  elapsedMs: number
  warnings: string[]
  error?: string
}

function SeedDialog({ connectionId }: { connectionId: string }): React.JSX.Element | null {
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const engine = connection?.engine
  const isMongo = engine === 'mongo'
  const isSqlite = engine === 'sqlite'
  const dialect = engine ? ENGINES[engine].dialect : null
  const [name, setName] = useState(DEFAULT_SEED_DATABASE)
  const [size, setSize] = useState<SeedSize>('small')
  const [job, setJob] = useState<Job | null>(null)
  const cancelled = useRef(false)
  const sessions = useRef<string[]>([])
  const running = job?.state === 'running'

  const databases = useQuery(queries.databases(connectionId))
  // SQLite has one database; the seed goes into it beside whatever is there
  const sqliteDb = databases.data?.[0]?.name ?? 'main'
  const objects = useQuery({
    ...queries.objects(connectionId, sqliteDb, null),
    enabled: isSqlite && databases.isSuccess
  })
  const target = isSqlite ? sqliteDb : name.trim()
  const exists = isSqlite
    ? (objects.data ?? []).some((o) =>
        [...SEED_TABLES, ...SEED_VIEWS].includes(o.name.toLowerCase())
      )
    : (databases.data ?? []).some((d) => d.name.toLowerCase() === target.toLowerCase())

  const close = (): void => {
    if (!running) seedStore.set(null)
  }
  if (!connection) return null

  const problem = isSqlite || validDatabaseName(target) ? null : 'Use letters, digits and _'

  const update = (patch: Partial<Job>): void =>
    setJob((j) => (j ? { ...j, ...patch, elapsedMs: Date.now() - j.startedAt } : j))

  const exec = async (session: string, database: string, sql: string): Promise<void> => {
    if (cancelled.current) throw new Cancelled()
    const out = await api.execute(connectionId, session, database, sql, { maxRows: 1 })
    if (out.cancelled || cancelled.current) throw new Cancelled()
    if (out.error) throw new Error(out.error.message)
  }

  const runSql = async (key: string, warnings: string[]): Promise<number> => {
    if (!dialect) return 0
    const { scale, metricDays } = SEED_SIZES[size]
    if (isSqlite) {
      update({ phase: 'Dropping the previous sample tables' })
      for (const s of dropSeedObjectsSql(objects.data ?? [])) await exec(key, target, s)
    } else {
      update({ phase: exists ? `Recreating ${target}` : `Creating ${target}` })
      const admin = `${key}:admin`
      sessions.current.push(admin)
      for (const s of recreateDatabaseSql(dialect, target, exists)) {
        try {
          await exec(admin, '', s)
        } catch (e) {
          // DROP DATABASE … WITH (FORCE) needs PostgreSQL 13
          if (!/WITH \(FORCE\)/.test(s) || e instanceof Cancelled) throw e
          await exec(admin, '', s.replace(' WITH (FORCE)', ''))
        }
      }
      refreshConnection(connectionId)
    }
    update({ phase: 'Creating tables' })
    for (const s of schemaStatements(dialect)) await exec(key, target, s)
    let rows = 0
    for (const batch of sqlSeedBatches(dialect, scale, metricDays)) {
      await exec(key, target, batch.sql)
      rows += batch.rows
      update({ phase: `Inserting into ${batch.table}`, progress: batch.progress, rows })
    }
    update({ phase: 'Building keys, indexes, foreign keys and views', progress: 1 })
    for (const s of postStatements(dialect)) {
      try {
        await exec(key, target, s)
      } catch (e) {
        if (e instanceof Cancelled) throw e
        warnings.push(`${s.split('\n')[0].slice(0, 120)}: ${errorMessage(e)}`)
      }
    }
    return rows
  }

  const runMongo = async (key: string, warnings: string[]): Promise<number> => {
    const { scale, metricDays } = SEED_SIZES[size]
    const mongo = async (request: Parameters<typeof api.mongo>[2]): Promise<void> => {
      if (cancelled.current) throw new Cancelled()
      const out = await api.mongo(connectionId, key, request)
      if (out.cancelled || cancelled.current) throw new Cancelled()
    }
    update({ phase: exists ? `Recreating ${target}` : `Creating ${target}` })
    if (exists) await mongo({ op: 'dropDatabase', database: target })
    try {
      await mongo({ op: 'runCommand', database: target, command: MONGO_TIMESERIES })
    } catch (e) {
      if (e instanceof Cancelled) throw e
      // Time series collections need MongoDB 5.0; metrics then lands in a plain collection
      warnings.push(`metrics is a regular collection: ${errorMessage(e)}`)
    }
    let rows = 0
    for (const batch of mongoSeedBatches(scale, metricDays)) {
      await mongo({
        op: 'insertMany',
        database: target,
        collection: batch.collection,
        documents: batch.documents
      })
      rows += batch.documents.length
      update({ phase: `Inserting into ${batch.collection}`, progress: batch.progress, rows })
    }
    update({ phase: 'Building indexes', progress: 1 })
    for (const ix of mongoSeedIndexes()) {
      try {
        await mongo({ op: 'createIndex', database: target, ...ix })
      } catch (e) {
        if (e instanceof Cancelled) throw e
        warnings.push(`${ix.collection} ${JSON.stringify(ix.keys)}: ${errorMessage(e)}`)
      }
    }
    return rows
  }

  const start = async (): Promise<void> => {
    if (running || problem || !target) return
    if (!(await connect(connectionId))) return
    const key = `seed:${crypto.randomUUID()}`
    sessions.current = [key]
    cancelled.current = false
    const warnings: string[] = []
    setJob({
      state: 'running',
      phase: 'Starting',
      progress: 0,
      rows: 0,
      startedAt: Date.now(),
      elapsedMs: 0,
      warnings
    })
    try {
      const rows = isMongo ? await runMongo(key, warnings) : await runSql(key, warnings)
      update({ state: 'done', phase: 'Done', warnings: [...warnings] })
      toast(
        `Seeded ${target} with ${rows.toLocaleString()} ${isMongo ? 'documents' : 'rows'}`,
        warnings.length ? 'error' : 'success'
      )
    } catch (e) {
      const wasCancelled = e instanceof Cancelled || cancelled.current
      update({
        state: wasCancelled ? 'cancelled' : 'failed',
        warnings: [...warnings],
        error: wasCancelled ? undefined : errorMessage(e)
      })
    } finally {
      if (!isMongo)
        for (const s of sessions.current) void api.closeSession(connectionId, s).catch(() => {})
      sessions.current = []
      refreshConnection(connectionId)
    }
  }

  const cancel = (): void => {
    cancelled.current = true
    for (const s of sessions.current) void api.cancel(connectionId, s).catch(() => {})
  }

  const noun = isMongo ? 'documents' : 'rows'
  const finished = job && job.state !== 'running'

  return (
    <Modal
      width="md"
      icon={<Sprout />}
      title="Seed sample database"
      description={connectionLabel(connection)}
      onClose={close}
      footer={
        running ? (
          <Button variant="secondary" onClick={cancel}>
            Cancel
          </Button>
        ) : finished ? (
          <Button variant="primary" onClick={close}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant={exists ? 'danger' : 'primary'}
              disabled={!!problem || !target}
              onClick={() => void start()}
            >
              {exists ? (isSqlite ? 'Replace sample tables' : `Replace ${target}`) : 'Seed'}
            </Button>
          </>
        )
      }
    >
      {job ? (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between text-[12.5px]">
            <span className="text-fg">{job.phase}</span>
            <span className="text-muted tabular-nums">
              {job.rows.toLocaleString()} {noun} · {formatDuration(job.elapsedMs)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-accent/15">
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${Math.round(job.progress * 100)}%` }}
            />
          </div>
          {job.state === 'cancelled' && (
            <p className="text-xs text-muted">
              Cancelled. {target} holds a partial dataset; seed again to replace it.
            </p>
          )}
          {job.error && <ErrorText error={job.error} />}
          {job.warnings.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-muted">
                {job.warnings.length} statement{job.warnings.length === 1 ? '' : 's'} failed
              </p>
              <ul className="max-h-40 space-y-1 overflow-y-auto text-[11.5px] text-danger select-text">
                {job.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[12.5px] leading-relaxed text-muted">
            Fills a database with a realistic e-commerce dataset: customers, products, orders,
            reviews, clickstream events, support tickets, inventory and per-minute host metrics. The
            data is skewed and seasonal, and reruns produce the same rows. It's the same dataset
            scripts/{isMongo ? 'seed-mongo.sh' : 'seed-sql'} loads at full size.
          </p>
          {!isSqlite && (
            <Field label="Database" hint={problem ?? undefined}>
              <Input
                mono
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void start()}
              />
            </Field>
          )}
          <Field label="Size" hint={SEED_SIZES[size].hint}>
            <div>
              <Segmented
                value={size}
                onChange={setSize}
                options={(Object.keys(SEED_SIZES) as SeedSize[]).map((s) => ({
                  value: s,
                  label: SEED_SIZES[s].label
                }))}
              />
            </div>
          </Field>
          {exists && (
            <p className="flex gap-2 text-[12px] text-warn">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {isSqlite
                ? `${sqliteDb} already has sample tables; they're dropped and recreated. Other tables are left alone.`
                : `${target} already exists. It's dropped and recreated, and everything in it is lost.`}
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
