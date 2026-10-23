import { useState } from 'react'
import { Braces } from 'lucide-react'
import type { Dialect } from '@/lib/engines'
import { paramSql, paramValuesStore, type ParamMode, type ParamValue } from '@/lib/params'
import { Button, Input, Modal, Select } from '@/components/ui'

/** Asks for the values of a script's `:name` / `${name}` parameters. */
export function ParamsDialog({
  names,
  dialect,
  onDone
}: {
  names: string[]
  dialect: Dialect
  /** `null` when cancelled */
  onDone: (values: Record<string, ParamValue> | null) => void
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, ParamValue>>(() => {
    const remembered = paramValuesStore.get()
    return Object.fromEntries(
      names.map((n) => [n, remembered[n] ?? { value: '', mode: 'auto' as ParamMode }])
    )
  })
  const set = (name: string, patch: Partial<ParamValue>): void =>
    setValues((v) => ({ ...v, [name]: { ...v[name], ...patch } }))

  const run = (): void => {
    paramValuesStore.set((r) => ({ ...r, ...values }))
    onDone(values)
  }

  return (
    <Modal
      width="md"
      icon={
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Braces className="size-4" />
        </span>
      }
      title="Query parameters"
      description="Values replace the :name and ${name} placeholders before the query runs."
      onClose={() => onDone(null)}
      footer={
        <>
          <Button variant="secondary" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={run}>
            Run
          </Button>
        </>
      }
    >
      <form
        className="space-y-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          run()
        }}
      >
        <div className="grid grid-cols-[minmax(6rem,auto)_1fr_7.5rem] items-center gap-x-2 gap-y-2.5">
          {names.map((name) => {
            const v = values[name]
            return (
              <div key={name} className="contents">
                <span className="truncate font-mono text-xs text-bright" title={name}>
                  :{name}
                </span>
                <Input
                  mono
                  value={v.value}
                  onChange={(e) => set(name, { value: e.target.value })}
                  placeholder={v.mode === 'raw' ? 'SQL expression, e.g. NULL or now()' : 'Value'}
                />
                <Select
                  value={v.mode}
                  onChange={(e) => set(name, { mode: e.target.value as ParamMode })}
                  title={`Runs as ${paramSql(dialect, v) || '(empty)'}`}
                >
                  <option value="auto">Auto</option>
                  <option value="text">Text</option>
                  <option value="raw">Raw SQL</option>
                </Select>
              </div>
            )
          })}
        </div>
        <p className="text-[11px] leading-snug text-faint">
          Auto leaves numbers as they are and quotes everything else. Raw SQL is inserted as typed,
          for NULL, expressions or lists.
        </p>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
