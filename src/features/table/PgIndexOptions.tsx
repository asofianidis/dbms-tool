import type { IndexDraft } from '@/lib/ddl'
import {
  indexOpclasses,
  indexParams,
  needsOpclass,
  type PgExtensions
} from '@/lib/pg-extensions-aware'
import { Field, Input, Select } from '@/components/ui'

/**
 * Operator class and storage parameters of a PostgreSQL index, for the methods
 * pgvector and PostGIS add or extend (hnsw, ivfflat, gist, spgist). Renders
 * nothing for other methods or when neither extension is installed.
 */
export function PgIndexOptions({
  ix,
  extensions,
  onChange
}: {
  ix: IndexDraft
  extensions: PgExtensions
  onChange: (change: Partial<IndexDraft>) => void
}): React.JSX.Element | null {
  const opclasses = indexOpclasses(ix.method, extensions)
  const params = indexParams(ix.method)
  if (!opclasses.length && !params.length) return null
  const required = needsOpclass(ix.method)
  const current = ix.opclass ?? ''
  return (
    <div className="flex items-end gap-3">
      {opclasses.length > 0 && (
        <Field label="Operator class (first column)" className="flex-1">
          <Select
            selectClassName="h-7 font-mono text-xs"
            value={current}
            onChange={(e) => onChange({ opclass: e.target.value })}
          >
            {!required && <option value="">default</option>}
            {current && !opclasses.includes(current) && <option value={current}>{current}</option>}
            {opclasses.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {params.map((p) => (
        <Field key={p.name} label={p.name} className="w-32">
          <Input
            mono
            className="h-7 text-xs"
            inputMode="numeric"
            title={p.hint}
            placeholder={String(p.fallback)}
            value={ix.params?.[p.name] ?? ''}
            onChange={(e) =>
              onChange({
                params: { ...ix.params, [p.name]: e.target.value.replace(/\D/g, '') }
              })
            }
          />
        </Field>
      ))}
    </div>
  )
}
