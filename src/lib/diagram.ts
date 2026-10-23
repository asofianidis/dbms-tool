import type { ColumnInfo, ForeignKeyInfo, IndexInfo, ObjectKind } from './api'

/* ---------- Model ---------- */

export interface DiagramTable {
  key: string
  schema: string | null
  name: string
  kind: ObjectKind
  columns: ColumnInfo[]
  primaryKey: string[]
  foreignKeys: ForeignKeyInfo[]
  indexes: IndexInfo[]
}

export interface DiagramEdge {
  id: string
  name: string
  /** The referencing (child) table */
  from: string
  fromColumns: string[]
  /** The referenced (parent) table */
  to: string
  toColumns: string[]
  /** Every referencing column is nullable, so a child row may have no parent */
  optional: boolean
  /** The referencing columns are unique, so each parent has at most one child */
  unique: boolean
}

export type ColumnMode = 'all' | 'keys' | 'none'

export function tableKey(schema: string | null, name: string): string {
  return schema === null ? name : `${schema}.${name}`
}

/**
 * Foreign keys between the given tables. References to tables outside the set are dropped.
 * `nullSchema` is what a reference reports for tables listed without a schema (MySQL
 * reports the database name).
 */
export function buildEdges(tables: DiagramTable[], nullSchema?: string): DiagramEdge[] {
  const keys = new Set(tables.map((t) => t.key))
  const edges: DiagramEdge[] = []
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      let refSchema = fk.refSchema ?? t.schema
      if (t.schema === null && (refSchema === null || refSchema === nullSchema)) refSchema = null
      const to = tableKey(refSchema, fk.refTable)
      if (!keys.has(to)) continue
      const cols = fk.columns.map((c) => t.columns.find((col) => col.name === c))
      const sameColumns = (list: string[]): boolean =>
        list.length === fk.columns.length && fk.columns.every((c) => list.includes(c))
      edges.push({
        id: `${t.key}/${fk.name}`,
        name: fk.name,
        from: t.key,
        fromColumns: fk.columns,
        to,
        toColumns: fk.refColumns,
        optional: cols.length > 0 && cols.every((c) => c?.nullable),
        unique:
          sameColumns(t.primaryKey) ||
          t.indexes.some((i) => (i.unique || i.primary) && sameColumns(i.columns))
      })
    }
  }
  return edges
}

/** Columns shown for a table in the given mode, in table order. */
export function visibleColumns(table: DiagramTable, mode: ColumnMode): ColumnInfo[] {
  if (mode === 'none') return []
  if (mode === 'all') return table.columns
  const fkColumns = new Set(table.foreignKeys.flatMap((f) => f.columns))
  return table.columns.filter((c) => c.isPrimaryKey || fkColumns.has(c.name))
}

/* ---------- Sizing ---------- */

export const HEADER_HEIGHT = 34
export const ROW_HEIGHT = 22
export const ROW_PAD = 6
const MIN_WIDTH = 160
const MAX_WIDTH = 400
const NAME_X = 30
const SIDE_PAD = 12
const TYPE_GAP = 24

export const FONTS = {
  header: `600 12.5px 'Inter Variable', Inter, 'Segoe UI', system-ui, sans-serif`,
  schema: `400 11px 'Inter Variable', Inter, 'Segoe UI', system-ui, sans-serif`,
  name: `400 12px 'Inter Variable', Inter, 'Segoe UI', system-ui, sans-serif`,
  type: `400 11px 'JetBrains Mono', 'Cascadia Code', Consolas, ui-monospace, monospace`
}

export type Measure = (text: string, font: string) => number

/** Rough widths for tests and environments without a canvas. */
export const approximateMeasure: Measure = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12)
  return text.length * size * (font.includes('Mono') ? 0.6 : 0.55)
}

export interface NodeBox {
  key: string
  width: number
  height: number
}

