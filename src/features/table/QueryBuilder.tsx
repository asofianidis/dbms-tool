import { useEffect, useState } from 'react'
import {
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowUp,
  ArrowUpNarrowWide,
  Code2,
  Filter,
  Play,
  Plus,
  X
} from 'lucide-react'
import type { ColumnInfo } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { Dialect } from '@/lib/engines'
import {
  OPERATORS,
  buildOrderBy,
  buildWhere,
  columnKind,
  describeCondition,
  emptyQuery,
  newCondition,
  operatorsFor,
  type ColumnKind,
  type FilterCondition,
  type FilterOp,
  type QueryState,
  type SortKey
} from '@/lib/filters'
import { Button, Segmented } from '@/components/ui'

const control =
  'h-7 rounded-md border border-line-strong bg-canvas px-2 text-[12px] text-fg placeholder:text-faint focus:border-accent/50 focus:outline-none disabled:opacity-40'

const DEFAULT_OP: Record<ColumnKind, FilterOp> = {
  text: 'contains',
  number: 'eq',
  date: 'eq',
  boolean: 'true',
  other: 'eq'
}

const PLACEHOLDER: Record<ColumnKind, string> = {
  text: 'text',
  number: '0',
  date: '2024-01-31',
  boolean: '',
  other: 'value'
}

