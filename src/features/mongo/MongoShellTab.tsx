import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { KeyBinding } from '@codemirror/view'
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  AlertTriangle,
  FileDown,
  FolderOpen,
  Leaf,
  MessageSquareText,
  Play,
  PlugZap,
  Square,
  TextCursorInput
} from 'lucide-react'
import { api, type MongoOutput, type MongoRequest } from '@/lib/api'
import { cn } from '@/lib/cn'
import { recordHistory } from '@/lib/history'
import { MOD } from '@/lib/keys'
import { parseShell, type ShellOp } from '@/lib/mongo-shell'
import { formatDuration } from '@/lib/format'
import { queries } from '@/lib/queries'
import { settingsStore } from '@/lib/settings'
import { createStore } from '@/lib/store'
import { notPickedInDialog } from '@/lib/files'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { toShell } from '@/lib/ejson'
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
import { Button, EmptyState, ProgressBar, Toolbar, ToolbarDivider } from '@/components/ui'
import { ConnectionPicker, DatabasePicker } from '../query/pickers'
import { SavedButton } from '../saved/SavedButton'
import { mongoCompletion } from './completion'
import { DocumentsView, type DocumentsMode } from './DocumentsView'

interface ShellResult {
  label: string
  output?: MongoOutput
  /** For `show dbs` and similar, rendered as documents */
  documents?: Record<string, unknown>[]
  single?: boolean
}

interface ShellRun {
  results: ShellResult[]
  messages: { level: 'info' | 'error' | 'warning'; text: string }[]
  elapsedMs: number
}

export const shellResultsStore = createStore<Record<string, ShellRun>>({})

function describeDanger(op: MongoRequest): string | null {
  const empty = (f: unknown): boolean =>
    !f || (typeof f === 'object' && Object.keys(f as object).length === 0)
  switch (op.op) {
    case 'deleteMany':
      return empty(op.filter) ? `deleteMany({}) on ${op.collection} deletes every document` : null
    case 'updateMany':
      return empty(op.filter) ? `updateMany({}) on ${op.collection} updates every document` : null
    case 'dropCollection':
      return `drop() removes the ${op.collection} collection`
    case 'dropDatabase':
      return `dropDatabase() removes ${op.database}`
    default:
      return null
  }
}

/** The statement block (blank-line separated) around the cursor. */
function blockAt(text: string, pos: number): { from: number; to: number; text: string } {
  const before = text.lastIndexOf('\n\n', pos - 1)
  const after = text.indexOf('\n\n', pos)
  const from = before < 0 ? 0 : before + 2
  const to = after < 0 ? text.length : after
  return { from, to, text: text.slice(from, to) }
}

