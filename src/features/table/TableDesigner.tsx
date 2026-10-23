import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  FilePlus2,
  KeyRound,
  Link2,
  Plus,
  Save,
  Trash2,
  Undo2
} from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  columnChanged,
  countChanges,
  ddlScript,
  draftFromTable,
  draftId,
  draftWarnings,
  foreignKeyActions,
  foreignKeyName,
  indexName,
  newColumn,
  newTableDraft,
  primaryKeyOf,
  tableStatements,
  validateDraft,
  type ColumnDraft,
  type ForeignKeyAction,
  type ForeignKeyDraft,
  type IndexDraft,
  type TableDraft
} from '@/lib/ddl'
import { ENGINES, type Dialect } from '@/lib/engines'
import { plural } from '@/lib/format'
import { queries } from '@/lib/queries'
import { createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import {
  connectionsStore,
  newQueryTab,
  openTable,
  refreshConnection,
  tabsStore,
  updateTab
} from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Input,
  Modal,
  Segmented,
  Select,
  Spinner
} from '@/components/ui'

interface Request {
  connectionId: string
  database: string
  /** Schema as the explorer knows it (null for MySQL) */
  schema: string | null
  /** Table to modify; null to create one */
  name: string | null
}

const designerStore = createStore<Request | null>(null)

export function openTableDesigner(
  connectionId: string,
  database: string,
  schema: string | null,
  name: string | null = null
): void {
  designerStore.set({ connectionId, database, schema, name })
}

const close = (): void => designerStore.set(null)

export function TableDesignerHost(): React.JSX.Element | null {
  const request = designerStore.use()
  if (!request) return null
  return (
    <TableDesigner
      key={`${request.connectionId}/${request.database}/${request.schema}/${request.name}`}
      {...request}
    />
  )
}

const TYPES: Record<Dialect, string[]> = {
  // SQLite only has storage classes; any type name maps onto one of them
  sqlite: ['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC', 'BOOLEAN', 'DATETIME'],
  postgres: [
    'integer',
    'bigint',
    'smallint',
    'numeric(10,2)',
    'real',
    'double precision',
    'boolean',
    'text',
    'varchar(255)',
    'char(1)',
    'uuid',
    'date',
    'time',
    'timestamp',
    'timestamptz',
    'interval',
    'json',
    'jsonb',
    'bytea',
    'inet'
  ],
  mysql: [
    'int',
    'bigint',
    'smallint',
    'tinyint',
    'tinyint(1)',
    'decimal(10,2)',
    'float',
    'double',
    'varchar(255)',
    'char(1)',
    'text',
    'mediumtext',
    'longtext',
    'date',
    'time',
    'datetime',
    'timestamp',
    'json',
    'blob',
    'binary(16)'
  ],
  tsql: [
    'int',
    'bigint',
    'smallint',
    'tinyint',
    'bit',
    'decimal(18,2)',
    'money',
    'float',
    'real',
    'nvarchar(255)',
    'nvarchar(max)',
    'varchar(255)',
    'nchar(1)',
    'uniqueidentifier',
    'date',
    'time',
    'datetime2',
    'datetimeoffset',
    'varbinary(max)'
  ]
}

function TableDesigner(request: Request): React.JSX.Element {
  const { connectionId, database, schema, name } = request
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const dialect: Dialect = (connection && ENGINES[connection.engine].dialect) || 'postgres'
  // Always read fresh metadata: the ALTERs are computed against it
  const table = useQuery({
    ...queries.table(connectionId, database, schema, name ?? ''),
    enabled: name !== null,
    staleTime: 0
  })
  // Wait for the fresh fetch only; later refetches mustn't unmount the form and lose edits
  if (name !== null && (!table.isFetchedAfterMount || !table.data)) {
    return (
      <Modal width="sm" title={`Design ${name}`} onClose={close}>
        {table.isError ? (
          <ErrorText error={table.error} />
        ) : (
          <div className="flex justify-center py-6">
            <Spinner className="size-5" />
          </div>
        )}
      </Modal>
    )
  }
  // MySQL qualifies by database; the others by schema
  const draftSchema =
    connection?.engine === 'mysql' ? database : (schema ?? (dialect === 'tsql' ? 'dbo' : 'public'))
  const initial =
    name !== null && table.data
      ? draftFromTable(dialect, draftSchema, name, table.data)
      : newTableDraft(dialect, draftSchema)
  return <DesignerForm request={request} dialect={dialect} initial={initial} />
}

