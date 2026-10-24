import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Braces,
  Clock,
  Copy,
  Pencil,
  Plus,
  RefreshCw,
  SquareTerminal,
  Trash2,
  WrapText
} from 'lucide-react'
import { api, type RData, type RedisOutput, type RedisRequest } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatBytes, formatCount } from '@/lib/format'
import { dataBytes, dataText, formatTtl, isHex, parseTtl, prettyJson, quoteArg } from '@/lib/redis'
import { settingsStore } from '@/lib/settings'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { confirm, newQueryTab, promptText } from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { Button, EmptyState, ErrorText, Input, Modal, Segmented, Spinner } from '@/components/ui'
import { TypeBadge, refreshKeyCounts } from './common'

const PAGE = 200

interface Props {
  connectionId: string
  database: string
  session: string
  readOnly: boolean
  keyName: RData
  onDeleted: () => void
  onRenamed: (key: RData) => void
  /** The key's TTL or type changed, for the list on the left */
  onMeta: (meta: { ttl: number; type: string }) => void
}

type Loaded = RedisOutput & { loadedAt: number }

export function KeyEditor(props: Props): React.JSX.Element {
  const { connectionId, database, session, keyName } = props
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)
  const [more, setMore] = useState(false)
  const keyText = dataText(keyName)

  const request = useCallback(
    (r: RedisRequest) => api.redis(connectionId, session, r),
    [connectionId, session]
  )

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const out = await request({ op: 'get', database, key: keyName, count: PAGE })
      setData({ ...out, loadedAt: Date.now() })
      setError(null)
      if (out.type && out.ttl !== null) props.onMeta({ ttl: out.ttl, type: out.type })
    } catch (e) {
      setError(e)
      setData(null)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, database, keyText])

  useEffect(() => {
    setData(null)
    void load()
  }, [load])

  const loadMore = async (): Promise<void> => {
    if (!data?.cursor) return
    setMore(true)
    try {
      const listLike = data.type === 'list' || data.type === 'zset'
      const out = await request({
        op: 'get',
        database,
        key: keyName,
        count: PAGE,
        ...(listLike ? { offset: Number(data.cursor) } : { cursor: data.cursor })
      })
      setData((d) => d && { ...d, entries: [...d.entries, ...out.entries], cursor: out.cursor })
    } catch (e) {
      toastError(e)
    } finally {
      setMore(false)
    }
  }

  /** Runs a write, then reloads the key. */
  const write = async (r: RedisRequest, done?: string): Promise<boolean> => {
    try {
      await request(r)
      if (done) toast(done)
      await load()
      return true
    } catch (e) {
      toastError(e)
      return false
    }
  }

  const rename = async (): Promise<void> => {
    const name = await promptText({
      title: 'Rename key',
      label: 'New name (fails if a key with that name exists)',
      initial: keyText,
      confirmLabel: 'Rename'
    })
    if (!name || name === keyText) return
    try {
      await request({ op: 'rename', database, key: keyName, newKey: name })
      toast(`Renamed to ${name}`)
      props.onRenamed(name)
    } catch (e) {
      toastError(e)
    }
  }

  const setTtl = async (): Promise<void> => {
    const current = data?.ttl ?? -1
    const text = await promptText({
      title: 'Time to live',
      label: 'Expire after, e.g. 90s, 15m, 1h30m or 7d. Leave empty to keep the key forever.',
      initial: current > 0 ? formatTtl(current).replace(/\s/g, '') : '',
      confirmLabel: 'Set TTL'
    })
    if (text === null) return
    let ttlMs: number | null
    try {
      ttlMs = parseTtl(text)
    } catch (e) {
      return toastError(e)
    }
    await write(
      { op: 'expire', database, key: keyName, ttlMs },
      ttlMs ? `Expires in ${formatTtl(ttlMs)}` : 'The key no longer expires'
    )
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${keyText}?`,
      message: 'The key and its value are removed from the server.',
      confirmLabel: 'Delete key',
      danger: true
    })
    if (!ok) return
    try {
      await request({ op: 'delete', database, keys: [keyName] })
      toast(`Deleted ${keyText}`)
      refreshKeyCounts(connectionId)
      props.onDeleted()
    } catch (e) {
      toastError(e)
    }
  }

  const openInConsole = (): void => {
    const k = quoteArg(keyText)
    const command: Record<string, string> = {
      string: `GET ${k}`,
      hash: `HGETALL ${k}`,
      list: `LRANGE ${k} 0 -1`,
      set: `SMEMBERS ${k}`,
      zset: `ZRANGE ${k} 0 -1 WITHSCORES`,
      stream: `XREVRANGE ${k} + - COUNT 20`,
      'ReJSON-RL': `JSON.GET ${k}`
    }
    newQueryTab(connectionId, database, command[data?.type ?? ''] ?? `TYPE ${k}`)
  }

  if (error)
    return (
      <EmptyState
        title="Couldn't load the key"
        actions={
          <Button size="sm" onClick={() => void load()}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        }
      >
        <ErrorText error={error} />
      </EmptyState>
    )
  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )

  const type = data.type ?? ''
  const ro = props.readOnly
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line bg-panel px-3 py-2">
        <div className="flex items-center gap-2">
          <TypeBadge type={type} />
          <span
            className="min-w-0 flex-1 truncate font-mono text-[13px] text-bright select-text"
            title={keyText}
          >
            {keyText}
          </span>
          {loading && <Spinner className="size-3.5" />}
          <Button
            size="icon-sm"
            variant="ghost"
            title="Copy key name"
            onClick={() =>
              void navigator.clipboard.writeText(keyText).then(() => toast('Key name copied'))
            }
          >
            <Copy className="size-3.5" />
          </Button>
          <Button size="icon-sm" variant="ghost" title="Open in console" onClick={openInConsole}>
            <SquareTerminal className="size-3.5" />
          </Button>
          <Button size="icon-sm" variant="ghost" title="Reload" onClick={() => void load()}>
            <RefreshCw className="size-3.5" />
          </Button>
          {!ro && (
            <>
              <Button size="icon-sm" variant="ghost" title="Rename" onClick={() => void rename()}>
                <Pencil className="size-3.5" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title="Delete key"
                onClick={() => void remove()}
              >
                <Trash2 className="size-3.5 text-danger" />
              </Button>
            </>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
          <button
            type="button"
            disabled={ro}
            onClick={() => void setTtl()}
            className="flex items-center gap-1 hover:text-bright disabled:pointer-events-none"
            title={ro ? 'Time to live' : 'Change the time to live'}
          >
            <Clock className="size-3" />
            <LiveTtl ttl={data.ttl ?? -1} loadedAt={data.loadedAt} onExpired={() => void load()} />
          </button>
          {data.length !== null && (
            <span>
              {formatCount(data.length)}{' '}
              {type === 'string'
                ? 'bytes'
                : type === 'hash'
                  ? 'fields'
                  : type === 'stream'
                    ? 'entries'
                    : type === 'list'
                      ? 'items'
                      : 'members'}
            </span>
          )}
          {data.memory !== null && (
            <span title="MEMORY USAGE">{formatBytes(data.memory)} in memory</span>
          )}
          {data.encoding && <span title="OBJECT ENCODING">{data.encoding}</span>}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {type === 'string' && (
          <StringValue
            data={data}
            readOnly={ro}
            onSave={(value) =>
              write({ op: 'set', database, key: keyName, value, keepTtl: true }, 'Saved')
            }
          />
        )}
        {type === 'ReJSON-RL' && (
          <StringValue
            data={data}
            readOnly={ro}
            json
            onSave={(value) =>
              write({ op: 'jsonSet', database, key: keyName, json: dataText(value) }, 'Saved')
            }
          />
        )}
        {type === 'hash' && (
          <HashValue
            data={data}
            readOnly={ro}
            database={database}
            keyName={keyName}
            write={write}
          />
        )}
        {type === 'list' && (
          <ListValue
            data={data}
            readOnly={ro}
            database={database}
            keyName={keyName}
            write={write}
          />
        )}
        {type === 'set' && (
          <SetValue data={data} readOnly={ro} database={database} keyName={keyName} write={write} />
        )}
        {type === 'zset' && (
          <ZsetValue
            data={data}
            readOnly={ro}
            database={database}
            keyName={keyName}
            write={write}
          />
        )}
        {type === 'stream' && (
          <StreamValue
            data={data}
            readOnly={ro}
            database={database}
            keyName={keyName}
            write={write}
          />
        )}
        {!['string', 'ReJSON-RL', 'hash', 'list', 'set', 'zset', 'stream'].includes(type) && (
          <EmptyState title={`${type} keys can't be shown here`}>
            Module types are read with their own commands; open the key in the console.
          </EmptyState>
        )}
      </div>
      {data.cursor && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-line bg-panel py-1.5 text-[11px] text-muted">
          Showing {formatCount(data.entries.length)}
          {data.length !== null && ` of ${formatCount(data.length)}`}
          <Button size="xs" variant="secondary" disabled={more} onClick={() => void loadMore()}>
            {more ? <Spinner className="size-3" /> : null} Load {PAGE} more
          </Button>
        </div>
      )}
    </div>
  )
}

