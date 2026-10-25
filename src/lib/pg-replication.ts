/**
 * PostgreSQL streaming replication for the Server page: the standbys a primary sends WAL to
 * (pg_stat_replication), the WAL receiver of a standby (pg_stat_wal_receiver) and the
 * replication slots (pg_replication_slots). One cheap probe decides whether there's anything
 * to show; a plain server with no standbys, no receiver and no slots shows nothing.
 */
import type { Cell, ResultSet } from './api'
import { formatBytes } from './format'
import { literal } from './sql'

/**
 * Whether this server replicates at all, its version (to gate newer columns) and whether the
 * signed-in role sees other sessions' replication details (pg_read_all_stats, part of pg_monitor).
 */
export const REPLICATION_PROBE_SQL = `SELECT pg_is_in_recovery() AS standby,
  (SELECT count(*) FROM pg_stat_replication) AS senders,
  (SELECT count(*) FROM pg_stat_wal_receiver) AS receivers,
  (SELECT count(*) FROM pg_replication_slots) AS slots,
  current_setting('server_version_num')::int AS version,
  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
    OR pg_has_role('pg_read_all_stats', 'USAGE') AS monitor`

export interface ReplicationProbe {
  standby: boolean
  senders: number
  receivers: number
  slots: number
  version: number
  /** Without pg_read_all_stats, pg_stat_replication and pg_stat_wal_receiver show only pids */
  monitor: boolean
}

const text = (cell: Cell | undefined): string | null =>
  typeof cell === 'string' && cell !== '' ? cell : null

const flag = (cell: Cell | undefined): boolean | null =>
  typeof cell === 'boolean'
    ? cell
    : cell == null || cell === ''
      ? null
      : /^(t|true|1|on)$/i.test(cell)

const number = (cell: Cell | undefined): number | null => {
  const n = Number(text(cell) ?? NaN)
  return Number.isFinite(n) ? n : null
}

/** Row `i` of a result set as a column name → cell map. */
function record(set: ResultSet | undefined, i: number): Record<string, Cell> {
  const row = set?.rows[i] ?? []
  return Object.fromEntries((set?.columns ?? []).map((c, j) => [c.name, row[j] ?? null]))
}

const records = (set: ResultSet | undefined): Record<string, Cell>[] =>
  (set?.rows ?? []).map((_, i) => record(set, i))

export function parseProbe(set: ResultSet | undefined): ReplicationProbe | null {
  if (!set?.rows.length) return null
  const r = record(set, 0)
  return {
    standby: !!flag(r.standby),
    senders: number(r.senders) ?? 0,
    receivers: number(r.receivers) ?? 0,
    slots: number(r.slots) ?? 0,
    version: number(r.version) ?? 0,
    monitor: !!flag(r.monitor)
  }
}

/** A standby, or a primary sending to standbys or logical subscribers, or one with slots. */
export const hasReplication = (p: ReplicationProbe | null): boolean =>
  !!p && (p.standby || p.senders > 0 || p.receivers > 0 || p.slots > 0)

/* ---------- Details ---------- */

// The WAL position replication is measured against: the primary's insert position, or on a
// (cascading) standby what it has received. CASE keeps pg_current_wal_lsn() from running on a
// standby, where it raises an error.
const HEAD_LSN = `CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn() ELSE pg_current_wal_lsn() END`

/** WAL senders: physical standbys and logical subscribers this server streams to. */
export const SENDERS_SQL = `SELECT r.pid, r.usename::text AS usename, r.application_name,
  host(r.client_addr) AS client_addr, r.state, r.sync_state,
  s.slot_name::text AS slot_name, s.slot_type,
  r.sent_lsn::text AS sent_lsn, r.write_lsn::text AS write_lsn,
  r.flush_lsn::text AS flush_lsn, r.replay_lsn::text AS replay_lsn,
  extract(epoch FROM r.write_lag)::float8 AS write_lag_s,
  extract(epoch FROM r.flush_lag)::float8 AS flush_lag_s,
  extract(epoch FROM r.replay_lag)::float8 AS replay_lag_s,
  pg_wal_lsn_diff(${HEAD_LSN}, r.replay_lsn)::bigint AS behind_bytes
FROM pg_stat_replication r
LEFT JOIN pg_replication_slots s ON s.active_pid = r.pid
ORDER BY r.application_name, r.pid`

