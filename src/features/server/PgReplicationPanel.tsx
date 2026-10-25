import { useCallback, useEffect, useRef, useState } from 'react'
import { Lock, RadioTower, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { api, type ConnectionConfig } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  dropSlotSql,
  formatLag,
  formatWalBytes,
  hasReplication,
  parseProbe,
  parseReplication,
  receiverHidden,
  REPLICATION_HINTS,
  REPLICATION_PROBE_SQL,
  replicationSql,
  replicationWarnings,
  sendersHidden,
  slotWarning,
  type Replication,
  type ReplicationSlot
} from '@/lib/pg-replication'
import { confirmProductionWrite } from '@/lib/production'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { confirm } from '@/lib/workspace'
import { Badge, Button, ErrorText } from '@/components/ui'

export interface PgReplicationState {
  /** Null until the first read, and for servers with nothing to show */
  data: Replication | null
  error: string | null
  loading: boolean
  reload: () => void
}

/**
 * Streaming replication status, read every `refresh` seconds (0: off) once the probe finds a
 * standby, a WAL sender or a slot. `enabled` gates the reads to PostgreSQL; a server that
 * doesn't replicate is probed once.
 */
export function usePgReplication(
  connection: ConnectionConfig,
  enabled: boolean,
  refresh: number
): PgReplicationState {
  const [data, setData] = useState<Replication | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const busy = useRef(false)
  const reload = useCallback(async () => {
    if (!enabled || busy.current) return
    busy.current = true
    setLoading(true)
    try {
      const probed = await api.execute(connection.id, '__meta', '', REPLICATION_PROBE_SQL, {
        confirmed: true
      })
      if (probed.error) throw new Error(probed.error.message)
      const probe = parseProbe(probed.results[0])
      if (!probe || !hasReplication(probe)) {
        setData(null)
        setError(null)
        return
      }
      const out = await api.execute(connection.id, '__meta', '', replicationSql(probe), {
        confirmed: true
      })
      if (out.error) throw new Error(out.error.message)
      setData(parseReplication(probe, out.results))
      setError(null)
    } catch (e) {
      // Keeps the last status; without one the section stays hidden (e.g. a Postgres-compatible
      // server without these views)
      setError(errorMessage(e))
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [connection.id, enabled])
  useEffect(() => {
    setData(null)
    setError(null)
    void reload()
  }, [reload])
  const on = !!data
  useEffect(() => {
    if (!on || !refresh) return
    const timer = setInterval(() => void reload(), refresh * 1000)
    return () => clearInterval(timer)
  }, [on, refresh, reload])
  return { data, error, loading, reload: () => void reload() }
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral'

const TONE_TEXT: Record<Tone, string> = {
  success: 'text-ok',
  warning: 'text-warn',
  danger: 'text-danger',
  neutral: 'text-bright'
}

const stateTone = (state: string | null): Tone =>
  !state ? 'neutral' : state === 'streaming' ? 'success' : 'warning'

const walStatusTone = (status: string | null): Tone =>
  !status
    ? 'neutral'
    : status === 'lost' || status === 'unreserved'
      ? 'danger'
      : status === 'extended'
        ? 'warning'
        : 'success'

function Stat({
  label,
  value,
  hint,
  tone = 'neutral'
}: {
  label: string
  value: string
  hint: string
  tone?: Tone
}): React.JSX.Element {
  return (
    <div className="cursor-help rounded-md border border-line bg-panel/70 px-3 py-2" title={hint}>
      <p className="text-[11px] text-muted">{label}</p>
      <p className={cn('mt-0.5 truncate text-[14px] font-medium tabular-nums', TONE_TEXT[tone])}>
        {value}
      </p>
    </div>
  )
}

function Th({ children, hint }: { children: React.ReactNode; hint?: string }): React.JSX.Element {
  return (
    <th
      className={cn('px-2 py-1.5 text-left font-medium whitespace-nowrap', hint && 'cursor-help')}
      title={hint}
    >
      {children}
    </th>
  )
}

const td = 'px-2 py-1.5 whitespace-nowrap'
const mono = 'font-mono text-[11.5px] select-text'

function MonitorNote(): React.JSX.Element {
  return (
    <p
      className="flex items-center gap-1.5 rounded-md bg-warn/10 px-3 py-2 text-xs text-warn"
      title={REPLICATION_HINTS.monitor}
    >
      <Lock className="size-3.5 shrink-0" />
      Positions and lag are hidden: this needs a superuser or a member of pg_monitor
      (pg_read_all_stats).
    </p>
  )
}

/** Streaming replication of a PostgreSQL server; render only when `replication.data` is set. */
export function PgReplicationPanel({
  connection,
  replication
}: {
  connection: ConnectionConfig
  replication: PgReplicationState
}): React.JSX.Element | null {
  const r = replication.data
  if (!r) return null
  const warnings = replicationWarnings(r)
  const worst = warnings[0]?.tone
  const rx = r.receiver

  const drop = async (slot: ReplicationSlot): Promise<void> => {
    const sql = dropSlotSql(slot.name)
    const ok = await confirm({
      title: `Drop replication slot ${slot.name}?`,
      message: `The ${slot.type ?? ''} slot is removed and the WAL it holds back (${formatWalBytes(slot.retainedBytes)}) can be recycled. Whatever consumes it, ${slot.type === 'logical' ? 'a logical subscriber or CDC tool' : 'a standby'}, can no longer resume from it and has to be resynchronized from scratch. This can't be undone.`,
      code: sql,
      confirmLabel: 'Drop slot',
      danger: true,
      typeToConfirm: slot.name
    })
    if (!ok) return
    // A SELECT isn't caught by the write guard, so production is asked explicitly
    const allowed = await confirmProductionWrite(connection, {
      action: 'This drops a replication slot',
      dangers: [`dropping replication slot ${slot.name}`],
      code: sql
    })
    if (!allowed) return
    try {
      const out = await api.execute(connection.id, '__meta', '', sql, { confirmed: true })
      if (out.error) throw new Error(out.error.message)
      toast(`Dropped replication slot ${slot.name}`)
    } catch (e) {
      toastError(e)
    }
    replication.reload()
  }

  return (
    <section
      className={cn(
        'rounded-lg border p-4',
        worst === 'danger'
          ? 'border-danger/30 bg-danger/[0.03]'
          : worst === 'warning'
            ? 'border-warn/30 bg-warn/[0.03]'
            : 'border-line bg-panel/40'
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <RadioTower className="size-4 text-accent" />
        <h2 className="font-medium text-bright">Replication</h2>
        <Badge tone={r.probe.standby ? 'warning' : 'success'}>
          {r.probe.standby ? 'Standby' : 'Primary'}
        </Badge>
        {r.senders.length > 0 && (
          <Badge>
            {r.senders.length} WAL sender{r.senders.length === 1 ? '' : 's'}
          </Badge>
        )}
        <Button size="icon-sm" variant="ghost" onClick={replication.reload} title="Refresh">
          <RefreshCw className={replication.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        <span className="ml-auto text-xs text-muted">Hover a column for what it means</span>
      </div>

      {replication.error && (
        <div className="mb-3">
          <ErrorText error={replication.error} />
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="mb-3 space-y-1.5">
          {warnings.map((w) => (
            <li
              key={w.text}
              className={cn(
                'flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-relaxed',
                w.tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-warn/10 text-warn'
              )}
            >
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {w.text}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-4">
        {rx && (
          <div>
            <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
              Receiving from{' '}
              <span className="font-mono normal-case">
                {[rx.senderHost, rx.senderPort].filter(Boolean).join(':') || 'primary'}
              </span>
            </h3>
            {receiverHidden(r) && (
              <div className="mb-2">
                <MonitorNote />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
              <Stat
                label="Receiver"
                value={rx.status ?? (receiverHidden(r) ? 'Hidden' : 'Not running')}
                hint={REPLICATION_HINTS.receiverStatus}
                tone={receiverHidden(r) ? 'neutral' : rx.status ? stateTone(rx.status) : 'danger'}
              />
              <Stat
                label="Received LSN"
                value={rx.receivedLsn ?? '—'}
                hint={REPLICATION_HINTS.lsn}
              />
              <Stat
                label="Replayed LSN"
                value={rx.replayedLsn ?? '—'}
                hint={REPLICATION_HINTS.lsn}
              />
              <Stat
                label="To replay"
                value={formatWalBytes(rx.replayBehindBytes)}
                hint={REPLICATION_HINTS.replayBehind}
              />
              <Stat
                label="Replay lag"
                value={formatLag(rx.replayLag)}
                hint={REPLICATION_HINTS.replayLag}
              />
              <Stat
                label="Replay"
                value={rx.paused == null ? '—' : rx.paused ? 'Paused' : 'Running'}
                hint={REPLICATION_HINTS.paused}
                tone={rx.paused == null ? 'neutral' : rx.paused ? 'warning' : 'success'}
              />
            </div>
            {rx.slotName && (
              <p className="mt-2 text-[12px] text-muted">
                Using slot <span className="font-mono text-fg">{rx.slotName}</span> on the primary
              </p>
            )}
          </div>
        )}

        {r.senders.length > 0 && (
          <div>
            <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
              Sending to
            </h3>
            {sendersHidden(r) && (
              <div className="mb-2">
                <MonitorNote />
              </div>
            )}
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full text-[12px]">
                <thead className="bg-panel/70 text-muted">
                  <tr>
                    <Th>Application</Th>
                    <Th>Client</Th>
                    <Th hint={REPLICATION_HINTS.state}>State</Th>
                    <Th hint={REPLICATION_HINTS.syncState}>Sync</Th>
                    <Th>Slot</Th>
                    <Th hint={REPLICATION_HINTS.lsn}>Sent / write / flush / replay LSN</Th>
                    <Th hint={REPLICATION_HINTS.lag}>Write / flush / replay lag</Th>
                    <Th hint={REPLICATION_HINTS.behind}>Behind</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.senders.map((s) => (
                    <tr key={s.pid ?? s.applicationName} className="border-t border-line">
                      <td className={td}>
                        <span className="text-bright">{s.applicationName || '—'}</span>
                        {s.user && <span className="text-faint"> · {s.user}</span>}
                      </td>
                      <td className={cn(td, mono)}>{s.clientAddr ?? '—'}</td>
                      <td className={cn(td, TONE_TEXT[stateTone(s.state)])}>{s.state ?? '—'}</td>
                      <td className={td}>{s.syncState ?? '—'}</td>
                      <td className={td}>
                        {s.slotName ? (
                          <>
                            <span className="font-mono">{s.slotName}</span>
                            {s.slotType && <span className="text-faint"> · {s.slotType}</span>}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={cn(td, mono)}>
                        {[s.sentLsn, s.writeLsn, s.flushLsn, s.replayLsn]
                          .map((l) => l ?? '—')
                          .join(' / ')}
                      </td>
                      <td className={cn(td, 'tabular-nums')}>
                        {[s.writeLag, s.flushLag, s.replayLag].map(formatLag).join(' / ')}
                      </td>
                      <td className={cn(td, 'tabular-nums')}>{formatWalBytes(s.behindBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {r.slots.length > 0 && (
          <div>
            <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
              Replication slots
            </h3>
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full text-[12px]">
                <thead className="bg-panel/70 text-muted">
                  <tr>
                    <Th>Slot</Th>
                    <Th>Type</Th>
                    <Th>Plugin / database</Th>
                    <Th>Active</Th>
                    <Th hint={REPLICATION_HINTS.retained}>Retained WAL</Th>
                    <Th hint={REPLICATION_HINTS.walStatus}>WAL status</Th>
                    <Th hint={REPLICATION_HINTS.safeWalSize}>Safe WAL size</Th>
                    <Th hint={REPLICATION_HINTS.inactiveSince}>Inactive since</Th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {r.slots.map((slot) => {
                    const warning = slotWarning(slot)
                    return (
                      <tr key={slot.name} className="border-t border-line">
                        <td className={cn(td, 'font-mono text-bright select-text')}>
                          {warning && (
                            <TriangleAlert
                              className={cn(
                                'mr-1 inline size-3.5 align-[-2px]',
                                warning.tone === 'danger' ? 'text-danger' : 'text-warn'
                              )}
                            />
                          )}
                          {slot.name}
                          {slot.temporary && <span className="text-faint"> · temporary</span>}
                        </td>
                        <td className={td}>{slot.type ?? '—'}</td>
                        <td className={td}>
                          {[slot.plugin, slot.database].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className={cn(td, slot.active ? 'text-ok' : 'text-muted')}>
                          {slot.active
                            ? `Yes${slot.activePid ? ` (pid ${slot.activePid})` : ''}`
                            : 'No'}
                        </td>
                        <td
                          className={cn(
                            td,
                            'tabular-nums',
                            warning?.tone === 'warning' && 'text-warn'
                          )}
                        >
                          {formatWalBytes(slot.retainedBytes)}
                        </td>
                        <td className={cn(td, TONE_TEXT[walStatusTone(slot.walStatus)])}>
                          {slot.walStatus ?? '—'}
                          {slot.invalidationReason && (
                            <span className="text-faint"> · {slot.invalidationReason}</span>
                          )}
                        </td>
                        <td className={cn(td, 'tabular-nums')}>
                          {slot.safeWalSize != null
                            ? formatWalBytes(slot.safeWalSize)
                            : slot.walStatus && slot.walStatus !== 'lost'
                              ? 'Unlimited'
                              : '—'}
                        </td>
                        <td className={cn(td, 'text-muted')}>
                          {slot.inactiveSince?.replace(/\.\d+/, '') ?? '—'}
                        </td>
                        <td className={cn(td, 'text-right')}>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => void drop(slot)}
                            disabled={connection.readOnly || slot.active}
                            title={
                              connection.readOnly
                                ? 'This connection is read-only'
                                : slot.active
                                  ? 'A slot in use can’t be dropped; stop its consumer first'
                                  : 'Drop this slot'
                            }
                          >
                            <Trash2 className="size-3.5" /> Drop slot
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
