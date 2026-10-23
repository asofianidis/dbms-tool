import { CircleDot, Lock, Info } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ENGINES } from '@/lib/engines'
import { formatDuration } from '@/lib/format'
import { createStore } from '@/lib/store'
import {
  activeTab,
  connectionsStore,
  cursorStore,
  lastRunStore,
  runsStore,
  statusStore,
  tabsStore
} from '@/lib/workspace'

/** Grid selection summary (cells / sum / avg), set by the focused grid. */
export const selectionSummaryStore = createStore<string | null>(null)

export function StatusBar(): React.JSX.Element {
  tabsStore.use()
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const cursor = cursorStore.use()
  const runs = runsStore.use()
  const lastRuns = lastRunStore.use()
  const summary = selectionSummaryStore.use()
  const tab = activeTab()
  const connectionId = tab && 'connectionId' in tab ? tab.connectionId : undefined
  const connection = connections.find((c) => c.id === connectionId)
  const status = connectionId ? statuses[connectionId] : undefined
  const run = tab ? runs[tab.id] : undefined
  const last = tab ? lastRuns[tab.id] : undefined
  const database = tab && 'database' in tab ? tab.database : undefined
  const showCursor = tab?.kind === 'query' || tab?.kind === 'mongo'

  return (
    <footer className="flex h-6 shrink-0 items-stretch border-t border-line bg-panel text-[11px] text-muted">
      {connection ? (
        <div
          className="flex items-center gap-2 px-3"
          style={
            connection.color
              ? { background: `${connection.color}26`, color: connection.color }
              : undefined
          }
        >
          <CircleDot
            className={cn(
              'size-3',
              status?.state === 'connected'
                ? 'text-ok'
                : status?.state === 'error'
                  ? 'text-danger'
                  : status?.state === 'connecting'
                    ? 'animate-pulse text-warn'
                    : 'text-faint'
            )}
          />
          <span className={cn(!connection.color && 'text-fg')}>
            {connection.name || connection.host}
          </span>
          {database && <span className="opacity-80">/ {database}</span>}
          {connection.readOnly && (
            <span className="flex items-center gap-1 text-warn" title="Read-only connection">
              <Lock className="size-3" /> read-only
            </span>
          )}
        </div>
      ) : (
        <div className="flex items-center px-3 text-faint">No connection</div>
      )}
      {status?.state === 'connected' && (
        <div
          className="flex items-center gap-1.5 border-l border-line px-3"
          title={status.info.version}
        >
          {connection && (
            <span className="font-mono text-[10px] text-faint">
              {ENGINES[connection.engine].mark}
            </span>
          )}
          <span>{status.info.product}</span>
          {status.info.babelfishVersion && connection?.engine !== 'babelfish' && (
            <span
              className="flex items-center gap-1 text-babelfish"
              title="This server identifies as Babelfish. Edit the connection and pick Babelfish for tailored behaviour."
            >
              <Info className="size-3" /> Babelfish detected
            </span>
          )}
          {status.info.user && <span className="text-faint">· {status.info.user}</span>}
        </div>
      )}
      <div className="flex-1" />
      {summary && <div className="flex items-center px-3 text-fg">{summary}</div>}
      {run?.running ? (
        <div className="flex items-center gap-1.5 px-3 text-accent">
          <span className="size-1.5 animate-pulse rounded-full bg-accent" /> Running…
        </div>
      ) : (
        last && (
          <div className={cn('flex items-center gap-2 px-3', !last.ok && 'text-danger')}>
            <span>{last.rows.toLocaleString()} rows</span>
            <span className="text-faint">{formatDuration(last.elapsedMs)}</span>
          </div>
        )
      )}
      {showCursor && cursor && (
        <div className="flex items-center gap-2 border-l border-line px-3">
          Ln {cursor.line}, Col {cursor.col}
          {cursor.selected > 0 && <span className="text-faint">({cursor.selected} selected)</span>}
        </div>
      )}
    </footer>
  )
}
