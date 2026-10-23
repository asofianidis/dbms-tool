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
import { api, type CompletionTable } from '@/lib/api'
import { ENGINES } from '@/lib/engines'
import { recordHistory } from '@/lib/history'
import { MOD, SHIFT } from '@/lib/keys'
import { paramNames, substituteParams, type ParamValue } from '@/lib/params'
import { parsePlan, planFormat } from '@/lib/plan'
import { queries } from '@/lib/queries'
import { settingsStore } from '@/lib/settings'
import { dangerousStatements, explainSql, formatSql, statementAt } from '@/lib/sql'
import { createStore } from '@/lib/store'
import { notPickedInDialog } from '@/lib/files'
import { errorMessage, toast, toastError } from '@/lib/toast'
import {
  beginSql,
  commitSql,
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
import { showMenuAt } from '@/components/ContextMenu'
import { Badge, Button, EmptyState, Toolbar, ToolbarDivider } from '@/components/ui'
import { SavedButton } from '../saved/SavedButton'
import { ParamsDialog } from './ParamsDialog'
import { ResultsPanel, type RunResult } from './ResultsPanel'
import { ConnectionPicker, DatabasePicker } from './pickers'

export const sqlResultsStore = createStore<Record<string, RunResult>>({})

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
  const layout = useDefaultLayout({ id: 'query-split', storage: localStorage })
  const inTransaction = !!openTransactionsStore.use()[tab.id]
  const manualCommit = !!manualCommitStore.use()[tab.id]
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
      if (settings.confirmDangerous && !transform) {
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
      if (names.length) {
        const values = await askParams(names)
        if (!values) return
        filled = substituteParams(sql, dialect, values)
      }
      if (!(await connect(tab.connectionId))) return
      const toRun = transform ? transform(filled) : filled
      // Error positions only map back onto the editor when the text ran unchanged
      const runOffset = transform || names.length ? -1 : offset
      ed.clearErrors()
      setRunning(tab.id, true)
      if (resultsPanel.current?.isCollapsed()) resultsPanel.current.expand()
      try {
        // Manual commit: the first run after a COMMIT or ROLLBACK opens a new transaction
        if (manualCommitStore.get()[tab.id] && !explain && !openTransactionsStore.get()[tab.id]) {
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
          maxRows: settings.maxRows
        })
        if (output.inTransaction != null) setInTransaction(tab.id, output.inTransaction)
        const plan =
          explain && !output.error
            ? (parsePlan(output, planFormat(dialect, babelfish)) ?? undefined)
            : undefined
        sqlResultsStore.set((r) => ({
          ...r,
          [tab.id]: { output, offset: runOffset, sql: toRun, plan }
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
        if (output.error && runOffset >= 0) showError(output.error, runOffset, toRun)
      } catch (e) {
        sqlResultsStore.set((r) => ({
          ...r,
          [tab.id]: { error: errorMessage(e), offset: runOffset, sql: toRun }
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
      settings.maxRows,
      settings.confirmDangerous
    ]
  )

  const showError = (
    error: { message: string; position: number | null; line: number | null },
    offset: number,
    sql: string
  ): void => {
    const ed = editor.current
    if (!ed) return
    const firstLine = error.message.split('\n')[0]
    if (error.position != null) {
      // PostgreSQL positions are 1-based character offsets into the submitted text
      const at = offset + Math.max(0, error.position - 1)
      const rest = sql.slice(error.position - 1)
      const word = /^\S+/.exec(rest)?.[0].length ?? 1
      ed.showError(at, at + word, firstLine)
    } else if (error.line != null) {
      const view = ed.view()
      if (!view) return
      const base = view.state.doc.lineAt(offset).number
      const lineNo = Math.min(view.state.doc.lines, base + error.line - 1)
      const line = view.state.doc.line(lineNo)
      ed.showError(line.from, line.to, firstLine)
    }
  }

  const cancel = (): void => void api.cancel(tab.connectionId, tab.id).catch(toastError)

  const endTransaction = async (commit: boolean): Promise<void> => {
    const sql = commit ? commitSql(dialect) : rollbackSql(dialect)
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
          void execute('statement', (s) => explainSql(s, dialect, false, babelfish), true),
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
    [execute, dialect, babelfish, tab.filePath]
  )

  // Tabs opened by "Execute…" or a saved query run once, after the editor has the text
  const executeRef = useRef(execute)
  executeRef.current = execute
  useEffect(() => {
    if (!tab.autorun) return
    const timer = setTimeout(() => {
      updateTab(tab.id, { autorun: false })
      void executeRef.current('all')
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
                  void execute('statement', (s) => explainSql(s, dialect, false, babelfish), true)
              },
              {
                label:
                  dialect === 'tsql'
                    ? 'Actual execution plan (runs the query)'
                    : 'Explain analyze (runs the query)',
                onSelect: () =>
                  void execute('statement', (s) => explainSql(s, dialect, true, babelfish), true)
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
            language={{ kind: 'sql', dialect }}
            completion={namespace}
            defaultSchema={defaultSchema}
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
            onJumpToError={() => {
              if (result?.output?.error && result.offset >= 0)
                showError(result.output.error, result.offset, result.sql)
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
