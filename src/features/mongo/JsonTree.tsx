import { memo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { bsonType, scalarText, type BsonType } from '@/lib/ejson'

const TYPE_TONE: Partial<Record<BsonType, string>> = {
  String: 'text-syn-string',
  Int32: 'text-syn-number',
  Int64: 'text-syn-number',
  Double: 'text-syn-number',
  Decimal128: 'text-syn-number',
  Boolean: 'text-syn-keyword',
  Null: 'text-faint italic',
  ObjectId: 'text-syn-fn',
  Date: 'text-syn-type',
  UUID: 'text-syn-fn',
  Binary: 'text-muted',
  Regex: 'text-syn-string',
  Timestamp: 'text-syn-type'
}

const WRAPPED: Partial<Record<BsonType, string>> = {
  ObjectId: 'ObjectId',
  Date: 'ISODate',
  Int64: 'Long',
  Decimal128: 'Decimal',
  UUID: 'UUID'
}

export function ScalarValue({
  value,
  className
}: {
  value: unknown
  className?: string
}): React.JSX.Element {
  const type = bsonType(value)
  const text = scalarText(value)
  const wrapper = WRAPPED[type]
  return (
    <span className={cn('break-all whitespace-pre-wrap', TYPE_TONE[type], className)}>
      {wrapper ? (
        <>
          <span className="text-faint">{wrapper}(</span>
          {type === 'Int64' || type === 'Decimal128' ? text : `'${text}'`}
          <span className="text-faint">)</span>
        </>
      ) : type === 'String' ? (
        `"${text.length > 2000 ? text.slice(0, 2000) + '…' : text}"`
      ) : type === 'Double' && /^-?\d+$/.test(text) ? (
        `${text}.0`
      ) : (
        text
      )}
    </span>
  )
}

function Node({
  name,
  value,
  depth,
  defaultOpen,
  isIndex
}: {
  name: string
  value: unknown
  depth: number
  defaultOpen: boolean
  isIndex?: boolean
}): React.JSX.Element {
  const type = bsonType(value)
  const container = type === 'Object' || type === 'Array'
  const [open, setOpen] = useState(defaultOpen)
  const entries = container
    ? type === 'Array'
      ? (value as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>)
    : []
  return (
    <div>
      <div
        className={cn(
          'flex items-start gap-1 rounded py-px leading-5 hover:bg-hover/50',
          container && 'cursor-default'
        )}
        style={{ paddingLeft: depth * 16 }}
        onClick={() => container && setOpen((o) => !o)}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-faint">
          {container && (
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
          )}
        </span>
        <span className={cn('shrink-0', isIndex ? 'text-faint' : 'text-syn-prop')}>{name}</span>
        <span className="shrink-0 text-faint">:</span>
        {container ? (
          <span className="text-faint">
            {type === 'Array' ? `Array (${entries.length})` : `Object (${entries.length})`}
            {!open && entries.length > 0 && (
              <span className="ml-2 text-faint/70">
                {type === 'Array' ? '[' : '{'} … {type === 'Array' ? ']' : '}'}
              </span>
            )}
          </span>
        ) : (
          <ScalarValue value={value} className="min-w-0" />
        )}
      </div>
      {container &&
        open &&
        entries.map(([k, v]) => (
          <Node
            key={k}
            name={k}
            value={v}
            depth={depth + 1}
            defaultOpen={false}
            isIndex={type === 'Array'}
          />
        ))}
    </div>
  )
}

/** Expandable view of one document. Top-level fields start open, nested ones closed. */
export const JsonTree = memo(function JsonTree({
  value,
  expandAll = false
}: {
  value: Record<string, unknown> | unknown[]
  expandAll?: boolean
}): React.JSX.Element {
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value)
  return (
    <div className="font-mono text-[12px] select-text">
      {entries.map(([k, v]) => (
        <Node
          key={k}
          name={k}
          value={v}
          depth={0}
          defaultOpen={expandAll}
          isIndex={Array.isArray(value)}
        />
      ))}
    </div>
  )
})
