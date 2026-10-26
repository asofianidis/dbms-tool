import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Boxes, Network, Pause, Play, Plus, RefreshCw, Split } from 'lucide-react'
import { api, type ConnectionConfig } from '@/lib/api'
import { cn } from '@/lib/cn'
import { parseShellValue, scalarText, toShell } from '@/lib/ejson'
import { formatDuration } from '@/lib/format'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { confirm } from '@/lib/workspace'
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Modal,
  Spinner,
  Toggle
} from '@/components/ui'

type Doc = Record<string, unknown>

interface Member {
  name: string
  state: string
  /** null when unknown: only `hello` could be read */
  health: boolean | null
  self: boolean
  uptimeSecs: number | null
  optime: number | null
  pingMs: number | null
  syncSource: string
}

interface ShardedCollection {
  ns: string
  key: unknown
  unique: boolean
  chunks: Record<string, number>
}

interface Cluster {
  kind: 'standalone' | 'replicaSet' | 'sharded'
  setName?: string
  members: Member[]
  /** Set when replSetGetStatus is denied and only `hello` could be read */
  membersNote?: string
  shards: { id: string; host: string; state: number; draining: boolean; tags: string[] }[]
  balancer?: { mode: string; inRound: boolean }
  collections: ShardedCollection[]
  databases: { name: string; primary: string }[]
  shardingNote?: string
}

const SHARD_COLORS = [
  'bg-accent',
  'bg-info',
  'bg-ok',
  'bg-warn',
  'bg-mongo',
  'bg-syn-string',
  'bg-syn-fn',
  'bg-syn-number'
]

const num = (v: unknown): number | null => {
  if (v === undefined || v === null) return null
  const n = Number(scalarText(v))
  return Number.isFinite(n) ? n : null
}

const time = (v: unknown): number | null => {
  if (v === undefined || v === null) return null
  const t = new Date(scalarText(v)).getTime()
  return Number.isFinite(t) ? t : null
}

async function command(connectionId: string, cmd: Doc, database = 'admin'): Promise<Doc> {
  const out = await api.mongo(connectionId, '__meta', {
    op: 'runCommand',
    database,
    command: cmd
  })
  return (out.value ?? {}) as Doc
}

async function find(connectionId: string, collection: string, filter: Doc = {}): Promise<Doc[]> {
  const out = await api.mongo(
    connectionId,
    '__meta',
    { op: 'find', database: 'config', collection, filter, limit: 5000 },
    { maxRows: 5000 }
  )
  return out.documents as Doc[]
}

/**
 * Replica set members as `hello` lists them, for when replSetGetStatus is denied. Only the
 * connected member's own state is known; the rest are as the connected member last saw
 * them (the primary) or unknown, and nobody's health is known but the connected member's.
 */
export function helloMembers(hello: Doc): Member[] {
  const selfState =
    hello.isWritablePrimary === true || hello.ismaster === true
      ? 'PRIMARY'
      : hello.secondary === true
        ? 'SECONDARY'
        : hello.arbiterOnly === true
          ? 'ARBITER'
          : 'UNKNOWN'
  const member = (name: string, state: string): Member => {
    const self = name === hello.me
    return {
      name,
      state: self ? selfState : state,
      health: self ? true : null,
      self,
      uptimeSecs: null,
      optime: null,
      pingMs: null,
      syncSource: ''
    }
  }
  return [
    ...[...((hello.hosts ?? []) as string[]), ...((hello.passives ?? []) as string[])].map((name) =>
      member(name, name === hello.primary ? 'PRIMARY' : 'UNKNOWN')
    ),
    ...((hello.arbiters ?? []) as string[]).map((name) => member(name, 'ARBITER'))
  ]
}

