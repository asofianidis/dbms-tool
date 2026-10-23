import { useMemo, useState } from 'react'
import {
  Copy,
  Download,
  ExternalLink,
  LayoutDashboard,
  Lock,
  Sparkles,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { dashboardsStore, sortDashboards } from '@/lib/dashboards'
import { connectionLabel } from '@/lib/engines'
import { plural } from '@/lib/format'
import { connectionsStore, openDashboard } from '@/lib/workspace'
import { showContextMenu, showMenuAt } from '@/components/ContextMenu'
import { Button, EngineMark } from '@/components/ui'
import {
  duplicateDashboard,
  exportDashboard,
  importDashboard,
  newDashboard,
  openExampleDashboard,
  removeDashboard,
  renameDashboard
} from './actions'

export function DashboardsPanel(): React.JSX.Element {
  const dashboards = dashboardsStore.use()
  const connections = connectionsStore.use()
  const [filter, setFilter] = useState('')
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return sortDashboards(
      q
        ? dashboards.filter(
            (d) =>
              d.name.toLowerCase().includes(q) ||
              d.widgets.some((w) => w.title.toLowerCase().includes(q))
          )
        : dashboards
    )
  }, [dashboards, filter])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center pr-1.5 pl-3">
        <span className="flex-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
          Dashboards
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          title="New dashboard"
          onClick={(e) =>
            showMenuAt(e.currentTarget, [
              { label: 'New dashboard…', icon: <Plus />, onSelect: () => void newDashboard() },
              { label: 'Example dashboard', icon: <Sparkles />, onSelect: openExampleDashboard },
              'separator',
              {
                label: 'Import from file…',
                icon: <Upload />,
                onSelect: () => void importDashboard()
              }
            ])
          }
        >
          <Plus className="size-3.5" />
        </Button>
      </div>
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search dashboards"
            spellCheck={false}
            className="h-7 w-full rounded-md border border-line bg-canvas pr-7 pl-7 text-[12px] text-bright placeholder:text-faint focus:border-accent/50 focus:outline-none"
          />
          {filter && (
            <button
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-faint hover:text-bright"
              onClick={() => setFilter('')}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.map((d) => {
          const connection = connections.find((c) => c.id === d.connectionId)
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => openDashboard(d.id)}
              onContextMenu={(e) =>
                showContextMenu(e, [
                  { label: 'Open', icon: <ExternalLink />, onSelect: () => openDashboard(d.id) },
                  {
                    label: 'Rename…',
                    icon: <Pencil />,
                    disabled: d.locked,
                    onSelect: () => void renameDashboard(d)
                  },
                  { label: 'Duplicate', icon: <Copy />, onSelect: () => duplicateDashboard(d) },
                  { label: 'Export…', icon: <Download />, onSelect: () => void exportDashboard(d) },
                  'separator',
                  {
                    label: 'Delete',
                    icon: <Trash2 />,
                    disabled: d.locked,
                    danger: true,
                    onSelect: () => void removeDashboard(d)
                  }
                ])
              }
              className="block w-full border-b border-line/60 px-3 py-2 text-left hover:bg-hover/60"
            >
              <div className="flex items-center gap-1.5 text-[12px] font-medium text-bright">
                <LayoutDashboard className="size-3 shrink-0 text-accent" />
                <span className="truncate">{d.name}</span>
                {d.locked && (
                  <Lock className="ml-auto size-3 shrink-0 text-faint" aria-label="Locked" />
                )}
              </div>
              <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted">
                {connection ? (
                  <>
                    <EngineMark engine={connection.engine} size="sm" />
                    <span className="truncate">
                      {connectionLabel(connection)}
                      {d.database ? ` / ${d.database}` : ''}
                    </span>
                  </>
                ) : (
                  <span className="truncate text-faint">Connection removed</span>
                )}
                <span className="ml-auto shrink-0 text-faint">
                  {plural(d.widgets.length, 'widget')}
                </span>
              </div>
            </button>
          )
        })}
        {!visible.length && (
          <div className="flex flex-col items-center gap-3 px-4 py-6 text-center text-xs text-faint">
            {dashboards.length ? (
              'No matches'
            ) : (
              <>
                <p>
                  Chart query results from any database as numbers, bar and line charts, and tables.
                </p>
                <div className="flex gap-1.5">
                  <Button size="sm" onClick={() => void newDashboard()}>
                    <Plus className="size-3.5" />
                    New dashboard
                  </Button>
                  <Button size="sm" variant="ghost" onClick={openExampleDashboard}>
                    <Sparkles className="size-3.5" />
                    See an example
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
