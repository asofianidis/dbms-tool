import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ClipboardCopy,
  FileCode2,
  FilePlus2,
  Leaf,
  Pencil,
  Play,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { copyText } from '@/lib/export'
import {
  deleteSavedQuery,
  findByName,
  savedQueriesStore,
  sortQueries,
  updateSavedQuery,
  type SavedQuery
} from '@/lib/saved'
import { toast } from '@/lib/toast'
import { confirm, connectionsStore, promptText, tabsStore } from '@/lib/workspace'
import { showContextMenu, showMenuAt } from '@/components/ContextMenu'
import { Button } from '@/components/ui'
import { defaultTarget, openSavedQuery, runOnMenu, runSavedQuery, targetLabel } from './actions'

async function rename(query: SavedQuery): Promise<void> {
  const name = (
    await promptText({
      title: 'Rename saved query',
      label: 'Name',
      initial: query.name,
      confirmLabel: 'Rename'
    })
  )?.trim()
  if (!name || name === query.name) return
  const clash = findByName(savedQueriesStore.get(), name, query.kind)
  if (clash && clash.id !== query.id) {
    toast(`A saved query named “${clash.name}” already exists`, 'error')
    return
  }
  updateSavedQuery(query.id, { name })
}

async function remove(query: SavedQuery): Promise<void> {
  const ok = await confirm({
    title: `Delete “${query.name}”?`,
    message: 'The saved query is removed. Open tabs keep their text.',
    confirmLabel: 'Delete',
    danger: true
  })
  if (ok) deleteSavedQuery(query.id)
}

export function SavedQueriesPanel(): React.JSX.Element {
  const saved = savedQueriesStore.use()
  // The default run target follows the active tab and the connection list
  tabsStore.use()
  connectionsStore.use()
  const [filter, setFilter] = useState('')
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q
      ? saved.filter((s) => s.name.toLowerCase().includes(q) || s.text.toLowerCase().includes(q))
      : saved
    return sortQueries(list)
  }, [saved, filter])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center pr-1.5 pl-3">
        <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">
          Saved queries
        </span>
      </div>
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search saved queries"
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
        {visible.map((q) => {
          const target = defaultTarget(q)
          const runLabel = `Run on ${targetLabel(target)}`
          return (
            <div key={q.id} className="group relative border-b border-line/60 hover:bg-hover/60">
              <button
                type="button"
                onClick={() => openSavedQuery(q)}
                onContextMenu={(e) =>
                  showContextMenu(e, [
                    {
                      label: runLabel,
                      icon: <Play />,
                      disabled: !target,
                      onSelect: () => runSavedQuery(q)
                    },
                    { label: 'Run on', icon: <Play />, submenu: runOnMenu(q) },
                    {
                      label: 'Open in new tab',
                      icon: <FilePlus2 />,
                      onSelect: () => openSavedQuery(q)
                    },
                    'separator',
                    { label: 'Rename…', icon: <Pencil />, onSelect: () => void rename(q) },
                    {
                      label: 'Copy',
                      icon: <ClipboardCopy />,
                      onSelect: () => void copyText(q.text, 'Copied query')
                    },
                    'separator',
                    {
                      label: 'Delete',
                      icon: <Trash2 />,
                      danger: true,
                      onSelect: () => void remove(q)
                    }
                  ])
                }
                className="block w-full px-3 py-2 text-left"
                title={q.text}
              >
                <div className="flex items-center gap-1.5 pr-12 text-[12px] font-medium text-bright">
                  {q.kind === 'mongo' ? (
                    <Leaf className="size-3 shrink-0 text-mongo" />
                  ) : (
                    <FileCode2 className="size-3 shrink-0 text-muted" />
                  )}
                  <span className="truncate">{q.name}</span>
                </div>
                <pre className="mt-1 line-clamp-2 font-mono text-[11.5px] leading-snug whitespace-pre-wrap text-muted">
                  {q.text.length > 300 ? q.text.slice(0, 300) : q.text}
                </pre>
              </button>
              <div className="absolute top-1 right-1.5 hidden items-center group-hover:flex">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title={runLabel}
                  disabled={!target}
                  onClick={() => runSavedQuery(q)}
                >
                  <Play className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Run on another connection or database"
                  onClick={(e) => showMenuAt(e.currentTarget, runOnMenu(q))}
                >
                  <ChevronDown className="size-3.5" />
                </Button>
              </div>
            </div>
          )
        })}
        {!visible.length && (
          <p className="px-4 py-6 text-center text-xs text-faint">
            {saved.length
              ? 'No matches'
              : 'Save a query from the Saved menu in any query tab to run it again on any connection.'}
          </p>
        )}
      </div>
    </div>
  )
}
