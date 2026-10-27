import type { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { api, isAppError, type ConnectionConfig, type ObjectKind, type ServerInfo } from './api'
import type { CompareScope } from './compare'
import { ENGINES } from './engines'
import type { QueryState } from './filters'
import type { MaintenancePreset } from './maintenance'
import { createPersistentStore, createStore } from './store'
import { errorMessage, toast } from './toast'
import { clearTransactionState, openTransactionsStore } from './transactions'

/* ---------- Tabs ---------- */

export type TableView = 'data' | 'structure' | 'definition'
export type CollectionView = 'documents' | 'aggregation' | 'schema' | 'indexes' | 'validation'

export type Tab =
  | { id: string; kind: 'welcome' }
  | { id: string; kind: 'settings' }
  | {
      id: string
      kind: 'query'
      connectionId: string
      database: string
      title: string
      text: string
      filePath?: string
      savedText?: string
      /** Run (or explain) the whole script once, as soon as the editor has the text */
      autorun?: boolean | 'explain'
      /** The saved query this tab was opened from or saved as */
      savedQueryId?: string
    }
  | {
      id: string
      kind: 'mongo'
      connectionId: string
      database: string
      title: string
      text: string
      filePath?: string
      savedText?: string
      autorun?: boolean
      savedQueryId?: string
    }
  | {
      id: string
      /** Redis console */
      kind: 'redis'
      connectionId: string
      database: string
      title: string
      /** The command being typed */
      text: string
      filePath?: string
      savedText?: string
      autorun?: boolean
      savedQueryId?: string
    }
  | {
      id: string
      kind: 'redisKeys'
      connectionId: string
      database: string
      /** SCAN pattern to start with */
      pattern?: string
    }
  | {
      id: string
      kind: 'redisPubsub'
      connectionId: string
      /** Channels and patterns to subscribe to on open, comma separated */
      channels?: string
    }
  | {
      id: string
      /** PostgreSQL LISTEN / NOTIFY on a session of its own */
      kind: 'pgNotify'
      connectionId: string
      database: string
      /** Channels to listen on again, as last listened */
      channels?: string[]
    }
  | {
      id: string
      kind: 'table'
      connectionId: string
      database: string
      schema: string | null
      name: string
      objectKind: ObjectKind
      detail?: string | null
      view: TableView
      /** A filter for the data view to apply, e.g. when following a foreign key */
      query?: QueryState
    }
  | {
      id: string
      kind: 'collection'
      connectionId: string
      database: string
      collection: string
      view: CollectionView
    }
  | { id: string; kind: 'server'; connectionId: string }
  | { id: string; kind: 'cloud' }
  | {
      id: string
      kind: 'diagram'
      connectionId: string
      database: string
      /** null for engines browsed without schemas, where the whole database is drawn */
      schema: string | null
    }
  | { id: string; kind: 'dashboard'; dashboardId: string }
  | {
      id: string
      kind: 'backup'
      connectionId: string
      /** Database to back up or restore into; empty to choose in the wizard */
      database: string
      mode: 'backup' | 'restore'
    }
  | {
      id: string
      kind: 'maintenance'
      connectionId: string
      database: string
      /** Task and tables to start on, when opened for particular tables */
      preset?: MaintenancePreset
    }
  | {
      id: string
      kind: 'compare'
      /** The source: the side the target is changed to match */
      connectionId: string
      database: string
      schema: string | null
      table: string | null
      scope: CompareScope
      target: CompareTarget | null
    }
  | {
      id: string
      kind: 'import'
      connectionId: string
      database: string
      schema: string | null
      /** Table or collection to import into; null to choose or create one in the wizard */
      table: string | null
    }

/** The side of a comparison the migration script runs against. */
export interface CompareTarget {
  connectionId: string
  database: string
  schema: string | null
  table: string | null
}

export type TabOf<K extends Tab['kind']> = Extract<Tab, { kind: K }>

interface TabsState {
  tabs: Tab[]
  active: string | null
  /** Most recently used first, for Ctrl+Tab and closing */
  order: string[]
}

export const tabsStore = createPersistentStore<TabsState>('dbms.tabs.v1', {
  tabs: [{ id: 'welcome', kind: 'welcome' }],
  active: 'welcome',
  order: ['welcome']
})

function tabId(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function activateTab(id: string): void {
  tabsStore.set((s) => ({ ...s, active: id, order: [id, ...s.order.filter((o) => o !== id)] }))
}

export function openTab(tab: Tab, sameAs?: (t: Tab) => boolean): void {
  const existing = sameAs ? tabsStore.get().tabs.find(sameAs) : undefined
  if (existing) {
    // Re-opening a table in a different view switches that view
    if ('view' in tab && 'view' in existing && existing.view !== tab.view) {
      updateTab(existing.id, { view: tab.view } as Partial<Tab>)
    }
    activateTab(existing.id)
    return
  }
  tabsStore.set((s) => {
    const index = s.tabs.findIndex((t) => t.id === s.active)
    const tabs = [...s.tabs]
    tabs.splice(index < 0 ? tabs.length : index + 1, 0, tab)
    return { tabs, active: tab.id, order: [tab.id, ...s.order] }
  })
}

export function updateTab(id: string, patch: Partial<Tab>): void {
  tabsStore.set((s) => ({
    ...s,
    tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t))
  }))
}