export function nodeBox(
  table: DiagramTable,
  mode: ColumnMode,
  showTypes: boolean,
  measure: Measure,
  showSchema: boolean
): NodeBox {
  const title = (showSchema && table.schema ? `${table.schema}.` : '') + table.name
  let width = measure(title, FONTS.header) + SIDE_PAD * 2 + 34
  const rows = visibleColumns(table, mode)
  for (const c of rows) {
    const row =
      NAME_X +
      measure(c.name, FONTS.name) +
      (showTypes ? TYPE_GAP + measure(c.dataType, FONTS.type) : 0) +
      SIDE_PAD
    width = Math.max(width, row)
  }
  return {
    key: table.key,
    width: Math.ceil(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width))),
    height: HEADER_HEIGHT + (rows.length ? rows.length * ROW_HEIGHT + ROW_PAD * 2 : 0)
  }
}

/** Shortens `text` with an ellipsis so it fits in `max` pixels. */
export function fitText(text: string, max: number, font: string, measure: Measure): string {
  if (measure(text, font) <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(text.slice(0, mid) + '…', font) <= max) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}

export const ROW_LAYOUT = { nameX: NAME_X, sidePad: SIDE_PAD, typeGap: TYPE_GAP }

/* ---------- Layout ---------- */

export interface Point {
  x: number
  y: number
}

export interface Rect extends Point {
  width: number
  height: number
}

const RANK_GAP = 140
const NODE_GAP = 36
const GRID_GAP = 48

/**
 * Layered left-to-right layout: referenced tables sit left of the tables that reference
 * them. Tables without relationships are packed in a grid underneath.
 */
