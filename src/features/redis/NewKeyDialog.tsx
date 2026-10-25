import { useState } from 'react'
import { api, type RData, type RedisRequest } from '@/lib/api'
import { KEY_TYPES, parseTtl, zsetScore } from '@/lib/redis'
import { errorMessage } from '@/lib/toast'
import { Button, Field, Input, Modal, Select, Spinner, Textarea } from '@/components/ui'

/** Creates a key of any type with a first value, refusing to overwrite one that exists. */
export function NewKeyDialog({
  connectionId,
  database,
  session,
  prefix,
  onClose,
  onCreated
}: {
  connectionId: string
  database: string
  session: string
  /** Pre-filled start of the name, e.g. the folder the user was in */
  prefix: string
  onClose: () => void
  onCreated: (key: RData) => void
}): React.JSX.Element {
  const [type, setType] = useState('string')
  const [key, setKey] = useState(prefix)
  const [field, setField] = useState('')
  const [value, setValue] = useState('')
  const [score, setScore] = useState('0')
  const [ttl, setTtl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async (): Promise<void> => {
    setError(null)
    if (!key) return setError('Enter a key name')
    let ttlMs: number | null
    try {
      ttlMs = parseTtl(ttl)
    } catch (e) {
      return setError(errorMessage(e))
    }
    const base = { database, key }
    let request: RedisRequest
    switch (type) {
      case 'hash':
        if (!field) return setError('Enter the first field name')
        request = { op: 'hashSet', ...base, field, value }
        break
      case 'list':
        request = { op: 'listPush', ...base, values: [value] }
        break
      case 'set':
        request = { op: 'setAdd', ...base, members: [value] }
        break
      case 'zset': {
        let n: string
        try {
          n = zsetScore(score)
        } catch (e) {
          return setError(errorMessage(e))
        }
        request = { op: 'zsetAdd', ...base, member: value, score: n }
        break
      }
      case 'stream':
        if (!field) return setError('Enter the first field name')
        request = { op: 'streamAdd', ...base, fields: [[field, value]] }
        break
      case 'ReJSON-RL':
        request = { op: 'jsonSet', ...base, json: value || '{}' }
        break
      default:
        request = { op: 'set', ...base, value, ttlMs, onlyNew: true }
    }
    setSaving(true)
    try {
      // SET checks on its own (NX); the other types would add to an existing key
      if (type !== 'string') {
        const exists = await api.redis(connectionId, session, {
          op: 'command',
          database,
          args: ['EXISTS', key]
        })
        if (exists.reply?.t === 'int' && Number(exists.reply.v) > 0)
          throw new Error('A key with that name already exists')
      }
      await api.redis(connectionId, session, request)
      if (ttlMs && type !== 'string')
        await api.redis(connectionId, session, { op: 'expire', database, key, ttlMs })
      onCreated(key)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const needsField = type === 'hash' || type === 'stream'
  return (
    <Modal
      title="New key"
      description={`In database ${database}`}
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void create()}>
            {saving && <Spinner className="size-3.5" />} Create
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <div className="grid grid-cols-[1fr_10rem] gap-3">
          <Field label="Key">
            <Input
              mono
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="user:42"
            />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {KEY_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {(needsField || type === 'zset') && (
          <Field label={type === 'zset' ? 'Score' : 'First field'}>
            {type === 'zset' ? (
              <Input mono value={score} onChange={(e) => setScore(e.target.value)} />
            ) : (
              <Input
                mono
                value={field}
                onChange={(e) => setField(e.target.value)}
                placeholder="name"
              />
            )}
          </Field>
        )}
        <Field
          label={
            type === 'set' || type === 'zset'
              ? 'First member'
              : type === 'list'
                ? 'First item'
                : type === 'ReJSON-RL'
                  ? 'JSON document'
                  : 'Value'
          }
          hint={
            type === 'ReJSON-RL' ? 'Needs the RedisJSON module (Redis Stack, Redis 8)' : undefined
          }
        >
          <Textarea mono rows={5} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field
          label="Time to live (optional)"
          hint="e.g. 90s, 15m, 1h30m or 7d; empty keeps the key forever"
        >
          <Input
            mono
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            placeholder="No expiry"
          />
        </Field>
        {error && <p className="text-xs text-danger">{error}</p>}
      </form>
    </Modal>
  )
}
