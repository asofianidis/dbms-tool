import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FilePlus2, Play } from 'lucide-react'
import type { DbObject } from '@/lib/api'
import { ENGINES, type Dialect } from '@/lib/engines'
import { queries } from '@/lib/queries'
import { callScript, isInput, isOutput, type ArgMode, type RoutineArg } from '@/lib/routines'
import { createStore } from '@/lib/store'
import { connectionsStore, newQueryTab } from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { Badge, Button, ErrorText, Modal, Spinner } from '@/components/ui'
import { tableRef } from './actions'

interface Request {
  connectionId: string
  database: string
  obj: DbObject
}

const executeStore = createStore<Request | null>(null)

export function openExecuteRoutine(connectionId: string, database: string, obj: DbObject): void {
  executeStore.set({ connectionId, database, obj })
}

export function ExecuteRoutineHost(): React.JSX.Element | null {
  const request = executeStore.use()
  if (!request) return null
  return <ExecuteRoutineDialog key={`${request.obj.schema}.${request.obj.name}`} {...request} />
}

const MODES: { value: ArgMode; label: string }[] = [
  { value: 'value', label: 'Value' },
  { value: 'null', label: 'NULL' },
  { value: 'default', label: 'Default' },
  { value: 'expression', label: 'Expression' }
]

function ExecuteRoutineDialog({ connectionId, database, obj }: Request): React.JSX.Element {
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const dialect: Dialect = (connection && ENGINES[connection.engine].dialect) || 'postgres'
  const kind = obj.kind === 'procedure' ? 'procedure' : 'function'
  const info = useQuery(
    queries.routine(connectionId, database, obj.schema, obj.name, kind, obj.detail)
  )
  const [args, setArgs] = useState<Record<string, RoutineArg>>({})
  const close = (): void => executeStore.set(null)

  const ref = tableRef(connectionId, database, obj)
  const script = useMemo(
    () => (info.data ? callScript(dialect, ref, kind, info.data, args) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info.data, args, dialect, kind]
  )

  const inputs = info.data?.params.filter(isInput) ?? []
  const outputs = info.data?.params.filter(isOutput) ?? []
  const setArg = (name: string, patch: Partial<RoutineArg>): void =>
    setArgs((a) => ({ ...a, [name]: { ...(a[name] ?? { mode: 'value', value: '' }), ...patch } }))

  const open = (autorun: boolean): void => {
    newQueryTab(connectionId, database, script, { autorun, title: `exec ${obj.name}` })
    close()
  }

  return (
    <Modal
      width="lg"
      title={
        <span className="font-mono">
          {obj.schema && connection?.engine !== 'mysql' ? `${obj.schema}.` : ''}
          {obj.name}
        </span>
      }
      description={
        <span className="flex items-center gap-2">
          <Badge>{kind}</Badge>
          {info.data?.returns && (
            <span>
              returns <span className="font-mono text-fg">{info.data.returns}</span>
            </span>
          )}
          {info.data?.language && <span className="text-faint">{info.data.language}</span>}
        </span>
      }
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={() => open(false)} disabled={!script}>
            <FilePlus2 className="size-3.5" /> Open in editor
          </Button>
          <Button variant="primary" onClick={() => open(true)} disabled={!script}>
            <Play className="size-3.5 fill-current" /> Run
          </Button>
        </>
      }
    >
      {info.isPending ? (
        <div className="flex justify-center py-6">
          <Spinner className="size-5" />
        </div>
      ) : info.isError ? (
        <ErrorText error={info.error} />
      ) : (
        <div className="space-y-4">
          {inputs.length ? (
            <table className="w-full text-[12.5px]">
              <thead className="text-left text-[11px] text-muted">
                <tr>
                  <th className="pb-1.5 font-medium">Parameter</th>
                  <th className="pb-1.5 font-medium">Type</th>
                  <th className="pb-1.5 font-medium">Pass</th>
                  <th className="w-1/2 pb-1.5 font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {inputs.map((p, i) => {
                  const arg = args[p.name] ?? { mode: 'value' as ArgMode, value: '' }
                  return (
                    <tr key={p.name || i} className="border-t border-line">
                      <td className="py-1.5 pr-2 font-mono text-bright">
                        {p.name || `$${i + 1}`}
                        {isOutput(p) && (
                          <Badge className="ml-1.5" tone="info">
                            {p.mode.toLowerCase()}
                          </Badge>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-syn-type">{p.dataType}</td>
                      <td className="py-1.5 pr-2">
                        <select
                          value={arg.mode}
                          onChange={(e) => setArg(p.name, { mode: e.target.value as ArgMode })}
                          className="h-7 rounded-md border border-line-strong bg-canvas px-1.5 text-[12px] text-fg focus:outline-none"
                        >
                          {MODES.map((m) => (
                            <option key={m.value} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1.5">
                        <input
                          value={arg.value}
                          disabled={arg.mode === 'null' || arg.mode === 'default'}
                          onChange={(e) => setArg(p.name, { value: e.target.value })}
                          placeholder={
                            arg.mode === 'expression'
                              ? 'e.g. now() or @var'
                              : arg.mode === 'value'
                                ? 'value'
                                : ''
                          }
                          spellCheck={false}
                          className="h-7 w-full rounded-md border border-line-strong bg-canvas px-2 font-mono text-[12px] text-bright placeholder:text-faint focus:border-accent/50 focus:outline-none disabled:opacity-40"
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-muted">This {kind} takes no input parameters.</p>
          )}
          {outputs.length > 0 && (
            <p className="text-[11.5px] text-muted">
              Output parameters ({outputs.map((p) => p.name).join(', ')}) are captured and selected
              after the call.
            </p>
          )}
          <div>
            <p className="mb-1.5 text-[11px] font-medium text-muted">Statement</p>
            <div className="h-36 overflow-hidden rounded-lg border border-line bg-canvas">
              <CodeEditor
                value={script}
                language={{ kind: 'sql', dialect }}
                readOnly
                lineNumbers={false}
                className="h-full"
                fontSize={12}
              />
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