export function layoutDiagram(
  boxes: NodeBox[],
  edges: Pick<DiagramEdge, 'from' | 'to'>[]
): Record<string, Point> {
  const byKey = new Map(boxes.map((b) => [b.key, b]))
  const parents = new Map<string, Set<string>>()
  const children = new Map<string, Set<string>>()
  for (const b of boxes) {
    parents.set(b.key, new Set())
    children.set(b.key, new Set())
  }
  for (const e of edges) {
    if (e.from === e.to || !byKey.has(e.from) || !byKey.has(e.to)) continue
    parents.get(e.from)!.add(e.to)
    children.get(e.to)!.add(e.from)
  }
  const sorted = [...boxes].sort((a, b) => a.key.localeCompare(b.key))
  const linked = sorted.filter((b) => parents.get(b.key)!.size || children.get(b.key)!.size)
  const isolated = sorted.filter((b) => !parents.get(b.key)!.size && !children.get(b.key)!.size)

  // Break cycles: drop edges that point back into the current DFS path
  const state = new Map<string, 'active' | 'done'>()
  const visit = (key: string): void => {
    state.set(key, 'active')
    for (const p of [...parents.get(key)!]) {
      if (state.get(p) === 'active') {
        parents.get(key)!.delete(p)
        children.get(p)!.delete(key)
      } else if (!state.has(p)) visit(p)
    }
    state.set(key, 'done')
  }
  for (const b of linked) if (!state.has(b.key)) visit(b.key)

  // Longest path from the roots, then pull parents right up against their nearest child
  const rank = new Map<string, number>()
  const rankOf = (key: string): number => {
    const known = rank.get(key)
    if (known !== undefined) return known
    let r = 0
    for (const p of parents.get(key)!) r = Math.max(r, rankOf(p) + 1)
    rank.set(key, r)
    return r
  }
  for (const b of linked) rankOf(b.key)
  const byRankDesc = [...linked].sort((a, b) => rank.get(b.key)! - rank.get(a.key)!)
  for (const b of byRankDesc) {
    const kids = [...children.get(b.key)!]
    if (kids.length) rank.set(b.key, Math.min(...kids.map((k) => rank.get(k)!)) - 1)
  }

  const rankCount = linked.length ? Math.max(...linked.map((b) => rank.get(b.key)!)) + 1 : 0
  const ranks: string[][] = Array.from({ length: rankCount }, () => [])
  for (const b of linked) ranks[rank.get(b.key)!].push(b.key)

  // Barycenter ordering to reduce crossings
  const order = new Map<string, number>()
  const renumber = (r: string[]): void => r.forEach((k, i) => order.set(k, i))
  ranks.forEach(renumber)
  const neighbours = (key: string): string[] => [...parents.get(key)!, ...children.get(key)!]
  for (let pass = 0; pass < 8; pass++) {
    const sweep = pass % 2 === 0 ? ranks : [...ranks].reverse()
    for (const r of sweep) {
      const centre = new Map<string, number>()
      for (const k of r) {
        const ns = neighbours(k)
        centre.set(
          k,
          ns.length ? ns.reduce((sum, n) => sum + order.get(n)!, 0) / ns.length : order.get(k)!
        )
      }
      r.sort((a, b) => centre.get(a)! - centre.get(b)! || order.get(a)! - order.get(b)!)
      renumber(r)
    }
  }

  // Columns: very full ranks wrap into several columns so the diagram stays roughly square
  const totalArea = boxes.reduce((s, b) => s + (b.width + RANK_GAP) * (b.height + NODE_GAP), 0)
  const maxColumnHeight = Math.max(900, Math.sqrt(totalArea) * 1.1)
  const columns: string[][] = []
  for (const r of ranks) {
    let column: string[] = []
    let height = 0
    for (const k of r) {
      const h = byKey.get(k)!.height
      if (column.length && height + h > maxColumnHeight) {
        columns.push(column)
        column = []
        height = 0
      }
      column.push(k)
      height += h + NODE_GAP
    }
    if (column.length) columns.push(column)
  }

  const positions: Record<string, Point> = {}
  const columnHeight = (c: string[]): number =>
    c.reduce((s, k) => s + byKey.get(k)!.height, 0) + NODE_GAP * (c.length - 1)
  const tallest = Math.max(0, ...columns.map(columnHeight))
  let x = 0
  for (const c of columns) {
    const width = Math.max(...c.map((k) => byKey.get(k)!.width))
    let y = (tallest - columnHeight(c)) / 2
    for (const k of c) {
      positions[k] = { x, y: Math.round(y) }
      y += byKey.get(k)!.height + NODE_GAP
    }
    x += width + RANK_GAP
  }

  // Shelf-pack the unrelated tables below
  if (isolated.length) {
    const linkedWidth = Math.max(0, x - RANK_GAP)
    const area = isolated.reduce((s, b) => s + (b.width + GRID_GAP) * (b.height + GRID_GAP), 0)
    const rowWidth = Math.max(linkedWidth, Math.sqrt(area) * 1.6, isolated[0].width)
    let cx = 0
    let cy = columns.length ? tallest + GRID_GAP * 2 : 0
    let shelf = 0
    for (const b of isolated) {
      if (cx > 0 && cx + b.width > rowWidth) {
        cx = 0
        cy += shelf + GRID_GAP
        shelf = 0
      }
      positions[b.key] = { x: cx, y: cy }
      cx += b.width + GRID_GAP
      shelf = Math.max(shelf, b.height)
    }
  }
  return positions
}

export function boundsOf(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 }
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: right - x, height: bottom - y }
}

/* ---------- Edges ---------- */

const MARKER_LENGTH = 18

export interface Anchor extends Point {
  /** Outward direction from the table side: -1 left, 1 right */
  dir: 1 | -1
}

export interface Route {
  path: string
  start: Anchor
  end: Anchor
}

