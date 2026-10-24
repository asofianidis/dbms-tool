import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Eraser, Pause, Play, RadioTower, Send, Square, Zap } from 'lucide-react'
import { api, type PubSubMessage } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCount } from '@/lib/format'
import { dataText, prettyJson } from '@/lib/redis'
import { createStore } from '@/lib/store'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { connectionsStore, statusStore, updateTab, type TabOf } from '@/lib/workspace'
import { Button, EmptyState, Input, Toolbar, ToolbarDivider } from '@/components/ui'
import { ConnectionPicker } from '../query/pickers'
import { NotConnected } from './common'

/** Most messages kept per tab; older ones scroll away. */
const KEEP = 5000

interface Feed {
  messages: (PubSubMessage & { n: number })[]
  dropped: number
  error: string | null
}

const feedStore = createStore<Record<string, Feed>>({})
let seq = 0

// One listener for every tab; batches are routed by subscription (the tab id)
let listening: Promise<unknown> | null = null
function listen(): void {
  listening ??= api.onRedisMessages((batch) => {
    feedStore.set((all) => {
      const feed = all[batch.subscription] ?? { messages: [], dropped: 0, error: null }
      const added = batch.messages.map((m) => ({ ...m, n: ++seq }))
      return {
        ...all,
        [batch.subscription]: {
          messages: [...feed.messages, ...added].slice(-KEEP),
          dropped: feed.dropped + batch.dropped,
          error: batch.error ?? feed.error
        }
      }
    })
  })
}

