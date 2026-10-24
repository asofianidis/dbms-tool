import type { Cell, ColumnMeta } from './api'

export type DiffStatus = 'added' | 'removed' | 'changed' | undefined

export interface ResultDiff {
  columns: ColumnMeta[]
  /** Rows of the newer result, then rows only the older one had */
  rows: Cell[][]
  status: DiffStatus[]
  /** `row:col` of cells whose value changed (keyed comparison only) */
  changed: Set<string>
  counts: { added: number; removed: number; changed: number; same: number }
}

interface Rows {
  columns: ColumnMeta[]
  rows: Cell[][]
}

/**
 * Compares an older result (`before`) with a newer one. Columns are matched
 * by name. With `key` columns, rows with the same key are compared cell by
 * cell; without, whole rows are matched as a multiset.
 */
export function diffResults(before: Rows, after: Rows, key: string[] = []): ResultDiff {
  const names = after.columns.map((c) => c.name)
  const columns = [...after.columns, ...before.columns.filter((c) => !names.includes(c.name))]
  const index = (set: Rows): number[] =>
    columns.map((c) => set.columns.findIndex((sc) => sc.name === c.name))
  const align = (row: Cell[], at: number[]): Cell[] => at.map((i) => (i < 0 ? null : row[i]))
  const beforeRows = before.rows.map((r) => align(r, index(before)))
  const afterRows = after.rows.map((r) => align(r, index(after)))
  const keyAt = key.map((k) => columns.findIndex((c) => c.name === k)).filter((i) => i >= 0)
  const identity = (row: Cell[], at: number[]): string => JSON.stringify(at.map((i) => row[i]))

  const status: DiffStatus[] = []
  const changed = new Set<string>()
  const counts = { added: 0, removed: 0, changed: 0, same: 0 }
  const all = columns.map((_, i) => i)
  const matchOn = keyAt.length ? keyAt : all

  const pool = new Map<string, number[]>()
  beforeRows.forEach((r, i) => {
    const id = identity(r, matchOn)
    const list = pool.get(id)
    if (list) list.push(i)
    else pool.set(id, [i])
  })
  const used = new Set<number>()
  afterRows.forEach((row, r) => {
    const match = pool.get(identity(row, matchOn))?.shift()
    if (match === undefined) {
      status.push('added')
      counts.added++
      return
    }
    used.add(match)
    const old = beforeRows[match]
    const diffs = all.filter((c) => JSON.stringify(old[c]) !== JSON.stringify(row[c]))
    if (diffs.length) {
      for (const c of diffs) changed.add(`${r}:${c}`)
      status.push('changed')
      counts.changed++
    } else {
      status.push(undefined)
      counts.same++
    }
  })
  const rows = [...afterRows]
  beforeRows.forEach((row, i) => {
    if (used.has(i)) return
    rows.push(row)
    status.push('removed')
    counts.removed++
  })
  return { columns, rows, status, changed, counts }
}
