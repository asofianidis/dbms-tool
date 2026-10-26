import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { toShell } from '@/lib/ejson'
import {
  collectionNameError,
  createCommand,
  emptyCollection,
  type CollectionKind,
  type Granularity,
  type NewCollection,
  type ValidationAction,
  type ValidationLevel
} from '@/lib/mongo-collections'
import { mongoDatabaseProblem } from '@/lib/databases'
import { queries } from '@/lib/queries'
import { createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import { openCollection, refreshConnection } from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { Button, Field, Input, Modal, Segmented, Select } from '@/components/ui'

interface Request {
  connectionId: string
  /** '' to create a new database along with its first collection */
  database: string
  kind?: CollectionKind
  /** For a view: the collection it starts from */
  viewOn?: string
}

const requestStore = createStore<Request | null>(null)

export function openCreateCollection(request: Request): void {
  requestStore.set(request)
}

export function CreateCollectionHost(): React.JSX.Element | null {
  const request = requestStore.use()
  if (!request) return null
  return (
    <CreateCollectionDialog
      key={`${request.connectionId}/${request.database}`}
      request={request}
      onClose={() => requestStore.set(null)}
    />
  )
}

const KINDS: { value: CollectionKind; label: string; title: string }[] = [
  { value: 'collection', label: 'Collection', title: 'A regular collection' },
  {
    value: 'capped',
    label: 'Capped',
    title: 'Fixed size; the oldest documents are removed as new ones arrive'
  },
  {
    value: 'timeseries',
    label: 'Time series',
    title: 'Measurements over time, stored in compressed buckets'
  },
  { value: 'view', label: 'View', title: 'A read-only aggregation over another collection' }
]

function CreateCollectionDialog({
  request,
  onClose
}: {
  request: Request
  onClose: () => void
}): React.JSX.Element {
  const [spec, setSpec] = useState<NewCollection>(() => ({
    ...emptyCollection(),
    kind: request.kind ?? 'collection',
    viewOn: request.viewOn ?? ''
  }))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // MongoDB creates a database when its first collection is
  const newDatabase = request.database === ''
  const [databaseName, setDatabaseName] = useState('')
  const database = newDatabase ? databaseName.trim() : request.database
  const databases = useQuery({ ...queries.databases(request.connectionId), enabled: newDatabase })
  const databaseError =
    newDatabase && databaseName
      ? mongoDatabaseProblem(
          databaseName,
          (databases.data ?? []).map((d) => d.name)
        )
      : null
  const collections = useQuery({
    ...queries.objects(request.connectionId, request.database, null),
    enabled: !newDatabase
  })
  const set = (patch: Partial<NewCollection>): void => setSpec((s) => ({ ...s, ...patch }))
  const nameError = spec.name ? collectionNameError(spec.name) : null

  let preview = ''
  try {
    preview = `db.runCommand(${toShell(createCommand(spec))})`
  } catch {
    // Shown on submit
  }

  const submit = async (): Promise<void> => {
    setError(null)
    if (newDatabase) {
      const problem = mongoDatabaseProblem(
        databaseName,
        (databases.data ?? []).map((d) => d.name)
      )
      if (problem) return setError(problem)
    }
    let command: Record<string, unknown>
    try {
      command = createCommand(spec)
    } catch (e) {
      setError(errorMessage(e))
      return
    }
    setSaving(true)
    try {
      await api.mongo(request.connectionId, '__meta', {
        op: 'runCommand',
        database,
        command
      })
      toast(
        newDatabase
          ? `Created database ${database} with ${spec.name}`
          : `Created ${spec.kind === 'view' ? 'view' : 'collection'} ${spec.name}`
      )
      refreshConnection(request.connectionId)
      openCollection(request.connectionId, database, spec.name)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setSaving(false)
    }
  }

  const sources = (collections.data ?? []).map((o) => o.name)

  return (
    <Modal
      width="lg"
      title={
        newDatabase ? 'New database' : spec.kind === 'view' ? 'Create view' : 'Create collection'
      }
      description={
        newDatabase
          ? 'MongoDB creates a database with its first collection'
          : `In ${request.database}`
      }
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
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={saving || !spec.name || (newDatabase && !database)}
          >
            <Plus className="size-3.5" /> Create
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {newDatabase && (
          <Field label="Database" hint={databaseError ?? undefined}>
            <Input
              value={databaseName}
              onChange={(e) => setDatabaseName(e.target.value)}
              placeholder="my_app"
              mono
            />
          </Field>
        )}
        <Field label={newDatabase ? 'First collection' : 'Name'} hint={nameError ?? undefined}>
          <Input
            value={spec.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder={spec.kind === 'view' ? 'active_users' : 'orders'}
            mono
          />
        </Field>
        <Segmented
          value={spec.kind}
          onChange={(kind) => set({ kind })}
          // A view needs a collection to read from, which a new database doesn't have yet
          options={newDatabase ? KINDS.filter((k) => k.value !== 'view') : KINDS}
        />

        {spec.kind === 'capped' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Maximum size (bytes)" hint="Rounded up to a multiple of 256">
              <Input
                value={spec.size}
                onChange={(e) => set({ size: e.target.value })}
                placeholder="1048576"
                mono
              />
            </Field>
            <Field label="Maximum documents" hint="Optional; the size limit applies first">
              <Input
                value={spec.max}
                onChange={(e) => set({ max: e.target.value })}
                placeholder="No limit"
                mono
              />
            </Field>
          </div>
        )}

        {spec.kind === 'timeseries' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Time field" hint="Holds each measurement's date">
              <Input
                value={spec.timeField}
                onChange={(e) => set({ timeField: e.target.value })}
                placeholder="timestamp"
                mono
              />
            </Field>
            <Field label="Meta field" hint="Optional; identifies the series, e.g. a sensor">
              <Input
                value={spec.metaField}
                onChange={(e) => set({ metaField: e.target.value })}
                placeholder="metadata"
                mono
              />
            </Field>
            <Field label="Granularity" hint="How far apart measurements in a series usually are">
              <Select
                value={spec.granularity}
                onChange={(e) => set({ granularity: e.target.value as Granularity })}
              >
                <option value="">Default (seconds)</option>
                <option value="seconds">Seconds</option>
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
              </Select>
            </Field>
            <Field label="Expire after (seconds)" hint="Optional; deletes old measurements">
              <Input
                value={spec.expireAfterSeconds}
                onChange={(e) => set({ expireAfterSeconds: e.target.value })}
                placeholder="Keep forever"
                mono
              />
            </Field>
          </div>
        )}

        {spec.kind === 'view' ? (
          <>
            <Field label="Source">
              <Select value={spec.viewOn} onChange={(e) => set({ viewOn: e.target.value })}>
                <option value="">Choose a collection or view…</option>
                {sources.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Pipeline">
              <div className="h-40 overflow-hidden rounded-md border border-line-strong bg-canvas">
                <CodeEditor
                  value={spec.pipeline}
                  onChange={(pipeline) => set({ pipeline })}
                  language={{ kind: 'mongo' }}
                  className="h-full"
                  fontSize={12}
                  lineNumbers={false}
                  placeholder="[{ $match: { active: true } }]"
                />
              </div>
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Validation"
              hint="Optional. A $jsonSchema or query operators every insert and update must match. You can also infer one from documents later, in the collection's Validation tab."
            >
              <div className="h-32 overflow-hidden rounded-md border border-line-strong bg-canvas">
                <CodeEditor
                  value={spec.validator}
                  onChange={(validator) => set({ validator })}
                  language={{ kind: 'mongo' }}
                  className="h-full"
                  fontSize={12}
                  lineNumbers={false}
                  placeholder="{ $jsonSchema: { bsonType: 'object', required: ['email'] } }"
                />
              </div>
            </Field>
            {spec.validator.trim() && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Level">
                  <Select
                    value={spec.validationLevel}
                    onChange={(e) => set({ validationLevel: e.target.value as ValidationLevel })}
                  >
                    <option value="strict">strict: check every write</option>
                    <option value="moderate">moderate: skip documents already invalid</option>
                    <option value="off">off</option>
                  </Select>
                </Field>
                <Field label="Action">
                  <Select
                    value={spec.validationAction}
                    onChange={(e) => set({ validationAction: e.target.value as ValidationAction })}
                  >
                    <option value="error">error: reject the write</option>
                    <option value="warn">warn: allow and log</option>
                  </Select>
                </Field>
              </div>
            )}
          </>
        )}

        {preview && (
          <pre className="max-h-28 overflow-auto rounded-md bg-canvas px-3 py-2 font-mono text-[11px] text-muted select-text">
            {preview}
          </pre>
        )}
      </form>
    </Modal>
  )
}