/** Counts down between reloads so the TTL shown stays true. */
function LiveTtl({
  ttl,
  loadedAt,
  onExpired
}: {
  ttl: number
  loadedAt: number
  onExpired: () => void
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (ttl < 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ttl])
  const left = ttl < 0 ? -1 : ttl - (now - loadedAt)
  const expired = ttl >= 0 && left <= 0
  useEffect(() => {
    if (expired) onExpired()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired])
  return (
    <span className={cn(ttl >= 0 && left < 60_000 && 'text-warn')}>
      {ttl < 0 ? 'No expiry' : expired ? 'Expired' : `Expires in ${formatTtl(left)}`}
    </span>
  )
}

/* ---------- Strings and JSON ---------- */

function StringValue({
  data,
  readOnly,
  json,
  onSave
}: {
  data: Loaded
  readOnly: boolean
  json?: boolean
  onSave: (value: RData) => Promise<boolean>
}): React.JSX.Element {
  const settings = settingsStore.use()
  const original = data.value ?? ''
  const binary = isHex(original)
  const text = binary ? '' : original
  const pretty = useMemo(() => (binary ? null : prettyJson(text)), [binary, text])
  const [view, setView] = useState<'text' | 'json'>(json || pretty ? 'json' : 'text')
  const shown = view === 'json' && pretty ? pretty : text
  const [draft, setDraft] = useState(shown)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(shown), [shown])

  if (binary) return <HexView value={original} />

  const dirty = draft !== shown
  const canEdit = !readOnly && !data.truncated
  const save = async (): Promise<void> => {
    let value = draft
    // Pretty-printing is only for reading; store JSON as compactly as it came
    if (view === 'json' && pretty && !json) {
      try {
        const compact = !/\n\s/.test(text)
        value = compact ? JSON.stringify(JSON.parse(draft)) : draft
      } catch {
        value = draft
      }
    }
    setSaving(true)
    await onSave(value)
    setSaving(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel/60 px-2">
        {(pretty || json) && (
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            options={[
              {
                value: 'json',
                label: (
                  <>
                    <Braces className="size-3" /> JSON
                  </>
                )
              },
              {
                value: 'text',
                label: (
                  <>
                    <WrapText className="size-3" /> Raw
                  </>
                )
              }
            ]}
          />
        )}
        {data.truncated && (
          <span className="text-[11px] text-warn">
            Showing the first {formatBytes(dataBytes(text))}; large values are read-only here.
          </span>
        )}
        <div className="flex-1" />
        {canEdit && (
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={!dirty || saving}
              onClick={() => setDraft(shown)}
            >
              Discard
            </Button>
            <Button
              size="xs"
              variant="primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving && <Spinner className="size-3" />} Save
            </Button>
          </>
        )}
      </div>
      <CodeEditor
        value={draft}
        onChange={setDraft}
        language={{ kind: view === 'json' && (pretty || json) ? 'json' : 'text' }}
        readOnly={!canEdit}
        fontSize={settings.editorFontSize}
        wordWrap
        keys={[{ key: 'Mod-s', run: () => (canEdit && dirty && void save(), true) }]}
        className="min-h-0 flex-1 bg-canvas"
      />
    </div>
  )
}

