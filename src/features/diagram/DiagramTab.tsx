import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Camera,
  Columns3,
  Copy,
  Download,
  EyeOff,
  FileDown,
  FileUp,
  FolderInput,
  LayoutGrid,
  ListChecks,
  Maximize,
  Minus,
  Link2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Table2,
  TableProperties,
  Trash2,
  Unlink,
  Wrench
} from 'lucide-react'
import { open as openDialog, save } from '@tauri-apps/plugin-dialog'
import { api, type ConnectionConfig, type DbObject } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  FONTS,
  boundsOf,
  buildEdges,
  layoutDiagram,
  nodeBox,
  tableKey,
  type ColumnMode,
  type DiagramTable,
  type Measure,
  type Point,
  type Rect
} from '@/lib/diagram'
import { parseLayout, serializeLayout, toDbml, toMermaid } from '@/lib/diagram-text'
import {
  dropForeignKey,
  hitTest,
  orientLink,
  type ColumnRef,
  type LinkSpec
} from '@/lib/diagram-edit'
import { ddlScript, newColumn, type TableDraft } from '@/lib/ddl'
import { qualified } from '@/lib/sql'
import { copyText } from '@/lib/export'
import { queries, queryClient } from '@/lib/queries'
import { createPersistentStore } from '@/lib/store'
import { TOKENS, type ThemeColors } from '@/lib/themes'
import { errorMessage, toast, toastError } from '@/lib/toast'
import {
  confirm,
  connect,
  connectionsStore,
  openTable,
  refreshConnection,
  statusStore,
  type TabOf
} from '@/lib/workspace'
import { showContextMenu } from '@/components/ContextMenu'
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Input,
  Modal,
  ProgressBar,
  Segmented,
  Spinner,
  Toolbar,
  ToolbarDivider
} from '@/components/ui'
import { DiagramScene, rectOf, rowY, type SceneProps } from './DiagramScene'
import { RelationshipDialog } from './RelationshipDialog'
import { openTableDesigner, type DesignerView } from '../table/TableDesigner'
import {
  ddlTarget,
  draftScript,
  draftSchemaFor,
  loadTableDraft,
  runDdl
} from '../table/designer-ops'
import {
  copyPng,
  exportPalette,
  saveExport,
  saveText,
  type ExportFormat,
  type ExportJob,
  type ExportStyle,
  type TextFormat
} from './exportDiagram'

/* ---------- Saved per-diagram state ---------- */

// Kept per connection in the app's state files (see persist.ts); layout files share them

interface DiagramPrefs {
  /** Positions of tables the user moved; the rest are laid out automatically */
  positions: Record<string, Point>
  hidden: string[]
  mode: ColumnMode
  showTypes: boolean
  views: boolean
}

const DEFAULT_PREFS: DiagramPrefs = {
  positions: {},
  hidden: [],
  mode: 'all',
  showTypes: true,
  views: false
}

const prefsStore = createPersistentStore<Record<string, DiagramPrefs>>('dbms.diagrams.v1', {})

function usePrefs(
  key: string
): [DiagramPrefs, (patch: (p: DiagramPrefs) => Partial<DiagramPrefs>) => void] {
  const prefs = { ...DEFAULT_PREFS, ...prefsStore.use()[key] }
  const update = useCallback(
    (patch: (p: DiagramPrefs) => Partial<DiagramPrefs>) =>
      prefsStore.set((all) => {
        const current = { ...DEFAULT_PREFS, ...all[key] }
        return { ...all, [key]: { ...current, ...patch(current) } }
      }),
    [key]
  )
  return [prefs, update]
}

/* ---------- Data ---------- */

const TABLE_KINDS = new Set(['table', 'foreign_table'])
const VIEW_KINDS = new Set(['view', 'materialized_view'])

async function loadTables(
  connectionId: string,
  database: string,
  schema: string | null,
  views: boolean,
  onProgress: (done: number, total: number) => void
): Promise<{ tables: DiagramTable[]; failed: string[] }> {
  const objects = await queryClient.fetchQuery(queries.objects(connectionId, database, schema))
  const wanted = objects.filter((o) => TABLE_KINDS.has(o.kind) || (views && VIEW_KINDS.has(o.kind)))
  const tables: DiagramTable[] = []
  const failed: string[] = []
  let next = 0
  let done = 0
  onProgress(0, wanted.length)
  const worker = async (): Promise<void> => {
    while (next < wanted.length) {
      const o: DbObject = wanted[next++]
      try {
        const info = await queryClient.fetchQuery(
          queries.table(connectionId, database, o.schema, o.name)
        )
        tables.push({
          key: tableKey(o.schema, o.name),
          schema: o.schema,
          name: o.name,
          kind: o.kind,
          ...info
        })
      } catch {
        failed.push(tableKey(o.schema, o.name))
      }
      onProgress(++done, wanted.length)
    }
  }
  // A few at a time keeps big schemas from flooding the connection
  await Promise.all(Array.from({ length: Math.min(6, wanted.length) }, worker))
  tables.sort((a, b) => a.key.localeCompare(b.key))
  return { tables, failed }
}

/* ---------- Text measurement ---------- */

