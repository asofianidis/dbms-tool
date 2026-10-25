import { useMemo, useState } from 'react'
import type {
  Cell,
  ColumnMeta,
  ConnectionConfig,
  ExecOptions,
  ExecOutput,
  TableInfo
} from '@/lib/api'
import type { Dialect } from '@/lib/engines'
import { plural } from '@/lib/format'
import {
  deleteRow,
  editInsert,
  editRow,
  removeChange,
  rowKeyOf,
  toRowEdits,
  type PendingChange
} from '@/lib/pending'
import { confirmProductionWrite, isProduction } from '@/lib/production'
import { locatedEditStatements, type RowLocator } from '@/lib/row-locator'
import { literal, qualified, quoteIdent, wrapInTransaction, type TableRef } from '@/lib/sql'
import { toast, toastError } from '@/lib/toast'
import { confirm } from '@/lib/workspace'
import type { GridEditing } from '@/components/grid/ResultGrid'

/**
 * Pending data edits over rows loaded from one table, shared by the table
 * tab and editable query results. Rows are tied to changes by primary key,
 * so changes survive reloads; `rows` is the loaded rows with the changes
 * applied and pending inserts appended.
 */
export function usePendingEdits({
  columns,
  baseRows,
  primaryKey,
  enabled,
  readOnlyColumns,
  hidden
}: {
  columns: ColumnMeta[]
  baseRows: Cell[][]
  primaryKey: string[]
  enabled: boolean
  /** Data columns that can't be edited */
  readOnlyColumns: Set<number>
  /** Key columns loaded but not shown (PostgreSQL's ctid), one row per base row */
  hidden?: { columns: ColumnMeta[]; rows: Cell[][] }
}): {
  changes: PendingChange[]
  setChanges: React.Dispatch<React.SetStateAction<PendingChange[]>>
  rows: Cell[][]
  editing: GridEditing | undefined
  /** Keys of the loaded rows, to flag changes to rows not shown */
  visibleKeys: Set<string>
} {
  const [changes, setChanges] = useState<PendingChange[]>([])
  const pkKey = primaryKey.join(',')
  // The loaded rows as records, with the primary key that ties them to pending changes
  const baseRecords = useMemo(
    () =>
      baseRows.map((r, ri) => {
        const record = Object.fromEntries([
          ...(hidden?.columns.map((c, i) => [c.name, hidden.rows[ri]?.[i] ?? null]) ?? []),
          ...columns.map((c, i) => [c.name, r[i]])
        ])
        return { record, key: rowKeyOf(primaryKey, record) }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseRows, columns, pkKey, hidden]
  )
  const byKey = useMemo(
    () => new Map(changes.filter((c) => c.rowKey).map((c) => [c.rowKey!, c])),
    [changes]
  )
  const inserts = useMemo(() => changes.filter((c) => c.kind === 'insert'), [changes])
  const rows = useMemo(
    () => [
      ...baseRows.map((r, i) => {
        const change = byKey.get(baseRecords[i].key)
        if (change?.kind !== 'update') return r
        return columns.map((c, ci) => (c.name in change.values ? change.values[c.name] : r[ci]))
      }),
      ...inserts.map((c) => columns.map((col) => c.values[col.name] ?? null))
    ],
    [baseRows, baseRecords, byKey, inserts, columns]
  )
  const visibleKeys = useMemo(() => new Set(baseRecords.map((r) => r.key)), [baseRecords])

  const insertAt = (row: number): PendingChange | undefined => inserts[row - baseRows.length]
  const editing: GridEditing | undefined = enabled
    ? {
        onEdit: (row, col, value) =>
          setChanges((all) =>
            row >= baseRows.length
              ? editInsert(all, insertAt(row)!.id, columns[col].name, value)
              : editRow(all, primaryKey, baseRecords[row].record, columns[col].name, value)
          ),
        rowStatus: (row) =>
          row >= baseRows.length
            ? 'inserted'
            : byKey.get(baseRecords[row].key)?.kind === 'delete'
              ? 'deleted'
              : undefined,
        isModified: (row, col) => {
          const change = row < baseRows.length ? byKey.get(baseRecords[row].key) : undefined
          return change?.kind === 'update' && columns[col].name in change.values
        },
        onDeleteRows: (list) =>
          setChanges((all) =>
            list.reduce(
              // Deleting a new row just drops it
              (acc, row) =>
                row >= baseRows.length
                  ? removeChange(acc, insertAt(row)!.id)
                  : deleteRow(acc, primaryKey, baseRecords[row].record),
              all
            )
          ),
        onRevertRows: (list) => {
          const keys = new Set(
            list.filter((r) => r < baseRows.length).map((r) => baseRecords[r].key)
          )
          setChanges((all) => all.filter((c) => !c.rowKey || !keys.has(c.rowKey)))
        },
        readOnlyColumns
      }
    : undefined

  return { changes, setChanges, rows, editing, visibleKeys }
}

/**
 * Runs pending changes as one transaction, after a confirmation when they
 * delete rows, the user asked to confirm, or the connection is production.
 * Returns whether they committed.
 */
export async function commitPendingChanges({
  changes,
  dialect,
  tableRef,
  info,
  confirmDangerous,
  connection,
  execute,
  busy,
  locator
}: {
  changes: PendingChange[]
  dialect: Dialect
  tableRef: TableRef
  info: TableInfo
  confirmDangerous: boolean
  connection?: ConnectionConfig
  execute: (sql: string, options?: ExecOptions) => Promise<ExecOutput>
  /** Told when the statements start and stop running */
  busy?: (running: boolean) => void
  /** How rows are found when the table has no primary key (PostgreSQL) */
  locator?: RowLocator | null
}): Promise<boolean> {
  const statements = locatedEditStatements(dialect, tableRef, info, toRowEdits(changes), locator)
  if (!statements.length) return true
  const script = wrapInTransaction(dialect, statements)
  const deletes = changes.some((c) => c.kind === 'delete')
  if (isProduction(connection)) {
    const deleted = changes.filter((c) => c.kind === 'delete').length
    const ok = await confirmProductionWrite(connection, {
      action: `This commits ${plural(statements.length, 'change')} in one transaction`,
      dangers: deleted ? [`deleting ${plural(deleted, 'row')}`] : [],
      code: script
    })
    if (!ok) return false
  } else if (confirmDangerous || deletes) {
    const ok = await confirm({
      title: `Commit ${plural(statements.length, 'change')}?`,
      message: 'These statements run in one transaction; if any fails, none are applied.',
      code: script,
      confirmLabel: 'Commit',
      danger: deletes
    })
    if (!ok) return false
  }
  busy?.(true)
  try {
    const out = await execute(script, { confirmed: true })
    if (out.error) {
      await execute(
        dialect === 'tsql' ? 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION' : 'ROLLBACK'
      ).catch(() => {})
      toast(`Changes not committed: ${out.error.message}`, 'error')
      return false
    }
    toast(`Committed ${plural(statements.length, 'change')}`)
    return true
  } catch (e) {
    toastError(e)
    return false
  } finally {
    busy?.(false)
  }
}

/** Largest binary value fetched in full for the value viewer */
const FULL_VALUE_BYTES = 64 * 1024 * 1024

/**
 * Reads one cell again by its row's primary key, without the binary cap that
 * results have, for viewing or saving a whole value.
 */
export async function fetchCellValue({
  execute,
  dialect,
  tableRef,
  info,
  columns,
  row,
  column
}: {
  execute: (sql: string, options: ExecOptions) => Promise<ExecOutput>
  dialect: Dialect
  tableRef: TableRef
  info: TableInfo
  columns: ColumnMeta[]
  /** The row as loaded; absent for a row that isn't saved yet */
  row: Cell[] | undefined
  column: number
}): Promise<Cell> {
  if (!row) throw new Error("The row isn't saved yet")
  const where = info.primaryKey.map((k) => {
    const i = columns.findIndex((c) => c.name === k)
    if (i < 0) throw new Error(`The result doesn't include the key column ${k}`)
    const type = info.columns.find((c) => c.name === k)?.dataType ?? ''
    const value = row[i]
    return value === null
      ? `${quoteIdent(dialect, k)} IS NULL`
      : `${quoteIdent(dialect, k)} = ${literal(dialect, value, type)}`
  })
  const sql = `SELECT ${quoteIdent(dialect, columns[column].name)} FROM ${qualified(dialect, tableRef)} WHERE ${where.join(' AND ')}`
  const out = await execute(sql, { maxRows: 1, maxBinaryBytes: FULL_VALUE_BYTES })
  if (out.error) throw new Error(out.error.message)
  const set = out.results[0]
  if (!set?.rows.length) throw new Error('The row is no longer there')
  return set.rows[0][0]
}
