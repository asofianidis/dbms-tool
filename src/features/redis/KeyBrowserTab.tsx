import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Filter,
  Folder,
  FolderOpen,
  KeyRound,
  ListTree,
  List as ListIcon,
  Plus,
  RefreshCw,
  Search,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-react'
import { api, type RData, type RedisKeyEntry } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCount, plural } from '@/lib/format'
import { queries } from '@/lib/queries'
import {
  KEY_TYPES,
  buildKeyTree,
  dataKey,
  dataText,
  flattenKeyTree,
  formatTtl,
  quoteData,
  sameData,
  scanPattern,
  type KeyFolder,
  type KeyRow
} from '@/lib/redis'
import { createPersistentStore } from '@/lib/store'
import { toast, toastError } from '@/lib/toast'
import {
  confirm,
  connectionsStore,
  newQueryTab,
  statusStore,
  updateTab,
  type TabOf
} from '@/lib/workspace'
import { showContextMenu, type MenuItem } from '@/components/ContextMenu'
import { Button, EmptyState, ErrorText, Input, Select, Spinner } from '@/components/ui'
import { KeyEditor } from './KeyEditor'
import { NewKeyDialog } from './NewKeyDialog'
import { NotConnected, TypeBadge, refreshKeyCounts } from './common'

const PAGE = 500
/** "Load all" stops here; past it, narrow the pattern instead. */
const LOAD_ALL_LIMIT = 100_000
const ROW_HEIGHT = 24

const prefsStore = createPersistentStore<{ view: 'tree' | 'list'; delimiter: string }>(
  'dbms.redis.browser.v1',
  { view: 'tree', delimiter: ':' }
)

