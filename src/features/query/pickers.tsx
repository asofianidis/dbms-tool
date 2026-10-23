import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Database } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ENGINES, connectionLabel } from '@/lib/engines'
import { queries } from '@/lib/queries'
import { connectionsStore, statusStore } from '@/lib/workspace'
import { showMenuAt, type MenuItem } from '@/components/ContextMenu'
import { EngineMark } from '@/components/ui'

const pickerClass =
  'flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-line-strong bg-canvas px-2 text-[12px] text-fg hover:border-faint hover:text-bright'

export function ConnectionPicker({
  value,
  onChange,
  sql,
  mongo
}: {
  value: string
  onChange: (id: string) => void
  /** Only offer SQL connections */
  sql?: boolean
  /** Only offer MongoDB connections */
  mongo?: boolean
}): React.JSX.Element {
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const current = connections.find((c) => c.id === value)
  const options = connections.filter((c) =>
    sql ? c.engine !== 'mongo' : mongo ? c.engine === 'mongo' : true
  )
  return (
    <button
      type="button"
      className={cn(pickerClass, 'max-w-60')}
      title="Connection"
      onClick={(e) =>
        showMenuAt(
          e.currentTarget,
          options.map((c): MenuItem => ({
            label: connectionLabel(c),
            icon: <EngineMark engine={c.engine} size="sm" />,
            shortcut: statuses[c.id]?.state === 'connected' ? '●' : undefined,
            onSelect: () => onChange(c.id)
          }))
        )
      }
    >
      {current ? <EngineMark engine={current.engine} size="sm" /> : null}
      <span className="truncate">{current ? connectionLabel(current) : 'Choose connection'}</span>
      {current?.color && (
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: current.color }} />
      )}
      <ChevronDown className="size-3 shrink-0 text-faint" />
    </button>
  )
}

export function DatabasePicker({
  connectionId,
  value,
  onChange
}: {
  connectionId: string
  value: string
  onChange: (database: string) => void
}): React.JSX.Element {
  const statuses = statusStore.use()
  const connections = connectionsStore.use()
  const connection = connections.find((c) => c.id === connectionId)
  const connected = statuses[connectionId]?.state === 'connected'
  const dbs = useQuery({ ...queries.databases(connectionId), enabled: connected })
  return (
    <button
      type="button"
      className={cn(pickerClass, 'max-w-52')}
      title={connection && ENGINES[connection.engine].hasSchemas ? 'Database' : 'Database / schema'}
      disabled={!connected}
      onClick={(e) => {
        const list = dbs.data ?? []
        showMenuAt(
          e.currentTarget,
          list.length
            ? [
                ...list
                  .filter((d) => !d.isSystem)
                  .map((d): MenuItem => ({
                    label: d.name,
                    icon: <Database className="text-info" />,
                    shortcut: d.name === value ? '✓' : undefined,
                    onSelect: () => onChange(d.name)
                  })),
                ...(list.some((d) => d.isSystem) ? (['separator'] as MenuItem[]) : []),
                ...list
                  .filter((d) => d.isSystem)
                  .map((d): MenuItem => ({
                    label: d.name,
                    icon: <Database className="text-faint" />,
                    shortcut: d.name === value ? '✓' : undefined,
                    onSelect: () => onChange(d.name)
                  }))
              ]
            : [{ label: dbs.isPending ? 'Loading…' : 'No databases', disabled: true }]
        )
      }}
    >
      <Database className="size-3.5 shrink-0 text-info" />
      <span className="truncate">{value || 'default'}</span>
      <ChevronDown className="size-3 shrink-0 text-faint" />
    </button>
  )
}
