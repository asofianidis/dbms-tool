import { useMemo, useState } from 'react'
import { CheckCircle2, ClipboardCopy, FilePlus2, Search, Trash2, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { copyText } from '@/lib/export'
import { formatDuration, timeAgo } from '@/lib/format'
import { historyStore, type HistoryEntry } from '@/lib/history'
import { confirm, connectionsStore, newQueryTab } from '@/lib/workspace'
import { showContextMenu } from '@/components/ContextMenu'
import { Button } from '@/components/ui'

export function HistoryPanel(): React.JSX.Element {
  const history = historyStore.use()
  const connections = connectionsStore.use()
  const [filter, setFilter] = useState('')
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q
      ? history.filter(
          (h) =>
            h.text.toLowerCase().includes(q) ||
            h.connectionName.toLowerCase().includes(q) ||
            h.database.toLowerCase().includes(q)
        )
      : history
  }, [history, filter])

  const open = (entry: HistoryEntry): void => {
    const exists = connections.some((c) => c.id === entry.connectionId)
    newQueryTab(
      exists ? entry.connectionId : undefined,
      exists ? entry.database : undefined,
      entry.text
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
        <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">
          History
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          title="Clear history"
          disabled={!history.length}
          onClick={async () => {
            if (
              await confirm({
                title: 'Clear query history?',
                message: 'All saved history entries are removed.',
                confirmLabel: 'Clear',
                danger: true
              })
            )
              historyStore.set([])
          }}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search history"
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
        {visible.map((h) => (
          <button
            key={h.id}
            type="button"
            onClick={() => open(h)}
            onContextMenu={(e) =>
              showContextMenu(e, [
                { label: 'Open in new tab', icon: <FilePlus2 />, onSelect: () => open(h) },
                {
                  label: 'Copy',
                  icon: <ClipboardCopy />,
                  onSelect: () => void copyText(h.text, 'Copied query')
                },
                'separator',
                {
                  label: 'Remove from history',
                  icon: <Trash2 />,
                  danger: true,
                  onSelect: () => historyStore.set((list) => list.filter((x) => x.id !== h.id))
                }
              ])
            }
            className="block w-full border-b border-line/60 px-3 py-2 text-left hover:bg-hover/60"
            title={h.text}
          >
            <div className="flex items-center gap-1.5 text-[11px] text-muted">
              {h.ok ? (
                <CheckCircle2 className="size-3 text-ok" />
              ) : (
                <XCircle className="size-3 text-danger" />
              )}
              <span className="truncate">
                {h.connectionName}
                {h.database && <span className="text-faint"> / {h.database}</span>}
              </span>
              <span className="ml-auto shrink-0 text-faint">{timeAgo(h.at)}</span>
            </div>
            <pre
              className={cn(
                'mt-1 line-clamp-3 font-mono text-[11.5px] leading-snug whitespace-pre-wrap',
                h.ok ? 'text-fg' : 'text-muted'
              )}
            >
              {h.text.length > 400 ? h.text.slice(0, 400) : h.text}
            </pre>
            <div className="mt-0.5 text-[10.5px] text-faint">{formatDuration(h.elapsedMs)}</div>
          </button>
        ))}
        {!visible.length && (
          <p className="px-4 py-6 text-center text-xs text-faint">
            {history.length ? 'No matches' : 'Queries you run appear here.'}
          </p>
        )}
      </div>
    </div>
  )
}