async function loadCluster(connectionId: string): Promise<Cluster> {
  const hello = await command(connectionId, { hello: 1 })
  const cluster: Cluster = {
    kind: hello.msg === 'isdbgrid' ? 'sharded' : hello.setName ? 'replicaSet' : 'standalone',
    setName: typeof hello.setName === 'string' ? hello.setName : undefined,
    members: [],
    shards: [],
    collections: [],
    databases: []
  }

  if (cluster.kind === 'replicaSet') {
    try {
      const status = await command(connectionId, { replSetGetStatus: 1 })
      cluster.members = ((status.members ?? []) as Doc[]).map((m) => ({
        name: String(m.name),
        state: String(m.stateStr ?? m.state),
        health: num(m.health) === 1,
        self: m.self === true,
        uptimeSecs: num(m.uptime),
        optime: time(m.optimeDate),
        pingMs: num(m.pingMs),
        syncSource: String(m.syncSourceHost ?? '')
      }))
    } catch (e) {
      // Without clusterMonitor, hello still names the members
      cluster.membersNote = errorMessage(e)
      cluster.members = helloMembers(hello)
    }
  }

  if (cluster.kind === 'sharded') {
    try {
      const shards = await command(connectionId, { listShards: 1 })
      cluster.shards = ((shards.shards ?? []) as Doc[]).map((s) => ({
        id: String(s._id),
        host: String(s.host ?? ''),
        state: num(s.state) ?? 1,
        draining: s.draining === true,
        tags: Array.isArray(s.tags) ? s.tags.map(String) : []
      }))
      const balancer = await command(connectionId, { balancerStatus: 1 }).catch(() => null)
      if (balancer)
        cluster.balancer = {
          mode: String(balancer.mode ?? 'unknown'),
          inRound: balancer.inBalancerRound === true
        }
      const [collections, chunkCounts, databases] = await Promise.all([
        find(connectionId, 'collections', { dropped: { $ne: true } }),
        api
          .mongo(
            connectionId,
            '__meta',
            {
              op: 'aggregate',
              database: 'config',
              collection: 'chunks',
              pipeline: [
                // 5.0+ chunks name their collection by uuid, older ones by ns
                {
                  $group: {
                    _id: { coll: { $ifNull: ['$uuid', '$ns'] }, shard: '$shard' },
                    n: { $sum: 1 }
                  }
                }
              ]
            },
            { maxRows: 100000 }
          )
          .then((out) => out.documents as Doc[]),
        find(connectionId, 'databases')
      ])
      const byColl = new Map<string, Record<string, number>>()
      for (const row of chunkCounts) {
        const id = row._id as Doc
        const key = JSON.stringify(id.coll)
        const counts = byColl.get(key) ?? {}
        counts[String(id.shard)] = num(row.n) ?? 0
        byColl.set(key, counts)
      }
      cluster.collections = collections
        .filter((c) => String(c._id) !== 'config.system.sessions')
        .map((c) => ({
          ns: String(c._id),
          key: c.key,
          unique: c.unique === true,
          chunks: byColl.get(JSON.stringify(c.uuid)) ?? byColl.get(JSON.stringify(c._id)) ?? {}
        }))
        .sort((a, b) => a.ns.localeCompare(b.ns))
      cluster.databases = databases
        .map((d) => ({ name: String(d._id), primary: String(d.primary ?? '') }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (e) {
      cluster.shardingNote = errorMessage(e)
    }
  }
  return cluster
}

function uptime(secs: number): string {
  const d = Math.floor(secs / 86_400)
  const h = Math.floor((secs % 86_400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

function stateTone(state: string): 'success' | 'info' | 'neutral' | 'warning' | 'danger' {
  switch (state) {
    case 'PRIMARY':
      return 'success'
    case 'SECONDARY':
      return 'info'
    case 'ARBITER':
      return 'neutral'
    case 'STARTUP':
    case 'STARTUP2':
    case 'RECOVERING':
    case 'ROLLBACK':
      return 'warning'
    default:
      return 'danger'
  }
}

function SectionTitle({
  icon,
  children,
  extra
}: {
  icon: React.ReactNode
  children: React.ReactNode
  extra?: React.ReactNode
}): React.JSX.Element {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
      {icon} {children}
      {extra}
    </h2>
  )
}

const th = 'px-3 py-1.5 text-left text-[11px] font-medium text-muted'
const td = 'px-3 py-1.5 align-middle'

/** Replica set members, shards, the balancer and how sharded collections are spread. */
export function ClusterPanel({ connection }: { connection: ConnectionConfig }): React.JSX.Element {
  const client = useQueryClient()
  const queryKey = ['conn', connection.id, 'cluster']
  const cluster = useQuery({ queryKey, queryFn: () => loadCluster(connection.id) })
  const [sharding, setSharding] = useState(false)
  const reload = (): void => void client.invalidateQueries({ queryKey })

  if (cluster.isPending)
    return (
      <section className="flex items-center gap-2 text-xs text-muted">
        <Spinner className="size-3.5" /> Reading cluster topology…
      </section>
    )
  if (cluster.error)
    return (
      <section>
        <ErrorText error={cluster.error} />
      </section>
    )
  const c = cluster.data
  if (c.kind === 'standalone')
    return (
      <section className="rounded-lg border border-line bg-panel/70 px-4 py-3 text-xs text-muted">
        <Network className="mr-1.5 inline size-3.5" />
        Standalone server: not part of a replica set or sharded cluster.
      </section>
    )

  const refresh = (
    <Button size="icon-sm" variant="ghost" onClick={reload} title="Refresh">
      <RefreshCw className={cluster.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
    </Button>
  )

  const toggleBalancer = async (): Promise<void> => {
    const stopping = c.balancer?.mode !== 'off'
    const ok = await confirm({
      title: stopping ? 'Stop the balancer?' : 'Start the balancer?',
      message: stopping
        ? 'Chunks stop moving between shards until it is started again. A migration in progress finishes first.'
        : 'The balancer starts moving chunks to even out the shards.',
      confirmLabel: stopping ? 'Stop balancer' : 'Start balancer',
      danger: stopping
    })
    if (!ok) return
    try {
      await command(connection.id, stopping ? { balancerStop: 1 } : { balancerStart: 1 })
      toast(stopping ? 'Balancer stopped' : 'Balancer started')
    } catch (e) {
      toastError(e)
    }
    reload()
  }

  const primaryOptime = c.members.find((m) => m.state === 'PRIMARY')?.optime ?? null
  const shardColor = (id: string): string =>
    SHARD_COLORS[
      Math.max(
        0,
        c.shards.findIndex((s) => s.id === id)
      ) % SHARD_COLORS.length
    ]

  return (
    <>
      {c.kind === 'replicaSet' && (
        <section>
          <SectionTitle icon={<Network className="size-3.5" />} extra={refresh}>
            Replica set <span className="font-mono normal-case">{c.setName}</span>
          </SectionTitle>
          {c.membersNote && (
            <p className="mb-2 text-[11px] text-faint">
              Showing members from hello only; replSetGetStatus failed: {c.membersNote}
            </p>
          )}
          <div className="overflow-hidden rounded-lg border border-line bg-panel/70">
            <table className="w-full text-[12px]">
              <thead className="border-b border-line">
                <tr>
                  <th className={th}>Member</th>
                  <th className={th}>State</th>
                  <th className={th}>Replication lag</th>
                  <th className={th}>Ping</th>
                  <th className={th}>Uptime</th>
                  <th className={th}>Syncing from</th>
                </tr>
              </thead>
              <tbody>
                {c.members.map((m) => (
                  <tr key={m.name} className="border-b border-line last:border-0">
                    <td className={cn(td, 'font-mono text-bright')}>
                      {m.name}
                      {m.self && <span className="ml-2 text-[11px] text-faint">(connected)</span>}
                    </td>
                    <td className={td}>
                      {m.health === null ? (
                        <Badge
                          tone="neutral"
                          title="Health unknown: replSetGetStatus wasn't allowed"
                        >
                          {m.state === 'UNKNOWN' ? 'unknown' : `${m.state} · health unknown`}
                        </Badge>
                      ) : (
                        <Badge tone={m.health ? stateTone(m.state) : 'danger'}>
                          {m.health ? m.state : `${m.state} · unreachable`}
                        </Badge>
                      )}
                    </td>
                    <td className={cn(td, 'tabular-nums')}>
                      {m.state === 'SECONDARY' && primaryOptime !== null && m.optime !== null
                        ? formatDuration(Math.max(0, primaryOptime - m.optime))
                        : '—'}
                    </td>
                    <td className={cn(td, 'tabular-nums')}>
                      {m.pingMs !== null ? `${m.pingMs} ms` : '—'}
                    </td>
                    <td className={cn(td, 'tabular-nums')}>
                      {m.uptimeSecs !== null ? uptime(m.uptimeSecs) : '—'}
                    </td>
                    <td className={cn(td, 'font-mono text-muted')}>{m.syncSource || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {c.kind === 'sharded' && (
        <>
          <section>
            <SectionTitle
              icon={<Boxes className="size-3.5" />}
              extra={
                <>
                  {refresh}
                  {c.balancer && (
                    <span className="ml-auto flex items-center gap-2 font-normal tracking-normal normal-case">
                      <span className="text-[11px] text-muted">
                        Balancer{' '}
                        <Badge tone={c.balancer.mode === 'off' ? 'warning' : 'success'}>
                          {c.balancer.mode}
                          {c.balancer.inRound && ' · migrating'}
                        </Badge>
                      </span>
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={connection.readOnly}
                        onClick={() => void toggleBalancer()}
                      >
                        {c.balancer.mode === 'off' ? (
                          <>
                            <Play className="size-3" /> Start
                          </>
                        ) : (
                          <>
                            <Pause className="size-3" /> Stop
                          </>
                        )}
                      </Button>
                    </span>
                  )}
                </>
              }
            >
              Shards
            </SectionTitle>
            {c.shardingNote && (
              <div className="mb-2">
                <ErrorText error={c.shardingNote} />
              </div>
            )}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
              {c.shards.map((s) => {
                const [set, hosts] = s.host.includes('/') ? s.host.split('/', 2) : ['', s.host]
                const chunks = c.collections.reduce((n, coll) => n + (coll.chunks[s.id] ?? 0), 0)
                const primaryFor = c.databases.filter((d) => d.primary === s.id).length
                return (
                  <div key={s.id} className="rounded-lg border border-line bg-panel/70 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={cn('size-2.5 rounded-full', shardColor(s.id))} />
                      <span className="font-medium text-bright">{s.id}</span>
                      {s.draining && <Badge tone="warning">draining</Badge>}
                      {s.tags.map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                    </div>
                    {set && <p className="mt-1 text-[11px] text-muted">Replica set {set}</p>}
                    <p className="mt-0.5 truncate font-mono text-[11px] text-faint" title={hosts}>
                      {hosts.split(',').join(', ')}
                    </p>
                    <p className="mt-2 text-[11px] text-muted tabular-nums">
                      {chunks.toLocaleString()} chunk{chunks === 1 ? '' : 's'} · primary for{' '}
                      {primaryFor} database{primaryFor === 1 ? '' : 's'}
                    </p>
                  </div>
                )
              })}
            </div>
          </section>

          <section>
            <SectionTitle
              icon={<Split className="size-3.5" />}
              extra={
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto normal-case"
                  disabled={connection.readOnly}
                  onClick={() => setSharding(true)}
                >
                  <Plus className="size-3" /> Shard a collection
                </Button>
              }
            >
              Sharded collections
            </SectionTitle>
            {c.collections.length ? (
              <div className="overflow-hidden rounded-lg border border-line bg-panel/70">
                <table className="w-full text-[12px]">
                  <thead className="border-b border-line">
                    <tr>
                      <th className={th}>Collection</th>
                      <th className={th}>Shard key</th>
                      <th className={cn(th, 'w-[40%]')}>Chunks per shard</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.collections.map((coll) => {
                      const total = Object.values(coll.chunks).reduce((a, b) => a + b, 0)
                      return (
                        <tr key={coll.ns} className="border-b border-line last:border-0">
                          <td className={cn(td, 'font-mono text-bright')}>{coll.ns}</td>
                          <td className={cn(td, 'font-mono text-muted')}>
                            {toShell(coll.key, 0)}
                            {coll.unique && <Badge className="ml-2">unique</Badge>}
                          </td>
                          <td className={td}>
                            <div className="flex h-2 overflow-hidden rounded-full bg-hover">
                              {Object.entries(coll.chunks).map(([shard, n]) => (
                                <div
                                  key={shard}
                                  className={shardColor(shard)}
                                  style={{ width: `${(n / Math.max(1, total)) * 100}%` }}
                                  title={`${shard}: ${n} chunk${n === 1 ? '' : 's'}`}
                                />
                              ))}
                            </div>
                            <p className="mt-1 text-[11px] text-faint tabular-nums">
                              {Object.entries(coll.chunks)
                                .map(([shard, n]) => `${shard} ${n}`)
                                .join(' · ') || 'No chunks'}
                            </p>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No sharded collections">
                Collections live whole on their database&apos;s primary shard until sharded.
              </EmptyState>
            )}
          </section>
          {sharding && (
            <ShardCollectionDialog
              connectionId={connection.id}
              onClose={() => setSharding(false)}
              onDone={() => {
                setSharding(false)
                reload()
              }}
            />
          )}
        </>
      )}
    </>
  )
}

function ShardCollectionDialog({
  connectionId,
  onClose,
  onDone
}: {
  connectionId: string
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const [ns, setNs] = useState('')
  const [key, setKey] = useState("{ _id: 'hashed' }")
  const [unique, setUnique] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setError(null)
    const dot = ns.indexOf('.')
    if (dot <= 0 || dot === ns.length - 1) {
      setError('Enter the namespace as database.collection')
      return
    }
    let keyDoc: unknown
    try {
      keyDoc = parseShellValue(key)
    } catch (e) {
      setError(`Shard key: ${errorMessage(e)}`)
      return
    }
    setBusy(true)
    try {
      // Needed before 6.0; newer servers accept it as a no-op
      await command(connectionId, { enableSharding: ns.slice(0, dot) }).catch(() => {})
      await command(connectionId, {
        shardCollection: ns,
        key: keyDoc as Doc,
        ...(unique ? { unique: true } : {})
      })
      toast(`Sharded ${ns}`)
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Shard a collection"
      description="Spreads the collection across shards by the shard key. Choose the key carefully: changing it later means resharding."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || !ns.trim()}>
            Shard collection
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Collection" hint="database.collection; created if it doesn't exist">
          <Input
            mono
            value={ns}
            onChange={(e) => setNs(e.target.value.trim())}
            placeholder="shop.orders"
          />
        </Field>
        <Field
          label="Shard key"
          hint="Hashed keys spread writes evenly; ranged keys ({ customerId: 1 }) keep related documents together. Non-empty collections need an index on the key."
        >
          <Input mono value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Toggle
          checked={unique}
          onChange={setUnique}
          label="Unique"
          description="Enforce uniqueness on the key (ranged keys only)"
        />
        {error && <ErrorText error={error} />}
      </div>
    </Modal>
  )
}
