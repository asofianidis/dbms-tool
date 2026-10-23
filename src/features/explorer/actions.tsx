import {
  Braces,
  ClipboardCopy,
  Code2,
  FileCode2,
  FilePlus2,
  GitCompareArrows,
  Hash,
  KeyRound,
  Leaf,
  ListTree,
  Pencil,
  Play,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Table2,
  Trash2,
  Zap
} from 'lucide-react'
import { api, type DbObject } from '@/lib/api'
import { modifyScript, routineTemplate } from '@/lib/routines'
import { ENGINES, type Dialect } from '@/lib/engines'
import { copyText } from '@/lib/export'
import { securableFor } from '@/lib/grants'
import { shellCollection } from '@/lib/mongo-shell'
import { queries, queryClient } from '@/lib/queries'
import {
  qualified,
  quoteIdent,
  scriptCreateTable,
  scriptDelete,
  scriptInsert,
  scriptSelect,
  scriptUpdate,
  countRows,
  type TableRef
} from '@/lib/sql'
import { toast, toastError } from '@/lib/toast'
import { canHaveTriggers } from '@/lib/triggers'
import {
  confirm,
  getConnection,
  newQueryTab,
  openCollection,
  openCompare,
  openTable,
  refreshConnection
} from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'
import { openTableDesigner } from '../table/TableDesigner'
import { openTriggerDesigner } from '../table/TriggerDesigner'
import { openPermissionsDesigner } from './PermissionsDesigner'

export function tableRef(connectionId: string, database: string, obj: DbObject): TableRef {
  const connection = getConnection(connectionId)
  // MySQL qualifies by database; the others by schema
  return connection?.engine === 'mysql'
    ? { schema: database, name: obj.name }
    : { schema: obj.schema, name: obj.name }
}

function dialectOf(connectionId: string): Dialect {
  const connection = getConnection(connectionId)
  return (connection && ENGINES[connection.engine].dialect) || 'postgres'
}

async function tableInfo(connectionId: string, database: string, obj: DbObject) {
  return queryClient.fetchQuery(queries.table(connectionId, database, obj.schema, obj.name))
}

async function scriptTo(
  connectionId: string,
  database: string,
  obj: DbObject,
  kind: 'select' | 'insert' | 'update' | 'delete' | 'create' | 'drop' | 'definition' | 'exec'
): Promise<void> {
  try {
    const dialect = dialectOf(connectionId)
    const ref = tableRef(connectionId, database, obj)
    let text = ''
    if (kind === 'definition' || (kind === 'create' && obj.kind !== 'table')) {
      text =
        (await queryClient.fetchQuery(
          queries.definition(connectionId, database, obj.schema, obj.name, obj.kind, obj.detail)
        )) ?? `-- No definition available for ${obj.name}`
    } else if (kind === 'drop') {
      const what =
        obj.kind === 'materialized_view'
          ? 'MATERIALIZED VIEW'
          : obj.kind === 'foreign_table'
            ? 'FOREIGN TABLE'
            : obj.kind.toUpperCase()
      const sig =
        dialect === 'postgres' && (obj.kind === 'function' || obj.kind === 'procedure')
          ? `(${obj.detail ?? ''})`
          : ''
      text = `DROP ${what} ${qualified(dialect, ref)}${sig};`
    } else if (kind === 'exec') {
      const target = qualified(dialect, ref)
      text =
        dialect === 'tsql'
          ? obj.kind === 'procedure'
            ? `EXEC ${target};`
            : `SELECT ${target}();`
          : obj.kind === 'procedure'
            ? `CALL ${target}(${dialect === 'postgres' ? (obj.detail ?? '') : ''});`
            : `SELECT * FROM ${target}(${dialect === 'postgres' ? (obj.detail ?? '') : ''});`
    } else {
      const info = await tableInfo(connectionId, database, obj)
      text =
        kind === 'select'
          ? scriptSelect(dialect, ref, info.columns)
          : kind === 'insert'
            ? scriptInsert(dialect, ref, info.columns)
            : kind === 'update'
              ? scriptUpdate(dialect, ref, info)
              : kind === 'delete'
                ? scriptDelete(dialect, ref, info)
                : getConnection(connectionId)?.engine === 'mysql'
                  ? ((await queryClient.fetchQuery(
                      queries.definition(connectionId, database, obj.schema, obj.name, 'table')
                    )) ?? scriptCreateTable(dialect, ref, info))
                  : scriptCreateTable(dialect, ref, info)
    }
    newQueryTab(connectionId, database, text)
  } catch (e) {
    toastError(e)
  }
}