/** Curve from the child's column row to the parent's, leaving and entering sideways. */
export function routeEdge(from: Rect, fromY: number, to: Rect, toY: number, self = false): Route {
  let start: Anchor
  let end: Anchor
  if (self) {
    start = { x: from.x + from.width, y: fromY, dir: 1 }
    end = { x: from.x + from.width, y: toY === fromY ? toY + ROW_HEIGHT / 2 : toY, dir: 1 }
  } else if (from.x + from.width + 24 <= to.x) {
    start = { x: from.x + from.width, y: fromY, dir: 1 }
    end = { x: to.x, y: toY, dir: -1 }
  } else if (to.x + to.width + 24 <= from.x) {
    start = { x: from.x, y: fromY, dir: -1 }
    end = { x: to.x + to.width, y: toY, dir: 1 }
  } else {
    // Stacked tables: loop round whichever sides are closest
    const leftGap = Math.abs(from.x - to.x)
    const rightGap = Math.abs(from.x + from.width - (to.x + to.width))
    const dir: 1 | -1 = rightGap <= leftGap ? 1 : -1
    start = { x: dir === 1 ? from.x + from.width : from.x, y: fromY, dir }
    end = { x: dir === 1 ? to.x + to.width : to.x, y: toY, dir }
  }
  const sx = start.x + start.dir * MARKER_LENGTH
  const ex = end.x + end.dir * MARKER_LENGTH
  const reach =
    start.dir === end.dir
      ? Math.max(40, Math.abs(sx - ex) + 30)
      : Math.max(40, Math.min(160, Math.abs(ex - sx) / 2))
  const path =
    `M ${start.x} ${start.y} H ${sx} ` +
    `C ${sx + start.dir * reach} ${start.y}, ${ex + end.dir * reach} ${end.y}, ${ex} ${end.y} ` +
    `H ${end.x}`
  return { path, start, end }
}

/**
 * Crow's foot notation at an anchor: `many` draws the foot, `one` a bar; `optional` adds a
 * circle for "zero or …".
 */
export function markerPath(anchor: Anchor, cardinality: 'one' | 'many', optional: boolean): string {
  const { x, y, dir } = anchor
  const parts: string[] = []
  if (cardinality === 'many') {
    parts.push(`M ${x} ${y - 6} L ${x + dir * 10} ${y} L ${x} ${y + 6}`)
  } else {
    parts.push(`M ${x + dir * 6} ${y - 6} V ${y + 6}`)
  }
  if (!optional) parts.push(`M ${x + dir * 13} ${y - 6} V ${y + 6}`)
  return parts.join(' ')
}

/** Centre of the "zero" circle for optional ends, or null when the end is mandatory. */
export function markerCircle(anchor: Anchor, optional: boolean): Point | null {
  return optional ? { x: anchor.x + anchor.dir * 14, y: anchor.y } : null
}

/* ---------- PDF ---------- */

/**
 * A single-page PDF showing an image. `pixels` is zlib-compressed RGB (FlateDecode), and
 * the page is `pageWidth` × `pageHeight` points.
 */
export function buildPdf(options: {
  pixels: Uint8Array
  width: number
  height: number
  pageWidth: number
  pageHeight: number
  title: string
}): Uint8Array {
  const { pixels, width, height, title } = options
  const pw = +options.pageWidth.toFixed(2)
  const ph = +options.pageHeight.toFixed(2)
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let length = 0
  const offsets: number[] = []
  const push = (part: string | Uint8Array): void => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part
    chunks.push(bytes)
    length += bytes.length
  }
  const object = (n: number, body: string | (string | Uint8Array)[]): void => {
    offsets[n] = length
    push(`${n} 0 obj\n`)
    for (const part of Array.isArray(body) ? body : [body]) push(part)
    push('\nendobj\n')
  }
  // PDF strings: escape the delimiters and keep to ASCII
  const pdfString = (s: string): string =>
    `(${s.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`)})`
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`

  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
  )
  object(4, [
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`,
    pixels,
    '\nendstream'
  ])
  object(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  object(6, `<< /Title ${pdfString(title)} /Producer (dbms-tool) >>`)
  const xref = length
  push(`xref\n0 7\n0000000000 65535 f \n`)
  for (let n = 1; n <= 6; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`)
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`)

  const out = new Uint8Array(length)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
