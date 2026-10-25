import { useQuery } from '@tanstack/react-query'
import { Layers, Plus, Trash2, Undo2, Unlink } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { TableDraft } from '@/lib/ddl'
import { formatCount } from '@/lib/format'
import {
  canDetachConcurrently,
  canExcludeOnPartitioned,
  EXCLUSION_METHODS,
  exclusionName,
  loadPgTableContext,
  needsBtreeGist,
  newExclusion,
  newParameter,
  newPartition,
  partitionStrategy,
  STORAGE_PARAMETERS,
  type Deferrable,
  type ExclusionDraft,
  type PartitionDraft,
  type PartitionStrategy,
  type PgTableContext,
  type PgTableOptions
} from '@/lib/pg-table-options'
import { queries } from '@/lib/queries'
import type { ExclusionInfo } from '@/lib/table-extras'
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Segmented,
  Select,
  Spinner,
  Textarea,
  Toggle
} from '@/components/ui'
import {
  cellInput,
  checkbox,
  ColumnPicker,
  columnOptions,
  ExistingRow,
  NewCard
} from './TableDesigner'

/**
 * What the designer's PostgreSQL options need: server version, tablespaces,
 * btree_gist and, for an existing table, its current options and partitions.
 * `context` is null until loaded.
 */
export function usePgTableContext(
  connectionId: string,
  database: string,
  schema: string | null,
  table: string | null,
  exclusions: ExclusionInfo[] | undefined,
  enabled: boolean
): { context: PgTableContext | null; error: Error | null } {
  const q = useQuery({
    queryKey: ['conn', connectionId, 'pg-table-options', database, schema, table],
    queryFn: () => loadPgTableContext(connectionId, database, schema, table, exclusions),
    enabled,
    staleTime: 0,
    gcTime: 0
  })
  return { context: q.isFetchedAfterMount ? (q.data ?? null) : null, error: q.error }
}

type OnChange = (change: (options: PgTableOptions) => PgTableOptions) => void

function Loading({ error }: { error: Error | null }): React.JSX.Element {
  if (error) return <ErrorText error={error} />
  return <EmptyState title="Loading…" icon={<Spinner className="size-5" />} />
}

/* ---------- Partitioning ---------- */

const STRATEGIES: { value: PartitionStrategy | ''; label: string }[] = [
  { value: '', label: 'Not partitioned' },
  { value: 'RANGE', label: 'Range' },
  { value: 'LIST', label: 'List' },
  { value: 'HASH', label: 'Hash' }
]

