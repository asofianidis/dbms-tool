import { useCallback, useEffect, useRef, useState } from 'react'
import { MoreHorizontal, Network, Play, RefreshCw, Square } from 'lucide-react'
import { api, type ConnectionConfig, type ResultSet, type ServerInfo } from '@/lib/api'
import { cn } from '@/lib/cn'
import { plural } from '@/lib/format'
import { isMariaDb } from '@/lib/mariadb'
import {
  channelHealth,
  connectedReplicas,
  formatLag,
  LAG_WARNING_SECONDS,
  parseBinlogStatus,
  parseDumpThreads,
  parseReplicaHosts,
  parseReplicaStatus,
  parseReplicationVars,
  replicaActionSql,
  replicationPrivilegeHint,
  replicationQueries,
  type ReplicaAction,
  type ReplicaChannel,
  type ReplicaThread,
  type ReplicationError,
  type ReplicationQueries,
  type ThreadState
} from '@/lib/replication'
import type { RefreshInterval } from '@/lib/server-perf'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { confirm } from '@/lib/workspace'
import { showContextMenu, showMenuAt, type MenuItem } from '@/components/ContextMenu'
import { Badge, Button, ErrorText } from '@/components/ui'
import { SectionHeading } from './PerformancePanels'

type Part = { set: ResultSet | null; error: string | null }
type Parts = Record<keyof ReplicationQueries, Part>

/** Runs every status statement on the metadata session; one refused statement doesn't hide the rest. */
function useReplication(
  connection: ConnectionConfig,
  queries: ReplicationQueries
): { parts: Parts | null; loading: boolean; reload: () => Promise<void> } {
  const [parts, setParts] = useState<Parts | null>(null)
  const [loading, setLoading] = useState(false)
  const busy = useRef(false)
  const key = JSON.stringify(queries)
  const reload = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    try {
      const entries = await Promise.all(
        Object.entries(JSON.parse(key) as ReplicationQueries).map(async ([name, sql]) => {
          try {
            // Status listings only, so no production prompt
            const out = await api.execute(connection.id, '__meta', '', sql, { confirmed: true })
            const part: Part = out.error
              ? { set: null, error: out.error.message }
              : { set: out.results[out.results.length - 1] ?? null, error: null }
            return [name, part] as const
          } catch (e) {
            return [name, { set: null, error: errorMessage(e) }] as const
          }
        })
      )
      setParts(Object.fromEntries(entries) as Parts)
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [connection.id, key])
  useEffect(() => {
    void reload()
  }, [reload])
  return { parts, loading, reload }
}

const THREAD: Record<
  ThreadState,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  running: { label: 'Running', tone: 'success' },
  connecting: { label: 'Connecting', tone: 'warning' },
  stopped: { label: 'Stopped', tone: 'danger' },
  unknown: { label: 'Unknown', tone: 'neutral' }
}

function ThreadBadge({
  thread,
  state
}: {
  thread: 'IO' | 'SQL'
  state: ThreadState
}): React.JSX.Element {
  const t = THREAD[state]
  return (
    <Badge tone={t.tone} title={`${thread} thread: ${t.label.toLowerCase()}`}>
      {thread} {t.label}
    </Badge>
  )
}

function Item({
  label,
  value,
  mono = true,
  wide
}: {
  label: string
  value: string | null
  mono?: boolean
  wide?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('min-w-0', wide && 'col-span-full')}>
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd
        className={cn('truncate text-[12px] text-fg select-text', mono && 'font-mono')}
        title={value ?? undefined}
      >
        {value || '—'}
      </dd>
    </div>
  )
}

const position = (file: string | null, pos: string | null): string | null =>
  file ? `${file}${pos ? `:${pos}` : ''}` : null

function ErrorBox({
  kind,
  error
}: {
  kind: 'IO' | 'SQL'
  error: ReplicationError
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-danger/25 bg-danger/[0.05] px-3 py-2 text-[12px]">
      <p className="font-medium text-danger">
        Last {kind} error {error.number || ''}
        {error.at && <span className="ml-2 font-normal text-muted">{error.at}</span>}
      </p>
      <p className="mt-0.5 font-mono text-[11.5px] break-words whitespace-pre-wrap text-fg select-text">
        {error.message}
      </p>
    </div>
  )
}

