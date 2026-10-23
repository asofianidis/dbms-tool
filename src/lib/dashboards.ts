import type { Cell, ResultSet } from './api'
import type { Dialect } from './engines'
import { isNumericType, splitStatements } from './sql'
import { createPersistentStore } from './store'

/* ---------- Model ---------- */

export type WidgetKind = 'stat' | 'bar' | 'line' | 'table'

/** Columns of the dashboard grid a widget spans. */
export type WidgetSpan = 1 | 2 | 3 | 4

export interface Widget {
  id: string
  title: string
  kind: WidgetKind
  /** SQL, or a mongosh find()/aggregate() on MongoDB connections */
  query: string
  /** Category / time column; null picks the first text column */
  x: string | null
  /** Value columns; empty picks every numeric column */
  y: string[]
  span: WidgetSpan
}

/** A grid of query-backed widgets over one database. */
export interface Dashboard {
  id: string
  name: string
  connectionId: string
  database: string
  widgets: Widget[]
  /** Seconds between automatic refreshes; 0 for manual only */
  refreshSecs: number
  /** Locked dashboards can be viewed and refreshed but not rearranged or edited */
  locked?: boolean
  /**
   * Imported from a file and not yet approved. MongoDB widget queries are
   * JavaScript, so nothing runs until the user has read them.
   */
  unreviewed?: boolean
  createdAt: number
  updatedAt: number
}

export const dashboardsStore = createPersistentStore<Dashboard[]>('dbms.dashboards.v1', [])

export const REFRESH_CHOICES = [0, 30, 60, 300, 900] as const

/** Series past this fold away: the categorical palette has eight slots. */
export const MAX_SERIES = 8

export function newWidget(patch: Partial<Widget> = {}): Widget {
  return {
    id: crypto.randomUUID(),
    title: '',
    kind: 'bar',
    query: '',
    x: null,
    y: [],
    span: 2,
    ...patch
  }
}

export function createDashboard(
  list: Dashboard[],
  init: Pick<Dashboard, 'name' | 'connectionId' | 'database'> & Partial<Dashboard>,
  now = Date.now()
): { list: Dashboard[]; dashboard: Dashboard } {
  const dashboard: Dashboard = {
    widgets: [],
    refreshSecs: 0,
    ...init,
    name: init.name.trim(),
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now
  }
  return { list: [...list, dashboard], dashboard }
}

export function findDashboardByName(list: Dashboard[], name: string): Dashboard | undefined {
  const key = name.trim().toLowerCase()
  return list.find((d) => d.name.toLowerCase() === key)
}

/** `base`, or `base 2`, `base 3`… when that name is taken. */
export function uniqueDashboardName(list: Dashboard[], base: string): string {
  const name = base.trim() || 'Dashboard'
  if (!findDashboardByName(list, name)) return name
  let n = 2
  while (findDashboardByName(list, `${name} ${n}`)) n++
  return `${name} ${n}`
}

export function sortDashboards(list: Dashboard[]): Dashboard[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export function getDashboard(id: string): Dashboard | undefined {
  return dashboardsStore.get().find((d) => d.id === id)
}

export function updateDashboard(
  id: string,
  patch: Partial<Omit<Dashboard, 'id' | 'createdAt'>> | ((d: Dashboard) => Partial<Dashboard>)
): void {
  dashboardsStore.set((list) =>
    list.map((d) =>
      d.id === id
        ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch), updatedAt: Date.now() }
        : d
    )
  )
}

export function deleteDashboard(id: string): void {
  dashboardsStore.set((list) => list.filter((d) => d.id !== id))
}

/** Replaces the widget with the same id, or appends it. */
export function upsertWidget(widgets: Widget[], widget: Widget): Widget[] {
  return widgets.some((w) => w.id === widget.id)
    ? widgets.map((w) => (w.id === widget.id ? widget : w))
    : [...widgets, widget]
}

export function moveWidget(widgets: Widget[], id: string, toIndex: number): Widget[] {
  const from = widgets.findIndex((w) => w.id === id)
  if (from < 0) return widgets
  const next = [...widgets]
  const [widget] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, widget)
  return next
}

/** Puts widgets in the order of `ids`; widgets missing from `ids` keep their place at the end. */
export function reorderWidgets(widgets: Widget[], ids: string[]): Widget[] {
  const byId = new Map(widgets.map((w) => [w.id, w]))
  const ordered = ids.flatMap((id) => byId.get(id) ?? [])
  return [...ordered, ...widgets.filter((w) => !ids.includes(w.id))]
}

