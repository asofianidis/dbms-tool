import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, FileUp, Square, Table2, XCircle } from 'lucide-react'
import { api, type Cell, type ColumnInfo, type ConnectionConfig } from '@/lib/api'
import { ENGINES, type Dialect } from '@/lib/engines'
import { formatBytes, formatDuration } from '@/lib/format'
import {
  autoMap,
  batchLimits,
  beginSql,
  commitSql,
  createTableStatements,
  csvDocuments,
  DEFAULT_CSV,
  detectFormat,
  documentBatches,
  insertBatches,
  parseFile,
  profileColumn,
  rollbackSql,
  sqlType,
  tableNameFromPath,
  type CsvOptions,
  type ImportFormat,
  type NewColumn
} from '@/lib/import'
import { queries, queryClient } from '@/lib/queries'
import { qualified, type TableRef } from '@/lib/sql'
import { errorMessage, toast } from '@/lib/toast'
import {
  connect,
  connectionsStore,
  openCollection,
  openTable,
  setRunning,
  statusStore,
  type TabOf
} from '@/lib/workspace'
import { ResultGrid } from '@/components/grid/ResultGrid'
import {
  Button,
  EmptyState,
  Field,
  Input,
  Segmented,
  Select,
  Spinner,
  Switch,
  Toggle
} from '@/components/ui'
import {
  Callout,
  Choice,
  CommandPreview,
  PathField,
  Section,
  StepFooter,
  Summary,
  useSteps,
  WizardLayout
} from '../backup/Wizard'

/** Imports CSV, TSV or JSON files into a table or collection. */
export function ImportTab({ tab }: { tab: TabOf<'import'> }): React.JSX.Element {
  const connection = connectionsStore.use().find((c) => c.id === tab.connectionId)
  const status = statusStore.use()[tab.connectionId]
  useEffect(() => {
    if (connection && status?.state !== 'connected') void connect(connection.id)
  }, [connection, status?.state])
  if (!connection) return <EmptyState title="This connection no longer exists" />
  if (status?.state !== 'connected')
    return <EmptyState title="Connecting…" icon={<Spinner className="size-5" />} />
  return <ImportWizard tab={tab} connection={connection} />
}

const STEPS = ['File', 'Target', 'Import']
const PREVIEW_ROWS = 50
/** Rows turned into INSERT statements at a time, so huge files don't double in memory */
const CHUNK_ROWS = 10_000

interface NewColumnState extends NewColumn {
  include: boolean
}

interface JobState {
  state: 'running' | 'done' | 'failed' | 'cancelled'
  done: number
  total: number
  /** Rows in batches that failed and were skipped */
  failed: number
  errors: string[]
  startedAt: number
  elapsedMs: number
  /** Rows were rolled back, so none of them stayed */
  rolledBack: boolean
}

class Cancelled extends Error {
  constructor() {
    super('Import cancelled')
  }
}

const DELIMITERS: { value: string; label: string }[] = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe' }
]

const TYPE_SUGGESTIONS: Record<Dialect, string[]> = {
  postgres: [
    'integer',
    'bigint',
    'numeric',
    'double precision',
    'boolean',
    'date',
    'timestamp',
    'timestamptz',
    'jsonb',
    'text',
    'uuid'
  ],
  mysql: [
    'int',
    'bigint',
    'decimal(18,4)',
    'double',
    'boolean',
    'date',
    'datetime(6)',
    'json',
    'varchar(255)',
    'text',
    'longtext'
  ],
  tsql: [
    'int',
    'bigint',
    'decimal(18,4)',
    'float',
    'bit',
    'date',
    'datetime2',
    'datetimeoffset',
    'nvarchar(255)',
    'nvarchar(max)',
    'uniqueidentifier'
  ],
  sqlite: ['INTEGER', 'REAL', 'NUMERIC', 'TEXT', 'BLOB']
}

function firstValue(rows: Cell[][], col: number): string {
  for (let i = 0; i < rows.length && i < PREVIEW_ROWS; i++) {
    const v = rows[i][col]
    if (v !== null && v !== '') return String(v)
  }
  return ''
}