export function closeTab(id: string, force = false): void {
  // Ending the session rolls back whatever the tab hasn't committed
  if (!force && openTransactionsStore.get()[id]) {
    // Closing several tabs queues a confirm for each; each shows its tab when asked
    void confirm({
      title: 'Close with an open transaction?',
      message:
        'This tab has a transaction that is still open. Closing it ends the session, which rolls back the uncommitted changes.',
      confirmLabel: 'Roll back and close',
      danger: true,
      onShow: () => activateTab(id)
    }).then((ok) => ok && closeTab(id, true))
    return
  }
  clearTransactionState(id)
  const tab = tabsStore.get().tabs.find((t) => t.id === id)
  if (tab && 'connectionId' in tab) {
    void api.closeSession(tab.connectionId, tab.id).catch(() => {})
    // The session the AI assistant's read-only queries ran on, if any
    if (tab.kind === 'query' || tab.kind === 'mongo')
      void api.aiSessionClose(tab.connectionId, tab.id).catch(() => {})
  }
  runsStore.set((r) => {
    const { [id]: _, ...rest } = r
    return rest
  })
  tabsStore.set((s) => {
    const tabs = s.tabs.filter((t) => t.id !== id)
    const order = s.order.filter((o) => o !== id && tabs.some((t) => t.id === o))
    const active = s.active === id ? (order[0] ?? tabs[tabs.length - 1]?.id ?? null) : s.active
    return { tabs, active, order }
  })
}

export function closeOtherTabs(id: string): void {
  for (const t of tabsStore.get().tabs) if (t.id !== id) closeTab(t.id)
}

export function moveTab(id: string, toIndex: number): void {
  tabsStore.set((s) => {
    const tabs = [...s.tabs]
    const from = tabs.findIndex((t) => t.id === id)
    if (from < 0) return s
    const [tab] = tabs.splice(from, 1)
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab)
    return { ...s, tabs }
  })
}

export function isDirty(tab: Tab): boolean {
  return (
    (tab.kind === 'query' || tab.kind === 'mongo') && !!tab.filePath && tab.text !== tab.savedText
  )
}

/* ---------- Connections ---------- */

export const connectionsStore = createStore<ConnectionConfig[]>([])

export type ConnectionStatus =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'connected'; info: ServerInfo }
  | { state: 'error'; error: string }

export const statusStore = createStore<Record<string, ConnectionStatus>>({})

let queryClient: QueryClient | null = null

export function bindQueryClient(client: QueryClient): void {
  queryClient = client
}

export async function loadConnections(): Promise<void> {
  connectionsStore.set(await api.connectionsList())
}

export function getConnection(id: string): ConnectionConfig | undefined {
  return connectionsStore.get().find((c) => c.id === id)
}

export function statusOf(id: string): ConnectionStatus {
  return statusStore.get()[id] ?? { state: 'idle' }
}

function setStatus(id: string, status: ConnectionStatus): void {
  statusStore.set((s) => ({ ...s, [id]: status }))
}

/* Password prompt: resolved by <PasswordPrompt /> */
export interface PasswordRequest {
  connection: ConnectionConfig
  error?: string
  resolve: (result: { password: string; remember: boolean } | null) => void
}

export const passwordPromptStore = createStore<PasswordRequest | null>(null)

function askPassword(
  connection: ConnectionConfig,
  error?: string
): Promise<{ password: string; remember: boolean } | null> {
  return new Promise((resolve) => passwordPromptStore.set({ connection, error, resolve }))
}

const pending = new Map<string, Promise<boolean>>()

/**
 * For a 'host_key_unknown' error: shows the SSH server's key fingerprint and,
 * if the user trusts it, adds it to known_hosts. Resolves `true` when the
 * caller should retry; `false` for other errors or when the user declines.
 */
