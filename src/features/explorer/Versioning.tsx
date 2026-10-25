import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import type { ConnectionConfig, DbObject } from '@/lib/api'
import { connectedInfo } from '@/lib/mariadb'
import { queryClient } from '@/lib/queries'
import {
  nowTimestamp,
  purgeHistoryScript,
  supportsVersioning,
  versionedTablesQuery
} from '@/lib/versioning'
import { getConnection, newQueryTab, statusStore } from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'

/** Whether the connection is MariaDB with system-versioned tables. */
function versionable(connectionId: string, statuses = statusStore.get()): boolean {
  return (
    getConnection(connectionId)?.engine === 'mysql' &&
    supportsVersioning(connectedInfo(statuses[connectionId]))
  )
}

/**
 * Marks a system-versioned table in the explorer. It stays a plain table: the
 * object list doesn't say, so one catalog query per database tells which are.
 */
export function VersionedMark({
  connection,
  database,
  obj
}: {
  connection: ConnectionConfig
  database: string
  obj: DbObject
}): React.JSX.Element | null {
  const enabled = obj.kind === 'table' && versionable(connection.id, statusStore.use())
  const versioned = useQuery({ ...versionedTablesQuery(connection.id, database), enabled })
  if (!enabled || !versioned.data?.includes(obj.name)) return null
  return (
    <span
      className="ml-1.5 inline-flex align-[-1px] text-faint"
      title="System-versioned: MariaDB keeps every old version of its rows"
    >
      <History className="size-3" />
    </span>
  )
}

/** "Script as" entries for a system-versioned table, once the explorer knows it is one. */
export function versioningScriptItems(
  connectionId: string,
  database: string,
  obj: DbObject
): MenuItem[] {
  if (obj.kind !== 'table' || !versionable(connectionId)) return []
  const versioned = queryClient.getQueryData(versionedTablesQuery(connectionId, database).queryKey)
  if (!versioned?.includes(obj.name)) return []
  return [
    {
      label: 'DELETE HISTORY',
      onSelect: () =>
        newQueryTab(
          connectionId,
          database,
          purgeHistoryScript({ schema: database, name: obj.name }, nowTimestamp()),
          { title: `purge history ${obj.name}` }
        )
    }
  ]
}
