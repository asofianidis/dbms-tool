import { memo, useEffect } from 'react'
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { CommandPalette } from './components/CommandPalette'
import { ContextMenuHost } from './components/ContextMenu'
import { ConnectionDialogHost } from './components/dialogs/ConnectionDialog'
import { ImportConnectionsHost } from './features/connections/ImportConnections'
import { ConfirmHost, PasswordPromptHost, PromptHost } from './components/dialogs/Dialogs'
import { ActivityRail } from './components/shell/ActivityRail'
import { StatusBar } from './components/shell/StatusBar'
import { TabBar } from './components/shell/TabBar'
import { TitleBar } from './components/shell/TitleBar'
import { EmptyState, Toaster } from './components/ui'
import { ExecuteRoutineHost } from './features/explorer/ExecuteRoutineDialog'
import { CreateCollectionHost } from './features/mongo/CreateCollectionDialog'
import { MongoUserDesignerHost } from './features/mongo/MongoUserDesigner'
import { Explorer } from './features/explorer/Explorer'
import { SchemaDesignerHost } from './features/explorer/SchemaDesigner'
import { HistoryPanel } from './features/history/HistoryPanel'
import { SavedQueriesPanel } from './features/saved/SavedQueriesPanel'
import { TableDesignerHost } from './features/table/TableDesigner'
import { TriggerDesignerHost } from './features/table/TriggerDesigner'
import { PermissionsDesignerHost } from './features/explorer/PermissionsDesigner'
import { PrincipalDesignerHost } from './features/explorer/PrincipalDesigner'
import { SeedHost } from './features/seed/SeedDialog'
import { BackupTab } from './features/backup/BackupTab'
import { CompareTab } from './features/compare/CompareTab'
import { MaintenanceTab } from './features/maintenance/MaintenanceTab'
import { ImportTab } from './features/import/ImportTab'
import { CloudTab } from './features/cloud/CloudTab'
import { CollectionTab } from './features/mongo/CollectionTab'
import { DashboardTab } from './features/dashboard/DashboardTab'
import { DashboardsPanel } from './features/dashboard/DashboardsPanel'
import { DiagramTab } from './features/diagram/DiagramTab'
import { MongoShellTab } from './features/mongo/MongoShellTab'
import { QueryTab } from './features/query/QueryTab'
import { ServerTab } from './features/server/ServerTab'
import { SettingsTab } from './features/settings/SettingsTab'
import { TableTab } from './features/table/TableTab'
import { WelcomeTab } from './features/welcome/WelcomeTab'
import { cn } from './lib/cn'
import { isMod } from './lib/keys'
import { queryClient } from './lib/queries'
import { toastError } from './lib/toast'
import { migrateAccentSetting, startThemeSync } from './lib/themes'
import { startSettingsSync } from './lib/app-settings'
import { startProductionGuard } from './lib/production'
import { startUpdateChecks } from './lib/updater'
import {
  activateTab,
  activeTab,
  bindQueryClient,
  closeTab,
  layoutStore,
  loadConnections,
  newQueryTab,
  openPalette,
  openSettings,
  openWelcome,
  tabsStore,
  type Tab
} from './lib/workspace'

// Tabs are replaced immutably, so only the tab that changed re-renders on each keystroke
const TabContent = memo(function TabContent({ tab }: { tab: Tab }): React.JSX.Element {
  switch (tab.kind) {
    case 'welcome':
      return <WelcomeTab />
    case 'settings':
      return <SettingsTab />
    case 'query':
      return <QueryTab tab={tab} />
    case 'mongo':
      return <MongoShellTab tab={tab} />
    case 'table':
      return <TableTab tab={tab} />
    case 'collection':
      return <CollectionTab tab={tab} />
    case 'server':
      return <ServerTab tab={tab} />
    case 'diagram':
      return <DiagramTab tab={tab} />
    case 'dashboard':
      return <DashboardTab tab={tab} />
    case 'cloud':
      return <CloudTab />
    case 'backup':
      return <BackupTab tab={tab} />
    case 'maintenance':
      return <MaintenanceTab tab={tab} />
    case 'compare':
      return <CompareTab tab={tab} />
    case 'import':
      return <ImportTab tab={tab} />
  }
})

