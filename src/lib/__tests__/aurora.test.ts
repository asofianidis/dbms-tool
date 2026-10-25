import { describe, expect, it } from 'vitest'
import type { ResultSet } from '../api'
import {
  AURORA_DETECT_SQL,
  auroraFunctions,
  auroraStatusSql,
  auroraWarnings,
  formatMs,
  lagTone,
  maxReaderLag,
  parseAurora,
  withAuroraMetrics
} from '../aurora'
import { dashboardFor } from '../server-metrics'

const set = (names: string[], rows: (string | boolean | null)[][]): ResultSet => ({
  columns: names.map((name) => ({ name, typeName: 'text' })),
  rows,
  rowCount: rows.length,
  truncated: false
})

const ALL = auroraFunctions(
  set(
    ['proname'],
    [
      ['aurora_version'],
      ['aurora_db_instance_identifier'],
      ['aurora_replica_status'],
      ['aurora_global_db_status']
    ]
  )
)!

const INSTANCE = set(['aurora_version', 'instance_id', 'in_recovery'], [['16.4.2', 'db-2', 't']])

const REPLICAS = set(
  [
    'server_id',
    'session_id',
    'replica_lag_in_msec',
    'cur_replay_latency_in_usec',
    'active_txns',
    'cpu',
    'durable_lsn',
    'highest_lsn_rcvd',
    'update_age_s'
  ],
  [
    ['db-1', 'MASTER_SESSION_ID', '-1', '0', '3', '12.5', '4518030', null, '0.4'],
    [
      'db-2',
      '6e1b0f4c-11aa-4a2e-9a55-d2c0c4f1e2b3',
      '18',
      '420',
      '1',
      '4.0',
      '4518030',
      '4518030',
      '0.7'
    ],
    [
      'db-3',
      '0c1e7c6d-55f2-4d4b-8a91-7f3b2d5a9e10',
      '2400',
      '9100',
      '0',
      '61',
      '4517900',
      '4518000',
      '0.2'
    ]
  ]
)

describe('aurora detection', () => {
  it('queries pg_proc for the aurora functions', () => {
    expect(AURORA_DETECT_SQL).toContain('pg_proc')
    expect(AURORA_DETECT_SQL).toContain("'aurora_replica_status'")
  })

  it('is null on community PostgreSQL', () => {
    expect(auroraFunctions(set(['proname'], []))).toBeNull()
    expect(auroraFunctions(undefined)).toBeNull()
    // A stray look-alike without aurora_version isn't Aurora
    expect(auroraFunctions(set(['proname'], [['aurora_replica_status']]))).toBeNull()
  })

  it('reads only the functions the server has', () => {
    const sql = auroraStatusSql(new Set(['aurora_version']))
    expect(sql).toContain('NULL::text AS instance_id')
    expect(sql).not.toContain('aurora_replica_status')
    expect(auroraStatusSql(ALL)).toContain('FROM aurora_replica_status()')
  })
})

describe('parseAurora', () => {
  const s = parseAurora([INSTANCE, REPLICAS])

  it('reads the connected instance', () => {
    expect(s.version).toBe('16.4.2')
    expect(s.instanceId).toBe('db-2')
    expect(s.role).toBe('reader')
  })

  it('lists the writer and readers', () => {
    expect(s.instances?.map((i) => [i.serverId, i.writer, i.self])).toEqual([
      ['db-1', true, false],
      ['db-2', false, true],
      ['db-3', false, false]
    ])
    // The writer's -1 lag means "not applicable"
    expect(s.instances?.[0].lagMs).toBeNull()
    expect(s.instances?.[2]).toMatchObject({ lagMs: 2400, replayLatencyUs: 9100, cpu: 61 })
    expect(maxReaderLag(s)).toBe(2400)
  })

  it('takes a writer from a false in_recovery, boolean or text', () => {
    const writer = (v: string | boolean) =>
      parseAurora([set(['aurora_version', 'instance_id', 'in_recovery'], [['16.4', 'db-1', v]])])
    expect(writer('f').role).toBe('writer')
    expect(writer(false).role).toBe('writer')
    expect(writer(true).role).toBe('reader')
  })

  it('has no instances without aurora_replica_status', () => {
    expect(parseAurora([INSTANCE]).instances).toBeNull()
  })

  it('shows regions only for a global database', () => {
    const cols = ['aws_region', 'durability_lag_in_msec', 'rpo_lag_in_msec']
    expect(parseAurora([INSTANCE], set(cols, [['us-east-1', '-1', '-1']])).regions).toEqual([])
    expect(
      parseAurora(
        [INSTANCE],
        set(cols, [
          ['us-east-1', '-1', '-1'],
          ['eu-west-1', '850', '1200']
        ])
      ).regions
    ).toEqual([
      { region: 'us-east-1', durabilityLagMs: null, rpoLagMs: null },
      { region: 'eu-west-1', durabilityLagMs: 850, rpoLagMs: 1200 }
    ])
  })
})

describe('auroraWarnings', () => {
  it('flags a lagging reader', () => {
    const w = auroraWarnings(parseAurora([INSTANCE, REPLICAS]))
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ tone: 'warning' })
    expect(w[0].text).toContain('db-3 is 2.4 s behind')
  })

  it('flags a missing writer and a silent instance, worst first', () => {
    const rows = set(
      ['server_id', 'session_id', 'replica_lag_in_msec', 'update_age_s'],
      [['db-2', 'abc', '10', '95']]
    )
    const w = auroraWarnings(parseAurora([INSTANCE, rows]))
    expect(w.map((x) => x.tone)).toEqual(['danger', 'warning'])
    expect(w[0].text).toContain('No writer')
    expect(w[1].text).toContain("hasn't reported its status for 95s")
  })

  it('is quiet for a healthy cluster', () => {
    const rows = set(
      ['server_id', 'session_id', 'replica_lag_in_msec', 'update_age_s'],
      [
        ['db-1', 'MASTER_SESSION_ID', null, '1'],
        ['db-2', 'abc', '15', '1']
      ]
    )
    expect(auroraWarnings(parseAurora([INSTANCE, rows]))).toEqual([])
  })
})

describe('formatting', () => {
  it('grades lag', () => {
    expect(lagTone(null)).toBe('neutral')
    expect(lagTone(40)).toBe('success')
    expect(lagTone(1500)).toBe('warning')
    expect(lagTone(20_000)).toBe('danger')
  })

  it('formats milliseconds', () => {
    expect(formatMs(null)).toBe('—')
    expect(formatMs(18.4)).toBe('18 ms')
    expect(formatMs(2400)).toBe('2.4 s')
    expect(formatMs(42_000)).toBe('42 s')
  })
})

describe('withAuroraMetrics', () => {
  const base = dashboardFor('postgres', false)
  const spec = withAuroraMetrics(base)

  it('keeps its identity and adds the Aurora probe and tiles', () => {
    expect(withAuroraMetrics(base)).toBe(spec)
    expect(spec.probes.at(-1)).toMatchObject({ id: 'aurora', shape: 'row' })
    expect(spec.tiles.slice(-2).map((t) => t.key)).toEqual(['auroraLag', 'auroraInstances'])
  })

  it('derives lag and instances, and adds a fact', () => {
    const raw = { aurora_lag_s: '0.018', aurora_instances: '3', aurora_reader: '1' }
    expect(spec.derive(raw, null, 5)).toMatchObject({ auroraLag: 0.018, auroraInstances: 3 })
    expect(spec.facts(raw).at(-1)).toEqual({ label: 'Aurora', value: 'Reader · 3 instances' })
  })
})
