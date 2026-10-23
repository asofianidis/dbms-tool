import { useEffect, useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { ArchiveRestore, DatabaseBackup, FilePlus2, Play, RotateCcw } from 'lucide-react'
import {
  api,
  type BackupContent,
  type BackupInspection,
  type BackupToolKind,
  type ConnectionConfig,
  type DbObject,
  type ObjectName,
  type PgFormat
} from '@/lib/api'
import {
  backupDatabases,
  backupExtension,
  backupIsFolder,
  backupJob,
  canSelectObjects,
  createDatabaseSql,
  defaultBackupName,
  joinServerPath,
  newBackupDraft,
  newRestoreDraft,
  restoreJob,
  restoresAsNamed,
  builtinCanRun,
  toolVersionProblem,
  validateBackup,
  validateRestore,
  withExtension,
  type BackupDraft,
  type BackupScope,
  type RestoreDraft
} from '@/lib/backup'
import { ENGINES } from '@/lib/engines'
import { formatBytes, plural } from '@/lib/format'
import { queries, queryClient } from '@/lib/queries'
import { errorMessage } from '@/lib/toast'
import { confirm, newQueryTab, refreshConnection } from '@/lib/workspace'
import {
  Button,
  ErrorText,
  Field,
  Input,
  Segmented,
  Select,
  Spinner,
  Toggle
} from '@/components/ui'
import {
  Callout,
  Checklist,
  Choice,
  CommandPreview,
  JobPanel,
  PathField,
  Section,
  StepFooter,
  Summary,
  ToolStatus,
  WizardLayout,
  backupPrefsStore,
  defaultFolder,
  useBackupTools,
  useSteps,
  useToolJob,
  type PickItem
} from './Wizard'

interface Props {
  tabId: string
  connection: ConnectionConfig
  /** Database the wizard was opened on; may be empty */
  database: string
  /** Server version banner, to check pg_dump against */
  serverVersion: string
}

const TABLE_KINDS = new Set(['table', 'view', 'materialized_view', 'foreign_table', 'sequence'])
const COLLECTION_KINDS = new Set(['collection', 'timeseries', 'view'])

const KIND_LABELS: Record<string, string> = {
  view: 'view',
  materialized_view: 'mat. view',
  foreign_table: 'foreign',
  sequence: 'sequence',
  timeseries: 'time series'
}

const keyOf = (o: ObjectName): string => `${o.schema ?? ''}\n${o.name}`
const fromKey = (key: string, withSchema: boolean): ObjectName => {
  const [schema, name] = key.split('\n')
  return { schema: withSchema ? schema : null, name }
}

const CONTENT_OPTIONS: { value: BackupContent; label: string }[] = [
  { value: 'all', label: 'Structure and data' },
  { value: 'schema', label: 'Structure only' },
  { value: 'data', label: 'Data only' }
]

function contentLabel(content: BackupContent): string {
  return CONTENT_OPTIONS.find((o) => o.value === content)!.label
}

function scopeLabel(scope: BackupScope, count: number, engine: ConnectionConfig['engine']): string {
  if (scope === 'all') return 'Everything'
  if (scope === 'schemas') return plural(count, 'schema')
  return plural(count, engine === 'mongo' ? 'collection' : 'table')
}

function databaseOptions(names: string[], current: string): string[] {
  return current && !names.includes(current) ? [current, ...names] : names
}

function useUserDatabases(connectionId: string): { names: string[]; loading: boolean } {
  const q = useQuery(queries.databases(connectionId))
  const names = useMemo(
    () => (q.data ?? []).filter((d) => !d.isSystem).map((d) => d.name),
    [q.data]
  )
  return { names, loading: q.isPending }
}

/* ---------- Backup ---------- */

export function ToolBackupWizard({
  tabId,
  connection,
  database,
  serverVersion
}: Props): React.JSX.Element {
  const engine = connection.engine
  const isPg = engine === 'postgres'
  const isMongo = engine === 'mongo'
  const steps = useSteps()
  const [draft, setDraft] = useState(() => newBackupDraft(database))
  const patch = (p: Partial<BackupDraft>): void => setDraft((d) => ({ ...d, ...p }))
  const [folder, setFolder] = useState('')
  const [customPath, setCustomPath] = useState<string | null>(null)
  const runner = useToolJob(tabId)
  const { tools, loading: toolsLoading } = useBackupTools(engine)
  const { names: databases } = useUserDatabases(connection.id)

  useEffect(() => {
    void defaultFolder().then(setFolder)
  }, [])

  const schemas = useQuery({
    ...queries.schemas(connection.id, draft.database),
    enabled: isPg && !!draft.database
  })
  const userSchemas = useMemo(
    () => (schemas.data ?? []).filter((s) => !s.isSystem).map((s) => s.name),
    [schemas.data]
  )
  const objectQueries = useQueries({
    queries: !draft.database
      ? []
      : isPg
        ? userSchemas.map((s) => queries.objects(connection.id, draft.database, s))
        : [queries.objects(connection.id, draft.database, null)]
  })
  const objectsLoading = objectQueries.some((q) => q.isPending) || (isPg && schemas.isPending)
  const objects: DbObject[] = objectQueries.flatMap((q) => q.data ?? [])
  const kinds = isMongo ? COLLECTION_KINDS : TABLE_KINDS
  const tableItems: PickItem[] = objects
    .filter((o) => kinds.has(o.kind))
    .map((o) => ({
      key: keyOf({ schema: isPg ? o.schema : null, name: o.name }),
      label: o.name,
      group: isPg ? (o.schema ?? '') : undefined,
      detail: KIND_LABELS[o.kind]
    }))
  const collections = objects.filter((o) => COLLECTION_KINDS.has(o.kind)).map((o) => o.name)

  const ext = backupExtension(engine, draft)
  const path =
    customPath ?? (folder ? joinServerPath(folder, defaultBackupName(engine, draft)) : '')
  const full = { ...draft, path }
  // Formats change the extension of a path the user typed, too
  const setFormat = (p: Partial<BackupDraft>): void => {
    const next = { ...draft, ...p }
    if (customPath !== null) {
      const folderNow = backupIsFolder(engine, draft)
      const folderNext = backupIsFolder(engine, next)
      setCustomPath(
        folderNow === folderNext || !folderNext
          ? withExtension(customPath, ext, backupExtension(engine, next))
          : customPath.slice(
              0,
              customPath.length - (ext && customPath.endsWith(ext) ? ext.length : 0)
            )
      )
    }
    setDraft(next)
  }

  const dumpKind: BackupToolKind = isPg ? 'pg_dump' : isMongo ? 'mongodump' : 'mysqldump'
  const dumpTool = tools?.find((t) => t.kind === dumpKind)
  const versionProblem = dumpTool ? toolVersionProblem(dumpTool, serverVersion) : null
  // Without the tool the built-in engine backs up, as plain SQL for PostgreSQL
  const builtin = !toolsLoading && !dumpTool?.path
  useEffect(() => {
    if (builtin && isPg && draft.pgFormat !== 'plain') setFormat({ pgFormat: 'plain' })
  }, [builtin])

  const stepProblem = (): string | null => {
    switch (steps.step) {
      case 0:
        if (!draft.database) return 'Choose a database'
        if (draft.scope === 'schemas' && !draft.schemas.length) return 'Choose at least one schema'
        if (draft.scope === 'tables' && !draft.tables.length) {
          return isMongo ? 'Choose at least one collection' : 'Choose at least one table'
        }
        return null
      case 2:
      case 3:
        if (!path.trim()) return 'Choose where to save the backup'
        if (toolsLoading) return 'Looking for the backup tool…'
        if (builtin && !builtinCanRun(backupJob(engine, full, collections))) {
          return `${dumpKind} wasn't found; without it, backups are plain SQL`
        }
        return versionProblem ?? validateBackup(engine, full)
      default:
        return null
    }
  }
  const problem = stepProblem()
  const job = problem ? null : backupJob(engine, full, collections)
  const preview = useQuery({
    queryKey: ['backupPreview', connection.id, job, backupPrefsStore.get().toolsDir],
    queryFn: () => api.backupPreview(connection.id, job!, backupPrefsStore.get().toolsDir),
    enabled: steps.step === 3 && !!job,
    staleTime: 0
  })

  const title = `Back up ${draft.database || 'a database'}`
  const subtitle = `${ENGINES[engine].label} · ${connection.name || connection.host}`
  if (runner.job) {
    return (
      <WizardLayout
        icon={<DatabaseBackup />}
        title={title}
        subtitle={subtitle}
        steps={[]}
        step={0}
        reached={0}
        onStep={() => undefined}
      >
        <JobPanel
          job={runner.job}
          noun="Backup"
          onCancel={runner.cancel}
          output={path}
          actions={
            <Button variant="secondary" onClick={runner.clear}>
              <RotateCcw className="size-3.5" /> Back to settings
            </Button>
          }
        />
      </WizardLayout>
    )
  }

  const STEPS = ['Source', 'Options', 'Destination', 'Review']
  const scopeOptions: { value: BackupScope; label: string }[] = [
    { value: 'all', label: 'Entire database' },
    ...(isPg ? [{ value: 'schemas' as const, label: 'Schemas' }] : []),
    { value: 'tables', label: isMongo ? 'Collections' : 'Tables' }
  ]

  return (
    <WizardLayout
      icon={<DatabaseBackup />}
      title={title}
      subtitle={subtitle}
      steps={STEPS}
      step={steps.step}
      reached={steps.reached}
      onStep={steps.go}
      footer={
        <StepFooter
          step={steps.step}
          last={STEPS.length - 1}
          problem={problem}
          onBack={() => steps.go(steps.step - 1)}
          onNext={() =>
            steps.step < STEPS.length - 1
              ? steps.go(steps.step + 1)
              : job && void runner.start(connection.id, job)
          }
          startLabel="Start backup"
          startIcon={<Play className="size-3.5" />}
        />
      }
    >
      {steps.step === 0 && (
        <>
          <Section title="Database">
            <Select
              className="max-w-sm"
              value={draft.database}
              onChange={(e) => patch({ database: e.target.value, schemas: [], tables: [] })}
            >
              {!draft.database && <option value="">Choose a database…</option>}
              {databaseOptions(databases, draft.database).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </Section>
          <Section title="What to back up">
            <Segmented
              value={draft.scope}
              options={scopeOptions}
              onChange={(scope) => patch({ scope })}
            />
            {draft.scope === 'schemas' &&
              (schemas.isPending ? (
                <Spinner />
              ) : (
                <Checklist
                  items={userSchemas.map((s) => ({ key: s, label: s }))}
                  selected={draft.schemas}
                  onChange={(keys) => patch({ schemas: keys })}
                  empty="No schemas"
                />
              ))}
            {draft.scope === 'tables' &&
              (objectsLoading ? (
                <Spinner />
              ) : (
                <Checklist
                  items={tableItems}
                  selected={draft.tables.map(keyOf)}
                  onChange={(keys) => patch({ tables: keys.map((k) => fromKey(k, isPg)) })}
                  empty={isMongo ? 'No collections' : 'No tables'}
                />
              ))}
            {draft.scope === 'schemas' && (
              <p className="text-xs text-muted">
                Everything in the chosen schemas is included: tables, views, functions, types and
                sequences.
              </p>
            )}
            {draft.scope === 'tables' && isPg && (
              <p className="text-xs text-muted">
                Chosen tables come with their indexes, constraints and triggers, but not the
                functions or types they depend on.
              </p>
            )}
          </Section>
          {!isMongo && (
            <Section title="Contents">
              <Segmented
                value={draft.content}
                options={CONTENT_OPTIONS}
                onChange={(content) => patch({ content })}
              />
            </Section>
          )}
        </>
      )}

      {steps.step === 1 && isPg && (
        <>
          <Section title="Format">
            <Choice<PgFormat>
              value={draft.pgFormat}
              onChange={(pgFormat) => setFormat({ pgFormat })}
              options={[
                {
                  value: 'custom',
                  label: 'Custom archive',
                  badge: builtin ? undefined : 'Recommended',
                  description: builtin
                    ? 'Needs pg_dump, which isn’t installed.'
                    : 'Compressed. pg_restore can restore all of it or chosen parts.',
                  disabled: builtin
                },
                {
                  value: 'plain',
                  label: 'Plain SQL script',
                  description: builtin
                    ? 'Readable and editable. Written by the built-in engine; restores here or with psql.'
                    : 'Readable and editable. Restores by running it with psql.'
                },
                {
                  value: 'directory',
                  label: 'Directory',
                  description: builtin
                    ? 'Needs pg_dump, which isn’t installed.'
                    : 'A folder with one file per table. Backs up in parallel.',
                  disabled: builtin
                },
                {
                  value: 'tar',
                  label: 'Tar archive',
                  description: builtin
                    ? 'Needs pg_dump, which isn’t installed.'
                    : 'Uncompressed archive for pg_restore.',
                  disabled: builtin
                }
              ]}
            />
          </Section>
          <Section title="Options">
            <div className="flex flex-wrap gap-4">
              {(draft.pgFormat === 'custom' || draft.pgFormat === 'directory') && (
                <Field label="Compression" className="w-40">
                  <Select
                    value={String(draft.compression)}
                    onChange={(e) => patch({ compression: Number(e.target.value) })}
                  >
                    <option value="0">None</option>
                    <option value="1">1 (fastest)</option>
                    <option value="6">6 (default)</option>
                    <option value="9">9 (smallest)</option>
                  </Select>
                </Field>
              )}
              {draft.pgFormat === 'directory' && (
                <Field label="Parallel jobs" className="w-32">
                  <Input
                    type="number"
                    min={1}
                    max={32}
                    value={draft.jobs}
                    onChange={(e) =>
                      patch({ jobs: Math.max(1, Math.min(32, Number(e.target.value) || 1)) })
                    }
                  />
                </Field>
              )}
            </div>
            <div className="space-y-3">
              {draft.pgFormat === 'plain' && (
                <>
                  <Toggle
                    checked={draft.clean}
                    onChange={(clean) => patch({ clean })}
                    disabled={draft.content === 'data'}
                    label="Drop objects before creating them"
                    description="Adds DROP … IF EXISTS, so the script can restore over an existing copy"
                  />
                  <Toggle
                    checked={draft.create}
                    onChange={(create) => patch({ create })}
                    label="Create the database"
                    description="Adds CREATE DATABASE and connects to it, so the script restores into its own database"
                  />
                </>
              )}
              <Toggle
                checked={draft.noOwner}
                onChange={(noOwner) => patch({ noOwner })}
                label="Skip ownership"
                description="Restored objects belong to whoever restores them; useful across servers with different roles"
              />
              <Toggle
                checked={draft.noPrivileges}
                onChange={(noPrivileges) => patch({ noPrivileges })}
                label="Skip privileges"
                description="Leaves out GRANT and REVOKE"
              />
              <Toggle
                checked={draft.inserts}
                onChange={(inserts) => patch({ inserts })}
                disabled={draft.content === 'schema'}
                label="Data as INSERT statements"
                description="Portable to other databases, but much slower to restore than COPY"
              />
            </div>
          </Section>
        </>
      )}

      {steps.step === 1 && engine === 'mysql' && (
        <Section title="Options">
          <div className="space-y-3">
            <Toggle
              checked={draft.singleTransaction}
              onChange={(singleTransaction) => patch({ singleTransaction })}
              label="Consistent snapshot"
              description="Backs up InnoDB tables in one transaction without locking them"
            />
            <Toggle
              checked={draft.routines}
              onChange={(routines) => patch({ routines })}
              disabled={draft.content === 'data'}
              label="Stored procedures and functions"
            />
            <Toggle
              checked={draft.triggers}
              onChange={(triggers) => patch({ triggers })}
              disabled={draft.content === 'data'}
              label="Triggers"
            />
            <Toggle
              checked={draft.events}
              onChange={(events) => patch({ events })}
              disabled={draft.content === 'data'}
              label="Scheduled events"
            />
            <Toggle
              checked={draft.createDatabase && draft.scope !== 'tables'}
              onChange={(createDatabase) => patch({ createDatabase })}
              disabled={draft.scope === 'tables'}
              label="Create the database"
              description="Adds CREATE DATABASE and USE, so the file always restores into a database with this name"
            />
            <Toggle
              checked={draft.dropTables}
              onChange={(dropTables) => patch({ dropTables })}
              disabled={draft.content === 'data'}
              label="Drop tables before creating them"
              description="Lets the file restore over an existing copy"
            />
            <Toggle
              checked={draft.extendedInsert}
              onChange={(extendedInsert) => patch({ extendedInsert })}
              disabled={draft.content === 'schema'}
              label="Multi-row INSERT statements"
              description="Smaller and much faster to restore; turn off for one row per line"
            />
            <Toggle
              checked={draft.hexBlob}
              onChange={(hexBlob) => patch({ hexBlob })}
              disabled={draft.content === 'schema'}
              label="Binary columns as hex"
              description="Keeps BLOB and BINARY data intact through any editor or encoding"
            />
          </div>
        </Section>
      )}

      {steps.step === 1 && isMongo && (
        <>
          <Section title="Format">
            <Choice
              value={draft.archive ? 'archive' : 'folder'}
              onChange={(v) => setFormat({ archive: v === 'archive' })}
              options={[
                {
                  value: 'archive',
                  label: 'Single archive file',
                  badge: 'Recommended',
                  description: 'One file, easy to move around.'
                },
                {
                  value: 'folder',
                  label: 'Folder of BSON files',
                  description: 'One file per collection, with its indexes alongside.'
                }
              ]}
            />
          </Section>
          <Section title="Options">
            <Toggle
              checked={draft.gzip}
              onChange={(gzip) => setFormat({ gzip })}
              label="Compress with gzip"
              description="Usually several times smaller; restoring needs the same setting, which is detected for you"
            />
          </Section>
        </>
      )}

      {steps.step === 2 && (
        <>
          <Section
            title={backupIsFolder(engine, draft) ? 'Folder' : 'File'}
            description={
              backupIsFolder(engine, draft)
                ? isPg
                  ? 'pg_dump creates this folder; it must not exist yet or be empty.'
                  : 'mongodump writes a subfolder for the database here.'
                : 'Saved on this computer.'
            }
          >
            <PathField
              value={path}
              onChange={setCustomPath}
              mode={backupIsFolder(engine, draft) ? 'folder' : 'save'}
              filters={ext ? [{ name: 'Backup', extensions: [ext.split('.').pop()!] }] : undefined}
            />
          </Section>
          <Section title="Backup tool">
            <ToolStatus
              kind={dumpKind}
              tools={tools}
              loading={toolsLoading}
              problem={versionProblem}
              builtin={builtin}
            />
          </Section>
        </>
      )}

      {steps.step === 3 && (
        <>
          <Section title="Summary">
            <Summary
              rows={[
                ['Database', draft.database],
                [
                  'Includes',
                  `${scopeLabel(draft.scope, draft.scope === 'schemas' ? draft.schemas.length : draft.tables.length, engine)}${isMongo ? '' : ` · ${contentLabel(draft.content).toLowerCase()}`}`
                ],
                [
                  'Format',
                  isPg
                    ? {
                        custom: 'Custom archive',
                        plain: 'Plain SQL',
                        directory: 'Directory',
                        tar: 'Tar'
                      }[draft.pgFormat]
                    : isMongo
                      ? `${draft.archive ? 'Archive file' : 'BSON folder'}${draft.gzip ? ', gzip' : ''}`
                      : 'SQL script'
                ],
                ['Saved to', <span className="font-mono text-xs">{path}</span>]
              ]}
            />
          </Section>
          <Section
            title={builtin ? 'How it runs' : 'Command'}
            description={
              builtin ? undefined : 'The password is passed privately, never on the command line.'
            }
          >
            {preview.isError ? (
              <ErrorText error={preview.error} />
            ) : (
              <CommandPreview text={preview.data ?? null} loading={preview.isPending} />
            )}
          </Section>
        </>
      )}
    </WizardLayout>
  )
}

/* ---------- Restore ---------- */

function InspectionCard({
  engine,
  inspection
}: {
  engine: ConnectionConfig['engine']
  inspection: BackupInspection
}): React.JSX.Element {
  const counts = new Map<string, number>()
  for (const e of inspection.entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1)
  const contents = [...counts.entries()]
    .filter(([kind]) => kind !== 'extension')
    .map(([kind, n]) => plural(n, kind.replace('_', ' ')))
    .join(', ')
  const format: Record<string, string> = {
    custom: 'pg_dump custom archive',
    tar: 'pg_dump tar archive',
    directory: 'pg_dump directory',
    plain: 'Plain SQL script',
    sql: 'SQL script',
    archive: `mongodump archive${inspection.gzip ? ' (gzip)' : ''}`,
    dump: `mongodump folder${inspection.gzip ? ' (gzip)' : ''}`
  }
  const dbs = engine === 'mongo' ? backupDatabases(inspection) : []
  return (
    <Summary
      rows={[
        ['Format', format[inspection.format] ?? inspection.format],
        ['Size', formatBytes(inspection.size)],
        ...(dbs.length > 1
          ? [['Databases', dbs.join(', ')] as [string, string]]
          : inspection.database
            ? [['Backed up from', inspection.database] as [string, string]]
            : []),
        ...(inspection.sourceVersion
          ? [['Server version', inspection.sourceVersion] as [string, string]]
          : []),
        ...(inspection.toolVersion
          ? [['Made by', inspection.toolVersion] as [string, string]]
          : []),
        ...(contents ? [['Contains', contents] as [string, string]] : [])
      ]}
    />
  )
}

export function ToolRestoreWizard({ tabId, connection, database }: Props): React.JSX.Element {
  const engine = connection.engine
  const isPg = engine === 'postgres'
  const isMongo = engine === 'mongo'
  const steps = useSteps()
  const [draft, setDraft] = useState(() => newRestoreDraft(database))
  const patch = (p: Partial<RestoreDraft>): void => setDraft((d) => ({ ...d, ...p }))
  const [path, setPath] = useState('')
  const [checked, setChecked] = useState('')
  const runner = useToolJob(tabId)
  const { tools, loading: toolsLoading, toolsDir } = useBackupTools(engine)
  const { names: databases } = useUserDatabases(connection.id)

  const inspect = useQuery({
    queryKey: ['backupInspect', connection.id, checked, toolsDir],
    queryFn: () => api.backupInspect(connection.id, checked, toolsDir),
    enabled: !!checked,
    staleTime: 0,
    gcTime: 0
  })
  const inspection = inspect.data ?? null
  useEffect(() => {
    if (!inspection) return
    setDraft((d) => ({
      ...d,
      scope: 'all',
      schemas: [],
      tables: [],
      database: d.target === 'new' && !d.database ? (inspection.database ?? '') : d.database
    }))
  }, [inspection])

  const choose = (next: string): void => {
    setPath(next)
    setChecked(next.trim())
  }

  const asNamed = restoresAsNamed(engine, inspection)
  const selectable = canSelectObjects(engine, inspection)
  const restoreKind: BackupToolKind = isPg
    ? inspection?.format === 'plain'
      ? 'psql'
      : 'pg_restore'
    : isMongo
      ? 'mongorestore'
      : 'mysql'
  const restoreTool = tools?.find((t) => t.kind === restoreKind)
  // Without the tool the built-in engine restores, except pg_dump's archives
  const builtin = !toolsLoading && !restoreTool?.path && restoreKind !== 'pg_restore'
  const target = draft.database.trim()
  const existingTarget = !asNamed && draft.target === 'existing'
  const destructive =
    existingTarget &&
    ((isPg && inspection?.format !== 'plain' && draft.clean) || (isMongo && draft.drop))

  const schemaItems: PickItem[] = useMemo(() => {
    if (!inspection) return []
    const names = new Set<string>()
    for (const e of inspection.entries) {
      if (e.kind === 'schema') names.add(e.name)
      else if (e.schema && e.kind !== 'extension') names.add(e.schema)
    }
    return [...names].sort().map((s) => ({ key: s, label: s }))
  }, [inspection])
  const tableItems: PickItem[] = useMemo(
    () =>
      (inspection?.entries ?? [])
        .filter((e) => (isMongo ? e.kind === 'collection' : TABLE_KINDS.has(e.kind)))
        .filter((e) => !(isMongo && e.name.startsWith('system.')))
        .map((e) => ({
          key: keyOf(e),
          label: e.name,
          group: e.schema ?? '',
          detail: KIND_LABELS[e.kind]
        })),
    [inspection, isMongo]
  )

  const stepProblem = (): string | null => {
    if (connection.readOnly) return 'This connection is read-only'
    switch (steps.step) {
      case 0:
        if (!checked) return 'Choose a backup'
        if (inspect.isPending) return 'Reading the backup…'
        if (inspect.isError) return 'This backup couldn’t be read'
        return null
      case 1:
        return validateRestore(engine, draft, inspection, databases)
      case 2:
      case 3:
        if (toolsLoading) return 'Looking for the restore tool…'
        if (!restoreTool?.path && !builtin) return `${restoreKind} wasn't found`
        return validateRestore(engine, draft, inspection, databases)
      default:
        return null
    }
  }
  const problem = stepProblem()
  const job = !problem && inspection ? restoreJob(engine, draft, inspection) : null
  const preview = useQuery({
    queryKey: ['backupPreview', connection.id, job, toolsDir],
    queryFn: () => api.backupPreview(connection.id, job!, toolsDir),
    enabled: steps.step === 3 && !!job,
    staleTime: 0
  })

  const start = async (): Promise<void> => {
    if (!job || !inspection) return
    if (destructive) {
      const ok = await confirm({
        title: `Restore over ${target}?`,
        message: isMongo
          ? `Collections in ${target} that are also in the backup are dropped and replaced.`
          : `Objects in ${target} that are also in the backup are dropped and replaced. Data written since the backup is lost.`,
        confirmLabel: 'Restore',
        danger: true
      })
      if (!ok) return
    }
    const create = draft.target === 'new' && !asNamed ? createDatabaseSql(engine, target) : null
    const ok = await runner.start(connection.id, job, async () => {
      if (!create) return
      const session = `backup-create-${tabId}`
      try {
        const out = await api.execute(connection.id, session, '', create)
        if (out.error) throw new Error(`Couldn't create ${target}: ${out.error.message}`)
      } finally {
        void api.closeSession(connection.id, session).catch(() => undefined)
      }
      await queryClient.invalidateQueries({ queryKey: ['conn', connection.id, 'databases'] })
    })
    if (ok || create) refreshConnection(connection.id)
  }

  const STEPS = ['Backup', 'Target', 'Options', 'Review']
  const title = target && !asNamed ? `Restore into ${target}` : 'Restore a backup'
  const subtitle = `${ENGINES[engine].label} · ${connection.name || connection.host}`

  if (runner.job) {
    return (
      <WizardLayout
        icon={<ArchiveRestore />}
        title={title}
        subtitle={subtitle}
        steps={[]}
        step={0}
        reached={0}
        onStep={() => undefined}
      >
        <JobPanel
          job={runner.job}
          noun="Restore"
          onCancel={runner.cancel}
          actions={
            <>
              {runner.job.status === 'done' && target && !asNamed && (
                <Button variant="secondary" onClick={() => newQueryTab(connection.id, target)}>
                  <FilePlus2 className="size-3.5" /> {isMongo ? 'New shell' : 'New query'} in{' '}
                  {target}
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => {
                  runner.clear()
                  // A database created for this run exists now
                  if (draft.target === 'new' && runner.job?.status !== 'done')
                    patch({ target: 'existing' })
                }}
              >
                <RotateCcw className="size-3.5" /> Back to settings
              </Button>
            </>
          }
        />
      </WizardLayout>
    )
  }

  const createsOwn =
    inspection?.createsDatabase && inspection.database && inspection.database !== target

  return (
    <WizardLayout
      icon={<ArchiveRestore />}
      title={title}
      subtitle={subtitle}
      steps={STEPS}
      step={steps.step}
      reached={steps.reached}
      onStep={steps.go}
      footer={
        <StepFooter
          step={steps.step}
          last={STEPS.length - 1}
          problem={problem}
          onBack={() => steps.go(steps.step - 1)}
          onNext={() => (steps.step < STEPS.length - 1 ? steps.go(steps.step + 1) : void start())}
          startLabel="Start restore"
          startIcon={<Play className="size-3.5" />}
          danger={destructive}
        />
      }
    >
      {connection.readOnly && (
        <Callout tone="warning">
          This connection is read-only. Turn off “Read-only” in the connection settings to restore.
        </Callout>
      )}

      {steps.step === 0 && (
        <>
          <Section
            title="Backup"
            description={
              isPg
                ? 'A pg_dump file (custom, tar or plain SQL) or a directory backup.'
                : isMongo
                  ? 'A mongodump archive, or a folder written by mongodump.'
                  : 'A SQL file written by mysqldump or mariadb-dump.'
            }
          >
            <form
              onSubmit={(e) => {
                e.preventDefault()
                choose(path)
              }}
              onBlur={() => path.trim() !== checked && choose(path)}
            >
              <PathField
                value={path}
                onChange={setPath}
                onPick={choose}
                mode={engine === 'mysql' ? 'file' : 'open'}
                placeholder="Path to the backup"
              />
            </form>
          </Section>
          {checked &&
            (inspect.isPending ? (
              <div className="flex items-center gap-2 text-xs text-muted">
                <Spinner /> Reading the backup…
              </div>
            ) : inspect.isError ? (
              <Callout tone="danger">{errorMessage(inspect.error)}</Callout>
            ) : (
              inspection && (
                <Section title="Contents">
                  <InspectionCard engine={engine} inspection={inspection} />
                </Section>
              )
            ))}
        </>
      )}

      {steps.step === 1 && inspection && (
        <>
          <Section title="Restore into">
            {asNamed ? (
              <Callout>
                This backup holds {backupDatabases(inspection).length} databases (
                {backupDatabases(inspection).join(', ')}). Each is restored under its own name.
              </Callout>
            ) : (
              <div className="space-y-3">
                <Choice
                  value={draft.target}
                  onChange={(t) =>
                    patch({
                      target: t,
                      database:
                        t === 'new'
                          ? inspection.database && !databases.includes(inspection.database)
                            ? inspection.database
                            : ''
                          : database || databases[0] || ''
                    })
                  }
                  options={[
                    {
                      value: 'existing',
                      label: 'An existing database',
                      description: 'Restores into a database already on this server.'
                    },
                    {
                      value: 'new',
                      label: 'A new database',
                      description: isMongo
                        ? 'Created as the restore writes to it.'
                        : 'Created first, then restored into.'
                    }
                  ]}
                />
                {draft.target === 'existing' ? (
                  <Select
                    className="max-w-sm"
                    value={draft.database}
                    onChange={(e) => patch({ database: e.target.value })}
                  >
                    {!draft.database && <option value="">Choose a database…</option>}
                    {databaseOptions(databases, draft.database).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    mono
                    className="max-w-sm"
                    value={draft.database}
                    placeholder="new_database"
                    onChange={(e) => patch({ database: e.target.value })}
                  />
                )}
              </div>
            )}
            {createsOwn && (
              <Callout tone="warning">
                {engine === 'mysql'
                  ? `This file switches to database \`${inspection.database}\` itself (it was made with "Create the database"), so its contents go there rather than into ${target || 'the database you choose'}.`
                  : `This script creates database ${inspection.database} and restores into it, rather than into ${target || 'the database you choose'}.`}
              </Callout>
            )}
          </Section>
          {selectable && (
            <Section title="What to restore">
              <Segmented
                value={draft.scope}
                options={[
                  { value: 'all' as const, label: 'Everything' },
                  ...(isPg ? [{ value: 'schemas' as const, label: 'Schemas' }] : []),
                  { value: 'tables' as const, label: isMongo ? 'Collections' : 'Tables' }
                ]}
                onChange={(scope) => patch({ scope })}
              />
              {draft.scope === 'schemas' && (
                <Checklist
                  items={schemaItems}
                  selected={draft.schemas}
                  onChange={(schemas) => patch({ schemas })}
                  empty="No schemas"
                />
              )}
              {draft.scope === 'tables' && (
                <>
                  <Checklist
                    items={tableItems}
                    selected={draft.tables.map(keyOf)}
                    onChange={(keys) => patch({ tables: keys.map((k) => fromKey(k, true)) })}
                    empty={isMongo ? 'No collections' : 'No tables'}
                  />
                  {isPg && (
                    <p className="text-xs text-muted">
                      pg_restore restores chosen tables without their indexes, constraints or
                      triggers. Choose schemas to restore everything in them.
                    </p>
                  )}
                </>
              )}
            </Section>
          )}
          {isPg && inspection.format !== 'plain' && (
            <Section title="Contents">
              <Segmented
                value={draft.content}
                options={CONTENT_OPTIONS}
                onChange={(content) => patch({ content })}
              />
            </Section>
          )}
        </>
      )}

      {steps.step === 2 && inspection && (
        <>
          <Section title="Options">
            <div className="space-y-3">
              {isPg && inspection.format !== 'plain' && (
                <>
                  <Toggle
                    checked={draft.clean}
                    onChange={(clean) => patch({ clean })}
                    disabled={draft.content === 'data'}
                    label="Drop objects before recreating them"
                    description="Replaces what's already there; without it, objects that exist cause errors"
                  />
                  <Toggle
                    checked={draft.noOwner}
                    onChange={(noOwner) => patch({ noOwner })}
                    label="Skip ownership"
                    description="Objects belong to you rather than to the roles in the backup, which may not exist here"
                  />
                  <Toggle
                    checked={draft.noPrivileges}
                    onChange={(noPrivileges) => patch({ noPrivileges })}
                    label="Skip privileges"
                    description="Leaves out the backup's GRANT and REVOKE statements"
                  />
                </>
              )}
              {isPg && (
                <Toggle
                  checked={
                    draft.singleTransaction &&
                    !(inspection.format === 'plain' && inspection.createsDatabase)
                  }
                  onChange={(singleTransaction) => patch({ singleTransaction })}
                  disabled={inspection.format === 'plain' && inspection.createsDatabase}
                  label="All or nothing"
                  description="Runs in one transaction, so a failure leaves the database untouched"
                />
              )}
              <Toggle
                checked={draft.stopOnError}
                onChange={(stopOnError) => patch({ stopOnError })}
                label="Stop at the first error"
                description="Otherwise the restore carries on and reports the errors at the end"
              />
              {isMongo && (
                <>
                  <Toggle
                    checked={draft.drop}
                    onChange={(drop) => patch({ drop })}
                    label="Drop collections before restoring them"
                    description="Replaces existing collections; without it, documents with the same _id are skipped"
                  />
                  <Toggle
                    checked={draft.noIndexRestore}
                    onChange={(noIndexRestore) => patch({ noIndexRestore })}
                    label="Skip indexes"
                    description="Restores documents only; only _id is indexed afterwards"
                  />
                </>
              )}
            </div>
            {isPg && inspection.format !== 'plain' && !draft.singleTransaction && (
              <Field label="Parallel jobs" className="w-32">
                <Input
                  type="number"
                  min={1}
                  max={32}
                  value={draft.jobs}
                  onChange={(e) =>
                    patch({ jobs: Math.max(1, Math.min(32, Number(e.target.value) || 1)) })
                  }
                />
              </Field>
            )}
          </Section>
          <Section title="Restore tool">
            <ToolStatus kind={restoreKind} tools={tools} loading={toolsLoading} builtin={builtin} />
          </Section>
        </>
      )}

      {steps.step === 3 && inspection && (
        <>
          <Section title="Summary">
            <Summary
              rows={[
                ['Backup', <span className="font-mono text-xs">{inspection.path}</span>],
                [
                  'Restore into',
                  asNamed
                    ? backupDatabases(inspection).join(', ')
                    : `${target}${draft.target === 'new' ? ' (new)' : ''}`
                ],
                [
                  'Includes',
                  `${scopeLabel(selectable ? draft.scope : 'all', draft.scope === 'schemas' ? draft.schemas.length : draft.tables.length, engine)}${isPg && inspection.format !== 'plain' ? ` · ${contentLabel(draft.content).toLowerCase()}` : ''}`
                ]
              ]}
            />
          </Section>
          {destructive && (
            <Callout tone="danger">
              {isMongo
                ? `Collections in ${target} that the backup also holds are dropped and replaced.`
                : `Objects in ${target} that the backup also holds are dropped and replaced.`}
            </Callout>
          )}
          {createsOwn && (
            <Callout tone="warning">
              The backup restores into its own database, {inspection.database}.
            </Callout>
          )}
          <Section
            title={builtin ? 'How it runs' : 'Command'}
            description={
              builtin ? undefined : 'The password is passed privately, never on the command line.'
            }
          >
            {preview.isError ? (
              <ErrorText error={preview.error} />
            ) : (
              <CommandPreview text={preview.data ?? null} loading={preview.isPending} />
            )}
          </Section>
        </>
      )}
    </WizardLayout>
  )
}
