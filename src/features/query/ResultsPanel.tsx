import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ClipboardCopy,
  Download,
  MessageSquareText,
  Search,
  TableProperties,
  X
} from 'lucide-react'
import type { ExecOutput, ResultSet } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { Dialect } from '@/lib/engines'
import { copyText, exportRows, serialize, type ExportFormat } from '@/lib/export'
import { formatDuration, plural } from '@/lib/format'
import { ResultGrid } from '@/components/grid/ResultGrid'
import { showMenuAt } from '@/components/ContextMenu'
import { Button, EmptyState, ProgressBar } from '@/components/ui'
import { selectionSummaryStore } from '@/components/shell/StatusBar'

export interface RunResult {
  output?: ExecOutput
  /** Failure before the server answered (not connected, blocked by read-only, …) */
  error?: string
  /** Offset of the executed text within the editor, for error positions */
  offset: number
  sql: string
}

export function exportMenu(
  anchor: HTMLElement,
  set: Pick<ResultSet, 'columns' | 'rows'>,
  name: string,
  dialect?: Dialect,
  table?: string
): void {
  const run = (format: ExportFormat) => () =>
    void exportRows(format, set.columns, set.rows, name, { dialect, table })
  const copy = (format: ExportFormat, label: string) => () =>
    void copyText(
      serialize(format, set.columns, set.rows, { dialect, table }),
      `Copied ${set.rows.length} rows as ${label}`
    )
  showMenuAt(anchor, [
    { heading: 'Save as' },
    { label: 'CSV', icon: <Download />, onSelect: run('csv') },
    { label: 'JSON', icon: <Download />, onSelect: run('json') },
    { label: 'TSV', icon: <Download />, onSelect: run('tsv') },
    { label: 'Markdown', icon: <Download />, onSelect: run('markdown') },
    { label: 'SQL INSERT statements', icon: <Download />, onSelect: run('sql') },
    'separator',
    { heading: 'Copy all rows as' },
    { label: 'TSV (spreadsheet)', icon: <ClipboardCopy />, onSelect: copy('tsv', 'TSV') },
    { label: 'JSON', icon: <ClipboardCopy />, onSelect: copy('json', 'JSON') },
    { label: 'Markdown', icon: <ClipboardCopy />, onSelect: copy('markdown', 'Markdown') },
    { label: 'SQL INSERT', icon: <ClipboardCopy />, onSelect: copy('sql', 'SQL') }
  ])
}