function HexView({ value }: { value: RData }): React.JSX.Element {
  const hex = isHex(value) ? value.$hex : ''
  const rows: string[] = []
  for (let i = 0; i < hex.length && rows.length < 4096; i += 32) {
    const chunk = hex.slice(i, i + 32)
    const bytes = chunk.match(/../g) ?? []
    const ascii = bytes
      .map((b) => {
        const n = parseInt(b, 16)
        return n >= 0x20 && n < 0x7f ? String.fromCharCode(n) : '.'
      })
      .join('')
    rows.push(`${(i / 2).toString(16).padStart(8, '0')}  ${bytes.join(' ').padEnd(47)}  ${ascii}`)
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center border-b border-line bg-panel/60 px-3 text-[11px] text-muted">
        Binary value · {formatBytes(hex.length / 2)} · read-only
      </div>
      <pre className="min-h-0 flex-1 overflow-auto bg-canvas p-3 font-mono text-[11.5px] leading-5 text-fg select-text">
        {rows.join('\n')}
      </pre>
    </div>
  )
}

/* ---------- Collections ---------- */

interface CollectionProps {
  data: Loaded
  readOnly: boolean
  database: string
  keyName: RData
  write: (r: RedisRequest, done?: string) => Promise<boolean>
}

interface EditState {
  title: string
  /** Field / member / score inputs above the value */
  fields?: { label: string; value: string; mono?: boolean }[]
  value?: string
  valueLabel?: string
  confirmLabel: string
  onSave: (fields: string[], value: string) => Promise<boolean>
}

