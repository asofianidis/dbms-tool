import { describe, expect, it } from 'vitest'
import type { ResultSet } from '../api'
import {
  clusterStatusTone,
  flowControlPausedPercent,
  GALERA_SQL,
  galeraRaw,
  galeraWarnings,
  localStateTone,
  parseGalera,
  withGaleraMetrics
} from '../galera'
import { dashboardFor } from '../server-metrics'

const pairs = (rows: [string, string][]): ResultSet => ({
  columns: [
    { name: 'Variable_name', typeName: 'VARCHAR' },
    { name: 'Value', typeName: 'VARCHAR' }
  ],
  rows,
  rowCount: rows.length,
  truncated: false
})

// Trimmed from SHOW GLOBAL STATUS LIKE 'wsrep%' on node 1 of a 3-node MariaDB 11.8 cluster
const STATUS = pairs([
  ['wsrep_local_state_uuid', '3b5ca8e4-d070-11f1-b040-8f9d8ad07cb3'],
  ['wsrep_last_committed', '3'],
  ['wsrep_local_cert_failures', '0'],
  ['wsrep_local_send_queue_avg', '0.5'],
  ['wsrep_local_recv_queue_avg', '0'],
  ['wsrep_flow_control_paused_ns', '0'],
  ['wsrep_flow_control_paused', '0'],
  ['wsrep_flow_control_sent', '0'],
  ['wsrep_flow_control_recv', '0'],
  ['wsrep_local_state', '4'],
  ['wsrep_local_state_comment', 'Synced'],
  ['wsrep_incoming_addresses', 'mdb-galera1:0,mdb-galera2:0,mdb-galera3:0'],
  ['wsrep_cluster_conf_id', '3'],
  ['wsrep_cluster_size', '3'],
  ['wsrep_cluster_state_uuid', '3b5ca8e4-d070-11f1-b040-8f9d8ad07cb3'],
  ['wsrep_cluster_status', 'Primary'],
  ['wsrep_connected', 'ON'],
  ['wsrep_local_bf_aborts', '0'],
  ['wsrep_local_index', '0'],
  ['wsrep_provider_name', 'Galera'],
  ['wsrep_provider_vendor', 'Codership Oy <info@codership.com>'],
  ['wsrep_provider_version', '26.4.27(rf032a460)'],
  ['wsrep_ready', 'ON']
])

const VARIABLES = pairs([
  ['wsrep_cluster_address', 'gcomm://'],
  ['wsrep_cluster_name', 'test'],
  ['wsrep_node_address', 'mdb-galera1'],
  ['wsrep_node_incoming_address', 'AUTO'],
  ['wsrep_node_name', 'node1'],
  ['wsrep_on', 'ON'],
  ['wsrep_provider', '/usr/lib/galera/libgalera_smm.so']
])

// MariaDB without Galera still reports a few wsrep counters, with wsrep_on = OFF
const PLAIN_STATUS = pairs([
  ['wsrep', '0'],
  ['wsrep_cluster_size', '0'],
  ['wsrep_cluster_status', 'Disconnected'],
  ['wsrep_connected', 'OFF'],
  ['wsrep_local_index', '18446744073709551615'],
  ['wsrep_ready', 'OFF']
])

const with_ = (status: ResultSet, overrides: Record<string, string>): ResultSet =>
  pairs([
    ...status.rows.map((r) => [String(r[0]), String(r[1])] as [string, string]),
    ...Object.entries(overrides)
  ])