/** `news, alerts:*` → exact channels and glob patterns. */
export function splitChannels(text: string): { channels: string[]; patterns: string[] } {
  const all = text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    channels: all.filter((c) => !/[*?[]/.test(c)),
    patterns: all.filter((c) => /[*?[]/.test(c))
  }
}

export function PubSubTab({ tab }: { tab: TabOf<'redisPubsub'> }): React.JSX.Element {
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const connection = connections.find((c) => c.id === tab.connectionId)
  const connected = statuses[tab.connectionId]?.state === 'connected'
  const feed = feedStore.use()[tab.id]
  const [channels, setChannels] = useState(tab.channels ?? '')
  const [active, setActive] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  const [frozen, setFrozen] = useState<Feed['messages'] | null>(null)
  const [filter, setFilter] = useState('')
  const [publishTo, setPublishTo] = useState('')
  const [payload, setPayload] = useState('')
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(listen, [])

  // Closing the tab ends the subscription with the tab's session (see close_session)
  useEffect(() => {
    if (!connected) setActive(null)
  }, [connected])

  const subscribe = async (text = channels): Promise<void> => {
    const { channels: chans, patterns } = splitChannels(text)
    if (!chans.length && !patterns.length) return toast('Enter channels or patterns', 'error')
    setBusy(true)
    try {
      await api.redisSubscribe(tab.connectionId, tab.id, chans, patterns)
      feedStore.set((all) => ({
        ...all,
        [tab.id]: { messages: all[tab.id]?.messages ?? [], dropped: 0, error: null }
      }))
      setActive(text)
      updateTab(tab.id, { channels: text } as Partial<typeof tab>)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  const unsubscribe = (): void => {
    void api.redisUnsubscribe(tab.connectionId, tab.id)
    setActive(null)
  }

  const publish = async (): Promise<void> => {
    if (!publishTo.trim()) return toast('Enter a channel to publish to', 'error')
    try {
      const out = await api.redis(tab.connectionId, tab.id, {
        op: 'command',
        database: '0',
        args: ['PUBLISH', publishTo.trim(), payload]
      })
      const n = out.reply?.t === 'int' ? Number(out.reply.v) : 0
      toast(`Delivered to ${n} subscriber${n === 1 ? '' : 's'}`)
    } catch (e) {
      toastError(e)
    }
  }

  /** Keyspace notifications publish every change to `__keyspace@<db>__:<key>`. */
  const watchKeyspace = async (): Promise<void> => {
    try {
      const out = await api.redis(tab.connectionId, tab.id, {
        op: 'command',
        database: '0',
        args: ['CONFIG', 'GET', 'notify-keyspace-events']
      })
      const item = out.reply?.t === 'array' ? out.reply.v[1] : undefined
      const current = item?.t === 'bulk' ? dataText(item.v) : ''
      if (!current && !connection?.readOnly) {
        toast('Turning on keyspace notifications (notify-keyspace-events KEA)', 'info')
        await api.redis(tab.connectionId, tab.id, {
          op: 'command',
          database: '0',
          args: ['CONFIG', 'SET', 'notify-keyspace-events', 'KEA']
        })
      } else if (!current) {
        toast('Keyspace notifications are off on this server (notify-keyspace-events)', 'info')
      }
    } catch (e) {
      // Managed services often block CONFIG; notifications may already be on
      toast(`Couldn't check keyspace notifications: ${errorMessage(e)}`, 'info')
    }
    const text = '__keyspace@*__:*'
    setChannels(text)
    void subscribe(text)
  }

  const messages = frozen ?? feed?.messages ?? []
  const shown = useMemo(() => {
    const f = filter.toLowerCase()
    return f
      ? messages.filter(
          (m) =>
            m.channel.toLowerCase().includes(f) || dataText(m.payload).toLowerCase().includes(f)
        )
      : messages
  }, [messages, filter])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && !paused) el.scrollTop = el.scrollHeight
  }, [shown.length, paused])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <ConnectionPicker
          value={tab.connectionId}
          redis
          disabled={!!active}
          onChange={(id) => updateTab(tab.id, { connectionId: id } as Partial<typeof tab>)}
        />
        <ToolbarDivider />
        <Input
          mono
          value={channels}
          onChange={(e) => setChannels(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void subscribe()}
          disabled={!connected || busy}
          placeholder="Channels or patterns: orders, events:*"
          className="h-7 max-w-md text-xs"
        />
        {active ? (
          <Button size="sm" variant="danger" onClick={unsubscribe}>
            <Square className="size-3 fill-current" /> Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={!connected || busy}
            onClick={() => void subscribe()}
          >
            <RadioTower className="size-3.5" /> Subscribe
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={!connected || busy}
          onClick={() => void watchKeyspace()}
          title="Watch every key change through keyspace notifications"
        >
          <Zap className="size-3.5" /> Watch key changes
        </Button>
        <div className="flex-1" />
        <Button
          size="icon"
          variant="ghost"
          title={paused ? 'Resume' : 'Pause the view (messages keep arriving)'}
          onClick={() => {
            setFrozen(paused ? null : (feed?.messages ?? []))
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
              [tab.id]: { messages: [], dropped: 0, error: null }
            }))
          }}
        >
          <Eraser className="size-3.5" />
        </Button>
      </Toolbar>
      {!connected ? (
        <NotConnected connection={connection} />
      ) : (
        <>
          <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line bg-panel px-3 text-[11px] text-muted">
            <span className={cn('size-1.5 rounded-full', active ? 'bg-ok' : 'bg-faint')} />
            {active ? `Listening on ${active}` : 'Not subscribed'}
            <span className="tabular-nums">{formatCount(messages.length)} messages</span>
            {!!feed?.dropped && (
              <span className="text-warn" title="Arrived faster than they could be shown">
                {formatCount(feed.dropped)} dropped
              </span>
            )}
            {feed?.error && <span className="text-danger">{feed.error}</span>}
            <div className="flex-1" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter messages"
              className="h-6 w-48 text-xs"
            />
          </div>
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-y-auto bg-canvas font-mono text-xs"
          >
            {!shown.length ? (
              <EmptyState
                icon={<RadioTower className="size-6" />}
                title={active ? 'Waiting for messages…' : 'Subscribe to see messages'}
              >
                Patterns use globs, like <span className="font-mono">orders:*</span>. Watch key
                changes subscribes to keyspace notifications, so every write shows up here.
              </EmptyState>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {shown.map((m) => (
                    <MessageRow key={m.n} message={m} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-2 py-1.5">
            <Input
              mono
              value={publishTo}
              onChange={(e) => setPublishTo(e.target.value)}
              placeholder="Channel"
              className="h-7 w-48 text-xs"
            />
            <Input
              mono
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void publish()}
              placeholder="Message to publish"
              className="h-7 flex-1 text-xs"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={connection?.readOnly}
              onClick={() => void publish()}
            >
              <Send className="size-3.5" /> Publish
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function MessageRow({ message }: { message: PubSubMessage }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const text = dataText(message.payload)
  const pretty = open ? prettyJson(text) : null
  return (
    <tr
      className="cursor-default border-b border-line/50 align-top hover:bg-hover/40"
      onClick={() => setOpen(!open)}
    >
      <td className="w-24 px-3 py-1 whitespace-nowrap text-faint tabular-nums">
        {new Date(message.at).toLocaleTimeString(undefined, { hour12: false })}
        <span className="text-faint/70">.{String(message.at % 1000).padStart(3, '0')}</span>
      </td>
      <td
        className="w-64 max-w-64 truncate px-2 py-1 text-syn-prop"
        title={message.pattern ? `via ${message.pattern}` : undefined}
      >
        {message.channel}
      </td>
      <td className="px-2 py-1 text-fg">
        {open ? (
          <pre className="break-all whitespace-pre-wrap select-text">{pretty ?? text}</pre>
        ) : (
          <span className="line-clamp-1 break-all">{text}</span>
        )}
      </td>
    </tr>
  )
}
