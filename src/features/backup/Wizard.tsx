import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listen } from '@tauri-apps/api/event'
import { documentDir } from '@tauri-apps/api/path'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FolderOpen,
  FolderSearch,
  Loader2,
  Search,
  Square,
  Wrench,
  XCircle
} from 'lucide-react'
import {
  api,
  type BackupJob,
  type BackupProgress,
  type BackupTool,
  type BackupToolKind,
  type Engine
} from '@/lib/api'
import { progressSql } from '@/lib/backup'
import { cn } from '@/lib/cn'
import { formatBytes, formatDuration } from '@/lib/format'
import { createPersistentStore } from '@/lib/store'
import { errorMessage } from '@/lib/toast'
import { setRunning } from '@/lib/workspace'
import { Badge, Button, Input, Spinner } from '@/components/ui'

/** Where to look for pg_dump and friends before PATH. */
export const backupPrefsStore = createPersistentStore<{ toolsDir: string }>('dbms.backup.v1', {
  toolsDir: ''
})

/* ---------- Layout ---------- */

export function WizardLayout({
  icon,
  title,
  subtitle,
  steps,
  step,
  reached,
  onStep,
  children,
  footer
}: {
  icon: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  steps: string[]
  step: number
  /** Furthest step visited; earlier ones can be revisited from the header */
  reached: number
  onStep: (step: number) => void
  children: ReactNode
  footer?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="shrink-0 border-b border-line bg-panel">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent [&>svg]:size-4.5">
              {icon}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-[15px] font-semibold text-bright">{title}</h1>
              {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
            </div>
          </div>
          {steps.length > 0 && (
            <ol className="flex items-center gap-1">
              {steps.map((label, i) => {
                const done = i < step
                const current = i === step
                const reachable = i <= reached && !current
                return (
                  <li key={label} className="flex items-center gap-1">
                    {i > 0 && (
                      <span
                        className={cn('h-px w-4', i <= reached ? 'bg-accent/40' : 'bg-line-strong')}
                      />
                    )}
                    <button
                      type="button"
                      disabled={!reachable}
                      onClick={() => onStep(i)}
                      className={cn(
                        'flex h-7 items-center gap-1.5 rounded-full pr-2.5 pl-1 text-xs transition-colors',
                        current && 'bg-accent/10 text-bright',
                        !current && reachable && 'text-fg hover:bg-hover',
                        !current && !reachable && 'text-faint'
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-5 items-center justify-center rounded-full text-[10px] font-semibold',
                          current && 'bg-accent text-accent-fg',
                          done && !current && 'bg-accent/15 text-accent',
                          !done && !current && 'ring-1 ring-line-strong ring-inset'
                        )}
                      >
                        {done ? <Check className="size-3" /> : i + 1}
                      </span>
                      {label}
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">{children}</div>
      </div>
      {footer && (
        <footer className="shrink-0 border-t border-line bg-panel">
          <div className="mx-auto flex max-w-3xl items-center gap-2 px-6 py-3">{footer}</div>
        </footer>
      )}
    </div>
  )
}

export function useSteps(): {
  step: number
  reached: number
  go: (step: number) => void
  reset: () => void
} {
  const [step, setStep] = useState(0)
  const [reached, setReached] = useState(0)
  return {
    step,
    reached,
    go: (next) => {
      setStep(next)
      setReached((r) => Math.max(r, next))
    },
    reset: () => {
      setStep(0)
      setReached(0)
    }
  }
}

/** Back / Next / Start buttons, with the reason Next is blocked. */
export function StepFooter({
  step,
  last,
  problem,
  onBack,
  onNext,
  startLabel,
  startIcon,
  danger,
  extra
}: {
  step: number
  last: number
  problem: string | null
  onBack: () => void
  onNext: () => void
  startLabel: string
  startIcon: ReactNode
  danger?: boolean
  extra?: ReactNode
}): React.JSX.Element {
  return (
    <>
      {problem ? (
        <span className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <AlertTriangle className="size-3.5 shrink-0 text-warn" />
          <span className="truncate">{problem}</span>
        </span>
      ) : (
        <span className="mr-auto" />
      )}
      {extra}
      <Button variant="secondary" disabled={step === 0} onClick={onBack}>
        Back
      </Button>
      {step < last ? (
        <Button variant="primary" disabled={!!problem} onClick={onNext}>
          Next
        </Button>
      ) : (
        <Button variant={danger ? 'danger' : 'primary'} disabled={!!problem} onClick={onNext}>
          {startIcon}
          {startLabel}
        </Button>
      )}
    </>
  )
}

export function Section({
  title,
  description,
  children,
  aside
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  aside?: ReactNode
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-bright">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** Radio cards for choices that need a sentence of explanation. */
export function Choice<T extends string>({
  value,
  options,
  onChange,
  columns = 2
}: {
  value: T
  options: {
    value: T
    label: string
    description?: ReactNode
    disabled?: boolean
    badge?: string
  }[]
  onChange: (value: T) => void
  columns?: 1 | 2 | 3
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      className={cn(
        'grid gap-2',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-3'
      )}
    >
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-left ring-1 transition-colors ring-inset disabled:opacity-40',
              selected ? 'bg-accent/8 ring-accent/50' : 'ring-line-strong hover:bg-hover/60'
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset',
                selected ? 'ring-accent' : 'ring-line-strong'
              )}
            >
              {selected && <span className="size-1.5 rounded-full bg-accent" />}
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-[13px] text-bright">
                {o.label}
                {o.badge && <Badge tone="accent">{o.badge}</Badge>}
              </span>
              {o.description && (
                <span className="mt-0.5 block text-xs text-muted">{o.description}</span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function Callout({
  tone = 'info',
  children
}: {
  tone?: 'info' | 'warning' | 'danger'
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
        tone === 'info' && 'border-info/25 bg-info/5 text-fg',
        tone === 'warning' && 'border-warn/30 bg-warn/5 text-fg',
        tone === 'danger' && 'border-danger/30 bg-danger/5 text-fg'
      )}
    >
      <AlertTriangle
        className={cn(
          'mt-px size-3.5 shrink-0',
          tone === 'info' && 'text-info',
          tone === 'warning' && 'text-warn',
          tone === 'danger' && 'text-danger'
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  )
}

/** Label / value rows for the review step. */
export function Summary({ rows }: { rows: [string, ReactNode][] }): React.JSX.Element {
  return (
    <dl className="divide-y divide-line rounded-lg border border-line bg-panel">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-4 px-3 py-2 text-[13px]">
          <dt className="w-36 shrink-0 text-muted">{label}</dt>
          <dd className="min-w-0 flex-1 break-words text-bright select-text">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function CommandPreview({
  text,
  loading
}: {
  text: string | null
  loading?: boolean
}): React.JSX.Element {
  return (
    <pre className="max-h-48 overflow-auto rounded-lg border border-line bg-panel px-3 py-2.5 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-fg select-text">
      {loading ? <Spinner /> : text}
    </pre>
  )
}

/* ---------- Choosing objects ---------- */

export interface PickItem {
  key: string
  label: string
  group?: string
  detail?: string
}

/** Filterable checklist; groups (schemas, databases) toggle together. */
export function Checklist({
  items,
  selected,
  onChange,
  empty = 'Nothing to choose from'
}: {
  items: PickItem[]
  selected: string[]
  onChange: (keys: string[]) => void
  empty?: string
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const visible = useMemo(() => {
    const f = filter.toLowerCase()
    return f ? items.filter((i) => `${i.group ?? ''}.${i.label}`.toLowerCase().includes(f)) : items
  }, [items, filter])
  const chosen = new Set(selected)
  const groups = useMemo(() => {
    const map = new Map<string, PickItem[]>()
    for (const item of visible) {
      const key = item.group ?? ''
      map.set(key, [...(map.get(key) ?? []), item])
    }
    return [...map.entries()]
  }, [visible])
  const set = (keys: string[], on: boolean): void => {
    const next = new Set(selected)
    for (const k of keys) {
      if (on) next.add(k)
      else next.delete(k)
    }
    // Keep the list's order so jobs are stable
    onChange(items.filter((i) => next.has(i.key)).map((i) => i.key))
  }
  const box = (on: boolean, partial = false): React.JSX.Element => (
    <span
      className={cn(
        'flex size-3.5 shrink-0 items-center justify-center rounded-[3px] ring-1 ring-inset',
        on || partial ? 'bg-accent text-accent-fg ring-accent' : 'ring-line-strong'
      )}
    >
      {on ? (
        <Check className="size-2.5" />
      ) : partial ? (
        <span className="h-0.5 w-2 bg-accent-fg" />
      ) : null}
    </span>
  )
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <Search className="size-3.5 shrink-0 text-faint" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter"
          spellCheck={false}
          className="h-6 min-w-0 flex-1 bg-transparent text-[13px] text-bright outline-none placeholder:text-faint"
        />
        <span className="text-[11px] text-faint tabular-nums">
          {selected.length} of {items.length}
        </span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            set(
              visible.map((i) => i.key),
              true
            )
          }
        >
          All
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            set(
              visible.map((i) => i.key),
              false
            )
          }
        >
          None
        </Button>
      </div>
      <div className="max-h-72 overflow-y-auto py-1">
        {!visible.length && <p className="px-3 py-2 text-xs text-faint italic">{empty}</p>}
        {groups.map(([group, members]) => {
          const on = members.filter((m) => chosen.has(m.key)).length
          return (
            <div key={group}>
              {group && (
                <button
                  type="button"
                  onClick={() =>
                    set(
                      members.map((m) => m.key),
                      on < members.length
                    )
                  }
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] font-medium tracking-wide text-muted uppercase hover:bg-hover/60"
                >
                  {box(on === members.length, on > 0)}
                  {group}
                </button>
              )}
              {members.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => set([item.key], !chosen.has(item.key))}
                  className={cn(
                    'flex w-full items-center gap-2 py-1 pr-3 text-left text-[13px] hover:bg-hover/60',
                    group ? 'pl-8' : 'pl-3'
                  )}
                >
                  {box(chosen.has(item.key))}
                  <span className="truncate font-mono text-xs text-bright">{item.label}</span>
                  {item.detail && (
                    <span className="ml-auto shrink-0 text-[11px] text-faint">{item.detail}</span>
                  )}
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------- Files ---------- */

export async function defaultFolder(): Promise<string> {
  try {
    return await documentDir()
  } catch {
    return ''
  }
}

/** Path input with a Browse button for a file to write, or a file / folder to read. */
export function PathField({
  value,
  onChange,
  onPick = onChange,
  mode,
  placeholder,
  filters
}: {
  value: string
  /** Typed edits */
  onChange: (path: string) => void
  /** A path chosen in a dialog; defaults to `onChange` */
  onPick?: (path: string) => void
  /** save: a file to create; folder: a folder; file: an existing file; open: an existing file or folder */
  mode: 'save' | 'folder' | 'file' | 'open'
  placeholder?: string
  filters?: { name: string; extensions: string[] }[]
}): React.JSX.Element {
  const browseFile = async (): Promise<void> => {
    const picked =
      mode === 'save'
        ? await saveDialog({ defaultPath: value || undefined, filters })
        : await openDialog({ multiple: false, defaultPath: value || undefined, filters })
    if (typeof picked === 'string') onPick(picked)
  }
  const browseFolder = async (): Promise<void> => {
    const picked = await openDialog({ directory: true, defaultPath: value || undefined })
    if (typeof picked === 'string') onPick(picked)
  }
  return (
    <div className="flex gap-2">
      <Input
        mono
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1"
      />
      {mode !== 'folder' && (
        <Button variant="secondary" onClick={() => void browseFile()}>
          <FolderOpen className="size-3.5" /> {mode === 'open' ? 'File…' : 'Browse…'}
        </Button>
      )}
      {(mode === 'folder' || mode === 'open') && (
        <Button variant="secondary" onClick={() => void browseFolder()}>
          <FolderSearch className="size-3.5" /> Folder…
        </Button>
      )}
    </div>
  )
}

/* ---------- Tools ---------- */

export function useBackupTools(engine: Engine): {
  tools: BackupTool[] | undefined
  loading: boolean
  toolsDir: string
} {
  const { toolsDir } = backupPrefsStore.use()
  const q = useQuery({
    queryKey: ['backupTools', engine, toolsDir],
    queryFn: () => api.backupTools(engine, toolsDir),
    staleTime: 60_000
  })
  return { tools: q.data, loading: q.isPending, toolsDir }
}

const INSTALL_HINTS: Record<string, string> = {
  pg: 'Install the PostgreSQL client tools (the PostgreSQL installer, "brew install libpq" or the postgresql-client package).',
  my: 'Install the MySQL or MariaDB client (MySQL Installer / Workbench, "brew install mysql-client" or the mysql-client package).',
  mo: 'Install the MongoDB Database Tools (mongodb.com/try/download/database-tools or "brew install mongodb-database-tools").'
}

/** Which tool will run, or how to get it. */
export function ToolStatus({
  kind,
  tools,
  loading,
  problem,
  builtin
}: {
  kind: BackupToolKind
  tools: BackupTool[] | undefined
  loading: boolean
  /** e.g. pg_dump older than the server */
  problem?: string | null
  /** The app's built-in engine runs the job when the tool is missing */
  builtin?: boolean
}): React.JSX.Element {
  const { toolsDir } = backupPrefsStore.use()
  const tool = tools?.find((t) => t.kind === kind)
  const chooseFolder = async (): Promise<void> => {
    const picked = await openDialog({ directory: true, defaultPath: toolsDir || undefined })
    if (typeof picked === 'string') backupPrefsStore.set({ toolsDir: picked })
  }
  const missing = !loading && !tool?.path && !builtin
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3 py-2.5',
        missing || problem ? 'border-warn/30 bg-warn/5' : 'border-line bg-panel'
      )}
    >
      <Wrench
        className={cn('mt-0.5 size-3.5 shrink-0', missing || problem ? 'text-warn' : 'text-muted')}
      />
      <div className="min-w-0 flex-1 text-xs">
        {loading ? (
          <span className="text-muted">Looking for {kind}…</span>
        ) : tool?.path ? (
          <>
            <span className="text-bright">{tool.version ?? kind}</span>
            <span className="block truncate font-mono text-[11px] text-faint" title={tool.path}>
              {tool.path}
            </span>
            {problem && <span className="mt-1 block text-warn">{problem}</span>}
          </>
        ) : builtin ? (
          <>
            <span className="text-bright">Built-in engine</span>
            <span className="block text-muted">
              {kind} isn&apos;t installed, so dbms-tool does this itself, reading and writing the
              same format {kind} uses.
            </span>
          </>
        ) : (
          <>
            <span className="text-bright">{kind} wasn&apos;t found</span>
            <span className="block text-muted">{INSTALL_HINTS[kind.slice(0, 2)] ?? ''}</span>
          </>
        )}
      </div>
      <div className="flex shrink-0 gap-1">
        {toolsDir && (
          <Button size="xs" variant="ghost" onClick={() => backupPrefsStore.set({ toolsDir: '' })}>
            Reset
          </Button>
        )}
        <Button size="xs" variant="secondary" onClick={() => void chooseFolder()}>
          {tool?.path ? 'Use another…' : 'Choose folder…'}
        </Button>
      </div>
    </div>
  )
}

/* ---------- Running ---------- */

const MAX_LINES = 5000

export interface JobState {
  status: 'running' | 'done' | 'failed' | 'cancelled'
  lines: string[]
  /** 0–100 when the job can tell */
  percent: number | null
  startedAt: number
  elapsedMs: number | null
  error: string | null
  size: number | null
  /** Errors a run reported while still finishing */
  errors: number
}

const startState = (): JobState => ({
  status: 'running',
  lines: [],
  percent: null,
  startedAt: Date.now(),
  elapsedMs: null,
  error: null,
  size: null,
  errors: 0
})

const appendLines = (lines: string[], more: string[]): string[] => {
  const next = lines.concat(more)
  return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next
}

/**
 * Runs a client-tool job, collecting its streamed output. The job is cancelled
 * if the tab closes, and marks the tab busy so updates don't restart mid-backup.
 */
export function useToolJob(tabId: string): {
  job: JobState | null
  start: (connectionId: string, job: BackupJob, before?: () => Promise<void>) => Promise<boolean>
  cancel: () => void
  clear: () => void
} {
  const [job, setJob] = useState<JobState | null>(null)
  const current = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (current.current) void api.backupCancel(current.current)
      setRunning(tabId, false)
    },
    [tabId]
  )
  const start = async (
    connectionId: string,
    spec: BackupJob,
    before?: () => Promise<void>
  ): Promise<boolean> => {
    const id = crypto.randomUUID()
    current.current = id
    setJob(startState())
    setRunning(tabId, true)
    const unlisten = await listen<BackupProgress>('backup-progress', (e) => {
      const p = e.payload
      if (p.job !== id) return
      setJob(
        (s) =>
          s && {
            ...s,
            lines: p.lines.length ? appendLines(s.lines, p.lines) : s.lines,
            percent: p.total ? Math.min(100, (100 * (p.bytes ?? 0)) / p.total) : s.percent
          }
      )
    })
    try {
      await before?.()
      const outcome = await api.backupRun(connectionId, id, spec, backupPrefsStore.get().toolsDir)
      setJob(
        (s) =>
          s && {
            ...s,
            status: outcome.cancelled ? 'cancelled' : 'done',
            percent: outcome.cancelled ? s.percent : 100,
            elapsedMs: outcome.elapsedMs,
            size: outcome.size,
            errors: outcome.errors
          }
      )
      return !outcome.cancelled
    } catch (e) {
      setJob(
        (s) =>
          s && {
            ...s,
            status: 'failed',
            error: errorMessage(e),
            elapsedMs: Date.now() - s.startedAt
          }
      )
      return false
    } finally {
      unlisten()
      current.current = null
      setRunning(tabId, false)
    }
  }
  return {
    job,
    start,
    cancel: () => {
      if (current.current) void api.backupCancel(current.current)
    },
    clear: () => setJob(null)
  }
}

/**
 * Runs a SQL Server BACKUP or RESTORE script on its own session, polling
 * sys.dm_exec_requests for percent complete from the metadata session.
 */
export function useSqlJob(tabId: string): {
  job: JobState | null
  start: (connectionId: string, script: string) => Promise<boolean>
  cancel: () => void
  clear: () => void
} {
  const [job, setJob] = useState<JobState | null>(null)
  const session = `backup-${tabId}`
  const running = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (running.current) void api.cancel(running.current, session)
      setRunning(tabId, false)
    },
    [tabId, session]
  )
  const start = async (connectionId: string, script: string): Promise<boolean> => {
    running.current = connectionId
    setJob(startState())
    setRunning(tabId, true)
    let timer: ReturnType<typeof setInterval> | undefined
    try {
      // Restores need the database to themselves, so work from master
      const spid = await api.execute(connectionId, session, 'master', 'SELECT @@SPID')
      const id = Number(spid.results[0]?.rows[0]?.[0])
      if (Number.isFinite(id)) {
        timer = setInterval(() => {
          void api
            .execute(connectionId, '__meta', 'master', progressSql(id))
            .then((out) => {
              const value = Number(out.results[0]?.rows[0]?.[0])
              if (Number.isFinite(value) && value > 0) setJob((s) => s && { ...s, percent: value })
            })
            .catch(() => undefined)
        }, 1000)
      }
      const out = await api.execute(connectionId, session, 'master', script)
      const lines = out.messages.filter((m) => m.level !== 'rows').map((m) => m.text)
      const failed = out.error?.message ?? null
      setJob(
        (s) =>
          s && {
            ...s,
            lines: appendLines(s.lines, lines),
            status: out.cancelled ? 'cancelled' : failed ? 'failed' : 'done',
            error: failed,
            percent: failed || out.cancelled ? s.percent : 100,
            elapsedMs: out.elapsedMs
          }
      )
      return !failed && !out.cancelled
    } catch (e) {
      setJob(
        (s) =>
          s && {
            ...s,
            status: 'failed',
            error: errorMessage(e),
            elapsedMs: Date.now() - s.startedAt
          }
      )
      return false
    } finally {
      clearInterval(timer)
      running.current = null
      setRunning(tabId, false)
      void api.closeSession(connectionId, session).catch(() => undefined)
    }
  }
  return {
    job,
    start,
    cancel: () => {
      if (running.current) void api.cancel(running.current, session)
    },
    clear: () => setJob(null)
  }
}

function Elapsed({ job }: { job: JobState }): React.JSX.Element {
  const [, tick] = useState(0)
  useEffect(() => {
    if (job.status !== 'running') return
    const timer = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [job.status])
  return <>{formatDuration(job.elapsedMs ?? Date.now() - job.startedAt)}</>
}

/** Progress, live output and the outcome of a job. */
export function JobPanel({
  job,
  noun,
  onCancel,
  output,
  actions
}: {
  job: JobState
  /** "Backup" / "Restore" */
  noun: string
  onCancel: () => void
  /** Local file or folder written, offered as "Show in folder" */
  output?: string
  actions?: ReactNode
}): React.JSX.Element {
  const log = useRef<HTMLPreElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = log.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [job.lines])
  const running = job.status === 'running'
  const warned = job.status === 'done' && job.errors > 0
  const headline =
    job.status === 'running'
      ? `${noun} running…`
      : job.status === 'done'
        ? warned
          ? `${noun} finished with ${job.errors} error${job.errors === 1 ? '' : 's'}`
          : `${noun} complete`
        : job.status === 'cancelled'
          ? `${noun} cancelled`
          : `${noun} failed`
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-panel px-4 py-3.5">
        <div className="flex items-center gap-3">
          {running ? (
            <Loader2 className="size-5 shrink-0 animate-spin text-accent" />
          ) : job.status === 'done' && !warned ? (
            <CheckCircle2 className="size-5 shrink-0 text-ok" />
          ) : job.status === 'failed' ? (
            <XCircle className="size-5 shrink-0 text-danger" />
          ) : (
            <AlertTriangle className="size-5 shrink-0 text-warn" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-bright">{headline}</p>
            <p className="text-xs text-muted tabular-nums">
              <Elapsed job={job} />
              {job.percent !== null && running && ` · ${Math.floor(job.percent)}%`}
              {job.size !== null && ` · ${formatBytes(job.size)}`}
            </p>
          </div>
          {running ? (
            <Button variant="secondary" onClick={onCancel}>
              <Square className="size-3" /> Cancel
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              {job.status === 'done' && output && (
                <Button
                  variant="secondary"
                  onClick={() => void revealItemInDir(output).catch(() => undefined)}
                >
                  <FolderOpen className="size-3.5" /> Show in folder
                </Button>
              )}
              {actions}
            </div>
          )}
        </div>
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-hover">
          {running && job.percent === null ? (
            <div className="h-full w-2/5 animate-indeterminate rounded-full bg-accent" />
          ) : (
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-500',
                job.status === 'failed'
                  ? 'bg-danger'
                  : warned || job.status === 'cancelled'
                    ? 'bg-warn'
                    : 'bg-accent'
              )}
              style={{ width: `${job.percent ?? (running ? 0 : 100)}%` }}
            />
          )}
        </div>
        {job.error && (
          <p className="mt-3 text-xs whitespace-pre-wrap text-danger select-text">{job.error}</p>
        )}
      </div>
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-muted">Output</p>
        <pre
          ref={log}
          onScroll={(e) => {
            const el = e.currentTarget
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
          className="h-80 overflow-auto rounded-lg border border-line bg-panel px-3 py-2 font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-fg select-text"
        >
          {job.lines.length
            ? job.lines.map((line, i) => (
                <div
                  key={i}
                  className={cn(/\bERROR\b|error:|Failed:/i.test(line) && 'text-danger')}
                >
                  {line}
                </div>
              ))
            : running
              ? 'Waiting for output…'
              : 'No output'}
        </pre>
      </div>
    </div>
  )
}
