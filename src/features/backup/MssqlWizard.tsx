import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listen } from '@tauri-apps/api/event'
import {
  ArchiveRestore,
  DatabaseBackup,
  FilePlus2,
  Play,
  RotateCcw,
  Search,
  Square,
  Upload
} from 'lucide-react'
import { api, type BackupProgress, type ConnectionConfig, type MssqlStagedBackup } from '@/lib/api'
import {
  MSSQL_RECENT_BACKUPS_SQL,
  defaultMoves,
  defaultMssqlBackupPath,
  fileListSql,
  joinServerPath,
  headerOnlySql,
  mssqlBackupScript,
  mssqlRestoreScript,
  mssqlServerSql,
  newMssqlBackupDraft,
  newMssqlRestoreDraft,
  parseFileList,
  parseHeaderOnly,
  parseMssqlServer,
  parseRecentBackups,
  serverFileName,
  validateMssqlBackup,
  validateMssqlRestore,
  type MssqlBackupDraft,
  type MssqlBackupType,
  type MssqlRestoreDraft
} from '@/lib/backup'
import { cn } from '@/lib/cn'
import { ENGINES } from '@/lib/engines'
import { formatBytes } from '@/lib/format'
import { queries } from '@/lib/queries'
import { errorMessage } from '@/lib/toast'
import { confirm, newQueryTab, refreshConnection, setRunning } from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
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
  Choice,
  JobPanel,
  PathField,
  Section,
  StepFooter,
  Summary,
  WizardLayout,
  defaultFolder,
  useSqlJob,
  useSteps
} from './Wizard'

interface Props {
  tabId: string
  connection: ConnectionConfig
  database: string
}

/** Runs a query on the metadata session and returns its first result set. */
async function meta(connectionId: string, database: string, sql: string) {
  const out = await api.execute(connectionId, '__meta', database, sql)
  if (out.error) throw new Error(out.error.message)
  return out.results[0]
}

function useServer(connectionId: string, database: string) {
  return useQuery({
    queryKey: ['conn', connectionId, 'mssqlBackupServer', database],
    queryFn: async () =>
      parseMssqlServer((await meta(connectionId, 'master', mssqlServerSql(database)))?.rows[0]),
    staleTime: 60_000
  })
}

function Script({ script }: { script: string }): React.JSX.Element {
  return (
    <div className="h-56 overflow-hidden rounded-lg border border-line bg-canvas">
      <CodeEditor
        value={script}
        language={{ kind: 'sql', dialect: 'tsql' }}
        readOnly
        lineNumbers={false}
        className="h-full"
        fontSize={12}
      />
    </div>
  )
}

function serverHint(connection: ConnectionConfig): string {
  return `This path is on the database server (${connection.host || 'localhost'}), not this computer. The SQL Server service account needs access to it.`
}

/* ---------- Backup ---------- */

