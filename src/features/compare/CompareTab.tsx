import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeftRight,
  ChevronDown,
  ClipboardCopy,
  Database,
  Eye,
  FileCode2,
  FunctionSquare,
  GitCompareArrows,
  Layers,
  ListOrdered,
  Minus,
  Pencil,
  Plus,
  Puzzle,
  Save,
  Shapes,
  Table2,
  TriangleAlert
} from 'lucide-react'
import type { ConnectionConfig } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  compareSnapshots,
  defaultSelection,
  diffLines,
  migrationScript,
  migrationStatements,
  type Change,
  type CompareScope,
  type DiffAction,
  type DiffItem
} from '@/lib/compare'
import { ENGINES, connectionLabel, type Dialect } from '@/lib/engines'
import { copyText, saveToFile } from '@/lib/export'
import { queries } from '@/lib/queries'
import {
  connect,
  connectionsStore,
  newQueryTab,
  statusStore,
  updateTab,
  type CompareTarget,
  type TabOf
} from '@/lib/workspace'
import { showMenuAt, type MenuItem } from '@/components/ContextMenu'
import { CodeEditor } from '@/components/editor/CodeEditor'
import {
  Badge,
  Button,
  EmptyState,
  EngineMark,
  ErrorText,
  ProgressBar,
  Segmented,
  Spinner
} from '@/components/ui'
import { loadSnapshot, type SideRef } from './load'

/** Dialects the DDL generator can write migrations for. */
const COMPARABLE: Dialect[] = ['postgres', 'mysql', 'tsql']

const dialectOf = (c: ConnectionConfig | undefined): Dialect | null =>
  (c && ENGINES[c.engine].dialect) || null

const defaultSchema = (dialect: Dialect | null): string | null =>
  dialect === 'postgres' ? 'public' : dialect === 'tsql' ? 'dbo' : null

/* ---------- Tab ---------- */

export function CompareTab({ tab }: { tab: TabOf<'compare'> }): React.JSX.Element {
  const connection = connectionsStore.use().find((c) => c.id === tab.connectionId)
  const status = statusStore.use()[tab.connectionId]
  useEffect(() => {
    if (connection && status?.state !== 'connected') void connect(connection.id)
  }, [connection, status?.state])
  if (!connection) return <EmptyState title="This connection no longer exists" />
  const dialect = dialectOf(connection)
  if (!dialect || !COMPARABLE.includes(dialect))
    return (
      <EmptyState title="Comparing isn’t available for this kind of connection">
        Schema comparison works with PostgreSQL, MySQL, SQL Server and Babelfish.
      </EmptyState>
    )
  if (status?.state !== 'connected')
    return <EmptyState title="Connecting…" icon={<Spinner className="size-5" />} />
  return <CompareView tab={tab} dialect={dialect} />
}

interface Result {
  /** The sides and scope compared, to tell when the pickers have moved on */
  key: string
  dialect: Dialect
  items: DiffItem[]
  failed: string[]
  source: string
  target: string
  babelfish: boolean
}

function sideLabel(side: SideRef, scope: CompareScope, dialect: Dialect): string {
  const connection = connectionsStore.get().find((c) => c.id === side.connectionId)
  const parts = [side.database]
  if (scope !== 'database' && dialect !== 'mysql' && side.schema) parts.push(side.schema)
  if (scope === 'table' && side.table) parts.push(side.table)
  return `${connection ? connectionLabel(connection) : '?'} / ${parts.join('.')}`
}

function sideComplete(side: SideRef, scope: CompareScope, dialect: Dialect): boolean {
  if (!side.connectionId || !side.database) return false
  if (scope !== 'database' && dialect !== 'mysql' && !side.schema) return false
  return scope !== 'table' || !!side.table
}