function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase()
      // Keep the webview from reloading the app
      if (e.key === 'F5' || (isMod(e) && key === 'r')) e.preventDefault()
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const { order, tabs } = tabsStore.get()
        const ids = order.filter((id) => tabs.some((t) => t.id === id))
        if (ids.length > 1) activateTab(e.shiftKey ? ids[ids.length - 1] : ids[1])
        return
      }
      if (!isMod(e)) return
      if (key === 'k' || (key === 'p' && !e.shiftKey)) {
        e.preventDefault()
        openPalette()
      } else if (key === 'p' && e.shiftKey) {
        e.preventDefault()
        openPalette('>')
      } else if (key === 'n' && !e.shiftKey) {
        e.preventDefault()
        newQueryTab()
      } else if (key === 'w') {
        e.preventDefault()
        const tab = activeTab()
        if (tab) closeTab(tab.id)
      } else if (key === ',') {
        e.preventDefault()
        openSettings()
      } else if (key === 'b' && !e.shiftKey) {
        e.preventDefault()
        layoutStore.set((l) => ({ ...l, sidebarOpen: !l.sidebarOpen }))
      } else if (e.shiftKey && key === 'e') {
        e.preventDefault()
        layoutStore.set({ sidebar: 'explorer', sidebarOpen: true })
      } else if (e.shiftKey && key === 'h') {
        e.preventDefault()
        layoutStore.set({ sidebar: 'history', sidebarOpen: true })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

export function App(): React.JSX.Element {
  const { tabs, active } = tabsStore.use()
  const layout = layoutStore.use()
  const sidebar = usePanelRef()
  const saved = useDefaultLayout({ id: 'workbench', storage: localStorage })
  useGlobalShortcuts()

  useEffect(() => {
    bindQueryClient(queryClient)
    migrateAccentSetting()
    const stopThemes = startThemeSync()
    const stopSettings = startSettingsSync()
    const stopGuard = startProductionGuard()
    loadConnections().catch(toastError)
    if (!tabsStore.get().tabs.length) openWelcome()
    // Native menus on right-click make the app feel like a web page
    const onContextMenu = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (!target.closest('input, textarea, .cm-editor')) e.preventDefault()
    }
    window.addEventListener('contextmenu', onContextMenu)
    const stopUpdates = startUpdateChecks()
    return () => {
      window.removeEventListener('contextmenu', onContextMenu)
      stopUpdates()
      stopThemes()
      stopSettings()
      stopGuard()
    }
  }, [])

  useEffect(() => {
    const panel = sidebar.current
    if (!panel) return
    if (layout.sidebarOpen && panel.isCollapsed()) panel.expand()
    if (!layout.sidebarOpen && !panel.isCollapsed()) panel.collapse()
  }, [layout.sidebarOpen, sidebar])

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityRail />
        <Group
          orientation="horizontal"
          className="min-w-0 flex-1"
          defaultLayout={saved.defaultLayout}
          onLayoutChanged={saved.onLayoutChanged}
        >
          <Panel
            id="sidebar"
            panelRef={sidebar}
            defaultSize={280}
            minSize={200}
            maxSize="45%"
            collapsible
            collapsedSize={0}
            onResize={(size) => {
              const open = size.inPixels > 0
              if (open !== layoutStore.get().sidebarOpen)
                layoutStore.set((l) => ({ ...l, sidebarOpen: open }))
            }}
          >
            <div className="h-full bg-panel">
              {layout.sidebar === 'history' ? (
                <HistoryPanel />
              ) : layout.sidebar === 'saved' ? (
                <SavedQueriesPanel />
              ) : layout.sidebar === 'dashboards' ? (
                <DashboardsPanel />
              ) : (
                <Explorer />
              )}
            </div>
          </Panel>
          <Separator />
          <Panel id="main" minSize={400}>
            <main className="flex h-full min-w-0 flex-col bg-canvas">
              <TabBar />
              <div className="relative min-h-0 flex-1">
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={cn(
                      'absolute inset-0 flex flex-col',
                      tab.id !== active && 'invisible'
                    )}
                  >
                    <TabContent tab={tab} />
                  </div>
                ))}
                {!tabs.length && (
                  <EmptyState title="No open tabs">
                    Press Ctrl+N for a new query or Ctrl+K to search.
                  </EmptyState>
                )}
              </div>
            </main>
          </Panel>
        </Group>
      </div>
      <StatusBar />
      <CommandPalette />
      <ConnectionDialogHost />
      <ImportConnectionsHost />
      <PasswordPromptHost />
      <ConfirmHost />
      <PromptHost />
      <ExecuteRoutineHost />
      <CreateCollectionHost />
      <TableDesignerHost />
      <SchemaDesignerHost />
      <TriggerDesignerHost />
      <PermissionsDesignerHost />
      <PrincipalDesignerHost />
      <MongoUserDesignerHost />
      <SeedHost />
      <ContextMenuHost />
      <Toaster />
    </div>
  )
}