type View = 'columns' | 'indexes' | 'foreignKeys' | 'sql'

function DesignerForm({
  request,
  dialect,
  initial
}: {
  request: Request
  dialect: Dialect
  initial: TableDraft
}): React.JSX.Element {
  const { connectionId, database } = request
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const mysql = connection?.engine === 'mysql'
  const [draft, setDraft] = useState(initial)
  const [view, setView] = useState<View>('columns')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const creating = !draft.original

  const babelfish = connection?.engine === 'babelfish'
  const statements = useMemo(
    () => tableStatements(dialect, draft, { babelfish }),
    [dialect, draft, babelfish]
  )
  const script = useMemo(() => ddlScript(dialect, statements), [dialect, statements])
  const problem = validateDraft(dialect, draft)
  const warnings = draftWarnings(draft)
  const changes = countChanges(draft)
  const destructive = draft.columns.some((c) => c.original && c.dropped)

  const schemas = useQuery({
    ...queries.schemas(connectionId, database),
    enabled: creating && !mysql
  })

  const apply = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    const session = `designer-${draftId()}`
    try {
      const out = await api.execute(connectionId, session, database, script)
      if (out.error) throw new Error(out.error.message)
      const newName = draft.name.trim()
      const tabSchema = mysql ? request.schema : draft.schema
      if (draft.original && newName !== draft.original.name) {
        for (const tab of tabsStore.get().tabs) {
          if (
            tab.kind === 'table' &&
            tab.connectionId === connectionId &&
            tab.database === database &&
            tab.schema === tabSchema &&
            tab.name === draft.original.name
          )
            updateTab(tab.id, { name: newName })
        }
      }
      toast(creating ? `Created ${newName}` : `Updated ${newName}`)
      refreshConnection(connectionId)
      close()
      openTable(connectionId, database, tabSchema, newName, 'table', 'structure')
    } catch (e) {
      setError(errorMessage(e))
      // XACT_ABORT doesn't roll back after a compile error, which leaves the transaction open
      if (dialect === 'tsql') {
        await api
          .execute(connectionId, session, database, 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;')
          .catch(() => undefined)
      }
    } finally {
      setRunning(false)
      void api.closeSession(connectionId, session).catch(() => undefined)
    }
  }

  const liveColumns = draft.columns.filter((c) => !c.dropped)
  const views: { value: View; label: string; count?: number }[] = [
    { value: 'columns', label: 'Columns', count: liveColumns.length },
    {
      value: 'indexes',
      label: 'Indexes',
      count: draft.indexes.filter((ix) => !ix.dropped).length
    },
    {
      value: 'foreignKeys',
      label: 'Foreign keys',
      count: draft.foreignKeys.filter((fk) => !fk.dropped).length
    },
    { value: 'sql', label: 'SQL', count: statements.length }
  ]

  const status = problem ? (
    <span className="text-danger">{problem}</span>
  ) : warnings.length ? (
    <span className="flex min-w-0 items-center gap-1.5 text-warn" title={warnings.join('\n')}>
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="truncate">{warnings.join(' · ')}</span>
    </span>
  ) : creating ? null : (
    <span className="text-muted">{changes ? plural(changes, 'change') : 'No changes'}</span>
  )

  return (
    <Modal
      width="2xl"
      title={creating ? 'New table' : `Design ${draft.original!.name}`}
      description={
        <span className="font-mono">
          {database}
          {!mysql && draft.schema ? `.${draft.schema}` : ''}
        </span>
      }
      onClose={close}
      footer={
        <>
          <div className="mr-auto min-w-0 text-xs">{status}</div>
          {connection?.readOnly && <Badge tone="warning">read-only connection</Badge>}
          <Button
            variant="secondary"
            disabled={!script || !!problem}
            onClick={() => {
              newQueryTab(connectionId, database, script, {
                title: creating ? `create ${draft.name.trim()}` : `alter ${draft.original!.name}`
              })
              close()
            }}
          >
            <FilePlus2 className="size-3.5" /> Open in editor
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            disabled={!script || !!problem || running || connection?.readOnly}
            onClick={() => void apply()}
          >
            {running ? <Spinner className="text-current" /> : <Save className="size-3.5" />}
            {creating ? 'Create table' : destructive ? 'Apply and drop data' : 'Apply changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-end gap-3">
          {!mysql &&
            (creating ? (
              <Field label="Schema" className="w-48">
                <Select
                  value={draft.schema ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, schema: e.target.value }))}
                >
                  {[
                    ...new Set([
                      draft.schema ?? '',
                      ...(schemas.data?.filter((s) => !s.isSystem).map((s) => s.name) ?? [])
                    ])
                  ].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Schema" className="w-48">
                <Input value={draft.schema ?? ''} disabled mono />
              </Field>
            ))}
          <Field label="Table name" className="flex-1">
            <Input
              mono
              value={draft.name}
              placeholder="table_name"
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </Field>
          <Segmented value={view} options={views} onChange={setView} className="mb-1" />
        </div>
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
            <ErrorText error={error} />
          </div>
        )}
        <div className="min-h-[22rem]">
          {view === 'columns' ? (
            <ColumnsEditor dialect={dialect} draft={draft} setDraft={setDraft} />
          ) : view === 'indexes' ? (
            <IndexesEditor draft={draft} setDraft={setDraft} />
          ) : view === 'foreignKeys' ? (
            <ForeignKeysEditor
              connectionId={connectionId}
              database={database}
              dialect={dialect}
              mysql={mysql}
              draft={draft}
              setDraft={setDraft}
            />
          ) : (
            <SqlPreview dialect={dialect} script={script} warnings={warnings} />
          )}
        </div>
      </div>
    </Modal>
  )
}

