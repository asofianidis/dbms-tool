import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Bookmark,
  BookmarkPlus,
  Cloud,
  CornerDownLeft,
  Database,
  Eye,
  FileCode2,
  FunctionSquare,
  History,
  LayoutDashboard,
  Leaf,
  ListOrdered,
  Plug,
  Plus,
  Search,
  Settings,
  Table2,
  Unplug,
  WrapText
} from 'lucide-react'
import type { DbObject } from '@/lib/api'
import { cn } from '@/lib/cn'
import { dashboardsStore } from '@/lib/dashboards'
import { ENGINES, connectionLabel } from '@/lib/engines'
import { MOD } from '@/lib/keys'
import { queryClient } from '@/lib/queries'
import { savedQueriesStore } from '@/lib/saved'
import { settingsStore } from '@/lib/settings'
import {
  activeTab,
  closePalette,
  closeTab,
  connect,
  connectionsStore,
  disconnect,
  layoutStore,
  newQueryTab,
  openCloud,
  openCollection,
  openConnectionDialog,
  openDashboard,
  openSettings,
  openTable,
  openWelcome,
  paletteStore,
  statusStore
} from '@/lib/workspace'
import {
  defaultTarget,
  runSavedQuery,
  saveTabQuery,
  showSavedQueries,
  targetLabel
} from '@/features/saved/actions'
import {
  importDashboard,
  newDashboard,
  openExampleDashboard,
  showDashboards
} from '@/features/dashboard/actions'
import { EngineMark, Kbd } from './ui'

interface Item {
  id: string
  /** Tie-breaker: tables and collections before sequences and routines */
  weight?: number
  label: string
  detail?: string
  group: string
  icon: ReactNode
  shortcut?: string
  run: () => void
}

function score(text: string, query: string): number {
  const haystack = text.toLowerCase()
  if (!query) return 1
  if (haystack.startsWith(query)) return 4
  const words = haystack.split(/[\s._/-]+/)
  if (words.some((w) => w.startsWith(query))) return 3
  if (haystack.includes(query)) return 2
  // Subsequence match, like fuzzy file pickers
  let i = 0
  for (const ch of haystack) if (ch === query[i]) i++
  return i === query.length ? 1 : 0
}

function objectIcon(kind: DbObject['kind']): ReactNode {
  if (kind === 'view' || kind === 'materialized_view') return <Eye className="text-syn-type" />
  if (kind === 'function' || kind === 'procedure') return <FunctionSquare className="text-syn-fn" />
  if (kind === 'collection' || kind === 'timeseries') return <Leaf className="text-mongo" />
  if (kind === 'sequence') return <ListOrdered className="text-syn-number" />
  return <Table2 className="text-syn-prop" />
}

export function CommandPalette(): React.JSX.Element | null {
  const { open, query } = paletteStore.use()
  if (!open) return null
  return <Palette initial={query} />
}

