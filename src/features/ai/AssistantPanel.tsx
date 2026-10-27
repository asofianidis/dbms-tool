import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowUp,
  BarChart3,
  ExternalLink,
  LayoutDashboard,
  ChevronDown,
  Bug,
  Check,
  ClipboardCopy,
  Database,
  Gauge,
  Lightbulb,
  ListPlus,
  Replace,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  X
} from 'lucide-react'
import { api, type AiMessage, type AiProvider } from '@/lib/api'
import {
  AI_PROVIDER_ORDER,
  DASHBOARD_FENCE,
  fitHistory,
  historyBudget,
  parseDashboardSpec,
  AI_PROVIDERS,
  parseReply,
  schemaBudget,
  systemPrompt,
  takeRunRequest,
  type ReplySegment
} from '@/lib/ai'
import { cn } from '@/lib/cn'
import { settingsStore } from '@/lib/settings'
import { createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import { createDashboard, dashboardsStore, newWidget, uniqueDashboardName } from '@/lib/dashboards'
import { onTabClosed, openDashboard, openSettings, promptText } from '@/lib/workspace'
import { showMenuAt, type MenuItem } from '@/components/ContextMenu'
import { Badge, Button, Spinner } from '@/components/ui'
import { aiStatusQuery } from './status'

/** What the panel works on: a query or Mongo shell tab, through its editor. */
export interface AssistantTarget {
  tabId: string
  connectionId: string
  database: string
  /** e.g. "PostgreSQL 16.2" */
  engine: string
  language: 'sql' | 'mongo'
  /** Tables, columns and keys as text (names only), within `budget` characters */
  schema: (budget: number, focus: string) => Promise<{ text: string; summary: string }>
  /** The selection, else the statement at the cursor, else the editor's text */
  code: () => string
  /** The last run's error, with the text that ran */
  error: () => { sql: string; message: string; line: number | null } | null
  /** The plan of `code()`, explaining it first when there's none yet */
  plan?: () => Promise<{ sql: string; text: string } | null>
  insert: (code: string, mode: 'cursor' | 'replace') => void
  /** Why a code block would change data when run, for a warning on it */
  writes: (code: string) => string | null
  /** Why the app won't run a query the assistant asked for, or null to allow it */
  refuse: (query: string) => string | null
  /** Runs a read-only query the assistant asked for; returns its rows as text */
  readData: (query: string, maxRows: number) => Promise<{ text: string; summary: string }>
}

interface Entry {
  id: string
  role: 'user' | 'assistant'
  /** What the model gets */
  content: string
  /** What the panel shows, when not `content` */
  display?: string
  /** What was attached to a question, shown as chips */
  attached?: string[]
  /** A query the assistant asked to run */
  query?: {
    text: string
    state: 'pending' | 'ran' | 'declined' | 'refused' | 'failed'
    note?: string
  }
  /** A failed request; never sent back */
  failed?: boolean
  model?: string | null
}

interface Thread {
  entries: Entry[]
  busy: boolean
  requestId?: string
}

/** Tabs showing the assistant panel */
export const assistantOpenStore = createStore<Record<string, boolean>>({})

export function toggleAssistant(tabId: string, open = !assistantOpenStore.get()[tabId]): void {
  assistantOpenStore.set((s) => ({ ...s, [tabId]: open }))
}

/** Conversations per tab, in memory only: closing the app forgets them. */
const threadsStore = createStore<Record<string, Thread>>({})

/** Answers for queries waiting on the user's approval, by entry id. */
const approvals = new Map<string, (run: boolean) => void>()

/** Tabs whose current request was stopped. */
const stopped = new Set<string>()

/** Rounds of "run this query" per question before the assistant must answer. */
const MAX_QUERIES = 6

function thread(tabId: string): Thread {
  return threadsStore.get()[tabId] ?? { entries: [], busy: false }
}

function update(tabId: string, change: (t: Thread) => Thread): void {
  threadsStore.set((all) => ({ ...all, [tabId]: change(thread(tabId)) }))
}

function push(tabId: string, entry: Omit<Entry, 'id'>): string {
  const id = crypto.randomUUID()
  update(tabId, (t) => ({ ...t, entries: [...t.entries, { ...entry, id }] }))
  return id
}

function patchQuery(tabId: string, id: string, query: Partial<NonNullable<Entry['query']>>): void {
  update(tabId, (t) => ({
    ...t,
    entries: t.entries.map((e) =>
      e.id === id && e.query ? { ...e, query: { ...e.query, ...query } } : e
    )
  }))
}

/** What the model gets back each round, trimmed so long conversations still fit. */
function conversation(tabId: string, budget: number): AiMessage[] {
  const messages = thread(tabId)
    .entries.filter((e) => !e.failed)
    .map((e) => ({ role: e.role, content: e.content }))
  return fitHistory(messages, budget)
}

/** The session MongoDB tabs sample field names on */
export function sampleSession(tabId: string): string {
  return `${tabId}:ai-sample`
}

/**
 * Stops a tab's request, forgets its conversation and closes the sessions its
 * queries ran on: for "Clear", a connection change and a closed tab.
 */
export function resetAssistant(tabId: string, connectionId: string): void {
  stop(tabId)
  threadsStore.set((all) => {
    const { [tabId]: _, ...rest } = all
    return rest
  })
  void api.aiSessionClose(connectionId, tabId).catch(() => {})
  void api.closeSession(connectionId, sampleSession(tabId)).catch(() => {})
}

// A closed tab's request stops and everything it held goes
onTabClosed((tab) => {
  if (tab.kind !== 'query' && tab.kind !== 'mongo') return
  resetAssistant(tab.id, tab.connectionId)
  assistantOpenStore.set((s) => {
    const { [tab.id]: _, ...rest } = s
    return rest
  })
})

/** Stops the request in flight, if any; a pending query is answered "don't run". */
export function stopAssistant(tabId: string): void {
  stop(tabId)
}

function stop(tabId: string): void {
  const t = thread(tabId)
  if (!t.busy) return
  stopped.add(tabId)
  if (t.requestId) void api.aiCancel(t.requestId)
  for (const e of t.entries)
    if (e.query?.state === 'pending') {
      approvals.get(e.id)?.(false)
      approvals.delete(e.id)
    }
}

/**
 * Sends `content` and keeps the conversation going while the assistant asks
 * for queries the user lets run, until it answers.
 */
async function ask(
  target: AssistantTarget,
  question: { content: string; display: string; attached: string[] }
): Promise<void> {
  const { tabId } = target
  if (thread(tabId).busy) return
  stopped.delete(tabId)
  push(tabId, { role: 'user', ...question })
  update(tabId, (t) => ({ ...t, busy: true }))
  try {
    for (let round = 0; ; round++) {
      // Stop can land during any await below; nothing more goes to the provider after it
      if (stopped.has(tabId)) return
      const settings = settingsStore.get()
      const provider = settings.aiProvider
      const allowData = settings.aiAllowData && round < MAX_QUERIES
      let schema
      try {
        schema = await target.schema(schemaBudget(provider), question.content)
      } catch (e) {
        if (!stopped.has(tabId))
          push(tabId, {
            role: 'assistant',
            content: `Couldn't load the schema: ${errorMessage(e)}`,
            failed: true
          })
        return
      }
      if (stopped.has(tabId)) return
      const requestId = crypto.randomUUID()
      update(tabId, (t) => ({ ...t, requestId }))
      let reply
      try {
        reply = await api.aiChat(requestId, {
          provider,
          model: settings.aiModels[provider] ?? '',
          baseUrl: settings.aiBaseUrl,
          system: systemPrompt({
            engine: target.engine,
            language: target.language,
            database: target.database,
            schema: schema.text,
            data: { allowed: allowData, maxRows: settings.aiMaxRows }
          }),
          messages: conversation(tabId, historyBudget(provider))
        })
      } catch (e) {
        if (!stopped.has(tabId))
          push(tabId, { role: 'assistant', content: errorMessage(e), failed: true })
        return
      }
      if (stopped.has(tabId)) return
      const { text, query } = takeRunRequest(reply.text)
      if (!query || !allowData) {
        // Without data access a requested query is just shown, for the user to run
        const display = query
          ? `${text}\n\n\`\`\`${target.language === 'sql' ? 'sql' : 'javascript'}\n${query}\n\`\`\``
          : text
        push(tabId, { role: 'assistant', content: reply.text, display, model: reply.model })
        return
      }
      const id = push(tabId, {
        role: 'assistant',
        content: reply.text,
        display: text,
        model: reply.model,
        query: { text: query, state: 'pending' }
      })
      const refusal = target.refuse(query)
      if (refusal) {
        patchQuery(tabId, id, { state: 'refused', note: `Not run: ${refusal}` })
        push(tabId, {
          role: 'user',
          content: `<query_result>\nNot run: ${refusal}. Only read-only queries can run.\n</query_result>`,
          display: 'Refused the query',
          attached: []
        })
        continue
      }
      const approved =
        !settings.aiConfirmQueries ||
        (await new Promise<boolean>((resolve) => approvals.set(id, resolve)))
      approvals.delete(id)
      if (stopped.has(tabId)) {
        patchQuery(tabId, id, { state: 'declined' })
        return
      }
      if (!approved) {
        patchQuery(tabId, id, { state: 'declined' })
        push(tabId, {
          role: 'user',
          content:
            '<query_result>\nThe user declined to run this query. Answer without it, or give them a query to run themselves.\n</query_result>',
          display: 'Declined the query',
          attached: []
        })
        continue
      }
      try {
        const result = await target.readData(query, settings.aiMaxRows)
        // Rows read after Stop are not added to the conversation
        if (stopped.has(tabId)) {
          patchQuery(tabId, id, { state: 'declined', note: 'Stopped' })
          return
        }
        patchQuery(tabId, id, { state: 'ran', note: result.summary })
        push(tabId, {
          role: 'user',
          content: `<query_result>\n${result.text}\n</query_result>`,
          display: 'Sent the result',
          attached: [result.summary]
        })
      } catch (e) {
        if (stopped.has(tabId)) return
        const message = errorMessage(e)
        patchQuery(tabId, id, { state: 'failed', note: message })
        push(tabId, {
          role: 'user',
          content: `<query_result>\nNot run: ${message}\n</query_result>`,
          display: 'The query failed',
          attached: []
        })
      }
    }
  } finally {
    update(tabId, (t) => ({ ...t, busy: false, requestId: undefined }))
  }
}

function fence(language: AssistantTarget['language'], code: string): string {
  return `\`\`\`${language === 'sql' ? 'sql' : 'javascript'}\n${code}\n\`\`\``
}

export function AssistantPanel({
  target,
  onClose
}: {
  target: AssistantTarget
  onClose: () => void
}): React.JSX.Element {
  const settings = settingsStore.use()
  const current = threadsStore.use()[target.tabId] ?? { entries: [], busy: false }
  const [draft, setDraft] = useState('')
  const [attach, setAttach] = useState(true)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const provider = settings.aiProvider
  const info = AI_PROVIDERS[provider]
  const status = useQuery(aiStatusQuery(provider, settings.aiBaseUrl))
  const lastError = target.error()

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [current.entries.length, current.busy])
  useEffect(() => input.current?.focus(), [])

  const send = async (
    question: string,
    extra: { label: string; content: string }[] = []
  ): Promise<void> => {
    const attached: string[] = []
    const parts = [question]
    for (const e of extra) {
      parts.push(e.content)
      attached.push(e.label)
    }
    await ask(target, { content: parts.join('\n\n'), display: question, attached })
  }

  const submit = (): void => {
    const question = draft.trim()
    if (!question || current.busy) return
    setDraft('')
    const code = attach ? target.code().trim() : ''
    void send(
      question,
      code
        ? [{ label: 'Editor text', content: `The editor holds:\n${fence(target.language, code)}` }]
        : []
    )
  }

  const explain = (): void => {
    const code = target.code().trim()
    if (!code) return toast('Write or select a query to explain', 'error')
    void send('Explain what this query does.', [
      { label: 'Query', content: fence(target.language, code) }
    ])
  }

  const slow = async (): Promise<void> => {
    if (!target.plan) return
    const code = target.code().trim()
    if (!code) return toast('Write or select a query first', 'error')
    const plan = await target.plan()
    if (!plan) return toast("Couldn't get a plan for this query", 'error')
    void send('Why is this query slow, and how do I make it faster?', [
      { label: 'Query', content: fence(target.language, plan.sql) },
      { label: 'Execution plan', content: `Its execution plan:\n${plan.text}` }
    ])
  }

  const fix = (): void => {
    if (!lastError) return
    void send('Fix this error.', [
      { label: 'Query', content: `The query that ran:\n${fence(target.language, lastError.sql)}` },
      {
        label: 'Error',
        content: `The server's error${lastError.line != null ? ` (line ${lastError.line})` : ''}:\n${lastError.message}`
      }
    ])
  }

  const ready = status.data?.ready
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-line bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <Lightbulb className="size-3.5 text-accent" />
        <span className="text-[13px] font-medium text-bright">Assistant</span>
        <ModelPicker disabled={current.busy} />
        <div className="flex-1" />
        <Button
          size="icon-sm"
          variant="ghost"
          title="Clear the conversation"
          disabled={!current.entries.length || current.busy}
          onClick={() => resetAssistant(target.tabId, target.connectionId)}
        >
          <Trash2 className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" title="Assistant settings" onClick={openSettings}>
          <Settings2 className="size-3.5" />
        </Button>
        <Button size="icon-sm" variant="ghost" title="Close" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>

      <div
        className="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-[11px] text-muted"
        title={
          settings.aiAllowData
            ? 'The assistant may ask to run read-only queries; their rows go to the provider. Writes are always refused.'
            : 'Only table and column names go to the provider, never rows. Turn on data access in Settings.'
        }
      >
        <ShieldCheck className="size-3 shrink-0 text-ok" />
        {settings.aiAllowData ? (
          <span>
            Schema, attached text and approved read-only queries
            {settings.aiConfirmQueries ? ' (asks first)' : ''}
          </span>
        ) : (
          <span>Sends the schema and attached text, never data</span>
        )}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {status.data && !ready && (
          <div className="rounded-md border border-warn/30 bg-warn/5 p-3 text-xs">
            <p className="text-bright">{status.data.detail}</p>
            <p className="mt-1 text-muted">{info.setup}</p>
            <div className="mt-2 flex gap-2">
              <Button size="xs" variant="secondary" onClick={() => void status.refetch()}>
                Check again
              </Button>
              <Button size="xs" variant="ghost" onClick={openSettings}>
                Settings
              </Button>
            </div>
          </div>
        )}
        {!current.entries.length && (
          <div className="space-y-2 pt-2 text-xs text-muted">
            <p>
              Ask for a query in plain English, or use the actions below on the query in the editor.
              Answers use the {target.language === 'sql' ? 'tables' : 'collections'} of{' '}
              <span className="text-fg">{target.database || 'this connection'}</span>.
            </p>
          </div>
        )}
        {current.entries.map((entry) => (
          <EntryView key={entry.id} entry={entry} target={target} />
        ))}
        {current.busy && !current.entries.some((e) => e.query?.state === 'pending') && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner className="size-3.5" /> Thinking…
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-2 border-t border-line p-2">
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant="ghost" disabled={current.busy} onClick={explain}>
            <Lightbulb className="size-3" /> Explain
          </Button>
          {target.plan && (
            <Button size="xs" variant="ghost" disabled={current.busy} onClick={() => void slow()}>
              <Gauge className="size-3" /> Why slow?
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={current.busy}
            title="Design a dashboard for this database; type what it should show first to steer it"
            onClick={() => {
              const ask = draft.trim()
              setDraft('')
              void send(
                ask
                  ? `Build a dashboard: ${ask}`
                  : 'Build a dashboard of the most useful numbers and trends in this database.'
              )
            }}
          >
            <LayoutDashboard className="size-3" /> Dashboard
          </Button>
          {lastError && (
            <Button size="xs" variant="ghost" disabled={current.busy} onClick={fix}>
              <Bug className="size-3" /> Fix error
            </Button>
          )}
        </div>
        <div className="rounded-md border border-line-strong bg-canvas focus-within:border-accent/60">
          <textarea
            ref={input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            rows={3}
            spellCheck
            placeholder={
              target.language === 'sql'
                ? 'e.g. Top 10 customers by revenue last month'
                : 'e.g. Orders over $100 from this week, newest first'
            }
            className="block max-h-40 w-full resize-none bg-transparent px-2.5 py-2 text-[13px] text-bright placeholder:text-faint focus:outline-none"
          />
          <div className="flex items-center gap-2 px-2 pb-1.5">
            <label
              className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted select-none"
              title="Send the selection, or the statement at the cursor, with the question"
            >
              <input
                type="checkbox"
                checked={attach}
                onChange={(e) => setAttach(e.target.checked)}
                className="accent-(--accent)"
              />
              Include editor text
            </label>
            <div className="flex-1" />
            {current.busy ? (
              <Button
                size="icon-sm"
                variant="danger"
                title="Stop"
                onClick={() => stop(target.tabId)}
              >
                <Square className="size-3 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                variant="primary"
                title="Send (Enter)"
                disabled={!draft.trim()}
                onClick={submit}
              >
                <ArrowUp className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function EntryView({
  entry,
  target
}: {
  entry: Entry
  target: AssistantTarget
}): React.JSX.Element {
  const text = entry.display ?? entry.content
  if (entry.role === 'user')
    return (
      <div className="ml-6 rounded-lg bg-raised px-3 py-2 text-[13px] text-bright">
        <p className="whitespace-pre-wrap">{text}</p>
        {!!entry.attached?.length && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {entry.attached.map((a) => (
              <Badge key={a}>{a}</Badge>
            ))}
          </div>
        )}
      </div>
    )
  if (entry.failed)
    return (
      <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs whitespace-pre-wrap text-danger">
        {text}
      </div>
    )
  return (
    <div className="space-y-2 text-[13px] text-fg">
      {parseReply(text).map((segment, i) => (
        <Segment key={i} segment={segment} target={target} />
      ))}
      {entry.query && <QueryCard id={entry.id} query={entry.query} />}
    </div>
  )
}

function Segment({
  segment,
  target
}: {
  segment: ReplySegment
  target: AssistantTarget
}): React.JSX.Element {
  if (segment.kind === 'text') return <Prose text={segment.text} />
  // Models sometimes label the block json
  if (
    segment.lang === DASHBOARD_FENCE ||
    (segment.lang === 'json' && /"widgets"\s*:/.test(segment.code))
  )
    return <DashboardCard code={segment.code} target={target} />
  const runnable = !['', 'text', 'plaintext', 'json', 'bash', 'sh', 'shell'].includes(segment.lang)
  const writes = runnable ? target.writes(segment.code) : null
  return (
    <div className="overflow-hidden rounded-md border border-line bg-canvas">
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed text-bright">
        {segment.code}
      </pre>
      <div className="flex items-center gap-1 border-t border-line px-1.5 py-1">
        {writes && (
          <Badge tone="warning" title="You'll be asked to confirm before it runs">
            {writes}
          </Badge>
        )}
        <div className="flex-1" />
        <Button
          size="xs"
          variant="ghost"
          title="Copy"
          onClick={() =>
            void navigator.clipboard.writeText(segment.code).then(() => toast('Copied'))
          }
        >
          <ClipboardCopy className="size-3" />
        </Button>
        {runnable && (
          <>
            <Button
              size="xs"
              variant="ghost"
              title="Replace the editor's text with this"
              onClick={() => target.insert(segment.code, 'replace')}
            >
              <Replace className="size-3" /> Replace
            </Button>
            <Button
              size="xs"
              variant="secondary"
              title="Insert at the cursor, replacing the selection"
              onClick={() => target.insert(segment.code, 'cursor')}
            >
              <ListPlus className="size-3" /> Insert
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function QueryCard({
  id,
  query
}: {
  id: string
  query: NonNullable<Entry['query']>
}): React.JSX.Element {
  const answer = (run: boolean): void => {
    approvals.get(id)?.(run)
    approvals.delete(id)
  }
  return (
    <div
      className={cn(
        'rounded-md border p-2',
        query.state === 'pending' ? 'border-accent/40 bg-accent/5' : 'border-line bg-canvas'
      )}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted">
        <Database className="size-3" />
        {query.state === 'pending'
          ? 'The assistant wants to run this read-only query'
          : query.state === 'ran'
            ? 'Ran for the assistant'
            : query.state === 'declined'
              ? 'Not run'
              : query.state === 'refused'
                ? 'Refused'
                : 'Failed'}
      </div>
      <pre className="overflow-x-auto font-mono text-xs text-bright">{query.text}</pre>
      {query.note && (
        <p className={cn('mt-1.5 text-[11px]', query.state === 'ran' ? 'text-muted' : 'text-warn')}>
          {query.note}
        </p>
      )}
      {query.state === 'pending' && (
        <div className="mt-2 flex items-center justify-end gap-1.5">
          <span className="mr-auto text-[11px] text-faint">Its rows are sent to the provider</span>
          <Button size="xs" variant="ghost" onClick={() => answer(false)}>
            Don't run
          </Button>
          <Button size="xs" variant="primary" onClick={() => answer(true)}>
            <Check className="size-3" /> Run
          </Button>
        </div>
      )}
    </div>
  )
}

/** Paragraphs and lists with `code` and **bold**: enough of Markdown for answers. */
function Prose({ text }: { text: string }): React.JSX.Element {
  const blocks = text.split(/\n{2,}/)
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l)))
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-4">
              {lines.map((l, j) => (
                <li key={j}>
                  <Inline text={l.replace(/^\s*([-*]|\d+\.)\s/, '')} />
                </li>
              ))}
            </ul>
          )
        const heading = /^#{1,6}\s+(.*)$/.exec(block)
        if (heading && lines.length === 1)
          return (
            <p key={i} className="font-semibold text-bright">
              <Inline text={heading[1]} />
            </p>
          )
        return (
          <p key={i} className="leading-relaxed whitespace-pre-wrap">
            <Inline text={block} />
          </p>
        )
      })}
    </>
  )
}

function Inline({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`') && p.length > 1 ? (
          <code key={i} className="rounded bg-raised px-1 font-mono text-[12px] text-bright">
            {p.slice(1, -1)}
          </code>
        ) : p.startsWith('**') && p.endsWith('**') && p.length > 3 ? (
          <b key={i} className="text-bright">
            {p.slice(2, -2)}
          </b>
        ) : (
          p
        )
      )}
    </>
  )
}

/** Short names for the picker button */
const SHORT: Record<AiProvider, string> = {
  'claude-code': 'Claude',
  cursor: 'Cursor',
  anthropic: 'Anthropic API',
  'openai-compatible': 'Local'
}

/** The provider and model the next question goes to; the conversation carries over. */
function ModelPicker({ disabled }: { disabled: boolean }): React.JSX.Element {
  const settings = settingsStore.use()
  const provider = settings.aiProvider
  const info = AI_PROVIDERS[provider]
  const model = settings.aiModels[provider] ?? ''
  const listed = useQuery({
    queryKey: ['ai-models', provider, settings.aiBaseUrl],
    queryFn: () => api.aiModels(provider, settings.aiBaseUrl),
    enabled: provider === 'cursor' || provider === 'openai-compatible',
    staleTime: 5 * 60_000
  })
  const choices = [
    ...info.models,
    ...(listed.data ?? [])
      .filter((m) => !info.models.some((o) => o.value === m))
      .map((m) => ({ value: m, label: m }))
  ]
  const modelLabel =
    choices.find((m) => m.value === model)?.label ??
    (model || info.models[0]?.label || 'Pick a model')
  const setModel = (value: string): void =>
    settingsStore.set((s) => ({ ...s, aiModels: { ...s.aiModels, [s.aiProvider]: value } }))
  const mark = (on: boolean): React.ReactNode =>
    on ? <Check className="size-3.5" /> : <span className="size-3.5" />

  const open = (element: HTMLElement): void => {
    const items: MenuItem[] = [
      { heading: 'Provider' },
      ...AI_PROVIDER_ORDER.map((p) => ({
        label: AI_PROVIDERS[p].label,
        icon: mark(p === provider),
        title: AI_PROVIDERS[p].description,
        onSelect: () => settingsStore.set((s) => ({ ...s, aiProvider: p }))
      })),
      'separator',
      { heading: 'Model' },
      ...choices.map((m) => ({
        label: m.label,
        icon: mark(m.value === model),
        onSelect: () => setModel(m.value)
      })),
      {
        label: 'Other model…',
        icon: mark(!!model && !choices.some((m) => m.value === model)),
        onSelect: () =>
          void promptText({
            title: `Model for ${info.label}`,
            label: 'Model name, as the provider spells it',
            initial: model,
            placeholder: provider === 'anthropic' ? 'claude-opus-5-5' : undefined,
            confirmLabel: 'Use model'
          }).then((value) => value != null && setModel(value.trim()))
      },
      'separator',
      {
        label: 'Set up providers…',
        icon: <Settings2 className="size-3.5" />,
        onSelect: openSettings
      }
    ]
    showMenuAt(element, items)
  }

  return (
    <button
      type="button"
      disabled={disabled}
      title={
        disabled ? 'Wait for the answer to switch' : 'Provider and model for the next question'
      }
      onClick={(e) => open(e.currentTarget)}
      className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-bright disabled:opacity-40"
    >
      <span className="truncate">
        {SHORT[provider]} · {modelLabel}
      </span>
      <ChevronDown className="size-3 shrink-0" />
    </button>
  )
}

const KIND_LABEL = { stat: 'Stat', bar: 'Bar chart', line: 'Line chart', table: 'Table' }

/** A dashboard the assistant designed: its widgets and queries, and a button to create it. */
function DashboardCard({
  code,
  target
}: {
  code: string
  target: AssistantTarget
}): React.JSX.Element {
  const [created, setCreated] = useState<string | null>(null)
  let spec
  try {
    spec = parseDashboardSpec(code)
  } catch (e) {
    return (
      <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
        {errorMessage(e)}. Ask the assistant to send it again.
      </div>
    )
  }
  const writing = spec.widgets.flatMap((w) => {
    const hint = target.writes(w.query)
    return hint ? [`${w.title || 'Untitled'}: ${hint}`] : []
  })

  const create = (): void => {
    const result = createDashboard(dashboardsStore.get(), {
      name: uniqueDashboardName(dashboardsStore.get(), spec.name),
      connectionId: target.connectionId,
      database: target.database,
      refreshSecs: spec.refreshSecs,
      widgets: spec.widgets.map((w) => newWidget(w)),
      source: 'assistant',
      // Nothing the model wrote runs until the user has read it: mongosh widget
      // queries run as JavaScript in the app, and SQL ones could still call
      // functions with side effects. SQL widgets also run with the assistant's checks.
      unreviewed: true
    })
    dashboardsStore.set(result.list)
    setCreated(result.dashboard.id)
    openDashboard(result.dashboard.id)
  }

  return (
    <div className="overflow-hidden rounded-md border border-line bg-canvas">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <LayoutDashboard className="size-3.5 text-accent" />
        <span className="truncate text-[13px] font-medium text-bright">{spec.name}</span>
        <span className="ml-auto shrink-0 text-[11px] text-faint">
          {spec.widgets.length} widget{spec.widgets.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="space-y-1 px-3 py-2">
        {spec.widgets.map((w, i) => (
          <li key={i} className="flex items-center gap-2 text-xs">
            <BarChart3 className="size-3 shrink-0 text-muted" />
            <span className="truncate text-fg">{w.title || 'Untitled'}</span>
            <span className="ml-auto shrink-0 text-[11px] text-faint">{KIND_LABEL[w.kind]}</span>
          </li>
        ))}
      </ul>
      <details className="border-t border-line px-3 py-1.5">
        <summary className="cursor-pointer text-[11px] text-muted select-none">Queries</summary>
        <div className="space-y-2 py-2">
          {spec.widgets.map((w, i) => (
            <div key={i}>
              <p className="text-[11px] text-muted">{w.title || 'Untitled'}</p>
              <pre className="overflow-x-auto font-mono text-[11px] text-bright">{w.query}</pre>
            </div>
          ))}
        </div>
      </details>
      <div className="flex items-center gap-2 border-t border-line px-2 py-1.5">
        {writing.length ? (
          <p className="text-[11px] text-warn">
            Not created: dashboard queries can only read ({writing.join('; ')})
          </p>
        ) : (
          <span className="text-[11px] text-faint">
            You review the queries before they run; results stay here
          </span>
        )}
        <div className="flex-1" />
        {created ? (
          <Button size="xs" variant="ghost" onClick={() => openDashboard(created)}>
            <ExternalLink className="size-3" /> Open
          </Button>
        ) : (
          <Button size="xs" variant="primary" disabled={!!writing.length} onClick={create}>
            <LayoutDashboard className="size-3" /> Create dashboard
          </Button>
        )}
      </div>
    </div>
  )
}