describe('GALERA_SQL', () => {
  it('reads every wsrep status counter and the naming variables', () => {
    expect(GALERA_SQL).toContain("SHOW GLOBAL STATUS LIKE 'wsrep%';")
    expect(GALERA_SQL).toMatch(/SHOW GLOBAL VARIABLES WHERE Variable_name IN \('wsrep_on', /)
    expect(GALERA_SQL).toContain("'wsrep_node_name'")
  })
})

describe('parseGalera', () => {
  it('parses a synced node of a healthy cluster', () => {
    const s = parseGalera(galeraRaw([STATUS, VARIABLES]))
    expect(s).toEqual({
      clusterName: 'test',
      clusterStatus: 'Primary',
      clusterSize: 3,
      clusterStateUuid: '3b5ca8e4-d070-11f1-b040-8f9d8ad07cb3',
      clusterConfId: 3,
      localState: 'Synced',
      ready: true,
      connected: true,
      nodeName: 'node1',
      nodeAddress: 'mdb-galera1',
      incomingAddresses: ['mdb-galera1:0', 'mdb-galera2:0', 'mdb-galera3:0'],
      localIndex: 0,
      providerName: 'Galera',
      providerVersion: '26.4.27(rf032a460)',
      providerVendor: 'Codership Oy <info@codership.com>',
      flowControlPaused: 0,
      flowControlSent: 0,
      flowControlRecv: 0,
      sendQueueAvg: 0.5,
      recvQueueAvg: 0,
      certFailures: 0,
      bfAborts: 0,
      lastCommitted: 3
    })
    expect(galeraWarnings(s!)).toEqual([])
  })

  it('is null when wsrep is off or the variables are missing', () => {
    const off = pairs([['wsrep_on', 'OFF']])
    expect(parseGalera(galeraRaw([PLAIN_STATUS, off]))).toBeNull()
    // MySQL has no wsrep variables at all
    expect(parseGalera(galeraRaw([pairs([]), pairs([])]))).toBeNull()
    expect(parseGalera(galeraRaw([]))).toBeNull()
  })

  it('drops the unsigned -1 local index of a node outside any component', () => {
    const status = with_(STATUS, { wsrep_local_index: '18446744073709551615' })
    expect(parseGalera(galeraRaw([status, VARIABLES]))?.localIndex).toBeNull()
  })
})

describe('health', () => {
  it('colors cluster status and node state', () => {
    expect(clusterStatusTone('Primary')).toBe('success')
    expect(clusterStatusTone('non-Primary')).toBe('danger')
    expect(clusterStatusTone('Disconnected')).toBe('danger')
    expect(clusterStatusTone(null)).toBe('neutral')
    expect(localStateTone('Synced')).toBe('success')
    expect(localStateTone('Donor/Desynced')).toBe('warning')
    expect(localStateTone('Joining: receiving State Transfer')).toBe('warning')
    expect(localStateTone('Joined')).toBe('warning')
    expect(localStateTone('Initialized')).toBe('danger')
  })

  it('warns about a node that lost quorum', () => {
    const status = with_(STATUS, {
      wsrep_cluster_status: 'non-Primary',
      wsrep_cluster_size: '1',
      wsrep_ready: 'OFF',
      wsrep_local_state_comment: 'Initialized'
    })
    const warnings = galeraWarnings(parseGalera(galeraRaw([status, VARIABLES]))!)
    expect(warnings.map((w) => w.tone)).toEqual(['danger', 'danger'])
    expect(warnings[0].text).toMatch(/non-Primary component/)
    expect(warnings[1].text).toMatch(/Initialized, not Synced/)
  })

  it('warns about a donor and heavy flow control', () => {
    const status = with_(STATUS, {
      wsrep_local_state_comment: 'Donor/Desynced',
      wsrep_flow_control_paused: '0.35'
    })
    const warnings = galeraWarnings(parseGalera(galeraRaw([status, VARIABLES]))!)
    expect(warnings.map((w) => w.tone)).toEqual(['warning', 'warning'])
    expect(warnings[0].text).toMatch(/state transfer/)
    expect(warnings[1].text).toMatch(/35% of the time/)
  })

  it('flags a disconnected node', () => {
    const status = with_(STATUS, { wsrep_connected: 'OFF', wsrep_ready: 'OFF' })
    const warnings = galeraWarnings(parseGalera(galeraRaw([status, VARIABLES]))!)
    expect(warnings[0]).toMatchObject({
      tone: 'danger',
      text: expect.stringMatching(/not connected/)
    })
  })
})

describe('live metrics', () => {
  it('turns paused nanoseconds into the share of the interval', () => {
    const prev = { wsrep_flow_control_paused_ns: '1000000000' }
    const next = { wsrep_flow_control_paused_ns: '1500000000' }
    expect(flowControlPausedPercent(next, prev, 2)).toBe(25)
    expect(flowControlPausedPercent(next, null, 0)).toBeNull()
    // A FLUSH STATUS resets the counter
    expect(flowControlPausedPercent(prev, next, 2)).toBeNull()
  })

  it('adds a probe and tiles to the MySQL spec, keeping identity', () => {
    const base = dashboardFor('mysql', false)
    const spec = withGaleraMetrics(base)
    expect(withGaleraMetrics(base)).toBe(spec)
    expect(spec.probes.map((p) => p.id)).toEqual([...base.probes.map((p) => p.id), 'galera'])
    expect(spec.tiles.slice(base.tiles.length).map((t) => t.key)).toEqual([
      'galeraPaused',
      'galeraSize',
      'galeraRecvQueue',
      'galeraSendQueue'
    ])
    const raw = {
      wsrep_flow_control_paused_ns: '100000000',
      wsrep_cluster_size: '3',
      wsrep_local_recv_queue: '2',
      wsrep_local_send_queue: '0',
      wsrep_cluster_status: 'Primary',
      wsrep_local_state_comment: 'Synced'
    }
    const point = spec.derive(raw, { ...raw, wsrep_flow_control_paused_ns: '0' }, 1)
    expect(point).toMatchObject({
      galeraPaused: 10,
      galeraSize: 3,
      galeraRecvQueue: 2,
      galeraSendQueue: 0
    })
    expect(spec.facts(raw)).toContainEqual({ label: 'Galera', value: 'Primary · Synced · 3 nodes' })
  })
})
