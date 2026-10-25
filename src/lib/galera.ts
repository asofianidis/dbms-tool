/**
 * Galera cluster status for MariaDB (and Percona XtraDB Cluster) servers with wsrep on.
 * Everything comes from the node's wsrep status counters and a few wsrep variables;
 * a server without Galera has no wsrep variables, or wsrep_on = OFF.
 */
import type { ResultSet } from './api'
import {
  num,
  pairsToRaw,
  percentOf,
  rate,
  type Raw,
  type ServerDashboardSpec
} from './server-metrics'

const GALERA_VARIABLES = [
  'wsrep_on',
  'wsrep_cluster_name',
  'wsrep_cluster_address',
  'wsrep_node_name',
  'wsrep_node_address',
  'wsrep_node_incoming_address',
  'wsrep_provider'
]

/** Two result sets: every wsrep status counter, then the variables naming the node and cluster. */
export const GALERA_SQL = `SHOW GLOBAL STATUS LIKE 'wsrep%';
SHOW GLOBAL VARIABLES WHERE Variable_name IN (${GALERA_VARIABLES.map((n) => `'${n}'`).join(', ')})`

export type GaleraTone = 'success' | 'warning' | 'danger' | 'neutral'

export interface GaleraStatus {
  clusterName: string | null
  /** Primary, Non-Primary or Disconnected */
  clusterStatus: string | null
  clusterSize: number | null
  clusterStateUuid: string | null
  clusterConfId: number | null
  /** Synced, Donor/Desynced, Joining, Joined, Initialized… */
  localState: string | null
  ready: boolean | null
  connected: boolean | null
  nodeName: string | null
  nodeAddress: string | null
  /** Client addresses of every node in the component, as the cluster reports them */
  incomingAddresses: string[]
  localIndex: number | null
  providerName: string | null
  providerVersion: string | null
  providerVendor: string | null
  flowControlPaused: number | null
  flowControlSent: number | null
  flowControlRecv: number | null
  sendQueueAvg: number | null
  recvQueueAvg: number | null
  certFailures: number | null
  bfAborts: number | null
  lastCommitted: number | null
}

/** Merges the result sets of GALERA_SQL into one name → value map. */
export function galeraRaw(sets: ResultSet[]): Raw {
  return Object.assign({}, ...sets.map(pairsToRaw)) as Raw
}

const flag = (v: string | null | undefined): boolean | null =>
  v == null || v === '' ? null : /^(on|1|true|yes)$/i.test(v.trim())

const text = (v: string | null | undefined): string | null => (v?.trim() ? v.trim() : null)