/** New-table partitioning (strategy and key) and the partitions to create, attach or detach. */
export function PgPartitionsEditor({
  connectionId,
  database,
  draft,
  context,
  error,
  options,
  onChange
}: {
  connectionId: string
  database: string
  draft: TableDraft
  context: PgTableContext | null
  error: Error | null
  options: PgTableOptions
  onChange: OnChange
}): React.JSX.Element {
  const creating = !draft.original
  const tables = useQuery({ ...queries.completion(connectionId, database), enabled: !!context })
  if (!context) return <Loading error={error} />
  const strategy = partitionStrategy(options, context, creating)
  const key = options.partitionKey
  const patch = (id: string, change: Partial<PartitionDraft>): void =>
    onChange((o) => ({
      ...o,
      partitions: o.partitions.map((p) => (p.id === id ? { ...p, ...change } : p))
    }))
  const tableKey = (schema: string | null, name: string): string => `${schema ?? ''}\u0000${name}`
  const self = draft.original
    ? tableKey(draft.schema, draft.original.name)
    : tableKey(draft.schema, draft.name.trim())
  const attachable = (tables.data ?? []).filter(
    (t) =>
      tableKey(t.schema, t.name) !== self &&
      !options.existingPartitions.some(
        (p) => tableKey(p.schema, p.name) === tableKey(t.schema, t.name)
      )
  )

  const boundFields = (p: PartitionDraft): React.JSX.Element => (
    <div className="flex items-end gap-3">
      {strategy === 'RANGE' && !p.isDefault && (
        <>
          <Field label="From" className="flex-1">
            <Input
              mono
              className={cellInput}
              value={p.from}
              placeholder="e.g. '2025-01-01' or MINVALUE"
              onChange={(e) => patch(p.id, { from: e.target.value })}
            />
          </Field>
          <Field label="To (exclusive)" className="flex-1">
            <Input
              mono
              className={cellInput}
              value={p.to}
              placeholder="e.g. '2026-01-01' or MAXVALUE"
              onChange={(e) => patch(p.id, { to: e.target.value })}
            />
          </Field>
        </>
      )}
      {strategy === 'LIST' && !p.isDefault && (
        <Field label="Values" className="flex-1">
          <Input
            mono
            className={cellInput}
            value={p.values}
            placeholder="e.g. 'eu', 'uk'"
            onChange={(e) => patch(p.id, { values: e.target.value })}
          />
        </Field>
      )}
      {strategy === 'HASH' && (
        <>
          <Field label="Modulus" className="w-28">
            <Input
              mono
              className={cellInput}
              value={p.modulus}
              placeholder="4"
              onChange={(e) => patch(p.id, { modulus: e.target.value })}
            />
          </Field>
          <Field label="Remainder" className="w-28">
            <Input
              mono
              className={cellInput}
              value={p.remainder}
              placeholder="0"
              onChange={(e) => patch(p.id, { remainder: e.target.value })}
            />
          </Field>
        </>
      )}
      {strategy !== 'HASH' && (
        <label className="mb-1.5 flex items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            className={checkbox}
            checked={p.isDefault}
            onChange={(e) => patch(p.id, { isDefault: e.target.checked })}
          />
          Default partition
        </label>
      )}
    </div>
  )

  const partitionForm = (p: PartitionDraft): React.JSX.Element => (
    <>
      <div className="flex items-end gap-3">
        <Segmented
          size="sm"
          className="mb-1.5"
          value={p.mode}
          options={[
            { value: 'create', label: 'New partition' },
            { value: 'attach', label: 'Attach a table' }
          ]}
          onChange={(mode) => patch(p.id, { mode, name: '', schema: null })}
        />
        {p.mode === 'create' ? (
          <Field label="Name" className="flex-1">
            <Input
              mono
              className={cellInput}
              value={p.name}
              placeholder={`${draft.name.trim() || 'table'}_2025`}
              onChange={(e) => patch(p.id, { name: e.target.value })}
            />
          </Field>
        ) : (
          <Field label="Table" className="flex-1">
            <Select
              selectClassName="h-7 font-mono text-xs"
              value={p.name ? tableKey(p.schema, p.name) : ''}
              onChange={(e) => {
                const [schema, name] = e.target.value.split('\u0000')
                patch(p.id, { schema: schema || null, name: name ?? '' })
              }}
            >
              <option value="" disabled>
                {tables.isPending ? 'Loading…' : 'Choose a table'}
              </option>
              {attachable.map((t) => (
                <option key={tableKey(t.schema, t.name)} value={tableKey(t.schema, t.name)}>
                  {t.schema ? `${t.schema}.${t.name}` : t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      {boundFields(p)}
    </>
  )

  return (
    <div className="space-y-5">
      {creating ? (
        <section className="space-y-3">
          <div className="flex items-end gap-3">
            <Field label="Strategy" className="w-44">
              <Select
                value={key.strategy}
                onChange={(e) =>
                  onChange((o) => ({
                    ...o,
                    partitionKey: {
                      ...o.partitionKey,
                      strategy: e.target.value as PartitionStrategy | ''
                    },
                    // Bounds are written for one strategy
                    partitions: e.target.value ? o.partitions : []
                  }))
                }
              >
                {STRATEGIES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            {key.strategy && (
              <Field label="Or a key expression" className="flex-1">
                <Input
                  mono
                  value={key.expression}
                  placeholder="e.g. date_trunc('month', created_at)"
                  onChange={(e) =>
                    onChange((o) => ({
                      ...o,
                      partitionKey: { ...o.partitionKey, expression: e.target.value }
                    }))
                  }
                />
              </Field>
            )}
          </div>
          {key.strategy ? (
            <>
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted">Key columns, in order</span>
                <ColumnPicker
                  options={columnOptions(draft)}
                  value={key.columns}
                  onChange={(columns) =>
                    onChange((o) => ({ ...o, partitionKey: { ...o.partitionKey, columns } }))
                  }
                />
              </div>
              <p className="text-[11px] text-faint">
                The primary key and unique constraints must include every key column; an expression
                key rules them out. Rows go to the partition whose bound they match.
              </p>
            </>
          ) : (
            <p className="text-xs text-faint">
              A partitioned table stores no rows itself: they go to partitions by range, list of
              values or hash of the key.
            </p>
          )}
        </section>
      ) : (
        <section className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <Layers className="size-3.5 text-muted" />
            <span className="text-muted">Partitioned by</span>
            <span className="font-mono text-bright">{context.partitionedBy}</span>
          </div>
          <div>
            {options.existingPartitions.map((p) => (
              <div
                key={`${p.schema}.${p.name}`}
                className={cn(
                  'flex items-center gap-2 border-b border-line/60 py-1.5 font-mono text-[12px]',
                  p.detach && 'opacity-60'
                )}
              >
                <span className={cn('text-bright', p.detach && 'line-through')}>
                  {p.schema && p.schema !== draft.schema ? `${p.schema}.` : ''}
                  {p.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted" title={p.bound}>
                  {p.bound}
                </span>
                {p.partitioned && <Badge tone="info">partitioned</Badge>}
                {p.rows !== null && (
                  <span className="font-sans text-[11px] text-faint">
                    ~{formatCount(p.rows)} rows
                  </span>
                )}
                {p.detach && canDetachConcurrently(context) && (
                  <label className="flex items-center gap-1.5 font-sans text-[11px] text-fg">
                    <input
                      type="checkbox"
                      className={checkbox}
                      checked={p.concurrently}
                      onChange={(e) =>
                        onChange((o) => ({
                          ...o,
                          existingPartitions: o.existingPartitions.map((x) =>
                            x.schema === p.schema && x.name === p.name
                              ? { ...x, concurrently: e.target.checked }
                              : x
                          )
                        }))
                      }
                    />
                    Concurrently
                  </label>
                )}
                {p.detach && <Badge tone="warning">detach</Badge>}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title={p.detach ? 'Keep attached' : 'Detach (keeps the table and its rows)'}
                  onClick={() =>
                    onChange((o) => ({
                      ...o,
                      existingPartitions: o.existingPartitions.map((x) =>
                        x.schema === p.schema && x.name === p.name
                          ? { ...x, detach: !x.detach, concurrently: false }
                          : x
                      )
                    }))
                  }
                >
                  {p.detach ? <Undo2 className="size-3.5" /> : <Unlink className="size-3.5" />}
                </Button>
              </div>
            ))}
            {!options.existingPartitions.length && (
              <p className="text-xs text-faint">
                No partitions yet: inserts fail until one matches.
              </p>
            )}
          </div>
        </section>
      )}
      {strategy && (
        <section className="space-y-3">
          {creating && <h3 className="text-xs font-semibold text-bright">Partitions</h3>}
          {options.partitions.map((p) => (
            <NewCard
              key={p.id}
              onRemove={() =>
                onChange((o) => ({ ...o, partitions: o.partitions.filter((x) => x.id !== p.id) }))
              }
            >
              {partitionForm(p)}
            </NewCard>
          ))}
          {tables.isError && <ErrorText error={tables.error} />}
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              onChange((o) => ({ ...o, partitions: [...o.partitions, newPartition()] }))
            }
          >
            <Plus className="size-3.5" /> Add partition
          </Button>
        </section>
      )}
    </div>
  )
}

/* ---------- Exclusion constraints ---------- */

const OPERATORS = ['=', '&&', '<>', '-|-', '~=', '@>', '<@']

/** Exclusion constraints: the existing ones to drop, and new ones. Shown under Constraints. */
export function PgExclusionsEditor({
  draft,
  context,
  error,
  options,
  onChange
}: {
  draft: TableDraft
  context: PgTableContext | null
  error: Error | null
  options: PgTableOptions
  onChange: OnChange
}): React.JSX.Element {
  const patch = (id: string, change: Partial<ExclusionDraft>): void =>
    onChange((o) => ({
      ...o,
      exclusions: o.exclusions.map((x) => (x.id === id ? { ...x, ...change } : x))
    }))
  const existing = options.exclusions.filter((x) => x.existing)
  const added = options.exclusions.filter((x) => !x.existing)
  const gist = needsBtreeGist(draft, options)
  const partitioned = draft.original ? !!context?.partitionedBy : !!options.partitionKey.strategy

  const form = (x: ExclusionDraft): React.JSX.Element => (
    <>
      <div className="flex items-end gap-3">
        <Field label="Name" className="flex-1">
          <Input
            mono
            className={cellInput}
            value={x.name}
            placeholder={exclusionName(draft, { ...x, name: '' })}
            onChange={(e) => patch(x.id, { name: e.target.value })}
          />
        </Field>
        <Field label="Method" className="w-32">
          <Select
            selectClassName="h-7 font-mono text-xs"
            value={x.method}
            onChange={(e) => patch(x.id, { method: e.target.value })}
          >
            <option value="">{EXCLUSION_METHODS[0]} (default)</option>
            {EXCLUSION_METHODS.slice(1).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Deferrable" className="w-48">
          <Select
            selectClassName="h-7 text-xs"
            value={x.deferrable}
            onChange={(e) => patch(x.id, { deferrable: e.target.value as Deferrable })}
          >
            <option value="">Not deferrable</option>
            <option value="DEFERRABLE">Deferrable</option>
            <option value="DEFERRABLE INITIALLY DEFERRED">Initially deferred</option>
          </Select>
        </Field>
      </div>
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted">
          No two rows where every element matches with its operator
        </span>
        {x.elements.map((el, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_7rem_1.75rem] items-center gap-2">
            <Input
              mono
              className={cellInput}
              value={el.expression}
              list="pg-exclusion-columns"
              placeholder="column or expression, e.g. tstzrange(starts, ends)"
              onChange={(e) =>
                patch(x.id, {
                  elements: x.elements.map((y, j) =>
                    j === i ? { ...y, expression: e.target.value } : y
                  )
                })
              }
            />
            <Input
              mono
              className={cellInput}
              value={el.operator}
              list="pg-exclusion-operators"
              placeholder="WITH"
              onChange={(e) =>
                patch(x.id, {
                  elements: x.elements.map((y, j) =>
                    j === i ? { ...y, operator: e.target.value } : y
                  )
                })
              }
            />
            <Button
              size="icon-sm"
              variant="ghost"
              title="Remove element"
              className="hover:text-danger"
              disabled={x.elements.length === 1}
              onClick={() => patch(x.id, { elements: x.elements.filter((_, j) => j !== i) })}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            patch(x.id, { elements: [...x.elements, { expression: '', operator: '&&' }] })
          }
        >
          <Plus className="size-3.5" /> Add element
        </Button>
      </div>
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted">
          Included columns <span className="font-normal text-faint">(stored, not compared)</span>
        </span>
        <ColumnPicker
          options={columnOptions(draft)}
          value={x.include}
          onChange={(include) => patch(x.id, { include })}
        />
      </div>
      <Field label="Only rows where (partial constraint)">
        <Input
          mono
          className={cellInput}
          value={x.where}
          placeholder="e.g. NOT cancelled"
          onChange={(e) => patch(x.id, { where: e.target.value })}
        />
      </Field>
    </>
  )

  return (
    <section className="mt-6 space-y-3">
      <datalist id="pg-exclusion-columns">
        {columnOptions(draft).map((c) => (
          <option key={c.id} value={c.label} />
        ))}
      </datalist>
      <datalist id="pg-exclusion-operators">
        {OPERATORS.map((op) => (
          <option key={op} value={op} />
        ))}
      </datalist>
      <h3 className="text-xs font-semibold text-bright">Exclusion constraints</h3>
      {!context ? (
        <Loading error={error} />
      ) : (
        <>
          {existing.length > 0 && (
            <div>
              {existing.map((x) =>
                x.existing!.inherited ? (
                  <div
                    key={x.id}
                    className="flex items-center gap-2 border-b border-line/60 py-1.5 font-mono text-[12px]"
                  >
                    <span className="shrink-0 text-bright">{x.name}</span>
                    <span className="truncate text-muted" title={x.existing!.definition}>
                      {x.existing!.definition}
                    </span>
                    <span className="ml-auto shrink-0 font-sans text-[11px] text-faint">
                      inherited from the partitioned table
                    </span>
                  </div>
                ) : (
                  <ExistingRow
                    key={x.id}
                    dropped={x.dropped}
                    change="none"
                    editing={false}
                    onToggle={() => patch(x.id, { dropped: !x.dropped })}
                  >
                    <span className="shrink-0 text-bright">{x.name}</span>
                    <span className="truncate text-muted" title={x.existing!.definition}>
                      {x.existing!.definition}
                    </span>
                  </ExistingRow>
                )
              )}
            </div>
          )}
          {added.map((x) => (
            <NewCard
              key={x.id}
              onRemove={() =>
                onChange((o) => ({ ...o, exclusions: o.exclusions.filter((y) => y.id !== x.id) }))
              }
            >
              {form(x)}
            </NewCard>
          ))}
          {gist.length > 0 && !context.btreeGist.installed && (
            <div className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
              {context.btreeGist.available ? (
                <Toggle
                  checked={options.installBtreeGist}
                  onChange={(installBtreeGist) => onChange((o) => ({ ...o, installBtreeGist }))}
                  label="Install btree_gist"
                  description={`GiST compares scalar values (like = on an integer room) only with the btree_gist extension. Adds CREATE EXTENSION IF NOT EXISTS btree_gist to the script.`}
                />
              ) : (
                <span>
                  GiST compares scalar values with = only with the btree_gist extension, which this
                  server doesn&apos;t have.
                </span>
              )}
            </div>
          )}
          {partitioned && !canExcludeOnPartitioned(context) && (
            <p className="text-[11px] text-faint">
              Exclusion constraints on partitioned tables need PostgreSQL 17; add them to each
              partition instead.
            </p>
          )}
          {!existing.length && !added.length && (
            <p className="text-xs text-faint">
              No exclusion constraints. They keep rows from overlapping, e.g. two bookings of one
              room at the same time.
            </p>
          )}
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              onChange((o) => ({ ...o, exclusions: [...o.exclusions, newExclusion()] }))
            }
          >
            <Plus className="size-3.5" /> Add exclusion constraint
          </Button>
        </>
      )}
    </section>
  )
}

/* ---------- Storage ---------- */

/** Persistence, storage parameters, tablespace and comment. */
export function PgStorageEditor({
  draft,
  context,
  error,
  options,
  onChange
}: {
  draft: TableDraft
  context: PgTableContext | null
  error: Error | null
  options: PgTableOptions
  onChange: OnChange
}): React.JSX.Element {
  if (!context) return <Loading error={error} />
  const creating = !draft.original
  const partitioned = creating ? !!options.partitionKey.strategy : !!context.partitionedBy
  const known = STORAGE_PARAMETERS.filter((p) => !p.since || context.version >= p.since)
  const patchParameter = (id: string, change: { name?: string; value?: string }): void =>
    onChange((o) => ({
      ...o,
      parameters: o.parameters.map((p) => (p.id === id ? { ...p, ...change } : p))
    }))
  const tablespaces = [
    ...new Set([...(options.tablespace ? [options.tablespace] : []), ...context.tablespaces])
  ].filter((t) => t !== context.defaultTablespace)
  return (
    <div className="max-w-2xl space-y-5">
      <datalist id="pg-storage-parameters">
        {known.map((p) => (
          <option key={p.name} value={p.name}>
            {p.hint}
          </option>
        ))}
      </datalist>
      {context.partitionOf && (
        <p className="text-xs text-muted">
          Partition of <span className="font-mono text-bright">{context.partitionOf}</span>
        </p>
      )}
      <div className="text-xs">
        <Toggle
          checked={options.unlogged}
          disabled={partitioned && !options.unlogged}
          onChange={(unlogged) => onChange((o) => ({ ...o, unlogged }))}
          label="Unlogged"
          description={
            partitioned
              ? 'Partitioned tables hold no rows; make each partition unlogged instead.'
              : 'Skips the write-ahead log: faster writes, but emptied after a crash and not replicated.'
          }
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Tablespace"
          hint={
            creating
              ? undefined
              : partitioned
                ? 'Where new partitions go by default'
                : 'Moving rewrites the table under an exclusive lock'
          }
        >
          <Select
            value={options.tablespace}
            onChange={(e) => onChange((o) => ({ ...o, tablespace: e.target.value }))}
          >
            <option value="">Database default ({context.defaultTablespace})</option>
            {tablespaces.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Comment">
        <Textarea
          className="min-h-14"
          value={options.comment}
          onChange={(e) => onChange((o) => ({ ...o, comment: e.target.value }))}
        />
      </Field>
      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-bright">Storage parameters</h3>
        {partitioned ? (
          <p className="text-xs text-faint">
            Partitioned tables take no storage parameters; set fillfactor and autovacuum on each
            partition.
          </p>
        ) : (
          <>
            {options.parameters.map((p) => {
              const hint = known.find((k) => k.name === p.name.trim().toLowerCase())?.hint
              return (
                <div
                  key={p.id}
                  className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_1.75rem] items-center gap-2"
                >
                  <Input
                    mono
                    className={cellInput}
                    value={p.name}
                    list="pg-storage-parameters"
                    placeholder="fillfactor"
                    onChange={(e) => patchParameter(p.id, { name: e.target.value })}
                  />
                  <Input
                    mono
                    className={cellInput}
                    value={p.value}
                    placeholder={hint ?? 'value'}
                    title={hint}
                    onChange={(e) => patchParameter(p.id, { value: e.target.value })}
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title="Reset to the default"
                    className="hover:text-danger"
                    onClick={() =>
                      onChange((o) => ({
                        ...o,
                        parameters: o.parameters.filter((x) => x.id !== p.id)
                      }))
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              )
            })}
            {!options.parameters.length && (
              <p className="text-xs text-faint">Server defaults apply.</p>
            )}
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                onChange((o) => ({ ...o, parameters: [...o.parameters, newParameter()] }))
              }
            >
              <Plus className="size-3.5" /> Add parameter
            </Button>
            <p className="text-[11px] text-faint">
              fillfactor applies to pages written from now on; toast.* parameters apply to the
              table&apos;s TOAST storage.
            </p>
          </>
        )}
      </section>
    </div>
  )
}