/**
 * This standby's WAL receiver and replay position; one row even when the receiver isn't
 * running (status is then null). Run only on a standby: pg_is_wal_replay_paused() raises an
 * error on a primary.
 */
export const RECEIVER_SQL = `SELECT w.pid, w.status, w.sender_host, w.sender_port, w.slot_name::text AS slot_name,
  coalesce(w.flushed_lsn, pg_last_wal_receive_lsn())::text AS received_lsn,
  pg_last_wal_replay_lsn()::text AS replayed_lsn,
  pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())::bigint AS replay_behind_bytes,
  extract(epoch FROM now() - pg_last_xact_replay_timestamp())::float8 AS replay_lag_s,
  extract(epoch FROM now() - w.last_msg_receipt_time)::float8 AS last_message_s,
  pg_is_wal_replay_paused() AS paused
FROM (SELECT 1) one LEFT JOIN pg_stat_wal_receiver w ON true`

/** Replication slots; wal_status and safe_wal_size are PG 13+, inactive_since and invalidation_reason PG 17+. */
export function slotsSql(version: number): string {
  const v13 = version >= 130000
  const v17 = version >= 170000
  return `SELECT slot_name::text AS slot_name, slot_type, plugin::text AS plugin, database::text AS database,
  active, active_pid, temporary,
  restart_lsn::text AS restart_lsn, confirmed_flush_lsn::text AS confirmed_flush_lsn,
  pg_wal_lsn_diff(${HEAD_LSN}, restart_lsn)::bigint AS retained_bytes,
  ${v13 ? 'wal_status' : 'NULL::text AS wal_status'},
  ${v13 ? 'safe_wal_size' : 'NULL::bigint AS safe_wal_size'},
  ${v17 ? 'inactive_since::text AS inactive_since' : 'NULL::text AS inactive_since'},
  ${v17 ? 'invalidation_reason' : 'NULL::text AS invalidation_reason'}
FROM pg_replication_slots
ORDER BY slot_name`
}

/** Every detail statement for the probed server, in the order `parseReplication` reads them. */
export function replicationSql(probe: ReplicationProbe): string {
  return [SENDERS_SQL, ...(probe.standby ? [RECEIVER_SQL] : []), slotsSql(probe.version)].join(
    ';\n'
  )
}

export interface WalSender {
  pid: string | null
  user: string | null
  applicationName: string | null
  clientAddr: string | null
  /** startup, catchup, streaming, backup, stopping; null without pg_read_all_stats */
  state: string | null
  /** async, potential, sync, quorum */
  syncState: string | null
  slotName: string | null
  /** physical (a standby) or logical (a subscriber) */
  slotType: string | null
  sentLsn: string | null
  writeLsn: string | null
  flushLsn: string | null
  replayLsn: string | null
  writeLag: number | null
  flushLag: number | null
  replayLag: number | null
  behindBytes: number | null
}

export interface WalReceiver {
  pid: string | null
  /** streaming, waiting, catchup, stopping…; null when no receiver runs or details are hidden */
  status: string | null
  senderHost: string | null
  senderPort: string | null
  slotName: string | null
  receivedLsn: string | null
  replayedLsn: string | null
  replayBehindBytes: number | null
  /** Seconds since the last replayed transaction committed on the primary */
  replayLag: number | null
  lastMessage: number | null
  paused: boolean | null
}

export interface ReplicationSlot {
  name: string
  type: string | null
  plugin: string | null
  database: string | null
  active: boolean
  activePid: string | null
  temporary: boolean
  restartLsn: string | null
  confirmedFlushLsn: string | null
  retainedBytes: number | null
  /** reserved, extended, unreserved, lost (PG 13+) */
  walStatus: string | null
  safeWalSize: number | null
  /** PG 17+ */
  inactiveSince: string | null
  invalidationReason: string | null
}

export interface Replication {
  probe: ReplicationProbe
  senders: WalSender[]
  /** Only on a standby */
  receiver: WalReceiver | null
  slots: ReplicationSlot[]
}

