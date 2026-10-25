import { useQuery } from '@tanstack/react-query'
import { Shield, ShieldCheck } from 'lucide-react'
import { rlsLabel, rlsQueries, takesUsing, takesWithCheck, type PolicyState } from '@/lib/rls'
import type { TableRef } from '@/lib/sql'
import { connectionsStore } from '@/lib/workspace'
import { Badge, ErrorText } from '@/components/ui'
import { scriptPolicy, setRls } from '../explorer/rls-actions'
import { openPolicyDesigner } from './PolicyDesigner'

/** Row-level security flags and policies in a PostgreSQL table's structure view. */
export function RlsSection({
  connectionId,
  database,
  schema,
  table
}: {
  connectionId: string
  database: string
  schema: string | null
  table: string
}): React.JSX.Element | null {
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const q = useQuery(rlsQueries.table(connectionId, database, schema, table))
  if (q.isPending) return null
  const readOnly = !!connection?.readOnly
  const ref: TableRef = { schema, name: table }
  const obj = { schema, name: table }
  const action = (label: string, onClick: () => void): React.JSX.Element => (
    <button
      className="text-info hover:underline disabled:no-underline disabled:opacity-50"
      disabled={readOnly}
      onClick={onClick}
    >
      {label}
    </button>
  )
  return (
    <section className="mb-6">
      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
        Row-level security{' '}
        {q.data && <span className="font-normal text-faint">{q.data.policies.length}</span>}
      </h3>
      {q.isError ? (
        <ErrorText error={q.error} />
      ) : (
        <>
          <div className="mb-2 flex items-center gap-3 text-[12px]">
            <span className="flex items-center gap-1.5">
              {q.data.enabled ? (
                <ShieldCheck className="size-3.5 text-syn-fn" />
              ) : (
                <Shield className="size-3.5 text-faint" />
              )}
              <span className="text-muted">Row-level security:</span>
              <span className="font-mono text-bright">{rlsLabel(q.data)}</span>
              {q.data.forced && !q.data.enabled && (
                <span className="text-faint">(FORCE is set and applies once enabled)</span>
              )}
            </span>
            <span className="ml-auto flex gap-3 text-[11px]">
              {q.data.enabled
                ? action('Disable', () => void setRls(connectionId, database, obj, 'disable'))
                : action('Enable', () => void setRls(connectionId, database, obj, 'enable'))}
              {q.data.forced
                ? action('No force', () => void setRls(connectionId, database, obj, 'noforce'))
                : action('Force', () => void setRls(connectionId, database, obj, 'force'))}
              {action('New policy…', () =>
                openPolicyDesigner(connectionId, database, schema, table)
              )}
            </span>
          </div>
          {q.data.enabled && !q.data.policies.length && (
            <p className="mb-2 text-xs text-warn">
              No policies: only the owner and roles that bypass RLS can see or change rows.
            </p>
          )}
          {q.data.policies.length ? (
            <table className="w-full text-left text-[12.5px]">
              <thead className="text-[11px] text-muted">
                <tr className="border-b border-line">
                  <th className="py-1.5 font-medium">Policy</th>
                  <th className="py-1.5 font-medium">Type</th>
                  <th className="py-1.5 font-medium">Command</th>
                  <th className="py-1.5 font-medium">Roles</th>
                  <th className="py-1.5 font-medium">Using</th>
                  <th className="py-1.5 font-medium">With check</th>
                  <th />
                </tr>
              </thead>
              <tbody className="select-text">
                {q.data.policies.map((p) => (
                  <PolicyRow
                    key={p.name}
                    policy={p}
                    onEdit={() => openPolicyDesigner(connectionId, database, schema, table, p.name)}
                    onScript={() => scriptPolicy(connectionId, database, ref, p, 'create')}
                    onDrop={
                      readOnly
                        ? undefined
                        : () =>
                            openPolicyDesigner(connectionId, database, schema, table, p.name, true)
                    }
                  />
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-faint">No policies</p>
          )}
        </>
      )}
    </section>
  )
}

function PolicyRow({
  policy: p,
  onEdit,
  onScript,
  onDrop
}: {
  policy: PolicyState
  onEdit: () => void
  onScript: () => void
  onDrop?: () => void
}): React.JSX.Element {
  const expr = (value: string, applies: boolean): React.JSX.Element => (
    <td
      className="max-w-64 truncate py-1.5 font-mono text-[11.5px] text-muted"
      title={value || undefined}
    >
      {applies ? value || <span className="text-faint">—</span> : null}
    </td>
  )
  return (
    <tr className="border-b border-line/60 hover:bg-hover/40">
      <td className="py-1.5 font-mono text-bright">{p.name}</td>
      <td className="py-1.5">
        {p.permissive ? (
          <span className="text-muted">permissive</span>
        ) : (
          <Badge tone="warning">restrictive</Badge>
        )}
      </td>
      <td className="py-1.5 font-mono text-[11.5px] text-fg">{p.command}</td>
      <td
        className="max-w-48 truncate py-1.5 font-mono text-[11.5px] text-fg"
        title={p.roles.join(', ')}
      >
        {p.roles.map((r) => (r === 'public' ? 'PUBLIC' : r)).join(', ')}
      </td>
      {expr(p.using, takesUsing(p.command))}
      {expr(p.withCheck, takesWithCheck(p.command))}
      <td className="py-1.5 text-right text-[11px] whitespace-nowrap select-none">
        <span className="flex justify-end gap-3">
          <button className="text-info hover:underline" onClick={onEdit}>
            Edit…
          </button>
          <button className="text-info hover:underline" onClick={onScript}>
            Script
          </button>
          {onDrop && (
            <button className="text-danger hover:underline" onClick={onDrop}>
              Drop…
            </button>
          )}
        </span>
      </td>
    </tr>
  )
}