/** The node's Galera status, or null when wsrep is off or the server has no wsrep variables. */
export function parseGalera(raw: Raw): GaleraStatus | null {
  if (!flag(raw.wsrep_on)) return null
  return {
    clusterName: text(raw.wsrep_cluster_name),
    clusterStatus: text(raw.wsrep_cluster_status),
    clusterSize: num(raw, 'wsrep_cluster_size'),
    clusterStateUuid: text(raw.wsrep_cluster_state_uuid),
    clusterConfId: num(raw, 'wsrep_cluster_conf_id'),
    localState: text(raw.wsrep_local_state_comment),
    ready: flag(raw.wsrep_ready),
    connected: flag(raw.wsrep_connected),
    nodeName: text(raw.wsrep_node_name),
    nodeAddress: text(raw.wsrep_node_address),
    incomingAddresses: (raw.wsrep_incoming_addresses ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    // An unsigned -1 (18446744073709551615) while the node isn't in a component
    localIndex: ((n) => (n == null || n > 1e6 ? null : n))(num(raw, 'wsrep_local_index')),
    providerName: text(raw.wsrep_provider_name),
    providerVersion: text(raw.wsrep_provider_version),
    providerVendor: text(raw.wsrep_provider_vendor),
    flowControlPaused: num(raw, 'wsrep_flow_control_paused'),
    flowControlSent: num(raw, 'wsrep_flow_control_sent'),
    flowControlRecv: num(raw, 'wsrep_flow_control_recv'),
    sendQueueAvg: num(raw, 'wsrep_local_send_queue_avg'),
    recvQueueAvg: num(raw, 'wsrep_local_recv_queue_avg'),
    certFailures: num(raw, 'wsrep_local_cert_failures'),
    bfAborts: num(raw, 'wsrep_local_bf_aborts'),
    lastCommitted: num(raw, 'wsrep_last_committed')
  }
}

export function clusterStatusTone(status: string | null): GaleraTone {
  if (!status) return 'neutral'
  return /^primary$/i.test(status) ? 'success' : 'danger'
}

export function localStateTone(state: string | null): GaleraTone {
  if (!state) return 'neutral'
  if (/^synced$/i.test(state)) return 'success'
  // Donor/Desynced, Joining, Joined: catching up or serving a state transfer
  if (/donor|desync|join/i.test(state)) return 'warning'
  return 'danger'
}

/** Fraction of time replication was paused by flow control above which it's worth flagging. */
const PAUSED_WARN = 0.1

/** Problems worth a banner, worst first. */
export function galeraWarnings(s: GaleraStatus): { tone: 'warning' | 'danger'; text: string }[] {
  const out: { tone: 'warning' | 'danger'; text: string }[] = []
  if (s.connected === false)
    out.push({
      tone: 'danger',
      text: 'This node is not connected to the cluster: check wsrep_cluster_address and the network between nodes.'
    })
  if (s.clusterStatus && clusterStatusTone(s.clusterStatus) === 'danger')
    out.push({
      tone: 'danger',
      text: `The node is in a ${s.clusterStatus} component, so it refuses queries. It lost quorum (a network split or most nodes down); once the others are back it rejoins, or bootstrap the most advanced node with pc.bootstrap=YES.`
    })
  else if (s.ready === false)
    out.push({ tone: 'danger', text: 'wsrep_ready is OFF: the node does not accept queries.' })
  const state = localStateTone(s.localState)
  if (state === 'warning' || state === 'danger')
    out.push({
      tone: state,
      text: `This node is ${s.localState}, not Synced: it is ${/donor|desync/i.test(s.localState ?? '') ? 'serving a state transfer or desynced' : 'still catching up with the cluster'}, so its data may lag.`
    })
  if (s.flowControlPaused != null && s.flowControlPaused >= PAUSED_WARN)
    out.push({
      tone: 'warning',
      text: `Replication was paused by flow control ${(s.flowControlPaused * 100).toFixed(0)}% of the time: a node cannot apply writes fast enough.`
    })
  return out
}

/** Hover text for each metric the panel shows. */
export const GALERA_HINTS = {
  clusterStatus:
    'wsrep_cluster_status: Primary means this node is in the component with quorum and serves queries; Non-Primary or Disconnected means it does not.',
  clusterSize: 'wsrep_cluster_size: how many nodes are in this node’s component right now.',
  localState:
    'wsrep_local_state_comment: Synced is normal. Donor/Desynced is sending a state transfer, Joining/Joined is receiving one or catching up.',
  ready: 'wsrep_ready: whether the node accepts queries.',
  connected: 'wsrep_connected: whether the node has a network connection to other nodes.',
  stateUuid:
    'wsrep_cluster_state_uuid: identifies the cluster’s data history; every node in sync shares it.',
  confId:
    'wsrep_cluster_conf_id: how many membership changes the cluster has seen; nodes in the same component show the same value.',
  node: 'wsrep_node_name and wsrep_node_address: this node’s name and its replication address.',
  incoming:
    'wsrep_incoming_addresses: the client addresses of every node in the component (port 0 when not configured).',
  provider: 'wsrep_provider_version: the Galera library this node replicates with.',
  flowControlPaused:
    'wsrep_flow_control_paused: share of time replication was paused because a node’s receive queue was full, since the last FLUSH STATUS. Near 0 is healthy.',
  flowControlSent:
    'wsrep_flow_control_sent: pause requests this node sent because it could not keep up applying writes.',
  flowControlRecv:
    'wsrep_flow_control_recv: pause requests received from any node, this one included.',
  sendQueueAvg:
    'wsrep_local_send_queue_avg: average length of the outgoing write-set queue; above 0 points to a slow network.',
  recvQueueAvg:
    'wsrep_local_recv_queue_avg: average length of the queue of write-sets waiting to be applied; well above 0 means this node is slow to apply.',
  certFailures:
    'wsrep_local_cert_failures: local transactions that failed certification because another node changed the same rows first.',
  bfAborts:
    'wsrep_local_bf_aborts: local transactions aborted by a replicated transaction that conflicted with them (brute-force aborts).',
  lastCommitted:
    'wsrep_last_committed: sequence number of the last transaction this node committed.'
} as const

/* ---------- Live metrics ---------- */

const LIVE_STATUS = [
  'wsrep_flow_control_paused_ns',
  'wsrep_cluster_size',
  'wsrep_local_recv_queue',
  'wsrep_local_send_queue',
  'wsrep_cluster_status',
  'wsrep_local_state_comment'
]

const extended = new WeakMap<ServerDashboardSpec, ServerDashboardSpec>()

/**
 * The live-metrics spec with Galera tiles added: the share of each interval spent paused by
 * flow control, cluster size and the replication queues. Cached so the spec keeps its identity.
 */
export function withGaleraMetrics(spec: ServerDashboardSpec): ServerDashboardSpec {
  const cached = extended.get(spec)
  if (cached) return cached
  const next: ServerDashboardSpec = {
    ...spec,
    probes: [
      ...spec.probes,
      {
        id: 'galera',
        shape: 'pairs',
        sql: `SHOW GLOBAL STATUS WHERE Variable_name IN (${LIVE_STATUS.map((n) => `'${n}'`).join(', ')})`
      }
    ],
    derive: (raw, prev, s) => ({
      ...spec.derive(raw, prev, s),
      galeraPaused: flowControlPausedPercent(raw, prev, s),
      galeraSize: num(raw, 'wsrep_cluster_size'),
      galeraRecvQueue: num(raw, 'wsrep_local_recv_queue'),
      galeraSendQueue: num(raw, 'wsrep_local_send_queue')
    }),
    tiles: [
      ...spec.tiles,
      {
        key: 'galeraPaused',
        label: 'Flow control paused',
        unit: 'percent',
        hint: 'Share of time Galera replication was paused by flow control'
      },
      {
        key: 'galeraSize',
        label: 'Cluster size',
        unit: 'count',
        hint: 'Nodes in this node’s Galera component'
      },
      {
        key: 'galeraRecvQueue',
        label: 'Recv queue',
        unit: 'count',
        hint: 'Write-sets waiting to be applied on this node'
      },
      {
        key: 'galeraSendQueue',
        label: 'Send queue',
        unit: 'count',
        hint: 'Write-sets waiting to be sent to the cluster'
      }
    ],
    facts: (raw) => {
      const base = spec.facts(raw)
      const parts = [
        raw.wsrep_cluster_status,
        raw.wsrep_local_state_comment,
        raw.wsrep_cluster_size && `${raw.wsrep_cluster_size} nodes`
      ].filter(Boolean)
      return parts.length ? [...base, { label: 'Galera', value: parts.join(' · ') }] : base
    }
  }
  extended.set(spec, next)
  return next
}

/** Percent of the interval spent paused, from the cumulative wsrep_flow_control_paused_ns. */
export function flowControlPausedPercent(
  next: Raw,
  prev: Raw | null,
  seconds: number
): number | null {
  return percentOf(rate(next, prev, seconds, 'wsrep_flow_control_paused_ns'), 1e9)
}