/** Moves `id` into `target`'s slot, the way sortable lists do while dragging. */
export function dragOrder(ids: string[], id: string, target: string): string[] {
  const to = ids.indexOf(target)
  if (to < 0 || !ids.includes(id) || id === target) return ids
  const next = ids.filter((i) => i !== id)
  next.splice(to, 0, id)
  return next
}

/* ---------- Files ---------- */

const FILE_FORMAT = 'dbms-dashboard'

/** Connections are machine-local, so a file carries the layout and queries only. */
export function serializeDashboard(dashboard: Dashboard): string {
  return JSON.stringify(
    {
      format: FILE_FORMAT,
      version: 1,
      name: dashboard.name,
      database: dashboard.database,
      refreshSecs: dashboard.refreshSecs,
      widgets: dashboard.widgets.map(({ id: _, ...w }) => w)
    },
    null,
    2
  )
}

const KINDS: WidgetKind[] = ['stat', 'bar', 'line', 'table']

export function parseDashboardFile(
  text: string
): Pick<Dashboard, 'name' | 'database' | 'refreshSecs' | 'widgets'> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('This file is not valid JSON')
  }
  const data = raw as Record<string, unknown>
  if (!data || data.format !== FILE_FORMAT || !Array.isArray(data.widgets))
    throw new Error('This file is not an exported dashboard')
  const widgets = data.widgets.map((item: unknown): Widget => {
    const w = (item ?? {}) as Record<string, unknown>
    const span = Number(w.span)
    return newWidget({
      title: typeof w.title === 'string' ? w.title : '',
      kind: KINDS.includes(w.kind as WidgetKind) ? (w.kind as WidgetKind) : 'table',
      query: typeof w.query === 'string' ? w.query : '',
      x: typeof w.x === 'string' ? w.x : null,
      y: Array.isArray(w.y) ? w.y.filter((c): c is string => typeof c === 'string') : [],
      span: span >= 1 && span <= 4 ? (Math.round(span) as WidgetSpan) : 2
    })
  })
  const refresh = Number(data.refreshSecs)
  return {
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'Dashboard',
    database: typeof data.database === 'string' ? data.database : '',
    refreshSecs: Number.isFinite(refresh) && refresh > 0 ? refresh : 0,
    widgets
  }
}

/* ---------- Safety ---------- */

const WRITE_STATEMENT =
  /^(insert|update|delete|merge|upsert|replace|drop|alter|create|truncate|rename|grant|revoke|call|exec|execute|do|copy|load|vacuum|reindex|cluster|lock|set|use|begin|commit|rollback)\b/i

/**
 * The first statement that isn't a plain read, if any. Widgets re-run on every
 * refresh, so they're limited to queries that can't change anything.
 */
export function writeStatement(sql: string, dialect: Dialect): string | null {
  for (const statement of splitStatements(sql, dialect)) {
    const s = statement.text
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .trim()
    if (!s) continue
    const keyword = WRITE_STATEMENT.exec(s)?.[1]
    if (keyword) return keyword.toUpperCase()
    // Data-modifying CTEs: WITH x AS (DELETE … RETURNING …) SELECT …
    if (/^with\b/i.test(s) && /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i.test(s))
      return 'WITH … (data-modifying)'
  }
  return null
}

/* ---------- Shaping results for charts ---------- */

