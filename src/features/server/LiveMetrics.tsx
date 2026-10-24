import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Gauge, Pause, Play, Server } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  collect,
  formatMetric,
  formatUptime,
  type Collected,
  type MeterSpec,
  type MetricSpec,
  type Point,
  type Raw,
  type ServerDashboardSpec
} from '@/lib/server-metrics'
import { Badge, Button, ErrorText, Segmented, Spinner } from '@/components/ui'

const INTERVALS = ['2', '5', '10', '30'] as const
type Interval = (typeof INTERVALS)[number]
/** Samples kept per metric: 5 minutes at the default 2s interval */
const HISTORY = 150

interface Sample {
  at: number
  point: Point
}

interface LiveState {
  samples: Sample[]
  raw: Raw | null
  errors: Collected['errors']
  /** Every probe failed on the last poll */
  failed: boolean
  fetching: boolean
}

function useLiveMetrics(
  connectionId: string,
  session: string,
  spec: ServerDashboardSpec,
  intervalMs: number,
  running: boolean
): LiveState {
  const [state, setState] = useState<LiveState>({
    samples: [],
    raw: null,
    errors: [],
    failed: false,
    fetching: false
  })
  const prev = useRef<{ raw: Raw; at: number } | null>(null)

  useEffect(() => {
    prev.current = null
    setState({ samples: [], raw: null, errors: [], failed: false, fetching: false })
  }, [connectionId, spec])

  useEffect(() => {
    if (!running) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      const started = Date.now()
      setState((s) => ({ ...s, fetching: true }))
      const { raw, errors } = await collect(connectionId, session, spec)
      if (cancelled) return
      const at = Date.now()
      const failed = errors.length === spec.probes.length
      if (failed) {
        setState((s) => ({ ...s, errors, failed, fetching: false }))
      } else {
        const last = prev.current
        const point = spec.derive(raw, last?.raw ?? null, last ? (at - last.at) / 1000 : 0)
        prev.current = { raw, at }
        setState((s) => ({
          samples: [...s.samples, { at, point }].slice(-HISTORY),
          raw,
          errors,
          failed,
          fetching: false
        }))
      }
      timer = setTimeout(() => void tick(), Math.max(250, intervalMs - (Date.now() - started)))
    }
    void tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
      setState((s) => ({ ...s, fetching: false }))
    }
  }, [connectionId, session, spec, intervalMs, running])

  return state
}

export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const onChange = (): void => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

