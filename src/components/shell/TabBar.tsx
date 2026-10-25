import { useRef } from 'react'
import {
  ArchiveRestore,
  Braces,
  CalendarClock,
  Cloud,
  Code2,
  DatabaseBackup,
  Eye,
  FileCode2,
  FileUp,
  FunctionSquare,
  GitCompareArrows,
  Home,
  LayoutDashboard,
  Leaf,
  Network,
  Plus,
  Server,
  Settings,
  KeyRound,
  RadioTower,
  SquareTerminal,
  Table2,
  Wrench,
  X
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { dashboardsStore } from '@/lib/dashboards'
import { MOD } from '@/lib/keys'
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  connectionsStore,
  isDirty,
  moveTab,
  newQueryTab,
  tabsStore,
  type Tab
} from '@/lib/workspace'
import { showContextMenu } from '../ContextMenu'

export function tabTitle(tab: Tab): string {
  switch (tab.kind) {
    case 'welcome':
      return 'Welcome'
    case 'settings':
      return 'Settings'
    case 'query':
    case 'mongo':
    case 'redis':
      return tab.filePath ? (tab.filePath.split(/[\\/]/).pop() ?? tab.title) : tab.title
    case 'redisKeys':
      return `Keys · db${tab.database}`
    case 'redisPubsub':
      return 'Pub/Sub'
    case 'table':
      return tab.schema && tab.schema !== 'dbo' && tab.schema !== 'public'
        ? `${tab.schema}.${tab.name}`
        : tab.name
    case 'collection':
      return tab.collection
    case 'server':
      return 'Server'
    case 'cloud':
      return 'Cloud databases'
    case 'diagram':
      return `${tab.schema ?? tab.database} diagram`
    case 'dashboard':
      return dashboardsStore.get().find((d) => d.id === tab.dashboardId)?.name ?? 'Dashboard'
    case 'backup':
      return tab.mode === 'backup'
        ? `Back up ${tab.database || 'database'}`
        : `Restore${tab.database ? ` ${tab.database}` : ''}`
    case 'maintenance':
      return `Maintain ${tab.database}`
    case 'compare':
      return `Compare ${tab.table ?? tab.schema ?? tab.database}`
    case 'import':
      return `Import into ${tab.table ?? tab.schema ?? tab.database}`
  }
}

export function TabIcon({ tab, className }: { tab: Tab; className?: string }): React.JSX.Element {
  const c = cn('size-3.5 shrink-0', className)
  switch (tab.kind) {
    case 'welcome':
      return <Home className={c} />
    case 'settings':
      return <Settings className={c} />
    case 'query':
      return <FileCode2 className={cn(c, 'text-info')} />
    case 'mongo':
      return <Code2 className={cn(c, 'text-mongo')} />
    case 'redis':
      return <SquareTerminal className={cn(c, 'text-redis')} />
    case 'redisKeys':
      return <KeyRound className={cn(c, 'text-redis')} />
    case 'redisPubsub':
      return <RadioTower className={cn(c, 'text-redis')} />
    case 'table':
      if (tab.objectKind === 'view' || tab.objectKind === 'materialized_view') {
        return <Eye className={cn(c, 'text-syn-type')} />
      }
      if (tab.objectKind === 'function' || tab.objectKind === 'procedure') {
        return <FunctionSquare className={cn(c, 'text-syn-fn')} />
      }
      if (tab.objectKind === 'event') return <CalendarClock className={cn(c, 'text-syn-fn')} />
      return <Table2 className={cn(c, 'text-syn-prop')} />
    case 'collection':
      return tab.view === 'aggregation' ? (
        <Braces className={cn(c, 'text-mongo')} />
      ) : (
        <Leaf className={cn(c, 'text-mongo')} />
      )
    case 'server':
      return <Server className={c} />
    case 'cloud':
      return <Cloud className={cn(c, 'text-info')} />
    case 'diagram':
      return <Network className={cn(c, 'text-syn-keyword')} />
    case 'dashboard':
      return <LayoutDashboard className={cn(c, 'text-accent')} />
    case 'backup':
      return tab.mode === 'backup' ? (
        <DatabaseBackup className={cn(c, 'text-ok')} />
      ) : (
        <ArchiveRestore className={cn(c, 'text-warn')} />
      )
    case 'maintenance':
      return <Wrench className={cn(c, 'text-info')} />
    case 'compare':
      return <GitCompareArrows className={cn(c, 'text-info')} />
    case 'import':
      return <FileUp className={cn(c, 'text-ok')} />
  }
}

export function TabBar(): React.JSX.Element {
  const { tabs, active } = tabsStore.use()
  const connections = connectionsStore.use()
  // Dashboard tabs are titled by the dashboard's current name
  dashboardsStore.use()
  const dragId = useRef<string | null>(null)

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-panel">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [&::-webkit-scrollbar]:h-0">
        {tabs.map((tab, index) => {
          const connection =
            'connectionId' in tab ? connections.find((c) => c.id === tab.connectionId) : undefined
          const selected = tab.id === active
          const dirty = isDirty(tab)
          const where =
            connection &&
            `${connection.name || connection.host}${'database' in tab && tab.database ? ` / ${tab.database}` : ''}`
          return (
            <div
              key={tab.id}
              draggable
              onDragStart={() => (dragId.current = tab.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragId.current && dragId.current !== tab.id) moveTab(dragId.current, index)
                dragId.current = null
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  closeTab(tab.id)
                } else if (e.button === 0) activateTab(tab.id)
              }}
              onContextMenu={(e) =>
                showContextMenu(e, [
                  { label: 'Close', shortcut: `${MOD}W`, onSelect: () => closeTab(tab.id) },
                  { label: 'Close others', onSelect: () => closeOtherTabs(tab.id) },
                  {
                    label: 'Close all',
                    onSelect: () => tabsStore.get().tabs.forEach((t) => closeTab(t.id))
                  }
                ])
              }
              title={where ? `${tabTitle(tab)} — ${where}` : tabTitle(tab)}
              className={cn(
                'group relative flex max-w-56 min-w-0 shrink-0 items-center gap-2 border-r border-line pr-1.5 pl-3 text-[12.5px] transition-colors',
                selected ? 'bg-canvas text-bright' : 'text-muted hover:bg-hover/60 hover:text-fg'
              )}
            >
              {selected && <span className="absolute inset-x-0 top-0 h-px bg-accent" />}
              {connection?.color && (
                <span
                  className="absolute inset-x-0 bottom-0 h-0.5"
                  style={{ background: connection.color }}
                />
              )}
              <TabIcon tab={tab} />
              <span
                className={cn(
                  'truncate',
                  (tab.kind === 'query' || tab.kind === 'mongo' || tab.kind === 'redis') &&
                    !tab.filePath &&
                    'italic'
                )}
              >
                {tabTitle(tab)}
              </span>
              <button
                type="button"
                aria-label="Close tab"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeTab(tab.id)}
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-hover hover:text-bright',
                  !selected && !dirty && 'opacity-0 group-hover:opacity-100'
                )}
              >
                {dirty && <span className="size-2 rounded-full bg-fg group-hover:hidden" />}
                <X className={cn('size-3.5', dirty && 'hidden group-hover:block')} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        title={`New query (${MOD}N)`}
        onClick={() => newQueryTab()}
        className="flex w-9 shrink-0 items-center justify-center border-l border-line text-muted hover:bg-hover hover:text-bright"
      >
        <Plus className="size-4" />
      </button>
    </div>
  )
}