export function MssqlBackupWizard({ tabId, connection, database }: Props): React.JSX.Element {
  const steps = useSteps()
  const [draft, setDraft] = useState(() => newMssqlBackupDraft(database))
  const patch = (p: Partial<MssqlBackupDraft>): void => setDraft((d) => ({ ...d, ...p }))
  const [customPath, setCustomPath] = useState<string | null>(null)
  // Copy the finished backup from the server to this computer
  const [download, setDownload] = useState(false)
  const [folder, setFolder] = useState('')
  const [customLocal, setCustomLocal] = useState<string | null>(null)
  useEffect(() => {
    void defaultFolder().then(setFolder)
  }, [])
  const runner = useSqlJob(tabId)
  const dbs = useQuery(queries.databases(connection.id))
  const names = (dbs.data ?? []).filter((d) => d.name !== 'tempdb').map((d) => d.name)
  const server = useServer(connection.id, draft.database)
  const info = server.data ?? null
  const path = customPath ?? (info && draft.database ? defaultMssqlBackupPath(info, draft) : '')
  const localPath =
    customLocal ?? (folder && path ? joinServerPath(folder, serverFileName(path)) : '')
  const full = { ...draft, path }
  const script = mssqlBackupScript(full)
  const express = info?.edition === 4
  const azure = info?.edition === 5

  const problem = ((): string | null => {
    if (azure) return 'Azure SQL Database doesn’t support BACKUP'
    if (steps.step === 0 && !draft.database) return 'Choose a database'
    if (steps.step === 0 && draft.type === 'log' && info?.recoveryModel === 'SIMPLE') {
      return 'Log backups need the FULL or BULK_LOGGED recovery model'
    }
    if (steps.step >= 2) {
      const invalid = validateMssqlBackup(full, info)
      if (invalid) return invalid
      if (download && !localPath.trim()) return 'Choose where to save the backup on this computer'
    }
    return null
  })()

  const title = `Back up ${draft.database || 'a database'}`
  const subtitle = `${ENGINES[connection.engine].label} · ${connection.name || connection.host}`
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
          output={download ? localPath : undefined}
          actions={
            <Button variant="secondary" onClick={runner.clear}>
              <RotateCcw className="size-3.5" /> Back to settings
            </Button>
          }
        />
        {runner.job.status === 'done' && (
          <Summary
            rows={[
              ['Saved on the server', <span className="font-mono text-xs">{path}</span>],
              ...(download
                ? [
                    [
                      'Copied to this computer',
                      <span className="font-mono text-xs">{localPath}</span>
                    ] as [string, React.ReactNode]
                  ]
                : [])
            ]}
          />
        )}
      </WizardLayout>
    )
  }

  const STEPS = ['Source', 'Options', 'Destination', 'Review']
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
              : void runner.start(
                  connection.id,
                  script,
                  download ? { source: path, file: localPath } : undefined
                )
          }
          startLabel="Start backup"
          startIcon={<Play className="size-3.5" />}
          extra={
            steps.step === STEPS.length - 1 && (
              <Button variant="ghost" onClick={() => newQueryTab(connection.id, 'master', script)}>
                <FilePlus2 className="size-3.5" /> Open in editor
              </Button>
            )
          }
        />
      }
    >
      {azure && (
        <Callout tone="warning">
          Azure SQL Database takes backups automatically and doesn’t support BACKUP. Use
          point-in-time restore or a BACPAC export in the Azure portal instead.
        </Callout>
      )}

      {steps.step === 0 && (
        <>
          <Section title="Database">
            <Select
              className="max-w-sm"
              value={draft.database}
              onChange={(e) => patch({ database: e.target.value })}
            >
              {!draft.database && <option value="">Choose a database…</option>}
              {names.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
            {info?.recoveryModel && (
              <p className="text-xs text-muted">
                Recovery model: {info.recoveryModel.toLowerCase().replace('_', '-')}
              </p>
            )}
          </Section>
          <Section title="Backup type">
            <Choice<MssqlBackupType>
              value={draft.type}
              onChange={(type) => {
                patch({ type })
                // A typed path keeps its name, but log backups conventionally end in .trn
                if (customPath)
                  setCustomPath(
                    customPath.replace(/\.(bak|trn)$/i, type === 'log' ? '.trn' : '.bak')
                  )
              }}
              columns={3}
              options={[
                { value: 'full', label: 'Full', description: 'The whole database.' },
                {
                  value: 'differential',
                  label: 'Differential',
                  description: 'Changes since the last full backup.'
                },
                {
                  value: 'log',
                  label: 'Transaction log',
                  description: 'Log since the last log backup, for point-in-time restores.',
                  disabled: info?.recoveryModel === 'SIMPLE'
                }
              ]}
            />
            <Toggle
              checked={draft.copyOnly}
              onChange={(copyOnly) => patch({ copyOnly })}
              label="Copy-only"
              description="An out-of-band backup that doesn't affect the sequence of differential and log backups"
            />
          </Section>
        </>
      )}

      {steps.step === 1 && (
        <Section title="Options">
          <Field label="Compression">
            <Segmented
              value={draft.compression}
              onChange={(compression) => patch({ compression })}
              options={[
                { value: 'default' as const, label: 'Server default' },
                { value: 'on' as const, label: 'Compress' },
                { value: 'off' as const, label: 'Don’t compress' }
              ]}
            />
          </Field>
          {express && draft.compression === 'on' && (
            <Callout tone="warning">SQL Server Express can’t compress backups.</Callout>
          )}
          <div className="space-y-3">
            <Toggle
              checked={draft.checksum}
              onChange={(checksum) => patch({ checksum })}
              label="Checksums"
              description="Verifies pages as they're read and stores a checksum to check on restore"
            />
            <Toggle
              checked={draft.verify}
              onChange={(verify) => patch({ verify })}
              label="Verify when finished"
              description="Reads the backup back with RESTORE VERIFYONLY"
            />
          </div>
          <Choice
            value={draft.overwrite ? 'overwrite' : 'append'}
            onChange={(v) => patch({ overwrite: v === 'overwrite' })}
            options={[
              {
                value: 'overwrite',
                label: 'Overwrite the file',
                description: 'Replaces any backups already in it.'
              },
              {
                value: 'append',
                label: 'Append to the file',
                description: 'Adds a backup set after the existing ones.'
              }
            ]}
          />
          <Field label="Backup set name" className="max-w-sm">
            <Input
              value={draft.name}
              placeholder={`${draft.database} ${draft.type} backup`}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
        </Section>
      )}

      {steps.step === 2 && (
        <Section title="Backup file" description={serverHint(connection)}>
          <Input
            mono
            value={path}
            onChange={(e) => setCustomPath(e.target.value)}
            placeholder="/var/opt/mssql/backup/db.bak"
          />
          {server.isPending && <Spinner />}
          {info && !info.backupDir && (
            <p className="text-xs text-muted">
              The server didn’t report a default backup folder; enter a full path.
            </p>
          )}
        </Section>
      )}

      {steps.step === 2 && (
        <Section title="Copy to this computer">
          <Toggle
            checked={download}
            onChange={setDownload}
            label="Download the backup when it finishes"
            description="Reads the file back over this connection and saves it here; the copy on the server stays"
          />
          {download && (
            <>
              <PathField
                mode="save"
                value={localPath}
                onChange={setCustomLocal}
                placeholder="Where to save the backup"
                filters={[
                  {
                    name: 'SQL Server backup',
                    extensions: [draft.type === 'log' ? 'trn' : 'bak']
                  }
                ]}
              />
              <Callout tone="info">
                Copying uses OPENROWSET(BULK …), which needs the ADMINISTER BULK OPERATIONS
                permission, and works for backups up to 2 GB. Compression keeps a backup well under
                that. While it copies, the server holds the whole backup in tempdb, so it needs
                about as much free tempdb space as the backup’s size.
              </Callout>
            </>
          )}
        </Section>
      )}

      {steps.step === 3 && (
        <>
          <Section title="Summary">
            <Summary
              rows={[
                ['Database', draft.database],
                [
                  'Type',
                  `${{ full: 'Full', differential: 'Differential', log: 'Transaction log' }[draft.type]}${draft.copyOnly ? ', copy-only' : ''}`
                ],
                ['File on server', <span className="font-mono text-xs">{path}</span>],
                ...(download
                  ? [
                      ['Copied to', <span className="font-mono text-xs">{localPath}</span>] as [
                        string,
                        React.ReactNode
                      ]
                    ]
                  : []),
                ['Existing backups', draft.overwrite ? 'Overwritten' : 'Kept; this one is appended']
              ]}
            />
          </Section>
          <Section title="Script">
            <Script script={script} />
          </Section>
        </>
      )}
    </WizardLayout>
  )
}

