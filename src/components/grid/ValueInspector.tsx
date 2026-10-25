import { useEffect, useMemo, useState } from 'react'
import { ClipboardCopy, Download, WrapText } from 'lucide-react'
import type { Cell, ColumnMeta } from '@/lib/api'
import {
  binaryExtension,
  hexLines,
  imageType,
  isBinaryColumn,
  parseBinary,
  utf8Text,
  type BinaryValue
} from '@/lib/binary'
import { displayTimestamp } from '@/lib/datetime'
import { decodeEwkb, type Geometry } from '@/lib/ewkb'
import { copyText, saveBytesToFile, saveToFile } from '@/lib/export'
import { formatBytes } from '@/lib/format'
import { isSpatialType, isVectorType, vectorDims } from '@/lib/pg-extensions-aware'
import { settingsStore } from '@/lib/settings'
import { errorMessage, toast } from '@/lib/toast'
import { CodeEditor } from '../editor/CodeEditor'
import { Badge, Button, Modal, Segmented, Spinner } from '../ui'
import { SpatialInspector } from './SpatialInspector'

function prettyJson(text: string): string | null {
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return null
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return null
  }
}

/** Lines of the hex dump drawn at once; the rest is reachable by saving the value */
const HEX_LINES = 4096

type BinaryMode = 'image' | 'hex' | 'text'