function canvasMeasure(): Measure {
  const ctx = document.createElement('canvas').getContext('2d')
  const cache = new Map<string, number>()
  return (text, font) => {
    const id = `${font}\0${text}`
    let width = cache.get(id)
    if (width === undefined) {
      if (ctx) {
        ctx.font = font
        width = ctx.measureText(text).width
      } else width = text.length * 7
      cache.set(id, width)
    }
    return width
  }
}

function useFontsReady(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let live = true
    void Promise.all(Object.values(FONTS).map((f) => document.fonts.load(f)))
      .catch(() => {})
      .finally(() => live && setReady(true))
    return () => {
      live = false
    }
  }, [])
  return ready
}

/* ---------- Tab ---------- */

export function DiagramTab({ tab }: { tab: TabOf<'diagram'> }): React.JSX.Element {
  const connection = connectionsStore.use().find((c) => c.id === tab.connectionId)
  const status = statusStore.use()[tab.connectionId]
  useEffect(() => {
    if (connection && status?.state !== 'connected') void connect(connection.id)
  }, [connection, status?.state])
  if (!connection) return <EmptyState title="This connection no longer exists" />
  if (status?.state !== 'connected')
    return <EmptyState title="Connecting…" icon={<Spinner className="size-5" />} />
  return <DiagramView tab={tab} connection={connection} />
}

/** CSS variables, so the on-screen diagram follows theme changes live. */
const LIVE_PALETTE = Object.fromEntries(
  TOKENS.map(({ key }) => [key, `var(--color-${key})`])
) as ThemeColors

interface View {
  x: number
  y: number
  k: number
}

const MIN_ZOOM = 0.08
const MAX_ZOOM = 2.5
const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))

type Gesture =
  | { kind: 'pan'; startX: number; startY: number; view: View; moved: boolean }
  | { kind: 'drag'; key: string; startX: number; startY: number; origin: Point; moved: boolean }
  | { kind: 'link'; key: string; column: string; startX: number; startY: number; moved: boolean }

/** A relationship being drawn from a column's handle */
interface Linking {
  source: { key: string; column: string }
  /** Pointer, in diagram coordinates */
  point: Point
  target: ColumnRef | null
}