export async function confirmSshHostKey(e: unknown): Promise<boolean> {
  if (!isAppError(e, 'host_key_unknown') || !e.hostKey) return false
  const key = e.hostKey
  const check = `Trust it only if this fingerprint matches the one the server's administrator gave you (ssh-keygen -lf on the server's host key).`
  const ok = await confirm({
    title: key.otherKeyTypesKnown
      ? 'This SSH server offered a different key type'
      : 'Trust this SSH server?',
    message: key.otherKeyTypesKnown
      ? `Warning: known_hosts already has a key of another type for ${key.host}, but the server now offers a ${key.keyType} key that isn't recorded. Its keys may have been replaced, or someone may be impersonating it. ${check}`
      : `This is the first connection to ${key.host}, so its identity can't be checked yet. ${check}`,
    code: `${key.keyType} key fingerprint
${key.fingerprint}`,
    confirmLabel: 'Trust and connect',
    danger: key.otherKeyTypesKnown
  })
  if (!ok) return false
  await api.sshTrustHostKey(key.token)
  return true
}

/** Opens a connection, prompting for a password if needed. Resolves `false` if cancelled or failed. */
export function connect(id: string): Promise<boolean> {
  if (statusOf(id).state === 'connected') return Promise.resolve(true)
  const inflight = pending.get(id)
  if (inflight) return inflight
  const run = (async () => {
    const connection = getConnection(id)
    if (!connection) return false
    setStatus(id, { state: 'connecting' })
    let password: string | undefined
    let remember = false
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const info = await api.connectionOpen(id, password, remember)
        setStatus(id, { state: 'connected', info })
        void queryClient?.invalidateQueries({ queryKey: ['conn', id] })
        if (remember) void loadConnections()
        return true
      } catch (e) {
        if (isAppError(e, 'host_key_unknown')) {
          const trusted = await confirmSshHostKey(e).catch((err: unknown) => {
            toast(errorMessage(err), 'error')
            return false
          })
          if (trusted) continue
          setStatus(id, { state: 'idle' })
          return false
        }
        const authFailed =
          password !== undefined &&
          /password|authentication|login failed|access denied/i.test(errorMessage(e))
        if (isAppError(e, 'password_required') || authFailed) {
          const answer = await askPassword(connection, authFailed ? errorMessage(e) : undefined)
          if (!answer) {
            setStatus(id, { state: 'idle' })
            return false
          }
          password = answer.password
          remember = answer.remember
          continue
        }
        setStatus(id, { state: 'error', error: errorMessage(e) })
        toast(`${connection.name || connection.host}: ${errorMessage(e)}`, 'error')
        return false
      }
    }
    setStatus(id, { state: 'idle' })
    return false
  })()
  pending.set(id, run)
  void run.finally(() => pending.delete(id))
  return run
}

export async function disconnect(id: string): Promise<void> {
  await api.connectionClose(id).catch(() => {})
  setStatus(id, { state: 'idle' })
  queryClient?.removeQueries({ queryKey: ['conn', id] })
}

export function refreshConnection(id: string): void {
  void queryClient?.invalidateQueries({ queryKey: ['conn', id] })
}

/** Database new tabs on this connection should open in. */
export function defaultDatabase(id: string): string {
  const status = statusOf(id)
  const connection = getConnection(id)
  if (status.state === 'connected' && status.info.currentDatabase)
    return status.info.currentDatabase
  return connection?.database || (connection ? ENGINES[connection.engine].defaultDatabase : '')
}

/* ---------- Opening things ---------- */

let untitled = 0

export function newQueryTab(
  connectionId?: string,
  database?: string,
  text = '',
  options: { autorun?: boolean | 'explain'; title?: string; savedQueryId?: string } = {}
): void {
  const fallback = connectionId ?? activeConnectionId() ?? connectionsStore.get()[0]?.id
  if (!fallback) {
    openConnectionDialog()
    return
  }
  const connection = getConnection(fallback)
  const kind =
    connection?.engine === 'mongo' ? 'mongo' : connection?.engine === 'redis' ? 'redis' : 'query'
  untitled++
  openTab({
    id: tabId(),
    kind,
    connectionId: fallback,
    database: database ?? defaultDatabase(fallback),
    title:
      options.title ??
      `${kind === 'mongo' ? 'shell' : kind === 'redis' ? 'console' : 'query'}-${untitled}`,
    text,
    ...(options.autorun ? { autorun: options.autorun } : {}),
    ...(options.savedQueryId ? { savedQueryId: options.savedQueryId } : {})
  } as Tab)
}

