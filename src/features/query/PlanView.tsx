import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownUp,
  Box,
  CheckCircle2,
  ClipboardCopy,
  Filter,
  GitMerge,
  Hash,
  Info,
  KeyRound,
  Layers,
  Lightbulb,
  Maximize2,
  Search,
  Sigma,
  Table2,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { copyText } from '@/lib/export'
import { compactCount } from '@/lib/format'
import {
  PLAN_NODE,
  fmtMs,
  layoutPlan,
  misestimate,
  nodeShare,
  planTotal,
  walkPlan,
  type Plan,
  type PlanHint,
  type PlanMetric,
  type PlanNode
} from '@/lib/plan'
import { Badge, Button, Segmented } from '@/components/ui'

interface View {
  x: number
  y: number
  k: number
}

const MIN_ZOOM = 0.15
const MAX_ZOOM = 2
const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))

function opIcon(op: string): React.JSX.Element {
  const cls = 'size-3.5 shrink-0'
  if (/lookup|seek|index (only )?scan|bitmap/i.test(op)) return <KeyRound className={cls} />
  if (/scan/i.test(op)) return <Table2 className={cls} />
  if (/join|nested loop|merge|semi|anti/i.test(op)) return <GitMerge className={cls} />
  if (/sort|top-n/i.test(op)) return <ArrowDownUp className={cls} />
  if (/aggregate|group|count|window/i.test(op)) return <Sigma className={cls} />
  if (/filter/i.test(op)) return <Filter className={cls} />
  if (/hash/i.test(op)) return <Hash className={cls} />
  if (/gather|parallel|append|union|materiali|spool/i.test(op)) return <Layers className={cls} />
  return <Box className={cls} />
}

/** Heat tone for a node's share of the plan's time or cost. */
function tone(share: number | null): 'danger' | 'warn' | 'ok' | 'none' {
  if (share == null) return 'none'
  return share >= 0.3 ? 'danger' : share >= 0.1 ? 'warn' : 'ok'
}

const TONE_TEXT = { danger: 'text-danger', warn: 'text-warn', ok: 'text-ok', none: 'text-faint' }
const TONE_BAR = { danger: 'bg-danger', warn: 'bg-warn', ok: 'bg-ok', none: 'bg-faint' }
const SEVERITY_TEXT = { high: 'text-danger', medium: 'text-warn', low: 'text-info' }

function fmtCost(n: number | null): string {
  if (n == null) return ''
  return n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(n < 10 ? 2 : 1)
}

/** Rows a node hands up to its parent. */
function flowRows(n: PlanNode): number | null {
  return n.actualRows ?? (n.estRows == null ? null : n.estRows * (n.loops ?? 1))
}