function DiagramView({
  tab,
  connection
}: {
  tab: TabOf<'diagram'>
  connection: ConnectionConfig
}): React.JSX.Element {
  const prefsKey = `${tab.connectionId}/${tab.database}/${tab.schema ?? ''}`
  const [prefs, setPrefs] = usePrefs(prefsKey)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const data = useQuery({
    queryKey: ['conn', tab.connectionId, 'diagram', tab.database, tab.schema, prefs.views],
    queryFn: () =>
      loadTables(tab.connectionId, tab.database, tab.schema, prefs.views, (done, total) =>
        setProgress({ done, total })
      )
  })

  const fontsReady = useFontsReady()
  const measure = useMemo(() => canvasMeasure(), [fontsReady])

  const hidden = useMemo(() => new Set(prefs.hidden), [prefs.hidden])
  const allTables = useMemo(() => data.data?.tables ?? [], [data.data])
  const tables = useMemo(() => allTables.filter((t) => !hidden.has(t.key)), [allTables, hidden])
  const edges = useMemo(
    () => buildEdges(tables, connection.engine === 'mysql' ? tab.database : undefined),
    [tables, connection.engine, tab.database]
  )
  // Without a schema in the tab the tables can span schemas, so name them in full
  const showSchema = useCallback(
    (t: DiagramTable) => tab.schema === null && !!t.schema && t.schema !== 'dbo',
    [tab.schema]
  )
  const boxes = useMemo(
    () =>
      new Map(
        tables.map((t) => [t.key, nodeBox(t, prefs.mode, prefs.showTypes, measure, showSchema(t))])
      ),
    [tables, prefs.mode, prefs.showTypes, measure, showSchema]
  )
  const auto = useMemo(() => layoutDiagram([...boxes.values()], edges), [boxes, edges])
  const [drag, setDrag] = useState<{ key: string; at: Point } | null>(null)
  const positions = useMemo(() => {
    const out: Record<string, Point> = { ...auto }
    for (const [key, at] of Object.entries(prefs.positions)) if (key in out) out[key] = at
    if (drag) out[drag.key] = drag.at
    return out
  }, [auto, prefs.positions, drag])

  const [selected, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return null
    return new Set(tables.filter((t) => t.key.toLowerCase().includes(q)).map((t) => t.key))
  }, [search, tables])

  /* ----- View transform ----- */

  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view

  const contentBounds = useCallback(
    (keys: string[] = tables.map((t) => t.key)): Rect =>
      boundsOf(keys.map((k) => rectOf(k, boxes, positions)).filter((r): r is Rect => !!r)),
    [tables, boxes, positions]
  )

  const fitTo = useCallback((b: Rect, maxZoom = 1) => {
    const el = containerRef.current
    if (!el || !b.width) return
    const { clientWidth: w, clientHeight: h } = el
    const k = clampZoom(Math.min(maxZoom, (w - 64) / b.width, (h - 64) / b.height))
    setView({ k, x: (w - b.width * k) / 2 - b.x * k, y: (h - b.height * k) / 2 - b.y * k })
  }, [])

  const fit = useCallback(() => fitTo(contentBounds()), [fitTo, contentBounds])

  // Fit once the first layout is ready
  const fitted = useRef(false)
  useLayoutEffect(() => {
    if (!fitted.current && tables.length && fontsReady) {
      fitted.current = true
      fit()
    }
  }, [tables.length, fontsReady, fit])

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

  /* ----- Pointer gestures ----- */

  const gesture = useRef<Gesture | null>(null)
  const [linking, setLinking] = useState<Linking | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)

  /** Client coordinates to diagram coordinates */
  const toDiagram = (clientX: number, clientY: number): Point => {
    const rect = containerRef.current?.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: (clientX - (rect?.left ?? 0) - v.x) / v.k,
      y: (clientY - (rect?.top ?? 0) - v.y) / v.k
    }
  }

  // Keyboard shortcuts act on the canvas once it's been clicked
  const focusCanvas = (): void => containerRef.current?.focus({ preventScroll: true })

  const onBackgroundDown = (e: React.PointerEvent): void => {
    focusCanvas()
    if (e.button !== 0 && e.button !== 1) return
    svgRef.current?.setPointerCapture(e.pointerId)
    gesture.current = {
      kind: 'pan',
      startX: e.clientX,
      startY: e.clientY,
      view: viewRef.current,
      moved: false
    }
  }

  const onNodeDown = useCallback(
    (key: string, e: React.PointerEvent) => {
      focusCanvas()
      if (e.button !== 0) return
      e.stopPropagation()
      svgRef.current?.setPointerCapture(e.pointerId)
      setSelected(key)
      setSelectedEdge(null)
      gesture.current = {
        kind: 'drag',
        key,
        startX: e.clientX,
        startY: e.clientY,
        origin: positions[key],
        moved: false
      }
    },
    [positions]
  )

  const onHandleDown = (key: string, column: string, e: React.PointerEvent): void => {
    focusCanvas()
    if (e.button !== 0) return
    e.stopPropagation()
    svgRef.current?.setPointerCapture(e.pointerId)
    setHover(null)
    setSelectedEdge(null)
    gesture.current = {
      kind: 'link',
      key,
      column,
      startX: e.clientX,
      startY: e.clientY,
      moved: false
    }
    setLinking({ source: { key, column }, point: toDiagram(e.clientX, e.clientY), target: null })
  }

  const onEdgeDown = (id: string, e: React.PointerEvent): void => {
    focusCanvas()
    if (e.button !== 0) return
    e.stopPropagation()
    setSelectedEdge(id)
    setSelected(null)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const g = gesture.current
    if (!g) return
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    if (!g.moved && Math.hypot(dx, dy) < 3) return
    g.moved = true
    if (g.kind === 'pan') setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy })
    else if (g.kind === 'link') {
      const point = toDiagram(e.clientX, e.clientY)
      let target = hitTest(tables, boxes, positions, prefs.mode, point)
      if (target && target.key === g.key && (target.column === g.column || target.column === null))
        target = null
      setLinking({ source: { key: g.key, column: g.column }, point, target })
    } else {
      const k = viewRef.current.k
      setDrag({
        key: g.key,
        at: { x: Math.round(g.origin.x + dx / k), y: Math.round(g.origin.y + dy / k) }
      })
    }
  }

  const onPointerUp = (): void => {
    const g = gesture.current
    gesture.current = null
    if (!g) return
    if (g.kind === 'pan' && !g.moved) {
      setSelected(null)
      setSelectedEdge(null)
    }
    if (g.kind === 'link') {
      const target = linking?.target
      setLinking(null)
      const link = target && orientLink({ key: g.key, column: g.column }, target, byKey)
      if (link) setRelationship(link)
      else if (g.moved) toast('Drop onto a column of another table to link them', 'info')
    }
    if (g.kind === 'drag' && drag) {
      const { key, at } = drag
      setPrefs((p) => ({ positions: { ...p.positions, [key]: at } }))
      setDrag(null)
    }
  }

  /* ----- Table actions ----- */

  const byKey = useMemo(() => new Map(allTables.map((t) => [t.key, t])), [allTables])

  const openData = useCallback(
    (key: string, view: 'data' | 'structure' = 'data') => {
      const t = byKey.get(key)
      if (t) openTable(tab.connectionId, tab.database, t.schema, t.name, t.kind, view)
    },
    [byKey, tab.connectionId, tab.database]
  )

  const setHidden = useCallback(
    (keys: string[], hide: boolean) =>
      setPrefs((p) => {
        const set = new Set(p.hidden)
        for (const k of keys) {
          if (hide) set.add(k)
          else set.delete(k)
        }
        return { hidden: [...set] }
      }),
    [setPrefs]
  )

  /* ----- Editing ----- */

  const target = useMemo(() => ddlTarget(connection, tab.database), [connection, tab.database])
  const editable = !!target && !connection.readOnly
  const [relationship, setRelationship] = useState<LinkSpec | null>(null)

  /** Pins every table where it is, so a schema change doesn't reshuffle the auto layout */
  const freezeLayout = useCallback(
    () => setPrefs((p) => ({ positions: { ...p.positions, ...positions } })),
    [setPrefs, positions]
  )

  /** Pins a table that was just created or renamed where the user wants it */
  const placeTable = useCallback(
    (key: string, at: Point | undefined, previous?: string) =>
      setPrefs((p) => {
        const positions = { ...p.positions }
        const from = previous ? (positions[previous] ?? auto[previous]) : undefined
        if (previous) delete positions[previous]
        const pin = at ?? from
        if (pin) positions[key] = pin
        return {
          positions,
          hidden: p.hidden.filter((h) => h !== key && h !== previous)
        }
      }),
    [setPrefs, auto]
  )

  const viewCentre = (): Point => {
    const el = containerRef.current
    const v = viewRef.current
    return el
      ? { x: (el.clientWidth / 2 - v.x) / v.k - 90, y: (el.clientHeight / 2 - v.y) / v.k - 60 }
      : { x: 0, y: 0 }
  }

  const newTable = (at: Point = viewCentre()): void => {
    if (!editable) return
    const spot = { x: Math.round(at.x), y: Math.round(at.y) }
    openTableDesigner(tab.connectionId, tab.database, tab.schema, null, {
      onApplied: ({ schema, name }) => {
        freezeLayout()
        placeTable(tableKey(schema, name), spot)
        setSelected(tableKey(schema, name))
      }
    })
  }

  const editTable = useCallback(
    (key: string, view: DesignerView = 'columns', seed?: (draft: TableDraft) => TableDraft) => {
      const t = byKey.get(key)
      if (!t || !editable) return
      openTableDesigner(tab.connectionId, tab.database, t.schema, t.name, {
        view,
        seed,
        onApplied: ({ schema, name, previous }) => {
          freezeLayout()
          const next = tableKey(schema, name)
          if (previous !== null && next !== key) {
            placeTable(next, undefined, key)
            setSelected(next)
          }
        }
      })
    },
    [byKey, editable, tab.connectionId, tab.database, placeTable, freezeLayout]
  )

  const addColumn = useCallback(
    (key: string) =>
      target &&
      editTable(key, 'columns', (d) => ({
        ...d,
        columns: [...d.columns, newColumn(target.dialect)]
      })),
    [editTable, target]
  )

  const dropTable = useCallback(
    async (key: string) => {
      const t = byKey.get(key)
      if (!t || !target || !editable) return
      const sql = ddlScript(
        target.dialect,
        [
          `DROP TABLE ${qualified(target.dialect, {
            schema: draftSchemaFor(target.dialect, target.mysql, tab.database, t.schema),
            name: t.name
          })}`
        ],
        target.options
      )
      const referencedBy = [
        ...new Set(edges.filter((e) => e.to === key && e.from !== key).map((e) => e.from))
      ]
      const ok = await confirm({
        title: `Drop ${t.name}?`,
        message: (
          <>
            The table and all its rows are deleted for good.
            {referencedBy.length > 0 && (
              <>
                {' '}
                {referencedBy.join(', ')} {referencedBy.length === 1 ? 'references' : 'reference'}{' '}
                it, which will stop the drop until those foreign keys are removed.
              </>
            )}
          </>
        ),
        code: sql,
        danger: true,
        confirmLabel: 'Drop table',
        typeToConfirm: t.name
      })
      if (!ok) return
      try {
        await runDdl(target, sql)
        freezeLayout()
        toast(`Dropped ${t.name}`)
        setSelected(null)
        refreshConnection(tab.connectionId)
      } catch (e) {
        toastError(e)
      }
    },
    [byKey, target, editable, edges, tab.connectionId, tab.database, freezeLayout]
  )

  const edgeById = useMemo(() => new Map(edges.map((e) => [e.id, e])), [edges])

  const dropRelationship = useCallback(
    async (id: string) => {
      const edge = edgeById.get(id)
      const t = edge && byKey.get(edge.from)
      if (!edge || !t || !target || !editable) return
      try {
        const loaded = await loadTableDraft(target, t.schema, t.name)
        const draft = dropForeignKey(loaded.draft, edge.name)
        if (!draft) throw new Error(`${t.name} no longer has the foreign key ${edge.name}`)
        const sql = draftScript(target, draft, loaded.versioning)
        const ok = await confirm({
          title: `Drop foreign key ${edge.name}?`,
          message: `${edge.from} (${edge.fromColumns.join(', ')}) will no longer reference ${edge.to} (${edge.toColumns.join(', ')}). The columns and their data stay.`,
          code: sql,
          danger: true,
          confirmLabel: 'Drop foreign key'
        })
        if (!ok) return
        await runDdl(target, sql)
        freezeLayout()
        toast(`Dropped ${edge.name}`)
        setSelectedEdge(null)
        refreshConnection(tab.connectionId)
      } catch (e) {
        toastError(e)
      }
    },
    [edgeById, byKey, target, editable, tab.connectionId, freezeLayout]
  )

  const onNodeMenu = useCallback(
    (key: string, e: React.MouseEvent) => {
      setSelected(key)
      setSelectedEdge(null)
      const t = byKey.get(key)
      const isTable = t?.kind === 'table'
      showContextMenu(e, [
        { heading: key },
        { label: 'Open data', icon: <Table2 />, onSelect: () => openData(key) },
        { label: 'Open structure', icon: <Wrench />, onSelect: () => openData(key, 'structure') },
        ...(editable && isTable
          ? [
              'separator' as const,
              {
                label: 'Edit table…',
                icon: <Pencil />,
                shortcut: 'Enter',
                onSelect: () => editTable(key)
              },
              { label: 'Add column…', icon: <Columns3 />, onSelect: () => addColumn(key) },
              {
                label: 'Add foreign key…',
                icon: <Link2 />,
                title: "Or drag a column's handle onto another table",
                onSelect: () => editTable(key, 'foreignKeys')
              },
              {
                label: 'Indexes…',
                icon: <TableProperties />,
                onSelect: () => editTable(key, 'indexes')
              }
            ]
          : []),
        'separator',
        { label: 'Hide from diagram', icon: <EyeOff />, onSelect: () => setHidden([key], true) },
        {
          label: 'Copy name',
          icon: <Copy />,
          onSelect: () => void copyText(t?.name ?? key, 'Name copied')
        },
        ...(editable && isTable
          ? [
              'separator' as const,
              {
                label: 'Drop table…',
                icon: <Trash2 />,
                danger: true,
                onSelect: () => void dropTable(key)
              }
            ]
          : [])
      ])
    },
    [byKey, openData, setHidden, editable, editTable, addColumn, dropTable]
  )

  const onEdgeMenu = (id: string, e: React.MouseEvent): void => {
    const edge = edgeById.get(id)
    if (!edge) return
    setSelectedEdge(id)
    setSelected(null)
    showContextMenu(e, [
      { heading: edge.name },
      ...(editable
        ? [
            {
              label: 'Edit foreign key…',
              icon: <Pencil />,
              shortcut: 'Enter',
              onSelect: () => editTable(edge.from, 'foreignKeys')
            },
            {
              label: 'Drop foreign key…',
              icon: <Unlink />,
              shortcut: 'Del',
              danger: true,
              onSelect: () => void dropRelationship(id)
            },
            'separator' as const
          ]
        : []),
      { label: `Go to ${edge.from}`, onSelect: () => focusTable(edge.from) },
      { label: `Go to ${edge.to}`, onSelect: () => focusTable(edge.to) },
      {
        label: 'Copy name',
        icon: <Copy />,
        onSelect: () => void copyText(edge.name, 'Name copied')
      }
    ])
  }

  const onBackgroundMenu = (e: React.MouseEvent): void => {
    const at = toDiagram(e.clientX, e.clientY)
    showContextMenu(e, [
      ...(editable
        ? [
            {
              label: 'New table here…',
              icon: <Plus />,
              shortcut: 'N',
              onSelect: () => newTable(at)
            },
            'separator' as const
          ]
        : []),
      { label: 'Fit to window', icon: <Maximize />, onSelect: fit },
      {
        label: 'Auto layout',
        icon: <LayoutGrid />,
        disabled: !Object.keys(prefs.positions).length,
        onSelect: autoLayout
      }
    ])
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return
    const handled = (): void => e.preventDefault()
    if (e.key === 'Escape') {
      if (gesture.current?.kind === 'link') {
        gesture.current = null
        setLinking(null)
      } else {
        setSelected(null)
        setSelectedEdge(null)
      }
      handled()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedEdge) void dropRelationship(selectedEdge)
      else if (selected) void dropTable(selected)
      handled()
    } else if (e.key === 'Enter') {
      const edge = selectedEdge && edgeById.get(selectedEdge)
      if (edge) editTable(edge.from, 'foreignKeys')
      else if (selected) editTable(selected)
      handled()
    } else if (e.key === 'n' || e.key === 'N') {
      newTable()
      handled()
    } else if (e.key === 'f') {
      fit()
      handled()
    }
  }

  const focusTable = (key: string): void => {
    setSelected(key)
    const r = rectOf(key, boxes, positions)
    if (r) fitTo({ x: r.x - 200, y: r.y - 120, width: r.width + 400, height: r.height + 240 })
  }

  /** Preview of the relationship being drawn, from the source row to the pointer or target row */
  const linkPreview = ((): React.JSX.Element | null => {
    if (!linking) return null
    const from = rectOf(linking.source.key, boxes, positions)
    const source = byKey.get(linking.source.key)
    if (!from || !source) return null
    const sy = rowY(source, linking.source.column, prefs.mode, from.y)
    let end = linking.point
    const t = linking.target
    const to = t && rectOf(t.key, boxes, positions)
    const targetTable = t && byKey.get(t.key)
    if (t && to && targetTable) {
      const right = linking.point.x > to.x + to.width / 2
      end = {
        x: right ? to.x + to.width : to.x,
        y: t.column ? rowY(targetTable, t.column, prefs.mode, to.y) : to.y + 17
      }
    }
    const sx = end.x > from.x + from.width / 2 ? from.x + from.width : from.x
    const dir = end.x >= sx ? 1 : -1
    const reach = Math.max(40, Math.min(160, Math.abs(end.x - sx) / 2))
    return (
      <g pointerEvents="none">
        <path
          d={`M ${sx} ${sy} C ${sx + dir * reach} ${sy}, ${end.x - dir * reach} ${end.y}, ${end.x} ${end.y}`}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={1.8}
          strokeDasharray={t ? undefined : '6 4'}
        />
        <circle cx={sx} cy={sy} r={4} fill="var(--color-accent)" />
        <circle
          cx={end.x}
          cy={end.y}
          r={t ? 4.5 : 3.5}
          fill={t ? 'var(--color-accent)' : 'var(--color-raised)'}
          stroke="var(--color-accent)"
          strokeWidth={1.5}
        />
      </g>
    )
  })()

  /* ----- Export ----- */

  const [panel, setPanel] = useState(false)
  const [exporting, setExporting] = useState(false)

  const sceneProps: Omit<SceneProps, 'palette'> = {
    tables,
    edges,
    boxes,
    positions,
    mode: prefs.mode,
    showTypes: prefs.showTypes,
    showSchema,
    measure
  }

  const title = tab.schema ? `${tab.database}.${tab.schema}` : tab.database

  const job = (area: 'all' | 'visible', style: ExportStyle, scale: number): ExportJob => {
    const palette = exportPalette(style)
    let rect: Rect
    if (area === 'visible' && containerRef.current) {
      const { clientWidth: w, clientHeight: h } = containerRef.current
      rect = { x: -view.x / view.k, y: -view.y / view.k, width: w / view.k, height: h / view.k }
    } else {
      const b = contentBounds()
      const pad = 32
      rect = { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }
    }
    return {
      scene: <DiagramScene {...sceneProps} palette={palette} />,
      area: rect,
      background: palette.canvas,
      title: `${title} schema`,
      // A screenshot of the view keeps what's on screen at the zoom it's shown at
      scale: area === 'visible' ? scale * view.k : scale
    }
  }

  const screenshot = (): void =>
    void copyPng(job('visible', 'theme', window.devicePixelRatio || 1)).catch(toastError)

  const text = (format: TextFormat): string =>
    format === 'dbml' ? toDbml(tables, edges) : toMermaid(tables, edges)

  /* ----- Layout files ----- */

  const saveLayout = async (): Promise<void> => {
    const path = await save({
      defaultPath: `${title.replace(/[^\w.-]+/g, '_')}-layout.json`,
      filters: [{ name: 'Diagram layout', extensions: ['json'] }]
    })
    if (!path) return
    // Pin every table where it is now, so the file looks the same wherever it's opened
    const pinned: Record<string, Point> = {}
    for (const t of allTables) if (positions[t.key]) pinned[t.key] = positions[t.key]
    await api.writeText(
      path,
      serializeLayout(
        { ...prefs, positions: pinned },
        { database: tab.database, schema: tab.schema }
      )
    )
    toast(`Saved ${path.split(/[\\/]/).pop()}`)
  }

  const openLayout = async (): Promise<void> => {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: 'Diagram layout', extensions: ['json'] }]
    })
    if (typeof path !== 'string') return
    const layout = parseLayout(await api.readText(path))
    // Tables this schema doesn't have are ignored when the diagram is drawn
    const known = new Set(allTables.map((t) => t.key))
    const listed = Object.keys(layout.positions)
    const matched = listed.filter((k) => known.has(k)).length
    setPrefs(() => ({
      positions: layout.positions,
      hidden: layout.hidden,
      mode: layout.mode,
      showTypes: layout.showTypes,
      views: layout.views
    }))
    fitted.current = false
    if (listed.length && !matched) toast("None of the layout's tables are in this diagram", 'info')
    else toast(`Loaded the layout for ${matched} ${matched === 1 ? 'table' : 'tables'}`)
  }

  const layoutMenu = (e: React.MouseEvent): void =>
    showContextMenu(e, [
      {
        label: 'Save layout to file…',
        icon: <FileDown />,
        disabled: !allTables.length,
        onSelect: () => void saveLayout().catch(toastError)
      },
      {
        label: 'Open layout file…',
        icon: <FileUp />,
        onSelect: () => void openLayout().catch(toastError)
      }
    ])

  /* ----- Render ----- */

  const autoLayout = (): void => {
    setPrefs(() => ({ positions: {} }))
    fitted.current = false
  }

  const refresh = (): void => {
    for (const kind of ['objects', 'table', 'diagram'])
      void queryClient.invalidateQueries({
        queryKey: ['conn', tab.connectionId, kind, tab.database]
      })
  }

  const failed = data.data?.failed ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <Network className="ml-1 size-4 text-syn-keyword" />
        <span className="mr-1 truncate text-[12.5px] font-medium text-bright">{title}</span>
        <ToolbarDivider />
        <Segmented
          size="sm"
          value={prefs.mode}
          onChange={(mode) => setPrefs(() => ({ mode }))}
          options={[
            { value: 'all', label: 'All columns' },
            { value: 'keys', label: 'Keys', title: 'Primary and foreign key columns only' },
            { value: 'none', label: 'Names', title: 'Table names only' }
          ]}
        />
        <Button
          size="xs"
          variant={prefs.showTypes ? 'secondary' : 'ghost'}
          disabled={prefs.mode === 'none'}
          onClick={() => setPrefs((p) => ({ showTypes: !p.showTypes }))}
        >
          Types
        </Button>
        <Button
          size="xs"
          variant={prefs.views ? 'secondary' : 'ghost'}
          onClick={() => setPrefs((p) => ({ views: !p.views }))}
          title="Include views"
        >
          Views
        </Button>
        <ToolbarDivider />
        <div className="relative w-48 min-w-24">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches?.size) focusTable([...matches][0])
              if (e.key === 'Escape') setSearch('')
            }}
            placeholder="Find table"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <div className="flex-1" />
        {editable && (
          <Button size="xs" variant="ghost" title="New table (N)" onClick={() => newTable()}>
            <Plus className="size-3.5" />
            Table
          </Button>
        )}
        <Button
          size="icon"
          variant={panel ? 'secondary' : 'ghost'}
          title="Choose tables"
          onClick={() => setPanel((p) => !p)}
        >
          <ListChecks className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Auto layout (forget moved tables)"
          disabled={!Object.keys(prefs.positions).length}
          onClick={autoLayout}
        >
          <LayoutGrid className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" title="Share layout" onClick={layoutMenu}>
          <FolderInput className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" title="Refresh" onClick={refresh}>
          <RefreshCw className="size-4" />
        </Button>
        <ToolbarDivider />
        <Button size="icon" variant="ghost" title="Zoom out" onClick={() => zoomAt(1 / 1.25)}>
          <Minus className="size-4" />
        </Button>
        <button
          type="button"
          title="Reset zoom to 100%"
          onClick={() => zoomAt(1 / view.k)}
          className="w-11 text-center text-xs text-muted tabular-nums hover:text-bright"
        >
          {Math.round(view.k * 100)}%
        </button>
        <Button size="icon" variant="ghost" title="Zoom in" onClick={() => zoomAt(1.25)}>
          <Plus className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" title="Fit to window" onClick={fit}>
          <Maximize className="size-4" />
        </Button>
        <ToolbarDivider />
        <Button
          size="icon"
          variant="ghost"
          title="Copy what's on screen as an image"
          disabled={!tables.length}
          onClick={screenshot}
        >
          <Camera className="size-4" />
        </Button>
        <Button size="sm" disabled={!tables.length} onClick={() => setExporting(true)}>
          <Download className="size-3.5" />
          Export
        </Button>
      </Toolbar>
      <ProgressBar active={data.isFetching} />
      <div className="flex min-h-0 flex-1">
        <div
          ref={containerRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="relative min-w-0 flex-1 overflow-hidden bg-canvas bg-dots outline-none"
          style={{
            backgroundPosition: `${view.x}px ${view.y}px`,
            backgroundSize: `${18 * view.k}px ${18 * view.k}px`
          }}
        >
          {data.isPending ? (
            <EmptyState
              className="bg-transparent"
              icon={<Spinner className="size-5" />}
              title="Reading the schema…"
            >
              {progress && progress.total > 0 && `${progress.done} of ${progress.total} tables`}
            </EmptyState>
          ) : data.isError ? (
            <EmptyState className="bg-transparent" title="Couldn't load the schema">
              <ErrorText error={data.error} />
            </EmptyState>
          ) : !allTables.length ? (
            <EmptyState
              className="bg-transparent"
              icon={<Network className="size-6" />}
              title="No tables"
              actions={
                editable && (
                  <Button size="sm" variant="primary" onClick={() => newTable({ x: 0, y: 0 })}>
                    <Plus className="size-3.5" /> New table
                  </Button>
                )
              }
            >
              {prefs.views ? 'This schema has no tables or views.' : 'This schema has no tables.'}
            </EmptyState>
          ) : !tables.length ? (
            <EmptyState
              className="bg-transparent"
              title="Every table is hidden"
              actions={
                <Button size="sm" onClick={() => setPrefs(() => ({ hidden: [] }))}>
                  Show all tables
                </Button>
              }
            />
          ) : (
            <svg
              ref={svgRef}
              className="absolute inset-0 size-full touch-none"
              onPointerDown={onBackgroundDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onContextMenu={onBackgroundMenu}
              style={linking ? { cursor: 'crosshair' } : undefined}
            >
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                <DiagramScene
                  {...sceneProps}
                  palette={LIVE_PALETTE}
                  focus={hover ?? selected}
                  selected={selected}
                  matches={matches}
                  onNodePointerDown={onNodeDown}
                  onNodeDoubleClick={openData}
                  onNodeContextMenu={onNodeMenu}
                  onNodeHover={setHover}
                  hovered={hover}
                  linkSource={linking?.source}
                  linkTarget={linking?.target}
                  selectedEdge={hoverEdge ?? selectedEdge}
                  onEdgePointerDown={onEdgeDown}
                  onEdgeContextMenu={onEdgeMenu}
                  onEdgeHover={setHoverEdge}
                  {...(editable && {
                    onHandlePointerDown: onHandleDown,
                    onColumnDoubleClick: (key: string) => editTable(key),
                    onEditTable: (key: string) => editTable(key)
                  })}
                />
                {linkPreview}
              </g>
            </svg>
          )}
          {data.isSuccess && allTables.length > 0 && (
            <div className="pointer-events-none absolute bottom-2 left-3 flex items-center gap-2 text-[11px] text-muted">
              <span>
                {tables.length} {tables.length === 1 ? 'table' : 'tables'} · {edges.length}{' '}
                {edges.length === 1 ? 'relationship' : 'relationships'}
              </span>
              {hidden.size > 0 && <Badge>{hidden.size} hidden</Badge>}
              {failed.length > 0 && (
                <Badge tone="warning" title={failed.join('\n')}>
                  {failed.length} couldn't be read
                </Badge>
              )}
              <span className="text-faint">
                {editable
                  ? "Drag a column's dot onto another column to link · Right-click to edit · Ctrl+scroll to zoom"
                  : 'Drag tables to arrange · Ctrl+scroll to zoom'}
              </span>
            </div>
          )}
        </div>
        {panel && (
          <TablePanel
            tables={allTables}
            hidden={hidden}
            onToggle={setHidden}
            onFocus={(key) => !hidden.has(key) && focusTable(key)}
          />
        )}
      </div>
      {relationship && target && (
        <RelationshipDialog
          target={target}
          link={relationship}
          byKey={byKey}
          label={(t) => (showSchema(t) && t.schema ? `${t.schema}.${t.name}` : t.name)}
          onChanged={freezeLayout}
          onClose={() => setRelationship(null)}
        />
      )}
      {exporting && (
        <ExportDialog name={title} onClose={() => setExporting(false)} job={job} text={text} />
      )}
    </div>
  )
}

