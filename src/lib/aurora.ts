/**
 * Aurora PostgreSQL cluster status. Aurora reports the same version() as community
 * PostgreSQL, so it's told apart by its aurora_* functions; the cluster topology and
 * replica lag come from aurora_replica_status(), cross-region lag from aurora_global_db_status().
 */
import type { ResultSet } from './api'
import { metricKey, num, rowToRaw, type Raw, type ServerDashboardSpec } from './server-metrics'

const AURORA_FUNCTIONS = [
  'aurora_version',
  'aurora_db_instance_identifier',
  'aurora_replica_status',
  'aurora_global_db_status'
] as const

export type AuroraFunction = (typeof AURORA_FUNCTIONS)[number]

/** Which aurora_* functions the server has; none on community PostgreSQL. */
export const AURORA_DETECT_SQL = `SELECT DISTINCT proname FROM pg_catalog.pg_proc
WHERE proname IN (${AURORA_FUNCTIONS.map((n) => `'${n}'`).join(', ')})`

/** The detected functions, or null when the server isn't Aurora. */
export function auroraFunctions(set: ResultSet | undefined): Set<AuroraFunction> | null {
  const found = new Set(
    (set?.rows ?? [])
      .map((r) => r[0])
      .filter((n): n is AuroraFunction => AURORA_FUNCTIONS.includes(n as AuroraFunction))
  )
  return found.has('aurora_version') ? found : null
}

/** The writer's row in aurora_replica_status() */
const WRITER_SESSION = 'MASTER_SESSION_ID'

/**
 * One or two result sets: the instance this session is on, then (when the server has
 * aurora_replica_status) every instance in the cluster, writer first.
 */
export function auroraStatusSql(fns: Set<AuroraFunction>): string {
  const instance = `SELECT aurora_version() AS aurora_version, ${
    fns.has('aurora_db_instance_identifier') ? 'aurora_db_instance_identifier()' : 'NULL::text'
  } AS instance_id, pg_is_in_recovery() AS in_recovery`
  if (!fns.has('aurora_replica_status')) return instance
  return `${instance};
SELECT *, extract(epoch FROM now() - last_update_timestamp) AS update_age_s
FROM aurora_replica_status()
ORDER BY session_id <> '${WRITER_SESSION}', server_id`
}

/** Lag per region of an Aurora global database; a cluster outside one lists just its region. */
export const AURORA_GLOBAL_SQL = 'SELECT * FROM aurora_global_db_status() ORDER BY aws_region'

export type AuroraTone = 'success' | 'warning' | 'danger' | 'neutral'

export interface AuroraInstance {
  serverId: string
  writer: boolean
  /** The instance this connection is on */
  self: boolean
  /** Null for the writer */
  lagMs: number | null
  replayLatencyUs: number | null
  activeTxns: number | null
  cpu: number | null
  durableLsn: string | null
  highestLsnReceived: string | null
  /** Seconds since the instance last reported its status */
  updateAgeS: number | null
}

export interface AuroraRegion {
  region: string
  /** Null for the primary region */
  durabilityLagMs: number | null
  rpoLagMs: number | null
}

export interface AuroraStatus {
  version: string | null
  instanceId: string | null
  /** The connected instance: a reader is in recovery */
  role: 'writer' | 'reader'
  /** Null when the server has no aurora_replica_status() */
  instances: AuroraInstance[] | null
  /** Empty unless the cluster is in a global database */
  regions: AuroraRegion[]
}

const text = (v: string | null | undefined): string | null => (v?.trim() ? v.trim() : null)

const flag = (v: string | null | undefined): boolean => /^(t|true|on|1|yes)$/i.test(v?.trim() ?? '')

/** Negative values stand for "not applicable" (the writer's own lag) */
const nonNegative = (n: number | null): number | null => (n == null || n < 0 ? null : n)

/** Each row of a result set as a name → value map. */
function records(set: ResultSet): Raw[] {
  const keys = set.columns.map((c) => metricKey(c.name))
  return set.rows.map((row) =>
    Object.fromEntries(
      row.map((cell, i) => [
        keys[i],
        cell == null ? null : typeof cell === 'boolean' ? (cell ? 't' : 'f') : cell
      ])
    )
  )
}

/** Parses the result sets of auroraStatusSql and, optionally, AURORA_GLOBAL_SQL. */
export function parseAurora(sets: ResultSet[], global?: ResultSet): AuroraStatus {
  const head = sets[0] ? rowToRaw(sets[0]) : {}
  const instanceId = text(head.instance_id)
  const instances = sets[1]
    ? records(sets[1]).map((r): AuroraInstance => {
        const serverId = text(r.server_id) ?? '?'
        const writer = r.session_id === WRITER_SESSION
        return {
          serverId,
          writer,
          self: !!instanceId && serverId === instanceId,
          lagMs: writer ? null : nonNegative(num(r, 'replica_lag_in_msec')),
          replayLatencyUs: writer ? null : nonNegative(num(r, 'cur_replay_latency_in_usec')),
          activeTxns: num(r, 'active_txns'),
          cpu: nonNegative(num(r, 'cpu')),
          durableLsn: text(r.durable_lsn),
          highestLsnReceived: writer ? null : text(r.highest_lsn_rcvd),
          updateAgeS: nonNegative(num(r, 'update_age_s'))
        }
      })
    : null
  const regions = global
    ? records(global).map((r) => ({
        region: text(r.aws_region) ?? '?',
        durabilityLagMs: nonNegative(num(r, 'durability_lag_in_msec')),
        rpoLagMs: nonNegative(num(r, 'rpo_lag_in_msec'))
      }))
    : []
  return {
    version: text(head.aurora_version),
    instanceId,
    role: flag(head.in_recovery) ? 'reader' : 'writer',
    instances,
    // A cluster outside a global database reports only its own region
    regions: regions.length > 1 ? regions : []
  }
}

