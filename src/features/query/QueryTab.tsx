import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SQLNamespace } from '@codemirror/lang-sql'
import type { KeyBinding } from '@codemirror/view'
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  Check,
  ChevronDown,
  FileDown,
  FolderOpen,
  Gauge,
  GitCommitHorizontal,
  PanelBottomClose,
  Play,
  PlugZap,
  Sparkles,
  Square,
  TextCursorInput,
  Undo2
} from 'lucide-react'
import { api, type CompletionTable, type StreamFormat } from '@/lib/api'
import { ENGINES, connectionLabel } from '@/lib/engines'
import { EXTENSIONS, pickSavePath } from '@/lib/export'
import { plural } from '@/lib/format'
import { recordHistory } from '@/lib/history'
import { MOD, SHIFT } from '@/lib/keys'
import { connectedInfo, isMariaDb } from '@/lib/mariadb'
import { installedExtensions } from '@/lib/pg-extensions-aware'
import { usePgExtensions } from '@/lib/use-pg-extensions'
import {
  fillParams,
  paramNames,
  sourceOffset,
  type ParamValue,
  type Substitution
} from '@/lib/params'
import { parsePlan, planFormat } from '@/lib/plan'
import { parseMariaDbPlan } from '@/lib/plan-mariadb'
import { confirmProductionWrite, isProduction } from '@/lib/production'
import { queries, queryClient } from '@/lib/queries'
import { isReadOnlyQuery, resolveTable, singleTableSource } from '@/lib/result-source'
import { settingsStore } from '@/lib/settings'
import { dangerousStatements, explainSql, formatSql, statementAt } from '@/lib/sql'
import { createStore } from '@/lib/store'
import { notPickedInDialog } from '@/lib/files'
import { errorMessage, toast, toastError } from '@/lib/toast'
import {
  beginSql,
  commitSql,
  isManualCommit,
  manualCommitStore,
  openTransactionsStore,
  rollbackSql,
  setInTransaction,
  setManualCommit
} from '@/lib/transactions'
import {
  confirm,
  connect,
  connectionsStore,
  cursorStore,
  defaultDatabase,
  lastRunStore,
  runsStore,
  setRunning,
  statusStore,
  updateTab,
  type TabOf
} from '@/lib/workspace'
import { CodeEditor, type CodeEditorHandle } from '@/components/editor/CodeEditor'
import { editorMariaDb } from '@/components/editor/mariadb-completion'
import { editorPostgres } from '@/components/editor/postgres-completion'
import { showMenuAt } from '@/components/ContextMenu'
import { Badge, Button, EmptyState, Toolbar, ToolbarDivider } from '@/components/ui'
import { SavedButton } from '../saved/SavedButton'
import { ParamsDialog } from './ParamsDialog'
import { ResultsPanel, type ResultEditTarget, type RunResult } from './ResultsPanel'
import { ConnectionPicker, DatabasePicker } from './pickers'

export const sqlResultsStore = createStore<Record<string, RunResult>>({})

/** Excel's sheet holds this many rows below the header */
const XLSX_ROWS = 1_048_575

function completionNamespace(tables: CompletionTable[] | undefined): SQLNamespace | undefined {
  if (!tables) return undefined
  const ns: Record<string, Record<string, string[]> | string[]> = {}
  for (const t of tables) {
    if (t.schema) {
      const schema = (ns[t.schema] ??= {}) as Record<string, string[]>
      schema[t.name] = t.columns
    } else {
      ns[t.name] = t.columns
    }
  }
  return ns as SQLNamespace
}

