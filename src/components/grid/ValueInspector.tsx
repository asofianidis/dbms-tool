import { useMemo, useState } from 'react'
import { ClipboardCopy, WrapText } from 'lucide-react'
import type { Cell, ColumnMeta } from '@/lib/api'
import { copyText } from '@/lib/export'
import { CodeEditor } from '../editor/CodeEditor'
import { Badge, Button, Modal } from '../ui'

function prettyJson(text: string): string | null {
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return null
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return null
  }
}

/** Full view of one cell, with JSON pretty-printing and optional editing. */
export function ValueInspector({
  column,
  value,
  editable,
  onSave,
  onClose
}: {
  column: ColumnMeta
  value: Cell
  editable: boolean
  onSave: (value: Cell) => void
  onClose: () => void
}): React.JSX.Element {
  const original = value === null ? '' : String(value)
  const pretty = useMemo(() => (typeof value === 'string' ? prettyJson(value) : null), [value])
  const [text, setText] = useState(pretty ?? original)
  const [wrap, setWrap] = useState(true)
  const changed = text !== (pretty ?? original)
  return (
    <Modal
      width="lg"
      title={column.name}
      description={
        <span className="flex items-center gap-2">
          {column.typeName && <span className="font-mono">{column.typeName}</span>}
          {value === null ? (
            <Badge>NULL</Badge>
          ) : (
            <span>{original.length.toLocaleString()} characters</span>
          )}
          {pretty && <Badge tone="info">JSON</Badge>}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={() => setWrap((w) => !w)}>
            <WrapText className="size-3.5" /> {wrap ? 'No wrap' : 'Wrap'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void copyText(text, 'Copied value')}>
            <ClipboardCopy className="size-3.5" /> Copy
          </Button>
          <div className="flex-1" />
          {editable && (
            <>
              <Button size="sm" variant="secondary" onClick={() => (onSave(null), onClose())}>
                Set NULL
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!changed}
                onClick={() => {
                  // Keep compact JSON if the user only reformatted it
                  const next = pretty && prettyJson(text) === text ? original : text
                  onSave(next)
                  onClose()
                }}
              >
                Apply
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="h-[46vh] overflow-hidden rounded-lg border border-line bg-canvas">
        <CodeEditor
          value={text}
          onChange={setText}
          language={pretty ? { kind: 'json' } : { kind: 'text' }}
          readOnly={!editable}
          wordWrap={wrap}
          lineNumbers={!!pretty || text.includes('\n')}
          className="h-full"
          fontSize={12.5}
        />
      </div>
    </Modal>
  )
}