type SetDraft = React.Dispatch<React.SetStateAction<TableDraft>>

const cellInput = 'h-7 text-xs'
const checkbox = 'size-3.5 accent-accent disabled:opacity-40'

/* ---------- Columns ---------- */

function ColumnsEditor({
  dialect,
  draft,
  setDraft
}: {
  dialect: Dialect
  draft: TableDraft
  setDraft: SetDraft
}): React.JSX.Element {
  const creating = !draft.original
  const comments = dialect !== 'tsql'
  const keys = primaryKeyOf(draft)
  const patch = (id: string, change: Partial<ColumnDraft>): void =>
    setDraft((d) => ({
      ...d,
      columns: d.columns.map((c) => (c.id === id ? { ...c, ...change } : c))
    }))
  const toggleKey = (c: ColumnDraft): void =>
    setDraft((d) =>
      d.primaryKey.includes(c.id)
        ? { ...d, primaryKey: d.primaryKey.filter((id) => id !== c.id) }
        : {
            ...d,
            primaryKey: [...d.primaryKey, c.id],
            columns: d.columns.map((x) => (x.id === c.id ? { ...x, nullable: false } : x))
          }
    )
  const remove = (c: ColumnDraft): void =>
    setDraft((d) =>
      c.original
        ? {
            ...d,
            columns: d.columns.map((x) => (x.id === c.id ? { ...x, dropped: !x.dropped } : x))
          }
        : {
            ...d,
            columns: d.columns.filter((x) => x.id !== c.id),
            primaryKey: d.primaryKey.filter((id) => id !== c.id),
            indexes: d.indexes.map((ix) =>
              ix.original ? ix : { ...ix, columns: ix.columns.filter((id) => id !== c.id) }
            ),
            foreignKeys: d.foreignKeys.map((fk) =>
              fk.original ? fk : { ...fk, columns: fk.columns.filter((id) => id !== c.id) }
            )
          }
    )
  const move = (index: number, by: number): void =>
    setDraft((d) => {
      const columns = [...d.columns]
      const [c] = columns.splice(index, 1)
      columns.splice(index + by, 0, c)
      return { ...d, columns }
    })
  const add = (): void => setDraft((d) => ({ ...d, columns: [...d.columns, newColumn(dialect)] }))

  const grid = cn(
    'grid items-center gap-x-2',
    comments
      ? 'grid-cols-[1.25rem_minmax(0,1.2fr)_minmax(0,1.1fr)_2rem_3.5rem_3.5rem_minmax(0,1fr)_minmax(0,1fr)_3.75rem]'
      : 'grid-cols-[1.25rem_minmax(0,1.2fr)_minmax(0,1.1fr)_2rem_3.5rem_3.5rem_minmax(0,1.4fr)_3.75rem]'
  )
  const identityLabel = dialect === 'mysql' ? 'Auto inc.' : 'Identity'

  return (
    <div>
      <datalist id={`ddl-types-${dialect}`}>
        {TYPES[dialect].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className={cn(grid, 'pb-1.5 text-[11px] font-medium text-muted')}>
        <span />
        <span>Name</span>
        <span>Type</span>
        <span className="text-center" title="Primary key">
          PK
        </span>
        <span className="text-center">Not null</span>
        <span className="text-center">{identityLabel}</span>
        <span>Default</span>
        {comments && <span>Comment</span>}
        <span />
      </div>
      <div className="space-y-1">
        {draft.columns.map((c, i) => {
          const key = keys.includes(c.id)
          const changed = columnChanged(draft, c)
          const locked = c.dropped || c.computed
          return (
            <div
              key={c.id}
              className={cn(grid, 'rounded-md py-0.5', c.dropped && 'opacity-45')}
              title={
                c.computed ? 'Computed column: it can be dropped but not altered here' : undefined
              }
            >
              <span className="flex justify-center" title={columnState(c, changed)}>
                {key ? (
                  <KeyRound className="size-3.5 text-warn" />
                ) : (
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      c.dropped
                        ? 'bg-danger'
                        : !c.original
                          ? 'bg-accent'
                          : changed
                            ? 'bg-warn'
                            : 'bg-line-strong'
                    )}
                  />
                )}
              </span>
              <Input
                mono
                className={cn(cellInput, c.dropped && 'line-through')}
                value={c.name}
                placeholder="column_name"
                disabled={c.dropped}
                onChange={(e) => patch(c.id, { name: e.target.value })}
              />
              <Input
                mono
                className={cn(cellInput, 'text-syn-type')}
                value={c.dataType}
                list={`ddl-types-${dialect}`}
                disabled={locked}
                onChange={(e) => patch(c.id, { dataType: e.target.value })}
              />
              <span className="flex justify-center">
                <input
                  type="checkbox"
                  className={checkbox}
                  checked={key}
                  disabled={c.dropped}
                  onChange={() => toggleKey(c)}
                  aria-label="Primary key"
                />
              </span>
              <span className="flex justify-center">
                <input
                  type="checkbox"
                  className={checkbox}
                  checked={!c.nullable || key || c.identity}
                  disabled={locked || key || c.identity}
                  onChange={(e) => patch(c.id, { nullable: !e.target.checked })}
                  aria-label="Not null"
                />
              </span>
              <span className="flex justify-center">
                {c.computed ? (
                  <Badge tone="info">computed</Badge>
                ) : (
                  <input
                    type="checkbox"
                    className={checkbox}
                    checked={c.identity}
                    // SQL Server can't add or remove IDENTITY on an existing column
                    disabled={locked || (dialect === 'tsql' && !!c.original)}
                    onChange={(e) =>
                      patch(c.id, {
                        identity: e.target.checked,
                        ...(e.target.checked && { nullable: false })
                      })
                    }
                    aria-label={identityLabel}
                  />
                )}
              </span>
              <Input
                mono
                className={cellInput}
                value={c.identity ? '' : c.default}
                placeholder={c.identity ? 'generated' : 'none'}
                disabled={locked || c.identity}
                onChange={(e) => patch(c.id, { default: e.target.value })}
                title="SQL expression, e.g. 0, 'text' or now()"
              />
              {comments && (
                <Input
                  className={cellInput}
                  value={c.comment}
                  disabled={locked}
                  onChange={(e) => patch(c.id, { comment: e.target.value })}
                />
              )}
              <span className="flex items-center justify-end gap-0.5">
                {creating && (
                  <>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Move up"
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title="Move down"
                      disabled={i === draft.columns.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                  </>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title={c.dropped ? 'Keep column' : c.original ? 'Drop column' : 'Remove'}
                  className={c.dropped ? undefined : 'hover:text-danger'}
                  onClick={() => remove(c)}
                >
                  {c.dropped ? <Undo2 className="size-3.5" /> : <Trash2 className="size-3.5" />}
                </Button>
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" variant="secondary" onClick={add}>
          <Plus className="size-3.5" /> Add column
        </Button>
        {!creating && (
          <span className="text-[11px] text-faint">
            New columns are added at the end of the table.
          </span>
        )}
      </div>
    </div>
  )
}

function columnState(c: ColumnDraft, changed: boolean): string {
  if (c.dropped) return 'Will be dropped'
  if (!c.original) return 'New column'
  if (changed) return 'Modified'
  return 'Unchanged'
}

/* ---------- Shared pieces ---------- */

/** Toggle chips for picking columns in order; selected chips show their position. */
function ColumnPicker({
  options,
  value,
  onChange
}: {
  options: { id: string; label: string }[]
  value: string[]
  onChange: (value: string[]) => void
}): React.JSX.Element {
  if (!options.length) return <span className="text-[11px] text-faint">No columns</span>
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const position = value.indexOf(o.id)
        return (
          <button
            key={o.id}
            type="button"
            onClick={() =>
              onChange(position >= 0 ? value.filter((id) => id !== o.id) : [...value, o.id])
            }
            className={cn(
              'flex h-6 items-center gap-1 rounded-md px-2 font-mono text-[11.5px] ring-1 transition-colors ring-inset',
              position >= 0
                ? 'bg-accent/10 text-bright ring-accent/40'
                : 'text-muted ring-line-strong hover:text-bright'
            )}
          >
            {position >= 0 && (
              <span className="text-[10px] text-accent tabular-nums">{position + 1}</span>
            )}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function ExistingRow({
  dropped,
  onToggle,
  children
}: {
  dropped: boolean
  onToggle: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-line/60 py-1.5 font-mono text-[12px]',
        dropped && 'line-through opacity-45'
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <Button
        size="icon-sm"
        variant="ghost"
        title={dropped ? 'Keep' : 'Drop'}
        className={dropped ? undefined : 'hover:text-danger'}
        onClick={onToggle}
      >
        {dropped ? <Undo2 className="size-3.5" /> : <Trash2 className="size-3.5" />}
      </Button>
    </div>
  )
}

function NewCard({
  onRemove,
  children
}: {
  onRemove: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="relative space-y-3 rounded-lg border border-accent/25 bg-accent/[0.03] p-3 pr-10">
      {children}
      <Button
        size="icon-sm"
        variant="ghost"
        title="Remove"
        className="absolute top-2 right-2 hover:text-danger"
        onClick={onRemove}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}

const columnOptions = (draft: TableDraft): { id: string; label: string }[] =>
  draft.columns
    .filter((c) => !c.dropped && c.name.trim())
    .map((c) => ({ id: c.id, label: c.name.trim() }))

/* ---------- Indexes ---------- */

function IndexesEditor({
  draft,
  setDraft
}: {
  draft: TableDraft
  setDraft: SetDraft
}): React.JSX.Element {
  const patch = (id: string, change: Partial<IndexDraft>): void =>
    setDraft((d) => ({
      ...d,
      indexes: d.indexes.map((ix) => (ix.id === id ? { ...ix, ...change } : ix))
    }))
  const existing = draft.indexes.filter((ix) => ix.original)
  const added = draft.indexes.filter((ix) => !ix.original)
  return (
    <div className="space-y-4">
      {existing.length > 0 && (
        <div>
          {existing.map((ix) => (
            <ExistingRow
              key={ix.id}
              dropped={ix.dropped}
              onToggle={() => patch(ix.id, { dropped: !ix.dropped })}
            >
              <span className="text-bright">{ix.name}</span>
              <span className="truncate text-muted">({ix.original!.columns.join(', ')})</span>
              {ix.unique && <Badge tone="info">unique</Badge>}
              {ix.original!.method && <span className="text-faint">{ix.original!.method}</span>}
            </ExistingRow>
          ))}
          <p className="mt-2 text-[11px] text-faint">
            To change an existing index, drop it and add a new one.
          </p>
        </div>
      )}
      {added.map((ix) => (
        <NewCard
          key={ix.id}
          onRemove={() =>
            setDraft((d) => ({ ...d, indexes: d.indexes.filter((x) => x.id !== ix.id) }))
          }
        >
          <div className="flex items-end gap-3">
            <Field label="Name" className="flex-1">
              <Input
                mono
                className={cellInput}
                value={ix.name}
                placeholder={indexName(draft, { ...ix, name: '' })}
                onChange={(e) => patch(ix.id, { name: e.target.value })}
              />
            </Field>
            <label className="mb-1.5 flex items-center gap-2 text-xs text-fg">
              <input
                type="checkbox"
                className={checkbox}
                checked={ix.unique}
                onChange={(e) => patch(ix.id, { unique: e.target.checked })}
              />
              Unique
            </label>
          </div>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted">Columns, in key order</span>
            <ColumnPicker
              options={columnOptions(draft)}
              value={ix.columns}
              onChange={(columns) => patch(ix.id, { columns })}
            />
          </div>
        </NewCard>
      ))}
      {!existing.length && !added.length && (
        <p className="text-xs text-faint">No indexes besides the primary key.</p>
      )}
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          setDraft((d) => ({
            ...d,
            indexes: [
              ...d.indexes,
              {
                id: draftId(),
                original: null,
                name: '',
                columns: [],
                unique: false,
                dropped: false
              }
            ]
          }))
        }
      >
        <Plus className="size-3.5" /> Add index
      </Button>
    </div>
  )
}

/* ---------- Foreign keys ---------- */

function ForeignKeysEditor({
  connectionId,
  database,
  dialect,
  mysql,
  draft,
  setDraft
}: {
  connectionId: string
  database: string
  dialect: Dialect
  mysql: boolean
  draft: TableDraft
  setDraft: SetDraft
}): React.JSX.Element {
  const tables = useQuery(queries.completion(connectionId, database))
  const patch = (id: string, change: Partial<ForeignKeyDraft>): void =>
    setDraft((d) => ({
      ...d,
      foreignKeys: d.foreignKeys.map((fk) => (fk.id === id ? { ...fk, ...change } : fk))
    }))
  const existing = draft.foreignKeys.filter((fk) => fk.original)
  const added = draft.foreignKeys.filter((fk) => !fk.original)
  const tableKey = (schema: string | null, name: string): string => `${schema ?? ''}\u0000${name}`
  const tableLabel = (schema: string | null, name: string): string =>
    schema && !mysql ? `${schema}.${name}` : name
  const actions = foreignKeyActions(dialect)
  return (
    <div className="space-y-4">
      {existing.length > 0 && (
        <div>
          {existing.map((fk) => (
            <ExistingRow
              key={fk.id}
              dropped={fk.dropped}
              onToggle={() => patch(fk.id, { dropped: !fk.dropped })}
            >
              <Link2 className="size-3.5 shrink-0 text-syn-fn" />
              <span className="text-bright">{fk.name}</span>
              <span className="truncate text-muted">
                ({fk.original!.columns.join(', ')}) → {tableLabel(fk.refSchema, fk.refTable)}(
                {fk.refColumns.join(', ')})
              </span>
              {fk.onDelete !== 'NO ACTION' && <Badge>on delete {fk.onDelete.toLowerCase()}</Badge>}
            </ExistingRow>
          ))}
          <p className="mt-2 text-[11px] text-faint">
            To change an existing foreign key, drop it and add a new one.
          </p>
        </div>
      )}
      {added.map((fk) => {
        const target = tables.data?.find(
          (t) => t.name === fk.refTable && (t.schema ?? null) === (fk.refSchema ?? null)
        )
        return (
          <NewCard
            key={fk.id}
            onRemove={() =>
              setDraft((d) => ({
                ...d,
                foreignKeys: d.foreignKeys.filter((x) => x.id !== fk.id)
              }))
            }
          >
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem_9rem] items-end gap-3">
              <Field label="Name">
                <Input
                  mono
                  className={cellInput}
                  value={fk.name}
                  placeholder={foreignKeyName(draft, { ...fk, name: '' })}
                  onChange={(e) => patch(fk.id, { name: e.target.value })}
                />
              </Field>
              <Field label="References table">
                <Select
                  selectClassName="h-7 font-mono text-xs"
                  value={fk.refTable ? tableKey(fk.refSchema, fk.refTable) : ''}
                  onChange={(e) => {
                    const [schema, name] = e.target.value.split('\u0000')
                    patch(fk.id, {
                      refSchema: schema || null,
                      refTable: name ?? '',
                      refColumns: []
                    })
                  }}
                >
                  <option value="" disabled>
                    {tables.isPending ? 'Loading…' : 'Choose a table'}
                  </option>
                  {tables.data?.map((t) => (
                    <option key={tableKey(t.schema, t.name)} value={tableKey(t.schema, t.name)}>
                      {tableLabel(t.schema, t.name)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="On delete">
                <Select
                  selectClassName="h-7 text-xs"
                  value={fk.onDelete}
                  onChange={(e) => patch(fk.id, { onDelete: e.target.value as ForeignKeyAction })}
                >
                  {actions.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </Select>
              </Field>
              <Field label="On update">
                <Select
                  selectClassName="h-7 text-xs"
                  value={fk.onUpdate}
                  onChange={(e) => patch(fk.id, { onUpdate: e.target.value as ForeignKeyAction })}
                >
                  {actions.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted">Columns</span>
                <ColumnPicker
                  options={columnOptions(draft)}
                  value={fk.columns}
                  onChange={(columns) => patch(fk.id, { columns })}
                />
              </div>
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted">Referenced columns, in order</span>
                {target ? (
                  <ColumnPicker
                    options={target.columns.map((c) => ({ id: c, label: c }))}
                    value={fk.refColumns}
                    onChange={(refColumns) => patch(fk.id, { refColumns })}
                  />
                ) : (
                  <p className="text-[11px] text-faint">Choose a table first.</p>
                )}
              </div>
            </div>
          </NewCard>
        )
      })}
      {tables.isError && <ErrorText error={tables.error} />}
      {!existing.length && !added.length && <p className="text-xs text-faint">No foreign keys.</p>}
      <Button
        size="sm"
        variant="secondary"
        onClick={() =>
          setDraft((d) => ({
            ...d,
            foreignKeys: [
              ...d.foreignKeys,
              {
                id: draftId(),
                original: null,
                name: '',
                columns: [],
                refSchema: null,
                refTable: '',
                refColumns: [],
                onDelete: 'NO ACTION',
                onUpdate: 'NO ACTION',
                dropped: false
              }
            ]
          }))
        }
      >
        <Plus className="size-3.5" /> Add foreign key
      </Button>
    </div>
  )
}

/* ---------- SQL preview ---------- */

function SqlPreview({
  dialect,
  script,
  warnings
}: {
  dialect: Dialect
  script: string
  warnings: string[]
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
          {warnings.map((w) => (
            <li key={w} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-px size-3.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      <div className="h-[20rem] overflow-hidden rounded-lg border border-line bg-canvas">
        <CodeEditor
          value={script || '-- No changes'}
          language={{ kind: 'sql', dialect }}
          readOnly
          className="h-full"
          fontSize={12}
        />
      </div>
      <p className="text-[11px] text-faint">
        {dialect === 'mysql'
          ? 'MySQL commits each DDL statement on its own; changes are grouped into a single ALTER TABLE.'
          : dialect === 'tsql'
            ? 'Runs in a transaction that rolls back if any statement fails.'
            : 'Runs as a single transaction: if any statement fails, nothing is changed.'}
      </p>
    </div>
  )
}