export function QueryTab({ tab }: { tab: TabOf<'query'> }): React.JSX.Element {
  const editor = useRef<CodeEditorHandle>(null)
  const resultsPanel = usePanelRef()
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const settings = settingsStore.use()
  const run = runsStore.use()[tab.id]
  const result = sqlResultsStore.use()[tab.id]
  const connection = connections.find((c) => c.id === tab.connectionId)
  const status = statuses[tab.connectionId]
  const connected = status?.state === 'connected'
  const dialect = (connection && ENGINES[connection.engine].dialect) || 'postgres'
  const babelfish =
    connection?.engine === 'babelfish' ||
    (status?.state === 'connected' && !!status.info.babelfishVersion)
  const mariadb = dialect === 'mysql' && isMariaDb(connectedInfo(status))
  const layout = useDefaultLayout({ id: 'query-split', storage: localStorage })
  const inTransaction = !!openTransactionsStore.use()[tab.id]
  const manualCommit = isManualCommit(tab.id, manualCommitStore.use(), settings.defaultCommitMode)
  const [paramPrompt, setParamPrompt] = useState<{
    names: string[]
    resolve: (values: Record<string, ParamValue> | null) => void
  } | null>(null)
  const askParams = (names: string[]): Promise<Record<string, ParamValue> | null> =>
    new Promise((resolve) => setParamPrompt({ names, resolve }))

  // A closed connection takes its transactions with it
  useEffect(() => {
    if (!connected) setInTransaction(tab.id, false)
  }, [connected, tab.id])

  const completion = useQuery({
    ...queries.completion(tab.connectionId, tab.database),
    enabled: connected && !!tab.database
  })
  const namespace = useMemo(() => completionNamespace(completion.data), [completion.data])
  // pgvector / PostGIS functions complete only where installed
  const pgExtensions = installedExtensions(
    usePgExtensions(tab.connectionId, tab.database, connected && dialect === 'postgres')
  )
  const defaultSchema = dialect === 'postgres' ? 'public' : dialect === 'tsql' ? 'dbo' : undefined

  const execute = useCallback(
    async (
      mode: 'auto' | 'all' | 'statement',
      transform?: (sql: string) => string,
      explain?: boolean
    ) => {
      const ed = editor.current
      if (!ed || !connection) return
      if (runsStore.get()[tab.id]?.running) return
      const text = ed.text()
      const selection = ed.selection()
      let sql: string
      let offset = 0
      if (selection) {
        sql = selection.text
        offset = selection.from
      } else if (mode === 'statement') {
        const statement = statementAt(text, dialect, ed.cursor())
        if (!statement) return
        sql = statement.text
        offset = statement.from
        // Flash the statement that's about to run
        ed.view()?.dispatch({ selection: { anchor: statement.from, head: statement.to } })
      } else {
        sql = text
      }
      if (!sql.trim()) return
      // Production connections confirm every write below instead
      if (settings.confirmDangerous && !transform && !isProduction(connection)) {
        const reasons = dangerousStatements(sql, dialect)
        if (reasons.length) {
          const ok = await confirm({
            title: 'Run this destructive statement?',
            message: (
              <span>
                The script contains <b className="text-bright">{reasons.join(', ')}</b>. You can
                turn this check off in Settings.
              </span>
            ),
            code: sql.length > 2000 ? sql.slice(0, 2000) + '\n…' : sql,
            confirmLabel: 'Run anyway',
            danger: true
          })
          if (!ok) return
        }
      }
      const names = paramNames(sql, dialect)
      let filled = sql
      let spans: Substitution[] | undefined
      if (names.length) {
        const values = await askParams(names)
        if (!values) return
        ;({ sql: filled, spans } = fillParams(sql, dialect, values))
      }
      const toRun = transform ? transform(filled) : filled
      // Asked before a manual-commit BEGIN, so declining leaves no transaction behind
      if (!(await confirmProductionWrite(connection, { sql: toRun }))) return
      if (!(await connect(tab.connectionId))) return
      // Error positions map back onto the editor unless the text was rewritten (Explain)
      const runOffset = transform ? -1 : offset
      ed.clearErrors()
      setRunning(tab.id, true)
      if (resultsPanel.current?.isCollapsed()) resultsPanel.current.expand()
      try {
        // Manual commit: the first run after a COMMIT or ROLLBACK opens a new transaction
        if (isManualCommit(tab.id) && !explain && !openTransactionsStore.get()[tab.id]) {
          const begin = beginSql(dialect)
          const begun = await api.execute(tab.connectionId, tab.id, tab.database, begin)
          if (begun.error) {
            sqlResultsStore.set((r) => ({
              ...r,
              [tab.id]: { output: begun, offset: -1, sql: begin }
            }))
            return
          }
        }
        const output = await api.execute(tab.connectionId, tab.id, tab.database, toRun, {
          maxRows: settings.maxRows,
          timeoutSecs: settings.queryTimeoutSecs,
          confirmed: true
        })
        if (output.inTransaction != null) setInTransaction(tab.id, output.inTransaction)
        const format = planFormat(dialect, babelfish, mariadb)
        const plan =
          explain && !output.error
            ? ((format === 'mariadb-json' ? parseMariaDbPlan(output) : parsePlan(output, format)) ??
              undefined)
            : undefined
        sqlResultsStore.set((r) => ({
          ...r,
          [tab.id]: { output, offset: runOffset, sql: toRun, spans, plan }
        }))
        if (output.database && output.database !== tab.database)
          updateTab(tab.id, { database: output.database })
        const rows = output.results.reduce((n, s) => n + s.rowCount, 0)
        lastRunStore.set((l) => ({
          ...l,
          [tab.id]: { rows, elapsedMs: output.elapsedMs, ok: !output.error }
        }))
        recordHistory({
          connectionId: tab.connectionId,
          connectionName: connection.name || connection.host,
          database: output.database ?? tab.database,
          text: sql,
          elapsedMs: output.elapsedMs,
          ok: !output.error,
          kind: 'sql'
        })
        if (output.error && runOffset >= 0) showError(output.error, runOffset, toRun, spans)
      } catch (e) {
        sqlResultsStore.set((r) => ({
          ...r,
          [tab.id]: { error: errorMessage(e), offset: runOffset, sql: toRun, spans }
        }))
        lastRunStore.set((l) => ({ ...l, [tab.id]: { rows: 0, elapsedMs: 0, ok: false } }))
      } finally {
        setRunning(tab.id, false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      connection,
      tab.id,
      tab.connectionId,
      tab.database,
      dialect,
      babelfish,
      mariadb,
      settings.maxRows,
      settings.queryTimeoutSecs,
      settings.confirmDangerous
    ]
  )

  const showError = (
    error: { message: string; position: number | null; line: number | null },
    offset: number,
    sql: string,
    spans: Substitution[] = []
  ): void => {
    const ed = editor.current
    if (!ed) return
    const firstLine = error.message.split('\n')[0]
    if (error.position != null) {
      // PostgreSQL positions are 1-based character offsets into the submitted text
      const start = Math.max(0, error.position - 1)
      const word = /^\S+/.exec(sql.slice(start))?.[0].length ?? 1
      ed.showError(
        offset + sourceOffset(start, spans),
        offset + sourceOffset(start + word, spans, 'end'),
        firstLine
      )
    } else if (error.line != null) {
      const view = ed.view()
      if (!view) return
      // Values can span lines, so find the line in the submitted text first
      let lineStart = 0
      for (let n = 1; n < error.line; n++) {
        const next = sql.indexOf('\n', lineStart)
        if (next < 0) break
        lineStart = next + 1
      }
      const at = Math.min(view.state.doc.length, offset + sourceOffset(lineStart, spans))
      const line = view.state.doc.lineAt(at)
      ed.showError(line.from, line.to, firstLine)
    }
  }

  const cancel = (): void => void api.cancel(tab.connectionId, tab.id).catch(toastError)

  /** Runs the last result's text again, keeping the open view: more rows, or a refresh after edits. */
  const rerun = async (maxRows: number): Promise<void> => {
    const last = sqlResultsStore.get()[tab.id]
    if (!last || runsStore.get()[tab.id]?.running) return
    if (!(await connect(tab.connectionId))) return
    setRunning(tab.id, true)
    try {
      const output = await api.execute(tab.connectionId, tab.id, tab.database, last.sql, {
        maxRows,
        readOnly: true,
        timeoutSecs: settings.queryTimeoutSecs
      })
      if (output.inTransaction != null) setInTransaction(tab.id, output.inTransaction)
      sqlResultsStore.set((r) => ({ ...r, [tab.id]: { ...last, output, keepView: true } }))
    } catch (e) {
      toastError(e)
    } finally {
      setRunning(tab.id, false)
    }
  }

  const rerunnable = !!result?.output && isReadOnlyQuery(result.sql, dialect)
  const notRerunnable = 'Only for queries that just read: running this text again could change data'

  const loadMore = (set: number): void => {
    const shown = result?.output?.results[set]?.rows.length ?? 0
    void rerun(shown + settings.maxRows)
  }

  const exportFull = async (set: number, format: StreamFormat): Promise<void> => {
    if (!result || runsStore.get()[tab.id]?.running) return
    const path = await pickSavePath(
      `${tab.title.replace(/[\\/:*?"<>|]+/g, '_')}${set ? `-${set + 1}` : ''}`,
      EXTENSIONS[format]
    )
    if (!path || !(await connect(tab.connectionId))) return
    setRunning(tab.id, true)
    try {
      const output = await api.exportQuery(
        tab.connectionId,
        tab.id,
        tab.database,
        result.sql,
        format,
        path,
        set
      )
      if (output.inTransaction != null) setInTransaction(tab.id, output.inTransaction)
      const rows = output.results[set]?.rowCount ?? 0
      const file = path.split(/[\\/]/).pop()
      if (output.error) toast(`Export stopped: ${output.error.message}`, 'error')
      else if (output.cancelled) toast(`Export cancelled after ${plural(rows, 'row')}`, 'error')
      else if (!output.results[set]) toast('The query returned no result set to export', 'error')
      else if (format === 'xlsx' && rows > XLSX_ROWS)
        toast(
          `Saved ${XLSX_ROWS.toLocaleString()} of ${rows.toLocaleString()} rows to ${file}: that's all an Excel sheet holds`,
          'error'
        )
      else toast(`Exported ${plural(rows, 'row')} to ${file}`)
    } catch (e) {
      toastError(e)
    } finally {
      setRunning(tab.id, false)
    }
  }

  // Results read straight from one table with a primary key can be edited in place
  // Edits commit to the connection and database the rows were read from, whatever the
  // tab's picker says by then
  const [editSource, setEditSource] = useState<
    | (Omit<ResultEditTarget, 'execute' | 'confirmDangerous' | 'blocked' | 'onCommitted'> & {
        connectionId: string
        database: string
      })
    | null
  >(null)
  useEffect(() => {
    const output = result?.output
    const set = output?.results[0]
    const source = result && singleTableSource(result.sql, dialect)
    const connectionId = tab.connectionId
    const database = output?.database ?? tab.database
    // The session's search_path isn't known, so a name found in several schemas isn't guessed
    const table = source && resolveTable(source.parts, completion.data ?? [], undefined, dialect)
    if (!set || output.error || output.results.length !== 1 || connection?.readOnly || !table) {
      setEditSource(null)
      return
    }
    let stale = false
    queryClient
      .fetchQuery(queries.table(connectionId, database, table.schema, table.name))
      .then((info) => {
        if (stale) return
        const names = set.columns.map((c) => c.name)
        const unique = (name: string): boolean => names.indexOf(name) === names.lastIndexOf(name)
        const passedThrough = (name: string): boolean => source.star || source.columns.has(name)
        // A key computed under the column's name (id + 1 AS id) would locate the wrong row
        const keyed =
          info.primaryKey.length > 0 &&
          info.primaryKey.every((k) => names.includes(k) && unique(k) && passedThrough(k))
        if (!keyed) return setEditSource(null)
        const readOnly = new Set<number>()
        set.columns.forEach((c, i) => {
          const column = info.columns.find((col) => col.name === c.name)
          if (!column || column.isGenerated || !passedThrough(c.name) || !unique(c.name))
            readOnly.add(i)
        })
        setEditSource({
          tableRef: { schema: table.schema, name: table.name },
          info,
          readOnly,
          scope: `${connectionId}/${database}`,
          connectionId,
          database
        })
      })
      .catch(() => !stale && setEditSource(null))
    return () => {
      stale = true
    }
    // Recomputed per run; completions arriving later only matter for the next run
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])
  // Switching the tab's connection or database leaves the rows shown read-only
  const editHere =
    editSource?.connectionId === tab.connectionId && editSource.database === tab.database
  const edit = useMemo<ResultEditTarget | undefined>(
    () =>
      editSource && editHere
        ? {
            ...editSource,
            execute: (sql, options) =>
              api.execute(editSource.connectionId, tab.id, editSource.database, sql, options),
            confirmDangerous: settings.confirmDangerous,
            connection,
            blocked: inTransaction
              ? "This tab's transaction is open. Commit or roll back before committing edits, which run in their own transaction."
              : undefined,
            onCommitted: () =>
              void rerun(
                Math.max(
                  settings.maxRows,
                  sqlResultsStore.get()[tab.id]?.output?.results[0]?.rows.length ?? 0
                )
              )
          }
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      editSource,
      editHere,
      tab.id,
      settings.confirmDangerous,
      settings.maxRows,
      inTransaction,
      connection
    ]
  )

  const endTransaction = async (commit: boolean): Promise<void> => {
    const sql = commit ? commitSql(dialect) : rollbackSql(dialect)
    if (
      commit &&
      connection &&
      isProduction(connection) &&
      !(await confirm({
        title: `Commit to production database ${connectionLabel(connection)}?`,
        message: "The transaction's changes become permanent.",
        confirmLabel: 'Commit',
        danger: true
      }))
    )
      return
    setRunning(tab.id, true)
    try {
      const output = await api.execute(tab.connectionId, tab.id, tab.database, sql)
      if (output.error) {
        sqlResultsStore.set((r) => ({ ...r, [tab.id]: { output, offset: -1, sql } }))
      } else {
        toast(commit ? 'Transaction committed' : 'Transaction rolled back')
      }
      // Nested T-SQL transactions stay open after one COMMIT
      setInTransaction(tab.id, output.inTransaction ?? (!!output.error && inTransaction))
    } catch (e) {
      toastError(e)
    } finally {
      setRunning(tab.id, false)
    }
  }

  const format = async (): Promise<void> => {
    const ed = editor.current
    if (!ed) return
    try {
      const selection = ed.selection()
      if (selection)
        ed.replaceRange(selection.from, selection.to, await formatSql(selection.text, dialect))
      else ed.setText(await formatSql(ed.text(), dialect))
    } catch (e) {
      toast(`Couldn't format: ${errorMessage(e)}`, 'error')
    }
  }

  const saveFile = async (saveAs = false): Promise<void> => {
    const text = editor.current?.text() ?? tab.text
    let path = saveAs ? undefined : tab.filePath
    if (!path) {
      path =
        (await saveDialog({
          defaultPath: `${tab.title}.sql`,
          filters: [{ name: 'SQL', extensions: ['sql'] }]
        })) ?? undefined
      if (!path) return
    }
    try {
      await api.writeText(path, text)
      updateTab(tab.id, { filePath: path, savedText: text, text })
      toast(`Saved ${path.split(/[\\/]/).pop()}`)
    } catch (e) {
      // A file remembered from before saves were limited to picked files
      if (!saveAs && notPickedInDialog(e)) return saveFile(true)
      toastError(e)
    }
  }

  const openFile = async (): Promise<void> => {
    const path = await openDialog({
      filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }],
      multiple: false
    })
    if (typeof path !== 'string') return
    try {
      const text = await api.readText(path)
      updateTab(tab.id, { text, filePath: path, savedText: text })
    } catch (e) {
      toastError(e)
    }
  }

  const keys = useMemo<KeyBinding[]>(
    () => [
      { key: 'F5', run: () => (void execute('auto'), true) },
      { key: 'Mod-e', run: () => (void execute('auto'), true) },
      { key: 'Mod-Enter', run: () => (void execute('statement'), true) },
      { key: 'Shift-Mod-Enter', run: () => (void execute('all'), true) },
      {
        key: 'Mod-l',
        run: () => (
          void execute('statement', (s) => explainSql(s, dialect, false, babelfish, mariadb), true),
          true
        )
      },
      { key: 'Shift-Alt-f', run: () => (void format(), true) },
      { key: 'Shift-Mod-f', run: () => (void format(), true) },
      { key: 'Mod-s', run: () => (void saveFile(), true) },
      { key: 'Shift-Mod-s', run: () => (void saveFile(true), true) },
      { key: 'Mod-o', run: () => (void openFile(), true) },
      {
        key: 'Mod-r',
        run: () => {
          const p = resultsPanel.current
          if (p?.isCollapsed()) p.expand()
          else p?.collapse()
          return true
        }
      },
      { key: 'Alt-Pause', run: () => (cancel(), true) },
      { key: 'Mod-Pause', run: () => (cancel(), true) }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [execute, dialect, babelfish, mariadb, tab.filePath]
  )

  // Tabs opened by "Execute…" or a saved query run once, after the editor has the text
  const executeRef = useRef(execute)
  executeRef.current = execute
  // Tabs opened by "Explain" (the slow query log) explain the text instead, like Mod-L
  const explainRef = useRef((s: string) => s)
  explainRef.current = (s) => explainSql(s, dialect, false, babelfish, mariadb)
  useEffect(() => {
    if (!tab.autorun) return
    const explain = tab.autorun === 'explain'
    const timer = setTimeout(() => {
      updateTab(tab.id, { autorun: false })
      void executeRef.current('all', explain ? explainRef.current : undefined, explain)
    }, 50)
    return () => clearTimeout(timer)
  }, [tab.autorun, tab.id])

  const running = !!run?.running

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        {running ? (
          <Button size="sm" variant="danger" onClick={cancel} title="Cancel (Alt+Break)">
            <Square className="size-3 fill-current" /> Cancel
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void execute('auto')}
            title={`Run selection or script (F5, ${MOD}E)`}
          >
            <Play className="size-3.5 fill-current" /> Run
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={running}
          onClick={() => void execute('statement')}
          title={`Run the statement at the cursor (${MOD}Enter)`}
        >
          <TextCursorInput className="size-3.5" /> Statement
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={running}
          onClick={(e) =>
            showMenuAt(e.currentTarget, [
              {
                label: 'Explain',
                shortcut: `${MOD}L`,
                onSelect: () =>
                  void execute(
                    'statement',
                    (s) => explainSql(s, dialect, false, babelfish, mariadb),
                    true
                  )
              },
              {
                label:
                  dialect === 'tsql'
                    ? 'Actual execution plan (runs the query)'
                    : 'Explain analyze (runs the query)',
                onSelect: () =>
                  void execute(
                    'statement',
                    (s) => explainSql(s, dialect, true, babelfish, mariadb),
                    true
                  )
              }
            ])
          }
        >
          <Gauge className="size-3.5" /> Explain <ChevronDown className="size-3" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setManualCommit(tab.id, !manualCommit)}
          title={
            manualCommit
              ? 'Manual commit: running opens a transaction that stays open until you commit or roll back. Click for auto-commit.'
              : 'Auto-commit: each statement is committed as it runs. Click for manual commit.'
          }
        >
          <GitCommitHorizontal className="size-3.5" />
          {manualCommit ? 'Manual commit' : 'Auto-commit'}
        </Button>
        {inTransaction && (
          <>
            <Badge tone="warning" title="This tab's session holds a transaction open">
              Transaction open
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              disabled={running}
              onClick={() => void endTransaction(true)}
              title={commitSql(dialect)}
            >
              <Check className="size-3.5" /> Commit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={running}
              onClick={() => void endTransaction(false)}
              title={rollbackSql(dialect)}
            >
              <Undo2 className="size-3.5" /> Rollback
            </Button>
          </>
        )}
        <ToolbarDivider />
        <ConnectionPicker
          value={tab.connectionId}
          sql
          onChange={async (id) => {
            if (
              openTransactionsStore.get()[tab.id] &&
              !(await confirm({
                title: 'Switch connection with an open transaction?',
                message:
                  "Switching ends this tab's session, which rolls back the uncommitted changes.",
                confirmLabel: 'Roll back and switch',
                danger: true
              }))
            )
              return
            setInTransaction(tab.id, false)
            void api.closeSession(tab.connectionId, tab.id).catch(() => {})
            updateTab(tab.id, { connectionId: id, database: defaultDatabase(id) })
          }}
        />
        <DatabasePicker
          connectionId={tab.connectionId}
          value={tab.database}
          onChange={(database) => updateTab(tab.id, { database })}
        />
        <div className="flex-1" />
        <SavedButton tab={tab} text={() => editor.current?.text() ?? tab.text} />
        <Button
          size="icon"
          variant="ghost"
          title={`Format SQL (${SHIFT}Alt+F)`}
          onClick={() => void format()}
        >
          <Sparkles className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title={`Open file (${MOD}O)`}
          onClick={() => void openFile()}
        >
          <FolderOpen className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title={`Save (${MOD}S)`}
          onClick={() => void saveFile()}
        >
          <FileDown className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title={`Toggle results (${MOD}R)`}
          onClick={() => {
            const p = resultsPanel.current
            if (p?.isCollapsed()) p.expand()
            else p?.collapse()
          }}
        >
          <PanelBottomClose className="size-3.5" />
        </Button>
      </Toolbar>
      <Group
        orientation="vertical"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <Panel id="editor" minSize={80} defaultSize="55%">
          <CodeEditor
            ref={editor}
            value={tab.text}
            onChange={(text) => updateTab(tab.id, { text })}
            language={{
              kind: 'sql',
              dialect,
              mariaDb: editorMariaDb(connectedInfo(status)),
              postgres: editorPostgres(connectedInfo(status)),
              pgExtensions
            }}
            completion={namespace}
            defaultSchema={defaultSchema}
            sqlTables={completion.data}
            keys={keys}
            fontSize={settings.editorFontSize}
            wordWrap={settings.wordWrap}
            onCursor={cursorStore.set}
            placeholder={`Write ${ENGINES[connection?.engine ?? 'postgres'].label} SQL…   ${MOD}Enter runs the statement at the cursor, F5 runs everything`}
            className="h-full bg-canvas"
            autoFocus
          />
        </Panel>
        <Separator />
        <Panel
          id="results"
          panelRef={resultsPanel}
          minSize={60}
          defaultSize="45%"
          collapsible
          collapsedSize={0}
        >
          <ResultsPanel
            result={result}
            running={running}
            startedAt={run?.startedAt}
            dialect={dialect}
            tabId={tab.id}
            loadMore={{ run: loadMore, disabled: rerunnable ? undefined : notRerunnable }}
            exportFull={{
              run: (set, format) => void exportFull(set, format),
              disabled: rerunnable ? undefined : notRerunnable
            }}
            edit={edit}
            onJumpToError={() => {
              if (result?.output?.error && result.offset >= 0)
                showError(result.output.error, result.offset, result.sql, result.spans)
            }}
            emptyHint={
              !connected ? (
                <EmptyState
                  icon={<PlugZap className="size-6" />}
                  title={
                    connection
                      ? `Not connected to ${connection.name || connection.host}`
                      : 'Pick a connection'
                  }
                  actions={
                    connection && (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => void connect(connection.id)}
                        disabled={status?.state === 'connecting'}
                      >
                        Connect
                      </Button>
                    )
                  }
                >
                  Running a query connects automatically.
                </EmptyState>
              ) : undefined
            }
          />
        </Panel>
      </Group>
      {paramPrompt && (
        <ParamsDialog
          names={paramPrompt.names}
          dialect={dialect}
          onDone={(values) => {
            paramPrompt.resolve(values)
            setParamPrompt(null)
          }}
        />
      )}
    </div>
  )
}
