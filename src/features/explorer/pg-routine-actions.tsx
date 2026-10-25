import { FileCode2, ScrollText, Trash2 } from 'lucide-react'
import type { DbObject } from '@/lib/api'
import { dropRoutineSql } from '@/lib/pg-objects'
import { queries, queryClient } from '@/lib/queries'
import { toastError } from '@/lib/toast'
import { newQueryTab, openTable } from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'

async function scriptCreate(connectionId: string, database: string, obj: DbObject): Promise<void> {
  try {
    const definition = await queryClient.fetchQuery(
      queries.definition(connectionId, database, obj.schema, obj.name, obj.kind, obj.detail)
    )
    newQueryTab(connectionId, database, definition ?? `-- No definition available for ${obj.name}`)
  } catch (e) {
    toastError(e)
  }
}

/**
 * PostgreSQL aggregates and window functions: DDL and scripts, but no Execute or
 * Modify, since neither can be called on its own (`SELECT * FROM agg()` fails).
 */
export function pgAggregateMenuItems(
  connectionId: string,
  database: string,
  obj: DbObject
): MenuItem[] {
  return [
    {
      label: 'DDL',
      icon: <ScrollText />,
      onSelect: () =>
        openTable(connectionId, database, obj.schema, obj.name, obj.kind, 'definition', obj.detail)
    },
    {
      label: 'Script as CREATE',
      icon: <FileCode2 />,
      onSelect: () => void scriptCreate(connectionId, database, obj)
    },
    {
      label: 'Script as DROP',
      icon: <Trash2 />,
      onSelect: () => newQueryTab(connectionId, database, dropRoutineSql(obj))
    }
  ]
}
