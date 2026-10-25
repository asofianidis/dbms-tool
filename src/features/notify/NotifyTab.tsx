import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Copy, Eraser, Pause, Play, RadioTower, RotateCcw, Send, Square, X } from 'lucide-react'
import { api, type PgNotification } from '@/lib/api'
import { cn } from '@/lib/cn'
import { copyText } from '@/lib/export'
import { formatCount } from '@/lib/format'
import {
  channelProblem,
  foldsCase,
  matchesFilter,
  rememberChannels,
  splitChannelList
} from '@/lib/pg-notify'
import { prettyJson } from '@/lib/redis'
import { createPersistentStore, createStore } from '@/lib/store'
import { toast, toastError } from '@/lib/toast'
import { connect, connectionsStore, statusStore, updateTab, type TabOf } from '@/lib/workspace'
import { Button, EmptyState, Input, Toolbar, ToolbarDivider } from '@/components/ui'
import { ConnectionPicker, DatabasePicker } from '../query/pickers'
import { NotConnected } from '../redis/common'

/** Most notifications kept per tab; older ones scroll away. */
const KEEP = 5000

interface Feed {
  items: (PgNotification & { n: number })[]
  dropped: number
  error: string | null
}

const feedStore = createStore<Record<string, Feed>>({})
/** Channels listened on lately, offered when typing one */
const recentStore = createPersistentStore<string[]>('dbms.pgNotify.recent.v1', [])
let seq = 0

// One listener for every tab; batches are routed by listener (the tab id)
let listening: Promise<unknown> | null = null
function listenAll(): void {
  listening ??= api.onPgNotifications((batch) => {
    feedStore.set((all) => {
      const feed = all[batch.listener] ?? { items: [], dropped: 0, error: null }
      const added = batch.notifications.map((m) => ({ ...m, n: ++seq }))
      return {
        ...all,
        [batch.listener]: {
          items: [...feed.items, ...added].slice(-KEEP),
          dropped: feed.dropped + batch.dropped,
          error: batch.error ?? feed.error
        }
      }
    })
  })
}

