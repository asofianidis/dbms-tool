import { useCallback, useEffect, useRef, useState } from 'react'
import { Layers, RefreshCw, TriangleAlert } from 'lucide-react'
import { api, type ConnectionConfig, type ResultSet } from '@/lib/api'
import {
  AURORA_DETECT_SQL,
  AURORA_GLOBAL_SQL,
  AURORA_HINTS,
  auroraFunctions,
  auroraStatusSql,
  auroraWarnings,
  formatMs,
  lagTone,
  maxReaderLag,
  parseAurora,
  type AuroraFunction,
  type AuroraStatus
} from '@/lib/aurora'
import { cn } from '@/lib/cn'
import { errorMessage } from '@/lib/toast'
import { Badge, Button, ErrorText } from '@/components/ui'
import { Detail, Stat } from './GaleraPanel'

export interface Aurora {
  /** Null until the first read, and for servers that aren't Aurora */
  status: AuroraStatus | null
  error: string | null
  loading: boolean
  reload: () => void
}

/**
 * The Aurora cluster status, read every `refresh` seconds (0: off) once the first read finds
 * the aurora_* functions. `enabled` gates the reads to PostgreSQL; other servers are probed once.
 */
export function useAurora(connection: ConnectionConfig, enabled: boolean, refresh: number): Aurora {
  const [status, setStatus] = useState<AuroraStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const busy = useRef(false)
  // Undefined until detected; null when the server isn't Aurora
  const fns = useRef<Set<AuroraFunction> | null | undefined>(undefined)
  const run = useCallback(
    async (sql: string): Promise<ResultSet[]> => {
      const out = await api.execute(connection.id, '__meta', '', sql, { confirmed: true })
      if (out.error) throw new Error(out.error.message)
      return out.results
    },
    [connection.id]
  )
  const reload = useCallback(async () => {
    if (!enabled || busy.current) return
    busy.current = true
    setLoading(true)
    try {
      if (fns.current === undefined)
        fns.current = auroraFunctions((await run(AURORA_DETECT_SQL))[0])
      const found = fns.current
      if (!found) return
      const sets = await run(auroraStatusSql(found))
      // Only a global database's members can always read it; a failure just hides the regions
      const global = found.has('aurora_global_db_status')
        ? await run(AURORA_GLOBAL_SQL).then(
            (r) => r[0],
            () => undefined
          )
        : undefined
      setStatus(parseAurora(sets, global))
      setError(null)
    } catch (e) {
      // Keeps the last status; without one there's nothing to show the error in
      setError(errorMessage(e))
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [enabled, run])
  useEffect(() => {
    fns.current = undefined
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

const count = (n: number | null): string => (n == null ? '—' : n.toLocaleString())

/** Writer, readers and global-database regions of an Aurora cluster; render only when `aurora.status` is set. */
export function AuroraPanel({ aurora }: { aurora: Aurora }): React.JSX.Element | null {
  const s = aurora.status
  if (!s) return null
  const warnings = auroraWarnings(s)
  const worst = warnings[0]?.tone
  const instances = s.instances ?? []
  const readers = instances.filter((i) => !i.writer).length
  const maxLag = maxReaderLag(s)
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
        <Layers className="size-4 text-accent" />
        <h2 className="font-medium text-bright">Aurora cluster</h2>
        {s.version && <Badge title={AURORA_HINTS.version}>Aurora {s.version}</Badge>}
        <Badge tone={s.role === 'writer' ? 'success' : 'info'} title={AURORA_HINTS.role}>
          Connected to {s.role}
        </Badge>
        <Button size="icon-sm" variant="ghost" onClick={aurora.reload} title="Refresh">
          <RefreshCw className={aurora.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        <span className="ml-auto text-xs text-muted">Hover a metric for what it means</span>
      </div>

      {aurora.error && (
        <div className="mb-3">
          <ErrorText error={aurora.error} />
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

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Instance" value={s.instanceId ?? '—'} hint={AURORA_HINTS.instanceId} />
        <Stat
          label="Role"
          value={s.role === 'writer' ? 'Writer' : 'Reader'}
          hint={AURORA_HINTS.role}
        />
        <Stat
          label="Instances"
          value={
            s.instances
              ? `${instances.length} (${readers} ${readers === 1 ? 'reader' : 'readers'})`
              : '—'
          }
          hint={AURORA_HINTS.instances}
        />
        <Stat
          label="Max replica lag"
          value={formatMs(maxLag)}
          hint={AURORA_HINTS.maxLag}
          tone={lagTone(maxLag)}
        />
      </div>

      {instances.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-md border border-line">
          <table className="w-full text-[12px]">
            <thead className="bg-panel/70 text-left text-[11px] text-muted">
              <tr>
                <th className="px-3 py-1.5 font-normal">Instance</th>
                <th className="px-3 py-1.5 font-normal">Role</th>
                <th
                  className="cursor-help px-3 py-1.5 text-right font-normal"
                  title={AURORA_HINTS.lag}
                >
                  Lag
                </th>
                <th
                  className="cursor-help px-3 py-1.5 text-right font-normal"
                  title={AURORA_HINTS.replay}
                >
                  Replay latency
                </th>
                <th
                  className="cursor-help px-3 py-1.5 text-right font-normal"
                  title={AURORA_HINTS.activeTxns}
                >
                  Active txns
                </th>
                <th
                  className="cursor-help px-3 py-1.5 text-right font-normal"
                  title={AURORA_HINTS.cpu}
                >
                  CPU
                </th>
                <th
                  className="cursor-help px-3 py-1.5 text-right font-normal"
                  title={AURORA_HINTS.updated}
                >
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {instances.map((i) => (
                <tr key={i.serverId} className="border-t border-line tabular-nums">
                  <td className="px-3 py-1.5 font-mono text-fg select-text">
                    {i.serverId}
                    {i.self && <span className="ml-2 text-faint">(this connection)</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    <Badge tone={i.writer ? 'success' : 'info'}>
                      {i.writer ? 'Writer' : 'Reader'}
                    </Badge>
                  </td>
                  <td
                    className={cn(
                      'px-3 py-1.5 text-right',
                      i.writer
                        ? 'text-faint'
                        : {
                            success: 'text-ok',
                            warning: 'text-warn',
                            danger: 'text-danger',
                            neutral: 'text-fg'
                          }[lagTone(i.lagMs)]
                    )}
                  >
                    {i.writer ? '—' : formatMs(i.lagMs)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-fg">
                    {i.replayLatencyUs == null ? '—' : formatMs(i.replayLatencyUs / 1000)}
                  </td>
                  <td className="px-3 py-1.5 text-right text-fg">{count(i.activeTxns)}</td>
                  <td className="px-3 py-1.5 text-right text-fg">
                    {i.cpu == null ? '—' : `${i.cpu.toFixed(i.cpu < 10 ? 1 : 0)}%`}
                  </td>
                  <td className="px-3 py-1.5 text-right text-muted">
                    {i.updateAgeS == null ? '—' : `${Math.round(i.updateAgeS)}s ago`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {s.regions.length > 0 && (
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
          {s.regions.map((r) => (
            <Detail key={r.region} label={r.region} hint={AURORA_HINTS.durabilityLag}>
              {r.durabilityLagMs == null
                ? 'primary region'
                : `${formatMs(r.durabilityLagMs)} behind · RPO lag ${formatMs(r.rpoLagMs)}`}
            </Detail>
          ))}
        </dl>
      )}
    </section>
  )
}