async function countTable(connectionId: string, database: string, obj: DbObject): Promise<void> {
  try {
    const dialect = dialectOf(connectionId)
    const out = await api.execute(
      connectionId,
      '__meta',
      database,
      countRows(dialect, tableRef(connectionId, database, obj))
    )
    if (out.error) throw new Error(out.error.message)
    const n = out.results[0]?.rows[0]?.[0]
    toast(`${obj.name}: ${Number(n).toLocaleString()} rows`, 'info')
  } catch (e) {
    toastError(e)
  }
}

export function objectMenu(connectionId: string, database: string, obj: DbObject): MenuItem[] {
  const isTable = obj.kind === 'table' || obj.kind === 'foreign_table'
  const isView = obj.kind === 'view' || obj.kind === 'materialized_view'
  const isRoutine = obj.kind === 'function' || obj.kind === 'procedure'
  const dialect = dialectOf(connectionId)
  const label = obj.schema ? `${obj.schema}.${obj.name}` : obj.name
  const items: MenuItem[] = [{ heading: label }]
  if (isTable || isView) {
    items.push(
      {
        label: 'Open data',
        icon: <Table2 />,
        onSelect: () => openTable(connectionId, database, obj.schema, obj.name, obj.kind, 'data')
      },
      {
        label: 'Structure',
        icon: <ListTree />,
        onSelect: () =>
          openTable(connectionId, database, obj.schema, obj.name, obj.kind, 'structure')
      },
      ...(obj.kind === 'table'
        ? [
            {
              label: 'Design table…',
              icon: <Pencil />,
              onSelect: () => openTableDesigner(connectionId, database, obj.schema, obj.name)
            },
            {
              label: 'Compare with…',
              icon: <GitCompareArrows />,
              onSelect: () => openCompare(connectionId, database, obj.schema, obj.name)
            }
          ]
        : []),
      ...(canHaveTriggers(dialect, obj.kind)
        ? [
            {
              label: 'New trigger…',
              icon: <Zap />,
              onSelect: () =>
                openTriggerDesigner(connectionId, database, obj.schema, obj.name, isView)
            }
          ]
        : []),
      {
        label: isView ? 'Definition' : 'DDL',
        icon: <ScrollText />,
        onSelect: () =>
          openTable(connectionId, database, obj.schema, obj.name, obj.kind, 'definition')
      },
      'separator',
      {
        label: 'New query: SELECT',
        icon: <FilePlus2 />,
        onSelect: () => void scriptTo(connectionId, database, obj, 'select')
      },
      {
        label: 'Script as',
        icon: <FileCode2 />,
        submenu: [
          { label: 'SELECT', onSelect: () => void scriptTo(connectionId, database, obj, 'select') },
          ...(isTable
            ? [
                {
                  label: 'INSERT',
                  onSelect: () => void scriptTo(connectionId, database, obj, 'insert')
                },
                {
                  label: 'UPDATE',
                  onSelect: () => void scriptTo(connectionId, database, obj, 'update')
                },
                {
                  label: 'DELETE',
                  onSelect: () => void scriptTo(connectionId, database, obj, 'delete')
                }
              ]
            : []),
          'separator',
          { label: 'CREATE', onSelect: () => void scriptTo(connectionId, database, obj, 'create') },
          { label: 'DROP', onSelect: () => void scriptTo(connectionId, database, obj, 'drop') }
        ]
      },
      {
        label: 'Count rows',
        icon: <Hash />,
        onSelect: () => void countTable(connectionId, database, obj)
      }
    )
  } else if (isRoutine) {
    items.push(
      {
        label: 'Execute…',
        icon: <Play />,
        onSelect: () =>
          void import('./ExecuteRoutineDialog').then((m) =>
            m.openExecuteRoutine(connectionId, database, obj)
          )
      },
      {
        label: dialect === 'tsql' ? 'Modify (ALTER)' : 'Modify',
        icon: <FileCode2 />,
        onSelect: () => void modifyRoutine(connectionId, database, obj)
      },
      'separator',
      {
        label: 'Definition',
        icon: <ScrollText />,
        onSelect: () =>
          openTable(
            connectionId,
            database,
            obj.schema,
            obj.name,
            obj.kind,
            'definition',
            obj.detail
          )
      },
      {
        label: 'Script as CREATE',
        icon: <FileCode2 />,
        onSelect: () => void scriptTo(connectionId, database, obj, 'definition')
      },
      {
        label: 'Script as DROP',
        icon: <Trash2 />,
        onSelect: () => void scriptTo(connectionId, database, obj, 'drop')
      }
    )
  } else if (obj.kind === 'sequence') {
    items.push({
      label: 'Script as CREATE',
      icon: <FileCode2 />,
      onSelect: () => void scriptTo(connectionId, database, obj, 'definition')
    })
  }
  const securable = securableFor(dialect, database, obj)
  if (securable) {
    items.push({
      label: 'Permissions…',
      icon: <ShieldCheck />,
      onSelect: () => openPermissionsDesigner(connectionId, database, securable)
    })
  }
  items.push(
    'separator',
    {
      label: 'Copy name',
      icon: <ClipboardCopy />,
      onSelect: () =>
        void copyText(qualified(dialect, tableRef(connectionId, database, obj)), 'Copied name')
    },
    {
      label: 'Refresh',
      icon: <RefreshCw />,
      onSelect: () =>
        void queryClient.invalidateQueries({
          queryKey: ['conn', connectionId, 'table', database, obj.schema, obj.name]
        })
    }
  )
  return items
}

