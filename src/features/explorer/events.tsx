import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, FileCode2, Pause, Play, ScrollText } from 'lucide-react'
import { api, type DbObject } from '@/lib/api'
import {
  alterEventScript,
  createEventScript,
  dropEventSql,
  eventSchedulerQuery,
  eventTemplate,
  isEventEnabled,
  schedulerNote,
  setEventEnabledSql
} from '@/lib/events'
import { queries, queryClient } from '@/lib/queries'
import { toast, toastError } from '@/lib/toast'
import { getConnection, newQueryTab, openTable } from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'

async function definitionOf(connectionId: string, database: string, obj: DbObject) {
  const definition = await queryClient.fetchQuery(
    queries.definition(connectionId, database, obj.schema, obj.name, obj.kind, obj.detail)
  )
  if (!definition) throw new Error(`No definition available for ${obj.name}`)
  return definition
}

async function scriptEvent(
  connectionId: string,
  database: string,
  obj: DbObject,
  kind: 'create' | 'alter' | 'drop'
): Promise<void> {
  try {
    const text =
      kind === 'drop'
        ? dropEventSql(database, obj.name)
        : kind === 'alter'
          ? alterEventScript(await definitionOf(connectionId, database, obj))
          : createEventScript(await definitionOf(connectionId, database, obj))
    newQueryTab(connectionId, database, text)
  } catch (e) {
    toastError(e)
  }
}

/** ALTER EVENT … ENABLE | DISABLE; production connections confirm it in `api.execute`. */
async function setEventEnabled(
  connectionId: string,
  database: string,
  obj: DbObject,
  enabled: boolean
): Promise<void> {
  try {
    const out = await api.execute(
      connectionId,
      '__meta',
      database,
      setEventEnabledSql(database, obj.name, enabled)
    )
    if (out.error) throw new Error(out.error.message)
    toast(`${enabled ? 'Enabled' : 'Disabled'} event ${obj.name}`)
    void queryClient.invalidateQueries({ queryKey: ['conn', connectionId, 'objects', database] })
  } catch (e) {
    toastError(e)
  }
}

/** Context menu entries for an event, between the heading and Copy name. */
export function eventMenuItems(connectionId: string, database: string, obj: DbObject): MenuItem[] {
  const readOnly = !!getConnection(connectionId)?.readOnly
  const enabled = isEventEnabled(obj.detail)
  return [
    {
      label: 'DDL',
      icon: <ScrollText />,
      onSelect: () =>
        openTable(connectionId, database, obj.schema, obj.name, obj.kind, 'definition', obj.detail)
    },
    {
      label: 'Script as',
      icon: <FileCode2 />,
      submenu: [
        {
          label: 'CREATE',
          onSelect: () => void scriptEvent(connectionId, database, obj, 'create')
        },
        { label: 'ALTER', onSelect: () => void scriptEvent(connectionId, database, obj, 'alter') },
        { label: 'DROP', onSelect: () => void scriptEvent(connectionId, database, obj, 'drop') }
      ]
    },
    'separator',
    enabled
      ? {
          label: 'Disable',
          icon: <Pause />,
          disabled: readOnly,
          onSelect: () => void setEventEnabled(connectionId, database, obj, false)
        }
      : {
          label: 'Enable',
          icon: <Play />,
          disabled: readOnly,
          onSelect: () => void setEventEnabled(connectionId, database, obj, true)
        }
  ]
}

/** Opens a query tab with a template for a new event. */
export function newEvent(connectionId: string, database: string): void {
  const scheduler = queryClient.getQueryData(eventSchedulerQuery(connectionId).queryKey) ?? null
  newQueryTab(connectionId, database, eventTemplate(scheduler))
}

/** A warning beside the Events folder when the event scheduler isn't running. */
export function EventSchedulerBadge({
  connectionId
}: {
  connectionId: string
}): React.JSX.Element | null {
  const q = useQuery(eventSchedulerQuery(connectionId))
  const note = schedulerNote(q.data ?? null)
  if (!note) return null
  return (
    <span className="ml-1.5 inline-flex items-center gap-0.5 text-[11px] text-warn" title={note}>
      <AlertTriangle className="size-3" />
      scheduler {q.data?.toLowerCase()}
    </span>
  )
}