export function parseReplication(probe: ReplicationProbe, sets: ResultSet[]): Replication {
  const [senders, ...rest] = sets
  const receiver = probe.standby ? rest.shift() : undefined
  const slots = rest[0]
  return {
    probe,
    senders: records(senders).map((r) => ({
      pid: text(r.pid),
      user: text(r.usename),
      applicationName: text(r.application_name),
      clientAddr: text(r.client_addr),
      state: text(r.state),
      syncState: text(r.sync_state),
      slotName: text(r.slot_name),
      slotType: text(r.slot_type),
      sentLsn: text(r.sent_lsn),
      writeLsn: text(r.write_lsn),
      flushLsn: text(r.flush_lsn),
      replayLsn: text(r.replay_lsn),
      writeLag: number(r.write_lag_s),
      flushLag: number(r.flush_lag_s),
      replayLag: number(r.replay_lag_s),
      behindBytes: number(r.behind_bytes)
    })),
    receiver: receiver?.rows.length
      ? ((r) => ({
          pid: text(r.pid),
          status: text(r.status),
          senderHost: text(r.sender_host),
          senderPort: text(r.sender_port),
          slotName: text(r.slot_name),
          receivedLsn: text(r.received_lsn),
          replayedLsn: text(r.replayed_lsn),
          replayBehindBytes: number(r.replay_behind_bytes),
          replayLag: number(r.replay_lag_s),
          lastMessage: number(r.last_message_s),
          paused: flag(r.paused)
        }))(record(receiver, 0))
      : null,
    slots: records(slots).map((r) => ({
      name: text(r.slot_name) ?? '',
      type: text(r.slot_type),
      plugin: text(r.plugin),
      database: text(r.database),
      active: !!flag(r.active),
      activePid: text(r.active_pid),
      temporary: !!flag(r.temporary),
      restartLsn: text(r.restart_lsn),
      confirmedFlushLsn: text(r.confirmed_flush_lsn),
      retainedBytes: number(r.retained_bytes),
      walStatus: text(r.wal_status),
      safeWalSize: number(r.safe_wal_size),
      inactiveSince: text(r.inactive_since),
      invalidationReason: text(r.invalidation_reason)
    }))
  }
}

/** Without pg_read_all_stats a sender row has its pid and name but every position is null. */
export const sendersHidden = (r: Replication): boolean =>
  !r.probe.monitor && r.senders.some((s) => s.state == null && s.sentLsn == null)

export const receiverHidden = (r: Replication): boolean =>
  !r.probe.monitor && !!r.receiver?.pid && r.receiver.status == null

/* ---------- Warnings ---------- */

/** WAL an inactive slot may hold back before it's flagged. */
export const SLOT_RETAINED_WARN = 1024 ** 3

/** Bytes a standby may trail the primary's WAL before it's flagged. */
const BEHIND_WARN = 1024 ** 3

export interface ReplicationWarning {
  tone: 'warning' | 'danger'
  text: string
}

/** Why a slot deserves attention, or null. */
export function slotWarning(slot: ReplicationSlot): ReplicationWarning | null {
  if (slot.walStatus === 'lost')
    return {
      tone: 'danger',
      text: `Slot ${slot.name} is invalidated${slot.invalidationReason ? ` (${slot.invalidationReason})` : ''}: the WAL it needed was removed, so its consumer can't resume from it. Drop it and resynchronize the consumer.`
    }
  if (slot.walStatus === 'unreserved')
    return {
      tone: 'danger',
      text: `Slot ${slot.name} has passed max_slot_wal_keep_size: the WAL it needs will be removed at the next checkpoint and the slot invalidated.`
    }
  if (!slot.active && !slot.temporary && (slot.retainedBytes ?? 0) >= SLOT_RETAINED_WARN)
    return {
      tone: 'warning',
      text: `Slot ${slot.name} is inactive${slot.inactiveSince ? ` since ${slot.inactiveSince}` : ''} and holds back ${formatBytes(slot.retainedBytes ?? 0)} of WAL. The server keeps that WAL until the slot's consumer reconnects, so an abandoned slot can fill the disk; drop it if nothing uses it.`
    }
  return null
}