function CompareView({
  tab,
  dialect
}: {
  tab: TabOf<'compare'>
  dialect: Dialect
}): React.JSX.Element {
  const source: SideRef = {
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema,
    table: tab.table
  }
  const target: SideRef = tab.target ?? {
    connectionId: tab.connectionId,
    database: '',
    schema: tab.schema,
    table: tab.table
  }
  // MySQL schemas are databases, so a schema comparison there is a database one
  const scope: CompareScope = dialect === 'mysql' && tab.scope === 'schema' ? 'database' : tab.scope
  const key = JSON.stringify([source, target, scope])
  const ready = sideComplete(source, scope, dialect) && sideComplete(target, scope, dialect)
  const same = key === JSON.stringify([source, source, scope])

  const [result, setResult] = useState<Result | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState<string | null>(null)
  const [pane, setPane] = useState<'details' | 'script'>('details')
  const [showSame, setShowSame] = useState(false)

  const setTarget = (patch: Partial<CompareTarget>): void =>
    updateTab(tab.id, { target: { ...target, ...patch } } as Partial<TabOf<'compare'>>)
  const setSource = (patch: Partial<SideRef>): void =>
    updateTab(tab.id, patch as Partial<TabOf<'compare'>>)

  const setScope = (next: CompareScope): void => {
    const schema = (side: SideRef): string | null =>
      next === 'database' ? null : (side.schema ?? defaultSchema(dialect))
    updateTab(tab.id, {
      scope: next,
      schema: dialect === 'mysql' ? null : schema(source),
      table: next === 'table' ? source.table : null,
      target: {
        ...target,
        schema: dialect === 'mysql' ? null : schema(target),
        table: next === 'table' ? target.table : null
      }
    } as Partial<TabOf<'compare'>>)
  }

  const swap = (): void =>
    updateTab(tab.id, {
      connectionId: target.connectionId,
      database: target.database,
      schema: target.schema,
      table: target.table,
      target: { ...source }
    } as Partial<TabOf<'compare'>>)

  const run = async (): Promise<void> => {
    setError(null)
    try {
      const targetConnection = connectionsStore.get().find((c) => c.id === target.connectionId)
      if (!(await connect(target.connectionId))) return
      const load = (label: string, side: SideRef) =>
        loadSnapshot(dialect, side, scope, (done, total) =>
          setProgress(`Reading ${label}${total ? ` ${done}/${total}` : ''}…`)
        )
      const a = await load('source', source)
      const b = await load('target', target)
      const status = statusStore.get()[target.connectionId]
      const babelfish =
        targetConnection?.engine === 'babelfish' ||
        (status?.state === 'connected' && !!status.info.babelfishVersion)
      const items = compareSnapshots({
        dialect,
        scope,
        source: a.snapshot,
        target: b.snapshot,
        options: { babelfish }
      })
      setResult({
        key,
        dialect,
        items,
        failed: [...a.failed, ...b.failed],
        source: sideLabel(source, scope, dialect),
        target: sideLabel(target, scope, dialect),
        babelfish
      })
      setSelected(defaultSelection(items))
      const first = items.find((i) => i.action !== 'same')
      setFocus(first?.id ?? items[0]?.id ?? null)
      setShowSame((s) => s || !first)
    } catch (e) {
      setError(e)
    } finally {
      setProgress(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-panel px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'database', label: 'Database' },
              ...(dialect === 'mysql' ? [] : [{ value: 'schema' as const, label: 'Schema' }]),
              { value: 'table', label: 'Table' }
            ]}
          />
          <div className="flex-1" />
          {result && result.key !== key && <Badge tone="warning">Selection changed</Badge>}
          <Button
            variant="primary"
            size="sm"
            disabled={!ready || !!progress || same}
            title={same ? 'Pick a different target' : undefined}
            onClick={() => void run()}
          >
            <GitCompareArrows className="size-3.5" />
            {result ? 'Compare again' : 'Compare'}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SidePicker
            title="Source"
            hint="The structure to copy"
            side={source}
            scope={scope}
            dialect={dialect}
            onChange={setSource}
          />
          <Button
            variant="ghost"
            size="icon"
            title="Swap source and target"
            disabled={!tab.target}
            onClick={swap}
          >
            <ArrowLeftRight className="size-3.5" />
          </Button>
          <SidePicker
            title="Target"
            hint="The database the script changes"
            side={target}
            scope={scope}
            dialect={dialect}
            onChange={setTarget}
          />
        </div>
      </div>
      <ProgressBar active={!!progress} />
      {progress ? (
        <EmptyState title={progress} icon={<Spinner className="size-5" />} />
      ) : error ? (
        <EmptyState title="Comparison failed">
          <ErrorText error={error} />
        </EmptyState>
      ) : !result ? (
        <EmptyState icon={<GitCompareArrows className="size-6" />} title="Compare two schemas">
          Pick a target, then Compare. You’ll see every table, view and routine that differs, and
          get a script that changes the target to match the source.
        </EmptyState>
      ) : (
        <Results
          result={result}
          selected={selected}
          setSelected={setSelected}
          focus={focus}
          setFocus={setFocus}
          pane={pane}
          setPane={setPane}
          showSame={showSame}
          setShowSame={setShowSame}
          targetSide={target}
        />
      )}
    </div>
  )
}

