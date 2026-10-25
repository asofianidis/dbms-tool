import { useQuery } from '@tanstack/react-query'
import { CircleSlash, DatabaseZap, RefreshCw, Square } from 'lucide-react'
import { api, type DbObject } from '@/lib/api'
import { compactCount, formatDuration } from '@/lib/format'
import {
  concurrentRefreshBlocker,
  matviewStatusQuery,
  refreshMatviewSql,
  type RefreshMode
} from '@/lib/matviews'
import { confirmProductionWrite, isProduction } from '@/lib/production'
import { queryClient } from '@/lib/queries'
import { qualified, type TableRef } from '@/lib/sql'
import { toast, toastError } from '@/lib/toast'
import { confirm, getConnection } from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'

/** Sessions of refreshes still running, so the menu can offer to cancel them. */
const running = new Map<string, string>()

const runningKey = (connectionId: string, database: string, ref: TableRef): string =>
  `${connectionId}/${database}/${ref.schema ?? ''}.${ref.name}`

/** Drops what a refresh changes: populated state, row estimate, DDL and the cached structure. */
function invalidate(connectionId: string, database: string, ref: TableRef): void {
  for (const queryKey of [
    ['conn', connectionId, 'matviews', database, ref.schema],
    ['conn', connectionId, 'objects', database, ref.schema],
    ['conn', connectionId, 'table', database, ref.schema, ref.name],
    ['conn', connectionId, 'definition', database, ref.schema, ref.name]
  ])
    void queryClient.invalidateQueries({ queryKey })
}

/**
 * REFRESH MATERIALIZED VIEW on its own session, so it can be cancelled from the menu
 * and doesn't hold up the explorer. Production connections confirm it in `api.execute`;
 * the backend refuses it on read-only ones. Resolves true when the refresh finished.
 */
export async function refreshMatview(
  connectionId: string,
  database: string,
  ref: TableRef,
  mode: RefreshMode
): Promise<boolean> {
  const key = runningKey(connectionId, database, ref)
  if (running.has(key)) return false
  const connection = getConnection(connectionId)
  const name = qualified('postgres', ref)
  const sql = refreshMatviewSql(ref, mode)
  let confirmed = false
  if (mode === 'no-data') {
    // Empties the view until the next refresh, so it's worth a question everywhere
    const danger = `WITH NO DATA empties ${name}; reading it fails until it's refreshed again`
    confirmed = isProduction(connection)
      ? await confirmProductionWrite(connection, {
          action: `This runs REFRESH MATERIALIZED VIEW on ${name}`,
          dangers: [danger],
          code: sql
        })
      : await confirm({
          title: `Empty ${ref.name}?`,
          message: `${danger}.`,
          code: sql,
          confirmLabel: 'Refresh with no data',
          danger: true
        })
    if (!confirmed) return false
  }
  const session = `matview-refresh-${key}`
  running.set(key, session)
  toast(`Refreshing ${name}…`, 'info')
  try {
    const out = await api.execute(connectionId, session, database, sql, { confirmed })
    if (out.cancelled) {
      toast(`Refresh of ${name} cancelled`, 'info')
      return false
    }
    if (out.error) throw new Error(out.error.message)
    toast(
      mode === 'no-data'
        ? `Emptied ${name}`
        : `Refreshed ${name} in ${formatDuration(out.elapsedMs)}`
    )
    return true
  } catch (e) {
    toastError(e)
    return false
  } finally {
    running.delete(key)
    invalidate(connectionId, database, ref)
    void api.closeSession(connectionId, session).catch(() => undefined)
  }
}

/** Refresh entries for a PostgreSQL materialized view's context menu. */
export function matviewMenuItems(
  connectionId: string,
  database: string,
  obj: DbObject,
  ref: TableRef
): MenuItem[] {
  const key = runningKey(connectionId, database, ref)
  const session = running.get(key)
  if (session)
    return [
      {
        label: 'Cancel refresh',
        icon: <Square />,
        onSelect: () => void api.cancel(connectionId, session)
      }
    ]
  const readOnly = !!getConnection(connectionId)?.readOnly
  const status = queryClient.getQueryData(
    matviewStatusQuery(connectionId, database, obj.schema).queryKey
  )?.[obj.name]
  const blocker = readOnly ? null : concurrentRefreshBlocker(status)
  const why = readOnly ? 'The connection is read-only' : undefined
  const run = (mode: RefreshMode) => () => void refreshMatview(connectionId, database, ref, mode)
  return [
    {
      label: 'Refresh data',
      icon: <RefreshCw />,
      disabled: readOnly,
      title: why ?? 'REFRESH MATERIALIZED VIEW: reruns the query; blocks reads until it finishes',
      onSelect: run('normal')
    },
    {
      label: 'Refresh concurrently',
      icon: <DatabaseZap />,
      disabled: readOnly || !!blocker,
      title:
        why ??
        blocker ??
        'REFRESH MATERIALIZED VIEW CONCURRENTLY: reads keep working while it runs; slower',
      onSelect: run('concurrently')
    },
    {
      label: 'Refresh with no data',
      icon: <CircleSlash />,
      disabled: readOnly,
      title:
        why ?? 'REFRESH … WITH NO DATA: frees the storage; the view is unreadable until refreshed',
      onSelect: run('no-data')
    }
  ]
}

/** Explorer row detail for a materialized view: its row estimate, or "not populated". */
export function MatviewRowDetail({
  connectionId,
  database,
  obj
}: {
  connectionId: string
  database: string
  obj: DbObject
}): React.JSX.Element | null {
  const q = useQuery(matviewStatusQuery(connectionId, database, obj.schema))
  if (q.data?.[obj.name]?.populated === false)
    return (
      <span className="text-warn" title="Created or refreshed WITH NO DATA; refresh it to read it">
        not populated
      </span>
    )
  return obj.rowEstimate != null && obj.rowEstimate >= 0 ? (
    <>{compactCount(obj.rowEstimate)}</>
  ) : null
}
