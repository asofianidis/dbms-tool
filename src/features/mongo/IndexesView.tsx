import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { parseShellValue, scalarText, toShell } from '@/lib/ejson'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { confirm, type TabOf } from '@/lib/workspace'
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Modal,
  ProgressBar,
  Toggle
} from '@/components/ui'

type IndexDoc = Record<string, unknown> & { name: string; key: Record<string, unknown> }

export function IndexesView({
  tab,
  readOnly
}: {
  tab: TabOf<'collection'>
  readOnly: boolean
}): React.JSX.Element {
  const [indexes, setIndexes] = useState<IndexDoc[] | null>(null)
  const [usage, setUsage] = useState<Record<string, { ops: string; since: string }>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const out = await api.mongo(tab.connectionId, tab.id, {
        op: 'listIndexes',
        database: tab.database,
        collection: tab.collection
      })
      setIndexes(out.documents as IndexDoc[])
      // Usage stats need the indexStats privilege; skip quietly without it
      const stats = await api
        .mongo(tab.connectionId, tab.id, {
          op: 'aggregate',
          database: tab.database,
          collection: tab.collection,
          pipeline: [{ $indexStats: {} }]
        })
        .catch(() => null)
      if (stats) {
        setUsage(
          Object.fromEntries(
            stats.documents.map((d) => {
              const accesses = d.accesses as { ops?: unknown; since?: unknown } | undefined
              return [
                String(d.name),
                { ops: scalarText(accesses?.ops), since: scalarText(accesses?.since) }
              ]
            })
          )
        )
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [tab.connectionId, tab.id, tab.database, tab.collection])

  useEffect(() => {
    void load()
  }, [load])

  const drop = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: `Drop index ${name}?`,
      message: 'Queries that rely on it will fall back to other indexes or collection scans.',
      confirmLabel: 'Drop index',
      danger: true
    })
    if (!ok) return
    try {
      await api.mongo(tab.connectionId, '__meta', {
        op: 'dropIndex',
        database: tab.database,
        collection: tab.collection,
        name
      })
      toast(`Dropped ${name}`)
      void load()
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        {!readOnly && (
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> Create index
          </Button>
        )}
        <Button size="icon" variant="ghost" title="Refresh" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <ProgressBar active={loading} />
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4">
            <ErrorText error={error} />
          </div>
        ) : !indexes ? null : !indexes.length ? (
          <EmptyState title="No indexes" />
        ) : (
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-[11px] text-muted">
              <tr className="border-b border-line">
                <th className="px-3 py-1.5 font-medium">Name</th>
                <th className="px-3 py-1.5 font-medium">Keys</th>
                <th className="px-3 py-1.5 font-medium">Properties</th>
                <th className="px-3 py-1.5 font-medium">Usage</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="select-text">
              {indexes.map((ix) => (
                <tr key={ix.name} className="border-b border-line/60 hover:bg-hover/40">
                  <td className="px-3 py-2 font-mono text-bright">
                    <span className="flex items-center gap-1.5">
                      <KeyRound
                        className={
                          ix.name === '_id_' ? 'size-3.5 text-warn' : 'size-3.5 text-faint'
                        }
                      />
                      {ix.name}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[12px] text-fg">{toShell(ix.key, 0)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {!!ix.unique && <Badge tone="info">unique</Badge>}
                      {!!ix.sparse && <Badge>sparse</Badge>}
                      {ix.expireAfterSeconds != null && (
                        <Badge tone="warning">TTL {scalarText(ix.expireAfterSeconds)}s</Badge>
                      )}
                      {ix.partialFilterExpression != null && (
                        <Badge title={toShell(ix.partialFilterExpression, 0)}>partial</Badge>
                      )}
                      {!!ix.hidden && <Badge>hidden</Badge>}
                      {Object.values(ix.key).some((v) => v === 'text') && (
                        <Badge tone="accent">text</Badge>
                      )}
                      {Object.values(ix.key).some(
                        (v) => typeof v === 'string' && v.startsWith('2d')
                      ) && <Badge tone="accent">geo</Badge>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[11.5px] text-muted">
                    {usage[ix.name] ? (
                      <span title={`since ${usage[ix.name].since}`}>
                        {Number(usage[ix.name].ops).toLocaleString()} ops
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-2">
                    {ix.name !== '_id_' && !readOnly && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Drop index"
                        onClick={() => void drop(ix.name)}
                        className="hover:text-danger"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <CreateIndexDialog
          tab={tab}
          onClose={() => setCreating(false)}
          onCreated={() => void load()}
        />
      )}
    </div>
  )
}

function CreateIndexDialog({
  tab,
  onClose,
  onCreated
}: {
  tab: TabOf<'collection'>
  onClose: () => void
  onCreated: () => void
}): React.JSX.Element {
  const [keys, setKeys] = useState('{ field: 1 }')
  const [name, setName] = useState('')
  const [unique, setUnique] = useState(false)
  const [sparse, setSparse] = useState(false)
  const [ttl, setTtl] = useState('')
  const [partial, setPartial] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    setError(null)
    try {
      const options: Record<string, unknown> = {}
      if (name.trim()) options.name = name.trim()
      if (unique) options.unique = true
      if (sparse) options.sparse = true
      if (ttl.trim()) options.expireAfterSeconds = Number(ttl)
      if (partial.trim()) options.partialFilterExpression = parseShellValue(partial)
      setBusy(true)
      await api.mongo(tab.connectionId, '__meta', {
        op: 'createIndex',
        database: tab.database,
        collection: tab.collection,
        keys: parseShellValue(keys),
        options
      })
      toast('Index created')
      onCreated()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Create index"
      description={`${tab.database}.${tab.collection}`}
      onClose={onClose}
      footer={
        <>
          {error && (
            <p className="mr-auto max-w-[60%] truncate text-xs text-danger" title={error}>
              {error}
            </p>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} disabled={busy}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Keys" hint="1 ascending, -1 descending, 'text', '2dsphere' or 'hashed'">
          <Input mono value={keys} onChange={(e) => setKeys(e.target.value)} />
        </Field>
        <Field label="Name" hint="Generated from the keys when empty">
          <Input
            mono
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="field_1"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Toggle checked={unique} onChange={setUnique} label="Unique" />
          <Toggle checked={sparse} onChange={setSparse} label="Sparse" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="TTL (seconds)" hint="Expire documents by a date field">
            <Input
              value={ttl}
              onChange={(e) => setTtl(e.target.value.replace(/\D/g, ''))}
              placeholder="none"
            />
          </Field>
          <Field label="Partial filter">
            <Input
              mono
              value={partial}
              onChange={(e) => setPartial(e.target.value)}
              placeholder="{ status: 'active' }"
            />
          </Field>
        </div>
        <ErrorText error={null} />
      </div>
    </Modal>
  )
}
