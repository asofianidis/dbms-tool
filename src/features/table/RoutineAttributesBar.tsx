import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { queries } from '@/lib/queries'
import { routineAttributeItems, searchPathWarning } from '@/lib/routine-attributes'
import { Badge } from '@/components/ui'

/**
 * Security, volatility and the other attributes of a PostgreSQL function or
 * procedure, above its definition. SECURITY DEFINER without a pinned
 * search_path gets a warning. Renders nothing for engines without them.
 */
export function RoutineAttributesBar({
  connectionId,
  database,
  schema,
  name,
  kind,
  detail
}: {
  connectionId: string
  database: string
  schema: string | null
  name: string
  kind: 'function' | 'procedure'
  detail: string | null | undefined
}): React.JSX.Element | null {
  const q = useQuery(queries.routine(connectionId, database, schema, name, kind, detail))
  const attrs = q.data?.attributes
  if (!attrs) return null
  const warning = searchPathWarning(attrs)
  return (
    <div className="shrink-0 border-b border-line bg-panel px-3 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {routineAttributeItems(attrs, kind).map((item) => (
          <Badge key={item.label} tone={item.tone} title={item.title} className="font-mono">
            {item.label}
          </Badge>
        ))}
      </div>
      {warning && (
        <div className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-warn">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{warning}</span>
        </div>
      )}
    </div>
  )
}
