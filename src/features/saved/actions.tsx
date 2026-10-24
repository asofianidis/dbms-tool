import { Bookmark, BookmarkPlus, Database, Play, Save } from 'lucide-react'
import { connectionLabel } from '@/lib/engines'
import { queries, queryClient } from '@/lib/queries'
import {
  findByName,
  queryKindOf,
  savedQueriesStore,
  splitFolder,
  updateSavedQuery,
  upsertQuery,
  type SavedQuery
} from '@/lib/saved'
import { toast } from '@/lib/toast'
import {
  activeTab,
  confirm,
  connectionsStore,
  defaultDatabase,
  getConnection,
  layoutStore,
  newQueryTab,
  promptText,
  statusOf,
  updateTab,
  type TabOf
} from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'
import { EngineMark } from '@/components/ui'

export type EditorTab = TabOf<'query'> | TabOf<'mongo'>

export interface RunTarget {
  connectionId: string
  database: string
}

/** Most recently used saved queries shown directly in the toolbar menu. */
const MENU_LIMIT = 10

/**
 * The connection the query is tied to, else the active tab's connection and
 * database, else the first connection that can run the query.
 */
export function defaultTarget(query: SavedQuery): RunTarget | undefined {
  const tied = query.connectionId ? getConnection(query.connectionId) : undefined
  if (tied && queryKindOf(tied.engine) === query.kind)
    return { connectionId: tied.id, database: query.database || defaultDatabase(tied.id) }
  const tab = activeTab()
  if (tab && 'database' in tab) {
    const connection = getConnection(tab.connectionId)
    if (connection && queryKindOf(connection.engine) === query.kind)
      return { connectionId: connection.id, database: tab.database }
  }
  const candidates = connectionsStore.get().filter((c) => queryKindOf(c.engine) === query.kind)
  const connection = candidates.find((c) => statusOf(c.id).state === 'connected') ?? candidates[0]
  return connection
    ? { connectionId: connection.id, database: defaultDatabase(connection.id) }
    : undefined
}

export function targetLabel(target: RunTarget | undefined): string {
  const connection = target && getConnection(target.connectionId)
  if (!target || !connection) return 'no connection'
  return target.database
    ? `${connectionLabel(connection)} / ${target.database}`
    : connectionLabel(connection)
}

function missingConnection(query: SavedQuery): void {
  const engine = query.kind === 'mongo' ? 'MongoDB' : query.kind === 'redis' ? 'Redis' : 'SQL'
  toast(`Add a ${engine} connection to run this query`, 'error')
}

/** Opens the query in a new tab; with `autorun` it runs as soon as the tab opens. */
export function openSavedQuery(
  query: SavedQuery,
  target = defaultTarget(query),
  autorun = false
): void {
  if (!target) return missingConnection(query)
  if (autorun) updateSavedQuery(query.id, { lastRunAt: Date.now() })
  newQueryTab(target.connectionId, target.database, query.text, {
    autorun,
    title: query.name,
    savedQueryId: query.id
  })
}

export function runSavedQuery(query: SavedQuery, target = defaultTarget(query)): void {
  openSavedQuery(query, target, true)
}

/** Loads the query into an existing editor tab and runs it on that tab's connection. */
export function runSavedQueryInTab(tab: EditorTab, query: SavedQuery): void {
  // Never overwrite a file's contents; run file-backed tabs' choices in a new tab instead
  if (tab.filePath)
    return runSavedQuery(query, { connectionId: tab.connectionId, database: tab.database })
  updateSavedQuery(query.id, { lastRunAt: Date.now() })
  updateTab(tab.id, { text: query.text, title: query.name, savedQueryId: query.id, autorun: true })
}