/* ---------- Pickers ---------- */

function PickButton({
  icon,
  value,
  placeholder,
  items,
  disabled,
  title
}: {
  icon: ReactNode
  value: string | null
  placeholder: string
  items: () => MenuItem[]
  disabled?: boolean
  title: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-line-strong bg-canvas px-2 text-[12px] text-fg hover:border-faint hover:text-bright disabled:pointer-events-none disabled:opacity-50"
      onClick={(e) => showMenuAt(e.currentTarget, items())}
    >
      {icon}
      <span className={cn('max-w-44 truncate', !value && 'text-faint')}>
        {value || placeholder}
      </span>
      <ChevronDown className="size-3 shrink-0 text-faint" />
    </button>
  )
}

function SidePicker({
  title,
  hint,
  side,
  scope,
  dialect,
  onChange
}: {
  title: string
  hint: string
  side: SideRef
  scope: CompareScope
  dialect: Dialect
  onChange: (patch: Partial<SideRef>) => void
}): React.JSX.Element {
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const connection = connections.find((c) => c.id === side.connectionId)
  const connected = statuses[side.connectionId]?.state === 'connected'
  const withSchema = scope !== 'database' && dialect !== 'mysql'
  const id = side.connectionId

  const databases = useQuery({ ...queries.databases(id), enabled: connected })
  const schemas = useQuery({
    ...queries.schemas(id, side.database),
    enabled: connected && !!side.database && withSchema
  })
  const tables = useQuery({
    ...queries.objects(id, side.database, dialect === 'mysql' ? null : side.schema),
    enabled: connected && !!side.database && scope === 'table' && (!withSchema || !!side.schema)
  })

  const loading = (q: { isPending: boolean }, none: string): MenuItem[] => [
    { label: q.isPending ? 'Loading…' : none, disabled: true }
  ]
  const check = (on: boolean): string | undefined => (on ? '✓' : undefined)

  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-lg bg-canvas/50 py-1 pr-1 pl-2 ring-1 ring-line ring-inset">
      <span className="text-[11px] font-medium tracking-wide text-faint uppercase" title={hint}>
        {title}
      </span>
      <PickButton
        title="Connection"
        icon={connection ? <EngineMark engine={connection.engine} size="sm" /> : null}
        value={connection ? connectionLabel(connection) : null}
        placeholder="Connection"
        items={() => {
          // Migration scripts are written in one dialect, so both sides must share it
          const options = connections.filter((c) => dialectOf(c) === dialect)
          return options.map((c) => ({
            label: connectionLabel(c),
            icon: <EngineMark engine={c.engine} size="sm" />,
            shortcut: statuses[c.id]?.state === 'connected' ? '●' : check(c.id === id),
            onSelect: () => {
              void connect(c.id)
              onChange({
                connectionId: c.id,
                database: c.id === id ? side.database : '',
                schema: withSchema ? (side.schema ?? defaultSchema(dialect)) : null,
                table: null
              })
            }
          }))
        }}
      />
      <PickButton
        title="Database"
        icon={<Database className="size-3.5 shrink-0 text-info" />}
        value={side.database}
        placeholder="Database"
        disabled={!connected}
        items={() => {
          const list = (databases.data ?? []).filter((d) => !d.isSystem)
          return list.length
            ? list.map((d) => ({
                label: d.name,
                icon: <Database className="text-info" />,
                shortcut: check(d.name === side.database),
                onSelect: () => onChange({ database: d.name, table: null })
              }))
            : loading(databases, 'No databases')
        }}
      />
      {withSchema && (
        <PickButton
          title="Schema"
          icon={<Layers className="size-3.5 shrink-0 text-syn-keyword" />}
          value={side.schema}
          placeholder="Schema"
          disabled={!connected || !side.database}
          items={() => {
            const list = (schemas.data ?? []).filter((s) => !s.isSystem)
            return list.length
              ? list.map((s) => ({
                  label: s.name,
                  icon: <Layers className="text-syn-keyword" />,
                  shortcut: check(s.name === side.schema),
                  onSelect: () => onChange({ schema: s.name, table: null })
                }))
              : loading(schemas, 'No schemas')
          }}
        />
      )}
      {scope === 'table' && (
        <PickButton
          title="Table"
          icon={<Table2 className="size-3.5 shrink-0 text-syn-prop" />}
          value={side.table}
          placeholder="Table"
          disabled={!connected || !side.database}
          items={() => {
            const list = (tables.data ?? []).filter(
              (o) => o.kind === 'table' || o.kind === 'foreign_table'
            )
            return list.length
              ? list.map((o) => ({
                  label: o.name,
                  icon: <Table2 className="text-syn-prop" />,
                  shortcut: check(o.name === side.table),
                  onSelect: () => onChange({ table: o.name })
                }))
              : loading(tables, 'No tables')
          }}
        />
      )}
    </div>
  )
}