export function PlanView({ plan }: { plan: Plan }): React.JSX.Element {
  const [metric, setMetric] = useState<PlanMetric | undefined>(plan.metrics[0])
  const [selected, setSelected] = useState<number | null>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const containerRef = useRef<HTMLDivElement>(null)

  const layout = useMemo(() => layoutPlan(plan.trees), [plan])
  const nodes = useMemo(() => {
    const list: { node: PlanNode; parent: PlanNode | null }[] = []
    for (const t of plan.trees) walkPlan(t.root, (node, parent) => list.push({ node, parent }))
    return list
  }, [plan])
  const byId = useMemo(() => new Map(nodes.map(({ node }) => [node.id, node])), [nodes])
  const hintsByNode = useMemo(() => {
    const map = new Map<number, PlanHint[]>()
    for (const h of plan.hints)
      if (h.nodeId != null) map.set(h.nodeId, [...(map.get(h.nodeId) ?? []), h])
    return map
  }, [plan])
  const total = metric ? planTotal(plan, metric) : 0
  const maxRows = Math.max(1, ...nodes.map(({ node }) => flowRows(node) ?? 0))

  useEffect(() => {
    setMetric(plan.metrics[0])
    setSelected(plan.hints[0]?.nodeId ?? null)
  }, [plan])

  /* ----- Pan and zoom ----- */

  const fit = useCallback(() => {
    const el = containerRef.current
    if (!el || !layout.width) return
    const pad = 32
    const k = clampZoom(
      Math.min(
        1,
        (el.clientWidth - pad * 2) / layout.width,
        (el.clientHeight - pad * 2) / layout.height
      )
    )
    setView({
      k,
      x: (el.clientWidth - layout.width * k) / 2,
      y: Math.max(pad, (el.clientHeight - layout.height * k) / 2)
    })
  }, [layout])

  useLayoutEffect(fit, [fit])

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = containerRef.current
    if (!el) return
    const v = viewRef.current
    const px = cx ?? el.clientWidth / 2
    const py = cy ?? el.clientHeight / 2
    const k = clampZoom(v.k * factor)
    setView({ k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k })
  }, [])

  // Wheel pans, Ctrl+wheel (and trackpad pinch) zooms; React's wheel listener is passive
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect()
        zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - rect.left, e.clientY - rect.top)
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY
        setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null)
  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 && e.button !== 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, view: viewRef.current, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.moved && Math.hypot(dx, dy) < 3) return
    d.moved = true
    setView({ ...d.view, x: d.view.x + dx, y: d.view.y + dy })
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    // A click rather than a drag: pick the node under the pointer
    const hit = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>('[data-plan-node]')
    setSelected(hit ? Number(hit.dataset.planNode) : null)
  }

  const reveal = (id: number): void => {
    setSelected(id)
    const el = containerRef.current
    const at = layout.positions.get(id)
    if (!el || !at) return
    setView((v) => ({
      ...v,
      x: el.clientWidth / 2 - (at.x + PLAN_NODE.width / 2) * v.k,
      y: el.clientHeight / 2 - (at.y + PLAN_NODE.height / 2) * v.k
    }))
  }

  const selectedNode = selected != null ? byId.get(selected) : undefined
  const totalTime =
    plan.executionMs ?? plan.trees.reduce((s, t) => s + (t.timeMs ?? t.root.timeMs ?? 0), 0)
  const totalCost = planTotal(plan, 'cost')

  return (
    <div className="flex h-full min-h-0">
      <div
        ref={containerRef}
        className="relative min-w-0 flex-1 cursor-grab touch-none overflow-hidden bg-canvas bg-dots select-none active:cursor-grabbing"
        style={{
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundSize: `${18 * view.k}px ${18 * view.k}px`
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          <svg
            width={layout.width}
            height={layout.height}
            className="absolute top-0 left-0 overflow-visible"
          >
            {nodes.map(({ node, parent }) => {
              if (!parent) return null
              const a = layout.positions.get(node.id)
              const b = layout.positions.get(parent.id)
              if (!a || !b) return null
              const x1 = a.x + PLAN_NODE.width / 2
              const y1 = a.y
              const x2 = b.x + PLAN_NODE.width / 2
              const y2 = b.y + PLAN_NODE.height
              const mid = (y1 + y2) / 2
              const rows = flowRows(node)
              const width = 1.25 + (7 * Math.log10((rows ?? 0) + 1)) / Math.log10(maxRows + 1)
              const lit = selected === node.id || selected === parent.id
              return (
                <g key={node.id}>
                  <path
                    d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                    fill="none"
                    stroke={lit ? 'var(--color-accent)' : 'var(--color-line-strong)'}
                    strokeWidth={width}
                    strokeLinecap="round"
                  >
                    <title>{`${rows == null ? '?' : Math.round(rows).toLocaleString()} rows${node.actualRows == null ? ' (estimated)' : ''}`}</title>
                  </path>
                  {rows != null && (
                    <text
                      x={(x1 + x2) / 2 + 6}
                      y={mid}
                      dominantBaseline="central"
                      fontSize={10.5}
                      fill="var(--color-muted)"
                      className="tabular-nums"
                    >
                      {compactCount(Math.round(rows))}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
          {layout.labels.map((l, i) => (
            <div
              key={i}
              className="absolute truncate font-mono text-[11.5px] text-muted"
              style={{ left: l.x, top: l.y, width: Math.max(layout.width, 480) }}
              title={l.text}
            >
              {l.text}
            </div>
          ))}
          {nodes.map(({ node }) => {
            const at = layout.positions.get(node.id)
            if (!at) return null
            return (
              <NodeCard
                key={node.id}
                node={node}
                at={at}
                share={metric ? nodeShare(node, metric, total) : null}
                hints={hintsByNode.get(node.id)}
                selected={selected === node.id}
              />
            )
          })}
        </div>

        <div
          className="absolute top-2 right-2 flex items-center gap-1 rounded-md bg-panel/90 p-0.5 ring-1 ring-line"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {plan.metrics.length > 1 && metric && (
            <Segmented
              size="sm"
              value={metric}
              onChange={setMetric}
              options={[
                { value: 'time', label: 'Time', title: 'Colour steps by measured time' },
                {
                  value: 'cost',
                  label: 'Cost',
                  title: "Colour steps by the planner's cost estimate"
                }
              ]}
              className="mr-1"
            />
          )}
          <Button size="icon-sm" variant="ghost" title="Zoom out" onClick={() => zoomAt(1 / 1.25)}>
            <ZoomOut className="size-3.5" />
          </Button>
          <Button size="icon-sm" variant="ghost" title="Zoom in" onClick={() => zoomAt(1.25)}>
            <ZoomIn className="size-3.5" />
          </Button>
          <Button size="icon-sm" variant="ghost" title="Fit to view" onClick={fit}>
            <Maximize2 className="size-3.5" />
          </Button>
        </div>
        <div className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-faint">
          Data flows upward · line thickness is rows · Ctrl+scroll to zoom
        </div>
      </div>

      <aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel text-[12px]">
        <section className="border-b border-line p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-medium text-bright">Execution plan</span>
            {plan.analyzed ? (
              <Badge tone="success" title="The query ran; rows and times are measured">
                Actual
              </Badge>
            ) : (
              <Badge title="The query didn't run; rows and costs are the planner's estimates">
                Estimated
              </Badge>
            )}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted">
            {plan.analyzed && totalTime > 0 && (
              <>
                <dt>Execution</dt>
                <dd className="text-fg tabular-nums">{fmtMs(totalTime)}</dd>
              </>
            )}
            {plan.planningMs != null && (
              <>
                <dt>Planning</dt>
                <dd className="text-fg tabular-nums">{fmtMs(plan.planningMs)}</dd>
              </>
            )}
            {totalCost > 0 && (
              <>
                <dt>Estimated cost</dt>
                <dd className="text-fg tabular-nums">{fmtCost(totalCost)}</dd>
              </>
            )}
            <dt>Steps</dt>
            <dd className="text-fg tabular-nums">{nodes.length}</dd>
          </dl>
          {!plan.analyzed && (
            <p className="mt-2 text-[11.5px] text-faint">
              Use Explain analyze to run the query and measure where the time really goes.
            </p>
          )}
        </section>

        <section className="border-b border-line p-3">
          <div className="mb-2 flex items-center gap-1.5 font-medium text-bright">
            <Lightbulb className="size-3.5 text-warn" /> Suggestions
          </div>
          {plan.hints.length === 0 ? (
            <p className="flex items-center gap-1.5 text-muted">
              <CheckCircle2 className="size-3.5 text-ok" /> Nothing stands out in this plan.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {plan.hints.map((h, i) => (
                <li key={i}>
                  <HintCard
                    hint={h}
                    active={h.nodeId != null && h.nodeId === selected}
                    onSelect={h.nodeId != null ? () => reveal(h.nodeId!) : undefined}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {selectedNode ? (
          <NodeDetails node={selectedNode} metric={metric} total={total} />
        ) : (
          <p className="p-3 text-muted">Click a step to see its details.</p>
        )}
      </aside>
    </div>
  )
}

function NodeCard({
  node,
  at,
  share,
  hints,
  selected
}: {
  node: PlanNode
  at: { x: number; y: number }
  share: number | null
  hints?: PlanHint[]
  selected: boolean
}): React.JSX.Element {
  const t = tone(share)
  const off = misestimate(node)
  const worst = hints?.find((h) => h.severity === 'high') ?? hints?.[0]
  return (
    <div
      data-plan-node={node.id}
      className={cn(
        'absolute flex cursor-pointer flex-col gap-1 rounded-lg border bg-raised px-2.5 py-2 shadow-sm',
        selected ? 'border-accent ring-2 ring-accent/30' : 'border-line-strong hover:border-muted'
      )}
      style={{ left: at.x, top: at.y, width: PLAN_NODE.width, height: PLAN_NODE.height }}
    >
      {node.label && (
        <span className="absolute -top-2.5 left-2 rounded bg-hover px-1.5 text-[10px] leading-4 text-muted">
          {node.label}
        </span>
      )}
      {worst && (
        <span
          className={cn(
            'absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full bg-panel ring-1 ring-line-strong',
            SEVERITY_TEXT[worst.severity]
          )}
          title={hints!.map((h) => h.title).join('\n')}
        >
          <AlertTriangle className="size-3" />
        </span>
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={TONE_TEXT[t]}>{opIcon(node.op)}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-bright" title={node.op}>
          {node.op}
        </span>
        {share != null && (
          <span className={cn('text-[11px] font-medium tabular-nums', TONE_TEXT[t])}>
            {share < 0.01 && share > 0 ? '<1' : Math.round(share * 100)}%
          </span>
        )}
      </div>
      <div
        className="truncate font-mono text-[11px] text-muted"
        title={node.target ?? node.filter ?? ''}
      >
        {node.target ?? node.filter ?? ' '}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-hover">
        <div
          className={cn('h-full rounded-full', TONE_BAR[t])}
          style={{ width: `${Math.max(2, (share ?? 0) * 100)}%` }}
        />
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted tabular-nums">
        {node.actualRows != null ? (
          <span
            className={cn(off != null && off >= 10 && 'text-warn')}
            title={`${node.actualRows.toLocaleString()} rows${node.estRows != null ? `; estimated ${Math.round(node.estRows).toLocaleString()} per execution` : ''}`}
          >
            {compactCount(Math.round(node.actualRows))} rows
            {off != null &&
              off >= 10 &&
              ` (est ${compactCount(Math.round(node.estRows! * (node.loops || 1)))})`}
          </span>
        ) : (
          node.estRows != null && <span>~{compactCount(Math.round(node.estRows))} rows</span>
        )}
        {node.loops != null && node.loops > 1 && (
          <span title="Executions">×{compactCount(node.loops)}</span>
        )}
        <span className="flex-1" />
        {node.timeMs != null ? (
          <span title="Including the steps under it">{fmtMs(node.timeMs)}</span>
        ) : (
          node.cost != null && (
            <span title="Estimated cost, including the steps under it">
              cost {fmtCost(node.cost)}
            </span>
          )
        )}
      </div>
    </div>
  )
}

function HintCard({
  hint,
  active,
  onSelect
}: {
  hint: PlanHint
  active: boolean
  onSelect?: () => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-md border p-2',
        active ? 'border-accent/50 bg-accent/5' : 'border-line bg-raised',
        onSelect && 'cursor-pointer hover:border-line-strong'
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-1.5">
        {hint.severity === 'low' ? (
          <Info className={cn('mt-0.5 size-3.5 shrink-0', SEVERITY_TEXT[hint.severity])} />
        ) : (
          <AlertTriangle className={cn('mt-0.5 size-3.5 shrink-0', SEVERITY_TEXT[hint.severity])} />
        )}
        <span className="font-medium text-bright">{hint.title}</span>
      </div>
      <p className="mt-1 pl-5 text-[11.5px] leading-relaxed text-muted">{hint.detail}</p>
      {hint.sql && (
        <div className="relative mt-1.5 ml-5">
          <pre className="overflow-x-auto rounded bg-canvas p-2 pr-8 font-mono text-[11px] text-fg select-text">
            {hint.sql}
          </pre>
          <Button
            size="icon-sm"
            variant="ghost"
            className="absolute top-1 right-1"
            title="Copy"
            onClick={(e) => {
              e.stopPropagation()
              void copyText(hint.sql!, 'Copied suggestion')
            }}
          >
            <ClipboardCopy className="size-3" />
          </Button>
        </div>
      )}
    </div>
  )
}

function NodeDetails({
  node,
  metric,
  total
}: {
  node: PlanNode
  metric?: PlanMetric
  total: number
}): React.JSX.Element {
  const share = metric ? nodeShare(node, metric, total) : null
  const rows: [string, React.ReactNode][] = []
  if (node.actualRows != null)
    rows.push(['Actual rows', Math.round(node.actualRows).toLocaleString()])
  if (node.estRows != null)
    rows.push([
      'Estimated rows',
      `${Math.round(node.estRows).toLocaleString()}${node.loops != null && node.loops > 1 ? ' per execution' : ''}`
    ])
  if (node.loops != null) rows.push(['Executions', node.loops.toLocaleString()])
  if (node.timeMs != null)
    rows.push(['Time', `${fmtMs(node.timeMs)} total · ${fmtMs(node.selfMs ?? 0)} in this step`])
  if (node.cost != null)
    rows.push(['Cost', `${fmtCost(node.cost)} total · ${fmtCost(node.selfCost)} in this step`])
  if (share != null)
    rows.push([
      'Share',
      `${Math.round(share * 100)}% of the ${metric === 'time' ? 'time' : 'cost'}`
    ])
  if (node.rowsRemoved != null)
    rows.push(['Rows filtered out', Math.round(node.rowsRemoved).toLocaleString()])
  return (
    <section className="p-3">
      <div className="mb-0.5 flex items-center gap-1.5 font-medium text-bright">
        {opIcon(node.op)} {node.op}
      </div>
      {node.target && (
        <div className="mb-2 font-mono text-[11px] break-all text-muted">{node.target}</div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>{k}</dt>
            <dd className="text-fg tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {node.filter && (
        <>
          <div className="mt-2 mb-0.5 text-muted">Filter</div>
          <code className="block rounded bg-canvas p-1.5 font-mono text-[11px] break-all text-fg select-text">
            {node.filter}
          </code>
        </>
      )}
      {node.warnings.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {node.warnings.map((w, i) => (
            <li key={i} className="flex gap-1.5 text-warn">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      <details className="mt-3">
        <summary className="flex cursor-pointer items-center gap-1.5 text-muted hover:text-fg">
          <Search className="size-3" /> All properties
        </summary>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
          {node.props.map(([k, v], i) => (
            <div key={i} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-all text-fg select-text">{v}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  )
}
