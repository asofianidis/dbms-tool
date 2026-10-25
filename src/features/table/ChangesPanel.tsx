import { useMemo, useState } from 'react'
import { Check, Code2, PanelRightClose, Plus, Trash2, Undo2, X } from 'lucide-react'
import type { Cell, ColumnMeta, TableInfo } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { Dialect } from '@/lib/engines'
import { removeChange, removeColumn, setValue, toRowEdits, type PendingChange } from '@/lib/pending'
import { locatedEditScript, type RowLocator } from '@/lib/row-locator'
import type { TableRef } from '@/lib/sql'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { Badge, Button, Spinner } from '@/components/ui'

/** Right-hand panel listing the pending data edits as one transaction. */
export function ChangesPanel({
  changes,
  columns,
  primaryKey,
  info,
  dialect,
  tableRef,
  visibleKeys,
  readOnlyColumns,
  busy,
  onChange,
  onCommit,
  onCancelAll,
  onClose,
  onAddRow,
  notice,
  locator
}: {
  changes: PendingChange[]
  columns: ColumnMeta[]
  primaryKey: string[]
  info: TableInfo
  dialect: Dialect
  tableRef: TableRef
  /** Row keys on the current page, to flag changes made on other pages */
  visibleKeys: Set<string>
  /** Generated columns, which inserts can't set */
  readOnlyColumns: Set<string>
  busy: boolean
  onChange: (update: (changes: PendingChange[]) => PendingChange[]) => void
  /** Commits the given changes, or all of them */
  onCommit: (ids?: string[]) => void
  onCancelAll: () => void
  onClose: () => void
  /** Shows an add-row button in the header (the table tab has its own) */
  onAddRow?: () => void
  /** Shown above the changes, e.g. why committing is held back */
  notice?: string
  /** How rows are found when the table has no primary key (PostgreSQL) */
  locator?: RowLocator | null
}): React.JSX.Element {
  const [showSql, setShowSql] = useState(false)
  const script = useMemo(
    () => locatedEditScript(dialect, tableRef, info, toRowEdits(changes), locator),
    [changes, dialect, tableRef, info, locator]
  )

  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <span className="text-[12px] font-medium text-bright">Pending changes</span>
        <Badge tone={changes.length ? 'accent' : 'neutral'}>{changes.length}</Badge>
        <div className="flex-1" />
        {onAddRow && (
          <Button size="icon-sm" variant="ghost" title="Add row" onClick={onAddRow}>
            <Plus className="size-3.5" />
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          title={showSql ? 'Show changes' : 'Show the transaction SQL'}
          className={cn(showSql && 'bg-hover text-bright')}
          onClick={() => setShowSql((s) => !s)}
        >
          <Code2 className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" title="Hide panel" onClick={onClose}>
          <PanelRightClose className="size-3.5" />
        </Button>
      </div>
      {notice && (
        <p className="border-b border-line bg-warn/[0.07] px-3 py-2 text-[11.5px] text-warn">
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!changes.length ? (
          <p className="p-4 text-xs text-faint">
            Edit cells, add rows or delete rows; the changes collect here until you commit them.
          </p>
        ) : showSql ? (
          <CodeEditor
            value={script}
            language={{ kind: 'sql', dialect }}
            readOnly
            lineNumbers={false}
            className="h-full bg-canvas"
            fontSize={11.5}
          />
        ) : (
          <div className="space-y-2 p-2">
            {changes.map((change) => (
              <ChangeCard
                key={change.id}
                change={change}
                columns={columns}
                primaryKey={primaryKey}
                offPage={!!change.rowKey && !visibleKeys.has(change.rowKey)}
                readOnlyColumns={readOnlyColumns}
                busy={busy}
                onChange={onChange}
                onCommit={() => onCommit([change.id])}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          className="hover:text-danger"
          disabled={!changes.length || busy}
          onClick={onCancelAll}
        >
          <Undo2 className="size-3.5" /> Cancel all
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="primary"
          disabled={!changes.length || busy}
          onClick={() => onCommit()}
          title="Run every change in one transaction"
        >
          {busy ? <Spinner className="text-current" /> : <Check className="size-3.5" />}
          Commit all
        </Button>
      </div>
    </aside>
  )
}

const KIND_TONE = { update: 'warning', delete: 'danger', insert: 'success' } as const

function ChangeCard({
  change,
  columns,
  primaryKey,
  offPage,
  readOnlyColumns,
  busy,
  onChange,
  onCommit
}: {
  change: PendingChange
  columns: ColumnMeta[]
  primaryKey: string[]
  offPage: boolean
  readOnlyColumns: Set<string>
  busy: boolean
  onChange: (update: (changes: PendingChange[]) => PendingChange[]) => void
  onCommit: () => void
}): React.JSX.Element {
  const key = change.original
    ? primaryKey.map((k) => `${k} = ${display(change.original![k])}`).join(', ')
    : 'new row'
  // Insert values follow the table's column order
  const entries =
    change.kind === 'insert'
      ? columns.filter((c) => c.name in change.values).map((c) => c.name)
      : Object.keys(change.values)
  const unset =
    change.kind === 'insert'
      ? columns.filter((c) => !(c.name in change.values) && !readOnlyColumns.has(c.name))
      : []

  return (
    <div className="rounded-lg border border-line bg-canvas/60">
      <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1.5">
        <Badge tone={KIND_TONE[change.kind]}>{change.kind}</Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg" title={key}>
          {key}
        </span>
        {offPage && (
          <span className="text-[10.5px] text-faint" title="This row isn't on the current page">
            other page
          </span>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          title="Commit just this change"
          disabled={busy}
          onClick={onCommit}
          className="hover:text-accent"
        >
          <Check className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          title="Discard this change"
          className="hover:text-danger"
          onClick={() => onChange((c) => removeChange(c, change.id))}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {change.kind === 'delete' ? (
        <p className="px-2.5 pb-2 text-[11.5px] text-muted">This row will be deleted.</p>
      ) : (
        <div className="space-y-1 px-2.5 pb-2">
          {entries.map((column) => (
            <div key={column} className="grid grid-cols-[6.5rem_minmax(0,1fr)_1.25rem] gap-1.5">
              <span className="truncate pt-1 font-mono text-[11px] text-muted" title={column}>
                {column}
              </span>
              <div className="min-w-0 space-y-0.5">
                {change.kind === 'update' && (
                  <div
                    className="truncate font-mono text-[11px] text-faint line-through"
                    title={display(change.original![column])}
                  >
                    {display(change.original![column])}
                  </div>
                )}
                <ValueInput
                  value={change.values[column]}
                  onChange={(v) => onChange((c) => setValue(c, change.id, column, v))}
                />
              </div>
              <button
                type="button"
                title="Discard this column's change"
                className="flex h-6 items-center justify-center self-end text-faint hover:text-danger"
                onClick={() => onChange((c) => removeColumn(c, change.id, column))}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          {change.kind === 'insert' && !entries.length && (
            <p className="text-[11px] text-faint">Every column uses its default.</p>
          )}
          {unset.length > 0 && (
            <label className="flex items-center gap-1 pt-0.5 text-[11px] text-muted">
              <Plus className="size-3" />
              <select
                value=""
                onChange={(e) =>
                  e.target.value && onChange((c) => setValue(c, change.id, e.target.value, ''))
                }
                className="h-6 min-w-0 flex-1 rounded border border-line-strong bg-canvas px-1 text-[11px] text-fg focus:outline-none"
              >
                <option value="">Set a column…</option>
                {unset.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  )
}

function display(value: Cell | undefined): string {
  if (value === null || value === undefined) return 'NULL'
  return String(value)
}

/** Edits a pending value: text, a boolean, or NULL. */
function ValueInput({
  value,
  onChange
}: {
  value: Cell
  onChange: (value: Cell) => void
}): React.JSX.Element {
  const field =
    'h-6 min-w-0 flex-1 rounded border border-line-strong bg-canvas px-1.5 font-mono text-[11.5px] text-bright placeholder:text-faint placeholder:italic focus:border-accent/50 focus:outline-none'
  return (
    <div className="flex items-center gap-1">
      {typeof value === 'boolean' ? (
        <select
          value={String(value)}
          onChange={(e) => onChange(e.target.value === 'true')}
          className={field}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          value={value ?? ''}
          placeholder={value === null ? 'NULL' : ''}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className={field}
        />
      )}
      <button
        type="button"
        title="Set to NULL"
        disabled={value === null}
        onClick={() => onChange(null)}
        className="h-6 rounded px-1 font-mono text-[10px] text-faint hover:bg-hover hover:text-bright disabled:opacity-30"
      >
        NULL
      </button>
    </div>
  )
}