export function KeyBrowserTab({ tab }: { tab: TabOf<'redisKeys'> }): React.JSX.Element {
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const prefs = prefsStore.use()
  const connection = connections.find((c) => c.id === tab.connectionId)
  const connected = statuses[tab.connectionId]?.state === 'connected'
  const readOnly = !!connection?.readOnly
  const session = tab.id
  const layout = useDefaultLayout({ id: 'redis-keys-split', storage: localStorage })

  const [input, setInput] = useState(tab.pattern ?? '')
  const [typeFilter, setTypeFilter] = useState('')
  const [keys, setKeys] = useState<RedisKeyEntry[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [scanned, setScanned] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<RData | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState<string | null>(null)
  const loadToken = useRef(0)
  const stopAll = useRef(false)

  const pattern = scanPattern(tab.pattern ?? '')
  const dbs = useQuery({ ...queries.databases(tab.connectionId), enabled: connected })
  const total = dbs.data?.find((d) => d.name === tab.database)?.keys

  const load = useCallback(
    async (from: string | null): Promise<string | null> => {
      const token = ++loadToken.current
      setLoading(true)
      try {
        const out = await api.redis(tab.connectionId, session, {
          op: 'scan',
          database: tab.database,
          cursor: from,
          pattern,
          keyType: typeFilter || undefined,
          count: PAGE
        })
        if (token !== loadToken.current) return null
        setKeys((prev) => {
          if (!from) return out.keys
          const seen = new Set(prev.map((k) => dataKey(k.key)))
          return [...prev, ...out.keys.filter((k) => !seen.has(dataKey(k.key)))]
        })
        setScanned((s) => (from ? s : 0) + out.scanned)
        setCursor(out.cursor)
        setError(null)
        return out.cursor
      } catch (e) {
        if (token === loadToken.current) setError(e)
        return null
      } finally {
        if (token === loadToken.current) setLoading(false)
      }
    },
    [tab.connectionId, tab.database, session, pattern, typeFilter]
  )

  const reload = useCallback(() => {
    setChecked(new Set())
    void load(null)
  }, [load])

  useEffect(() => {
    if (connected) reload()
  }, [connected, reload])

  // A pattern set from outside (explorer, palette) shows in the box
  useEffect(() => setInput(tab.pattern ?? ''), [tab.pattern])

  const loadAll = async (): Promise<void> => {
    stopAll.current = false
    let next = cursor
    let count = keys.length
    while (next && !stopAll.current && count < LOAD_ALL_LIMIT) {
      next = await load(next)
      count += PAGE
    }
    if (next && count >= LOAD_ALL_LIMIT)
      toast(
        `Stopped after ${formatCount(LOAD_ALL_LIMIT)} keys; narrow the pattern to see the rest`,
        'info'
      )
  }

  const applyFilter = (): void =>
    updateTab(tab.id, { pattern: input.trim() } as Partial<typeof tab>)

  const rows = useMemo((): KeyRow[] => {
    if (prefs.view === 'list' || !prefs.delimiter)
      return [...keys]
        .sort((a, b) => dataText(a.key).localeCompare(dataText(b.key)))
        .map((entry) => ({ kind: 'key', depth: 0, entry, label: dataText(entry.key) }))
    return flattenKeyTree(buildKeyTree(keys, prefs.delimiter), open)
  }, [keys, prefs.view, prefs.delimiter, open])

  const listRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20
  })

  const toggleFolder = (id: string): void =>
    setOpen((o) => {
      const next = new Set(o)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const removeKeys = (gone: RData[]): void => {
    const ids = new Set(gone.map(dataKey))
    setKeys((ks) => ks.filter((k) => !ids.has(dataKey(k.key))))
    setChecked(new Set())
    if (selected && ids.has(dataKey(selected))) setSelected(null)
  }

  const deleteKeys = async (list: RData[]): Promise<void> => {
    if (!list.length) return
    const ok = await confirm({
      title: list.length === 1 ? `Delete ${dataText(list[0])}?` : `Delete ${list.length} keys?`,
      message:
        list.length === 1
          ? 'The key and its value are removed from the server.'
          : 'These keys and their values are removed from the server.',
      code: list.length > 1 ? list.slice(0, 50).map(dataText).join('\n') : undefined,
      confirmLabel: list.length === 1 ? 'Delete key' : `Delete ${list.length} keys`,
      danger: true
    })
    if (!ok) return
    try {
      await api.redis(tab.connectionId, session, {
        op: 'delete',
        database: tab.database,
        keys: list
      })
      removeKeys(list)
      refreshKeyCounts(tab.connectionId)
      toast(list.length === 1 ? `Deleted ${dataText(list[0])}` : `Deleted ${list.length} keys`)
    } catch (e) {
      toastError(e)
    }
  }

  const deleteFolder = async (folder: KeyFolder): Promise<void> => {
    const match = folder.match
    const ok = await confirm({
      title: `Delete everything under ${folder.prefix}?`,
      message: `Every key matching ${dataText(match)} in database ${tab.database} is deleted, including keys that aren't loaded here (${plural(folder.count, 'key')} loaded).`,
      confirmLabel: 'Delete keys',
      danger: true
    })
    if (!ok) return
    try {
      const out = await api.redis(tab.connectionId, session, {
        op: 'deleteMatching',
        database: tab.database,
        pattern: match
      })
      const n = out.reply?.t === 'int' ? Number(out.reply.v) : 0
      toast(`Deleted ${plural(n, 'key')}`)
      refreshKeyCounts(tab.connectionId)
      reload()
    } catch (e) {
      toastError(e)
    }
  }

  const keyMenu = (e: React.MouseEvent, entry: RedisKeyEntry): void => {
    const name = dataText(entry.key)
    const targets = checked.has(dataKey(entry.key))
      ? keys.filter((k) => checked.has(dataKey(k.key))).map((k) => k.key)
      : [entry.key]
    const items: MenuItem[] = [
      { heading: targets.length > 1 ? `${targets.length} keys` : name },
      { label: 'Open', icon: <KeyRound />, onSelect: () => setSelected(entry.key) },
      {
        label: 'Copy name',
        icon: <Copy />,
        onSelect: () =>
          void navigator.clipboard
            .writeText(targets.map(dataText).join('\n'))
            .then(() => toast(targets.length > 1 ? 'Key names copied' : 'Key name copied'))
      },
      {
        label: 'Open in console',
        icon: <SquareTerminal />,
        onSelect: () => newQueryTab(tab.connectionId, tab.database, `TYPE ${quoteData(entry.key)}`)
      },
      ...(readOnly
        ? []
        : ([
            'separator',
            {
              label: targets.length > 1 ? `Delete ${targets.length} keys…` : 'Delete…',
              icon: <Trash2 />,
              danger: true,
              onSelect: () => void deleteKeys(targets)
            }
          ] as MenuItem[]))
    ]
    showContextMenu(e, items)
  }

  const folderMenu = (e: React.MouseEvent, folder: KeyFolder): void => {
    const items: MenuItem[] = [
      { heading: folder.prefix },
      {
        label: 'Show only this folder',
        icon: <Filter />,
        onSelect: () => updateTab(tab.id, { pattern: folder.filter } as Partial<typeof tab>)
      },
      {
        label: 'Copy prefix',
        icon: <Copy />,
        onSelect: () =>
          void navigator.clipboard.writeText(folder.prefix).then(() => toast('Prefix copied'))
      },
      ...(readOnly
        ? []
        : ([
            {
              label: 'New key here…',
              icon: <Plus />,
              onSelect: () => setCreating(folder.prefix)
            },
            'separator',
            {
              label: 'Delete all keys under this prefix…',
              icon: <Trash2 />,
              danger: true,
              onSelect: () => void deleteFolder(folder)
            }
          ] as MenuItem[]))
    ]
    showContextMenu(e, items)
  }

  const clickKey = (e: React.MouseEvent, entry: RedisKeyEntry): void => {
    if (e.ctrlKey || e.metaKey) {
      const id = dataKey(entry.key)
      setChecked((c) => {
        const next = new Set(c)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      return
    }
    setChecked(new Set())
    setSelected(entry.key)
  }

  /** Arrow keys move through keys; Delete removes the selection. */
  const onListKey = (e: React.KeyboardEvent): void => {
    const keyRows = rows.flatMap((r, i) => (r.kind === 'key' ? [{ i, entry: r.entry }] : []))
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const at = selected ? keyRows.findIndex((r) => sameData(r.entry.key, selected)) : -1
      const next =
        keyRows[Math.min(keyRows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) {
        setSelected(next.entry.key)
        virtualizer.scrollToIndex(next.i)
      }
    } else if (e.key === 'Delete' && !readOnly) {
      const list = checked.size
        ? keys.filter((k) => checked.has(dataKey(k.key))).map((k) => k.key)
        : selected
          ? [selected]
          : []
      void deleteKeys(list)
    }
  }

  if (!connected)
    return (
      <div className="flex h-full flex-col">
        <NotConnected connection={connection} />
      </div>
    )

  const checkedKeys = checked.size ? keys.filter((k) => checked.has(dataKey(k.key))) : []

  return (
    <>
      {creating !== null && (
        <NewKeyDialog
          connectionId={tab.connectionId}
          database={tab.database}
          session={session}
          prefix={creating}
          onClose={() => setCreating(null)}
          onCreated={(key) => {
            setCreating(null)
            refreshKeyCounts(tab.connectionId)
            toast(`Created ${dataText(key)}`)
            setKeys((ks) => [
              ...ks.filter((k) => !sameData(k.key, key)),
              { key, type: '', ttl: -1 }
            ])
            setSelected(key)
          }}
        />
      )}
      <Group
        orientation="horizontal"
        className="h-full min-h-0"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <Panel id="keys" minSize={220} defaultSize="38%">
          <div className="flex h-full min-h-0 flex-col border-r border-line bg-panel">
            <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
                <Input
                  mono
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && applyFilter()}
                  onBlur={() => input.trim() !== (tab.pattern ?? '') && applyFilter()}
                  placeholder="Filter: text or pattern like user:*"
                  className="h-7 pl-7 text-xs"
                  title="Plain text matches anywhere in the key name; * ? and [ ] are glob patterns"
                />
                {input && (
                  <button
                    type="button"
                    className="absolute top-1/2 right-1.5 -translate-y-1/2 text-faint hover:text-bright"
                    onClick={() => {
                      setInput('')
                      updateTab(tab.id, { pattern: '' } as Partial<typeof tab>)
                    }}
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
              <Select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="w-28 shrink-0"
                selectClassName="h-7 text-xs"
                title="Only keys of this type"
              >
                <option value="">All types</option>
                {KEY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2 text-[11px] text-muted">
              <span className="truncate" title={`${formatCount(scanned)} keys scanned`}>
                {formatCount(keys.length)}
                {pattern === '*' && !typeFilter && total !== undefined
                  ? ` of ${formatCount(total)}`
                  : cursor
                    ? '+'
                    : ''}{' '}
                {keys.length === 1 ? 'key' : 'keys'}
              </span>
              {loading && <Spinner className="size-3" />}
              <div className="flex-1" />
              <Button
                size="icon-sm"
                variant="ghost"
                title={prefs.view === 'tree' ? 'Show a flat list' : 'Group into folders'}
                onClick={() =>
                  prefsStore.set((p) => ({ ...p, view: p.view === 'tree' ? 'list' : 'tree' }))
                }
              >
                {prefs.view === 'tree' ? (
                  <ListIcon className="size-3.5" />
                ) : (
                  <ListTree className="size-3.5" />
                )}
              </Button>
              {prefs.view === 'tree' && (
                <input
                  value={prefs.delimiter}
                  onChange={(e) => prefsStore.set((p) => ({ ...p, delimiter: e.target.value }))}
                  title="Folder delimiter"
                  spellCheck={false}
                  className="h-5 w-7 rounded border border-line-strong bg-canvas text-center font-mono text-[11px] text-bright outline-none focus:border-accent/60"
                />
              )}
              <Button size="icon-sm" variant="ghost" title="Reload" onClick={reload}>
                <RefreshCw className="size-3.5" />
              </Button>
              {!readOnly && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="New key"
                  onClick={() => setCreating('')}
                >
                  <Plus className="size-3.5" />
                </Button>
              )}
            </div>
            {checkedKeys.length > 0 && (
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-sel/40 px-2 text-[11px] text-bright">
                {checkedKeys.length} selected
                <div className="flex-1" />
                <Button size="xs" variant="ghost" onClick={() => setChecked(new Set())}>
                  Clear
                </Button>
                {!readOnly && (
                  <Button
                    size="xs"
                    variant="danger"
                    onClick={() => void deleteKeys(checkedKeys.map((k) => k.key))}
                  >
                    <Trash2 className="size-3" /> Delete
                  </Button>
                )}
              </div>
            )}
            {error ? (
              <div className="space-y-2 p-3">
                <ErrorText error={error} />
                <Button size="xs" onClick={reload}>
                  Retry
                </Button>
              </div>
            ) : !keys.length && !loading ? (
              <EmptyState
                icon={<KeyRound className="size-6" />}
                title={cursor ? 'No matches yet' : 'No keys'}
              >
                {cursor
                  ? 'The keys scanned so far don’t match. Load more to keep scanning.'
                  : pattern !== '*' || typeFilter
                    ? 'Nothing matches the filter.'
                    : `Database ${tab.database} is empty.`}
              </EmptyState>
            ) : (
              <div
                ref={listRef}
                tabIndex={0}
                onKeyDown={onListKey}
                className="min-h-0 flex-1 overflow-y-auto outline-none"
              >
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((item) => {
                    const row = rows[item.index]
                    const style = {
                      position: 'absolute' as const,
                      top: 0,
                      left: 0,
                      right: 0,
                      height: ROW_HEIGHT,
                      transform: `translateY(${item.start}px)`,
                      paddingLeft: 8 + row.depth * 14
                    }
                    if (row.kind === 'folder') {
                      const isOpen = open.has(row.folder.id)
                      return (
                        <div
                          key={`f:${row.folder.id}`}
                          style={style}
                          onClick={() => toggleFolder(row.folder.id)}
                          onContextMenu={(e) => folderMenu(e, row.folder)}
                          className="flex cursor-default items-center gap-1 pr-2 text-xs text-fg hover:bg-hover"
                        >
                          {isOpen ? (
                            <ChevronDown className="size-3 shrink-0 text-faint" />
                          ) : (
                            <ChevronRight className="size-3 shrink-0 text-faint" />
                          )}
                          {isOpen ? (
                            <FolderOpen className="size-3.5 shrink-0 text-warn/80" />
                          ) : (
                            <Folder className="size-3.5 shrink-0 text-warn/80" />
                          )}
                          <span className="min-w-0 flex-1 truncate font-mono">
                            {row.folder.name || '(empty)'}
                          </span>
                          <span className="shrink-0 text-[10.5px] text-faint tabular-nums">
                            {formatCount(row.folder.count)}
                          </span>
                        </div>
                      )
                    }
                    const { entry } = row
                    const isSelected = !!selected && sameData(selected, entry.key)
                    const isChecked = checked.has(dataKey(entry.key))
                    return (
                      <div
                        key={`k:${dataKey(entry.key)}`}
                        style={style}
                        onClick={(e) => clickKey(e, entry)}
                        onContextMenu={(e) => keyMenu(e, entry)}
                        className={cn(
                          'flex cursor-default items-center gap-1.5 pr-2 text-xs',
                          isSelected
                            ? 'bg-sel text-bright'
                            : isChecked
                              ? 'bg-sel/50 text-bright'
                              : 'text-fg hover:bg-hover'
                        )}
                        title={dataText(entry.key)}
                      >
                        {prefs.view === 'tree' && <span className="w-3 shrink-0" />}
                        <TypeBadge type={entry.type} />
                        <span className="min-w-0 flex-1 truncate font-mono">{row.label}</span>
                        {entry.ttl >= 0 && (
                          <span
                            className={cn(
                              'shrink-0 text-[10.5px] tabular-nums',
                              entry.ttl < 60_000 ? 'text-warn' : 'text-faint'
                            )}
                            title="Time to live when loaded"
                          >
                            {formatTtl(entry.ttl)}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {cursor && !error && (
              <div className="flex shrink-0 items-center justify-center gap-2 border-t border-line py-1.5">
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={loading}
                  onClick={() => void load(cursor)}
                >
                  Load more
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={loading}
                  onClick={() => void loadAll()}
                  title={`Keep scanning until every matching key is loaded (up to ${formatCount(LOAD_ALL_LIMIT)})`}
                >
                  Load all
                </Button>
                {loading && (
                  <Button size="xs" variant="ghost" onClick={() => (stopAll.current = true)}>
                    Stop
                  </Button>
                )}
              </div>
            )}
          </div>
        </Panel>
        <Separator />
        <Panel id="value" minSize={300}>
          <div className="h-full min-h-0 bg-canvas">
            {selected ? (
              <KeyEditor
                key={dataKey(selected)}
                connectionId={tab.connectionId}
                database={tab.database}
                session={session}
                readOnly={readOnly}
                keyName={selected}
                onDeleted={() => removeKeys([selected])}
                onRenamed={(key) => {
                  setKeys((ks) => ks.map((k) => (sameData(k.key, selected) ? { ...k, key } : k)))
                  setSelected(key)
                }}
                onMeta={({ ttl, type }) =>
                  setKeys((ks) =>
                    ks.map((k) => (sameData(k.key, selected) ? { ...k, ttl, type } : k))
                  )
                }
              />
            ) : (
              <EmptyState
                icon={<KeyRound className="size-6" />}
                title="Pick a key"
                actions={
                  !readOnly && (
                    <Button size="sm" onClick={() => setCreating('')}>
                      <Plus className="size-3.5" /> New key
                    </Button>
                  )
                }
              >
                Click a key to see and edit its value. Ctrl+click picks several; right-click a
                folder to filter or delete by prefix.
              </EmptyState>
            )}
          </div>
        </Panel>
      </Group>
    </>
  )
}
