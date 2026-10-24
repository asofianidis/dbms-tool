import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Minus, Moon, Search, Square, Sun, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { MOD } from '@/lib/keys'
import { activeTab, connectionsStore, openPalette, tabsStore } from '@/lib/workspace'
import { connectionLabel } from '@/lib/engines'
import { Kbd, LogoMark } from '../ui'
import { UpdateButton } from './UpdateButton'
import { settingsStore } from '@/lib/settings'
import { resolvedBase, toggleThemeMode } from '@/lib/themes'

const appWindow = getCurrentWindow()

function RestoreIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 10 10"
      className="size-[10px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <rect x="0.5" y="2.5" width="7" height="7" />
      <path d="M2.5 2.5V0.5h7v7h-2" />
    </svg>
  )
}

export function TitleBar(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  settingsStore.use()
  const dark = resolvedBase() === 'dark'
  tabsStore.use()
  const connections = connectionsStore.use()
  const tab = activeTab()
  const connection =
    tab && 'connectionId' in tab ? connections.find((c) => c.id === tab.connectionId) : undefined

  useEffect(() => {
    void appWindow.isMaximized().then(setMaximized)
    const unlisten = appWindow.onResized(() => void appWindow.isMaximized().then(setMaximized))
    return () => void unlisten.then((f) => f())
  }, [])

  const context =
    tab?.kind === 'query' || tab?.kind === 'mongo' || tab?.kind === 'redis'
      ? tab.title
      : tab?.kind === 'table'
        ? tab.name
        : tab?.kind === 'collection'
          ? tab.collection
          : null

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-9 shrink-0 items-center border-b border-line bg-panel pl-3"
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) void appWindow.toggleMaximize()
      }}
    >
      <div data-tauri-drag-region className="pointer-events-none flex items-center gap-2">
        <LogoMark size="sm" />
        <span className="text-[12.5px] font-semibold tracking-tight text-bright">dbms-tool</span>
      </div>

      <div
        data-tauri-drag-region
        className="pointer-events-none absolute inset-x-0 flex justify-center"
      >
        <button
          type="button"
          onClick={() => openPalette()}
          className="pointer-events-auto flex h-6 w-[min(520px,46vw)] items-center gap-2 rounded-md border border-line-strong bg-canvas/70 px-2.5 text-[12px] text-muted transition-colors hover:border-faint hover:text-fg"
        >
          <Search className="size-3.5 shrink-0" />
          <span className="truncate">
            {connection ? (
              <>
                <span className="text-fg">{connectionLabel(connection)}</span>
                {context && <span className="text-faint"> — {context}</span>}
              </>
            ) : (
              'Search connections, tables and commands'
            )}
          </span>
          <Kbd className="ml-auto h-4 border-line bg-transparent">{MOD}K</Kbd>
        </button>
      </div>

      <div data-tauri-drag-region className="flex-1" />

      <div className="relative z-10 mr-2 flex items-center">
        <UpdateButton />
        <button
          type="button"
          onClick={toggleThemeMode}
          title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          className="ml-1 flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-bright"
        >
          {dark ? (
            <Sun className="size-4" strokeWidth={1.75} />
          ) : (
            <Moon className="size-4" strokeWidth={1.75} />
          )}
        </button>
      </div>

      <div className="relative z-10 flex h-full">
        {[
          {
            label: 'Minimize',
            onClick: () => void appWindow.minimize(),
            icon: <Minus className="size-3.5" strokeWidth={1.5} />
          },
          {
            label: maximized ? 'Restore' : 'Maximize',
            onClick: () => void appWindow.toggleMaximize(),
            icon: maximized ? <RestoreIcon /> : <Square className="size-[10px]" strokeWidth={1.5} />
          },
          {
            label: 'Close',
            onClick: () => void appWindow.close(),
            icon: <X className="size-4" strokeWidth={1.5} />,
            close: true
          }
        ].map((b) => (
          <button
            key={b.label}
            type="button"
            aria-label={b.label}
            title={b.label}
            onClick={b.onClick}
            className={cn(
              'flex h-full w-11 items-center justify-center text-muted transition-colors',
              b.close ? 'hover:bg-[#c42b1c] hover:text-white' : 'hover:bg-hover hover:text-bright'
            )}
          >
            {b.icon}
          </button>
        ))}
      </div>
    </header>
  )
}
