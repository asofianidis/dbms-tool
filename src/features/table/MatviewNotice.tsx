import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DatabaseZap, RefreshCw } from 'lucide-react'
import { isUnpopulatedError, matviewStatusQuery } from '@/lib/matviews'
import type { TableRef } from '@/lib/sql'
import { getConnection, type TabOf } from '@/lib/workspace'
import { Badge, Button, EmptyState, ErrorText } from '@/components/ui'
import { refreshMatview } from '../explorer/matviews'

const isPgMatview = (tab: TabOf<'table'>): boolean =>
  tab.objectKind === 'materialized_view' && getConnection(tab.connectionId)?.engine === 'postgres'

function useMatviewStatus(tab: TabOf<'table'>) {
  const q = useQuery({
    ...matviewStatusQuery(tab.connectionId, tab.database, tab.schema),
    enabled: isPgMatview(tab)
  })
  return q.data?.[tab.name]
}

/** "not populated" beside a PostgreSQL materialized view's name. */
export function MatviewBadge({ tab }: { tab: TabOf<'table'> }): React.JSX.Element | null {
  const status = useMatviewStatus(tab)
  if (status?.populated !== false) return null
  return (
    <Badge tone="warning" title="Created or refreshed WITH NO DATA; refresh it to read it">
      not populated
    </Badge>
  )
}

/**
 * The data view's error. Reading a materialized view that was created or refreshed
 * WITH NO DATA fails; that gets an explanation and a way to refresh it instead.
 */
export function DataError({
  tab,
  tableRef,
  error,
  onRefreshed
}: {
  tab: TabOf<'table'>
  tableRef: TableRef
  error: string
  onRefreshed: () => void
}): React.JSX.Element {
  const status = useMatviewStatus(tab)
  const [refreshing, setRefreshing] = useState(false)
  // The status check doesn't depend on the server's message language
  const unpopulated = isPgMatview(tab) && (status?.populated === false || isUnpopulatedError(error))
  if (!unpopulated)
    return (
      <div className="p-4">
        <ErrorText error={error} />
      </div>
    )
  const readOnly = !!getConnection(tab.connectionId)?.readOnly
  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    const done = await refreshMatview(tab.connectionId, tab.database, tableRef, 'normal')
    setRefreshing(false)
    if (done) onRefreshed()
  }
  return (
    <EmptyState
      icon={<DatabaseZap className="size-6" />}
      title="This materialized view isn’t populated"
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={readOnly || refreshing}
          title={readOnly ? 'The connection is read-only' : undefined}
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-3.5" />
          {refreshing ? 'Refreshing…' : 'Refresh data'}
        </Button>
      }
    >
      It was created or last refreshed WITH NO DATA, so it has no rows to show. Refreshing runs its
      query and stores the result (REFRESH MATERIALIZED VIEW).
    </EmptyState>
  )
}
