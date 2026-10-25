import { describe, expect, it } from 'vitest'
import type { Cell, ResultSet } from '../api'
import {
  dropSlotSql,
  formatLag,
  hasReplication,
  parseProbe,
  parseReplication,
  receiverHidden,
  RECEIVER_SQL,
  replicationSql,
  replicationWarnings,
  sendersHidden,
  SENDERS_SQL,
  SLOT_RETAINED_WARN,
  slotsSql,
  slotWarning,
  type ReplicationProbe,
  type ReplicationSlot
} from '../pg-replication'

const set = (columns: string[], rows: Cell[][]): ResultSet => ({
  columns: columns.map((name) => ({ name, typeName: 'text' })),
  rows,
  rowCount: rows.length,
  truncated: false
})

const PROBE_COLUMNS = ['standby', 'senders', 'receivers', 'slots', 'version', 'monitor']

const probe = (over: Partial<ReplicationProbe> = {}): ReplicationProbe => ({
  standby: false,
  senders: 0,
  receivers: 0,
  slots: 0,
  version: 170000,
  monitor: true,
  ...over
})

const SENDER_COLUMNS = [
  'pid',
  'usename',
  'application_name',
  'client_addr',
  'state',
  'sync_state',
  'slot_name',
  'slot_type',
  'sent_lsn',
  'write_lsn',
  'flush_lsn',
  'replay_lsn',
  'write_lag_s',
  'flush_lag_s',
  'replay_lag_s',
  'behind_bytes'
]

const SLOT_COLUMNS = [
  'slot_name',
  'slot_type',
  'plugin',
  'database',
  'active',
  'active_pid',
  'temporary',
  'restart_lsn',
  'confirmed_flush_lsn',
  'retained_bytes',
  'wal_status',
  'safe_wal_size',
  'inactive_since',
  'invalidation_reason'
]

const RECEIVER_COLUMNS = [
  'pid',
  'status',
  'sender_host',
  'sender_port',
  'slot_name',
  'received_lsn',
  'replayed_lsn',
  'replay_behind_bytes',
  'replay_lag_s',
  'last_message_s',
  'paused'
]

const slot = (over: Partial<ReplicationSlot> = {}): ReplicationSlot => ({
  name: 's',
  type: 'logical',
  plugin: 'pgoutput',
  database: 'db',
  active: false,
  activePid: null,
  temporary: false,
  restartLsn: '0/1',
  confirmedFlushLsn: '0/1',
  retainedBytes: 0,
  walStatus: 'reserved',
  safeWalSize: null,
  inactiveSince: null,
  invalidationReason: null,
  ...over
})

describe('probe', () => {
  it('parses text and boolean cells', () => {
    expect(parseProbe(set(PROBE_COLUMNS, [['t', '0', '1', '0', '170011', 'f']]))).toEqual({
      standby: true,
      senders: 0,
      receivers: 1,
      slots: 0,
      version: 170011,
      monitor: false
    })
    expect(parseProbe(set(PROBE_COLUMNS, [[false, '2', '0', '3', '160004', true]]))?.monitor).toBe(
      true
    )
    expect(parseProbe(set(PROBE_COLUMNS, []))).toBeNull()
  })

  it('shows the section only when there is something to show', () => {
    expect(hasReplication(null)).toBe(false)
    expect(hasReplication(probe())).toBe(false)
    expect(hasReplication(probe({ standby: true }))).toBe(true)
    expect(hasReplication(probe({ senders: 1 }))).toBe(true)
    expect(hasReplication(probe({ slots: 1 }))).toBe(true)
  })
})

describe('SQL', () => {
  it('reads the receiver only on a standby', () => {
    expect(replicationSql(probe())).not.toContain('pg_stat_wal_receiver')
    expect(replicationSql(probe({ standby: true }))).toContain(RECEIVER_SQL)
    expect(replicationSql(probe())).toContain(SENDERS_SQL)
  })

  it('keeps pg_current_wal_lsn() off standbys', () => {
    expect(SENDERS_SQL).toContain(
      'CASE WHEN pg_is_in_recovery() THEN pg_last_wal_receive_lsn() ELSE pg_current_wal_lsn() END'
    )
  })

  it('gates slot columns by version', () => {
    expect(slotsSql(170000)).toContain('inactive_since::text AS inactive_since')
    expect(slotsSql(160000)).toContain('NULL::text AS inactive_since')
    expect(slotsSql(160000)).toContain(' wal_status,')
    expect(slotsSql(120000)).toContain('NULL::text AS wal_status')
  })

  it('quotes the slot name', () => {
    expect(dropSlotSql("it's")).toBe("SELECT pg_drop_replication_slot('it''s')")
  })
})

