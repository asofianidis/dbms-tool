import { useEffect, useRef, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { FileCode2, Play, Wrench } from 'lucide-react'
import { api, type ConnectionConfig, type DbObject } from '@/lib/api'
import { ENGINES } from '@/lib/engines'
import {
  maintenanceScript,
  maintenanceSteps,
  maintenanceTasks,
  maintenanceWarnings,
  mongoReplyLines,
  newMaintenanceDraft,
  optionInfo,
  resultErrors,
  resultLines,
  taskInfo,
  validateMaintenance,
  type MaintenanceDraft,
  type MaintenanceStep
} from '@/lib/maintenance'
import { confirmProductionWrite, mongoIsWrite, sqlWriteKeyword } from '@/lib/production'
import { queries, queryClient } from '@/lib/queries'
import type { TableRef } from '@/lib/sql'
import { errorMessage } from '@/lib/toast'
import {
  connect,
  connectionsStore,
  newQueryTab,
  setRunning,
  statusStore,
  type TabOf
} from '@/lib/workspace'
import { Button, EmptyState, Spinner, Toggle } from '@/components/ui'
import {
  Callout,
  Checklist,
  Choice,
  CommandPreview,
  JobPanel,
  Section,
  WizardLayout,
  type JobState,
  type PickItem
} from '../backup/Wizard'

/** Vacuum, analyze, integrity checks and index rebuilds for one database. */
export function MaintenanceTab({ tab }: { tab: TabOf<'maintenance'> }): React.JSX.Element {
  const connection = connectionsStore.use().find((c) => c.id === tab.connectionId)
  const status = statusStore.use()[tab.connectionId]
  useEffect(() => {
    if (connection && status?.state !== 'connected') void connect(connection.id)
  }, [connection, status?.state])
  if (!connection) return <EmptyState title="This connection no longer exists" />
  if (status?.state !== 'connected')
    return <EmptyState title="Connecting…" icon={<Spinner className="size-5" />} />
  if (connection.engine === 'babelfish' || status.info.babelfishVersion) {
    return (
      <EmptyState title="Babelfish doesn’t support maintenance commands">
        Add a PostgreSQL connection to the cluster’s PostgreSQL endpoint and run VACUUM, ANALYZE and
        REINDEX there.
      </EmptyState>
    )
  }
  return <MaintenanceForm tabId={tab.id} connection={connection} database={tab.database} />
}

const keyOf = (t: TableRef): string => `${t.schema ?? ''}\n${t.name}`
const fromKey = (key: string): TableRef => {
  const [schema, name] = key.split('\n')
  return { schema: schema || null, name }
}

/** Tables (or collections) maintenance can run on. */
function useTargets(
  connection: ConnectionConfig,
  database: string
): { tables: TableRef[]; loading: boolean } {
  const engine = connection.engine
  const isPg = engine === 'postgres'
  const schemas = useQuery({ ...queries.schemas(connection.id, database), enabled: isPg })
  const userSchemas = (schemas.data ?? []).filter((s) => !s.isSystem).map((s) => s.name)
  const objectQueries = useQueries({
    queries: isPg
      ? userSchemas.map((s) => queries.objects(connection.id, database, s))
      : [queries.objects(connection.id, database, null)]
  })
  const objects: DbObject[] = objectQueries.flatMap((q) => q.data ?? [])
  const loading = objectQueries.some((q) => q.isPending) || (isPg && schemas.isPending)
  const kinds =
    engine === 'mongo' ? ['collection'] : isPg ? ['table', 'materialized_view'] : ['table']
  // Only PostgreSQL and SQL Server need the schema to name a table
  const withSchema = isPg || engine === 'mssql'
  const tables = objects
    .filter((o) => kinds.includes(o.kind))
    .map((o) => ({ schema: withSchema ? o.schema : null, name: o.name }))
  return { tables, loading }
}

function MaintenanceForm({
  tabId,
  connection,
  database
}: {
  tabId: string
  connection: ConnectionConfig
  database: string
}): React.JSX.Element {
  const engine = connection.engine
  const tasks = maintenanceTasks(engine)
  const [draft, setDraft] = useState<MaintenanceDraft>(() => newMaintenanceDraft(engine))
  const patch = (p: Partial<MaintenanceDraft>): void => setDraft((d) => ({ ...d, ...p }))
  const { tables, loading } = useTargets(connection, database)
  const runner = useMaintenanceJob(tabId)

  const info = taskInfo(engine, draft.task)
  const steps = maintenanceSteps(engine, database, draft, tables)
  const script = maintenanceScript(engine, steps)
  const warnings = maintenanceWarnings(engine, draft)
  const noun = engine === 'mongo' ? 'collection' : 'table'
  const writes = steps.some((s) =>
    'sql' in s
      ? !!sqlWriteKeyword(s.sql)
      : mongoIsWrite({ op: 'runCommand', database, command: s.command })
  )
  const problem =
    connection.readOnly && writes
      ? 'This connection is read-only'
      : loading && (draft.scope === 'tables' || info?.eachTable)
        ? `Loading ${noun}s…`
        : validateMaintenance(engine, draft, steps)

  const title = `Maintenance on ${database}`
  const subtitle = `${ENGINES[engine].label} · ${connection.name || connection.host}`

  if (!tasks.length) {
    return <EmptyState title="Maintenance isn’t available for this kind of connection" />
  }

  if (runner.job) {
    return (
      <WizardLayout
        icon={<Wrench />}
        title={title}
        subtitle={subtitle}
        steps={[]}
        step={0}
        reached={0}
        onStep={() => undefined}
      >
        <JobPanel
          job={runner.job}
          noun={info?.label ?? 'Maintenance'}
          onCancel={runner.cancel}
          actions={
            <Button variant="secondary" onClick={runner.clear}>
              Back to tasks
            </Button>
          }
        />
      </WizardLayout>
    )
  }

  const run = async (): Promise<void> => {
    if (writes) {
      const ok = await confirmProductionWrite(connection, {
        action: `This runs ${info?.label.toLowerCase()} on ${database}`,
        dangers: [],
        code: script.length > 2000 ? script.slice(0, 2000) + '\n…' : script
      })
      if (!ok) return
    }
    await runner.start(connection.id, database, steps)
    void queryClient.invalidateQueries({ queryKey: ['conn', connection.id, 'databases'] })
  }

  const tableItems: PickItem[] = tables.map((t) => ({
    key: keyOf(t),
    label: t.name,
    group: t.schema ?? undefined
  }))

  return (
    <WizardLayout
      icon={<Wrench />}
      title={title}
      subtitle={subtitle}
      steps={[]}
      step={0}
      reached={0}
      onStep={() => undefined}
      footer={
        <>
          {problem ? (
            <span className="mr-auto truncate text-xs text-muted">{problem}</span>
          ) : (
            <span className="mr-auto text-xs text-muted">
              {steps.length === 1 ? '1 statement' : `${steps.length} statements`}
            </span>
          )}
          <Button
            variant="secondary"
            disabled={!steps.length}
            onClick={() => newQueryTab(connection.id, database, script)}
          >
            <FileCode2 className="size-3.5" />
            Open in editor
          </Button>
          <Button variant="primary" disabled={!!problem} onClick={() => void run()}>
            <Play className="size-3.5" />
            Run {info?.label.toLowerCase()}
          </Button>
        </>
      }
    >
      <Section title="Task">
        <Choice
          value={draft.task}
          options={tasks.map((t) => ({
            value: t.value,
            label: t.label,
            description: t.description,
            title: t.hint
          }))}
          onChange={(task) => patch({ task })}
        />
      </Section>

      {info && info.options.length > 0 && (
        <Section title="Options">
          <div className="space-y-3 rounded-lg border border-line bg-panel px-4 py-3">
            {info.options.map((option) => {
              const { label, description, hint } = optionInfo(engine, draft.task, option)
              return (
                <Toggle
                  key={option}
                  checked={!!draft.options[option]}
                  onChange={(on) => patch({ options: { ...draft.options, [option]: on } })}
                  label={label}
                  description={description}
                  title={hint}
                />
              )
            })}
          </div>
        </Section>
      )}

      {info?.perTable && (
        <Section
          title={engine === 'mongo' ? 'Collections' : 'Tables'}
          aside={loading ? <Spinner /> : undefined}
        >
          <Choice
            value={draft.scope}
            options={[
              {
                value: 'all',
                label: 'Whole database',
                description: info.eachTable
                  ? `Every ${noun}, one at a time (${tables.length})`
                  : `One statement for the whole database`
              },
              {
                value: 'tables',
                label: engine === 'mongo' ? 'Chosen collections' : 'Chosen tables',
                description: `Pick the ${noun}s to run on`
              }
            ]}
            onChange={(scope) => patch({ scope })}
          />
          {draft.scope === 'tables' && (
            <Checklist
              items={tableItems}
              selected={draft.tables.map(keyOf)}
              onChange={(keys) => patch({ tables: keys.map(fromKey) })}
              empty={loading ? 'Loading…' : `No ${noun}s`}
            />
          )}
        </Section>
      )}

      {warnings.map((w) => (
        <Callout key={w} tone="warning">
          {w}
        </Callout>
      ))}

      <Section title="Script" description="Each statement runs on its own, in this order.">
        <CommandPreview text={script || '—'} />
      </Section>
    </WizardLayout>
  )
}

/**
 * Runs maintenance steps one by one on their own session, logging each step's
 * output and carrying on past failures so one bad table doesn't stop the rest.
 */
function useMaintenanceJob(tabId: string): {
  job: JobState | null
  start: (connectionId: string, database: string, steps: MaintenanceStep[]) => Promise<void>
  cancel: () => void
  clear: () => void
} {
  const [job, setJob] = useState<JobState | null>(null)
  const session = `maintenance-${tabId}`
  const running = useRef<string | null>(null)
  const stopped = useRef(false)
  useEffect(
    () => () => {
      stopped.current = true
      if (running.current) void api.cancel(running.current, session)
      setRunning(tabId, false)
    },
    [tabId, session]
  )
  const add = (lines: string[], patch: Partial<JobState> = {}): void =>
    setJob((s) => s && { ...s, ...patch, lines: lines.length ? s.lines.concat(lines) : s.lines })

  const start = async (
    connectionId: string,
    database: string,
    steps: MaintenanceStep[]
  ): Promise<void> => {
    running.current = connectionId
    stopped.current = false
    const startedAt = Date.now()
    setJob({
      status: 'running',
      lines: [],
      percent: steps.length > 1 ? 0 : null,
      startedAt,
      elapsedMs: null,
      error: null,
      size: null,
      errors: 0
    })
    setRunning(tabId, true)
    let errors = 0
    let lastError: string | null = null
    let cancelled = false
    try {
      for (const [i, step] of steps.entries()) {
        if (stopped.current) {
          cancelled = true
          break
        }
        const lines = steps.length > 1 ? [`▸ ${step.label}`] : []
        let output: string[] = []
        try {
          if ('sql' in step) {
            const out = await api.execute(connectionId, session, database, step.sql, {
              confirmed: true
            })
            if (out.cancelled) {
              cancelled = true
              break
            }
            output = [
              ...out.messages.filter((m) => m.level !== 'rows').map((m) => m.text),
              ...out.results.flatMap(resultLines)
            ]
            errors += out.results.reduce((n, set) => n + resultErrors(set), 0)
            if (out.error) {
              errors++
              lastError = out.error.message
              output.push(`Failed: ${out.error.message}`)
            }
          } else {
            const out = await api.mongo(
              connectionId,
              session,
              { op: 'runCommand', database, command: step.command },
              { confirmed: true }
            )
            if (out.cancelled) {
              cancelled = true
              break
            }
            const reply = mongoReplyLines(step.command, out.value)
            if (reply.failed) errors++
            output = reply.lines
          }
        } catch (e) {
          errors++
          lastError = errorMessage(e)
          output = [`Failed: ${lastError}`]
        }
        const indent = steps.length > 1 ? '  ' : ''
        add(
          [...lines, ...(output.length ? output : ['OK']).map((l) => indent + l)],
          steps.length > 1 ? { percent: (100 * (i + 1)) / steps.length } : {}
        )
      }
      // A single statement that failed is a failed run, not one with errors
      const failedOutright = steps.length === 1 && lastError !== null
      setJob(
        (s) =>
          s && {
            ...s,
            status: cancelled ? 'cancelled' : failedOutright ? 'failed' : 'done',
            error: failedOutright ? lastError : null,
            percent: cancelled || failedOutright ? s.percent : 100,
            errors: failedOutright ? 0 : errors,
            elapsedMs: Date.now() - startedAt
          }
      )
    } finally {
      running.current = null
      setRunning(tabId, false)
      void api.closeSession(connectionId, session).catch(() => undefined)
    }
  }
  return {
    job,
    start,
    cancel: () => {
      stopped.current = true
      if (running.current) void api.cancel(running.current, session)
    },
    clear: () => setJob(null)
  }
}
