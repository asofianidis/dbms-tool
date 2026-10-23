import { Fragment, useEffect, useRef, useState } from 'react'
import { keepPreviousData, useIsFetching, useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Copy,
  Download,
  GripVertical,
  LayoutDashboard,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Table2,
  Timer,
  Trash2
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  dashboardsStore,
  dragOrder,
  moveWidget,
  newWidget,
  REFRESH_CHOICES,
  reorderWidgets,
  updateDashboard,
  upsertWidget,
  type Dashboard,
  type Widget,
  type WidgetSpan
} from '@/lib/dashboards'
import { formatDuration, plural } from '@/lib/format'
import { queryClient } from '@/lib/queries'
import {
  connect,
  connectionsStore,
  defaultDatabase,
  statusStore,
  tabsStore,
  type TabOf
} from '@/lib/workspace'
import { showContextMenu, showMenuAt, type MenuItem } from '@/components/ContextMenu'
import { Button, EmptyState, ErrorText, Spinner, Toolbar, ToolbarDivider } from '@/components/ui'
import { ConnectionPicker, DatabasePicker } from '../query/pickers'
import {
  duplicateDashboard,
  exportDashboard,
  removeDashboard,
  renameDashboard,
  setLocked
} from './actions'
import { ImportReview } from './ImportReview'
import { runWidgetQuery } from './run'
import { WidgetBody } from './WidgetBody'
import { WidgetEditor } from './WidgetEditor'

const SPAN_CLASS: Record<WidgetSpan, string> = {
  1: '',
  2: '@2xl:col-span-2',
  3: '@2xl:col-span-2 @5xl:col-span-3',
  4: '@2xl:col-span-2 @5xl:col-span-4'
}

const SPAN_LABEL: Record<WidgetSpan, string> = {
  1: 'Quarter',
  2: 'Half',
  3: 'Three quarters',
  4: 'Full'
}

/** Pointer travel before a press on a card header becomes a drag, so clicks still work. */
const DRAG_THRESHOLD = 5
/** Distance from the scroller's edge at which dragging scrolls it. */
const SCROLL_EDGE = 48

const heightClass = (widget: Widget): string => (widget.kind === 'stat' ? 'h-32' : 'h-80')

function refreshLabel(secs: number): string {
  if (!secs) return 'Off'
  return secs < 60 ? `${secs}s` : `${secs / 60} min`
}

