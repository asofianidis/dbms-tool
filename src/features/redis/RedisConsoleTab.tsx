import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Copy, Eraser, KeyRound, Play, RotateCcw, Square } from 'lucide-react'
import { api, type RData, type RedisReply } from '@/lib/api'
import { cn } from '@/lib/cn'
import { connectionLabel } from '@/lib/engines'
import { formatDuration } from '@/lib/format'
import { recordHistory } from '@/lib/history'
import { isProduction } from '@/lib/production'
import {
  commandDoc,
  completeCommand,
  dataText,
  describeRedisDanger,
  formatReply,
  parseCommandLine,
  redisIsWrite,
  scriptCommands,
  type CommandDoc
} from '@/lib/redis'
import { settingsStore } from '@/lib/settings'
import { createPersistentStore, createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import {
  confirm,
  connectionsStore,
  defaultDatabase,
  openRedisKeys,
  runsStore,
  setRunning,
  statusStore,
  updateTab,
  type TabOf
} from '@/lib/workspace'
import { Button, Toolbar, ToolbarDivider } from '@/components/ui'
import { ConnectionPicker, DatabasePicker } from '../query/pickers'
import { NotConnected, refreshKeyCounts } from './common'

interface Entry {
  id: number
  database: string
  command: string
  reply?: RedisReply
  error?: string
  /** Output of a console command such as `help` */
  note?: string
  elapsedMs?: number
}

/** Scrollback per tab; it lives as long as the app does, like a terminal's. */
const scrollbackStore = createStore<Record<string, Entry[]>>({})
/** Commands typed per connection, newest last. */
const commandHistoryStore = createPersistentStore<Record<string, string[]>>(
  'dbms.redis.history.v1',
  {}
)

const MAX_SCROLLBACK = 500
const MAX_HISTORY = 200
/** Longest reply printed in full; the rest is cut with a note. */
const MAX_LINES = 5000

let nextId = 1

function pushEntries(tabId: string, entries: Entry[]): void {
  scrollbackStore.set((s) => ({
    ...s,
    [tabId]: [...(s[tabId] ?? []), ...entries].slice(-MAX_SCROLLBACK)
  }))
}

function remember(connectionId: string, command: string): void {
  commandHistoryStore.set((h) => {
    const list = (h[connectionId] ?? []).filter((c) => c !== command)
    return { ...h, [connectionId]: [...list, command].slice(-MAX_HISTORY) }
  })
}

/** Syntax still to type after `typed` arguments, for the greyed-out hint. */
function remainingHint(doc: CommandDoc, typed: number): string {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of doc.args) {
    if (ch === '[') depth++
    if (ch === ']') depth--
    if (ch === ' ' && depth === 0) {
      if (current) parts.push(current)
      current = ''
    } else current += ch
  }
  if (current) parts.push(current)
  // Variadic arguments (`key [key ...]`) keep showing their repeat
  const rest = parts.slice(typed)
  return rest.length ? rest.join(' ') : parts.filter((p) => p.includes('...')).join(' ')
}

function helpText(name?: string): string {
  if (name) {
    const doc = commandDoc(name)
    if (!doc) return `No help for ${name.toUpperCase()}. Try COMMAND DOCS ${name}.`
    return `${doc.name} ${doc.args}\n  ${doc.summary} (${doc.group})`
  }
  return [
    'Type a command and press Enter. Shift+Enter adds a line; each line runs as its own command.',
    '  ↑ / ↓        previous and next command',
    '  Tab          complete a command name',
    '  help <cmd>   syntax of a command',
    '  clear        clear the console (Ctrl+L)',
    '  select <n>   switch database',
    'Quote arguments with spaces: SET greeting "hello world"'
  ].join('\n')
}

