import { useCallback, useEffect, useRef, useState } from 'react'
import { Network, RefreshCw, TriangleAlert } from 'lucide-react'
import { api, type ConnectionConfig } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  clusterStatusTone,
  GALERA_HINTS,
  GALERA_SQL,
  galeraRaw,
  galeraWarnings,
  localStateTone,
  parseGalera,
  type GaleraStatus,
  type GaleraTone
} from '@/lib/galera'
import { errorMessage } from '@/lib/toast'
import { Badge, Button, ErrorText } from '@/components/ui'

export interface Galera {
  /** Null until the first read, and for servers without Galera or with wsrep off */
  status: GaleraStatus | null
  error: string | null
  loading: boolean
  reload: () => void
}

/**
 * The node's Galera status, read every `refresh` seconds (0: off) once the first read finds
 * wsrep on. `enabled` gates the reads to MariaDB; a server without Galera is read once.
 */
export function useGalera(connection: ConnectionConfig, enabled: boolean, refresh: number): Galera {
  const [status, setStatus] = useState<GaleraStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const busy = useRef(false)
  const reload = useCallback(async () => {
    if (!enabled || busy.current) return
    busy.current = true
    setLoading(true)
    try {
      const out = await api.execute(connection.id, '__meta', '', GALERA_SQL, { confirmed: true })
      if (out.error) throw new Error(out.error.message)
      setStatus(parseGalera(galeraRaw(out.results)))
      setError(null)
    } catch (e) {
      // Keeps the last status; without one there's nothing to show the error in
      setError(errorMessage(e))
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [connection.id, enabled])
  useEffect(() => {
    setStatus(null)
    setError(null)
    void reload()
  }, [reload])
  const on = !!status
  useEffect(() => {
    if (!on || !refresh) return
    const timer = setInterval(() => void reload(), refresh * 1000)
    return () => clearInterval(timer)
  }, [on, refresh, reload])
  return { status, error, loading, reload: () => void reload() }
}

const TONE_TEXT: Record<GaleraTone, string> = {
  success: 'text-ok',
  warning: 'text-warn',
  danger: 'text-danger',
  neutral: 'text-bright'
}

const count = (n: number | null): string => (n == null ? '—' : n.toLocaleString())
const avg = (n: number | null): string => (n == null ? '—' : n.toFixed(n < 10 ? 2 : 0))
const onOff = (v: boolean | null): string => (v == null ? '—' : v ? 'Yes' : 'No')
const onOffTone = (v: boolean | null): GaleraTone =>
  v == null ? 'neutral' : v ? 'success' : 'danger'

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral'
}: {
  label: string
  value: string
  hint: string
  tone?: GaleraTone
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

export function Detail({
  label,
  hint,
  children
}: {
  label: string
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <dt className="cursor-help text-muted" title={hint}>
        {label}
      </dt>
      <dd className="min-w-0 truncate font-mono text-fg select-text">{children}</dd>
    </>
  )
}

/** Cluster and node state of a Galera node; render only when `galera.status` is set. */
export function GaleraPanel({ galera }: { galera: Galera }): React.JSX.Element | null {
  const s = galera.status
  if (!s) return null
  const warnings = galeraWarnings(s)
  const worst = warnings[0]?.tone
  const pausedPct = s.flowControlPaused == null ? null : s.flowControlPaused * 100
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
        <Network className="size-4 text-accent" />
        <h2 className="font-medium text-bright">Galera cluster</h2>
        {s.clusterName && <Badge>{s.clusterName}</Badge>}
        <Badge tone={clusterStatusTone(s.clusterStatus)} title={GALERA_HINTS.clusterStatus}>
          {s.clusterStatus ?? 'Unknown'}
        </Badge>
        <Badge tone={localStateTone(s.localState)} title={GALERA_HINTS.localState}>
          {s.localState ?? 'Unknown'}
        </Badge>
        <Button size="icon-sm" variant="ghost" onClick={galera.reload} title="Refresh">
          <RefreshCw className={galera.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        <span className="ml-auto text-xs text-muted">
          Hover a metric for what it means; counters run since start or FLUSH STATUS
        </span>
      </div>

      {galera.error && (
        <div className="mb-3">
          <ErrorText error={galera.error} />
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

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
        <Stat
          label="Cluster status"
          value={s.clusterStatus ?? '—'}
          hint={GALERA_HINTS.clusterStatus}
          tone={clusterStatusTone(s.clusterStatus)}
        />
        <Stat label="Cluster size" value={count(s.clusterSize)} hint={GALERA_HINTS.clusterSize} />
        <Stat
          label="Node state"
          value={s.localState ?? '—'}
          hint={GALERA_HINTS.localState}
          tone={localStateTone(s.localState)}
        />
        <Stat
          label="Ready"
          value={onOff(s.ready)}
          hint={GALERA_HINTS.ready}
          tone={onOffTone(s.ready)}
        />
        <Stat
          label="Connected"
          value={onOff(s.connected)}
          hint={GALERA_HINTS.connected}
          tone={onOffTone(s.connected)}
        />
        <Stat
          label="Last committed"
          value={count(s.lastCommitted)}
          hint={GALERA_HINTS.lastCommitted}
        />
        <Stat
          label="Flow control paused"
          value={pausedPct == null ? '—' : `${pausedPct.toFixed(pausedPct < 10 ? 2 : 0)}%`}
          hint={GALERA_HINTS.flowControlPaused}
          tone={pausedPct == null ? 'neutral' : pausedPct >= 10 ? 'warning' : 'success'}
        />
        <Stat
          label="Flow control sent"
          value={count(s.flowControlSent)}
          hint={GALERA_HINTS.flowControlSent}
        />
        <Stat
          label="Flow control received"
          value={count(s.flowControlRecv)}
          hint={GALERA_HINTS.flowControlRecv}
        />
        <Stat label="Send queue avg" value={avg(s.sendQueueAvg)} hint={GALERA_HINTS.sendQueueAvg} />
        <Stat label="Recv queue avg" value={avg(s.recvQueueAvg)} hint={GALERA_HINTS.recvQueueAvg} />
        <Stat
          label="Cert failures"
          value={count(s.certFailures)}
          hint={GALERA_HINTS.certFailures}
        />
        <Stat label="BF aborts" value={count(s.bfAborts)} hint={GALERA_HINTS.bfAborts} />
      </div>

      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
        <Detail label="Node" hint={GALERA_HINTS.node}>
          {[s.nodeName, s.nodeAddress].filter(Boolean).join(' · ') || '—'}
          {s.localIndex != null && <span className="text-faint"> · index {s.localIndex}</span>}
        </Detail>
        <Detail label="Incoming addresses" hint={GALERA_HINTS.incoming}>
          {s.incomingAddresses.join(', ') || '—'}
        </Detail>
        <Detail label="Cluster state UUID" hint={GALERA_HINTS.stateUuid}>
          {s.clusterStateUuid ?? '—'}
        </Detail>
        <Detail label="Configuration id" hint={GALERA_HINTS.confId}>
          {s.clusterConfId ?? '—'}
        </Detail>
        <Detail label="Provider" hint={GALERA_HINTS.provider}>
          {[s.providerName, s.providerVersion].filter(Boolean).join(' ') || '—'}
          {s.providerVendor && <span className="text-faint"> · {s.providerVendor}</span>}
        </Detail>
      </dl>
    </section>
  )
}