/* ---------- Results ---------- */

const KIND_LABELS: Record<DiffItem['kind'], string> = {
  schema: 'Schemas',
  table: 'Tables',
  foreign_table: 'Foreign tables',
  view: 'Views',
  materialized_view: 'Materialized views',
  function: 'Functions',
  procedure: 'Procedures',
  sequence: 'Sequences',
  synonym: 'Synonyms',
  collection: 'Collections',
  timeseries: 'Time series',
  event: 'Events',
  type: 'Types',
  extension: 'Extensions'
}

function KindIcon({ kind }: { kind: DiffItem['kind'] }): React.JSX.Element {
  const c = 'size-3.5 shrink-0'
  if (kind === 'schema') return <Layers className={cn(c, 'text-syn-keyword')} />
  if (kind === 'view' || kind === 'materialized_view')
    return <Eye className={cn(c, 'text-syn-type')} />
  if (kind === 'function' || kind === 'procedure')
    return <FunctionSquare className={cn(c, 'text-syn-fn')} />
  if (kind === 'sequence') return <ListOrdered className={cn(c, 'text-syn-number')} />
  if (kind === 'type') return <Shapes className={cn(c, 'text-syn-type')} />
  if (kind === 'extension') return <Puzzle className={cn(c, 'text-syn-fn')} />
  return <Table2 className={cn(c, 'text-syn-prop')} />
}

const ACTIONS: Record<
  DiffAction,
  { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; title: string }
> = {
  create: { label: 'New', tone: 'success', title: 'Only in the source; the script creates it' },
  alter: { label: 'Changed', tone: 'warning', title: 'Differs; the script alters the target' },
  drop: { label: 'Extra', tone: 'danger', title: 'Only in the target; tick it to drop it' },
  same: { label: 'Same', tone: 'neutral', title: 'Identical on both sides' }
}

const itemName = (item: DiffItem): string =>
  item.schema ? `${item.schema}.${item.name}` : item.name