/** Full view of one cell: JSON pretty-printing, hex and image views for binary data, editing. */
export function ValueInspector({
  column,
  value,
  editable,
  onSave,
  onLoadFull,
  onClose
}: {
  column: ColumnMeta
  value: Cell
  editable: boolean
  onSave: (value: Cell) => void
  /** Fetches the whole value when the cell arrived cut short */
  onLoadFull?: () => Promise<Cell>
  onClose: () => void
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Cell | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const current = loaded !== undefined ? loaded : value
  const binary = useMemo<BinaryValue | null>(
    () =>
      typeof current === 'string' && isBinaryColumn(column.typeName, current)
        ? parseBinary(current)
        : null,
    [current, column.typeName]
  )
  // PostGIS values arrive as hex EWKB
  const geometry = useMemo<Geometry | null>(
    () =>
      typeof current === 'string' && isSpatialType(column.typeName) ? decodeEwkb(current) : null,
    [current, column.typeName]
  )
  if (geometry)
    return (
      <SpatialInspector
        column={column}
        geometry={geometry}
        editable={editable}
        onSave={onSave}
        onClose={onClose}
      />
    )
  if (binary)
    return (
      <BinaryInspector
        column={column}
        binary={binary}
        loading={loading}
        editable={editable}
        onLoadFull={
          onLoadFull &&
          (async () => {
            setLoading(true)
            try {
              setLoaded(await onLoadFull())
            } catch (e) {
              toast(`Couldn't load the whole value: ${errorMessage(e)}`, 'error')
            } finally {
              setLoading(false)
            }
          })
        }
        onSetNull={() => (onSave(null), onClose())}
        onClose={onClose}
      />
    )
  return (
    <TextInspector
      column={column}
      value={current}
      editable={editable}
      onSave={onSave}
      onClose={onClose}
    />
  )
}

function TextInspector({
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
  const { timeZone, assumeUtc, dateFormat } = settingsStore.use()
  const local =
    typeof value === 'string'
      ? displayTimestamp(value, column.typeName, { timeZone, assumeUtc, format: dateFormat })
      : null
  const changed = text !== (pretty ?? original)
  const dims = typeof value === 'string' && isVectorType(column.typeName) ? vectorDims(value) : null
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
          {dims !== null && <Badge tone="info">{dims.toLocaleString()} dims</Badge>}
          {local && (
            <span className="font-mono text-syn-type" title={`Shown in ${timeZone}`}>
              {local}
            </span>
          )}
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
          <Button
            size="sm"
            variant="ghost"
            disabled={value === null}
            onClick={() => void saveToFile(text, column.name, pretty ? 'json' : 'txt')}
          >
            <Download className="size-3.5" /> Save to file
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

function BinaryInspector({
  column,
  binary,
  loading,
  editable,
  onLoadFull,
  onSetNull,
  onClose
}: {
  column: ColumnMeta
  binary: BinaryValue
  loading: boolean
  editable: boolean
  onLoadFull?: () => Promise<void>
  onSetNull: () => void
  onClose: () => void
}): React.JSX.Element {
  const { bytes, total, truncated } = binary
  const image = useMemo(() => imageType(bytes), [bytes])
  const text = useMemo(() => (bytes.length <= 1 << 20 ? utf8Text(bytes) : null), [bytes])
  const [mode, setMode] = useState<BinaryMode>(image && !truncated ? 'image' : 'hex')
  const lines = useMemo(() => hexLines(bytes, 0, HEX_LINES), [bytes])
  const [url, setUrl] = useState<string | null>(null)

  // Show the picture once the whole value is in
  useEffect(() => {
    if (image && !truncated) setMode('image')
  }, [image, truncated])

  useEffect(() => {
    if (!image || truncated) return setUrl(null)
    const next = URL.createObjectURL(new Blob([bytes as BlobPart], { type: image }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [bytes, image, truncated])

  const save = async (): Promise<void> => {
    if (truncated && !onLoadFull)
      toast(`Only the first ${formatBytes(bytes.length)} of ${formatBytes(total)} were loaded`)
    await saveBytesToFile(bytes, column.name, binaryExtension(bytes))
  }

  const modes: { value: BinaryMode; label: string }[] = [
    ...(image ? [{ value: 'image' as const, label: 'Image' }] : []),
    { value: 'hex', label: 'Hex' },
    ...(text !== null ? [{ value: 'text' as const, label: 'Text' }] : [])
  ]

  return (
    <Modal
      width="lg"
      title={column.name}
      description={
        <span className="flex items-center gap-2">
          {column.typeName && <span className="font-mono">{column.typeName}</span>}
          <span>
            {truncated
              ? `${formatBytes(bytes.length)} of ${formatBytes(total)} loaded`
              : formatBytes(total)}
          </span>
          {image && <Badge tone="info">{image.replace('image/', '').toUpperCase()}</Badge>}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {modes.length > 1 && (
            <Segmented size="sm" value={mode} onChange={setMode} options={modes} />
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void copyText(
                '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
                'Copied as hex'
              )
            }
          >
            <ClipboardCopy className="size-3.5" /> Copy hex
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void save()} disabled={loading}>
            <Download className="size-3.5" /> Save to file
          </Button>
          <div className="flex-1" />
          {editable && (
            <Button size="sm" variant="secondary" onClick={onSetNull}>
              Set NULL
            </Button>
          )}
        </>
      }
    >
      {truncated && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-warn/30 bg-warn/[0.07] px-3 py-1.5 text-[12px] text-warn">
          <span className="flex-1">
            Results carry the first {formatBytes(bytes.length)} of binary values.
            {!onLoadFull && ' Open the table with a primary key to load the whole value.'}
          </span>
          {onLoadFull && (
            <Button
              size="xs"
              variant="secondary"
              disabled={loading}
              onClick={() => void onLoadFull()}
            >
              {loading && <Spinner className="size-3" />} Load all {formatBytes(total)}
            </Button>
          )}
        </div>
      )}
      <div className="h-[46vh] overflow-auto rounded-lg border border-line bg-canvas">
        {mode === 'image' && url ? (
          <div className="flex min-h-full items-center justify-center bg-[repeating-conic-gradient(var(--color-hover)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-4">
            <img src={url} alt={column.name} className="max-h-full max-w-full object-contain" />
          </div>
        ) : mode === 'text' && text !== null ? (
          <pre className="p-3 font-mono text-[12px] whitespace-pre-wrap text-fg select-text">
            {text}
          </pre>
        ) : (
          <div className="p-3 font-mono text-[12px] leading-[1.6] select-text">
            {lines.map((l) => (
              <div key={l.offset} className="flex gap-4 whitespace-pre">
                <span className="text-faint">{l.offset}</span>
                <span className="w-[47ch] text-fg">{l.hex}</span>
                <span className="text-muted">{l.ascii}</span>
              </div>
            ))}
            {bytes.length > HEX_LINES * 16 && (
              <p className="mt-2 font-sans text-faint">
                Showing the first {formatBytes(HEX_LINES * 16)}; save the value to see the rest.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