function useEditor(): [React.JSX.Element | null, (s: EditState) => void] {
  const [state, setState] = useState<EditState | null>(null)
  const dialog = state && <EditDialog state={state} onClose={() => setState(null)} />
  return [dialog, setState]
}

function EditDialog({
  state,
  onClose
}: {
  state: EditState
  onClose: () => void
}): React.JSX.Element {
  const [fields, setFields] = useState(state.fields?.map((f) => f.value) ?? [])
  const [value, setValue] = useState(state.value ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pretty = state.value !== undefined ? prettyJson(value) : null
  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      if (await state.onSave(fields, value)) onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      title={state.title}
      onClose={onClose}
      width="lg"
      footer={
        <>
          {pretty && pretty !== value && (
            <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setValue(pretty)}>
              <Braces className="size-3.5" /> Format JSON
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving && <Spinner className="size-3.5" />} {state.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {state.fields?.map((f, i) => (
          <label key={f.label} className="block space-y-1.5">
            <span className="text-xs font-medium text-muted">{f.label}</span>
            <Input
              mono={f.mono}
              value={fields[i]}
              onChange={(e) =>
                setFields((all) => all.map((v, j) => (j === i ? e.target.value : v)))
              }
            />
          </label>
        ))}
        {state.value !== undefined && (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted">{state.valueLabel ?? 'Value'}</span>
            <textarea
              value={value}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save()
              }}
              rows={Math.min(16, Math.max(4, value.split('\n').length + 1))}
              className="w-full rounded-md border border-line-strong bg-canvas px-2.5 py-2 font-mono text-xs text-bright focus:border-accent/60 focus:outline-none"
            />
          </label>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </form>
    </Modal>
  )
}

function Cell({ value, className }: { value: unknown; className?: string }): React.JSX.Element {
  const text = dataText(value as RData)
  return (
    <span
      className={cn(
        'block truncate font-mono text-xs select-text',
        isHex(value as RData) ? 'text-syn-number' : 'text-fg',
        className
      )}
      title={text.length > 2000 ? text.slice(0, 2000) + '…' : text}
    >
      {text.replace(/\s+/g, ' ') || <span className="text-faint italic">empty</span>}
    </span>
  )
}

function Table({
  head,
  children,
  filter,
  onFilter,
  actions
}: {
  head: React.ReactNode
  children: React.ReactNode
  filter?: string
  onFilter?: (f: string) => void
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel/60 px-2">
        {onFilter && (
          <Input
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            placeholder="Filter loaded rows"
            className="h-6 w-56 text-xs"
          />
        )}
        <div className="flex-1" />
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-panel text-[11px] text-muted">{head}</thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  )
}

const th = 'border-b border-line px-2 py-1.5 font-medium'
const td = 'border-b border-line/60 px-2 py-1 align-top'

function RowActions({
  readOnly,
  onEdit,
  onDelete
}: {
  readOnly: boolean
  onEdit?: () => void
  onDelete?: () => void
}): React.JSX.Element | null {
  if (readOnly) return null
  return (
    <div className="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100">
      {onEdit && (
        <Button size="icon-sm" variant="ghost" title="Edit" onClick={onEdit}>
          <Pencil className="size-3" />
        </Button>
      )}
      {onDelete && (
        <Button size="icon-sm" variant="ghost" title="Remove" onClick={onDelete}>
          <Trash2 className="size-3 text-danger" />
        </Button>
      )}
    </div>
  )
}

function useFiltered<T>(rows: T[], text: (row: T) => string): [T[], string, (f: string) => void] {
  const [filter, setFilter] = useState('')
  const shown = useMemo(() => {
    const f = filter.toLowerCase()
    return f ? rows.filter((r) => text(r).toLowerCase().includes(f)) : rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filter])
  return [shown, filter, setFilter]
}

function HashValue({
  data,
  readOnly,
  database,
  keyName,
  write
}: CollectionProps): React.JSX.Element {
  const [dialog, edit] = useEditor()
  const rows = data.entries as { field: RData; value: RData }[]
  const [shown, filter, setFilter] = useFiltered(
    rows,
    (r) => `${dataText(r.field)} ${dataText(r.value)}`
  )
  const editRow = (row?: { field: RData; value: RData }): void =>
    edit({
      title: row ? `Edit ${dataText(row.field)}` : 'Add field',
      fields: row ? undefined : [{ label: 'Field', value: '', mono: true }],
      value: row ? dataText(row.value) : '',
      confirmLabel: row ? 'Save' : 'Add field',
      onSave: ([field], value) =>
        write(
          {
            op: 'hashSet',
            database,
            key: keyName,
            field: row ? row.field : field,
            value,
            onlyNew: !row
          },
          row ? 'Saved' : 'Field added'
        )
    })
  return (
    <>
      {dialog}
      <Table
        filter={filter}
        onFilter={setFilter}
        actions={
          !readOnly && (
            <Button size="xs" variant="secondary" onClick={() => editRow()}>
              <Plus className="size-3" /> Add field
            </Button>
          )
        }
        head={
          <tr>
            <th className={cn(th, 'w-[35%]')}>Field</th>
            <th className={th}>Value</th>
            <th className={cn(th, 'w-16')} />
          </tr>
        }
      >
        {shown.map((r) => (
          <tr
            key={dataText(r.field)}
            className="group hover:bg-hover/50"
            onDoubleClick={() => !readOnly && editRow(r)}
          >
            <td className={td}>
              <Cell value={r.field} className="text-syn-prop" />
            </td>
            <td className={td}>
              <Cell value={r.value} />
            </td>
            <td className={td}>
              <RowActions
                readOnly={readOnly || isHex(r.value)}
                onEdit={() => editRow(r)}
                onDelete={() =>
                  void write(
                    { op: 'hashDelete', database, key: keyName, fields: [r.field] },
                    'Field removed'
                  )
                }
              />
            </td>
          </tr>
        ))}
      </Table>
    </>
  )
}

function ListValue({
  data,
  readOnly,
  database,
  keyName,
  write
}: CollectionProps): React.JSX.Element {
  const [dialog, edit] = useEditor()
  const rows = data.entries as { index: number; value: RData }[]
  const [shown, filter, setFilter] = useFiltered(rows, (r) => dataText(r.value))
  const push = (head: boolean): void =>
    edit({
      title: head ? 'Push to the head' : 'Push to the tail',
      value: '',
      confirmLabel: head ? 'LPUSH' : 'RPUSH',
      onSave: (_, value) =>
        write({ op: 'listPush', database, key: keyName, values: [value], head }, 'Pushed')
    })
  return (
    <>
      {dialog}
      <Table
        filter={filter}
        onFilter={setFilter}
        actions={
          !readOnly && (
            <>
              <Button size="xs" variant="secondary" onClick={() => push(true)}>
                <Plus className="size-3" /> Head
              </Button>
              <Button size="xs" variant="secondary" onClick={() => push(false)}>
                <Plus className="size-3" /> Tail
              </Button>
            </>
          )
        }
        head={
          <tr>
            <th className={cn(th, 'w-20')}>Index</th>
            <th className={th}>Value</th>
            <th className={cn(th, 'w-16')} />
          </tr>
        }
      >
        {shown.map((r) => {
          const editRow = (): void =>
            edit({
              title: `Edit item ${r.index}`,
              value: dataText(r.value),
              confirmLabel: 'Save',
              onSave: (_, value) =>
                write({ op: 'listSet', database, key: keyName, index: r.index, value }, 'Saved')
            })
          return (
            <tr
              key={r.index}
              className="group hover:bg-hover/50"
              onDoubleClick={() => !readOnly && editRow()}
            >
              <td className={cn(td, 'font-mono text-xs text-faint tabular-nums')}>{r.index}</td>
              <td className={td}>
                <Cell value={r.value} />
              </td>
              <td className={td}>
                <RowActions
                  readOnly={readOnly}
                  onEdit={isHex(r.value) ? undefined : editRow}
                  onDelete={() =>
                    void write(
                      { op: 'listRemove', database, key: keyName, index: r.index },
                      'Item removed'
                    )
                  }
                />
              </td>
            </tr>
          )
        })}
      </Table>
    </>
  )
}

function SetValue({
  data,
  readOnly,
  database,
  keyName,
  write
}: CollectionProps): React.JSX.Element {
  const [dialog, edit] = useEditor()
  const rows = data.entries as { value: RData }[]
  const [shown, filter, setFilter] = useFiltered(rows, (r) => dataText(r.value))
  return (
    <>
      {dialog}
      <Table
        filter={filter}
        onFilter={setFilter}
        actions={
          !readOnly && (
            <Button
              size="xs"
              variant="secondary"
              onClick={() =>
                edit({
                  title: 'Add member',
                  value: '',
                  valueLabel: 'Member',
                  confirmLabel: 'Add member',
                  onSave: (_, value) =>
                    write(
                      { op: 'setAdd', database, key: keyName, members: [value] },
                      'Member added'
                    )
                })
              }
            >
              <Plus className="size-3" /> Add member
            </Button>
          )
        }
        head={
          <tr>
            <th className={th}>Member</th>
            <th className={cn(th, 'w-16')} />
          </tr>
        }
      >
        {shown.map((r) => (
          <tr key={dataText(r.value)} className="group hover:bg-hover/50">
            <td className={td}>
              <Cell value={r.value} />
            </td>
            <td className={td}>
              <RowActions
                readOnly={readOnly}
                onDelete={() =>
                  void write(
                    { op: 'setRemove', database, key: keyName, members: [r.value] },
                    'Member removed'
                  )
                }
              />
            </td>
          </tr>
        ))}
      </Table>
    </>
  )
}

function ZsetValue({
  data,
  readOnly,
  database,
  keyName,
  write
}: CollectionProps): React.JSX.Element {
  const [dialog, edit] = useEditor()
  const rows = data.entries as { rank: number; value: RData; score: number | null }[]
  const [shown, filter, setFilter] = useFiltered(rows, (r) => `${dataText(r.value)} ${r.score}`)
  const score = (text: string): number => {
    const n = Number(
      text
        .trim()
        .replace(/^\+?inf$/i, 'Infinity')
        .replace(/^-inf$/i, '-Infinity')
    )
    if (text.trim() === '' || Number.isNaN(n)) throw new Error('The score must be a number')
    return n
  }
  const editRow = (row?: (typeof rows)[number]): void =>
    edit({
      title: row ? `Score of ${dataText(row.value)}` : 'Add member',
      fields: row
        ? [{ label: 'Score', value: String(row.score ?? 0), mono: true }]
        : [
            { label: 'Member', value: '', mono: true },
            { label: 'Score', value: '0', mono: true }
          ],
      confirmLabel: row ? 'Save' : 'Add member',
      onSave: (f) =>
        write(
          {
            op: 'zsetAdd',
            database,
            key: keyName,
            member: row ? row.value : f[0],
            score: score(row ? f[0] : f[1])
          },
          row ? 'Saved' : 'Member added'
        )
    })
  return (
    <>
      {dialog}
      <Table
        filter={filter}
        onFilter={setFilter}
        actions={
          !readOnly && (
            <Button size="xs" variant="secondary" onClick={() => editRow()}>
              <Plus className="size-3" /> Add member
            </Button>
          )
        }
        head={
          <tr>
            <th className={cn(th, 'w-16')}>Rank</th>
            <th className={cn(th, 'w-36')}>Score</th>
            <th className={th}>Member</th>
            <th className={cn(th, 'w-16')} />
          </tr>
        }
      >
        {shown.map((r) => (
          <tr
            key={dataText(r.value)}
            className="group hover:bg-hover/50"
            onDoubleClick={() => !readOnly && editRow(r)}
          >
            <td className={cn(td, 'font-mono text-xs text-faint tabular-nums')}>{r.rank}</td>
            <td className={cn(td, 'font-mono text-xs text-syn-number tabular-nums')}>{r.score}</td>
            <td className={td}>
              <Cell value={r.value} />
            </td>
            <td className={td}>
              <RowActions
                readOnly={readOnly}
                onEdit={() => editRow(r)}
                onDelete={() =>
                  void write(
                    { op: 'zsetRemove', database, key: keyName, members: [r.value] },
                    'Member removed'
                  )
                }
              />
            </td>
          </tr>
        ))}
      </Table>
    </>
  )
}

function StreamValue({
  data,
  readOnly,
  database,
  keyName,
  write
}: CollectionProps): React.JSX.Element {
  const [dialog, edit] = useEditor()
  const rows = data.entries as { id: string; fields: [RData, RData][] }[]
  const [shown, filter, setFilter] = useFiltered(
    rows,
    (r) => `${r.id} ${r.fields.map(([k, v]) => `${dataText(k)}=${dataText(v)}`).join(' ')}`
  )
  const groups = data.groups as Record<string, unknown>[]
  const add = (): void =>
    edit({
      title: 'Add entry',
      fields: [{ label: 'ID (* lets the server choose)', value: '*', mono: true }],
      value: '{\n  "field": "value"\n}',
      valueLabel: 'Fields, as a JSON object',
      confirmLabel: 'XADD',
      onSave: ([id], value) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(value)
        } catch {
          throw new Error('Enter the fields as a JSON object, e.g. {"temp": "21"}')
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('Enter the fields as a JSON object, e.g. {"temp": "21"}')
        const fields = Object.entries(parsed).map(([k, v]): [RData, RData] => [
          k,
          typeof v === 'string' ? v : JSON.stringify(v)
        ])
        return write({ op: 'streamAdd', database, key: keyName, id, fields }, 'Entry added')
      }
    })
  return (
    <>
      {dialog}
      <div className="flex h-full min-h-0 flex-col">
        {groups.length > 0 && (
          <div className="shrink-0 border-b border-line bg-panel/40 px-2 py-1.5">
            <p className="mb-1 text-[11px] font-medium text-muted">Consumer groups</p>
            <div className="flex flex-wrap gap-1.5">
              {groups.map((g) => (
                <span
                  key={String(g.name)}
                  className="rounded border border-line-strong bg-canvas px-2 py-0.5 font-mono text-[11px] text-fg"
                  title={`Last delivered ${g['last-delivered-id']}`}
                >
                  {String(g.name)}
                  <span className="ml-2 text-faint">
                    {String(g.consumers)} consumers · {String(g.pending)} pending
                    {g.lag !== undefined && g.lag !== null ? ` · lag ${String(g.lag)}` : ''}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Table
            filter={filter}
            onFilter={setFilter}
            actions={
              !readOnly && (
                <Button size="xs" variant="secondary" onClick={add}>
                  <Plus className="size-3" /> Add entry
                </Button>
              )
            }
            head={
              <tr>
                <th className={cn(th, 'w-48')}>ID (newest first)</th>
                <th className={th}>Fields</th>
                <th className={cn(th, 'w-16')} />
              </tr>
            }
          >
            {shown.map((r) => (
              <tr key={r.id} className="group hover:bg-hover/50">
                <td className={cn(td, 'font-mono text-xs text-muted')} title={streamTime(r.id)}>
                  {r.id}
                </td>
                <td className={td}>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-xs">
                    {r.fields.map(([k, v], i) => (
                      <span key={i} className="min-w-0 truncate">
                        <span className="text-syn-prop">{dataText(k)}</span>
                        <span className="text-faint">=</span>
                        <span className="text-fg">{dataText(v)}</span>
                      </span>
                    ))}
                  </div>
                </td>
                <td className={td}>
                  <RowActions
                    readOnly={readOnly}
                    onDelete={() =>
                      void write(
                        { op: 'streamDelete', database, key: keyName, ids: [r.id] },
                        'Entry deleted'
                      )
                    }
                  />
                </td>
              </tr>
            ))}
          </Table>
        </div>
      </div>
    </>
  )
}

/** Stream IDs start with the entry's Unix time in milliseconds. */
function streamTime(id: string): string {
  const ms = Number(id.split('-')[0])
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString() : id
}
