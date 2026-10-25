import { useQuery } from '@tanstack/react-query'
import {
  FileCode2,
  Pencil,
  Plus,
  ShieldCheck,
  ShieldOff,
  ShieldAlert,
  ShieldPlus,
  Trash2
} from 'lucide-react'
import { api, type ConnectionConfig, type DbObject } from '@/lib/api'
import { ddlScript } from '@/lib/ddl'
import { queryClient } from '@/lib/queries'
import {
  createPolicyStatement,
  dropPolicyStatement,
  rlsLabel,
  rlsQueries,
  rlsStatement,
  type PolicyState,
  type RlsAction,
  type RlsFlags
} from '@/lib/rls'
import type { TableRef } from '@/lib/sql'
import { toast, toastError } from '@/lib/toast'
import { getConnection, newQueryTab } from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'
import { openPolicyDesigner } from '../table/PolicyDesigner'

/** Row-level security applies to plain and partitioned PostgreSQL tables, not Babelfish's T-SQL side. */
export function hasRls(connection: ConnectionConfig | undefined, kind: string): boolean {
  return connection?.engine === 'postgres' && kind === 'table'
}

const refOf = (obj: { schema: string | null; name: string }): TableRef => ({
  schema: obj.schema,
  name: obj.name
})

/** Reloads the RLS badges and the table's policies after a change. */
export function invalidateRls(connectionId: string, database: string): void {
  void queryClient.invalidateQueries({
    queryKey: ['conn', connectionId, 'catalog', database, 'rls']
  })
  void queryClient.invalidateQueries({
    queryKey: ['conn', connectionId, 'catalog', database, 'policies']
  })
}

const DONE: Record<RlsAction, string> = {
  enable: 'Enabled row-level security on',
  disable: 'Disabled row-level security on',
  force: 'Forced row-level security on',
  noforce: 'Stopped forcing row-level security on'
}

/** ALTER TABLE … ROW LEVEL SECURITY; production connections confirm it in `api.execute`. */
export async function setRls(
  connectionId: string,
  database: string,
  obj: { schema: string | null; name: string },
  action: RlsAction
): Promise<void> {
  try {
    const out = await api.execute(
      connectionId,
      '__meta',
      database,
      ddlScript('postgres', [rlsStatement(refOf(obj), action)])
    )
    if (out.error) throw new Error(out.error.message)
    toast(`${DONE[action]} ${obj.name}`)
    invalidateRls(connectionId, database)
  } catch (e) {
    toastError(e)
  }
}

/** Flags from the database-wide query the explorer badges use; off until it's loaded. */
function cachedFlags(connectionId: string, database: string, obj: DbObject): RlsFlags {
  const map = queryClient.getQueryData<Map<string, RlsFlags>>(
    rlsQueries.tables(connectionId, database).queryKey
  )
  return map?.get(`${obj.schema ?? 'public'}.${obj.name}`) ?? { enabled: false, forced: false }
}

/** Enable/Disable, Force/No force and New policy… for a table. */
export function rlsActionItems(
  connectionId: string,
  database: string,
  obj: { schema: string | null; name: string },
  flags: RlsFlags
): MenuItem[] {
  const readOnly = !!getConnection(connectionId)?.readOnly
  const run = (action: RlsAction) => () => void setRls(connectionId, database, obj, action)
  return [
    {
      label: 'New policy…',
      icon: <Plus />,
      disabled: readOnly,
      onSelect: () => openPolicyDesigner(connectionId, database, obj.schema, obj.name)
    },
    'separator',
    flags.enabled
      ? { label: 'Disable RLS', icon: <ShieldOff />, disabled: readOnly, onSelect: run('disable') }
      : { label: 'Enable RLS', icon: <ShieldCheck />, disabled: readOnly, onSelect: run('enable') },
    flags.forced
      ? { label: 'No force RLS', icon: <ShieldOff />, disabled: readOnly, onSelect: run('noforce') }
      : {
          label: 'Force RLS (owner too)',
          icon: <ShieldAlert />,
          disabled: readOnly,
          onSelect: run('force')
        }
  ]
}

/** The table context menu's Row-level security submenu; empty where RLS doesn't apply. */
export function rlsMenuItems(connectionId: string, database: string, obj: DbObject): MenuItem[] {
  if (!hasRls(getConnection(connectionId), obj.kind)) return []
  return [
    {
      label: 'Row-level security',
      icon: <ShieldPlus />,
      submenu: rlsActionItems(connectionId, database, obj, cachedFlags(connectionId, database, obj))
    }
  ]
}

export function scriptPolicy(
  connectionId: string,
  database: string,
  table: TableRef,
  policy: PolicyState,
  kind: 'create' | 'drop'
): void {
  const statement =
    kind === 'create'
      ? createPolicyStatement(table, policy)
      : dropPolicyStatement(table, policy.name)
  newQueryTab(connectionId, database, `${statement};`)
}

/** A policy row's context menu. */
export function policyMenuItems(
  connectionId: string,
  database: string,
  table: TableRef,
  policy: PolicyState
): MenuItem[] {
  const readOnly = !!getConnection(connectionId)?.readOnly
  return [
    { heading: policy.name },
    {
      label: 'Edit policy…',
      icon: <Pencil />,
      onSelect: () =>
        openPolicyDesigner(connectionId, database, table.schema, table.name, policy.name)
    },
    {
      label: 'Script as',
      icon: <FileCode2 />,
      submenu: [
        {
          label: 'CREATE',
          onSelect: () => scriptPolicy(connectionId, database, table, policy, 'create')
        },
        {
          label: 'DROP',
          onSelect: () => scriptPolicy(connectionId, database, table, policy, 'drop')
        }
      ]
    },
    'separator',
    {
      label: 'Drop policy…',
      icon: <Trash2 />,
      danger: true,
      disabled: readOnly,
      onSelect: () =>
        openPolicyDesigner(connectionId, database, table.schema, table.name, policy.name, true)
    }
  ]
}

/** One query per database feeds every table's badge. */
export function useRlsFlags(
  connection: ConnectionConfig,
  database: string,
  obj: { schema: string | null; name: string; kind: string }
): RlsFlags | null {
  const enabled = hasRls(connection, obj.kind)
  const q = useQuery({ ...rlsQueries.tables(connection.id, database), enabled })
  if (!enabled) return null
  return q.data?.get(`${obj.schema ?? 'public'}.${obj.name}`) ?? null
}

/** A small shield beside a table that has row-level security on. */
export function RlsBadge({
  connection,
  database,
  obj
}: {
  connection: ConnectionConfig
  database: string
  obj: DbObject
}): React.JSX.Element | null {
  const flags = useRlsFlags(connection, database, obj)
  if (!flags || rlsLabel(flags) === 'off') return null
  const forced = rlsLabel(flags) === 'forced'
  return (
    <span
      className="ml-1 inline-flex align-[-2px]"
      title={forced ? 'Row-level security: forced' : 'Row-level security: on'}
    >
      <ShieldCheck className={forced ? 'size-3 text-warn' : 'size-3 text-faint'} />
    </span>
  )
}