function Palette({ initial }: { initial: string }): React.JSX.Element {
  const [query, setQuery] = useState(initial)
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const saved = savedQueriesStore.use()
  const dashboards = dashboardsStore.use()
  const commandMode = query.startsWith('>')
  const term = (commandMode ? query.slice(1) : query).trim().toLowerCase()

  const items = useMemo((): Item[] => {
    const commands: Item[] = [
      {
        id: 'new-connection',
        group: 'Commands',
        label: 'New connection',
        icon: <Plus />,
        run: () => openConnectionDialog()
      },
      {
        id: 'cloud',
        group: 'Commands',
        label: 'Cloud databases (AWS, Google Cloud, Azure)',
        icon: <Cloud />,
        run: openCloud
      },
      {
        id: 'new-query',
        group: 'Commands',
        label: 'New query',
        icon: <FileCode2 />,
        shortcut: `${MOD}N`,
        run: () => newQueryTab()
      },
      {
        id: 'settings',
        group: 'Commands',
        label: 'Open settings',
        icon: <Settings />,
        shortcut: `${MOD},`,
        run: openSettings
      },
      {
        id: 'welcome',
        group: 'Commands',
        label: 'Show welcome page',
        icon: <Database />,
        run: openWelcome
      },
      {
        id: 'history',
        group: 'Commands',
        label: 'Show query history',
        icon: <History />,
        run: () => layoutStore.set({ sidebar: 'history', sidebarOpen: true })
      },
      {
        id: 'saved',
        group: 'Commands',
        label: 'Show saved queries',
        icon: <Bookmark />,
        run: showSavedQueries
      },
      {
        id: 'new-dashboard',
        group: 'Commands',
        label: 'New dashboard',
        icon: <LayoutDashboard />,
        run: () => void newDashboard()
      },
      {
        id: 'dashboards',
        group: 'Commands',
        label: 'Show dashboards',
        icon: <LayoutDashboard />,
        run: showDashboards
      },
      {
        id: 'example-dashboard',
        group: 'Commands',
        label: 'Open example dashboard',
        icon: <LayoutDashboard />,
        run: openExampleDashboard
      },
      {
        id: 'import-dashboard',
        group: 'Commands',
        label: 'Import dashboard…',
        icon: <LayoutDashboard />,
        run: () => void importDashboard()
      },
      {
        id: 'save-query',
        group: 'Commands',
        label: 'Save current query',
        icon: <BookmarkPlus />,
        run: () => {
          const tab = activeTab()
          if (tab?.kind === 'query' || tab?.kind === 'mongo') void saveTabQuery(tab, tab.text)
        }
      },
      {
        id: 'explorer',
        group: 'Commands',
        label: 'Show explorer',
        icon: <Database />,
        run: () => layoutStore.set({ sidebar: 'explorer', sidebarOpen: true })
      },
      {
        id: 'sidebar',
        group: 'Commands',
        label: 'Toggle sidebar',
        icon: <Database />,
        shortcut: `${MOD}B`,
        run: () => layoutStore.set((l) => ({ ...l, sidebarOpen: !l.sidebarOpen }))
      },
      {
        id: 'wrap',
        group: 'Commands',
        label: 'Toggle word wrap',
        icon: <WrapText />,
        run: () => settingsStore.set((s) => ({ ...s, wordWrap: !s.wordWrap }))
      },
      {
        id: 'close-tab',
        group: 'Commands',
        label: 'Close tab',
        icon: <Database />,
        shortcut: `${MOD}W`,
        run: () => {
          const tab = activeTab()
          if (tab) closeTab(tab.id)
        }
      }
    ]
    const connectionItems: Item[] = connections.flatMap((c) => {
      const connected = statuses[c.id]?.state === 'connected'
      const label = connectionLabel(c)
      return [
        {
          id: `query:${c.id}`,
          group: 'Connections',
          label: `${c.engine === 'mongo' ? 'New shell' : 'New query'}: ${label}`,
          detail: ENGINES[c.engine].label,
          icon: <EngineMark engine={c.engine} size="sm" />,
          run: async () => {
            if (await connect(c.id)) newQueryTab(c.id)
          }
        },
        connected
          ? {
              id: `disconnect:${c.id}`,
              group: 'Connections',
              label: `Disconnect ${label}`,
              icon: <Unplug />,
              run: () => void disconnect(c.id)
            }
          : {
              id: `connect:${c.id}`,
              group: 'Connections',
              label: `Connect ${label}`,
              icon: <Plug />,
              run: () => void connect(c.id)
            }
      ]
    })
    const savedItems: Item[] = saved.map((q) => ({
      id: `saved:${q.id}`,
      group: 'Saved queries',
      label: q.name,
      detail: `Run on ${targetLabel(defaultTarget(q))}`,
      icon: <Bookmark />,
      weight: 1,
      run: () => runSavedQuery(q)
    }))
    const dashboardItems: Item[] = dashboards.map((d) => ({
      id: `dashboard:${d.id}`,
      group: 'Dashboards',
      label: d.name,
      detail: `${d.widgets.length} widget${d.widgets.length === 1 ? '' : 's'}`,
      icon: <LayoutDashboard />,
      weight: 1,
      run: () => openDashboard(d.id)
    }))
    // Objects from every list the explorer has loaded
    const objectItems: Item[] = []
    if (!commandMode) {
      for (const [key, data] of queryClient.getQueriesData<DbObject[]>({ queryKey: ['conn'] })) {
        if (key[2] !== 'objects' || !Array.isArray(data)) continue
        const connectionId = key[1] as string
        const database = key[3] as string
        const connection = connections.find((c) => c.id === connectionId)
        if (!connection) continue
        for (const obj of data) {
          const name =
            obj.schema && connection.engine !== 'mysql' ? `${obj.schema}.${obj.name}` : obj.name
          objectItems.push({
            id: `obj:${connectionId}:${database}:${name}:${obj.detail ?? ''}`,
            group: 'Objects',
            label: name,
            detail: `${obj.kind.replace('_', ' ')} · ${connectionLabel(connection)} / ${database}`,
            icon: objectIcon(obj.kind),
            weight: ['table', 'collection', 'view'].includes(obj.kind) ? 1 : 0,
            run: () =>
              connection.engine === 'mongo'
                ? openCollection(connectionId, database, obj.name)
                : openTable(
                    connectionId,
                    database,
                    obj.schema,
                    obj.name,
                    obj.kind,
                    ['function', 'procedure', 'sequence', 'synonym'].includes(obj.kind)
                      ? 'definition'
                      : 'data',
                    obj.detail
                  )
          })
        }
      }
    }
    const pool = commandMode
      ? commands
      : [...connectionItems, ...savedItems, ...dashboardItems, ...objectItems, ...commands]
    return pool
      .map((item) => ({
        item,
        s: Math.max(score(item.label, term) * 2, score(item.detail ?? '', term))
      }))
      .filter((m) => m.s > 0)
      .sort(
        (a, b) =>
          b.s - a.s ||
          (b.item.weight ?? 0) - (a.item.weight ?? 0) ||
          a.item.label.length - b.item.label.length
      )
      .slice(0, 80)
      .map((m) => m.item)
  }, [connections, statuses, saved, dashboards, term, commandMode])

  useEffect(() => setIndex(0), [term])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const run = (item?: Item): void => {
    if (!item) return
    closePalette()
    item.run()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-(--backdrop) pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && closePalette()}
    >
      <div className="flex h-fit max-h-[60vh] w-full max-w-xl animate-rise flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl shadow-(color:--shadow)">
        <div className="flex items-center gap-2.5 border-b border-line px-3.5">
          <Search className="size-4 shrink-0 text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closePalette()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(i + 1, items.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(items[index])
              }
            }}
            placeholder={
              commandMode
                ? 'Run a command…'
                : 'Search connections, tables, collections — type > for commands'
            }
            spellCheck={false}
            className="h-11 flex-1 bg-transparent text-[14px] text-bright placeholder:text-faint focus:outline-none"
          />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {items.map((item, i) => (
            <div key={item.id}>
              {(i === 0 || items[i - 1].group !== item.group) && (
                <div className="px-2.5 pt-2 pb-1 text-[10.5px] font-medium tracking-wide text-faint uppercase">
                  {item.group}
                </div>
              )}
              <button
                type="button"
                data-index={i}
                onMouseMove={() => setIndex(i)}
                onClick={() => run(item)}
                className={cn(
                  'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px]',
                  i === index ? 'bg-sel text-bright' : 'text-fg'
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-muted [&>svg]:size-3.5">
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
                {item.detail && (
                  <span className="truncate text-[11.5px] text-faint">{item.detail}</span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
                  {i === index && <CornerDownLeft className="size-3.5 text-faint" />}
                </span>
              </button>
            </div>
          ))}
          {!items.length && <p className="px-3 py-6 text-center text-xs text-muted">No matches</p>}
        </div>
      </div>
    </div>
  )
}