function contains(el: Element | null | undefined, x: number, y: number): boolean {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

interface DragState {
  id: string
  order: string[]
  /** Where the card was grabbed, relative to its corner */
  offsetX: number
  offsetY: number
  x: number
  y: number
  width: number
  height: number
  /** The card last swapped with: ignored until the pointer leaves it, so mixed sizes don't flicker */
  lastSwap: string | null
}

export function DashboardTab({ tab }: { tab: TabOf<'dashboard'> }): React.JSX.Element {
  const dashboard = dashboardsStore.use().find((d) => d.id === tab.dashboardId)
  if (!dashboard)
    return (
      <EmptyState
        icon={<LayoutDashboard className="size-6" />}
        title="This dashboard was deleted"
      />
    )
  if (dashboard.unreviewed) return <ImportReview dashboard={dashboard} />
  return <DashboardView tab={tab} dashboard={dashboard} />
}

function DashboardView({
  tab,
  dashboard
}: {
  tab: TabOf<'dashboard'>
  dashboard: Dashboard
}): React.JSX.Element {
  const connection = connectionsStore.use().find((c) => c.id === dashboard.connectionId)
  const status = statusStore.use()[dashboard.connectionId]
  const active = tabsStore.use().active === tab.id
  const fetching = useIsFetching({ queryKey: ['dashboard', tab.id] })
  const locked = !!dashboard.locked
  const [editing, setEditing] = useState<{ widget: Widget; isNew: boolean } | null>(null)
  const [drag, setDragState] = useState<DragState | null>(null)
  const [resize, setResize] = useState<{ id: string; span: WidgetSpan } | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const cards = useRef(new Map<string, HTMLElement>())
  const placeholder = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const board = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (connection && status?.state !== 'connected' && status?.state !== 'connecting')
      void connect(connection.id)
    // Only on open and when the connection changes; failures show on each widget
  }, [connection?.id])

  // Widgets share one session per tab; it closes with the tab or when the connection changes
  useEffect(
    () => () => void api.closeSession(dashboard.connectionId, tab.id).catch(() => {}),
    [dashboard.connectionId, tab.id]
  )

  const setWidgets = (fn: (widgets: Widget[]) => Widget[]): void =>
    updateDashboard(dashboard.id, (d) => ({ widgets: fn(d.widgets) }))
  const refreshAll = (): void =>
    void queryClient.invalidateQueries({ queryKey: ['dashboard', tab.id] })
  const addWidget = (): void => setEditing({ widget: newWidget(), isNew: true })

  const setDrag = (next: DragState | null): void => {
    dragRef.current = next
    setDragState(next)
  }

  /** Follows the pointer: swaps the dragged card into the slot of the card under it. */
  const dragTo = (x: number, y: number): void => {
    const d = dragRef.current
    if (!d) return
    const area = scroller.current?.getBoundingClientRect()
    if (area && y < area.top + SCROLL_EDGE) scroller.current!.scrollBy(0, -14)
    else if (area && y > area.bottom - SCROLL_EDGE) scroller.current!.scrollBy(0, 14)
    const over = d.order.find((id) => id !== d.id && contains(cards.current.get(id), x, y))
    if (!over) {
      setDrag({ ...d, x, y, lastSwap: contains(placeholder.current, x, y) ? null : d.lastSwap })
    } else if (over === d.lastSwap) {
      setDrag({ ...d, x, y })
    } else {
      setDrag({ ...d, x, y, order: dragOrder(d.order, d.id, over), lastSwap: over })
    }
  }

  const beginDrag = (widget: Widget, e: React.PointerEvent): void => {
    if (locked || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const card = cards.current.get(widget.id)
    if (!card) return
    const rect = card.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    let started = false
    const onMove = (ev: PointerEvent): void => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
        started = true
        document.body.style.cursor = 'grabbing'
        setDrag({
          id: widget.id,
          order: dashboard.widgets.map((w) => w.id),
          offsetX: startX - rect.left,
          offsetY: startY - rect.top,
          x: ev.clientX,
          y: ev.clientY,
          width: rect.width,
          height: rect.height,
          lastSwap: null
        })
      }
      dragTo(ev.clientX, ev.clientY)
    }
    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      document.body.style.cursor = ''
      const d = dragRef.current
      if (d && commit) setWidgets((list) => reorderWidgets(list, d.order))
      setDrag(null)
    }
    const onUp = (): void => finish(true)
    const onCancel = (): void => finish(false)
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
  }

  /** Drags a card's right edge across grid columns to change its width. */
  const beginResize = (widget: Widget, e: React.PointerEvent): void => {
    const el = grid.current
    const card = cards.current.get(widget.id)
    if (locked || e.button !== 0 || !el || !card) return
    e.preventDefault()
    e.stopPropagation()
    const style = getComputedStyle(el)
    const cols = style.gridTemplateColumns.split(' ').filter(Boolean).length
    if (cols < 2) return
    const gap = parseFloat(style.columnGap) || 0
    const colWidth = (el.clientWidth - gap * (cols - 1)) / cols
    const left = card.getBoundingClientRect().left
    let span = widget.span
    setResize({ id: widget.id, span })
    const onMove = (ev: PointerEvent): void => {
      const n = Math.max(
        1,
        Math.min(cols, Math.round((ev.clientX - left + gap) / (colWidth + gap)))
      )
      // Two columns only tell narrow from wide; keep a wide card's own width
      span = (cols >= 4 ? n : n === 1 ? 1 : Math.max(2, widget.span)) as WidgetSpan
      setResize({ id: widget.id, span })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.cursor = ''
      if (span !== widget.span) setWidgets((list) => upsertWidget(list, { ...widget, span }))
      setResize(null)
    }
    document.body.style.cursor = 'ew-resize'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const moreMenu: MenuItem[] = [
    {
      label: locked ? 'Unlock' : 'Lock',
      icon: locked ? <LockOpen /> : <Lock />,
      onSelect: () => setLocked(dashboard, !locked)
    },
    'separator',
    {
      label: 'Rename…',
      icon: <Pencil />,
      disabled: locked,
      onSelect: () => void renameDashboard(dashboard)
    },
    { label: 'Duplicate', icon: <Copy />, onSelect: () => duplicateDashboard(dashboard) },
    { label: 'Export…', icon: <Download />, onSelect: () => void exportDashboard(dashboard) },
    'separator',
    {
      label: 'Delete dashboard…',
      icon: <Trash2 />,
      danger: true,
      disabled: locked,
      onSelect: () => void removeDashboard(dashboard)
    }
  ]

  const byId = new Map(dashboard.widgets.map((w) => [w.id, w]))
  const ordered = drag ? drag.order.flatMap((id) => byId.get(id) ?? []) : dashboard.widgets
  const boardRect = drag ? board.current?.getBoundingClientRect() : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <button
          type="button"
          title={locked ? dashboard.name : 'Rename dashboard'}
          disabled={locked}
          onClick={() => void renameDashboard(dashboard)}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] font-medium text-bright enabled:hover:bg-hover"
        >
          <LayoutDashboard className="size-3.5 shrink-0 text-accent" />
          <span className="truncate">{dashboard.name}</span>
        </button>
        <ToolbarDivider />
        <ConnectionPicker
          value={dashboard.connectionId}
          disabled={locked}
          onChange={(id) =>
            updateDashboard(dashboard.id, { connectionId: id, database: defaultDatabase(id) })
          }
        />
        {connection ? (
          <DatabasePicker
            connectionId={dashboard.connectionId}
            value={dashboard.database}
            disabled={locked}
            onChange={(database) => updateDashboard(dashboard.id, { database })}
          />
        ) : null}
        <ToolbarDivider />
        <Button
          size="sm"
          variant="ghost"
          onClick={refreshAll}
          disabled={!dashboard.widgets.length}
          title="Refresh every widget"
        >
          <RefreshCw className={cn('size-3.5', fetching > 0 && 'animate-spin')} />
          Refresh
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="Refresh automatically while this tab is open"
          onClick={(e) =>
            showMenuAt(e.currentTarget, [
              { heading: 'Auto-refresh' },
              ...REFRESH_CHOICES.map((secs): MenuItem => ({
                label: secs ? `Every ${refreshLabel(secs)}` : 'Off',
                shortcut: secs === dashboard.refreshSecs ? '✓' : undefined,
                onSelect: () => updateDashboard(dashboard.id, { refreshSecs: secs })
              }))
            ])
          }
        >
          <Timer className={cn('size-3.5', dashboard.refreshSecs > 0 && 'text-accent')} />
          {refreshLabel(dashboard.refreshSecs)}
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          variant={locked ? 'secondary' : 'ghost'}
          title={
            locked
              ? 'Locked: widgets can be viewed and refreshed, not moved or edited. Click to unlock.'
              : 'Lock the dashboard so it can’t be changed by accident'
          }
          onClick={() => setLocked(dashboard, !locked)}
        >
          {locked ? <Lock className="size-3.5 text-accent" /> : <LockOpen className="size-3.5" />}
          {locked ? 'Locked' : 'Lock'}
        </Button>
        {!locked && (
          <Button size="sm" variant="primary" onClick={addWidget}>
            <Plus className="size-3.5" />
            Add widget
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          title="More"
          onClick={(e) => showMenuAt(e.currentTarget, moreMenu)}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </Toolbar>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto bg-canvas">
        {!connection ? (
          <EmptyState title="This dashboard’s connection no longer exists">
            {locked
              ? 'Unlock the dashboard, then pick another connection from the toolbar.'
              : 'Pick another connection from the toolbar; the widgets keep their queries.'}
          </EmptyState>
        ) : !dashboard.widgets.length ? (
          <EmptyState
            icon={<BarChart3 className="size-6" />}
            title="An empty dashboard"
            actions={
              locked ? (
                <Button onClick={() => setLocked(dashboard, false)}>
                  <LockOpen className="size-3.5" />
                  Unlock
                </Button>
              ) : (
                <Button variant="primary" onClick={addWidget}>
                  <Plus className="size-3.5" />
                  Add widget
                </Button>
              )
            }
          >
            Each widget runs a query on {dashboard.database || 'this database'} and shows the result
            as a number, a bar or line chart, or a table.
          </EmptyState>
        ) : (
          <div ref={board} className="@container relative p-4">
            <div ref={grid} className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-4">
              {ordered.map((widget, index) => {
                const dragging = drag?.id === widget.id
                const span = resize?.id === widget.id ? resize.span : widget.span
                return (
                  <Fragment key={widget.id}>
                    {dragging && (
                      <div
                        key="placeholder"
                        ref={placeholder}
                        className={cn(
                          'rounded-lg border-2 border-dashed border-accent/50 bg-accent/5',
                          heightClass(widget),
                          SPAN_CLASS[widget.span]
                        )}
                      />
                    )}
                    <WidgetCard
                      key="card"
                      cardRef={(el) => {
                        if (el) cards.current.set(widget.id, el)
                        else cards.current.delete(widget.id)
                      }}
                      widget={widget}
                      span={span}
                      dashboard={dashboard}
                      session={tab.id}
                      active={active}
                      locked={locked}
                      resizing={resize?.id === widget.id}
                      ghost={
                        dragging && drag && boardRect
                          ? {
                              left: drag.x - drag.offsetX - boardRect.left,
                              top: drag.y - drag.offsetY - boardRect.top,
                              width: drag.width,
                              height: drag.height
                            }
                          : undefined
                      }
                      onPointerDown={(e) => beginDrag(widget, e)}
                      onResizeStart={(e) => beginResize(widget, e)}
                      onEdit={() => setEditing({ widget, isNew: false })}
                      onChange={(w) => setWidgets((list) => upsertWidget(list, w))}
                      onMove={(delta) =>
                        setWidgets((list) => moveWidget(list, widget.id, index + delta))
                      }
                      isFirst={index === 0}
                      isLast={index === ordered.length - 1}
                      onDuplicate={() =>
                        setWidgets((list) => {
                          const copy = newWidget({
                            ...widget,
                            id: crypto.randomUUID(),
                            title: `${widget.title} copy`
                          })
                          return moveWidget([...list, copy], copy.id, index + 1)
                        })
                      }
                      onRemove={() => setWidgets((list) => list.filter((w) => w.id !== widget.id))}
                    />
                  </Fragment>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {editing && connection && !locked && (
        <WidgetEditor
          initial={editing.widget}
          isNew={editing.isNew}
          engine={connection.engine}
          connectionId={dashboard.connectionId}
          database={dashboard.database}
          session={tab.id}
          onClose={() => setEditing(null)}
          onSave={(widget) => {
            setWidgets((list) => upsertWidget(list, widget))
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function WidgetCard({
  cardRef,
  widget,
  span,
  dashboard,
  session,
  active,
  locked,
  resizing,
  ghost,
  isFirst,
  isLast,
  onPointerDown,
  onResizeStart,
  onEdit,
  onChange,
  onMove,
  onDuplicate,
  onRemove
}: {
  cardRef: (el: HTMLElement | null) => void
  widget: Widget
  /** The width shown, which differs from the widget's own while resizing */
  span: WidgetSpan
  dashboard: Dashboard
  session: string
  active: boolean
  locked: boolean
  resizing: boolean
  /** Set while the card is being dragged: it floats under the pointer */
  ghost?: { left: number; top: number; width: number; height: number }
  isFirst: boolean
  isLast: boolean
  onPointerDown: (e: React.PointerEvent) => void
  onResizeStart: (e: React.PointerEvent) => void
  onEdit: () => void
  onChange: (widget: Widget) => void
  onMove: (delta: number) => void
  onDuplicate: () => void
  onRemove: () => void
}): React.JSX.Element {
  const [asTable, setAsTable] = useState(false)
  const result = useQuery({
    queryKey: [
      'dashboard',
      session,
      dashboard.connectionId,
      dashboard.database,
      widget.query
    ] as const,
    queryFn: () =>
      runWidgetQuery(dashboard.connectionId, session, dashboard.database, widget.query),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    // Background tabs don't keep querying
    refetchInterval: active && dashboard.refreshSecs ? dashboard.refreshSecs * 1000 : false
  })
  const charted = widget.kind !== 'table'

  const viewItems: MenuItem[] = [
    { label: 'Refresh', icon: <RefreshCw />, onSelect: () => void result.refetch() },
    ...(charted
      ? [
          {
            label: asTable ? 'Show chart' : 'Show data',
            icon: asTable ? <BarChart3 /> : <Table2 />,
            onSelect: () => setAsTable((v) => !v)
          }
        ]
      : [])
  ]
  const menu: MenuItem[] = locked
    ? [...viewItems, 'separator', { label: 'Unlock the dashboard to edit', disabled: true }]
    : [
        { label: 'Edit…', icon: <Pencil />, onSelect: onEdit },
        ...viewItems,
        'separator',
        {
          label: 'Width',
          submenu: ([1, 2, 3, 4] as WidgetSpan[]).map((s) => ({
            label: SPAN_LABEL[s],
            shortcut: s === widget.span ? '✓' : undefined,
            onSelect: () => onChange({ ...widget, span: s })
          }))
        },
        {
          label: 'Move earlier',
          icon: <ArrowLeft />,
          disabled: isFirst,
          onSelect: () => onMove(-1)
        },
        { label: 'Move later', icon: <ArrowRight />, disabled: isLast, onSelect: () => onMove(1) },
        { label: 'Duplicate', icon: <Copy />, onSelect: onDuplicate },
        'separator',
        { label: 'Remove', icon: <Trash2 />, danger: true, onSelect: onRemove }
      ]

  const meta = result.data
    ? `${plural(result.data.set.rows.length, 'row')}${result.data.set.truncated ? ' (truncated)' : ''} · ${formatDuration(result.data.elapsedMs)}`
    : undefined

  return (
    <section
      ref={cardRef}
      style={ghost ? { position: 'absolute', ...ghost } : undefined}
      className={cn(
        'group relative flex min-w-0 flex-col rounded-lg border bg-panel p-3',
        heightClass(widget),
        SPAN_CLASS[span],
        ghost
          ? 'pointer-events-none z-20 rotate-[0.5deg] border-accent/50 shadow-2xl shadow-(color:--shadow)'
          : resizing
            ? 'border-accent/60'
            : 'border-line'
      )}
    >
      <header
        onPointerDown={onPointerDown}
        onContextMenu={(e) => showContextMenu(e, menu)}
        title={locked ? undefined : 'Drag to move'}
        className={cn(
          '-mt-1 mb-1.5 flex h-6 shrink-0 items-center gap-1',
          !locked && 'cursor-grab'
        )}
      >
        {!locked && (
          <GripVertical className="-ml-1.5 size-3.5 shrink-0 text-faint opacity-0 group-hover:opacity-100" />
        )}
        <h3 className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-bright" title={meta}>
          {widget.title || 'Untitled widget'}
        </h3>
        {result.isFetching && <Spinner className="size-3" />}
        <div className="flex items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          {charted && (
            <Button
              size="icon-sm"
              variant="ghost"
              title={asTable ? 'Show chart' : 'Show data'}
              onClick={() => setAsTable((v) => !v)}
            >
              {asTable ? <BarChart3 className="size-3.5" /> : <Table2 className="size-3.5" />}
            </Button>
          )}
          {!locked && (
            <Button size="icon-sm" variant="ghost" title="Edit widget" onClick={onEdit}>
              <Pencil className="size-3.5" />
            </Button>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            title="More"
            onClick={(e) => showMenuAt(e.currentTarget, menu)}
          >
            <MoreHorizontal className="size-3.5" />
          </Button>
        </div>
      </header>
      <div
        className={cn(
          'min-h-0 flex-1 transition-opacity',
          result.isFetching && result.data && 'opacity-60'
        )}
      >
        {result.error ? (
          <div className="flex h-full flex-col items-start gap-2 overflow-y-auto">
            <ErrorText error={result.error} />
            <div className="flex gap-1.5">
              <Button size="xs" onClick={() => void result.refetch()}>
                Retry
              </Button>
              {!locked && (
                <Button size="xs" variant="ghost" onClick={onEdit}>
                  Edit query
                </Button>
              )}
            </div>
          </div>
        ) : result.data ? (
          <WidgetBody widget={widget} set={result.data.set} asTable={asTable} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-4" />
          </div>
        )}
      </div>
      {resizing && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-canvas/40">
          <span className="rounded-md bg-raised px-2.5 py-1 text-[12px] font-medium text-bright shadow-lg ring-1 ring-line-strong">
            {SPAN_LABEL[span]} width
          </span>
        </div>
      )}
      {!locked && !ghost && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize widget"
          title="Drag to change the width"
          onPointerDown={onResizeStart}
          className="absolute top-3 -right-1.5 bottom-3 hidden w-3 cursor-ew-resize items-center justify-center @2xl:flex"
        >
          <span
            className={cn(
              'h-10 w-1 rounded-full transition-colors',
              resizing ? 'bg-accent' : 'bg-transparent group-hover:bg-line-strong hover:!bg-accent'
            )}
          />
        </div>
      )}
    </section>
  )
}
