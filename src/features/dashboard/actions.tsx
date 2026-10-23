import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { api } from '@/lib/api'
import {
  createDashboard,
  dashboardsStore,
  deleteDashboard,
  findDashboardByName,
  newWidget,
  parseDashboardFile,
  serializeDashboard,
  uniqueDashboardName,
  updateDashboard,
  type Dashboard
} from '@/lib/dashboards'
import { exampleDashboard } from '@/lib/dashboard-example'
import { connectionLabel } from '@/lib/engines'
import { saveToFile } from '@/lib/export'
import { toast, toastError } from '@/lib/toast'
import {
  activeConnectionId,
  closeTab,
  confirm,
  connectionsStore,
  defaultDatabase,
  getConnection,
  layoutStore,
  openConnectionDialog,
  openDashboard,
  promptText,
  statusOf,
  tabsStore
} from '@/lib/workspace'

/** The active tab's connection, else a connected one, else the first. */
function pickConnection(): string | undefined {
  const connections = connectionsStore.get()
  return (
    activeConnectionId() ??
    connections.find((c) => statusOf(c.id).state === 'connected')?.id ??
    connections[0]?.id
  )
}

async function askName(title: string, initial: string, confirmLabel: string, current?: Dashboard) {
  const name = (
    await promptText({
      title,
      label: 'Name',
      placeholder: 'e.g. Orders overview',
      initial,
      confirmLabel
    })
  )?.trim()
  if (!name) return null
  const clash = findDashboardByName(dashboardsStore.get(), name)
  if (clash && clash.id !== current?.id) {
    toast(`A dashboard named “${clash.name}” already exists`, 'error')
    return null
  }
  return name
}

export async function newDashboard(connectionId?: string, database?: string): Promise<void> {
  const id = connectionId ?? pickConnection()
  if (!id) {
    toast('Add a connection first, then create a dashboard on it', 'info')
    openConnectionDialog()
    return
  }
  const db = database ?? defaultDatabase(id)
  const name = await askName('New dashboard', db ? `${db} overview` : '', 'Create')
  if (!name) return
  const result = createDashboard(dashboardsStore.get(), { name, connectionId: id, database: db })
  dashboardsStore.set(result.list)
  openDashboard(result.dashboard.id)
}

/** True (with a hint) when the dashboard is locked against changes. */
export function isLocked(dashboard: Dashboard): boolean {
  if (!dashboard.locked) return false
  toast(`“${dashboard.name}” is locked. Unlock it from its toolbar to make changes.`, 'info')
  return true
}

export function setLocked(dashboard: Dashboard, locked: boolean): void {
  updateDashboard(dashboard.id, { locked })
}

export async function renameDashboard(dashboard: Dashboard): Promise<void> {
  if (isLocked(dashboard)) return
  const name = await askName('Rename dashboard', dashboard.name, 'Rename', dashboard)
  if (name && name !== dashboard.name) updateDashboard(dashboard.id, { name })
}

export function duplicateDashboard(dashboard: Dashboard): void {
  const { id: _, createdAt: __, updatedAt: ___, ...rest } = dashboard
  const result = createDashboard(dashboardsStore.get(), {
    ...rest,
    // A copy is yours to change, even when the original is locked
    locked: false,
    name: uniqueDashboardName(dashboardsStore.get(), `${dashboard.name} copy`),
    widgets: dashboard.widgets.map((w) => newWidget({ ...w, id: crypto.randomUUID() }))
  })
  dashboardsStore.set(result.list)
  openDashboard(result.dashboard.id)
}

export async function removeDashboard(dashboard: Dashboard): Promise<void> {
  if (isLocked(dashboard)) return
  const ok = await confirm({
    title: `Delete “${dashboard.name}”?`,
    message: `The dashboard and its ${dashboard.widgets.length === 1 ? 'widget' : `${dashboard.widgets.length} widgets`} are removed. Nothing in the database changes.`,
    confirmLabel: 'Delete',
    danger: true
  })
  if (!ok) return
  for (const t of tabsStore.get().tabs)
    if (t.kind === 'dashboard' && t.dashboardId === dashboard.id) closeTab(t.id)
  deleteDashboard(dashboard.id)
}

export async function exportDashboard(dashboard: Dashboard): Promise<void> {
  const file = dashboard.name.replace(/[\\/:*?"<>|]+/g, '-')
  await saveToFile(serializeDashboard(dashboard), `${file}.dashboard.json`, 'json')
}

/** Imports an exported dashboard onto the current connection. */
export async function importDashboard(): Promise<void> {
  const connectionId = pickConnection()
  if (!connectionId) {
    toast('Add a connection first, then import the dashboard onto it', 'info')
    openConnectionDialog()
    return
  }
  try {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: 'Dashboard', extensions: ['json'] }]
    })
    if (typeof path !== 'string') return
    const data = parseDashboardFile(await api.readText(path))
    const result = createDashboard(dashboardsStore.get(), {
      ...data,
      name: uniqueDashboardName(dashboardsStore.get(), data.name),
      connectionId,
      database: data.database || defaultDatabase(connectionId),
      unreviewed: true
    })
    dashboardsStore.set(result.list)
    openDashboard(result.dashboard.id)
    const connection = getConnection(connectionId)
    toast(
      `Imported “${result.dashboard.name}” on ${connection ? connectionLabel(connection) : 'this connection'}. Pick another connection from its toolbar if needed.`,
      'info'
    )
  } catch (e) {
    toastError(e)
  }
}

/** Creates the example dashboard on the current connection and opens it. */
export function openExampleDashboard(): void {
  const connectionId = pickConnection()
  const connection = connectionId ? getConnection(connectionId) : undefined
  if (!connectionId || !connection) {
    toast('Add a connection first; the example runs its sample queries on it', 'info')
    openConnectionDialog()
    return
  }
  const example = exampleDashboard(connection.engine)
  const result = createDashboard(dashboardsStore.get(), {
    ...example,
    name: uniqueDashboardName(dashboardsStore.get(), example.name),
    connectionId,
    database: defaultDatabase(connectionId)
  })
  dashboardsStore.set(result.list)
  openDashboard(result.dashboard.id)
  toast(
    connection.engine === 'mongo'
      ? 'The example uses sample data via $documents (MongoDB 5.1+). It’s locked; unlock it from the toolbar to rearrange or edit.'
      : 'The example uses sample data, so no tables are read. It’s locked; unlock it from the toolbar to rearrange or edit.',
    'info'
  )
}

export function showDashboards(): void {
  layoutStore.set({ sidebar: 'dashboards', sidebarOpen: true })
}
