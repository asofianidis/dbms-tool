import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  FileCode2,
  FilePlus2,
  Folder,
  FolderInput,
  Leaf,
  Link2,
  Pencil,
  Play,
  Search,
  Settings2,
  Tag,
  Trash2,
  X
} from 'lucide-react'
import { connectionLabel } from '@/lib/engines'
import { copyText } from '@/lib/export'
import {
  allFolders,
  deleteSavedQuery,
  findByName,
  matchesSearch,
  parseTags,
  queryKindOf,
  renameFolder,
  savedQueriesStore,
  sortQueries,
  updateSavedQuery,
  type SavedQuery
} from '@/lib/saved'
import { toast } from '@/lib/toast'
import {
  activeTab,
  confirm,
  connectionsStore,
  getConnection,
  promptText,
  tabsStore
} from '@/lib/workspace'
import { showContextMenu, showMenuAt, type MenuItem } from '@/components/ContextMenu'
import { Button, Segmented } from '@/components/ui'
import { defaultTarget, openSavedQuery, runOnMenu, runSavedQuery, targetLabel } from './actions'
import { QueryDetailsDialog } from './QueryDetailsDialog'
import { SnippetsList } from './SnippetsList'

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

async function moveToFolder(query: SavedQuery): Promise<void> {
  const folder = await promptText({
    title: 'Move to folder',
    label: 'Folder (empty for none; nest with a slash)',
    initial: query.folder ?? '',
    placeholder: 'Reports/Daily',
    confirmLabel: 'Move'
  })
  if (folder === null) return
  const clean = folder
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/')
  updateSavedQuery(query.id, { folder: clean || undefined })
}

async function editTags(query: SavedQuery): Promise<void> {
  const text = await promptText({
    title: 'Tags',
    label: 'Separate with commas or spaces',
    initial: (query.tags ?? []).join(', '),
    placeholder: 'billing, daily',
    confirmLabel: 'Save'
  })
  if (text !== null) updateSavedQuery(query.id, { tags: parseTags(text) })
}