/* ---------- Restore ---------- */

interface UploadState {
  running: boolean
  /** 0–100 once the size is known */
  percent: number | null
  /** The latest line of the upload's log */
  line: string
  error: string | null
}

/** A copy sent to the server that couldn't be deleted. */
interface Leftover {
  path: string
  error: string
}

/**
 * Makes a backup on this computer readable by the server: used in place when
 * the server runs here and sees it, otherwise sent to the server's backup
 * folder. A sent copy is deleted after a restore, when another file or the
 * server side is chosen, or when the tab closes; one that couldn't be deleted
 * stays as `leftover` until a retry works.
 */
function useLocalBackup(
  tabId: string,
  connectionId: string
): {
  state: UploadState | null
  staged: MssqlStagedBackup | null
  leftover: Leftover | null
  /** The staged backup, or null if it failed, was cancelled or was superseded */
  start: (file: string) => Promise<MssqlStagedBackup | null>
  cancel: () => void
  /** Drops the staged backup and any upload still running */
  reset: () => Promise<void>
  retryLeftover: () => Promise<void>
} {
  const [state, setState] = useState<UploadState | null>(null)
  const [staged, setStaged] = useState<MssqlStagedBackup | null>(null)
  const [leftover, setLeftover] = useState<Leftover | null>(null)
  const job = useRef<string | null>(null)
  const sent = useRef<MssqlStagedBackup | null>(null)
  const stranded = useRef<Leftover | null>(null)
  // Bumped by every start and reset; an upload finishing under an older one is stale
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current++
      if (job.current) void api.backupCancel(job.current)
      for (const path of [sent.current?.uploaded && sent.current.path, stranded.current?.path]) {
        if (path) void api.backupMssqlDiscardUpload(connectionId, path).catch(() => undefined)
      }
      setRunning(tabId, false)
    },
    [tabId, connectionId]
  )
  const strand = (next: Leftover | null): void => {
    stranded.current = next
    setLeftover(next)
  }
  /** Deletes `copy` from the server, remembering it if that fails. */
  const remove = async (copy: MssqlStagedBackup | null): Promise<void> => {
    if (!copy?.uploaded) return
    try {
      await api.backupMssqlDiscardUpload(connectionId, copy.path)
    } catch (e) {
      strand({ path: copy.path, error: errorMessage(e) })
    }
  }
  const reset = async (): Promise<void> => {
    generation.current++
    if (job.current) void api.backupCancel(job.current)
    const previous = sent.current
    sent.current = null
    setStaged(null)
    setState((s) => (s?.running ? s : null))
    await remove(previous)
  }
  const start = async (file: string): Promise<MssqlStagedBackup | null> => {
    await reset()
    const mine = generation.current
    const id = crypto.randomUUID()
    job.current = id
    setState({ running: true, percent: null, line: '', error: null })
    setRunning(tabId, true)
    let unlisten: (() => void) | undefined
    try {
      unlisten = await listen<BackupProgress>('backup-progress', (e) => {
        const p = e.payload
        if (p.job !== id) return
        setState(
          (s) =>
            s && {
              ...s,
              line: p.lines.at(-1) ?? s.line,
              percent: p.total ? Math.min(100, (100 * (p.bytes ?? 0)) / p.total) : s.percent
            }
        )
      })
      if (generation.current !== mine) return null
      const result = await api.backupMssqlUpload(connectionId, id, file)
      if (generation.current !== mine) {
        // Another file or the server side was chosen meanwhile
        await remove(result)
        return null
      }
      sent.current = result
      setStaged(result)
      setState(null)
      return result
    } catch (e) {
      if (generation.current === mine) {
        setState({ running: false, percent: null, line: '', error: errorMessage(e) })
      }
      return null
    } finally {
      unlisten?.()
      if (job.current === id) {
        job.current = null
        setRunning(tabId, false)
        setState((s) => (s?.running ? null : s))
      }
    }
  }
  return {
    state,
    staged,
    leftover,
    start,
    cancel: () => {
      if (job.current) void api.backupCancel(job.current)
    },
    reset,
    retryLeftover: async () => {
      const current = stranded.current
      if (!current) return
      strand(null)
      await remove({ path: current.path, uploaded: true })
    }
  }
}