/**
 * Replication on a MySQL or MariaDB server: each channel (MariaDB connection) it replicates
 * from, and the replicas reading its binary log. Right-click a channel to start or stop it.
 */
export function ReplicationPanel({
  connection,
  info,
  refresh,
  active
}: {
  connection: ConnectionConfig
  info: ServerInfo | null
  refresh: RefreshInterval
  active: boolean
}): React.JSX.Element | null {
  const mariadb = isMariaDb(info)
  const queries = replicationQueries(info)
  const { parts, loading, reload } = useReplication(connection, queries)

  // Follows the activity list's auto-refresh; a tick during a refresh is skipped by the hook
  const reloadRef = useRef(reload)
  reloadRef.current = reload
  useEffect(() => {
    if (!refresh || !active) return
    const timer = setInterval(() => void reloadRef.current(), refresh * 1000)
    return () => clearInterval(timer)
  }, [refresh, active])

  if (!parts) return null
  const channels = parseReplicaStatus(parts.replicas.set)
  const vars = parseReplicationVars(parts.variables.set)
  const binlog = parseBinlogStatus(parts.binlog.set)
  const hosts = parseReplicaHosts(parts.hosts.set)
  const dumps = parseDumpThreads(parts.dumps.set)
  const replicaHint = parts.replicas.error
    ? replicationPrivilegeHint(parts.replicas.error, mariadb)
    : null
  const isPrimary = hosts.length > 0 || dumps.length > 0
  const noun = mariadb ? 'connection' : 'channel'
  const label = (c: ReplicaChannel): string =>
    c.name ? `${noun} '${c.name}'` : `the default ${noun}`

  const act = async (
    action: ReplicaAction,
    channel: ReplicaChannel | null,
    thread: ReplicaThread = 'all'
  ): Promise<void> => {
    const sql = replicaActionSql(info, action, channel ? channel.name : null, thread)
    const what = channel ? label(channel) : `all ${noun}s`
    const threads =
      thread === 'io' ? 'the IO thread of ' : thread === 'sql' ? 'the SQL thread of ' : ''
    const ok = await confirm({
      title: `${action === 'start' ? 'Start' : 'Stop'} ${threads}${what}?`,
      message:
        action === 'stop'
          ? thread === 'io'
            ? 'The replica stops receiving events from the source; it applies what it already has.'
            : 'The replica stops applying changes until it is started again, so it falls behind the source.'
          : 'The replica resumes from where it stopped and catches up with the source.',
      code: sql,
      confirmLabel: action === 'start' ? 'Start' : 'Stop',
      danger: action === 'stop'
    })
    if (!ok) return
    try {
      const out = await api.execute(connection.id, '__meta', '', sql)
      if (out.error) throw new Error(out.error.message)
      toast(`${action === 'start' ? 'Started' : 'Stopped'} ${threads}${what}`)
    } catch (e) {
      toastError(e)
    }
    void reload()
  }

  const channelMenu = (c: ReplicaChannel): MenuItem[] => {
    const disabled = connection.readOnly
    const running = c.io !== 'stopped' || c.sql !== 'stopped'
    const item = (
      action: ReplicaAction,
      thread: ReplicaThread,
      labelText: string,
      off: boolean
    ): MenuItem => ({
      label: labelText,
      icon: action === 'start' ? <Play /> : <Square />,
      danger: action === 'stop',
      disabled: disabled || off,
      onSelect: () => void act(action, c, thread)
    })
    return [
      { heading: c.name ? `${mariadb ? 'Connection' : 'Channel'} ${c.name}` : `Default ${noun}` },
      item('start', 'all', 'Start replica', c.io !== 'stopped' && c.sql !== 'stopped'),
      item('stop', 'all', 'Stop replica', !running),
      'separator',
      item('start', 'io', 'Start IO thread', c.io !== 'stopped'),
      item('stop', 'io', 'Stop IO thread', c.io === 'stopped'),
      item('start', 'sql', 'Start SQL thread', c.sql !== 'stopped'),
      item('stop', 'sql', 'Stop SQL thread', c.sql === 'stopped')
    ]
  }

  const allMenu = (): MenuItem[] => [
    { heading: `All ${noun}s` },
    {
      label: mariadb ? 'Start all replicas' : 'Start all channels',
      icon: <Play />,
      disabled: connection.readOnly,
      onSelect: () => void act('start', null)
    },
    {
      label: mariadb ? 'Stop all replicas' : 'Stop all channels',
      icon: <Square />,
      danger: true,
      disabled: connection.readOnly,
      onSelect: () => void act('stop', null)
    }
  ]

  const errored = channels.filter((c) => channelHealth(c) === 'error').length
  const binlogText = binlog
    ? `${binlog.file}:${binlog.position ?? '?'}${vars?.binlogFormat ? ` (${vars.binlogFormat})` : ''}`
    : null

  return (
    <section>
      <SectionHeading icon={<Network className="size-3.5" />} title="Replication">
        <Button size="icon-sm" variant="ghost" onClick={() => void reload()} title="Refresh">
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        {channels.length > 0 && (
          <Badge tone={errored ? 'danger' : 'info'} className="normal-case">
            Replica of {plural(channels.length, 'source')}
            {errored > 0 && ` · ${errored} failing`}
          </Badge>
        )}
        {isPrimary && (
          <Badge tone="success" className="normal-case">
            Primary · {plural(Math.max(hosts.length, dumps.length), 'replica')}
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-2 text-[11px] font-normal tracking-normal normal-case">
          {channels.length > 0 && (
            <span className="text-faint">Right-click a {noun} to start or stop it</span>
          )}
          {channels.length > 1 && (
            <Button
              size="icon-sm"
              variant="ghost"
              title={`Start or stop all ${noun}s`}
              onClick={(e) => showMenuAt(e.currentTarget, allMenu())}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          )}
        </span>
      </SectionHeading>

      <div className="space-y-3">
        {/* A missing privilege is common on ordinary accounts, so it gets one quiet line */}
        {parts.replicas.error &&
          (replicaHint ? (
            <p
              className="rounded-lg border border-line bg-panel/70 px-4 py-3 text-xs text-muted"
              title={parts.replicas.error}
            >
              Can&apos;t tell whether this server is a replica. {replicaHint}
            </p>
          ) : (
            <div className="rounded-lg border border-line bg-panel/70 p-4">
              <ErrorText error={parts.replicas.error} />
            </div>
          ))}

        {channels.map((c) => {
          const health = channelHealth(c)
          return (
            <div
              key={c.name}
              className="rounded-lg border border-line bg-panel/70 p-3"
              onContextMenu={(e) => showContextMenu(e, channelMenu(c))}
            >
              <div className="mb-2.5 flex flex-wrap items-center gap-2 text-[12px]">
                <span
                  className={cn(
                    'size-2 shrink-0 rounded-full',
                    health === 'ok' ? 'bg-ok' : health === 'warning' ? 'bg-warn' : 'bg-danger'
                  )}
                />
                <span className="font-mono font-medium text-bright">
                  {c.name || <span className="font-sans text-muted italic">default {noun}</span>}
                </span>
                <span className="text-muted">
                  from{' '}
                  <span className="font-mono text-fg select-text">
                    {c.sourceHost ?? '?'}
                    {c.sourcePort ? `:${c.sourcePort}` : ''}
                  </span>
                  {c.sourceUser && <span className="text-faint"> as {c.sourceUser}</span>}
                </span>
                <ThreadBadge thread="IO" state={c.io} />
                <ThreadBadge thread="SQL" state={c.sql} />
                <Badge
                  tone={
                    c.lagSeconds !== null &&
                    c.lagSeconds - (c.delaySeconds ?? 0) >= LAG_WARNING_SECONDS
                      ? 'warning'
                      : 'neutral'
                  }
                  title={mariadb ? 'Seconds_Behind_Master' : 'Seconds_Behind_Source'}
                >
                  Lag {formatLag(c.lagSeconds)}
                </Badge>
                {!!c.delaySeconds && (
                  <Badge title="Configured replication delay">
                    Delay {formatLag(c.delaySeconds)}
                  </Badge>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="ml-auto"
                  title={`Start or stop this ${noun}`}
                  onClick={(e) => showMenuAt(e.currentTarget, channelMenu(c))}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </div>
              <dl className="grid grid-cols-3 gap-x-4 gap-y-2">
                <Item label="IO thread" value={c.ioState} mono={false} />
                <Item label="SQL thread" value={c.sqlState} mono={false} />
                <Item label="Using GTID" value={c.usingGtid} />
                <Item label="Read up to" value={position(c.sourceLogFile, c.readSourceLogPos)} />
                <Item
                  label="Executed up to"
                  value={position(c.relaySourceLogFile, c.execSourceLogPos)}
                />
                <Item label="Relay log" value={position(c.relayLogFile, c.relayLogPos)} />
                {mariadb ? (
                  <Item label="Gtid_IO_Pos" value={c.gtidIoPos} wide />
                ) : (
                  <>
                    <Item label="Retrieved GTID set" value={c.retrievedGtidSet} wide />
                    <Item label="Executed GTID set" value={c.executedGtidSet} wide />
                  </>
                )}
              </dl>
              {(c.ioError || c.sqlError) && (
                <div className="mt-2.5 space-y-2">
                  {c.ioError && <ErrorBox kind="IO" error={c.ioError} />}
                  {c.sqlError && <ErrorBox kind="SQL" error={c.sqlError} />}
                </div>
              )}
            </div>
          )
        })}

        {mariadb && channels.length > 0 && vars && (
          <dl className="grid grid-cols-3 gap-x-4 gap-y-2 rounded-lg border border-line bg-panel/70 px-3 py-2.5">
            <Item label="@@gtid_slave_pos" value={vars.gtidSlavePos} />
            <Item label="@@gtid_current_pos" value={vars.gtidCurrentPos} />
            <Item label="@@gtid_binlog_pos" value={vars.gtidBinlogPos} />
          </dl>
        )}

        {isPrimary ? (
          <div className="rounded-lg border border-line bg-panel/70 p-3">
            <dl className="mb-3 grid grid-cols-3 gap-x-4 gap-y-2">
              <Item label="Binary log" value={binlogText} />
              <Item label="Server ID" value={vars?.serverId ?? null} />
              {mariadb ? (
                <Item label="@@gtid_binlog_pos" value={vars?.gtidBinlogPos ?? null} />
              ) : (
                <Item
                  label={`GTID mode ${vars?.gtidMode ?? ''}`.trim()}
                  value={binlog?.executedGtidSet ?? vars?.gtidExecuted ?? null}
                />
              )}
            </dl>
            <table className="w-full text-[12px]">
              <thead className="border-b border-line">
                <tr>
                  {['Replica', 'Server ID', 'Dump thread', 'Connected', 'State'].map((h) => (
                    <th
                      key={h}
                      className="px-2 py-1.5 text-left text-[11px] font-medium text-muted"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {connectedReplicas(hosts, dumps).map((r, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    <td className="px-2 py-1.5 font-mono text-bright select-text">{r.host}</td>
                    <td className="px-2 py-1.5 tabular-nums">{r.serverId ?? '—'}</td>
                    <td className="px-2 py-1.5 font-mono">{r.thread ?? '—'}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {r.seconds !== null ? formatLag(r.seconds) : '—'}
                    </td>
                    <td className="truncate px-2 py-1.5 text-muted" title={r.state ?? undefined}>
                      {r.state ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parts.hosts.error && (
              <p className="mt-2 text-[11px] text-faint">
                Registered replicas unavailable:{' '}
                {replicationPrivilegeHint(parts.hosts.error, mariadb) ?? parts.hosts.error}
              </p>
            )}
          </div>
        ) : (
          channels.length === 0 &&
          !parts.replicas.error && (
            <p className="rounded-lg border border-line bg-panel/70 px-4 py-3 text-xs text-muted">
              Not a replica, and no replicas are connected.{' '}
              {vars && !vars.logBin
                ? 'Binary logging is off.'
                : binlogText
                  ? `Binary log at ${binlogText}.`
                  : ''}
            </p>
          )
        )}
      </div>
    </section>
  )
}