/* ---------- Table chooser ---------- */

function TablePanel({
  tables,
  hidden,
  onToggle,
  onFocus
}: {
  tables: DiagramTable[]
  hidden: Set<string>
  onToggle: (keys: string[], hide: boolean) => void
  onFocus: (key: string) => void
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const q = filter.trim().toLowerCase()
  const shown = tables.filter((t) => !q || t.key.toLowerCase().includes(q))
  const keys = shown.map((t) => t.key)
  return (
    <aside className="flex w-60 shrink-0 flex-col border-l border-line bg-panel">
      <div className="space-y-2 border-b border-line p-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables"
          className="h-7 text-xs"
        />
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={() => onToggle(keys, false)}>
            Show {q ? 'matching' : 'all'}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => onToggle(keys, true)}>
            Hide {q ? 'matching' : 'all'}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {shown.map((t) => (
          <label
            key={t.key}
            className="flex items-center gap-2 px-3 py-1 text-xs text-fg hover:bg-hover"
            onDoubleClick={() => onFocus(t.key)}
          >
            <input
              type="checkbox"
              checked={!hidden.has(t.key)}
              onChange={(e) => onToggle([t.key], !e.target.checked)}
              className="accent-(--color-accent)"
            />
            <span className={cn('truncate', hidden.has(t.key) && 'text-faint')} title={t.key}>
              {t.key}
            </span>
          </label>
        ))}
      </div>
    </aside>
  )
}

