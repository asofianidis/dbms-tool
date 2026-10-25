import { useQuery } from '@tanstack/react-query'
import { formatBytes, formatCount } from '@/lib/format'
import { connectedInfo, isMariaDb } from '@/lib/mariadb'
import {
  effectiveEngine,
  engineTraits,
  loadInboundKeys,
  loadStorageCatalog,
  loadTableStorage,
  optionsFromStorage,
  rowFormatChoices,
  withEngine,
  type OptionsContext,
  type StorageCatalog,
  type TableOptions
} from '@/lib/storage-engines'
import { statusStore } from '@/lib/workspace'
import { Badge, EmptyState, ErrorText, Field, Select, Spinner } from '@/components/ui'

/** Engines, charsets and collations the server has. */
function useStorageCatalog(connectionId: string, database: string, enabled: boolean) {
  const mariaDb = isMariaDb(connectedInfo(statusStore.use()[connectionId]))
  return useQuery({
    queryKey: ['conn', connectionId, 'storage-catalog', database, mariaDb],
    queryFn: () => loadStorageCatalog(connectionId, database, mariaDb),
    enabled,
    staleTime: 5 * 60_000
  })
}

const storageQuery = (connectionId: string, database: string, table: string) => ({
  queryKey: ['conn', connectionId, 'table-storage', database, table],
  queryFn: () => loadTableStorage(connectionId, database, table)
})

/**
 * What the table designer's options need on a MySQL-dialect connection: the
 * server's catalog and, for an existing table, its current options and the
 * foreign keys that point at it. `context` is null until all of it is loaded.
 */
export function useTableOptionsContext(
  connectionId: string,
  database: string,
  table: string | null,
  enabled: boolean
): {
  catalog: StorageCatalog | undefined
  context: OptionsContext | null
  error: Error | null
} {
  const catalog = useStorageCatalog(connectionId, database, enabled)
  const existing = enabled && table !== null
  const storage = useQuery({
    ...storageQuery(connectionId, database, table ?? ''),
    enabled: existing,
    staleTime: 0
  })
  const inbound = useQuery({
    queryKey: ['conn', connectionId, 'inbound-keys', database, table],
    queryFn: () => loadInboundKeys(connectionId, database, table ?? ''),
    enabled: existing,
    staleTime: 0
  })
  const ready = catalog.data && (!existing || (storage.isFetchedAfterMount && inbound.data))
  return {
    catalog: catalog.data,
    context: ready
      ? {
          engines: catalog.data!.engines,
          original:
            existing && storage.data
              ? optionsFromStorage(storage.data, catalog.data!.collations)
              : null,
          inbound: inbound.data ?? []
        }
      : null,
    error: catalog.error ?? storage.error ?? inbound.error
  }
}

/** The designer's Options view: engine, character set, collation, row format. */
export function TableOptionsEditor({
  catalog,
  context,
  error,
  options,
  onChange
}: {
  catalog: StorageCatalog | undefined
  context: OptionsContext | null
  error: Error | null
  options: TableOptions
  onChange: (options: TableOptions) => void
}): React.JSX.Element {
  if (error) return <ErrorText error={error} />
  if (!catalog || !context)
    return <EmptyState title="Loading…" icon={<Spinner className="size-5" />} />
  const { engines, original } = context
  const engine = effectiveEngine(options.engine, engines)
  const traits = engineTraits(engine, engines)
  const fallback = engines.find((e) => e.isDefault)?.name
  // The table's own engine stays pickable even if the server no longer lists it
  const engineNames = [
    ...new Set([...(original ? [original.engine] : []), ...engines.map((e) => e.name)])
  ]
  const collations = catalog.collations.filter(
    (c) => !options.charset || c.charset === options.charset
  )
  const rowFormats = rowFormatChoices(engine, options.rowFormat)
  const comment = engines.find((e) => e.name === engine)?.comment
  return (
    <div className="grid max-w-2xl grid-cols-2 gap-4">
      <Field
        label="Storage engine"
        className="col-span-2"
        hint={comment || (original ? undefined : 'The server default applies when none is picked')}
      >
        <Select
          value={options.engine}
          onChange={(e) => onChange(withEngine(options, e.target.value, engines))}
        >
          {!original && <option value="">Default{fallback ? ` (${fallback})` : ''}</option>}
          {engineNames.map((name) => (
            <option key={name} value={name}>
              {name}
              {engines.find((e) => e.name === name)?.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      <div className="col-span-2 flex flex-wrap gap-1.5">
        <Badge tone={traits.transactional ? 'success' : 'warning'}>
          {traits.transactional ? 'transactional' : 'not transactional'}
        </Badge>
        <Badge tone={traits.foreignKeys === 'enforced' ? 'success' : 'warning'}>
          {traits.foreignKeys === 'enforced'
            ? 'foreign keys'
            : traits.foreignKeys === 'rejected'
              ? 'no foreign keys'
              : 'foreign keys ignored'}
        </Badge>
        {traits.fullText && <Badge tone="info">full-text indexes</Badge>}
      </div>
      <Field label="Character set">
        <Select
          value={options.charset}
          onChange={(e) => onChange({ ...options, charset: e.target.value, collation: '' })}
        >
          {(!original || !options.charset) && <option value="">Database default</option>}
          {catalog.charsets.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Collation"
        hint={original ? 'Applies to columns added later; existing columns keep theirs' : undefined}
      >
        <Select
          value={options.collation}
          onChange={(e) => onChange({ ...options, collation: e.target.value })}
        >
          <option value="">{options.charset ? 'Character set default' : 'Database default'}</option>
          {collations.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      {rowFormats.length > 0 && (
        <Field label="Row format">
          <Select
            value={options.rowFormat}
            onChange={(e) => onChange({ ...options, rowFormat: e.target.value })}
          >
            <option value="">Default</option>
            {rowFormats.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  )
}

/** Engine, row format and sizes for the structure view of a MySQL / MariaDB table. */
export function StorageSummary({
  connectionId,
  database,
  table
}: {
  connectionId: string
  database: string
  table: string
}): React.JSX.Element | null {
  const storage = useQuery(storageQuery(connectionId, database, table))
  const catalog = useStorageCatalog(connectionId, database, true)
  const s = storage.data
  if (!s) return null
  const traits = engineTraits(s.engine, catalog.data?.engines)
  const items: [string, string][] = [
    ['Row format', s.rowFormat ?? ''],
    ['Collation', s.collation ?? ''],
    ['Rows (est.)', s.rows === null ? '' : formatCount(s.rows)],
    ['Data', formatBytes(s.dataLength)],
    ['Indexes', formatBytes(s.indexLength)]
  ]
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] select-text">
      <span className="flex items-center gap-1.5">
        <span className="text-muted">Engine</span>
        <span className="font-mono text-bright">{s.engine}</span>
        {!traits.transactional && <Badge tone="warning">not transactional</Badge>}
        {traits.foreignKeys !== 'enforced' && <Badge tone="warning">no foreign keys</Badge>}
      </span>
      {items
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className="text-muted">{label}</span>
            <span className="font-mono text-fg">{value}</span>
          </span>
        ))}
    </div>
  )
}