/** "Run on" choices: every compatible connection, with its databases when they're loaded. */
export function runOnMenu(query: SavedQuery): MenuItem[] {
  const connections = connectionsStore.get().filter((c) => queryKindOf(c.engine) === query.kind)
  if (!connections.length) return [{ label: 'No compatible connections', disabled: true }]
  return connections.map((c): MenuItem => {
    const base = { label: connectionLabel(c), icon: <EngineMark engine={c.engine} size="sm" /> }
    const databases = (queryClient.getQueryData(queries.databases(c.id).queryKey) ?? []).filter(
      (d) => !d.isSystem
    )
    if (!databases.length)
      return {
        ...base,
        onSelect: () =>
          runSavedQuery(query, { connectionId: c.id, database: defaultDatabase(c.id) })
      }
    return {
      ...base,
      submenu: databases.map((d) => ({
        label: d.name,
        icon: <Database className="text-info" />,
        onSelect: () => runSavedQuery(query, { connectionId: c.id, database: d.name })
      }))
    }
  })
}

/** Saves the tab's text as a saved query, updating the one it's linked to unless `asNew`. */
export async function saveTabQuery(tab: EditorTab, text: string, asNew = false): Promise<void> {
  if (!text.trim()) {
    toast('Write a query before saving it', 'error')
    return
  }
  const kind = tab.kind === 'mongo' ? 'mongo' : 'sql'
  const linked =
    !asNew && tab.savedQueryId
      ? savedQueriesStore.get().find((q) => q.id === tab.savedQueryId)
      : undefined
  let id = linked?.id
  let name = linked?.name
  let folder: string | undefined
  if (!linked) {
    const fileName = tab.filePath
      ?.split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, '')
    const answer = await promptText({
      title: 'Save query',
      label: 'Name',
      placeholder: 'Name, or Folder/Name, e.g. Reports/Active users',
      initial: fileName ?? '',
      confirmLabel: 'Save'
    })
    if (!answer?.trim()) return
    const path = splitFolder(answer)
    if (!path.name) return
    name = path.name
    folder = path.folder
    const clash = findByName(savedQueriesStore.get(), name, kind)
    if (clash) {
      const ok = await confirm({
        title: `Replace “${clash.name}”?`,
        message: 'A saved query with this name already exists. Its text is replaced.',
        confirmLabel: 'Replace',
        danger: true
      })
      if (!ok) return
      id = clash.id
    }
  }
  const result = upsertQuery(savedQueriesStore.get(), { id, name: name!, text, kind, folder })
  savedQueriesStore.set(result.list)
  updateTab(tab.id, { savedQueryId: result.saved.id, title: result.saved.name })
  toast(linked ? `Updated “${result.saved.name}”` : `Saved “${result.saved.name}”`)
}

export function showSavedQueries(): void {
  layoutStore.set({ sidebar: 'saved', sidebarOpen: true })
}

/** Items for the "Saved" dropdown in query and shell tab toolbars. */
export function savedMenu(tab: EditorTab, text: string): MenuItem[] {
  const kind = tab.kind === 'mongo' ? 'mongo' : 'sql'
  const list = savedQueriesStore.get().filter((q) => q.kind === kind)
  const linked = list.find((q) => q.id === tab.savedQueryId)
  const recent = [...list]
    .sort((a, b) => (b.lastRunAt ?? b.updatedAt) - (a.lastRunAt ?? a.updatedAt))
    .slice(0, MENU_LIMIT)
  return [
    linked
      ? {
          label: `Update “${linked.name}”`,
          icon: <Save />,
          disabled: linked.text === text,
          onSelect: () => void saveTabQuery(tab, text)
        }
      : {
          label: 'Save query…',
          icon: <BookmarkPlus />,
          onSelect: () => void saveTabQuery(tab, text)
        },
    ...(linked
      ? [
          {
            label: 'Save as new query…',
            icon: <BookmarkPlus />,
            onSelect: () => void saveTabQuery(tab, text, true)
          }
        ]
      : []),
    'separator',
    { heading: 'Run in this tab' },
    ...(recent.length
      ? recent.map((q): MenuItem => ({
          label: q.name,
          icon: <Play />,
          shortcut: q.id === linked?.id ? '✓' : undefined,
          onSelect: () => runSavedQueryInTab(tab, q)
        }))
      : [{ label: 'No saved queries yet', disabled: true }]),
    'separator',
    {
      label: list.length > MENU_LIMIT ? `All ${list.length} saved queries…` : 'Show saved queries',
      icon: <Bookmark />,
      onSelect: showSavedQueries
    }
  ]
}
