import type { Cell } from './api'
import type { RowEdit } from './sql'

/**
 * A data edit waiting to be committed. Existing rows are identified by their
 * primary key, so pending changes survive paging, sorting and reloads.
 */
export interface PendingChange {
  id: string
  kind: 'update' | 'delete' | 'insert'
  /** Primary key values of an existing row, JSON-encoded; null for inserts */
  rowKey: string | null
  /** The row as loaded (update / delete), keyed by column name */
  original: Record<string, Cell> | null
  /** update: the changed columns; insert: the columns given a value */
  values: Record<string, Cell>
}

let seq = 0
const nextId = (): string => `p${++seq}`

export function rowKeyOf(primaryKey: string[], row: Record<string, Cell>): string {
  return JSON.stringify(primaryKey.map((k) => row[k] ?? null))
}

const findRow = (changes: PendingChange[], rowKey: string): PendingChange | undefined =>
  changes.find((c) => c.rowKey === rowKey)

/** Sets a column of an existing row; setting it back to the loaded value drops the change. */
export function editRow(
  changes: PendingChange[],
  primaryKey: string[],
  original: Record<string, Cell>,
  column: string,
  value: Cell
): PendingChange[] {
  const rowKey = rowKeyOf(primaryKey, original)
  const existing = findRow(changes, rowKey)
  if (existing?.kind === 'delete') return changes
  const values = { ...existing?.values }
  if (value === original[column]) delete values[column]
  else values[column] = value
  if (!existing) {
    return Object.keys(values).length
      ? [...changes, { id: nextId(), kind: 'update', rowKey, original, values }]
      : changes
  }
  return Object.keys(values).length
    ? changes.map((c) => (c === existing ? { ...c, values } : c))
    : changes.filter((c) => c !== existing)
}

/** Sets a column of a pending insert; NULL leaves the column out so its default applies. */
export function editInsert(
  changes: PendingChange[],
  id: string,
  column: string,
  value: Cell
): PendingChange[] {
  return changes.map((c) => {
    if (c.id !== id) return c
    const values = { ...c.values }
    if (value === null) delete values[column]
    else values[column] = value
    return { ...c, values }
  })
}

export function addInsert(changes: PendingChange[]): PendingChange[] {
  return [...changes, { id: nextId(), kind: 'insert', rowKey: null, original: null, values: {} }]
}

/** Marks an existing row for deletion, replacing any pending update to it. */
export function deleteRow(
  changes: PendingChange[],
  primaryKey: string[],
  original: Record<string, Cell>
): PendingChange[] {
  const rowKey = rowKeyOf(primaryKey, original)
  if (findRow(changes, rowKey)?.kind === 'delete') return changes
  return [
    ...changes.filter((c) => c.rowKey !== rowKey),
    { id: nextId(), kind: 'delete', rowKey, original, values: {} }
  ]
}

export function removeChange(changes: PendingChange[], id: string): PendingChange[] {
  return changes.filter((c) => c.id !== id)
}

/** Drops one column from a change; an update with no columns left is dropped entirely. */
export function removeColumn(
  changes: PendingChange[],
  id: string,
  column: string
): PendingChange[] {
  return changes.flatMap((c) => {
    if (c.id !== id) return [c]
    const values = { ...c.values }
    delete values[column]
    return c.kind === 'update' && !Object.keys(values).length ? [] : [{ ...c, values }]
  })
}

/** Sets a column's value from the changes panel (unlike editRow, never drops the change). */
export function setValue(
  changes: PendingChange[],
  id: string,
  column: string,
  value: Cell
): PendingChange[] {
  return changes.map((c) => (c.id === id ? { ...c, values: { ...c.values, [column]: value } } : c))
}

/** Row edits in transaction order: deletes first so re-inserted keys don't collide. */
export function toRowEdits(changes: PendingChange[]): RowEdit[] {
  const order = { delete: 0, update: 1, insert: 2 }
  return [...changes]
    .sort((a, b) => order[a.kind] - order[b.kind])
    .map((c) =>
      c.kind === 'delete'
        ? { kind: 'delete', original: c.original! }
        : c.kind === 'update'
          ? { kind: 'update', original: c.original!, values: c.values }
          : { kind: 'insert', values: c.values }
    )
}