/** Reader lag at which a replica is flagged, then flagged as badly behind. */
const LAG_WARN_MS = 1000
const LAG_DANGER_MS = 10_000
/** An instance that hasn't reported for this long is likely restarting or gone. */
const STALE_S = 60

export function lagTone(ms: number | null): AuroraTone {
  if (ms == null) return 'neutral'
  if (ms >= LAG_DANGER_MS) return 'danger'
  if (ms >= LAG_WARN_MS) return 'warning'
  return 'success'
}

export function maxReaderLag(s: AuroraStatus): number | null {
  const lags = (s.instances ?? []).map((i) => i.lagMs).filter((n): n is number => n != null)
  return lags.length ? Math.max(...lags) : null
}

/** Problems worth a banner, worst first. */
export function auroraWarnings(s: AuroraStatus): { tone: 'warning' | 'danger'; text: string }[] {
  const out: { tone: 'warning' | 'danger'; text: string }[] = []
  const instances = s.instances ?? []
  if (s.instances && !instances.some((i) => i.writer))
    out.push({
      tone: 'danger',
      text: 'No writer is listed in aurora_replica_status(): the cluster may be failing over.'
    })
  for (const i of instances) {
    const tone = lagTone(i.lagMs)
    if (tone === 'warning' || tone === 'danger')
      out.push({
        tone,
        text: `Reader ${i.serverId} is ${formatMs(i.lagMs)} behind the writer: queries there see older data.`
      })
    if (i.updateAgeS != null && i.updateAgeS >= STALE_S)
      out.push({
        tone: 'warning',
        text: `${i.writer ? 'The writer' : `Reader ${i.serverId}`} hasn't reported its status for ${Math.round(i.updateAgeS)}s: it may be restarting or unreachable.`
      })
  }
  for (const r of s.regions) {
    const tone = lagTone(r.durabilityLagMs)
    if (tone === 'warning' || tone === 'danger')
      out.push({
        tone,
        text: `Secondary region ${r.region} is ${formatMs(r.durabilityLagMs)} behind the primary.`
      })
  }
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1))
}

export function formatMs(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

/** Hover text for each metric the panel shows. */
export const AURORA_HINTS = {
  role: 'pg_is_in_recovery(): readers are in recovery and only serve reads; the writer takes every write.',
  version: 'aurora_version(): the Aurora PostgreSQL release, separate from the PostgreSQL version.',
  instanceId: 'aurora_db_instance_identifier(): the DB instance this connection landed on.',
  instances: 'Instances aurora_replica_status() lists in the cluster: one writer and its readers.',
  maxLag:
    'replica_lag_in_msec: how far the furthest reader is behind the writer. Usually well under 100 ms.',
  lag: 'replica_lag_in_msec: how far this reader is behind the writer.',
  replay: 'cur_replay_latency_in_usec: how long the reader takes to apply the changes it receives.',
  activeTxns: 'active_txns: transactions open on the instance.',
  cpu: 'cpu: CPU usage the instance reports to the cluster, in percent.',
  durableLsn: 'durable_lsn: the log position made durable in Aurora storage.',
  updated: 'last_update_timestamp: how long ago the instance last reported its status.',
  durabilityLag:
    'durability_lag_in_msec: how far the secondary region’s storage is behind the primary region.',
  rpoLag: 'rpo_lag_in_msec: the recovery point objective lag; data a failover to it could lose.'
} as const

/* ---------- Live metrics ---------- */

const extended = new WeakMap<ServerDashboardSpec, ServerDashboardSpec>()

/**
 * The live-metrics spec with Aurora tiles added: the furthest reader's lag and the instance
 * count. Cached so the spec keeps its identity.
 */
export function withAuroraMetrics(spec: ServerDashboardSpec): ServerDashboardSpec {
  const cached = extended.get(spec)
  if (cached) return cached
  const next: ServerDashboardSpec = {
    ...spec,
    probes: [
      ...spec.probes,
      {
        id: 'aurora',
        shape: 'row',
        sql: `SELECT max(replica_lag_in_msec) FILTER (WHERE session_id <> '${WRITER_SESSION}' AND replica_lag_in_msec >= 0) / 1000.0 AS aurora_lag_s,
  count(*) AS aurora_instances, pg_is_in_recovery() AS aurora_reader
FROM aurora_replica_status()`
      }
    ],
    derive: (raw, prev, s) => ({
      ...spec.derive(raw, prev, s),
      auroraLag: num(raw, 'aurora_lag_s'),
      auroraInstances: num(raw, 'aurora_instances')
    }),
    tiles: [
      ...spec.tiles,
      {
        key: 'auroraLag',
        label: 'Replica lag',
        unit: 'seconds',
        hint: 'How far the furthest Aurora reader is behind the writer'
      },
      {
        key: 'auroraInstances',
        label: 'Instances',
        unit: 'count',
        hint: 'Writer and readers in the Aurora cluster'
      }
    ],
    facts: (raw) => {
      const base = spec.facts(raw)
      if (raw.aurora_instances == null) return base
      const parts = [
        flag(raw.aurora_reader) ? 'Reader' : 'Writer',
        `${raw.aurora_instances} instances`
      ]
      return [...base, { label: 'Aurora', value: parts.join(' · ') }]
    }
  }
  extended.set(spec, next)
  return next
}