export function NotifyTab({ tab }: { tab: TabOf<'pgNotify'> }): React.JSX.Element {
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const recent = recentStore.use()
  const connection = connections.find((c) => c.id === tab.connectionId)
  const connected = statuses[tab.connectionId]?.state === 'connected'
  const feed = feedStore.use()[tab.id]
  const [input, setInput] = useState('')
  /** What the tab's session listens on, as the server last said */
  const [active, setActive] = useState<string[]>([])
  /** Why listening stopped without being asked to */
  const [lost, setLost] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  const [frozen, setFrozen] = useState<Feed['items'] | null>(null)
  const [filter, setFilter] = useState('')
  const [sendTo, setSendTo] = useState('')
  const [payload, setPayload] = useState('')
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(listenAll, [])

  // Disconnecting closes the tab's session with the rest of the connection's
  useEffect(() => {
    if (!connected && active.length) {
      setActive([])
      setLost('Disconnected from the server')
    }
  }, [connected, active.length])

  // The session ended on its own (server restart, pg_terminate_backend, network)
  const error = feed?.error ?? null
  useEffect(() => {
    if (error && active.length) {
      setActive([])
      setLost(error)
    }
  }, [error, active.length])

  /** Listens on `channels` too; reconnects first when the connection is down. */
  const listen = async (channels: string[]): Promise<void> => {
    if (!channels.length) return toast('Enter channels to listen on', 'error')
    const problem = channels.map(channelProblem).find(Boolean)
    if (problem) return toast(problem, 'error')
    if (!connected && !(await connect(tab.connectionId))) return
    setBusy(true)
    try {
      const now = await api.pgListen(tab.connectionId, tab.id, tab.database, channels)
      feedStore.set((all) => ({
        ...all,
        [tab.id]: { items: all[tab.id]?.items ?? [], dropped: 0, error: null }
      }))
      setActive(now)
      setLost(null)
      setInput('')
      if (!sendTo) setSendTo(now[0] ?? '')
      updateTab(tab.id, { channels: now } as Partial<typeof tab>)
      recentStore.set((r) => rememberChannels(r, channels))
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  /** Stops listening on `channels`, or on all of them when empty. */
  const unlisten = async (channels: string[]): Promise<void> => {
    try {
      const now = await api.pgUnlisten(tab.connectionId, tab.id, channels)
      setActive(now)
      updateTab(tab.id, { channels: now } as Partial<typeof tab>)
    } catch (e) {
      toastError(e)
    }
  }

  const send = async (): Promise<void> => {
    const channel = sendTo.trim()
    const problem = channelProblem(channel)
    if (problem) return toast(problem, 'error')
    try {
      await api.pgNotify(tab.connectionId, tab.id, tab.database, channel, payload)
      toast(`Sent NOTIFY to ${channel}`)
    } catch (e) {
      toastError(e)
    }
  }

  const items = frozen ?? feed?.items ?? []
  const shown = useMemo(
    () => (filter ? items.filter((m) => matchesFilter(m, filter)) : items),
    [items, filter]
  )
  const suggestions = useMemo(
    () => [...new Set([...recent, ...(feed?.items ?? []).map((m) => m.channel)])],
    [recent, feed?.items]
  )
  const remembered = tab.channels ?? []

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && !paused) el.scrollTop = el.scrollHeight
  }, [shown.length, paused])

  const listId = `pg-notify-channels-${tab.id}`
  return (
    <div className="flex h-full min-h-0 flex-col">
      <datalist id={listId}>
        {suggestions.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <Toolbar>
        <ConnectionPicker
          value={tab.connectionId}
          sql
          disabled={active.length > 0}
          onChange={(id) => {
            const engine = connections.find((c) => c.id === id)?.engine
            if (engine !== 'postgres') return toast('LISTEN / NOTIFY needs PostgreSQL', 'error')
            // The tab's session stays with the old connection otherwise
            void api.closeSession(tab.connectionId, tab.id).catch(() => {})
            setLost(null)
            updateTab(tab.id, { connectionId: id, channels: [] } as Partial<typeof tab>)
          }}
        />
        <DatabasePicker
          connectionId={tab.connectionId}
          value={tab.database}
          disabled={active.length > 0}
          onChange={(database) => updateTab(tab.id, { database } as Partial<typeof tab>)}
        />
        <ToolbarDivider />
        <Input
          mono
          list={listId}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void listen(splitChannelList(input))}
          disabled={!connected || busy}
          placeholder="Channels: orders, jobs"
          className="h-7 max-w-sm text-xs"
        />
        <Button
          size="sm"
          variant="primary"
          disabled={!connected || busy || !input.trim()}
          onClick={() => void listen(splitChannelList(input))}
        >
          <RadioTower className="size-3.5" /> Listen
        </Button>
        {active.length > 0 && (
          <Button
            size="sm"
            variant="danger"
            title="UNLISTEN *"
            onClick={() => {
              void unlisten([])
            }}
          >
            <Square className="size-3 fill-current" /> Unlisten all
          </Button>
        )}
        <div className="flex-1" />
        <Button
          size="icon"
          variant="ghost"
          title={paused ? 'Resume' : 'Pause the view (notifications keep arriving)'}
          onClick={() => {
            setFrozen(paused ? null : (feed?.items ?? []))
            setPaused(!paused)
          }}
        >
          {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Clear"
          onClick={() => {
            setFrozen(null)
            feedStore.set((all) => ({
              ...all,
              [tab.id]: { items: [], dropped: 0, error: null }
            }))
          }}
        >
          <Eraser className="size-3.5" />
        </Button>
      </Toolbar>
      {!connected && !lost ? (
        <NotConnected connection={connection} />
      ) : (
        <>
          <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-1 text-[11px] text-muted">
            <span className={cn('size-1.5 rounded-full', active.length ? 'bg-ok' : 'bg-faint')} />
            {active.length ? (
              <>
                <span>Listening on {tab.database}:</span>
                {active.map((c) => (
                  <span
                    key={c}
                    className={cn(
                      'inline-flex items-center gap-1 rounded bg-raised px-1.5 py-0.5 font-mono text-fg ring-1 ring-line-strong ring-inset',
                      foldsCase(c) && 'ring-warn/50'
                    )}
                    title={
                      foldsCase(c)
                        ? `Mixed case: send with pg_notify('${c}', …) or NOTIFY "${c}"; an unquoted NOTIFY ${c} goes to ${c.toLowerCase()}`
                        : undefined
                    }
                  >
                    {c}
                    <button
                      type="button"
                      className="text-faint hover:text-danger"
                      title={`UNLISTEN ${c}`}
                      onClick={() => void unlisten([c])}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </>
            ) : (
              <span>Not listening</span>
            )}
            <span className="tabular-nums">{formatCount(items.length)} notifications</span>
            {paused && <span className="text-warn">Paused</span>}
            {!!feed?.dropped && (
              <span className="text-warn" title="Arrived faster than they could be shown">
                {formatCount(feed.dropped)} dropped
              </span>
            )}
            <div className="flex-1" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter channel, payload or pid"
              className="h-6 w-56 text-xs"
            />
          </div>
          {!active.length && (lost || remembered.length > 0) && (
            <div className="flex shrink-0 items-center gap-2 border-b border-line bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
              <span className="min-w-0 truncate">
                {lost ? `Stopped listening: ${lost}.` : 'Not listening.'}
                {remembered.length > 0 && ` Channels: ${remembered.join(', ')}`}
              </span>
              <div className="flex-1" />
              {remembered.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void listen(remembered)}
                >
                  <RotateCcw className="size-3.5" />
                  {connected ? 'Listen again' : 'Reconnect and listen'}
                </Button>
              )}
            </div>
          )}
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-y-auto bg-canvas font-mono text-xs"
          >
            {!shown.length ? (
              <EmptyState
                icon={<RadioTower className="size-6" />}
                title={active.length ? 'Waiting for notifications…' : 'Listen to see notifications'}
              >
                This tab listens on a session of its own in {tab.database}. Channel names are kept
                exactly as typed, like <span className="font-mono">pg_notify()</span>; in SQL an
                unquoted <span className="font-mono">NOTIFY Jobs</span> goes to{' '}
                <span className="font-mono">jobs</span>.
              </EmptyState>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {shown.map((m) => (
                    <NotificationRow key={m.n} notification={m} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-2 py-1.5">
            <Input
              mono
              list={listId}
              value={sendTo}
              onChange={(e) => setSendTo(e.target.value)}
              placeholder="Channel"
              className="h-7 w-48 text-xs"
            />
            <Input
              mono
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void send()}
              placeholder="Payload (optional)"
              className="h-7 flex-1 text-xs"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!connected || connection?.readOnly}
              title="SELECT pg_notify(channel, payload)"
              onClick={() => void send()}
            >
              <Send className="size-3.5" /> Send NOTIFY
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function NotificationRow({ notification: m }: { notification: PgNotification }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const pretty = open ? prettyJson(m.payload) : null
  return (
    <tr
      className="group cursor-default border-b border-line/50 align-top hover:bg-hover/40"
      onClick={() => setOpen(!open)}
    >
      <td className="w-24 px-3 py-1 whitespace-nowrap text-faint tabular-nums">
        {new Date(m.at).toLocaleTimeString(undefined, { hour12: false })}
        <span className="text-faint/70">.{String(m.at % 1000).padStart(3, '0')}</span>
      </td>
      <td className="w-56 max-w-56 truncate px-2 py-1 text-syn-prop" title={m.channel}>
        {m.channel}
      </td>
      <td className="w-20 px-2 py-1 text-faint tabular-nums" title="Sending backend's pid">
        {m.pid}
      </td>
      <td className="px-2 py-1 text-fg">
        {!m.payload ? (
          <span className="text-faint italic">no payload</span>
        ) : open ? (
          <pre className="break-all whitespace-pre-wrap select-text">{pretty ?? m.payload}</pre>
        ) : (
          <span className="line-clamp-1 break-all">{m.payload}</span>
        )}
      </td>
      <td className="w-8 px-1 py-0.5 text-right">
        {!!m.payload && (
          <button
            type="button"
            className="rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:text-bright"
            title="Copy payload"
            onClick={(e) => {
              e.stopPropagation()
              void copyText(pretty ?? m.payload, 'Payload copied')
            }}
          >
            <Copy className="size-3.5" />
          </button>
        )}
      </td>
    </tr>
  )
}