function Results({
  result,
  selected,
  setSelected,
  focus,
  setFocus,
  pane,
  setPane,
  showSame,
  setShowSame,
  targetSide
}: {
  result: Result
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  focus: string | null
  setFocus: (id: string) => void
  pane: 'details' | 'script'
  setPane: (p: 'details' | 'script') => void
  showSame: boolean
  setShowSame: (v: boolean) => void
  targetSide: SideRef
}): React.JSX.Element {
  const { items } = result
  const counts = useMemo(() => {
    const out: Record<DiffAction, number> = { create: 0, alter: 0, drop: 0, same: 0 }
    for (const i of items) out[i.action]++
    return out
  }, [items])
  const shown = items.filter((i) => showSame || i.action !== 'same')
  const groups = useMemo(() => {
    const out = new Map<DiffItem['kind'], DiffItem[]>()
    for (const i of shown) out.set(i.kind, [...(out.get(i.kind) ?? []), i])
    return [...out]
  }, [shown])
  const focused = items.find((i) => i.id === focus) ?? null
  const differing = items.filter((i) => i.action !== 'same')
  const toggle = (ids: string[], on: boolean): void => {
    const next = new Set(selected)
    for (const id of ids) on ? next.add(id) : next.delete(id)
    setSelected(next)
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-panel">
        <div className="space-y-2 border-b border-line px-3 py-2.5">
          <div className="flex flex-wrap gap-1.5">
            {(['create', 'alter', 'drop'] as const).map((a) => (
              <Badge
                key={a}
                tone={counts[a] ? ACTIONS[a].tone : 'neutral'}
                title={ACTIONS[a].title}
              >
                {counts[a]} {ACTIONS[a].label.toLowerCase()}
              </Badge>
            ))}
            <Badge>{counts.same} same</Badge>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <button
              type="button"
              className="hover:text-bright"
              onClick={() =>
                toggle(
                  differing.map((i) => i.id),
                  true
                )
              }
            >
              Select all
            </button>
            <button
              type="button"
              className="hover:text-bright"
              onClick={() =>
                toggle(
                  differing.map((i) => i.id),
                  false
                )
              }
            >
              None
            </button>
            <div className="flex-1" />
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showSame}
                onChange={(e) => setShowSame(e.target.checked)}
                className="accent-(--color-accent)"
              />
              Show identical
            </label>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {!shown.length && (
            <p className="px-3 py-6 text-center text-xs text-muted">
              No differences. The target matches the source.
            </p>
          )}
          {groups.map(([kind, list]) => (
            <div key={kind} className="pb-1">
              <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">
                {KIND_LABELS[kind]}
              </div>
              {list.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    'flex cursor-default items-center gap-2 px-3 py-1 text-xs',
                    item.id === focus ? 'bg-sel text-bright' : 'text-fg hover:bg-hover'
                  )}
                  onClick={() => {
                    setFocus(item.id)
                    setPane('details')
                  }}
                >
                  <input
                    type="checkbox"
                    disabled={item.action === 'same'}
                    checked={selected.has(item.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => toggle([item.id], e.target.checked)}
                    className="accent-(--color-accent)"
                    title="Include in the script"
                  />
                  <KindIcon kind={item.kind} />
                  <span className="min-w-0 flex-1 truncate" title={itemName(item)}>
                    {itemName(item)}
                  </span>
                  {item.warnings.length > 0 && item.action !== 'same' && (
                    <TriangleAlert className="size-3 shrink-0 text-warn" />
                  )}
                  <Badge tone={ACTIONS[item.action].tone} title={ACTIONS[item.action].title}>
                    {ACTIONS[item.action].label}
                  </Badge>
                </div>
              ))}
            </div>
          ))}
        </div>
        {result.failed.length > 0 && (
          <p className="border-t border-line px-3 py-2 text-[11px] text-warn">
            Couldn’t read{' '}
            {result.failed.length === 1 ? 'one object' : `${result.failed.length} objects`}:{' '}
            {result.failed.slice(0, 5).join(', ')}
            {result.failed.length > 5 ? '…' : ''}
          </p>
        )}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
          <Segmented
            value={pane}
            onChange={setPane}
            options={[
              { value: 'details', label: 'Differences' },
              {
                value: 'script',
                label: 'Migration script',
                count: migrationStatements(items, selected).length
              }
            ]}
          />
          <div className="min-w-0 flex-1 truncate text-right text-[11px] text-faint">
            {result.source} → {result.target}
          </div>
        </div>
        {pane === 'script' ? (
          <ScriptPane result={result} selected={selected} targetSide={targetSide} />
        ) : focused ? (
          <Details item={focused} result={result} />
        ) : (
          <EmptyState title="Pick an object to see how it differs" />
        )}
      </section>
    </div>
  )
}

function ChangeIcon({ action }: { action: Change['action'] }): React.JSX.Element {
  if (action === 'add') return <Plus className="size-3 text-ok" />
  if (action === 'drop') return <Minus className="size-3 text-danger" />
  return <Pencil className="size-3 text-warn" />
}