async function modifyRoutine(connectionId: string, database: string, obj: DbObject): Promise<void> {
  try {
    const definition = await queryClient.fetchQuery(
      queries.definition(connectionId, database, obj.schema, obj.name, obj.kind, obj.detail)
    )
    if (!definition) throw new Error(`No definition available for ${obj.name}`)
    const kind = obj.kind === 'procedure' ? 'procedure' : 'function'
    newQueryTab(
      connectionId,
      database,
      modifyScript(dialectOf(connectionId), definition, tableRef(connectionId, database, obj), kind)
    )
  } catch (e) {
    toastError(e)
  }
}

/** Opens a query tab with a template for a new procedure or function. */
export function newRoutine(
  connectionId: string,
  database: string,
  schema: string | null,
  kind: 'procedure' | 'function'
): void {
  const connection = getConnection(connectionId)
  const babelfish = connection?.engine === 'babelfish'
  const target =
    connection?.engine === 'mysql'
      ? null
      : (schema ?? (dialectOf(connectionId) === 'tsql' ? 'dbo' : 'public'))
  newQueryTab(
    connectionId,
    database,
    routineTemplate(dialectOf(connectionId), kind, target, babelfish)
  )
}

export function collectionMenu(connectionId: string, database: string, obj: DbObject): MenuItem[] {
  const name = obj.name
  const shellName = shellCollection(name)
  return [
    { heading: name },
    {
      label: 'Open documents',
      icon: <Leaf />,
      onSelect: () => openCollection(connectionId, database, name, 'documents')
    },
    {
      label: 'Aggregations',
      icon: <Braces />,
      onSelect: () => openCollection(connectionId, database, name, 'aggregation')
    },
    {
      label: 'Schema',
      icon: <ListTree />,
      onSelect: () => openCollection(connectionId, database, name, 'schema')
    },
    {
      label: 'Indexes',
      icon: <KeyRound />,
      onSelect: () => openCollection(connectionId, database, name, 'indexes')
    },
    'separator',
    {
      label: 'New shell',
      icon: <Code2 />,
      onSelect: () => newQueryTab(connectionId, database, `${shellName}.find({})\n  .limit(50)`)
    },
    {
      label: 'Copy name',
      icon: <ClipboardCopy />,
      onSelect: () => void copyText(name, 'Copied name')
    },
    'separator',
    {
      label: obj.kind === 'view' ? 'Drop view' : 'Drop collection',
      icon: <Trash2 />,
      danger: true,
      onSelect: () => void dropCollection(connectionId, database, name)
    }
  ]
}

export async function dropCollection(
  connectionId: string,
  database: string,
  name: string
): Promise<void> {
  const ok = await confirm({
    title: `Drop ${name}?`,
    message: `This permanently deletes the collection "${name}" in ${database}, including all of its documents and indexes.`,
    confirmLabel: 'Drop collection',
    danger: true
  })
  if (!ok) return
  try {
    await api.mongo(connectionId, '__meta', { op: 'dropCollection', database, collection: name })
    toast(`Dropped ${name}`)
    refreshConnection(connectionId)
  } catch (e) {
    toastError(e)
  }
}

export async function createCollection(
  connectionId: string,
  database: string,
  name: string
): Promise<void> {
  try {
    await api.mongo(connectionId, '__meta', { op: 'createCollection', database, collection: name })
    toast(`Created ${name}`)
    refreshConnection(connectionId)
    openCollection(connectionId, database, name)
  } catch (e) {
    toastError(e)
  }
}

export async function dropDatabase(connectionId: string, database: string): Promise<void> {
  const ok = await confirm({
    title: `Drop database ${database}?`,
    message: `This permanently deletes ${database} and every collection in it.`,
    confirmLabel: 'Drop database',
    danger: true
  })
  if (!ok) return
  try {
    await api.mongo(connectionId, '__meta', { op: 'dropDatabase', database })
    toast(`Dropped ${database}`)
    refreshConnection(connectionId)
  } catch (e) {
    toastError(e)
  }
}

export function quoteFor(connectionId: string, name: string): string {
  return quoteIdent(dialectOf(connectionId), name)
}