export function openTable(
  connectionId: string,
  database: string,
  schema: string | null,
  name: string,
  objectKind: ObjectKind,
  view: TableView = 'data',
  detail?: string | null,
  query?: QueryState
): void {
  const sameAs = (t: Tab): boolean =>
    t.kind === 'table' &&
    t.connectionId === connectionId &&
    t.database === database &&
    t.schema === schema &&
    t.name === name &&
    (t.detail ?? null) === (detail ?? null)
  const existing = tabsStore.get().tabs.find(sameAs)
  // An already open tab picks up the new filter
  if (existing && query) updateTab(existing.id, { query } as Partial<Tab>)
  openTab(
    {
      id: tabId(),
      kind: 'table',
      connectionId,
      database,
      schema,
      name,
      objectKind,
      view,
      detail,
      ...(query ? { query } : {})
    },
    sameAs
  )
}

export function openCollection(
  connectionId: string,
  database: string,
  collection: string,
  view: CollectionView = 'documents'
): void {
  openTab(
    { id: tabId(), kind: 'collection', connectionId, database, collection, view },
    (t) =>
      t.kind === 'collection' &&
      t.connectionId === connectionId &&
      t.database === database &&
      t.collection === collection
  )
}

/** The key browser for one Redis keyspace; an open one picks up `pattern`. */
export function openRedisKeys(connectionId: string, database: string, pattern?: string): void {
  const sameAs = (t: Tab): boolean =>
    t.kind === 'redisKeys' && t.connectionId === connectionId && t.database === database
  const existing = tabsStore.get().tabs.find(sameAs)
  if (existing && pattern !== undefined) updateTab(existing.id, { pattern } as Partial<Tab>)
  openTab({ id: tabId(), kind: 'redisKeys', connectionId, database, pattern }, sameAs)
}

export function openRedisPubsub(connectionId: string, channels?: string): void {
  openTab({ id: tabId(), kind: 'redisPubsub', connectionId, channels })
}

/** One Notifications tab per connection and database. */
export function openPgNotify(connectionId: string, database = defaultDatabase(connectionId)): void {
  openTab(
    { id: tabId(), kind: 'pgNotify', connectionId, database },
    (t) => t.kind === 'pgNotify' && t.connectionId === connectionId && t.database === database
  )
}

export function openSettings(): void {
  openTab({ id: 'settings', kind: 'settings' }, (t) => t.kind === 'settings')
}

export function openWelcome(): void {
  openTab({ id: 'welcome', kind: 'welcome' }, (t) => t.kind === 'welcome')
}

export function openServer(connectionId: string): void {
  openTab(
    { id: tabId(), kind: 'server', connectionId },
    (t) => t.kind === 'server' && t.connectionId === connectionId
  )
}

export function openCloud(): void {
  openTab({ id: 'cloud', kind: 'cloud' }, (t) => t.kind === 'cloud')
}

export function openDiagram(connectionId: string, database: string, schema: string | null): void {
  openTab(
    { id: tabId(), kind: 'diagram', connectionId, database, schema },
    (t) =>
      t.kind === 'diagram' &&
      t.connectionId === connectionId &&
      t.database === database &&
      t.schema === schema
  )
}

/** Opens the import wizard for a table or collection (`table` null to pick or create one). */
export function openImport(
  connectionId: string,
  database: string,
  schema: string | null,
  table: string | null = null
): void {
  openTab(
    { id: tabId(), kind: 'import', connectionId, database, schema, table },
    (t) =>
      t.kind === 'import' &&
      t.connectionId === connectionId &&
      t.database === database &&
      t.schema === schema &&
      t.table === table
  )
}

/** Opens the backup or restore wizard for `database` (empty to choose one there). */
export function openBackup(
  connectionId: string,
  database: string,
  mode: 'backup' | 'restore'
): void {
  openTab(
    { id: tabId(), kind: 'backup', connectionId, database, mode },
    (t) =>
      t.kind === 'backup' &&
      t.connectionId === connectionId &&
      t.database === database &&
      t.mode === mode
  )
}

/** Opens maintenance tasks (vacuum, analyze, integrity checks…) for `database`. */
export function openMaintenance(
  connectionId: string,
  database: string,
  preset?: Omit<MaintenancePreset, 'nonce'>
): void {
  const sameAs = (t: Tab): boolean =>
    t.kind === 'maintenance' && t.connectionId === connectionId && t.database === database
  const withNonce = preset && { ...preset, nonce: Date.now() }
  const existing = tabsStore.get().tabs.find(sameAs)
  if (existing && withNonce) updateTab(existing.id, { preset: withNonce } as Partial<Tab>)
  openTab({ id: tabId(), kind: 'maintenance', connectionId, database, preset: withNonce }, sameAs)
}