export function LiveMetrics({
  connectionId,
  session,
  spec,
  active
}: {
  connectionId: string
  session: string
  spec: ServerDashboardSpec
  /** Whether the tab is in front; polling stops while it's hidden */
  active: boolean
}): React.JSX.Element {
  const [interval, setIntervalSecs] = useState<Interval>('2')
  const [paused, setPaused] = useState(false)
  const visible = useDocumentVisible()
  const live = useLiveMetrics(
    connectionId,
    session,
    spec,
    Number(interval) * 1000,
    active && visible && !paused
  )
  const [selected, setSelected] = useState(spec.tiles[0]?.key)
  const chartSpec = spec.tiles.find((t) => t.key === selected) ?? spec.tiles[0]
  const latest = live.samples[live.samples.length - 1]?.point
  const uptime = latest?.uptime
  const facts = live.raw ? spec.facts(live.raw) : []

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
          <Gauge className="size-3.5" /> Live metrics
        </h2>
        {uptime != null && <Badge>Up {formatUptime(uptime)}</Badge>}
        {live.fetching && <Spinner className="size-3" />}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-muted">Refresh every</span>
          <Segmented
            size="sm"
            value={interval}
            onChange={setIntervalSecs}
            options={INTERVALS.map((v) => ({ value: v, label: `${v}s` }))}
          />
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setPaused((p) => !p)}
            title={paused ? 'Resume polling' : 'Pause polling'}
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
      </div>

      {live.failed && !live.samples.length ? (
        <div className="rounded-lg border border-line bg-panel/70 p-4">
          <ErrorText error={live.errors[0]?.message} />
          {spec.note && <p className="mt-2 text-xs text-muted">{spec.note}</p>}
        </div>
      ) : (
        <>
          {(live.errors.length > 0 || live.failed) && (
            <p
              className="flex items-center gap-1.5 text-[11.5px] text-muted"
              title={live.errors.map((e) => `${e.probe}: ${e.message}`).join('\n')}
            >
              <AlertTriangle className="size-3.5 text-warn" />
              {live.failed
                ? 'The last refresh failed; showing the previous readings.'
                : 'Some metrics are unavailable.'}{' '}
              {spec.note}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {spec.tiles.map((tile) => (
              <StatTile
                key={tile.key}
                spec={tile}
                samples={live.samples}
                selected={tile.key === chartSpec?.key}
                onSelect={() => setSelected(tile.key)}
              />
            ))}
          </div>

          {chartSpec && (
            <div className="rounded-lg border border-line bg-panel/70 px-4 pt-3 pb-2">
              <div className="mb-1 flex items-baseline gap-2">
                <p className="text-[13px] font-medium text-bright">{chartSpec.label}</p>
                <p className="truncate text-[11.5px] text-muted">{chartSpec.hint}</p>
              </div>
              <LineChart spec={chartSpec} samples={live.samples} />
            </div>
          )}

          {(spec.meters.length > 0 || facts.length > 0) && (
            <div className="grid gap-3 lg:grid-cols-2">
              {spec.meters.length > 0 && (
                <div className="space-y-4 rounded-lg border border-line bg-panel/70 p-4">
                  {spec.meters.map((m) => (
                    <Meter key={m.key} spec={m} raw={live.raw} point={latest} />
                  ))}
                </div>
              )}
              {facts.length > 0 && (
                <div className="rounded-lg border border-line bg-panel/70 p-4">
                  <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted">
                    <Server className="size-3.5" /> Host and configuration
                  </p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
                    {facts.map((f) => (
                      <div key={f.label} className="contents">
                        <dt className="text-muted">{f.label}</dt>
                        <dd className="truncate text-bright select-text" title={f.value}>
                          {f.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function seriesOf(samples: Sample[], key: string): { at: number; value: number | null }[] {
  return samples.map((s) => ({ at: s.at, value: s.point[key] ?? null }))
}

function StatTile({
  spec,
  samples,
  selected,
  onSelect
}: {
  spec: MetricSpec
  samples: Sample[]
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const series = seriesOf(samples, spec.key)
  const value = series[series.length - 1]?.value ?? null
  return (
    <button
      type="button"
      onClick={onSelect}
      title={spec.hint}
      aria-pressed={selected}
      className={cn(
        'rounded-lg border bg-panel/70 px-4 pt-3 pb-2 text-left transition-colors hover:bg-hover/60',
        selected ? 'border-accent/60 ring-1 ring-accent/30' : 'border-line'
      )}
    >
      <p className="truncate text-[11px] text-muted">{spec.label}</p>
      <p className="mt-0.5 truncate text-[17px] font-semibold text-bright">
        {formatMetric(value, spec.unit)}
      </p>
      <Sparkline series={series.slice(-40)} percent={spec.unit === 'percent'} />
    </button>
  )
}

function Sparkline({
  series,
  percent
}: {
  series: { value: number | null }[]
  percent: boolean
}): React.JSX.Element {
  const W = 100
  const H = 24
  const values = series.map((p) => p.value)
  const known = values.filter((v): v is number => v != null)
  const max = percent ? 100 : Math.max(...known, 0)
  const min = percent ? Math.min(...known, 100) : 0
  const span = max - min || 1
  const step = series.length > 1 ? W / (series.length - 1) : 0
  const y = (v: number): number => H - 2 - ((v - min) / span) * (H - 4)
  const path = pathFor(values, (i) => i * step, y)
  const lastIndex = values.length - 1
  const last = values[lastIndex]
  return (
    <div className="relative mt-1.5 h-6">
      {known.length > 1 && (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="size-full">
          <path
            d={path}
            fill="none"
            className="stroke-faint"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      {last != null && known.length > 1 && (
        <span
          className="absolute size-1.5 -translate-1/2 rounded-full bg-accent"
          style={{ left: `${((lastIndex * step) / W) * 100}%`, top: `${(y(last) / H) * 100}%` }}
        />
      )}
    </div>
  )
}

/** Line path that breaks at missing values. */
function pathFor(
  values: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number
): string {
  let d = ''
  let pen = false
  values.forEach((v, i) => {
    if (v == null) {
      pen = false
      return
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`
    pen = true
  })
  return d
}

/** Closed wash under each unbroken run of values, down to the zero baseline. */
function areaFor(
  values: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number
): string {
  let d = ''
  let run: number[] = []
  const flush = (): void => {
    if (run.length > 1) {
      d += `M${x(run[0])},${y(0)}`
      for (const i of run) d += `L${x(i)},${y(values[i] as number)}`
      d += `L${x(run[run.length - 1])},${y(0)}Z`
    }
    run = []
  }
  values.forEach((v, i) => (v == null ? flush() : run.push(i)))
  flush()
  return d
}

function niceMax(max: number): number {
  if (max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * magnitude >= max) return m * magnitude
  return 10 * magnitude
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

function LineChart({ spec, samples }: { spec: MetricSpec; samples: Sample[] }): React.JSX.Element {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 180
  const pad = { top: 10, right: 8, bottom: 20, left: 56 }
  const series = seriesOf(samples, spec.key)
  const known = series.filter((p) => p.value != null).map((p) => p.value as number)
  const top = spec.unit === 'percent' ? 100 : niceMax(Math.max(...known, 0))
  const ticks = [0, top / 2, top]
  const plotW = Math.max(0, width - pad.left - pad.right)
  const plotH = H - pad.top - pad.bottom
  const t0 = series[0]?.at ?? 0
  const t1 = series[series.length - 1]?.at ?? 0
  const x = (at: number): number => pad.left + (t1 > t0 ? ((at - t0) / (t1 - t0)) * plotW : plotW)
  const y = (v: number): number => pad.top + plotH - (v / top) * plotH
  const values = series.map((p) => p.value)
  const line = pathFor(values, (i) => x(series[i].at), y)
  const area = areaFor(values, (i) => x(series[i].at), y)

  const hovered = hover != null ? series[hover] : null
  const onMove = (e: React.PointerEvent<SVGRectElement>): void => {
    if (series.length === 0) return
    const box = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - box.left + pad.left
    let best = 0
    for (let i = 1; i < series.length; i++)
      if (Math.abs(x(series[i].at) - px) < Math.abs(x(series[best].at) - px)) best = i
    setHover(best)
  }

  return (
    <div ref={ref} className="relative" style={{ height: H }}>
      {width > 0 && (
        <svg width={width} height={H} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y(t)}
                y2={y(t)}
                className="stroke-line"
                strokeWidth={1}
              />
              <text
                x={pad.left - 8}
                y={y(t)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted text-[10.5px] tabular-nums"
              >
                {formatMetric(t, spec.unit)}
              </text>
            </g>
          ))}
          {series.length > 1 && (
            <>
              <text x={pad.left} y={H - 4} className="fill-muted text-[10.5px]">
                {new Date(t0).toLocaleTimeString()}
              </text>
              <text
                x={width - pad.right}
                y={H - 4}
                textAnchor="end"
                className="fill-muted text-[10.5px]"
              >
                now
              </text>
            </>
          )}
          <path d={area} className="fill-accent" fillOpacity={0.1} />
          <path
            d={line}
            fill="none"
            className="stroke-accent"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {hovered && (
            <g pointerEvents="none">
              <line
                x1={x(hovered.at)}
                x2={x(hovered.at)}
                y1={pad.top}
                y2={pad.top + plotH}
                className="stroke-line-strong"
                strokeWidth={1}
              />
              {hovered.value != null && (
                <circle
                  cx={x(hovered.at)}
                  cy={y(hovered.value)}
                  r={4}
                  className="fill-accent stroke-panel"
                  strokeWidth={2}
                />
              )}
            </g>
          )}
          <rect
            x={pad.left}
            y={pad.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      {series.length < 2 && (
        <p className="absolute inset-0 flex items-center justify-center text-[12px] text-muted">
          Collecting samples…
        </p>
      )}
      {hovered && (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-line-strong bg-raised px-2.5 py-1.5 shadow-lg"
          style={
            x(hovered.at) > width / 2
              ? { right: width - x(hovered.at) + 10 }
              : { left: x(hovered.at) + 10 }
          }
        >
          <p className="text-[13px] font-semibold text-bright">
            {formatMetric(hovered.value, spec.unit)}
          </p>
          <p className="text-[11px] whitespace-nowrap text-muted">
            {new Date(hovered.at).toLocaleTimeString()}
          </p>
        </div>
      )}
    </div>
  )
}

function Meter({
  spec,
  raw,
  point
}: {
  spec: MeterSpec
  raw: Raw | null
  point: Point | undefined
}): React.JSX.Element {
  const value = point?.[spec.key] ?? null
  const level =
    value == null
      ? 'normal'
      : spec.danger != null && value >= spec.danger
        ? 'danger'
        : spec.warn != null && value >= spec.warn
          ? 'warn'
          : 'normal'
  const detail = raw && point ? spec.detail(raw, point) : null
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <p className="text-[12px] text-fg">{spec.label}</p>
        {level === 'warn' && <Badge tone="warning">High</Badge>}
        {level === 'danger' && <Badge tone="danger">Critical</Badge>}
        <p className="ml-auto text-[13px] font-semibold text-bright">
          {formatMetric(value, 'percent')}
        </p>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-accent/15">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            level === 'danger' ? 'bg-danger' : level === 'warn' ? 'bg-warn' : 'bg-accent'
          )}
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
      {detail && <p className="mt-1 text-[11px] text-muted">{detail}</p>}
    </div>
  )
}