describe('parseReplication', () => {
  const senders = set(SENDER_COLUMNS, [
    [
      '88',
      'replicator',
      'walreceiver',
      '172.18.0.3',
      'streaming',
      'async',
      'standby1',
      'physical',
      '0/38BA698',
      '0/38BA698',
      '0/38BA698',
      '0/38BA690',
      '0.0012',
      null,
      null,
      '8'
    ]
  ])
  const slots = set(SLOT_COLUMNS, [
    [
      'abandoned',
      'logical',
      'test_decoding',
      'pub_db',
      'f',
      null,
      'f',
      '0/385F240',
      '0/385F278',
      String(2 * 1024 ** 3),
      'extended',
      null,
      '2026-10-25 18:12:25.893196+00',
      null
    ]
  ])

  it('reads a primary', () => {
    const r = parseReplication(probe({ senders: 1, slots: 1 }), [senders, slots])
    expect(r.receiver).toBeNull()
    expect(r.senders[0]).toMatchObject({
      applicationName: 'walreceiver',
      state: 'streaming',
      slotType: 'physical',
      writeLag: 0.0012,
      flushLag: null,
      behindBytes: 8
    })
    expect(r.slots[0]).toMatchObject({ name: 'abandoned', active: false, walStatus: 'extended' })
    expect(sendersHidden(r)).toBe(false)
  })

  it('reads a standby', () => {
    const receiver = set(RECEIVER_COLUMNS, [
      ['13', 'streaming', 'primary', '5432', 'standby1', '0/1', '0/1', '0', '3.5', '1.2', 'f']
    ])
    const r = parseReplication(probe({ standby: true, receivers: 1 }), [
      set(SENDER_COLUMNS, []),
      receiver,
      set(SLOT_COLUMNS, [])
    ])
    expect(r.receiver).toMatchObject({ status: 'streaming', paused: false, replayLag: 3.5 })
    expect(r.slots).toEqual([])
    expect(replicationWarnings(r)).toEqual([])
  })

  it('notices hidden columns without pg_read_all_stats', () => {
    const hidden = set(SENDER_COLUMNS, [
      ['88', 'replicator', 'walreceiver', ...Array(13).fill(null)]
    ])
    const receiver = set(RECEIVER_COLUMNS, [
      ['13', null, null, null, null, '0/1', '0/1', '0', '3', null, 'f']
    ])
    const r = parseReplication(probe({ standby: true, monitor: false }), [
      hidden,
      receiver,
      set(SLOT_COLUMNS, [])
    ])
    expect(sendersHidden(r)).toBe(true)
    expect(receiverHidden(r)).toBe(true)
    // A hidden status isn't reported as a stopped receiver
    expect(replicationWarnings(r)).toEqual([])
  })
})

describe('warnings', () => {
  it('flags inactive slots holding back a lot of WAL', () => {
    expect(slotWarning(slot({ retainedBytes: SLOT_RETAINED_WARN - 1 }))).toBeNull()
    expect(slotWarning(slot({ retainedBytes: SLOT_RETAINED_WARN }))?.tone).toBe('warning')
    expect(slotWarning(slot({ retainedBytes: SLOT_RETAINED_WARN, active: true }))).toBeNull()
    expect(
      slotWarning(slot({ retainedBytes: SLOT_RETAINED_WARN, inactiveSince: '2026-10-01' }))?.text
    ).toContain('since 2026-10-01')
  })

  it('flags lost and unreserved slots as danger', () => {
    expect(slotWarning(slot({ walStatus: 'lost', invalidationReason: 'wal_removed' }))).toEqual({
      tone: 'danger',
      text: expect.stringContaining('(wal_removed)')
    })
    expect(slotWarning(slot({ walStatus: 'unreserved', active: true }))?.tone).toBe('danger')
  })

  it('flags a standby without a receiver, and paused replay', () => {
    const r = parseReplication(probe({ standby: true }), [
      set(SENDER_COLUMNS, []),
      set(RECEIVER_COLUMNS, [[null, null, null, null, null, '0/1', '0/1', '0', '9', null, 't']]),
      set(SLOT_COLUMNS, [
        ['x', 'physical', null, null, 'f', null, 'f', null, null, null, 'lost', null, null, null]
      ])
    ])
    const w = replicationWarnings(r)
    expect(w.map((x) => x.tone)).toEqual(['danger', 'danger', 'warning'])
    expect(w[2].text).toContain('paused')
  })
})

describe('formatLag', () => {
  it('scales the unit', () => {
    expect(formatLag(null)).toBe('—')
    expect(formatLag(0.0012)).toBe('1.2 ms')
    expect(formatLag(0.25)).toBe('250 ms')
    expect(formatLag(3.46)).toBe('3.5 s')
    expect(formatLag(245)).toBe('4 min 05 s')
    expect(formatLag(3 * 3600 + 120)).toBe('3 h 02 min')
    expect(formatLag(52 * 3600)).toBe('2 d 4 h')
  })
})
