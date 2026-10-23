import { Bookmark, Database, History, Plus, Settings } from 'lucide-react'
import { cn } from '@/lib/cn'
import { MOD, SHIFT } from '@/lib/keys'
import { layoutStore, openConnectionDialog, openSettings, type SidebarView } from '@/lib/workspace'

function RailButton({
  label,
  active,
  onClick,
  children
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'relative flex size-10 items-center justify-center rounded-md transition-colors',
        active ? 'text-bright' : 'text-faint hover:text-fg'
      )}
    >
      {active && <span className="absolute top-2 bottom-2 -left-1 w-0.5 rounded-full bg-accent" />}
      {children}
    </button>
  )
}

export function ActivityRail(): React.JSX.Element {
  const layout = layoutStore.use()
  const toggle = (view: SidebarView): void =>
    layoutStore.set((l) =>
      l.sidebar === view && l.sidebarOpen
        ? { ...l, sidebarOpen: false }
        : { sidebar: view, sidebarOpen: true }
    )
  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-1.5">
      <RailButton
        label={`Explorer (${MOD}${SHIFT}E)`}
        active={layout.sidebarOpen && layout.sidebar === 'explorer'}
        onClick={() => toggle('explorer')}
      >
        <Database className="size-[18px]" strokeWidth={1.75} />
      </RailButton>
      <RailButton
        label={`Query history (${MOD}${SHIFT}H)`}
        active={layout.sidebarOpen && layout.sidebar === 'history'}
        onClick={() => toggle('history')}
      >
        <History className="size-[18px]" strokeWidth={1.75} />
      </RailButton>
      <RailButton
        label="Saved queries"
        active={layout.sidebarOpen && layout.sidebar === 'saved'}
        onClick={() => toggle('saved')}
      >
        <Bookmark className="size-[18px]" strokeWidth={1.75} />
      </RailButton>
      <RailButton label="New connection" onClick={() => openConnectionDialog()}>
        <Plus className="size-[18px]" strokeWidth={1.75} />
      </RailButton>
      <div className="flex-1" />
      <RailButton label={`Settings (${MOD},)`} onClick={openSettings}>
        <Settings className="size-[18px]" strokeWidth={1.75} />
      </RailButton>
    </nav>
  )
}