export function MongoShellTab({ tab }: { tab: TabOf<'mongo'> }): React.JSX.Element {
  const editor = useRef<CodeEditorHandle>(null)
  const resultsPanel = usePanelRef()
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const settings = settingsStore.use()
  const run = runsStore.use()[tab.id]
  const result = shellResultsStore.use()[tab.id]
  const connection = connections.find((c) => c.id === tab.connectionId)
  const status = statuses[tab.connectionId]
  const connected = status?.state === 'connected'
  const layout = useDefaultLayout({ id: 'mongo-split', storage: localStorage })
  const [active, setActive] = useState<number | 'messages'>(0)
  const [mode, setMode] = useState<DocumentsMode>('list')

  const collections = useQuery({
    ...queries.objects(tab.connectionId, tab.database, null),
    enabled: connected && !!tab.database
  })
  const completion = useMemo(
    () => mongoCompletion((collections.data ?? []).map((c) => c.name)),
    [collections.data]
  )

  const execute = async (mode: 'auto' | 'block'): Promise<void> => {
    const ed = editor.current
    if (!ed || !connection || runsStore.get()[tab.id]?.running) return
    const selection = ed.selection()
    const script = selection
      ? selection.text
      : mode === 'block'
        ? blockAt(ed.text(), ed.cursor()).text
        : ed.text()
    if (!script.trim()) return
    let ops: ShellOp[]
    try {
      ops = parseShell(script, tab.database || 'test')
    } catch (e) {
      shellResultsStore.set((r) => ({
        ...r,
        [tab.id]: {
          results: [],
          messages: [{ level: 'error', text: errorMessage(e) }],
          elapsedMs: 0
        }
      }))
      setActive('messages')
      return
    }
    if (!ops.length) return
    if (settings.confirmDangerous) {
      const reasons = ops
        .flatMap((op) => (op.kind === 'request' ? [describeDanger(op.request)] : []))
        .filter(Boolean)
      if (reasons.length) {
        const ok = await confirm({
          title: 'Run this destructive command?',
          message: (
            <ul className="list-disc pl-4">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ),
          confirmLabel: 'Run anyway',
          danger: true
        })
        if (!ok) return
      }
    }
    if (!(await connect(tab.connectionId))) return
    setRunning(tab.id, true)
    if (resultsPanel.current?.isCollapsed()) resultsPanel.current.expand()
    const started = Date.now()
    const out: ShellRun = { results: [], messages: [], elapsedMs: 0 }
    let database = tab.database
    let ok = true
    try {
      for (const op of ops) {
        if (op.kind === 'use') {
          database = op.database
          out.messages.push({ level: 'info', text: `switched to db ${database}` })
        } else if (op.kind === 'print') {
          out.messages.push({ level: 'info', text: op.text })
        } else if (op.kind === 'show') {
          if (op.what === 'dbs') {
            const dbs = await api.databases(tab.connectionId)
            out.results.push({
              label: 'show dbs',
              documents: dbs.map((d) => ({
                name: d.name,
                sizeOnDisk: d.sizeBytes,
                system: d.isSystem
              }))
            })
          } else {
            const list = await api.objects(tab.connectionId, op.database)
            out.results.push({
              label: 'show collections',
              documents: list.map((c) => ({
                name: c.name,
                type: c.kind,
                ...(c.detail ? { viewOn: c.detail } : {})
              }))
            })
          }
        } else {
          const output = await api.mongo(tab.connectionId, tab.id, op.request, {
            maxRows: settings.maxRows
          })
          out.results.push({ label: op.label, output, single: op.single })
          const count =
            output.kind === 'documents'
              ? `${output.documents.length} document${output.documents.length === 1 ? '' : 's'}${output.truncated ? ' (truncated)' : ''}`
              : 'ok'
          out.messages.push({
            level: 'info',
            text: `${op.label} → ${count} · ${formatDuration(output.elapsedMs)}`
          })
          if (output.cancelled) {
            out.messages.push({ level: 'warning', text: 'Cancelled' })
            break
          }
        }
      }
    } catch (e) {
      ok = false
      out.messages.push({ level: 'error', text: errorMessage(e) })
    } finally {
      out.elapsedMs = Date.now() - started
      setRunning(tab.id, false)
    }
    if (database !== tab.database) updateTab(tab.id, { database })
    shellResultsStore.set((r) => ({ ...r, [tab.id]: out }))
    setActive(out.results.length && ok ? out.results.length - 1 : 'messages')
    const docs = out.results.reduce(
      (n, r) => n + (r.output?.documents.length ?? r.documents?.length ?? 0),
      0
    )
    lastRunStore.set((l) => ({ ...l, [tab.id]: { rows: docs, elapsedMs: out.elapsedMs, ok } }))
    recordHistory({
      connectionId: tab.connectionId,
      connectionName: connection.name || connection.host || 'MongoDB',
      database,
      text: script,
      elapsedMs: out.elapsedMs,
      ok,
      kind: 'mongo'
    })
  }

  const cancel = (): void => void api.cancel(tab.connectionId, tab.id).catch(toastError)

  const saveFile = async (saveAs = false): Promise<void> => {
    const text = editor.current?.text() ?? tab.text
    let path = saveAs ? undefined : tab.filePath
    if (!path) {
      path =
        (await saveDialog({
          defaultPath: `${tab.title}.js`,
          filters: [{ name: 'Mongo shell script', extensions: ['js', 'mongodb'] }]
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
      filters: [{ name: 'Mongo shell script', extensions: ['js', 'mongodb', 'txt'] }],
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
      { key: 'Mod-Enter', run: () => (void execute('block'), true) },
      { key: 'Mod-s', run: () => (void saveFile(), true) },
      { key: 'Mod-o', run: () => (void openFile(), true) },
      { key: 'Alt-Pause', run: () => (cancel(), true) }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      tab.connectionId,
      tab.database,
      tab.filePath,
      connection,
      settings.maxRows,
      settings.confirmDangerous
    ]
  )

  // Tabs opened from a saved query run once, after the editor has the text
  const executeRef = useRef(execute)
  executeRef.current = execute
  useEffect(() => {
    if (!tab.autorun) return
    const timer = setTimeout(() => {
      updateTab(tab.id, { autorun: false })
      void executeRef.current('auto')
    }, 50)
    return () => clearTimeout(timer)
  }, [tab.autorun, tab.id])

  const running = !!run?.running
  const current = typeof active === 'number' ? result?.results[active] : undefined
  const errors = result?.messages.filter((m) => m.level === 'error').length ?? 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        {running ? (
          <Button size="sm" variant="danger" onClick={cancel}>
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
          onClick={() => void execute('block')}
          title={`Run the block at the cursor (${MOD}Enter)`}
        >
          <TextCursorInput className="size-3.5" /> Block
        </Button>
        <ToolbarDivider />
        <ConnectionPicker
          value={tab.connectionId}
          mongo
          onChange={(id) => updateTab(tab.id, { connectionId: id, database: defaultDatabase(id) })}
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
      </Toolbar>
      <Group
        orientation="vertical"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
      >
        <Panel id="editor" minSize={80} defaultSize="45%">
          <CodeEditor
            ref={editor}
            value={tab.text}
            onChange={(text) => updateTab(tab.id, { text })}
            language={{ kind: 'mongo' }}
            extraCompletion={completion}
            keys={keys}
            fontSize={settings.editorFontSize}
            wordWrap={settings.wordWrap}
            onCursor={cursorStore.set}
            placeholder={`db.collection.find({ field: 'value' }).sort({ _id: -1 }).limit(20)   ·   ${MOD}Enter runs the block at the cursor`}
            className="h-full bg-canvas"
            autoFocus
          />
        </Panel>
        <Separator />
        <Panel
          id="results"
          panelRef={resultsPanel}
          minSize={60}
          defaultSize="55%"
          collapsible
          collapsedSize={0}
        >
          <div className="flex h-full min-h-0 flex-col bg-canvas">
            <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-panel">
              <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [&::-webkit-scrollbar]:h-0">
                {result?.results.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setActive(i)}
                    className={cn(
                      'relative flex shrink-0 items-center gap-1.5 px-3 font-mono text-[11.5px]',
                      active === i ? 'text-bright' : 'text-muted hover:text-fg'
                    )}
                  >
                    {active === i && (
                      <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />
                    )}
                    <Leaf className="size-3.5 text-mongo" />
                    {r.label}
                    {(r.output?.kind === 'documents' || r.documents) && (
                      <span className="font-sans text-faint tabular-nums">
                        {(r.output?.documents.length ?? r.documents?.length ?? 0).toLocaleString()}
                      </span>
                    )}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setActive('messages')}
                  className={cn(
                    'relative flex shrink-0 items-center gap-1.5 px-3 text-[12px]',
                    active === 'messages' ? 'text-bright' : 'text-muted hover:text-fg',
                    errors > 0 && 'text-danger'
                  )}
                >
                  {active === 'messages' && (
                    <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />
                  )}
                  {errors ? (
                    <AlertTriangle className="size-3.5" />
                  ) : (
                    <MessageSquareText className="size-3.5" />
                  )}
                  Messages
                </button>
              </div>
              {result && (
                <span className="flex items-center px-3 text-[11px] text-muted tabular-nums">
                  {formatDuration(result.elapsedMs)}
                </span>
              )}
            </div>
            <ProgressBar active={running} />
            <div className="min-h-0 flex-1">
              {!result ? (
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
                        >
                          Connect
                        </Button>
                      )
                    }
                  >
                    Running a script connects automatically.
                  </EmptyState>
                ) : (
                  <EmptyState title="Run a command to see results">
                    <span className="font-mono">show collections</span>,{' '}
                    <span className="font-mono">
                      db.users.find({'{'} age: {'{'} $gt: 30 {'}'} {'}'})
                    </span>
                    , <span className="font-mono">db.orders.aggregate([…])</span>
                  </EmptyState>
                )
              ) : active === 'messages' || !current ? (
                <div className="h-full overflow-auto p-3 font-mono text-[12px] leading-relaxed select-text">
                  {result.messages.map((m, i) => (
                    <p
                      key={i}
                      className={cn(
                        'border-b border-line/50 py-1 whitespace-pre-wrap',
                        m.level === 'error' && 'text-danger',
                        m.level === 'warning' && 'text-warn'
                      )}
                    >
                      {m.text}
                    </p>
                  ))}
                  {!result.messages.length && <p className="text-faint">No messages</p>}
                </div>
              ) : current.output?.kind === 'value' ? (
                <ValueView value={current.output.value} />
              ) : (
                <DocumentsView
                  documents={
                    (current.output?.documents ?? current.documents ?? []) as Record<
                      string,
                      unknown
                    >[]
                  }
                  mode={mode}
                  onModeChange={setMode}
                  toolbarExtra={
                    current.output?.truncated && (
                      <span className="flex items-center gap-1 text-[11px] text-warn">
                        <AlertTriangle className="size-3" /> Limited to{' '}
                        {settings.maxRows.toLocaleString()} documents; add .limit() or raise the
                        limit in Settings
                      </span>
                    )
                  }
                />
              )}
            </div>
          </div>
        </Panel>
      </Group>
    </div>
  )
}

function ValueView({ value }: { value: unknown }): React.JSX.Element {
  const text = useMemo(() => toShell(value), [value])
  return (
    <CodeEditor
      value={text}
      language={{ kind: 'mongo' }}
      readOnly
      className="h-full bg-canvas"
      fontSize={12.5}
    />
  )
}
