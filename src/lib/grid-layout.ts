import type { Cell, ColumnMeta } from './api'
import { createPersistentStore } from './store'

/**
 * How a grid shows its columns, remembered per grid (a query tab, a table) so
 * widths, order, hidden and frozen columns survive re-runs and restarts.
 * Columns are matched by name, so a query that gains a column keeps the rest.
 */
export interface GridLayout {
  widths: Record<string, number>
  hidden: string[]
  /** Column keys in the order last arranged */
  order: string[]
  /** Leading visible columns kept in view while scrolling sideways */
  frozen: number
  updatedAt: number
}

const MAX_LAYOUTS = 300

export const gridLayoutStore = createPersistentStore<Record<string, GridLayout>>(
  'dbms.grid-layouts.v1',
  {}
)

export const emptyLayout = (): GridLayout => ({
  widths: {},
  hidden: [],
  order: [],
  frozen: 0,
  updatedAt: 0
})

export function updateLayout(
  key: string,
  update: (layout: GridLayout) => Partial<GridLayout>
): void {
  gridLayoutStore.set((all) => {
    const current = all[key] ?? emptyLayout()
    const next = { ...all, [key]: { ...current, ...update(current), updatedAt: Date.now() } }
    const keys = Object.keys(next)
    if (keys.length <= MAX_LAYOUTS) return next
    // Forget the layouts used longest ago
    const keep = new Set(
      keys.sort((a, b) => next[b].updatedAt - next[a].updatedAt).slice(0, MAX_LAYOUTS)
    )
    return Object.fromEntries(Object.entries(next).filter(([k]) => keep.has(k)))
  })
}

export function resetLayout(key: string): void {
  gridLayoutStore.set((all) => {
    const next = { ...all }
    delete next[key]
    return next
  })
}

/** A stable key per column: its name, with `#2`, `#3`… for repeated names (joins). */
export function columnKeys(columns: ColumnMeta[]): string[] {
  const seen = new Map<string, number>()
  return columns.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1
    seen.set(c.name, n)
    return n === 1 ? c.name : `${c.name}#${n}`
  })
}

/**
 * Data column indexes in display order, without hidden ones. Columns the
 * saved order doesn't know go after the column that precedes them in the data.
 */
export function viewColumns(keys: string[], layout: GridLayout | undefined): number[] {
  if (!layout) return keys.map((_, i) => i)
  const index = new Map(keys.map((k, i) => [k, i]))
  const order = layout.order.filter((k) => index.has(k))
  const placed = new Set(order)
  keys.forEach((k, i) => {
    if (placed.has(k)) return
    const before = i > 0 ? order.indexOf(keys[i - 1]) : -1
    order.splice(before + 1, 0, k)
    placed.add(k)
  })
  const hidden = new Set(layout.hidden)
  return order.filter((k) => !hidden.has(k)).map((k) => index.get(k)!)
}

/** Moves the column at view position `from` to `to`, returning the new full order. */
export function moveColumn(keys: string[], view: number[], from: number, to: number): string[] {
  const shown = view.map((i) => keys[i])
  const [moved] = shown.splice(from, 1)
  shown.splice(to, 0, moved)
  // Hidden columns keep their place relative to the start
  const hidden = keys.filter((k) => !shown.includes(k))
  return [...shown, ...hidden]
}

type Test = (value: Cell) => boolean

/**
 * A per-column filter. Plain text matches anywhere, ignoring case; also
 * `=x` (exactly), `!=x` / `<>x`, `!x` (doesn't contain), `>n` `>=n` `<n` `<=n`,
 * `null` and `!null`.
 */
export function columnFilter(text: string, numeric: boolean): Test | null {
  const t = text.trim()
  if (!t) return null
  const lower = t.toLowerCase()
  if (lower === 'null') return (v) => v === null
  if (lower === '!null' || lower === 'not null') return (v) => v !== null
  const str = (v: Cell): string => (v === null ? '' : String(v))
  const cmp = /^(>=|<=|>|<)\s*(.+)$/.exec(t)
  if (cmp) {
    const [, op, operand] = cmp
    const n = Number(operand)
    const asNumber = numeric || (!Number.isNaN(n) && operand.trim() !== '')
    return (v) => {
      if (v === null) return false
      const d = asNumber
        ? Number(v) - n
        : str(v).localeCompare(operand, undefined, { numeric: true, sensitivity: 'base' })
      if (Number.isNaN(d)) return false
      return op === '>' ? d > 0 : op === '>=' ? d >= 0 : op === '<' ? d < 0 : d <= 0
    }
  }
  const neq = /^(!=|<>)(.*)$/.exec(t)
  if (neq) {
    const operand = neq[2].trim().toLowerCase()
    return (v) => str(v).toLowerCase() !== operand
  }
  if (t.startsWith('=')) {
    const operand = t.slice(1).trim().toLowerCase()
    return (v) => v !== null && str(v).toLowerCase() === operand
  }
  if (t.startsWith('!')) {
    const operand = t.slice(1).toLowerCase()
    return (v) => !str(v).toLowerCase().includes(operand)
  }
  return (v) => v !== null && str(v).toLowerCase().includes(lower)
}