export function ResultsPanel({
  result,
  running,
  startedAt,
  dialect,
  onJumpToError,
  emptyHint
}: {
  result?: RunResult
  running: boolean
  startedAt?: number
  dialect: Dialect
  onJumpToError?: () => void
  emptyHint?: React.ReactNode
}): React.JSX.Element {
  const output = result?.output
  const sets = output?.results ?? []
  const [active, setActive] = useState<number | 'messages'>(0)
  const [filter, setFilter] = useState('')
  const [showFilter, setShowFilter] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  // Jump to messages when a run produced no grids or failed outright
  useEffect(() => {
    if (!result) return
    setActive(sets.length && !(output?.error && !sets.length) ? 0 : 'messages')
    setFilter('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  useEffect(() => {
    if (!running || !startedAt) return
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 100)
    return () => clearInterval(timer)
  }, [running, startedAt])

  useEffect(() => () => selectionSummaryStore.set(null), [])

  const set = typeof active === 'number' ? sets[active] : undefined
  const errorCount =
    output?.messages.filter((m) => m.level === 'error').length ?? (result?.error ? 1 : 0)

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-panel">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [&::-webkit-scrollbar]:h-0">
          {sets.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActive(i)}
              className={cn(
                'relative flex shrink-0 items-center gap-1.5 px-3 text-[12px]',
                active === i ? 'text-bright' : 'text-muted hover:text-fg'
              )}
            >
              {active === i && (
                <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />
              )}
              <TableProperties className="size-3.5" />
              Result {sets.length > 1 ? i + 1 : ''}
              <span className="text-faint tabular-nums">{s.rowCount.toLocaleString()}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setActive('messages')}
            className={cn(
              'relative flex shrink-0 items-center gap-1.5 px-3 text-[12px]',
              active === 'messages' ? 'text-bright' : 'text-muted hover:text-fg',
              errorCount > 0 && 'text-danger'
            )}
          >
            {active === 'messages' && (
              <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />
            )}
            {errorCount > 0 ? (
              <AlertTriangle className="size-3.5" />
            ) : (
              <MessageSquareText className="size-3.5" />
            )}
            Messages
            {(output?.messages.length ?? 0) > 0 && (
              <span className="text-faint tabular-nums">{output?.messages.length}</span>
            )}
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1 pr-1.5 text-[11px] text-muted">
          {running ? (
            <span className="px-2 text-accent tabular-nums">{formatDuration(elapsed)}</span>
          ) : (
            output && (
              <span className="px-2 tabular-nums">
                {output.cancelled ? 'cancelled · ' : ''}
                {formatDuration(output.elapsedMs)}
              </span>
            )
          )}
          {set && (
            <>
              {set.truncated && (
                <span
                  className="flex items-center gap-1 px-1 text-warn"
                  title="Raise the row limit in Settings to fetch more"
                >
                  <AlertTriangle className="size-3" /> first {plural(set.rows.length, 'row')}
                </span>
              )}
              {showFilter ? (
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-faint" />
                  <input
                    autoFocus
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setFilter('')
                        setShowFilter(false)
                      }
                    }}
                    placeholder="Filter rows"
                    className="h-6 w-44 rounded border border-line-strong bg-canvas pr-6 pl-6 text-[11.5px] text-bright placeholder:text-faint focus:border-accent/50 focus:outline-none"
                  />
                  <button
                    className="absolute top-1/2 right-1 -translate-y-1/2 text-faint hover:text-bright"
                    onClick={() => {
                      setFilter('')
                      setShowFilter(false)
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ) : (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Filter rows (Ctrl+F in grid)"
                  onClick={() => setShowFilter(true)}
                >
                  <Search className="size-3.5" />
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                onClick={(e) =>
                  exportMenu(
                    e.currentTarget,
                    set,
                    `result-${typeof active === 'number' ? active + 1 : 1}`,
                    dialect
                  )
                }
              >
                <Download className="size-3.5" /> Export <ChevronDown className="size-3" />
              </Button>
            </>
          )}
        </div>
      </div>
      <ProgressBar active={running} />
      <div
        className="min-h-0 flex-1"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && set) {
            e.preventDefault()
            setShowFilter(true)
          }
        }}
      >
        {active === 'messages' ? (
          <Messages result={result} onJumpToError={onJumpToError} />
        ) : set ? (
          set.columns.length ? (
            <ResultGrid
              columns={set.columns}
              rows={set.rows}
              filter={filter}
              dialect={dialect}
              onSelectionSummary={selectionSummaryStore.set}
            />
          ) : (
            <EmptyState title="No columns" />
          )
        ) : running ? (
          <EmptyState title="Running…" />
        ) : (
          (emptyHint ?? <EmptyState title="Run a query to see results" />)
        )}
      </div>
    </div>
  )
}

function Messages({
  result,
  onJumpToError
}: {
  result?: RunResult
  onJumpToError?: () => void
}): React.JSX.Element {
  if (!result) return <EmptyState title="No messages yet" />
  const messages = result.output?.messages ?? []
  return (
    <div className="h-full overflow-auto p-3 font-mono text-[12px] leading-relaxed select-text">
      {result.error && <p className="whitespace-pre-wrap text-danger">{result.error}</p>}
      {messages.map((m, i) => (
        <div
          key={i}
          className={cn(
            'flex gap-3 border-b border-line/50 py-1 last:border-0',
            m.level === 'error' && 'text-danger',
            m.level === 'warning' && 'text-warn',
            (m.level === 'notice' || m.level === 'info') && 'text-info',
            m.level === 'rows' && 'text-fg'
          )}
        >
          <span className="w-14 shrink-0 text-right text-faint tabular-nums">
            {formatDuration(m.atMs)}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{m.text}</span>
        </div>
      ))}
      {result.output?.error &&
        onJumpToError &&
        (result.output.error.position != null || result.output.error.line != null) && (
          <button className="mt-2 font-sans text-xs text-accent underline" onClick={onJumpToError}>
            Show error in editor
          </button>
        )}
      {result.output && !result.output.error && !result.error && (
        <p className="mt-2 text-ok">
          Completed in {formatDuration(result.output.elapsedMs)}
          {result.output.cancelled ? ' (cancelled)' : ''}
        </p>
      )}
    </div>
  )
}