/* ---------- Export dialog ---------- */

function Option({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted">{label}</div>
      {children}
    </div>
  )
}

function ExportDialog({
  name,
  job,
  text,
  onClose
}: {
  name: string
  job: (area: 'all' | 'visible', style: ExportStyle, scale: number) => ExportJob
  /** The shown tables as a DBML or Mermaid document */
  text: (format: TextFormat) => string
  onClose: () => void
}): React.JSX.Element {
  const [format, setFormat] = useState<ExportFormat | TextFormat>('png')
  const textFormat = format === 'dbml' || format === 'mermaid' ? format : null
  const [area, setArea] = useState<'all' | 'visible'>('all')
  const [style, setStyle] = useState<ExportStyle>('theme')
  const [scale, setScale] = useState<'1' | '2' | '3'>('2')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if ((await action()) !== false) onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const fileName = `${name.replace(/[^\w.-]+/g, '_')}-diagram`

  return (
    <Modal
      title="Export diagram"
      description="Save the diagram as an image, PDF, DBML or Mermaid, or copy it to the clipboard."
      onClose={onClose}
      icon={<Download className="mt-0.5 size-4 text-accent" />}
      footer={
        <>
          {busy && <Spinner className="mr-auto size-4" />}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {(format === 'png' || textFormat) && (
            <Button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  textFormat
                    ? navigator.clipboard
                        .writeText(text(textFormat))
                        .then(() => toast('Copied to the clipboard'))
                    : copyPng(job(area, style, +scale))
                )
              }
            >
              <Copy className="size-3.5" />
              Copy
            </Button>
          )}
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void run(() =>
                textFormat
                  ? saveText(text(textFormat), textFormat, fileName)
                  : saveExport(job(area, style, +scale), format as ExportFormat, fileName)
              )
            }
          >
            Save…
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Option label="Format">
          <Segmented
            value={format}
            onChange={setFormat}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'svg', label: 'SVG', title: 'Vector image, scales without blurring' },
              { value: 'pdf', label: 'PDF' },
              {
                value: 'dbml',
                label: 'DBML',
                title: 'Schema as code, for dbdiagram.io and dbdocs'
              },
              {
                value: 'mermaid',
                label: 'Mermaid',
                title: 'An erDiagram for Markdown on GitHub, GitLab and Notion'
              }
            ]}
          />
        </Option>
        {textFormat ? (
          <p className="text-xs text-muted">
            The tables, columns{textFormat === 'dbml' ? ', indexes' : ''} and relationships shown in
            the diagram; hidden tables are left out.
          </p>
        ) : (
          <>
            <Option label="Area">
              <Segmented
                value={area}
                onChange={setArea}
                options={[
                  { value: 'all', label: 'Whole diagram' },
                  { value: 'visible', label: 'Visible area' }
                ]}
              />
            </Option>
            <Option label="Colours">
              <Segmented
                value={style}
                onChange={setStyle}
                options={[
                  { value: 'theme', label: 'Current theme' },
                  {
                    value: 'light',
                    label: 'Light',
                    title: 'Dark text on white, for documents and print'
                  }
                ]}
              />
            </Option>
            {format !== 'svg' && (
              <Option label="Resolution">
                <Segmented
                  value={scale}
                  onChange={setScale}
                  options={[
                    { value: '1', label: '1×' },
                    { value: '2', label: '2×' },
                    { value: '3', label: '3×' }
                  ]}
                />
              </Option>
            )}
          </>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