async function renameFolderPrompt(folder: string): Promise<void> {
  const next = await promptText({
    title: 'Rename folder',
    label: 'Folder',
    initial: folder,
    confirmLabel: 'Rename'
  })
  const clean = next
    ?.split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('/')
  if (clean === undefined || clean === folder) return
  savedQueriesStore.set((list) => renameFolder(list, folder, clean))
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

/** Ties the query to a connection, or frees it to run anywhere. */
function connectionMenu(query: SavedQuery): MenuItem[] {
  const connections = connectionsStore.get().filter((c) => queryKindOf(c.engine) === query.kind)
  return [
    {
      label: 'Any connection',
      shortcut: query.connectionId ? undefined : '✓',
      onSelect: () => updateSavedQuery(query.id, { connectionId: null, database: null })
    },
    'separator',
    ...connections.map((c): MenuItem => ({
      label: connectionLabel(c),
      shortcut: query.connectionId === c.id ? '✓' : undefined,
      onSelect: () => updateSavedQuery(query.id, { connectionId: c.id, database: null })
    }))
  ]
}

interface FolderNode {
  path: string
  name: string
  depth: number
}

export function SavedQueriesPanel(): React.JSX.Element {
  const saved = savedQueriesStore.use()
  // The default run target follows the active tab and the connection list
  tabsStore.use()
  connectionsStore.use()
  const [view, setView] = useState<'queries' | 'snippets'>('queries')
  const [filter, setFilter] = useState('')
  const [thisConnection, setThisConnection] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [details, setDetails] = useState<SavedQuery | null>(null)
  const tab = activeTab()
  const activeConnection = tab && 'connectionId' in tab ? tab.connectionId : null

  const visible = useMemo(() => {
    let list = filter.trim() ? saved.filter((s) => matchesSearch(s, filter)) : saved
    // Untied queries run anywhere, so they stay listed
    if (thisConnection && activeConnection)
      list = list.filter((q) => !q.connectionId || q.connectionId === activeConnection)
    return sortQueries(list)
  }, [saved, filter, thisConnection, activeConnection])

  // Folders that hold a visible query, with their parents
  const folders = useMemo<FolderNode[]>(
    () =>
      allFolders(visible).map((path) => ({
        path,
        name: path.split('/').pop()!,
        depth: path.split('/').length - 1
      })),
    [visible]
  )
  const isHidden = (path: string): boolean =>
    [...collapsed].some((c) => path === c || path.startsWith(`${c}/`))
  const toggle = (path: string): void =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const item = (q: SavedQuery, depth: number): React.JSX.Element => {
    const target = defaultTarget(q)
    const runLabel = `Run on ${targetLabel(target)}`
    const tied = q.connectionId ? getConnection(q.connectionId) : undefined
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
              { label: 'Details…', icon: <Settings2 />, onSelect: () => setDetails(q) },
              { label: 'Rename…', icon: <Pencil />, onSelect: () => void rename(q) },
              {
                label: 'Move to folder…',
                icon: <FolderInput />,
                onSelect: () => void moveToFolder(q)
              },
              { label: 'Tags…', icon: <Tag />, onSelect: () => void editTags(q) },
              { label: 'Use with', icon: <Link2 />, submenu: connectionMenu(q) },
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
          className="block w-full py-2 pr-3 text-left"
          style={{ paddingLeft: 12 + depth * 12 }}
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
          {(tied || q.tags?.length) && (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {tied && (
                <span
                  className="flex items-center gap-0.5 rounded bg-accent/10 px-1 text-[10.5px] text-accent"
                  title="Runs on this connection by default"
                >
                  <Link2 className="size-2.5" />
                  {connectionLabel(tied)}
                  {q.database ? ` / ${q.database}` : ''}
                </span>
              )}
              {q.tags?.map((t) => (
                <span
                  key={t}
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation()
                    setFilter(`#${t}`)
                  }}
                  className="rounded bg-hover px-1 text-[10.5px] text-muted hover:text-bright"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
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
  }

  const unfiled = visible.filter((q) => !q.folder)

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
        <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">
          {view === 'queries' ? 'Saved queries' : 'Snippets'}
        </span>
        <div className="flex-1" />
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'queries', label: 'Queries' },
            { value: 'snippets', label: 'Snippets' }
          ]}
        />
      </div>
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={view === 'queries' ? 'Search · #tag · @folder' : 'Search snippets'}
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
        {view === 'queries' && activeConnection && saved.some((q) => q.connectionId) && (
          <label className="mt-1.5 flex items-center gap-1.5 px-0.5 text-[11.5px] text-muted">
            <input
              type="checkbox"
              checked={thisConnection}
              onChange={(e) => setThisConnection(e.target.checked)}
              className="accent-(--accent)"
            />
            Only queries for {connectionLabel(getConnection(activeConnection)!)} and untied ones
          </label>
        )}
      </div>
      {view === 'snippets' ? (
        <SnippetsList filter={filter} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {unfiled.map((q) => item(q, 0))}
          {folders.map((f) =>
            isHidden(f.path.split('/').slice(0, -1).join('/') || '\0') ? null : (
              <div key={`folder:${f.path}`}>
                <button
                  type="button"
                  onClick={() => toggle(f.path)}
                  onContextMenu={(e) =>
                    showContextMenu(e, [
                      {
                        label: 'Rename folder…',
                        icon: <Pencil />,
                        onSelect: () => void renameFolderPrompt(f.path)
                      },
                      {
                        label: 'Move queries out of folder',
                        icon: <FolderInput />,
                        onSelect: () =>
                          savedQueriesStore.set((list) =>
                            renameFolder(list, f.path, f.path.split('/').slice(0, -1).join('/'))
                          )
                      }
                    ])
                  }
                  className="flex w-full items-center gap-1 border-b border-line/60 bg-panel/60 py-1.5 pr-3 text-left text-[12px] text-fg hover:bg-hover/60"
                  style={{ paddingLeft: 8 + f.depth * 12 }}
                >
                  {collapsed.has(f.path) ? (
                    <ChevronRight className="size-3.5 text-faint" />
                  ) : (
                    <ChevronDown className="size-3.5 text-faint" />
                  )}
                  <Folder className="size-3.5 text-muted" />
                  <span className="truncate font-medium">{f.name}</span>
                  <span className="ml-auto text-[11px] text-faint tabular-nums">
                    {
                      visible.filter(
                        (q) => q.folder === f.path || q.folder?.startsWith(`${f.path}/`)
                      ).length
                    }
                  </span>
                </button>
                {!collapsed.has(f.path) &&
                  visible.filter((q) => q.folder === f.path).map((q) => item(q, f.depth + 1))}
              </div>
            )
          )}
          {!visible.length && (
            <p className="px-4 py-6 text-center text-xs text-faint">
              {saved.length
                ? 'No matches'
                : 'Save a query from the Saved menu in any query tab to run it again on any connection.'}
            </p>
          )}
        </div>
      )}
      {details && <QueryDetailsDialog query={details} onClose={() => setDetails(null)} />}
    </div>
  )
}
