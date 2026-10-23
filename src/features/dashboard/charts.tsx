import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { formatValue, niceTicks, type ChartData } from '@/lib/dashboards'

/** Categories past this are left off bar charts; the data view still has every row. */
const MAX_BARS = 50
const TICK_FONT = 10.5
/** Rough advance of one character at the tick font size, for layout without measuring. */
const CHAR_W = 6.2

const seriesColor = (i: number): string => `var(--series-${(i % 8) + 1})`

function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize((s) =>
        Math.round(s.w) === Math.round(width) && Math.round(s.h) === Math.round(height)
          ? s
          : { w: width, h: height }
      )
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, size]
}

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, Math.max(1, chars - 1))}…` : text
}

function Legend({ data, mark }: { data: ChartData; mark: 'rect' | 'line' }): ReactNode {
  if (data.series.length < 2 && !data.hiddenSeries) return null
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 pb-2 text-[11px] text-muted">
      {data.series.map((s, i) => (
        <span key={s.name} className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn('shrink-0', mark === 'rect' ? 'size-2.5 rounded-[2px]' : 'h-0.5 w-3')}
            style={{ background: seriesColor(i) }}
          />
          <span className="truncate">{s.name}</span>
        </span>
      ))}
      {data.hiddenSeries > 0 && (
        <span className="text-faint">+{data.hiddenSeries} more in the data view</span>
      )}
    </div>
  )
}

interface TipState {
  x: number
  y: number
  index: number
}

/** One readout for every series at a position: values lead, names follow. */
function Tooltip({
  tip,
  data,
  width,
  mark
}: {
  tip: TipState
  data: ChartData
  width: number
  mark: 'rect' | 'line'
}): React.JSX.Element {
  const flip = tip.x > width - 180
  return (
    <div
      className="pointer-events-none absolute z-10 max-w-64 min-w-28 rounded-md border border-line-strong bg-raised px-2.5 py-2 shadow-lg shadow-(color:--shadow)"
      style={{
        top: Math.max(0, tip.y - 12),
        ...(flip ? { right: width - tip.x + 12 } : { left: tip.x + 12 })
      }}
    >
      <p className="mb-1 truncate text-[11px] text-muted">{data.labels[tip.index]}</p>
      {data.series.map((s, i) => (
        <div key={s.name} className="flex items-center gap-2 text-[12px] leading-5">
          <span
            className={cn('shrink-0', mark === 'rect' ? 'size-2 rounded-[2px]' : 'h-0.5 w-2.5')}
            style={{ background: seriesColor(i) }}
          />
          <span className="font-semibold text-bright tabular-nums">
            {formatValue(s.values[tip.index])}
          </span>
          <span className="truncate text-muted">{s.name}</span>
        </div>
      ))}
    </div>
  )
}

/** A bar with a 4px rounded data end and a square baseline. */
function barPath(x0: number, x1: number, y: number, h: number): string {
  const left = Math.min(x0, x1)
  const right = Math.max(x0, x1)
  const r = Math.min(4, h / 2, right - left)
  if (x1 >= x0)
    return `M${left},${y}H${right - r}Q${right},${y} ${right},${y + r}V${y + h - r}Q${right},${y + h} ${right - r},${y + h}H${left}Z`
  return `M${right},${y}H${left + r}Q${left},${y} ${left},${y + r}V${y + h - r}Q${left},${y + h} ${left + r},${y + h}H${right}Z`
}

/** Horizontal bars: one band per row, grouped by series, growing from zero. */
export function BarChart({ data }: { data: ChartData }): React.JSX.Element {
  const [ref, { w, h }] = useSize<HTMLDivElement>()
  const [tip, setTip] = useState<TipState | null>(null)
  const count = Math.min(data.labels.length, MAX_BARS)
  const k = data.series.length
  const values = data.series.flatMap((s) => s.values.slice(0, count)).filter((v) => v != null)
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), w > 360 ? 5 : 3)
  const lo = ticks[0]
  const hi = ticks[ticks.length - 1]

  const axisH = 18
  const longest = Math.max(...data.labels.slice(0, count).map((l) => l.length), 1)
  const labelChars = Math.max(4, Math.min(longest, Math.floor((w * 0.35) / CHAR_W)))
  const left = labelChars * CHAR_W + 10
  const valueRoom = k === 1 ? 44 : 8
  const plotW = Math.max(10, w - left - valueRoom)
  const minBand = k * 8 + (k - 1) * 2 + 8
  const band = Math.max(minBand, count ? (h - axisH) / count : 0)
  const thick = Math.min(24, Math.max(4, (band * 0.7 - (k - 1) * 2) / k))
  const groupH = thick * k + (k - 1) * 2
  const plotH = band * count
  const sx = (v: number): number => left + ((v - lo) / (hi - lo || 1)) * plotW
  const zero = sx(0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Legend data={data} mark="rect" />
      <div ref={ref} className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {w > 0 && (
          <svg width={w} height={plotH + axisH} className="block select-none" role="img">
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={sx(t)}
                  x2={sx(t)}
                  y1={0}
                  y2={plotH}
                  stroke={t === 0 ? 'var(--color-line-strong)' : 'var(--color-line)'}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={sx(t)}
                  y={plotH + 13}
                  textAnchor="middle"
                  fontSize={TICK_FONT}
                  fill="var(--color-muted)"
                  className="tabular-nums"
                >
                  {formatValue(t)}
                </text>
              </g>
            ))}
            {data.labels.slice(0, count).map((label, row) => {
              const top = row * band
              const y0 = top + (band - groupH) / 2
              const active = tip?.index === row
              return (
                <g key={row}>
                  {active && (
                    <rect x={0} y={top} width={w} height={band} fill="var(--color-hover)" />
                  )}
                  <text
                    x={left - 8}
                    y={top + band / 2}
                    dominantBaseline="central"
                    textAnchor="end"
                    fontSize={11}
                    fill={active ? 'var(--color-bright)' : 'var(--color-fg)'}
                  >
                    {clip(label, labelChars)}
                  </text>
                  {data.series.map((s, i) => {
                    const v = s.values[row]
                    if (v == null) return null
                    const y = y0 + i * (thick + 2)
                    return (
                      <path key={s.name} d={barPath(zero, sx(v), y, thick)} fill={seriesColor(i)} />
                    )
                  })}
                  {k === 1 && data.series[0].values[row] != null && band >= 14 && (
                    <text
                      x={
                        sx(data.series[0].values[row]!) + (data.series[0].values[row]! < 0 ? -4 : 4)
                      }
                      y={top + band / 2}
                      dominantBaseline="central"
                      textAnchor={data.series[0].values[row]! < 0 ? 'end' : 'start'}
                      fontSize={TICK_FONT}
                      fill="var(--color-muted)"
                      className="tabular-nums"
                    >
                      {formatValue(data.series[0].values[row])}
                    </text>
                  )}
                  <rect
                    x={0}
                    y={top}
                    width={w}
                    height={band}
                    fill="transparent"
                    tabIndex={0}
                    className="outline-none"
                    onPointerMove={(e) => {
                      const box = ref.current!.getBoundingClientRect()
                      setTip({
                        x: e.clientX - box.left,
                        y: e.clientY - box.top + ref.current!.scrollTop,
                        index: row
                      })
                    }}
                    onPointerLeave={() => setTip(null)}
                    onFocus={() => setTip({ x: sx(0), y: top, index: row })}
                    onBlur={() => setTip(null)}
                  />
                </g>
              )
            })}
          </svg>
        )}
        {tip && <Tooltip tip={tip} data={data} width={w} mark="rect" />}
      </div>
      {data.labels.length > count && (
        <p className="shrink-0 pt-1 text-[11px] text-faint">
          First {count} of {data.labels.length} rows · the data view has them all
        </p>
      )}
    </div>
  )
}

/** Lines over rows in query order, with a crosshair that snaps to the nearest row. */
export function LineChart({ data }: { data: ChartData }): React.JSX.Element {
  const [ref, { w, h }] = useSize<HTMLDivElement>()
  const [index, setIndex] = useState<number | null>(null)
  const n = data.labels.length
  const k = data.series.length
  const values = data.series.flatMap((s) => s.values).filter((v): v is number => v != null)
  const ticks = niceTicks(Math.min(...values), Math.max(...values), h > 200 ? 5 : 3)
  const lo = ticks[0]
  const hi = ticks[ticks.length - 1]

  const left = Math.max(...ticks.map((t) => formatValue(t).length)) * CHAR_W + 10
  const right = k === 1 ? 48 : 12
  const top = 8
  const axisH = 20
  const plotW = Math.max(10, w - left - right)
  const plotH = Math.max(10, h - top - axisH)
  const step = n > 1 ? plotW / (n - 1) : 0
  const px = (i: number): number => (n > 1 ? left + i * step : left + plotW / 2)
  const py = (v: number): number => top + plotH - ((v - lo) / (hi - lo || 1)) * plotH

  const avgLabel = Math.min(16, Math.max(4, ...data.labels.slice(0, 50).map((l) => l.length)))
  const every = Math.max(
    1,
    Math.ceil(n / Math.max(1, Math.floor(plotW / (avgLabel * CHAR_W + 16))))
  )

  const paths = data.series.map((s) => {
    let d = ''
    let pen = false
    s.values.forEach((v, i) => {
      if (v == null) {
        pen = false
        return
      }
      d += `${pen ? 'L' : 'M'}${px(i)},${py(v)}`
      pen = true
    })
    return d
  })
  const single = k === 1 ? data.series[0] : null
  const lastIndex = single ? single.values.findLastIndex((v) => v != null) : -1
  const area =
    single && n > 1 && single.values.every((v) => v != null)
      ? `${paths[0]}L${px(n - 1)},${py(Math.max(lo, Math.min(0, hi)))}L${px(0)},${py(Math.max(lo, Math.min(0, hi)))}Z`
      : null

  const pick = (clientX: number): void => {
    const box = ref.current!.getBoundingClientRect()
    const x = clientX - box.left
    setIndex(n > 1 ? Math.max(0, Math.min(n - 1, Math.round((x - left) / step))) : 0)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Legend data={data} mark="line" />
      <div ref={ref} className="relative min-h-0 flex-1">
        {w > 0 && h > 0 && (
          <svg
            width={w}
            height={h}
            className="absolute inset-0 block outline-none select-none"
            role="img"
            tabIndex={0}
            onPointerMove={(e) => pick(e.clientX)}
            onPointerLeave={() => setIndex(null)}
            onBlur={() => setIndex(null)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              e.preventDefault()
              const delta = e.key === 'ArrowLeft' ? -1 : 1
              setIndex((i) => Math.max(0, Math.min(n - 1, (i ?? (delta < 0 ? n : -1)) + delta)))
            }}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={left}
                  x2={left + plotW}
                  y1={py(t)}
                  y2={py(t)}
                  stroke={t === 0 ? 'var(--color-line-strong)' : 'var(--color-line)'}
                  shapeRendering="crispEdges"
                />
                <text
                  x={left - 8}
                  y={py(t)}
                  dominantBaseline="central"
                  textAnchor="end"
                  fontSize={TICK_FONT}
                  fill="var(--color-muted)"
                  className="tabular-nums"
                >
                  {formatValue(t)}
                </text>
              </g>
            ))}
            {data.labels.map((label, i) =>
              i % every === 0 ? (
                <text
                  key={i}
                  x={px(i)}
                  y={top + plotH + 14}
                  textAnchor={n > 1 && i === 0 ? 'start' : 'middle'}
                  fontSize={TICK_FONT}
                  fill="var(--color-muted)"
                >
                  {clip(label, avgLabel)}
                </text>
              ) : null
            )}
            {area && <path d={area} fill={seriesColor(0)} opacity={0.1} />}
            {paths.map((d, i) => (
              <path
                key={data.series[i].name}
                d={d}
                fill="none"
                stroke={seriesColor(i)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {single && lastIndex >= 0 && index === null && (
              <g>
                <circle
                  cx={px(lastIndex)}
                  cy={py(single.values[lastIndex]!)}
                  r={4}
                  fill={seriesColor(0)}
                  stroke="var(--color-panel)"
                  strokeWidth={2}
                />
                <text
                  x={px(lastIndex) + 8}
                  y={py(single.values[lastIndex]!)}
                  dominantBaseline="central"
                  fontSize={11}
                  fontWeight={600}
                  fill="var(--color-bright)"
                  className="tabular-nums"
                >
                  {formatValue(single.values[lastIndex])}
                </text>
              </g>
            )}
            {index !== null && (
              <g>
                <line
                  x1={px(index)}
                  x2={px(index)}
                  y1={top}
                  y2={top + plotH}
                  stroke="var(--color-line-strong)"
                  shapeRendering="crispEdges"
                />
                {data.series.map((s, i) =>
                  s.values[index] == null ? null : (
                    <circle
                      key={s.name}
                      cx={px(index)}
                      cy={py(s.values[index]!)}
                      r={4}
                      fill={seriesColor(i)}
                      stroke="var(--color-panel)"
                      strokeWidth={2}
                    />
                  )
                )}
              </g>
            )}
          </svg>
        )}
        {index !== null && (
          <Tooltip tip={{ x: px(index), y: top, index }} data={data} width={w} mark="line" />
        )}
      </div>
    </div>
  )
}

/** A single headline number. */
export function StatTile({
  value,
  text,
  caption
}: {
  value: number | null
  text: string
  caption: string | null
}): React.JSX.Element {
  return (
    <div className="flex h-full min-w-0 flex-col justify-center">
      <p
        className="truncate text-[32px] leading-tight font-semibold tracking-tight text-bright select-text"
        title={text}
      >
        {value == null ? text : formatValue(value)}
      </p>
      {caption && <p className="truncate text-[11.5px] text-muted">{caption}</p>}
    </div>
  )
}