export function RedisConsoleTab({ tab }: { tab: TabOf<'redis'> }): React.JSX.Element {
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const settings = settingsStore.use()
  const running = !!runsStore.use()[tab.id]?.running
  const entries = scrollbackStore.use()[tab.id] ?? []
  const history = commandHistoryStore.use()[tab.connectionId] ?? []
  const connection = connections.find((c) => c.id === tab.connectionId)
  const connected = statuses[tab.connectionId]?.state === 'connected'
  const input = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [browse, setBrowse] = useState<number | null>(null)
  const [picked, setPicked] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  // Keep the newest output in view
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length])

  // Grow the input with its text
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [tab.text])

  useEffect(() => {
    if (connected) input.current?.focus()
  }, [connected])

  const text = tab.text
  const singleLine = !text.includes('\n')
  const tokens = useMemo(() => {
    try {
      return parseCommandLine(text).map((a) => dataText(a))
    } catch {
      return null
    }
  }, [text])
  const typingName = singleLine && !!tokens && tokens.length <= 1 && !/\s$/.test(text)
  const suggestions = typingName && !dismissed ? completeCommand(tokens?.[0] ?? '') : []
  const doc = singleLine && tokens?.length ? commandDoc(tokens[0]) : undefined
  // An argument being typed counts as given; the hint starts after it
  const hint = doc && tokens && !suggestions.length ? remainingHint(doc, tokens.length - 1) : ''

  const setText = (value: string): void => {
    updateTab(tab.id, { text: value })
    setBrowse(null)
    setPicked(0)
    setDismissed(false)
  }

  const run = async (): Promise<void> => {
    if (!connection || running) return
    const script = text
    const commands = scriptCommands(script)
    if (!commands.length) return
    setText('')
    remember(tab.connectionId, script.trim())
    setRunning(tab.id, true)
    let database = tab.database || defaultDatabase(tab.connectionId) || '0'
    let wrote = false
    try {
      for (const { text: line } of commands) {
        const base = { id: nextId++, database, command: line }
        let args: RData[]
        try {
          args = parseCommandLine(line)
        } catch (e) {
          pushEntries(tab.id, [{ ...base, error: errorMessage(e) }])
          break
        }
        if (!args.length) continue
        const words = args.map((a) => dataText(a))
        const name = words[0].toLowerCase()
        if (name === 'clear' && args.length === 1) {
          scrollbackStore.set((s) => ({ ...s, [tab.id]: [] }))
          continue
        }
        if (name === 'help' || name === '?') {
          pushEntries(tab.id, [{ ...base, note: helpText(words[1]) }])
          continue
        }
        if (name === 'select' && args.length === 2) {
          if (!/^\d+$/.test(words[1])) {
            pushEntries(tab.id, [{ ...base, error: 'SELECT takes a database number' }])
            break
          }
          database = words[1]
          updateTab(tab.id, { database })
          pushEntries(tab.id, [{ ...base, reply: { t: 'status', v: 'OK' } }])
          continue
        }
        const request = { op: 'command' as const, database, args }
        // Production connections confirm every write in api.redis; elsewhere only destructive ones
        const danger = describeRedisDanger(request)
        if (danger && !isProduction(connection) && settings.confirmDangerous) {
          const ok = await confirm({
            title: 'Run this destructive command?',
            message: `${danger}.`,
            code: line,
            confirmLabel: 'Run anyway',
            danger: true
          })
          if (!ok) {
            pushEntries(tab.id, [{ ...base, error: 'Not run' }])
            break
          }
        }
        const started = performance.now()
        try {
          const out = await api.redis(tab.connectionId, tab.id, request, {
            timeoutSecs: settings.queryTimeoutSecs || undefined
          })
          if (out.cancelled) {
            pushEntries(tab.id, [{ ...base, error: 'Cancelled', elapsedMs: out.elapsedMs }])
            break
          }
          wrote ||= redisIsWrite(request)
          pushEntries(tab.id, [
            { ...base, reply: out.reply ?? { t: 'nil' }, elapsedMs: out.elapsedMs }
          ])
          recordHistory({
            connectionId: tab.connectionId,
            connectionName: connectionLabel(connection),
            database,
            text: line,
            elapsedMs: out.elapsedMs,
            ok: out.reply?.t !== 'error',
            kind: 'redis'
          })
        } catch (e) {
          pushEntries(tab.id, [
            { ...base, error: errorMessage(e), elapsedMs: Math.round(performance.now() - started) }
          ])
          break
        }
      }
    } finally {
      setRunning(tab.id, false)
      if (wrote) refreshKeyCounts(tab.connectionId)
      input.current?.focus()
    }
  }

  const cancel = (): void => void api.cancel(tab.connectionId, tab.id).catch(() => {})

  const accept = (doc: CommandDoc): void => {
    setText(`${doc.name} `)
    input.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget
    if (suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setPicked((p) => (p + step + suggestions.length) % suggestions.length)
        return
      }
      // Enter takes the suggestion unless what's typed is already a command
      if (e.key === 'Tab' || (e.key === 'Enter' && (picked > 0 || !doc))) {
        e.preventDefault()
        accept(suggestions[picked] ?? suggestions[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void run()
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault()
      scrollbackStore.set((s) => ({ ...s, [tab.id]: [] }))
    } else if (e.key === 'c' && e.ctrlKey && running) {
      e.preventDefault()
      cancel()
    } else if (e.key === 'ArrowUp' && !el.value.slice(0, el.selectionStart).includes('\n')) {
      if (!history.length) return
      e.preventDefault()
      const i = browse === null ? history.length - 1 : Math.max(0, browse - 1)
      updateTab(tab.id, { text: history[i] })
      setBrowse(i)
    } else if (e.key === 'ArrowDown' && !el.value.slice(el.selectionEnd).includes('\n')) {
      if (browse === null) return
      e.preventDefault()
      const i = browse + 1
      if (i >= history.length) {
        updateTab(tab.id, { text: '' })
        setBrowse(null)
      } else {
        updateTab(tab.id, { text: history[i] })
        setBrowse(i)
      }
    }
  }

  const copyAll = async (): Promise<void> => {
    const text = entries.map((e) => `${e.database}> ${e.command}\n${entryText(e)}`).join('\n\n')
    await navigator.clipboard.writeText(text)
    toast('Console output copied')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        {running ? (
          <Button size="sm" variant="danger" onClick={cancel} title="Cancel (Ctrl+C)">
            <Square className="size-3 fill-current" /> Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={!connected || !text.trim()}
            onClick={() => void run()}
            title="Run (Enter)"
          >
            <Play className="size-3.5 fill-current" /> Run
          </Button>
        )}
        <ToolbarDivider />
        <ConnectionPicker
          value={tab.connectionId}
          redis
          onChange={(id) => updateTab(tab.id, { connectionId: id, database: defaultDatabase(id) })}
        />
        <DatabasePicker
          connectionId={tab.connectionId}
          value={tab.database}
          onChange={(database) => updateTab(tab.id, { database })}
        />
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!connected}
          onClick={() => openRedisKeys(tab.connectionId, tab.database || '0')}
          title="Browse the keys in this database"
        >
          <KeyRound className="size-3.5" /> Keys
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Command help"
          onClick={() =>
            pushEntries(tab.id, [
              { id: nextId++, database: tab.database, command: 'help', note: helpText() }
            ])
          }
        >
          <BookOpen className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Copy output"
          disabled={!entries.length}
          onClick={() => void copyAll()}
        >
          <Copy className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Clear (Ctrl+L)"
          disabled={!entries.length}
          onClick={() => scrollbackStore.set((s) => ({ ...s, [tab.id]: [] }))}
        >
          <Eraser className="size-3.5" />
        </Button>
      </Toolbar>
      {!connected ? (
        <NotConnected connection={connection} />
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col bg-canvas font-mono"
          style={{ fontSize: settings.editorFontSize - 1 }}
          onMouseUp={() => {
            // Clicking the output focuses the prompt, unless text was selected to copy
            if (!window.getSelection()?.toString()) input.current?.focus()
          }}
        >
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {!entries.length && (
              <div className="pb-2 whitespace-pre-wrap text-faint">
                {`Connected to ${connection ? connectionLabel(connection) : 'Redis'}. Type help for tips.`}
              </div>
            )}
            {entries.map((entry) => (
              <EntryView
                key={entry.id}
                entry={entry}
                onRerun={() => {
                  setText(entry.command)
                  input.current?.focus()
                }}
              />
            ))}
          </div>
          <div className="relative shrink-0 border-t border-line bg-panel/60 px-3 py-2">
            {suggestions.length > 0 && (
              <div className="absolute bottom-full left-3 mb-1 w-[min(36rem,calc(100%-1.5rem))] overflow-hidden rounded-md border border-line-strong bg-panel py-1 font-sans shadow-xl">
                {suggestions.map((s, i) => (
                  <button
                    key={s.name}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      accept(s)
                    }}
                    className={cn(
                      'flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-xs',
                      i === picked ? 'bg-sel text-bright' : 'text-fg hover:bg-hover'
                    )}
                  >
                    <span className="font-mono font-semibold text-redis">{s.name}</span>
                    <span className="truncate font-mono text-[11px] text-muted">{s.args}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-faint">{s.summary}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-start gap-2">
              <span className="shrink-0 py-px leading-5 text-redis select-none">
                {tab.database || '0'}&gt;
              </span>
              <div className="relative min-w-0 flex-1">
                {/* Greyed-out syntax for the rest of the command, like redis-cli's hints */}
                {hint && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 overflow-hidden leading-5 whitespace-pre text-faint"
                  >
                    <span className="invisible">{text}</span>
                    {/\s$/.test(text) ? '' : ' '}
                    {hint}
                  </div>
                )}
                <textarea
                  ref={input}
                  rows={1}
                  value={text}
                  spellCheck={false}
                  autoComplete="off"
                  readOnly={running}
                  placeholder={running ? 'Running… (Ctrl+C cancels)' : 'GET key'}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onKeyDown}
                  className="relative block w-full resize-none bg-transparent leading-5 text-bright outline-none placeholder:text-faint read-only:opacity-60"
                />
              </div>
            </div>
            {doc && !suggestions.length && (
              <div className="mt-1 truncate pl-6 font-sans text-[11px] text-faint">
                <span className="font-mono text-muted">{doc.name}</span> · {doc.summary}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function entryText(entry: Entry): string {
  if (entry.note) return entry.note
  if (entry.error) return `(error) ${entry.error}`
  if (!entry.reply) return ''
  return formatReply(entry.reply)
}

function EntryView({ entry, onRerun }: { entry: Entry; onRerun: () => void }): React.JSX.Element {
  const [full, setFull] = useState(false)
  const text = useMemo(() => entryText(entry), [entry])
  const lines = useMemo(() => text.split('\n'), [text])
  const cut = !full && lines.length > MAX_LINES
  const tone = entry.error
    ? 'text-danger'
    : entry.note
      ? 'text-muted'
      : entry.reply?.t === 'error'
        ? 'text-danger'
        : entry.reply?.t === 'int' || entry.reply?.t === 'double'
          ? 'text-syn-number'
          : entry.reply?.t === 'nil'
            ? 'text-faint'
            : entry.reply?.t === 'status'
              ? 'text-ok'
              : 'text-fg'
  return (
    <div className="group py-1">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          <span className="text-redis select-none">{entry.database}&gt; </span>
          <span className="text-bright">{entry.command}</span>
        </span>
        {entry.elapsedMs !== undefined && (
          <span className="shrink-0 font-sans text-[10.5px] text-faint tabular-nums">
            {formatDuration(entry.elapsedMs)}
          </span>
        )}
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button size="icon-sm" variant="ghost" title="Edit and run again" onClick={onRerun}>
            <RotateCcw className="size-3" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Copy reply"
            onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copied'))}
          >
            <Copy className="size-3" />
          </Button>
        </div>
      </div>
      {text && (
        <pre className={cn('leading-5 break-all whitespace-pre-wrap select-text', tone)}>
          {cut ? lines.slice(0, MAX_LINES).join('\n') : text}
        </pre>
      )}
      {cut && (
        <button
          type="button"
          className="font-sans text-[11px] text-accent hover:underline"
          onClick={() => setFull(true)}
        >
          Show all {lines.length.toLocaleString()} lines
        </button>
      )}
    </div>
  )
}