/** Problems worth a banner, worst first. */
export function replicationWarnings(r: Replication): ReplicationWarning[] {
  const out: ReplicationWarning[] = []
  const rx = r.receiver
  if (rx && !receiverHidden(r)) {
    if (!rx.status)
      out.push({
        tone: 'danger',
        text: 'This standby has no WAL receiver running: it isn’t streaming from a primary (check primary_conninfo, the network and the primary’s log). It may be replaying from an archive only.'
      })
    else if (rx.status !== 'streaming')
      out.push({
        tone: 'warning',
        text: `The WAL receiver is ${rx.status}, not streaming.`
      })
  }
  if (rx?.paused)
    out.push({
      tone: 'warning',
      text: 'WAL replay is paused (pg_wal_replay_pause): the standby receives WAL but doesn’t apply it, so its data falls behind. Resume with SELECT pg_wal_replay_resume().'
    })
  for (const s of r.senders) {
    const name = s.applicationName || s.clientAddr || `pid ${s.pid}`
    if (s.state && s.state !== 'streaming')
      out.push({ tone: 'warning', text: `${name} is ${s.state}, not streaming yet.` })
    if ((s.behindBytes ?? 0) >= BEHIND_WARN)
      out.push({
        tone: 'warning',
        text: `${name} has not replayed the last ${formatBytes(s.behindBytes ?? 0)} of WAL.`
      })
  }
  for (const slot of r.slots) {
    const w = slotWarning(slot)
    if (w) out.push(w)
  }
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1))
}

/* ---------- Actions ---------- */

export const dropSlotSql = (name: string): string =>
  `SELECT pg_drop_replication_slot(${literal('postgres', name)})`

/* ---------- Formatting ---------- */

/** A lag in seconds: 0.004 s, 12.3 s, 4 min 05 s, 3 h 02 min, 2 d 4 h. */
export function formatLag(seconds: number | null): string {
  if (seconds == null) return '—'
  const s = Math.max(0, seconds)
  if (s < 1) return `${(s * 1000).toFixed(s < 0.01 ? 1 : 0)} ms`
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

export const formatWalBytes = (n: number | null): string => (n == null ? '—' : formatBytes(n))

/** Hover text for the columns and figures the panel shows. */
export const REPLICATION_HINTS = {
  monitor:
    'Other sessions’ replication positions are visible only to superusers and members of pg_read_all_stats (included in pg_monitor): GRANT pg_monitor TO <role>.',
  state:
    'pg_stat_replication.state: startup and catchup while the standby is catching up, streaming once it is current, backup during pg_basebackup.',
  syncState:
    'sync_state: async standbys may lose the last commits on failover; sync and quorum ones confirm each commit (synchronous_standby_names).',
  lsn: 'WAL positions: sent to the standby, written to its disk, flushed, and replayed.',
  lag: 'write_lag / flush_lag / replay_lag: how long the standby took to write, flush and replay recent WAL. Null when the server has been idle.',
  behind:
    'Bytes of WAL between this server’s current position and what the standby has replayed (pg_wal_lsn_diff).',
  receiverStatus: 'pg_stat_wal_receiver.status: streaming is normal.',
  replayLag:
    'now() - pg_last_xact_replay_timestamp(): time since the last replayed transaction committed on the primary. It also grows while the primary is idle, so compare it with the bytes still to replay.',
  replayBehind: 'WAL received but not replayed yet.',
  paused: 'pg_is_wal_replay_paused(): whether replay was paused with pg_wal_replay_pause().',
  retained:
    'WAL this slot keeps on disk: from its restart_lsn to the current position. The server can’t recycle it until the slot’s consumer confirms it.',
  walStatus:
    'wal_status (PG 13+): reserved and extended are fine, unreserved is about to lose WAL it needs (past max_slot_wal_keep_size), lost means the slot is invalidated.',
  safeWalSize:
    'safe_wal_size (PG 13+): how much more WAL can be written before this slot is at risk of losing what it needs. Null when max_slot_wal_keep_size is -1 (unlimited).',
  inactiveSince: 'inactive_since (PG 17+): when the slot was last released by its consumer.'
} as const