/** Opens a comparison of a database, schema or table (`table` set) against one chosen in the tab. */
export function openCompare(
  connectionId: string,
  database: string,
  schema: string | null,
  table: string | null = null
): void {
  const scope: CompareScope = table ? 'table' : schema ? 'schema' : 'database'
  openTab({
    id: tabId(),
    kind: 'compare',
    connectionId,
    database,
    schema,
    table,
    scope,
    target: null
  })
}

export function openDashboard(dashboardId: string): void {
  openTab(
    { id: tabId(), kind: 'dashboard', dashboardId },
    (t) => t.kind === 'dashboard' && t.dashboardId === dashboardId
  )
}

export function activeTab(): Tab | undefined {
  const s = tabsStore.get()
  return s.tabs.find((t) => t.id === s.active)
}

export function activeConnectionId(): string | undefined {
  const tab = activeTab()
  return tab && 'connectionId' in tab ? tab.connectionId : undefined
}

/* ---------- Dialogs ---------- */

export const connectionDialogStore = createStore<{
  open: boolean
  editing?: ConnectionConfig
  duplicate?: boolean
  /** A new connection with fields already filled in, e.g. from a cloud database */
  prefill?: { config: ConnectionConfig; password?: string }
}>({
  open: false
})

export function openConnectionDialog(editing?: ConnectionConfig, duplicate = false): void {
  connectionDialogStore.set({ open: true, editing, duplicate })
}

export function openPrefilledConnection(config: ConnectionConfig, password?: string): void {
  connectionDialogStore.set({ open: true, prefill: { config, password } })
}

export function closeConnectionDialog(): void {
  connectionDialogStore.set({ open: false })
}

export const paletteStore = createStore<{ open: boolean; query: string }>({
  open: false,
  query: ''
})

export function openPalette(query = ''): void {
  paletteStore.set({ open: true, query })
}

export function closePalette(): void {
  paletteStore.set({ open: false, query: '' })
}

export interface ConfirmRequest {
  title: string
  message: ReactNode
  confirmLabel?: string
  danger?: boolean
  /** Shown in a code block, e.g. the SQL about to run */
  code?: string
  /** Text the user has to type before the confirm button enables, e.g. a connection name */
  typeToConfirm?: string
  /** Called when the dialog comes up, which can be later than asked when others wait ahead */
  onShow?: () => void
  resolve: (ok: boolean) => void
}

export const confirmStore = createStore<ConfirmRequest | null>(null)

/** Confirms asked while one is open, shown in turn as each is answered */
const confirmQueue: ConfirmRequest[] = []

function showConfirm(request: ConfirmRequest): void {
  confirmStore.set(request)
  request.onShow?.()
}

export function confirm(request: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false
    const entry: ConfirmRequest = {
      ...request,
      resolve: (ok) => {
        if (answered) return
        answered = true
        resolve(ok)
        if (confirmStore.get() === entry) confirmStore.set(null)
        const next = confirmStore.get() ? undefined : confirmQueue.shift()
        if (next) showConfirm(next)
      }
    }
    if (confirmStore.get()) confirmQueue.push(entry)
    else showConfirm(entry)
  })
}

/* ---------- Per-tab run state (not persisted) ---------- */

export interface RunState {
  running: boolean
  startedAt: number
}

export const runsStore = createStore<Record<string, RunState>>({})

export function setRunning(tabId: string, running: boolean): void {
  runsStore.set((r) => ({
    ...r,
    [tabId]: { running, startedAt: running ? Date.now() : (r[tabId]?.startedAt ?? 0) }
  }))
}

/** Cursor position and selection of the focused editor, for the status bar. */
export const cursorStore = createStore<{ line: number; col: number; selected: number } | null>(null)

/** Summary of the last run in the active tab, for the status bar. */
export const lastRunStore = createStore<
  Record<string, { rows: number; elapsedMs: number; ok: boolean }>
>({})

export type SidebarView = 'explorer' | 'history' | 'saved' | 'dashboards'

export const layoutStore = createPersistentStore<{ sidebar: SidebarView; sidebarOpen: boolean }>(
  'dbms.layout.v1',
  { sidebar: 'explorer', sidebarOpen: true }
)

export interface PromptRequest {
  title: string
  label: string
  placeholder?: string
  initial?: string
  confirmLabel?: string
  resolve: (value: string | null) => void
}

export const promptStore = createStore<PromptRequest | null>(null)

/** In-app replacement for `window.prompt`, which the webview doesn't support. */
export function promptText(request: Omit<PromptRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => promptStore.set({ ...request, resolve }))
}