export function MssqlRestoreWizard({ tabId, connection, database }: Props): React.JSX.Element {
  const steps = useSteps()
  const [draft, setDraft] = useState(() => newMssqlRestoreDraft(database))
  const patch = (p: Partial<MssqlRestoreDraft>): void => setDraft((d) => ({ ...d, ...p }))
  const [checked, setChecked] = useState('')
  const [movesEdited, setMovesEdited] = useState(false)
  // Where the backup is: a path on the server, or a file on this computer
  const [source, setSource] = useState<'server' | 'local'>('server')
  const [localFile, setLocalFile] = useState('')
  const local = useLocalBackup(tabId, connection.id)
  const runner = useSqlJob(tabId)
  const dbs = useQuery(queries.databases(connection.id))
  const names = (dbs.data ?? []).map((d) => d.name)
  const server = useServer(connection.id, '')
  const recent = useQuery({
    queryKey: ['conn', connection.id, 'mssqlRecentBackups'],
    queryFn: async () =>
      parseRecentBackups(
        (await meta(connection.id, 'master', MSSQL_RECENT_BACKUPS_SQL))?.rows ?? []
      ),
    staleTime: 0
  })
  const header = useQuery({
    queryKey: ['conn', connection.id, 'mssqlHeader', checked],
    queryFn: async () =>
      parseHeaderOnly(await meta(connection.id, 'master', headerOnlySql(checked))),
    enabled: !!checked,
    staleTime: 0,
    gcTime: 0
  })
  const sets = header.data ?? []
  const chosen = sets.find((s) => s.position === draft.position) ?? null
  const files = useQuery({
    queryKey: ['conn', connection.id, 'mssqlFiles', checked, draft.position],
    queryFn: async () =>
      parseFileList(await meta(connection.id, 'master', fileListSql(checked, draft.position))),
    enabled: !!checked && !!chosen,
    staleTime: 0,
    gcTime: 0
  })

  // A freshly read backup picks its newest set and its database name
  useEffect(() => {
    if (!header.data?.length) return
    const last = header.data[header.data.length - 1]
    setDraft((d) => ({
      ...d,
      position: header.data.some((s) => s.position === d.position) ? d.position : last.position,
      database: d.database || last.database
    }))
  }, [header.data])

  useEffect(() => {
    if (movesEdited || !files.data || !chosen || !server.data) return
    setDraft((d) => ({
      ...d,
      moves: defaultMoves(files.data, chosen.database, d.database.trim(), server.data)
    }))
  }, [files.data, chosen, server.data, draft.database, movesEdited])

  const read = (path: string, position?: number): void => {
    // 0 picks the newest set once the header is read
    setDraft((d) => ({ ...d, path, position: position ?? 0 }))
    setChecked(path.trim())
    setMovesEdited(false)
  }

  const readLocal = async (): Promise<void> => {
    setChecked('')
    // Null too when the source or file changed while it was being sent
    const staged = await local.start(localFile.trim())
    if (staged) read(staged.path)
  }

  // A different file, or the server side, forgets the backup read so far, so
  // the restore never runs a file other than the one shown
  const chooseSource = (next: 'server' | 'local'): void => {
    setSource(next)
    setChecked('')
    void local.reset()
  }
  const chooseLocalFile = (file: string): void => {
    setLocalFile(file)
    setChecked('')
    void local.reset()
  }

  const target = draft.database.trim()
  const exists = names.some((n) => n.toLowerCase() === target.toLowerCase())
  const script = mssqlRestoreScript(draft)
  const azure = server.data?.edition === 5

  const problem = ((): string | null => {
    if (connection.readOnly) return 'This connection is read-only'
    if (azure) return 'Azure SQL Database doesn’t support RESTORE'
    if (steps.step === 0) {
      if (local.state?.running) return 'Sending the backup to the server…'
      if (!checked) return 'Read a backup first'
      if (header.isPending) return 'Reading the backup…'
      if (header.isError) return 'The backup couldn’t be read'
      if (!chosen) return 'Choose a backup set'
      return null
    }
    if (files.isPending) return 'Reading the backup’s files…'
    return validateMssqlRestore(draft, sets)
  })()

  const start = async (): Promise<void> => {
    if (exists) {
      const ok = await confirm({
        title: `Overwrite ${target}?`,
        message: draft.closeConnections
          ? `${target} is replaced by the backup. Everyone connected to it, including tabs here, is disconnected first.`
          : `${target} is replaced by the backup. Data written since the backup is lost.`,
        confirmLabel: 'Restore',
        danger: true
      })
      if (!ok) return
    }
    const ok = await runner.start(connection.id, script)
    if (ok) {
      refreshConnection(connection.id)
      // The copy sent to the server has done its job
      if (local.staged?.uploaded) {
        await local.reset()
        setChecked('')
      }
    }
  }

  const title = target ? `Restore ${target}` : 'Restore a backup'
  const subtitle = `${ENGINES[connection.engine].label} · ${connection.name || connection.host}`
  const leftover = local.leftover && (
    <Callout tone="warning">
      <span className="block">
        A copy sent to the server couldn’t be deleted:{' '}
        <span className="font-mono">{local.leftover.path}</span>
      </span>
      <span className="block whitespace-pre-wrap text-muted">{local.leftover.error}</span>
      <Button size="xs" variant="secondary" onClick={() => void local.retryLeftover()}>
        <RotateCcw className="size-3" /> Try again
      </Button>
    </Callout>
  )
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
        {leftover}
        <JobPanel
          job={runner.job}
          noun="Restore"
          onCancel={runner.cancel}
          actions={
            <>
              {runner.job.status === 'done' && draft.recovery && (
                <Button variant="secondary" onClick={() => newQueryTab(connection.id, target)}>
                  <FilePlus2 className="size-3.5" /> New query in {target}
                </Button>
              )}
              <Button variant="secondary" onClick={runner.clear}>
                <RotateCcw className="size-3.5" /> Back to settings
              </Button>
            </>
          }
        />
      </WizardLayout>
    )
  }

  const STEPS = ['Backup', 'Target', 'Options', 'Review']
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
          danger={exists}
          extra={
            steps.step === STEPS.length - 1 && (
              <Button variant="ghost" onClick={() => newQueryTab(connection.id, 'master', script)}>
                <FilePlus2 className="size-3.5" /> Open in editor
              </Button>
            )
          }
        />
      }
    >
      {leftover}
      {connection.readOnly && (
        <Callout tone="warning">
          This connection is read-only. Turn off “Read-only” in the connection settings to restore.
        </Callout>
      )}
      {azure && (
        <Callout tone="warning">
          Azure SQL Database doesn’t support RESTORE. Use point-in-time restore or import a BACPAC
          in the Azure portal instead.
        </Callout>
      )}

      {steps.step === 0 && (
        <>
          <Segmented
            value={source}
            onChange={chooseSource}
            options={[
              { value: 'server' as const, label: 'On the server' },
              { value: 'local' as const, label: 'On this computer' }
            ]}
          />
          {source === 'local' && (
            <Section
              title="Backup file"
              description="A backup on this computer. A server running here reads it in place; otherwise it's sent to the server's backup folder (up to 2 GB, passing through tempdb) and deleted after the restore."
            >
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <PathField
                    mode="file"
                    value={localFile}
                    onChange={chooseLocalFile}
                    placeholder="Path to the backup"
                    filters={[{ name: 'SQL Server backup', extensions: ['bak', 'trn'] }]}
                  />
                </div>
                <Button
                  variant="secondary"
                  disabled={!localFile.trim() || !!local.state?.running}
                  onClick={() => void readLocal()}
                >
                  <Upload className="size-3.5" /> Read backup
                </Button>
              </div>
              {local.state?.running && (
                <div className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
                  <Spinner />
                  <div className="min-w-0 flex-1 text-xs">
                    <span className="text-bright tabular-nums">
                      {local.state.percent === null
                        ? 'Preparing…'
                        : `${Math.floor(local.state.percent)}%`}
                    </span>
                    <span className="block truncate text-muted" title={local.state.line}>
                      {local.state.line}
                    </span>
                  </div>
                  <Button size="xs" variant="secondary" onClick={local.cancel}>
                    <Square className="size-3" /> Cancel
                  </Button>
                </div>
              )}
              {local.state?.error && <ErrorText error={local.state.error} />}
              {local.staged?.uploaded && (
                <p className="text-xs text-muted">
                  Sent to <span className="font-mono">{local.staged.path}</span> on the server.
                </p>
              )}
              {header.isError && <ErrorText error={header.error} />}
            </Section>
          )}
          {source === 'server' && (
            <Section title="Backup file" description={serverHint(connection)}>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  read(draft.path)
                }}
              >
                <Input
                  mono
                  value={draft.path}
                  placeholder="/var/opt/mssql/backup/db.bak"
                  onChange={(e) => patch({ path: e.target.value })}
                  className="min-w-0 flex-1"
                />
                <Button type="submit" variant="secondary" disabled={!draft.path.trim()}>
                  <Search className="size-3.5" /> Read backup
                </Button>
              </form>
              {header.isError && <ErrorText error={header.error} />}
            </Section>
          )}

          {checked && sets.length > 0 && (
            <Section
              title="Backup set"
              description={sets.length > 1 ? 'This file holds several backups.' : undefined}
            >
              <div className="overflow-hidden rounded-lg border border-line">
                {sets.map((s) => (
                  <button
                    key={s.position}
                    type="button"
                    onClick={() => {
                      patch({ position: s.position })
                      setMovesEdited(false)
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left text-[13px] last:border-b-0',
                      s.position === draft.position ? 'bg-accent/8' : 'hover:bg-hover/60'
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-3.5 shrink-0 items-center justify-center rounded-full ring-1 ring-inset',
                        s.position === draft.position ? 'ring-accent' : 'ring-line-strong'
                      )}
                    >
                      {s.position === draft.position && (
                        <span className="size-1.5 rounded-full bg-accent" />
                      )}
                    </span>
                    <span className="w-6 text-faint tabular-nums">{s.position}</span>
                    <span className="w-24 text-bright">{s.type}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                      {s.database}
                    </span>
                    <span className="text-xs text-muted tabular-nums">{s.finished}</span>
                    <span className="w-20 text-right text-xs text-muted tabular-nums">
                      {formatBytes(s.size)}
                    </span>
                  </button>
                ))}
              </div>
            </Section>
          )}

          {!checked && source === 'server' && (
            <Section title="Recent backups" description="From this server's backup history.">
              {recent.isPending ? (
                <Spinner />
              ) : recent.isError ? (
                <ErrorText error={recent.error} />
              ) : !recent.data.length ? (
                <p className="text-xs text-faint italic">No disk backups recorded</p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-lg border border-line">
                  {recent.data.map((b, i) => (
                    <button
                      key={`${b.path}/${b.position}/${i}`}
                      type="button"
                      onClick={() => read(b.path, b.position)}
                      className="flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left text-[13px] last:border-b-0 hover:bg-hover/60"
                    >
                      <span className="w-32 truncate text-bright">{b.database}</span>
                      <span className="w-20 text-xs text-muted">{b.type}</span>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint"
                        title={b.path}
                      >
                        {b.path}
                      </span>
                      <span className="text-xs text-muted tabular-nums">{b.finished}</span>
                    </button>
                  ))}
                </div>
              )}
            </Section>
          )}
        </>
      )}

      {steps.step === 1 && (
        <>
          <Section
            title="Restore as"
            description="An existing name replaces that database; a new one creates a copy."
          >
            <Input
              mono
              className="max-w-sm"
              list="mssql-restore-databases"
              value={draft.database}
              onChange={(e) => patch({ database: e.target.value })}
            />
            <datalist id="mssql-restore-databases">
              {names.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            {exists && (
              <Callout tone="warning">
                {target} exists and will be replaced. Turn on “Overwrite” in the next step unless
                you’re restoring further backups onto a database left restoring.
              </Callout>
            )}
          </Section>
          <Section
            title="Files"
            description="Where the restored data and log files go on the server."
            aside={
              movesEdited && (
                <Button size="xs" variant="ghost" onClick={() => setMovesEdited(false)}>
                  Reset paths
                </Button>
              )
            }
          >
            {files.isPending ? (
              <Spinner />
            ) : files.isError ? (
              <ErrorText error={files.error} />
            ) : (
              <div className="space-y-2">
                {draft.moves.map((m, i) => (
                  <div key={m.logical} className="flex items-center gap-3">
                    <span
                      className="w-40 shrink-0 truncate font-mono text-xs text-bright"
                      title={m.logical}
                    >
                      {m.logical}
                    </span>
                    <span className="w-10 shrink-0 text-[11px] text-faint">
                      {m.type === 'L' ? 'log' : 'data'}
                    </span>
                    <Input
                      mono
                      value={m.physical}
                      onChange={(e) => {
                        setMovesEdited(true)
                        patch({
                          moves: draft.moves.map((x, j) =>
                            j === i ? { ...x, physical: e.target.value } : x
                          )
                        })
                      }}
                      className="min-w-0 flex-1"
                    />
                  </div>
                ))}
              </div>
            )}
          </Section>
        </>
      )}

      {steps.step === 2 && (
        <Section title="Options">
          <div className="space-y-3">
            <Toggle
              checked={draft.replace}
              onChange={(replace) => patch({ replace })}
              label="Overwrite the existing database"
              description="WITH REPLACE: needed to restore over a database, or over one with a different name's files"
            />
            <Toggle
              checked={draft.closeConnections}
              onChange={(closeConnections) => patch({ closeConnections })}
              label="Close existing connections"
              description="Switches the database to single-user first, rolling back open transactions"
            />
          </div>
          <Choice
            value={draft.recovery ? 'recovery' : 'norecovery'}
            onChange={(v) => patch({ recovery: v === 'recovery' })}
            options={[
              {
                value: 'recovery',
                label: 'Ready to use',
                description:
                  'RECOVERY: rolls back unfinished transactions and brings the database online.'
              },
              {
                value: 'norecovery',
                label: 'Leave restoring',
                description:
                  'NORECOVERY: waits for further differential or log backups to be restored.'
              }
            ]}
          />
        </Section>
      )}

      {steps.step === 3 && (
        <>
          <Section title="Summary">
            <Summary
              rows={[
                [
                  'Backup',
                  <span className="font-mono text-xs">
                    {source === 'local' ? localFile : draft.path}
                  </span>
                ],
                [
                  'Backup set',
                  chosen
                    ? `${chosen.position} · ${chosen.type} of ${chosen.database}, ${chosen.finished}`
                    : ''
                ],
                ['Restore as', `${target}${exists ? ' (replaced)' : ' (new)'}`],
                ['Afterwards', draft.recovery ? 'Online' : 'Restoring, awaiting more backups']
              ]}
            />
          </Section>
          {exists && draft.closeConnections && (
            <Callout tone="danger">
              Everyone connected to {target} is disconnected and their open transactions roll back.
            </Callout>
          )}
          <Section title="Script">
            <Script script={script} />
          </Section>
        </>
      )}
    </WizardLayout>
  )
}