function ImportWizard({
  tab,
  connection
}: {
  tab: TabOf<'import'>
  connection: ConnectionConfig
}): React.JSX.Element {
  const steps = useSteps()
  const engine = ENGINES[connection.engine]
  const isMongo = connection.engine === 'mongo'
  const dialect: Dialect = engine.dialect ?? 'postgres'
  const hasSchemas = engine.hasSchemas && !isMongo
  const defaultSchema = dialect === 'postgres' ? 'public' : dialect === 'tsql' ? 'dbo' : null
  const d1 = connection.cloud?.provider === 'cloudflare'
  const database = tab.database

  /* ----- File ----- */
  const [path, setPath] = useState('')
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [format, setFormat] = useState<ImportFormat>('csv')
  const [csv, setCsv] = useState<CsvOptions>(DEFAULT_CSV)

  const load = async (file: string): Promise<void> => {
    setPath(file)
    if (!file.trim()) return
    const detected = detectFormat(file)
    setFormat(detected.format)
    setCsv((c) => ({ ...c, delimiter: detected.delimiter }))
    setLoading(true)
    setLoadError(null)
    try {
      setText(await api.readText(file))
      setNewName((n) => n || tableNameFromPath(file))
      if (isMongo) setTable((t) => t || tableNameFromPath(file))
    } catch (e) {
      setText(null)
      setLoadError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  const parsed = useMemo(() => {
    if (text === null) return null
    try {
      return { file: parseFile(text, format, csv), error: null }
    } catch (e) {
      return { file: null, error: errorMessage(e) }
    }
  }, [text, format, csv])
  const file = parsed?.file ?? null
  const columnsKey = file?.columns.join('\u0000') ?? ''

  /* ----- Target ----- */
  const [mode, setMode] = useState<'existing' | 'new'>(tab.table || isMongo ? 'existing' : 'new')
  const [schema, setSchema] = useState<string | null>(
    hasSchemas ? (tab.schema ?? defaultSchema) : null
  )
  const [table, setTable] = useState(tab.table ?? '')
  const [newName, setNewName] = useState('')
  const [mapping, setMapping] = useState<(string | null)[]>([])
  const [newColumns, setNewColumns] = useState<NewColumnState[]>([])
  const [emptyAsNull, setEmptyAsNull] = useState(true)
  const [onError, setOnError] = useState<'rollback' | 'skip'>('rollback')
  const [typed, setTyped] = useState(true)

  const schemas = useQuery({ ...queries.schemas(connection.id, database), enabled: hasSchemas })
  const objects = useQuery(queries.objects(connection.id, database, hasSchemas ? schema : null))
  const targets = (objects.data ?? []).filter((o) =>
    isMongo ? o.kind === 'collection' || o.kind === 'timeseries' : o.kind === 'table'
  )
  const info = useQuery({
    ...queries.table(connection.id, database, schema, table),
    enabled: !isMongo && mode === 'existing' && !!table
  })
  const tableColumns: ColumnInfo[] = useMemo(() => info.data?.columns ?? [], [info.data])

  // Inferred columns for a new table, whenever the file's columns change
  useEffect(() => {
    if (!file) return
    setNewColumns(
      file.columns.map((name, i) => ({
        include: true,
        name,
        dataType: sqlType(dialect, profileColumn(file.rows, i))
      }))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey, dialect, parsed])

  useEffect(() => {
    if (!file) return
    setMapping(
      autoMap(
        file.columns,
        tableColumns.map((c) => c.name)
      )
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey, tableColumns])

  const refSchema = dialect === 'mysql' || dialect === 'sqlite' ? null : schema
  const targetName = isMongo ? table.trim() : mode === 'existing' ? table : newName.trim()
  const ref: TableRef = { schema: refSchema, name: targetName }

  /** The file columns that get imported, and the table column each lands in. */
  const plan = useMemo((): { source: number; column: NewColumn; identity: boolean }[] => {
    if (!file || isMongo) return []
    if (mode === 'new')
      return newColumns.flatMap((c, i) =>
        c.include
          ? [
              {
                source: i,
                column: { name: c.name.trim(), dataType: c.dataType.trim() },
                identity: false
              }
            ]
          : []
      )
    return mapping.flatMap((target, i) => {
      const col = target ? tableColumns.find((c) => c.name === target) : undefined
      return col
        ? [
            {
              source: i,
              column: { name: col.name, dataType: col.dataType },
              identity: col.isIdentity
            }
          ]
        : []
    })
  }, [file, isMongo, mode, newColumns, mapping, tableColumns])

  const ddl = useMemo(
    () =>
      !isMongo && mode === 'new' && targetName && plan.length
        ? createTableStatements(
            dialect,
            ref,
            plan.map((p) => p.column)
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isMongo, mode, targetName, refSchema, plan, dialect]
  )

  /* ----- Problems ----- */
  const fileProblem = ((): string | null => {
    if (connection.readOnly) return 'This connection is read-only'
    if (loading) return 'Reading the file…'
    if (loadError) return loadError
    if (!text && !path) return 'Choose a file to import'
    if (!parsed) return 'Choose a file to import'
    if (parsed.error) return parsed.error
    if (!file?.rows.length) return 'The file has no rows'
    return null
  })()

  const targetProblem = ((): string | null => {
    if (isMongo) return targetName ? null : 'Enter a collection to import into'
    if (hasSchemas && !schema) return 'Choose a schema'
    if (mode === 'existing') {
      if (!table) return 'Choose a table'
      if (info.isLoading) return 'Loading the table…'
      if (info.error) return errorMessage(info.error)
      if (!plan.length) return 'Map at least one file column to a table column'
      const used = new Set<string>()
      for (const p of plan) {
        if (used.has(p.column.name)) return `Two file columns go into ${p.column.name}`
        used.add(p.column.name)
      }
      return null
    }
    if (!newName.trim()) return 'Enter a name for the new table'
    if (targets.some((t) => t.name.toLowerCase() === newName.trim().toLowerCase()))
      return `${newName.trim()} already exists; import into it instead`
    if (!plan.length) return 'Include at least one column'
    const seen = new Set<string>()
    for (const p of plan) {
      if (!p.column.name) return 'Every column needs a name'
      if (!p.column.dataType) return `Column ${p.column.name} needs a type`
      const key = p.column.name.toLowerCase()
      if (seen.has(key)) return `There are two columns named ${p.column.name}`
      seen.add(key)
    }
    return null
  })()

  /* ----- Running ----- */
  const [job, setJob] = useState<JobState | null>(null)
  const cancelled = useRef(false)
  const session = useRef<string | null>(null)
  const running = job?.state === 'running'

  const cancel = (): void => {
    cancelled.current = true
    if (session.current) void api.cancel(connection.id, session.current).catch(() => {})
  }

  const finish = (patch: Partial<JobState>): void => {
    setJob((j) => (j ? { ...j, ...patch, elapsedMs: Date.now() - j.startedAt } : j))
  }

  const refresh = (): void => {
    for (const part of ['objects', 'table', 'completion'])
      void queryClient.invalidateQueries({ queryKey: ['conn', connection.id, part, database] })
  }

  const runSql = async (key: string): Promise<void> => {
    if (!file) return
    const useTransaction = onError === 'rollback' && !d1
    const rows = file.rows.map((r) => plan.map((p) => r[p.source]))
    const columns = plan.map((p) => p.column)
    const exec = async (sql: string): Promise<void> => {
      const out = await api.execute(connection.id, key, database, sql, { maxRows: 1 })
      if (out.cancelled || cancelled.current) throw new Cancelled()
      if (out.error) throw new Error(out.error.message)
    }
    let open = false
    let done = 0
    let failed = 0
    const errors: string[] = []
    try {
      // MySQL commits DDL implicitly, so the table is created before the transaction
      const ddlFirst = !useTransaction || dialect === 'mysql'
      if (ddlFirst) for (const s of ddl) await exec(s)
      if (useTransaction) {
        await exec(beginSql(dialect))
        open = true
      }
      if (!ddlFirst) for (const s of ddl) await exec(s)
      const identityInsert = dialect === 'tsql' && plan.some((p) => p.identity)
      if (identityInsert) await exec(`SET IDENTITY_INSERT ${qualified(dialect, ref)} ON`)
      const limits = batchLimits(dialect)
      for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
        const chunk = rows.slice(start, start + CHUNK_ROWS)
        for (const batch of insertBatches(dialect, ref, columns, chunk, emptyAsNull, limits)) {
          if (cancelled.current) throw new Cancelled()
          try {
            await exec(batch.sql)
            done += batch.rows
          } catch (e) {
            if (useTransaction || e instanceof Cancelled) throw e
            failed += batch.rows
            if (errors.length < 20)
              errors.push(
                `Rows ${done + failed - batch.rows + 1}–${done + failed}: ${errorMessage(e)}`
              )
          }
          setJob((j) => (j ? { ...j, done: done + failed, failed, errors: [...errors] } : j))
        }
      }
      if (identityInsert) await exec(`SET IDENTITY_INSERT ${qualified(dialect, ref)} OFF`)
      if (open) {
        await exec(commitSql(dialect))
        open = false
      }
      finish({ state: 'done', done, failed, errors, rolledBack: false })
      toast(
        failed
          ? `Imported ${done.toLocaleString()} rows into ${targetName}; skipped ${failed.toLocaleString()}`
          : `Imported ${done.toLocaleString()} rows into ${targetName}`,
        failed ? 'error' : 'success'
      )
    } catch (e) {
      if (open)
        await api.execute(connection.id, key, database, rollbackSql(dialect)).catch(() => {})
      const wasCancelled = e instanceof Cancelled || cancelled.current
      if (!wasCancelled) errors.unshift(errorMessage(e))
      finish({
        state: wasCancelled ? 'cancelled' : 'failed',
        done: open ? 0 : done,
        failed,
        errors,
        rolledBack: open
      })
    }
  }

  const runMongo = async (key: string): Promise<void> => {
    if (!file) return
    const docs = file.documents ?? csvDocuments(file.columns, file.rows, typed, emptyAsNull)
    let done = 0
    try {
      for (const batch of documentBatches(docs)) {
        if (cancelled.current) throw new Cancelled()
        const out = await api.mongo(connection.id, key, {
          op: 'insertMany',
          database,
          collection: targetName,
          documents: batch
        })
        if (out.cancelled) throw new Cancelled()
        done += batch.length
        setJob((j) => (j ? { ...j, done } : j))
      }
      finish({ state: 'done', done })
      toast(`Imported ${done.toLocaleString()} documents into ${targetName}`)
    } catch (e) {
      const wasCancelled = e instanceof Cancelled || cancelled.current
      finish({
        state: wasCancelled ? 'cancelled' : 'failed',
        done,
        errors: wasCancelled ? [] : [errorMessage(e)]
      })
    }
  }

  const start = async (): Promise<void> => {
    if (!file || running) return
    if (!(await connect(connection.id))) return
    const key = `import:${crypto.randomUUID()}`
    session.current = key
    cancelled.current = false
    setJob({
      state: 'running',
      done: 0,
      total: file.rows.length,
      failed: 0,
      errors: [],
      startedAt: Date.now(),
      elapsedMs: 0,
      rolledBack: false
    })
    setRunning(tab.id, true)
    try {
      if (isMongo) await runMongo(key)
      else await runSql(key)
    } finally {
      if (!isMongo) void api.closeSession(connection.id, key).catch(() => {})
      session.current = null
      setRunning(tab.id, false)
      refresh()
    }
  }

  const openTarget = (): void => {
    if (isMongo) openCollection(connection.id, database, targetName, 'documents')
    else openTable(connection.id, database, refSchema, targetName, 'table', 'data')
  }

  const problem =
    steps.step === 0
      ? fileProblem
      : steps.step === 1
        ? targetProblem
        : (fileProblem ?? targetProblem)
  const where = isMongo ? `${database}.${targetName}` : qualified(dialect, ref)
  const noun = isMongo ? 'documents' : 'rows'

  return (
    <WizardLayout
      icon={<FileUp />}
      title="Import data"
      subtitle={`${connection.name || connection.host} · ${database}${tab.table ? ` · ${tab.table}` : ''}`}
      steps={STEPS}
      step={steps.step}
      reached={running ? steps.step : steps.reached}
      onStep={steps.go}
      footer={
        running ? (
          <>
            <span className="mr-auto text-xs text-muted">Importing…</span>
            <Button variant="danger" onClick={cancel}>
              <Square className="size-3 fill-current" /> Cancel
            </Button>
          </>
        ) : job && job.state !== 'running' && steps.step === 2 ? (
          <>
            <span className="mr-auto" />
            {job.state === 'done' && (
              <Button variant="secondary" onClick={openTarget}>
                <Table2 className="size-3.5" /> Open {isMongo ? 'collection' : 'table'}
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => {
                setJob(null)
                steps.reset()
              }}
            >
              Import another file
            </Button>
          </>
        ) : (
          <StepFooter
            step={steps.step}
            last={STEPS.length - 1}
            problem={problem}
            onBack={() => steps.go(steps.step - 1)}
            onNext={() => (steps.step < STEPS.length - 1 ? steps.go(steps.step + 1) : void start())}
            startLabel="Import"
            startIcon={<FileUp className="size-3.5" />}
          />
        )
      }
    >
      {connection.readOnly && (
        <Callout tone="warning">
          This connection is read-only. Turn off &ldquo;Read-only&rdquo; in the connection settings
          to import data.
        </Callout>
      )}

      {steps.step === 0 && (
        <>
          <Section title="File" description="CSV, TSV, a JSON array of objects, or JSON lines.">
            <PathField
              value={path}
              onChange={setPath}
              onPick={(p) => void load(p)}
              mode="file"
              placeholder="Choose a file…"
              filters={[
                {
                  name: 'Data files',
                  extensions: ['csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson']
                },
                { name: 'All files', extensions: ['*'] }
              ]}
            />
            {path && !text && !loading && (
              <Button size="sm" variant="secondary" onClick={() => void load(path)}>
                Read file
              </Button>
            )}
          </Section>

          {text !== null && (
            <Section
              title="Format"
              aside={
                <span className="text-xs text-muted">
                  {formatBytes(text.length)}
                  {file &&
                    ` · ${file.rows.length.toLocaleString()} ${noun} · ${file.columns.length} columns`}
                </span>
              }
            >
              <div className="flex flex-wrap items-end gap-4">
                <Segmented
                  value={format}
                  onChange={setFormat}
                  options={[
                    { value: 'csv', label: 'CSV / TSV' },
                    { value: 'json', label: 'JSON' },
                    { value: 'jsonl', label: 'JSON lines' }
                  ]}
                />
                {format === 'csv' && (
                  <>
                    <Field label="Delimiter" className="w-36">
                      <Select
                        value={csv.delimiter}
                        onChange={(e) => setCsv({ ...csv, delimiter: e.target.value })}
                      >
                        {DELIMITERS.map((d) => (
                          <option key={d.label} value={d.value}>
                            {d.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Quote" className="w-32">
                      <Select
                        value={csv.quote}
                        onChange={(e) => setCsv({ ...csv, quote: e.target.value })}
                      >
                        <option value={'"'}>Double &quot;</option>
                        <option value={"'"}>Single &apos;</option>
                        <option value="">None</option>
                      </Select>
                    </Field>
                    <label className="flex h-8 items-center gap-2 text-[13px] text-bright">
                      <Switch
                        checked={csv.header}
                        onChange={(header) => setCsv({ ...csv, header })}
                      />
                      First row is a header
                    </label>
                  </>
                )}
              </div>
              {parsed?.error && <Callout tone="danger">{parsed.error}</Callout>}
              {file && (
                <div className="h-72 overflow-hidden rounded-lg border border-line">
                  <ResultGrid
                    columns={file.columns.map((name) => ({ name, typeName: '' }))}
                    rows={file.rows.slice(0, PREVIEW_ROWS)}
                  />
                </div>
              )}
            </Section>
          )}
        </>
      )}

      {steps.step === 1 && file && (
        <>
          {isMongo ? (
            <Section
              title="Collection"
              description="Documents go into this collection; MongoDB creates it if it doesn't exist."
            >
              <Input
                mono
                value={table}
                list="import-collections"
                onChange={(e) => setTable(e.target.value)}
                placeholder="collection"
              />
              <datalist id="import-collections">
                {targets.map((t) => (
                  <option key={t.name} value={t.name} />
                ))}
              </datalist>
              {!file.documents && (
                <div className="space-y-3">
                  <Toggle
                    checked={typed}
                    onChange={setTyped}
                    label="Detect types"
                    description="Store numbers, true / false and null as BSON values instead of strings. Dotted headers such as address.city become nested fields."
                  />
                  <Toggle
                    checked={emptyAsNull}
                    onChange={setEmptyAsNull}
                    label="Empty values are null"
                  />
                </div>
              )}
            </Section>
          ) : (
            <>
              <Section title="Target">
                <Choice
                  value={mode}
                  onChange={setMode}
                  options={[
                    {
                      value: 'existing',
                      label: 'An existing table',
                      description: 'Match file columns to the table’s columns.'
                    },
                    {
                      value: 'new',
                      label: 'A new table',
                      description: 'Created with column types guessed from the file.'
                    }
                  ]}
                />
                <div className="flex flex-wrap gap-3">
                  {hasSchemas && (
                    <Field label="Schema" className="w-48">
                      <Select value={schema ?? ''} onChange={(e) => setSchema(e.target.value)}>
                        {!schemas.data?.some((s) => s.name === schema) && schema && (
                          <option value={schema}>{schema}</option>
                        )}
                        {schemas.data?.map((s) => (
                          <option key={s.name} value={s.name}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  {mode === 'existing' ? (
                    <Field label="Table" className="min-w-56 flex-1">
                      <Select value={table} onChange={(e) => setTable(e.target.value)}>
                        <option value="">Choose a table…</option>
                        {targets.map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : (
                    <Field label="New table name" className="min-w-56 flex-1">
                      <Input mono value={newName} onChange={(e) => setNewName(e.target.value)} />
                    </Field>
                  )}
                </div>
              </Section>

              {mode === 'existing' && table && (
                <Section
                  title="Columns"
                  description="Each file column goes into the table column next to it. Unmatched columns are skipped; table columns nobody fills get their default."
                >
                  {info.isLoading ? (
                    <Spinner />
                  ) : (
                    <ColumnTable>
                      {file.columns.map((name, i) => (
                        <tr key={i} className="border-t border-line">
                          <td className="px-3 py-1.5 font-mono text-bright">{name}</td>
                          <td className="max-w-48 truncate px-3 py-1.5 font-mono text-muted">
                            {firstValue(file.rows, i)}
                          </td>
                          <td className="px-3 py-1">
                            <Select
                              value={mapping[i] ?? ''}
                              onChange={(e) => {
                                const next = [...mapping]
                                next[i] = e.target.value || null
                                setMapping(next)
                              }}
                            >
                              <option value="">Skip</option>
                              {tableColumns.map((c) => (
                                <option key={c.name} value={c.name}>
                                  {c.name} ({c.dataType})
                                </option>
                              ))}
                            </Select>
                          </td>
                        </tr>
                      ))}
                    </ColumnTable>
                  )}
                </Section>
              )}

              {mode === 'new' && (
                <Section
                  title="Columns"
                  description="Types are guessed from every value in the file; change any of them."
                >
                  <datalist id="import-types">
                    {TYPE_SUGGESTIONS[dialect].map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                  <ColumnTable newTable>
                    {newColumns.map((c, i) => {
                      const patch = (p: Partial<NewColumnState>): void =>
                        setNewColumns(newColumns.map((x, j) => (j === i ? { ...x, ...p } : x)))
                      return (
                        <tr key={i} className="border-t border-line">
                          <td className="px-3 py-1">
                            <Switch
                              checked={c.include}
                              onChange={(include) => patch({ include })}
                              label={`Import ${file.columns[i]}`}
                            />
                          </td>
                          <td className="px-3 py-1">
                            <Input
                              mono
                              value={c.name}
                              disabled={!c.include}
                              onChange={(e) => patch({ name: e.target.value })}
                            />
                          </td>
                          <td className="px-3 py-1">
                            <Input
                              mono
                              list="import-types"
                              value={c.dataType}
                              disabled={!c.include}
                              onChange={(e) => patch({ dataType: e.target.value })}
                            />
                          </td>
                          <td className="max-w-40 truncate px-3 py-1.5 font-mono text-muted">
                            {firstValue(file.rows, i)}
                          </td>
                        </tr>
                      )
                    })}
                  </ColumnTable>
                </Section>
              )}

              <Section title="Options">
                <Toggle
                  checked={emptyAsNull}
                  onChange={setEmptyAsNull}
                  label="Empty values are NULL"
                  description="Otherwise an empty field is an empty string."
                />
                <Choice
                  value={onError}
                  onChange={setOnError}
                  options={[
                    {
                      value: 'rollback',
                      label: 'All or nothing',
                      description: d1
                        ? 'D1 runs each request on its own, so this stops at the first error but keeps rows already inserted.'
                        : 'One transaction: the first error rolls back every row.',
                      badge: 'Default'
                    },
                    {
                      value: 'skip',
                      label: 'Skip failing batches',
                      description:
                        'Each batch commits on its own; batches with an error are reported and skipped.'
                    }
                  ]}
                />
                {dialect === 'mysql' && mode === 'new' && onError === 'rollback' && (
                  <Callout>
                    MySQL commits CREATE TABLE straight away, so the new table stays even if the
                    import rolls back.
                  </Callout>
                )}
              </Section>
            </>
          )}
        </>
      )}

      {steps.step === 2 && file && (
        <>
          <Section title="Review">
            <Summary
              rows={[
                [
                  'File',
                  <span key="f" className="font-mono break-all">
                    {path}
                  </span>
                ],
                [isMongo ? 'Documents' : 'Rows', file.rows.length.toLocaleString()],
                [
                  isMongo ? 'Collection' : mode === 'new' ? 'New table' : 'Table',
                  <span key="t" className="font-mono">
                    {where}
                  </span>
                ],
                ...(!isMongo
                  ? ([
                      ['Columns', `${plan.length} of ${file.columns.length}`],
                      [
                        'On error',
                        onError === 'rollback' ? 'Roll back everything' : 'Skip the batch'
                      ]
                    ] as [string, string][])
                  : [])
              ]}
            />
            {ddl.length > 0 && <CommandPreview text={ddl.map((s) => `${s};`).join('\n\n')} />}
          </Section>
          {job && <JobPanel job={job} noun={noun} where={where} />}
        </>
      )}
    </WizardLayout>
  )
}

function ColumnTable({
  newTable,
  children
}: {
  newTable?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <table className="w-full text-[12.5px]">
        <thead className="bg-panel text-left text-[11px] text-muted">
          <tr>
            {newTable ? (
              <>
                <th className="w-12 px-3 py-1.5 font-medium">Use</th>
                <th className="px-3 py-1.5 font-medium">Column</th>
                <th className="px-3 py-1.5 font-medium">Type</th>
                <th className="px-3 py-1.5 font-medium">First value</th>
              </>
            ) : (
              <>
                <th className="px-3 py-1.5 font-medium">File column</th>
                <th className="px-3 py-1.5 font-medium">First value</th>
                <th className="w-1/2 px-3 py-1.5 font-medium">Table column</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function JobPanel({
  job,
  noun,
  where
}: {
  job: JobState
  noun: string
  where: string
}): React.JSX.Element {
  const pct = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0
  const imported = (job.state === 'running' ? job.done - job.failed : job.done).toLocaleString()
  return (
    <section className="space-y-3 rounded-lg border border-line bg-panel p-4">
      <div className="flex items-center gap-2 text-[13px]">
        {job.state === 'running' && <Spinner />}
        {job.state === 'done' && <CheckCircle2 className="size-4 text-ok" />}
        {(job.state === 'failed' || job.state === 'cancelled') && (
          <XCircle className="size-4 text-danger" />
        )}
        <span className="text-bright">
          {job.state === 'running'
            ? `Importing… ${job.done.toLocaleString()} of ${job.total.toLocaleString()} ${noun}`
            : job.state === 'done'
              ? `Imported ${imported} ${noun} into ${where}`
              : job.state === 'cancelled'
                ? 'Import cancelled'
                : 'Import failed'}
        </span>
        <span className="ml-auto text-xs text-muted tabular-nums">
          {job.state === 'running' ? `${pct}%` : formatDuration(job.elapsedMs)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-line">
        <div
          className={
            job.state === 'failed' || job.state === 'cancelled'
              ? 'h-full bg-danger transition-[width]'
              : 'h-full bg-accent transition-[width]'
          }
          style={{ width: `${job.state === 'done' ? 100 : pct}%` }}
        />
      </div>
      {job.state === 'done' && job.failed > 0 && (
        <p className="text-xs text-muted">
          {job.failed.toLocaleString()} {noun} in failing batches were skipped.
        </p>
      )}
      {job.state !== 'running' && job.state !== 'done' && (
        <p className="text-xs text-muted">
          {job.rolledBack
            ? 'The transaction was rolled back, so no rows were imported.'
            : `${job.done.toLocaleString()} ${noun} were imported before it stopped${
                job.failed ? `; ${job.failed.toLocaleString()} in failing batches were skipped` : ''
              }.`}
        </p>
      )}
      {job.errors.length > 0 && (
        <pre className="max-h-48 overflow-auto rounded-md border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-fg select-text">
          {job.errors.join('\n')}
        </pre>
      )}
    </section>
  )
}