function Details({ item, result }: { item: DiffItem; result: Result }): React.JSX.Element {
  const rows = useMemo(
    () => diffLines(item.targetText, item.sourceText),
    [item.targetText, item.sourceText]
  )
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <KindIcon kind={item.kind} />
        <h2 className="truncate text-sm font-medium text-bright select-text">{itemName(item)}</h2>
        <Badge tone={ACTIONS[item.action].tone}>{ACTIONS[item.action].label}</Badge>
        <span className="text-xs text-muted">{ACTIONS[item.action].title}</span>
      </div>
      {item.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
          {item.warnings.map((w) => (
            <li key={w} className="flex gap-2">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {w}
            </li>
          ))}
        </ul>
      )}
      {item.changes.length > 0 && (
        <div className="overflow-hidden rounded-lg ring-1 ring-line">
          <table className="w-full text-xs">
            <thead className="bg-panel text-left text-[11px] text-faint">
              <tr>
                <th className="w-6 px-2 py-1.5" />
                <th className="px-2 py-1.5 font-medium">Change</th>
                <th className="px-2 py-1.5 font-medium">Target now</th>
                <th className="px-2 py-1.5 font-medium">After the script</th>
              </tr>
            </thead>
            <tbody>
              {item.changes.map((c, i) => (
                <tr key={i} className="border-t border-line align-top">
                  <td className="px-2 py-1.5">
                    <ChangeIcon action={c.action} />
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className="text-muted">{c.what}</span>{' '}
                    <span className="font-mono text-bright">{c.name}</span>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[11px] break-all text-muted select-text">
                    {c.from ?? '—'}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[11px] break-all text-fg select-text">
                    {c.to ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(item.sourceText || item.targetText) && (
        <div className="overflow-hidden rounded-lg ring-1 ring-line">
          <div className="grid grid-cols-2 bg-panel text-[11px] text-faint">
            <div className="truncate px-3 py-1.5" title={result.target}>
              Target · {result.target}
            </div>
            <div className="truncate border-l border-line px-3 py-1.5" title={result.source}>
              Source · {result.source}
            </div>
          </div>
          <div className="grid grid-cols-2 font-mono text-[11.5px] leading-[18px] select-text">
            {rows.map((r, i) => (
              <DiffRow key={i} row={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function DiffRow({ row }: { row: ReturnType<typeof diffLines>[number] }): React.JSX.Element {
  const cell = (
    side: { line: number; text: string } | null,
    tone: string,
    border?: boolean
  ): React.JSX.Element => (
    <div
      className={cn(
        'flex min-w-0 border-t border-line/50',
        border && 'border-l border-l-line',
        side ? tone : 'bg-hover/40'
      )}
    >
      <span className="w-9 shrink-0 pr-2 text-right text-faint select-none">
        {side?.line ?? ''}
      </span>
      <span className="min-w-0 flex-1 pr-2 break-all whitespace-pre-wrap">{side?.text ?? ''}</span>
    </div>
  )
  const removed = row.kind === 'removed' || row.kind === 'changed'
  const added = row.kind === 'added' || row.kind === 'changed'
  return (
    <>
      {cell(row.left, removed ? 'bg-danger/10 text-bright' : 'text-fg')}
      {cell(row.right, added ? 'bg-ok/10 text-bright' : 'text-fg', true)}
    </>
  )
}

function ScriptPane({
  result,
  selected,
  targetSide
}: {
  result: Result
  selected: Set<string>
  targetSide: SideRef
}): React.JSX.Element {
  const { dialect, items } = result
  const body = useMemo(() => migrationScript(dialect, items, selected), [dialect, items, selected])
  const script = body
    ? [
        `-- Migrates ${result.target}`,
        `-- to match ${result.source}`,
        '-- Run this against the target.',
        '',
        body
      ].join('\n')
    : ''
  const drops = items.filter((i) => i.action === 'drop' && selected.has(i.id)).length
  const warnings = items
    .filter((i) => selected.has(i.id))
    .reduce((n, i) => n + i.warnings.length, 0)
  const name = `migrate-${targetSide.table ?? targetSide.schema ?? targetSide.database}`
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!script}
          onClick={() =>
            newQueryTab(targetSide.connectionId, targetSide.database, script, { title: name })
          }
          title="Open the script in a query tab on the target, to review and run"
        >
          <FileCode2 className="size-3.5" />
          Open in editor
        </Button>
        <Button size="sm" disabled={!script} onClick={() => void copyText(script, 'Copied script')}>
          <ClipboardCopy className="size-3.5" />
          Copy
        </Button>
        <Button size="sm" disabled={!script} onClick={() => void saveToFile(script, name, 'sql')}>
          <Save className="size-3.5" />
          Save…
        </Button>
        <div className="flex-1" />
        {drops > 0 && <Badge tone="danger">Drops {drops}</Badge>}
        {warnings > 0 && (
          <Badge tone="warning" title="See each object's differences">
            {warnings} {warnings === 1 ? 'warning' : 'warnings'}
          </Badge>
        )}
        {dialect === 'mysql' && (
          <span className="text-[11px] text-faint">
            MySQL commits each DDL statement, so a failure part-way keeps earlier changes.
          </span>
        )}
        {result.babelfish && <span className="text-[11px] text-faint">Written for Babelfish</span>}
      </div>
      {script ? (
        <CodeEditor
          value={script}
          language={{ kind: 'sql', dialect }}
          readOnly
          className="min-h-0 flex-1"
          fontSize={12}
        />
      ) : (
        <EmptyState title="Nothing to run">
          {items.some((i) => i.action !== 'same')
            ? 'Tick the objects to include in the script.'
            : 'The target already matches the source.'}
        </EmptyState>
      )}
    </div>
  )
}