/** Filter and sort builder shown under the Data view toolbar. */
export function QueryBuilder({
  columns,
  dialect,
  applied,
  onApply,
  onClose
}: {
  columns: ColumnInfo[]
  dialect: Dialect
  applied: QueryState
  onApply: (query: QueryState) => void
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(applied)
  const [showSql, setShowSql] = useState(false)
  // Chips, header sorting and "filter by value" change the applied query from outside
  useEffect(() => setDraft(applied), [applied])

  const types = Object.fromEntries(columns.map((c) => [c.name, c.dataType]))
  const kindOf = (column: string): ColumnKind => columnKind(types[column] ?? '')
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied)
  const where = buildWhere(dialect, draft, types)
  const orderBy = buildOrderBy(dialect, draft.sorts)
  const apply = (): void => onApply(draft)

  const patchCondition = (id: string, patch: Partial<FilterCondition>): void =>
    setDraft((d) => ({
      ...d,
      conditions: d.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c))
    }))
  const setColumn = (c: FilterCondition, column: string): void => {
    const ops = operatorsFor(kindOf(column))
    patchCondition(c.id, { column, op: ops.includes(c.op) ? c.op : DEFAULT_OP[kindOf(column)] })
  }
  const addCondition = (kind: 'column' | 'sql'): void => {
    const column = columns[0]?.name ?? ''
    setDraft((d) => ({
      ...d,
      conditions: [...d.conditions, newCondition({ kind, column, op: DEFAULT_OP[kindOf(column)] })]
    }))
  }
  const patchSort = (index: number, patch: Partial<SortKey>): void =>
    setDraft((d) => ({
      ...d,
      sorts: d.sorts.map((s, i) => (i === index ? { ...s, ...patch } : s))
    }))
  const moveSort = (index: number, by: number): void =>
    setDraft((d) => {
      const sorts = [...d.sorts]
      const [s] = sorts.splice(index, 1)
      sorts.splice(index + by, 0, s)
      return { ...d, sorts }
    })
  const unsorted = columns.filter((c) => !draft.sorts.some((s) => s.column === c.name))

  // Enter applies from any field
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLSelectElement)) {
      e.preventDefault()
      apply()
    }
  }

  return (
    <div
      className="max-h-[45%] shrink-0 overflow-y-auto border-b border-line bg-panel px-3 py-2.5"
      onKeyDown={onKeyDown}
    >
      <div className="flex gap-6">
        <section className="min-w-0 flex-[3] space-y-1.5">
          <div className="flex items-center gap-2 text-[11.5px] text-muted">
            <Filter className="size-3.5" />
            <span>Rows matching</span>
            <Segmented
              size="sm"
              value={draft.match}
              options={[
                { value: 'all', label: 'all' },
                { value: 'any', label: 'any' }
              ]}
              onChange={(match) => setDraft((d) => ({ ...d, match }))}
            />
            <span>of these conditions</span>
          </div>
          {draft.conditions.map((c) => {
            const kind = kindOf(c.column)
            const operands = c.kind === 'column' ? OPERATORS[c.op].operands : 0
            return (
              <div
                key={c.id}
                className={cn('flex items-center gap-1.5', !c.enabled && 'opacity-50')}
              >
                <input
                  type="checkbox"
                  className="size-3.5 accent-accent"
                  checked={c.enabled}
                  onChange={(e) => patchCondition(c.id, { enabled: e.target.checked })}
                  title={c.enabled ? 'Turn this condition off' : 'Turn this condition on'}
                />
                {c.kind === 'sql' ? (
                  <input
                    className={cn(control, 'min-w-0 flex-1 font-mono')}
                    value={c.sql}
                    placeholder="Any SQL condition, e.g. created_at > now() - interval '1 day'"
                    spellCheck={false}
                    onChange={(e) => patchCondition(c.id, { sql: e.target.value })}
                  />
                ) : (
                  <>
                    <select
                      className={cn(control, 'w-40 font-mono')}
                      value={c.column}
                      onChange={(e) => setColumn(c, e.target.value)}
                    >
                      {columns.map((col) => (
                        <option key={col.name} value={col.name}>
                          {col.name}
                        </option>
                      ))}
                    </select>
                    <select
                      className={cn(control, 'w-32')}
                      value={c.op}
                      onChange={(e) => patchCondition(c.id, { op: e.target.value as FilterOp })}
                    >
                      {operatorsFor(kind).map((op) => (
                        <option key={op} value={op}>
                          {OPERATORS[op].label}
                        </option>
                      ))}
                    </select>
                    {operands > 0 && (
                      <input
                        className={cn(control, 'min-w-0 flex-1 font-mono')}
                        value={c.value}
                        placeholder={
                          c.op === 'in' || c.op === 'not_in'
                            ? 'a, b, c'
                            : operands === 2
                              ? 'from'
                              : PLACEHOLDER[kind]
                        }
                        spellCheck={false}
                        onChange={(e) => patchCondition(c.id, { value: e.target.value })}
                      />
                    )}
                    {operands === 2 && (
                      <input
                        className={cn(control, 'min-w-0 flex-1 font-mono')}
                        value={c.value2}
                        placeholder="to"
                        spellCheck={false}
                        onChange={(e) => patchCondition(c.id, { value2: e.target.value })}
                      />
                    )}
                    {operands === 0 && <div className="flex-1" />}
                  </>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Remove condition"
                  className="hover:text-danger"
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      conditions: d.conditions.filter((x) => x.id !== c.id)
                    }))
                  }
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )
          })}
          <div className="flex gap-1">
            <Button size="xs" variant="ghost" onClick={() => addCondition('column')}>
              <Plus className="size-3" /> Condition
            </Button>
            <Button size="xs" variant="ghost" onClick={() => addCondition('sql')}>
              <Code2 className="size-3" /> SQL condition
            </Button>
          </div>
        </section>

        <section className="min-w-0 flex-[2] space-y-1.5">
          <div className="flex h-5 items-center gap-2 text-[11.5px] text-muted">
            <ArrowDownWideNarrow className="size-3.5" /> Sort by
          </div>
          {draft.sorts.map((s, i) => (
            <div key={s.column} className="flex items-center gap-1.5">
              <span className="w-4 text-right text-[11px] text-faint tabular-nums">{i + 1}</span>
              <select
                className={cn(control, 'min-w-0 flex-1 font-mono')}
                value={s.column}
                onChange={(e) => patchSort(i, { column: e.target.value })}
              >
                {[s.column, ...unsorted.map((c) => c.name)].map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <Segmented
                size="sm"
                value={s.dir}
                options={[
                  { value: 'asc', label: 'ASC' },
                  { value: 'desc', label: 'DESC' }
                ]}
                onChange={(dir) => patchSort(i, { dir })}
              />
              <Button
                size="icon-sm"
                variant="ghost"
                title="Sort by this earlier"
                disabled={i === 0}
                onClick={() => moveSort(i, -1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title="Sort by this later"
                disabled={i === draft.sorts.length - 1}
                onClick={() => moveSort(i, 1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title="Remove sort"
                className="hover:text-danger"
                onClick={() =>
                  setDraft((d) => ({ ...d, sorts: d.sorts.filter((_, j) => j !== i) }))
                }
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
          {!draft.sorts.length && <p className="text-[11px] text-faint">Primary key order</p>}
          <Button
            size="xs"
            variant="ghost"
            disabled={!unsorted.length}
            onClick={() =>
              setDraft((d) => ({
                ...d,
                sorts: [...d.sorts, { column: unsorted[0].name, dir: 'asc' }]
              }))
            }
          >
            <Plus className="size-3" /> Sort column
          </Button>
        </section>
      </div>

      {showSql && (
        <pre className="mt-2 rounded-md border border-line bg-canvas px-2.5 py-1.5 font-mono text-[11.5px] whitespace-pre-wrap text-fg select-text">
          {where ? `WHERE ${where}` : '-- no filter'}
          {orderBy ? `\nORDER BY ${orderBy}` : ''}
        </pre>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="xs"
          variant="ghost"
          className={cn(showSql && 'bg-hover text-bright')}
          onClick={() => setShowSql((s) => !s)}
        >
          <Code2 className="size-3" /> SQL
        </Button>
        {dirty && <span className="text-[11px] text-warn">Not applied yet · Enter to apply</span>}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => onApply(emptyQuery())}>
          Clear all
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button size="sm" variant="primary" disabled={!dirty} onClick={apply}>
          <Play className="size-3 fill-current" /> Apply
        </Button>
      </div>
    </div>
  )
}

/** Toolbar summary of the applied filters and sorts, as removable chips. */
export function QuerySummary({
  query,
  open,
  onToggle,
  onChange
}: {
  query: QueryState
  open: boolean
  onToggle: () => void
  onChange: (query: QueryState) => void
}): React.JSX.Element {
  const active = query.conditions.filter((c) => c.enabled)
  const chip =
    'flex h-6 max-w-56 shrink-0 items-center gap-1 rounded-md bg-hover pr-1 pl-2 font-mono text-[11px] text-fg'
  const remove = 'rounded text-faint hover:text-danger'
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
      <Button
        size="sm"
        variant="ghost"
        onClick={onToggle}
        className={cn('shrink-0', open && 'bg-hover text-bright')}
        title={open ? 'Hide the filter and sort builder' : 'Filter and sort rows'}
      >
        <Filter className="size-3.5" /> Filter
        {active.length > 0 && <span className="text-accent tabular-nums">{active.length}</span>}
      </Button>
      {active.length > 1 && (
        <span className="shrink-0 text-[10.5px] text-faint uppercase">{query.match}</span>
      )}
      {active.map((c) => (
        <span key={c.id} className={chip} title={describeCondition(c)}>
          <span className="truncate">{describeCondition(c)}</span>
          <button
            className={remove}
            title="Remove"
            onClick={() =>
              onChange({ ...query, conditions: query.conditions.filter((x) => x.id !== c.id) })
            }
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {query.sorts.map((s) => (
        <span key={s.column} className={chip}>
          {s.dir === 'asc' ? (
            <ArrowUpNarrowWide className="size-3 shrink-0 text-muted" />
          ) : (
            <ArrowDownWideNarrow className="size-3 shrink-0 text-muted" />
          )}
          <span className="truncate">{s.column}</span>
          <button
            className={remove}
            title="Remove sort"
            onClick={() =>
              onChange({ ...query, sorts: query.sorts.filter((x) => x.column !== s.column) })
            }
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {!active.length && !query.sorts.length && !open && (
        <span className="truncate text-[11.5px] text-faint">All rows</span>
      )}
    </div>
  )
}