export function toNumber(cell: Cell): number | null {
  if (typeof cell !== 'string') return null
  const text = cell.trim()
  if (!text) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/** Columns whose type is numeric, or whose sampled values all parse as numbers. */
export function numericColumns(set: Pick<ResultSet, 'columns' | 'rows'>): string[] {
  const sample = set.rows.slice(0, 200)
  return set.columns
    .filter((column, i) => {
      if (isNumericType(column.typeName) && !/^bit\b/i.test(column.typeName)) return true
      let seen = false
      for (const row of sample) {
        const cell = row[i]
        if (cell == null || cell === '') continue
        if (toNumber(cell) === null) return false
        seen = true
      }
      return seen && !/date|time|uuid|char|text|string|objectid/i.test(column.typeName)
    })
    .map((c) => c.name)
}

const TEMPORAL_TYPE = /date|time|timestamp|year/i
const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?/

function isTemporal(set: Pick<ResultSet, 'columns' | 'rows'>, name: string): boolean {
  const i = set.columns.findIndex((c) => c.name === name)
  if (i < 0) return false
  if (TEMPORAL_TYPE.test(set.columns[i].typeName)) return true
  const values = set.rows.slice(0, 50).map((r) => r[i])
  return values.some((v) => v != null) && values.every((v) => v == null || ISO_DATE.test(String(v)))
}

/** Picks columns, and a widget kind, that suit a fresh result. */
export function guessMapping(set: Pick<ResultSet, 'columns' | 'rows'>): {
  kind: WidgetKind
  x: string | null
  y: string[]
} {
  const numeric = numericColumns(set)
  const x =
    set.columns.find((c) => !numeric.includes(c.name))?.name ??
    (numeric.length > 1 ? numeric[0] : null)
  const y = numeric.filter((n) => n !== x).slice(0, MAX_SERIES)
  if (!y.length) return { kind: 'table', x, y }
  if (set.rows.length === 1 && (!x || y.length === 1)) return { kind: 'stat', x, y: y.slice(0, 1) }
  if (x && isTemporal(set, x)) return { kind: 'line', x, y }
  return { kind: x ? 'bar' : 'table', x, y }
}

export interface Series {
  name: string
  values: (number | null)[]
}

export interface ChartData {
  labels: string[]
  series: Series[]
  /** Value columns left out past MAX_SERIES */
  hiddenSeries: number
}

/** Resolves the widget's columns against a result; unset columns fall back to `guessMapping`. */
export function resolveColumns(
  set: Pick<ResultSet, 'columns' | 'rows'>,
  widget: Pick<Widget, 'x' | 'y'>
): { x: string | null; y: string[] } {
  const names = new Set(set.columns.map((c) => c.name))
  const guess = guessMapping(set)
  const x = widget.x && names.has(widget.x) ? widget.x : guess.x
  const y = widget.y.filter((c) => names.has(c) && c !== x)
  return { x, y: y.length ? y : guess.y.filter((c) => c !== x) }
}

export function chartData(
  set: Pick<ResultSet, 'columns' | 'rows'>,
  x: string | null,
  y: string[]
): ChartData {
  const xi = x ? set.columns.findIndex((c) => c.name === x) : -1
  const shown = y.slice(0, MAX_SERIES)
  return {
    labels: set.rows.map((row, i) =>
      xi < 0 ? String(i + 1) : row[xi] == null ? '(null)' : String(row[xi])
    ),
    series: shown.map((name) => {
      const i = set.columns.findIndex((c) => c.name === name)
      return { name, values: set.rows.map((row) => (i < 0 ? null : toNumber(row[i]))) }
    }),
    hiddenSeries: Math.max(0, y.length - shown.length)
  }
}

/** The headline value: the first value column of the first row. */
export function statValue(
  set: Pick<ResultSet, 'columns' | 'rows'>,
  y: string[]
): { value: number | null; text: string; column: string | null } {
  const column = y[0] ?? set.columns[0]?.name ?? null
  const i = set.columns.findIndex((c) => c.name === column)
  const cell = i < 0 ? null : (set.rows[0]?.[i] ?? null)
  return {
    value: toNumber(cell),
    text: cell == null ? '—' : typeof cell === 'boolean' ? String(cell) : cell,
    column
  }
}

/** Round axis ticks spanning [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0]
  if (min === max) {
    if (min === 0) return [0, 1]
    const pad = Math.abs(min) * 0.1
    return niceTicks(min - pad, max + pad, count)
  }
  const raw = (max - min) / Math.max(1, count - 1)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * magnitude >= raw) ?? 10) * magnitude
  const start = Math.floor(min / step) * step
  const ticks: number[] = []
  // Keep going until a tick covers the maximum, so marks never overflow the axis
  for (let v = start; ticks.length <= 50; v += step) {
    ticks.push(Number(v.toPrecision(12)))
    if (v >= max - step * 1e-9) break
  }
  return ticks
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const plain = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

/** 1,284 / 12.9K / 4.2M — compact from ten thousand up. */
export function formatValue(n: number | null): string {
  if (n == null) return '—'
  return Math.abs(n) >= 10_000 ? compact.format(n) : plain.format(n)
}
