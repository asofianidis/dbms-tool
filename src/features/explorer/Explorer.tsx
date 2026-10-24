import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ChevronRight,
  CornerDownLeft,
  Play,
  ChevronsDownUp,
  Code2,
  Columns3,
  ArchiveRestore,
  Copy,
  Database,
  DatabaseBackup,
  Eye,
  FileInput,
  FileOutput,
  FileUp,
  Folder,
  FolderOpen,
  FunctionSquare,
  KeyRound,
  Layers,
  LayoutDashboard,
  Leaf,
  Link2,
  ListOrdered,
  Lock,
  Network,
  Pencil,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Sprout,
  Server,
  ShieldCheck,
  Table2,
  Terminal,
  Trash2,
  Unplug,
  X,
  Zap,
  GitCompareArrows
} from 'lucide-react'
import type { ConnectionConfig, DbObject, ObjectKind } from '@/lib/api'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ENGINES, connectionLabel, connectionSubtitle, supports } from '@/lib/engines'
import { compactCount, formatBytes } from '@/lib/format'
import { shellCollection } from '@/lib/mongo-shell'
import { queries, queryClient } from '@/lib/queries'
import { settingsStore } from '@/lib/settings'
import { createPersistentStore } from '@/lib/store'
import { canHaveTriggers } from '@/lib/triggers'
import { toast, toastError, errorMessage } from '@/lib/toast'
import {
  confirm,
  connect,
  connectionsStore,
  disconnect,
  loadConnections,
  newQueryTab,
  openCollection,
  openConnectionDialog,
  openBackup,
  openCompare,
  openDiagram,
  openImport,
  openServer,
  openTable,
  refreshConnection,
  statusStore
} from '@/lib/workspace'
import { showContextMenu, showMenuAt, type MenuItem } from '@/components/ContextMenu'
import { exportConnectionsToFile, openImportConnections } from '../connections/ImportConnections'
import { Button, EngineMark, Spinner } from '@/components/ui'
import { collectionMenu, dropDatabase, newRoutine, objectMenu } from './actions'
import { openCreateCollection } from '../mongo/CreateCollectionDialog'
import { openExecuteRoutine } from './ExecuteRoutineDialog'
import { openSeed } from '../seed/SeedDialog'
import { newDashboard } from '../dashboard/actions'
import { openTableDesigner } from '../table/TableDesigner'
import { openTriggerDesigner } from '../table/TriggerDesigner'
import { openPermissionsDesigner } from './PermissionsDesigner'
import { openSchemaDesigner } from './SchemaDesigner'

const expandedStore = createPersistentStore<Record<string, boolean>>('dbms.tree.v1', {})

function useExpanded(id: string, defaultOpen = false): [boolean, (open?: boolean) => void] {
  const expanded = expandedStore.use()
  const open = expanded[id] ?? defaultOpen
  return [open, (next) => expandedStore.set((e) => ({ ...e, [id]: next ?? !open }))]
}

const FilterContext = createContext('')

const selectedStore = createPersistentStore<{ id: string | null }>('dbms.tree.selected.v1', {
  id: null
})

function Row({
  id,
  depth,
  icon,
  label,
  detail,
  expandable,
  open,
  onToggle,
  onOpen,
  onMenu,
  actions,
  loading,
  muted,
  title
}: {
  id: string
  depth: number
  icon: ReactNode
  label: ReactNode
  detail?: ReactNode
  expandable?: boolean
  open?: boolean
  onToggle?: () => void
  onOpen?: () => void
  onMenu?: (e: React.MouseEvent) => void
  actions?: ReactNode
  loading?: boolean
  muted?: boolean
  title?: string
}): React.JSX.Element {
  const { id: selected } = selectedStore.use()
  const isSelected = selected === id
  return (
    <div
      role="treeitem"
      aria-expanded={expandable ? open : undefined}
      title={title}
      tabIndex={-1}
      onMouseDown={(e) => {
        if (e.button === 0) selectedStore.set({ id })
      }}
      onClick={() => {
        if (expandable) onToggle?.()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onOpen?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (onOpen ?? onToggle)?.()
      }}
      onContextMenu={(e) => {
        selectedStore.set({ id })
        onMenu?.(e)
      }}
      className={cn(
        'group flex h-[26px] cursor-default items-center gap-1.5 pr-1.5 text-[12.5px] whitespace-nowrap',
        isSelected ? 'bg-sel text-bright' : 'text-fg hover:bg-hover/70',
        muted && !isSelected && 'text-muted'
      )}
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-faint">
        {loading ? (
          <Spinner className="size-3" />
        ) : expandable ? (
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        ) : null}
      </span>
      <span className="flex shrink-0 items-center [&>svg]:size-3.5">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      {detail && <span className="ml-1 min-w-0 truncate text-[11px] text-faint">{detail}</span>}
      {actions && (
        <span
          className="ml-auto flex shrink-0 items-center opacity-0 group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          {actions}
        </span>
      )}
    </div>
  )
}

function ErrorRow({
  depth,
  error,
  onRetry
}: {
  depth: number
  error: unknown
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div
      className="flex items-start gap-2 py-1 pr-2 text-[11.5px] text-danger"
      style={{ paddingLeft: 26 + depth * 14 }}
    >
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap select-text">
        {errorMessage(error)}
      </span>
      <button className="shrink-0 text-muted underline hover:text-bright" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

function EmptyRow({ depth, children }: { depth: number; children: ReactNode }): React.JSX.Element {
  return (
    <div className="py-1 text-[11.5px] text-faint italic" style={{ paddingLeft: 26 + depth * 14 }}>
      {children}
    </div>
  )
}

function matches(filter: string, ...values: (string | null | undefined)[]): boolean {
  if (!filter) return true
  const f = filter.toLowerCase()
  return values.some((v) => v?.toLowerCase().includes(f))
}

/* ---------- Connections ---------- */

function ConnectionNode({ connection }: { connection: ConnectionConfig }): React.JSX.Element {
  const id = `c:${connection.id}`
  const [open, setOpen] = useExpanded(id)
  const status = statusStore.use()[connection.id] ?? { state: 'idle' as const }
  const connected = status.state === 'connected'

  const toggle = async (): Promise<void> => {
    // The expanded flag persists across restarts, so only collapse when actually showing children
    if (open && connected) return setOpen(false)
    if (await connect(connection.id)) setOpen(true)
  }

  const menu = (e: React.MouseEvent): void => {
    const items: MenuItem[] = [
      { heading: connectionLabel(connection) },
      connected
        ? { label: 'Disconnect', icon: <Unplug />, onSelect: () => void disconnect(connection.id) }
        : { label: 'Connect', icon: <PlugZap />, onSelect: () => void toggle() },
      {
        label: connection.engine === 'mongo' ? 'New shell' : 'New query',
        icon: <Terminal />,
        shortcut: 'Ctrl+N',
        onSelect: () => newQueryTab(connection.id)
      },
      {
        label: 'Server info',
        icon: <Server />,
        disabled: !connected,
        onSelect: () => openServer(connection.id)
      },
      ...(connection.engine !== 'babelfish' && supports(connection.engine, 'databases')
        ? [
            {
              label: 'Restore backup…',
              icon: <ArchiveRestore />,
              disabled: !connected || connection.readOnly,
              onSelect: () => openBackup(connection.id, '', 'restore')
            }
          ]
        : []),
      ...(connection.engine === 'mysql'
        ? [
            {
              label: 'New database…',
              icon: <Plus />,
              disabled: !connected,
              onSelect: () => openSchemaDesigner(connection.id, '')
            },
            {
              label: 'Permissions…',
              icon: <ShieldCheck />,
              disabled: !connected,
              onSelect: () => openPermissionsDesigner(connection.id, '')
            }
          ]
        : []),
      // Babelfish's T-SQL lacks the columnstore and identity reseeding the SQL Server DDL uses;
      // D1 enforces foreign keys during the load
      ...(connection.engine !== 'babelfish' && connection.cloud?.provider !== 'cloudflare'
        ? [
            {
              label: 'Seed sample database…',
              icon: <Sprout />,
              disabled: !connected || connection.readOnly,
              onSelect: () => openSeed(connection.id)
            }
          ]
        : []),
      {
        label: 'Refresh',
        icon: <RefreshCw />,
        disabled: !connected,
        onSelect: () => refreshConnection(connection.id)
      },
      'separator',
      {
        label: 'Edit connection…',
        icon: <Pencil />,
        onSelect: () => openConnectionDialog(connection)
      },
      {
        label: 'Duplicate',
        icon: <Copy />,
        onSelect: () => openConnectionDialog(connection, true)
      },
      {
        label: 'Delete',
        icon: <Trash2 />,
        danger: true,
        onSelect: async () => {
          const ok = await confirm({
            title: `Delete ${connectionLabel(connection)}?`,
            message:
              'The saved connection and its stored password are removed. Nothing on the server changes.',
            confirmLabel: 'Delete connection',
            danger: true
          })
          if (!ok) return
          try {
            await api.connectionDelete(connection.id)
            await loadConnections()
          } catch (err) {
            toastError(err)
          }
        }
      }
    ]
    showContextMenu(e, items)
  }

  return (
    <div role="group">
      <Row
        id={id}
        depth={0}
        open={open && connected}
        expandable
        onToggle={() => void toggle()}
        onOpen={() => void toggle()}
        onMenu={menu}
        loading={status.state === 'connecting'}
        title={`${ENGINES[connection.engine].label} · ${connectionSubtitle(connection)}${status.state === 'error' ? `\n${status.error}` : ''}`}
        icon={
          <span className="relative">
            <EngineMark engine={connection.engine} size="sm" />
            <span
              className={cn(
                'absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-panel',
                connected ? 'bg-ok' : status.state === 'error' ? 'bg-danger' : 'hidden'
              )}
            />
          </span>
        }
        label={
          <span className="flex items-center gap-1.5">
            {connection.color && (
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: connection.color }}
              />
            )}
            <span className={cn('truncate', connected && 'text-bright')}>
              {connectionLabel(connection)}
            </span>
            {connection.readOnly && <Lock className="size-3 shrink-0 text-warn" />}
            {connection.production && (
              <span
                className="shrink-0 rounded-sm bg-danger/15 px-1 text-[9.5px] font-semibold tracking-wider text-danger uppercase"
                title="Production: writes ask for confirmation"
              >
                prod
              </span>
            )}
          </span>
        }
        detail={
          status.state === 'connected'
            ? status.info.product
            : status.state === 'error'
              ? 'error'
              : undefined
        }
        actions={
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              title={connection.engine === 'mongo' ? 'New shell' : 'New query'}
              onClick={() => newQueryTab(connection.id)}
            >
              <Terminal className="size-3.5" />
            </Button>
            {connected ? (
              <Button
                size="icon-sm"
                variant="ghost"
                title="Disconnect"
                onClick={() => void disconnect(connection.id)}
              >
                <Unplug className="size-3.5" />
              </Button>
            ) : (
              <Button size="icon-sm" variant="ghost" title="Connect" onClick={() => void toggle()}>
                <Plug className="size-3.5" />
              </Button>
            )}
          </>
        }
      />
      {open && connected && <DatabaseList connection={connection} />}
    </div>
  )
}

function DatabaseList({ connection }: { connection: ConnectionConfig }): React.JSX.Element {
  const { showSystemObjects } = settingsStore.use()
  const q = useQuery(queries.databases(connection.id))
  const [systemOpen, setSystemOpen] = useExpanded(`c:${connection.id}/system`)
  if (q.isPending) return <EmptyRow depth={1}>Loading…</EmptyRow>
  if (q.isError) return <ErrorRow depth={1} error={q.error} onRetry={() => void q.refetch()} />
  const user = q.data.filter((d) => showSystemObjects || !d.isSystem)
  const system = showSystemObjects ? [] : q.data.filter((d) => d.isSystem)
  return (
    <>
      {user.map((db) => (
        <DatabaseNode
          key={db.name}
          connection={connection}
          database={db.name}
          depth={1}
          size={db.sizeBytes}
        />
      ))}
      {system.length > 0 && (
        <>
          <Row
            id={`c:${connection.id}/system`}
            depth={1}
            expandable
            open={systemOpen}
            onToggle={() => setSystemOpen()}
            muted
            icon={
              systemOpen ? <FolderOpen className="text-faint" /> : <Folder className="text-faint" />
            }
            label="System databases"
            detail={system.length}
          />
          {systemOpen &&
            system.map((db) => (
              <DatabaseNode
                key={db.name}
                connection={connection}
                database={db.name}
                depth={2}
                size={db.sizeBytes}
              />
            ))}
        </>
      )}
      {!q.data.length && <EmptyRow depth={1}>No databases visible to this user</EmptyRow>}
    </>
  )
}

function DatabaseNode({
  connection,
  database,
  depth,
  size
}: {
  connection: ConnectionConfig
  database: string
  depth: number
  size: number | null
}): React.JSX.Element {
  const id = `c:${connection.id}/d:${database}`
  const [open, setOpen] = useExpanded(id)
  const isMongo = connection.engine === 'mongo'

  const menu = (e: React.MouseEvent): void => {
    const items: MenuItem[] = [
      { heading: database },
      {
        label: isMongo ? 'New shell here' : 'New query here',
        icon: <Terminal />,
        onSelect: () => newQueryTab(connection.id, database)
      },
      {
        label: 'New dashboard…',
        icon: <LayoutDashboard />,
        onSelect: () => void newDashboard(connection.id, database)
      },
      {
        label: 'Import data…',
        icon: <FileUp />,
        disabled: connection.readOnly,
        onSelect: () => openImport(connection.id, database, null)
      },
      {
        label: 'Refresh',
        icon: <RefreshCw />,
        onSelect: () => {
          void queryClient.invalidateQueries({
            queryKey: ['conn', connection.id, 'objects', database]
          })
          void queryClient.invalidateQueries({
            queryKey: ['conn', connection.id, 'schemas', database]
          })
        }
      }
    ]
    if (connection.engine !== 'babelfish' && supports(connection.engine, 'databases')) {
      items.push(
        'separator',
        {
          label: 'Back up…',
          icon: <DatabaseBackup />,
          onSelect: () => openBackup(connection.id, database, 'backup')
        },
        {
          label: 'Restore into…',
          icon: <ArchiveRestore />,
          disabled: connection.readOnly,
          onSelect: () => openBackup(connection.id, database, 'restore')
        }
      )
    }
    if (isMongo) {
      items.push(
        'separator',
        {
          label: 'Create collection…',
          icon: <Plus />,
          disabled: connection.readOnly,
          onSelect: () => openCreateCollection({ connectionId: connection.id, database })
        },
        {
          label: 'Create view…',
          icon: <Eye />,
          disabled: connection.readOnly,
          onSelect: () =>
            openCreateCollection({ connectionId: connection.id, database, kind: 'view' })
        },
        {
          label: 'Drop database',
          icon: <Trash2 />,
          danger: true,
          onSelect: () => void dropDatabase(connection.id, database)
        }
      )
    } else if (connection.engine === 'mysql') {
      // MySQL schemas are databases
      items.push(
        {
          label: 'Open diagram',
          icon: <Network />,
          onSelect: () => openDiagram(connection.id, database, null)
        },
        'separator',
        {
          label: 'Edit database…',
          icon: <Pencil />,
          onSelect: () => openSchemaDesigner(connection.id, database, database)
        },
        {
          label: 'Drop database…',
          icon: <Trash2 />,
          danger: true,
          onSelect: () => openSchemaDesigner(connection.id, database, database, true)
        }
      )
    } else if (connection.engine === 'sqlite') {
      items.push({
        label: 'Open diagram',
        icon: <Network />,
        onSelect: () => openDiagram(connection.id, database, null)
      })
    } else {
      // SQL Server schemas aren't tree nodes, so its diagram spans the database
      if (connection.engine !== 'postgres') {
        items.push({
          label: 'Open diagram',
          icon: <Network />,
          onSelect: () => openDiagram(connection.id, database, null)
        })
      }
      items.push('separator', {
        label: 'New schema…',
        icon: <Plus />,
        onSelect: () => openSchemaDesigner(connection.id, database)
      })
      // SQL Server schemas aren't tree nodes; the dialog picks which one to edit
      if (connection.engine !== 'postgres') {
        items.push({
          label: 'Edit schemas…',
          icon: <Layers />,
          onSelect: () => openSchemaDesigner(connection.id, database, 'dbo')
        })
      }
    }
    if (!isMongo) {
      if (supports(connection.engine, 'permissions'))
        items.push({
          label: 'Permissions…',
          icon: <ShieldCheck />,
          onSelect: () => openPermissionsDesigner(connection.id, database)
        })
      items.push({
        label: 'Compare with…',
        icon: <GitCompareArrows />,
        onSelect: () => openCompare(connection.id, database, null)
      })
    }
    showContextMenu(e, items)
  }

  return (
    <>
      <Row
        id={id}
        depth={depth}
        expandable
        open={open}
        onToggle={() => setOpen()}
        onOpen={() => newQueryTab(connection.id, database)}
        onMenu={menu}
        icon={<Database className="text-info" />}
        label={database}
        detail={size ? formatBytes(size) : undefined}
      />
      {open &&
        (isMongo ? (
          <CollectionList connection={connection} database={database} depth={depth + 1} />
        ) : connection.engine === 'postgres' ? (
          <SchemaList connection={connection} database={database} depth={depth + 1} />
        ) : (
          <ObjectFolders
            connection={connection}
            database={database}
            schema={null}
            depth={depth + 1}
          />
        ))}
    </>
  )
}

function SchemaList({
  connection,
  database,
  depth
}: {
  connection: ConnectionConfig
  database: string
  depth: number
}): React.JSX.Element {
  const { showSystemObjects } = settingsStore.use()
  const q = useQuery(queries.schemas(connection.id, database))
  if (q.isPending) return <EmptyRow depth={depth}>Loading…</EmptyRow>
  if (q.isError) return <ErrorRow depth={depth} error={q.error} onRetry={() => void q.refetch()} />
  const schemas = q.data.filter((s) => showSystemObjects || !s.isSystem)
  return (
    <>
      {schemas.map((s) => (
        <SchemaNode
          key={s.name}
          connection={connection}
          database={database}
          schema={s.name}
          depth={depth}
          system={s.isSystem}
        />
      ))}
    </>
  )
}

function SchemaNode({
  connection,
  database,
  schema,
  depth,
  system
}: {
  connection: ConnectionConfig
  database: string
  schema: string
  depth: number
  system: boolean
}): React.JSX.Element {
  const id = `c:${connection.id}/d:${database}/s:${schema}`
  const [open, setOpen] = useExpanded(id, schema === 'public')
  return (
    <>
      <Row
        id={id}
        depth={depth}
        expandable
        open={open}
        onToggle={() => setOpen()}
        muted={system}
        onMenu={(e) =>
          showContextMenu(e, [
            { heading: schema },
            {
              label: 'New query here',
              icon: <Terminal />,
              onSelect: () =>
                newQueryTab(connection.id, database, `SET search_path TO ${schema};\n\n`)
            },
            {
              label: 'Open diagram',
              icon: <Network />,
              onSelect: () => openDiagram(connection.id, database, schema)
            },
            {
              label: 'Compare with…',
              icon: <GitCompareArrows />,
              onSelect: () => openCompare(connection.id, database, schema)
            },
            {
              label: 'Import data…',
              icon: <FileUp />,
              disabled: connection.readOnly,
              onSelect: () => openImport(connection.id, database, schema)
            },
            {
              label: 'Edit schema…',
              icon: <Pencil />,
              onSelect: () => openSchemaDesigner(connection.id, database, schema)
            },
            {
              label: 'Drop schema…',
              icon: <Trash2 />,
              danger: true,
              onSelect: () => openSchemaDesigner(connection.id, database, schema, true)
            },
            {
              label: 'Permissions…',
              icon: <ShieldCheck />,
              onSelect: () =>
                openPermissionsDesigner(connection.id, database, {
                  kind: 'schema',
                  schema,
                  name: null,
                  args: null
                })
            },
            {
              label: 'Refresh',
              icon: <RefreshCw />,
              onSelect: () =>
                void queryClient.invalidateQueries({
                  queryKey: ['conn', connection.id, 'objects', database, schema]
                })
            }
          ])
        }
        icon={<Layers className="text-syn-keyword" />}
        label={schema}
      />
      {open && (
        <ObjectFolders
          connection={connection}
          database={database}
          schema={schema}
          depth={depth + 1}
        />
      )}
    </>
  )
}

const FOLDERS: {
  kinds: ObjectKind[]
  label: string
  always?: boolean
  routine?: 'procedure' | 'function'
  newTable?: boolean
}[] = [
  { kinds: ['table', 'foreign_table'], label: 'Tables', always: true, newTable: true },
  { kinds: ['view'], label: 'Views', always: true },
  { kinds: ['materialized_view'], label: 'Materialized views' },
  { kinds: ['procedure'], label: 'Procedures', always: true, routine: 'procedure' },
  { kinds: ['function'], label: 'Functions', always: true, routine: 'function' },
  { kinds: ['sequence'], label: 'Sequences' },
  { kinds: ['synonym'], label: 'Synonyms' }
]

function ObjectFolders({
  connection,
  database,
  schema,
  depth
}: {
  connection: ConnectionConfig
  database: string
  schema: string | null
  depth: number
}): React.JSX.Element {
  const q = useQuery(queries.objects(connection.id, database, schema))
  if (q.isPending) return <EmptyRow depth={depth}>Loading…</EmptyRow>
  if (q.isError) return <ErrorRow depth={depth} error={q.error} onRetry={() => void q.refetch()} />
  return (
    <>
      {FOLDERS.map((folder) => {
        const objects = q.data.filter((o) => folder.kinds.includes(o.kind))
        if (!objects.length && !folder.always) return null
        if (folder.routine && !supports(connection.engine, 'routines')) return null
        const tsql = connection.engine === 'mssql' || connection.engine === 'babelfish'
        return (
          <ObjectFolder
            key={folder.label}
            id={`c:${connection.id}/d:${database}/s:${schema ?? ''}/f:${folder.label}`}
            connection={connection}
            database={database}
            schema={schema}
            label={tsql && folder.routine === 'procedure' ? 'Stored procedures' : folder.label}
            routine={folder.routine}
            newTable={folder.newTable}
            objects={objects}
            depth={depth}
          />
        )
      })}
    </>
  )
}

function ObjectFolder({
  id,
  connection,
  database,
  schema,
  label,
  routine,
  newTable,
  objects,
  depth
}: {
  id: string
  connection: ConnectionConfig
  database: string
  schema: string | null
  label: string
  routine?: 'procedure' | 'function'
  newTable?: boolean
  objects: DbObject[]
  depth: number
}): React.JSX.Element {
  const filter = useContext(FilterContext)
  const [open, setOpen] = useExpanded(id, label === 'Tables')
  const visible = objects.filter((o) => matches(filter, o.name, o.schema))
  // A tree filter opens folders that have matches
  const isOpen = open || (!!filter && visible.length > 0)
  return (
    <>
      <Row
        id={id}
        depth={depth}
        expandable
        open={isOpen}
        onToggle={() => setOpen(!isOpen)}
        muted
        icon={isOpen ? <FolderOpen className="text-faint" /> : <Folder className="text-faint" />}
        label={label}
        detail={filter ? `${visible.length}/${objects.length}` : objects.length}
        onMenu={(e) =>
          showContextMenu(e, [
            { heading: label },
            ...(routine
              ? [
                  {
                    label: routine === 'procedure' ? 'New procedure' : 'New function',
                    icon: <Plus />,
                    onSelect: () => newRoutine(connection.id, database, schema, routine)
                  }
                ]
              : []),
            ...(newTable && supports(connection.engine, 'designers')
              ? [
                  {
                    label: 'New table…',
                    icon: <Plus />,
                    onSelect: () => openTableDesigner(connection.id, database, schema)
                  }
                ]
              : []),
            {
              label: 'Refresh',
              icon: <RefreshCw />,
              onSelect: () =>
                void queryClient.invalidateQueries({
                  queryKey: ['conn', connection.id, 'objects', database]
                })
            }
          ])
        }
        actions={
          routine ? (
            <Button
              size="icon-sm"
              variant="ghost"
              title={routine === 'procedure' ? 'New procedure' : 'New function'}
              onClick={() => newRoutine(connection.id, database, schema, routine)}
            >
              <Plus className="size-3.5" />
            </Button>
          ) : (
            newTable && (
              <Button
                size="icon-sm"
                variant="ghost"
                title="New table"
                onClick={() => openTableDesigner(connection.id, database, schema)}
              >
                <Plus className="size-3.5" />
              </Button>
            )
          )
        }
      />
      {isOpen &&
        visible.map((obj) => (
          <ObjectNode
            key={`${obj.schema}.${obj.name}.${obj.detail ?? ''}`}
            connection={connection}
            database={database}
            obj={obj}
            depth={depth + 1}
          />
        ))}
      {isOpen && !objects.length && <EmptyRow depth={depth + 1}>None</EmptyRow>}
    </>
  )
}

function objectIcon(kind: ObjectKind): ReactNode {
  switch (kind) {
    case 'view':
    case 'materialized_view':
      return <Eye className="text-syn-type" />
    case 'function':
    case 'procedure':
      return <FunctionSquare className="text-syn-fn" />
    case 'sequence':
      return <ListOrdered className="text-syn-number" />
    case 'synonym':
      return <Link2 className="text-muted" />
    default:
      return <Table2 className="text-syn-prop" />
  }
}

function ObjectNode({
  connection,
  database,
  obj,
  depth
}: {
  connection: ConnectionConfig
  database: string
  obj: DbObject
  depth: number
}): React.JSX.Element {
  const id = `c:${connection.id}/d:${database}/o:${obj.schema ?? ''}.${obj.name}(${obj.detail ?? ''})`
  const [open, setOpen] = useExpanded(id)
  const browsable = ['table', 'view', 'materialized_view', 'foreign_table'].includes(obj.kind)
  const isRoutine = obj.kind === 'procedure' || obj.kind === 'function'
  const showSchema =
    (connection.engine === 'mssql' || connection.engine === 'babelfish') && obj.schema
  return (
    <>
      <Row
        id={id}
        depth={depth}
        expandable={browsable || isRoutine}
        open={open}
        onToggle={() => setOpen()}
        onOpen={() =>
          openTable(
            connection.id,
            database,
            obj.schema,
            obj.name,
            obj.kind,
            browsable ? 'data' : 'definition',
            obj.detail
          )
        }
        onMenu={(e) => showContextMenu(e, objectMenu(connection.id, database, obj))}
        icon={objectIcon(obj.kind)}
        title={
          [obj.comment, obj.detail && `(${obj.detail})`].filter(Boolean).join('\n') || undefined
        }
        label={
          <>
            {showSchema && <span className="text-muted">{obj.schema}.</span>}
            {obj.name}
            {(obj.kind === 'function' || obj.kind === 'procedure') &&
              connection.engine === 'postgres' && (
                <span className="text-faint">({obj.detail})</span>
              )}
          </>
        }
        detail={
          obj.rowEstimate != null && obj.rowEstimate >= 0
            ? compactCount(obj.rowEstimate)
            : undefined
        }
        actions={
          isRoutine && (
            <Button
              size="icon-sm"
              variant="ghost"
              title="Execute…"
              onClick={() => openExecuteRoutine(connection.id, database, obj)}
            >
              <Play className="size-3.5" />
            </Button>
          )
        }
      />
      {open && browsable && (
        <TableChildren connection={connection} database={database} obj={obj} depth={depth + 1} />
      )}
      {open && isRoutine && (
        <RoutineChildren connection={connection} database={database} obj={obj} depth={depth + 1} />
      )}
    </>
  )
}

function TableChildren({
  connection,
  database,
  obj,
  depth
}: {
  connection: ConnectionConfig
  database: string
  obj: DbObject
  depth: number
}): React.JSX.Element {
  const base = `c:${connection.id}/d:${database}/o:${obj.schema ?? ''}.${obj.name}`
  const q = useQuery(queries.table(connection.id, database, obj.schema, obj.name))
  const [indexesOpen, setIndexesOpen] = useExpanded(`${base}/indexes`)
  const [keysOpen, setKeysOpen] = useExpanded(`${base}/keys`)
  const [triggersOpen, setTriggersOpen] = useExpanded(`${base}/triggers`)
  const editTriggers =
    supports(connection.engine, 'designers') &&
    canHaveTriggers(ENGINES[connection.engine].dialect ?? 'postgres', obj.kind)
  const designTrigger = (trigger: string | null, drop = false): void =>
    openTriggerDesigner(
      connection.id,
      database,
      obj.schema,
      obj.name,
      obj.kind === 'view',
      trigger,
      drop
    )
  if (q.isPending) return <EmptyRow depth={depth}>Loading…</EmptyRow>
  if (q.isError) return <ErrorRow depth={depth} error={q.error} onRetry={() => void q.refetch()} />
  const info = q.data
  return (
    <>
      {info.columns.map((col) => (
        <Row
          key={col.name}
          id={`${base}/col:${col.name}`}
          depth={depth}
          icon={
            col.isPrimaryKey ? (
              <KeyRound className="text-warn" />
            ) : (
              <Columns3 className="text-faint" />
            )
          }
          label={col.name}
          title={[
            col.dataType,
            col.nullable ? 'NULL' : 'NOT NULL',
            col.default && `DEFAULT ${col.default}`,
            col.comment
          ]
            .filter(Boolean)
            .join(' · ')}
          detail={
            <span className="font-mono">
              {col.dataType}
              {!col.nullable && !col.isPrimaryKey && (
                <span className="text-faint/70"> not null</span>
              )}
            </span>
          }
          onMenu={(e) =>
            showContextMenu(e, [
              {
                label: 'Copy column name',
                icon: <Copy />,
                onSelect: () =>
                  void navigator.clipboard.writeText(col.name).then(() => toast('Copied'))
              }
            ])
          }
        />
      ))}
      {info.indexes.length > 0 && (
        <>
          <Row
            id={`${base}/indexes`}
            depth={depth}
            expandable
            open={indexesOpen}
            onToggle={() => setIndexesOpen()}
            muted
            icon={<ListOrdered className="text-faint" />}
            label="Indexes"
            detail={info.indexes.length}
          />
          {indexesOpen &&
            info.indexes.map((ix) => (
              <Row
                key={ix.name}
                id={`${base}/ix:${ix.name}`}
                depth={depth + 1}
                icon={
                  ix.primary ? (
                    <KeyRound className="text-warn" />
                  ) : (
                    <ListOrdered className={ix.unique ? 'text-info' : 'text-faint'} />
                  )
                }
                label={ix.name}
                title={ix.definition ?? undefined}
                detail={`(${ix.columns.join(', ')})${ix.unique && !ix.primary ? ' unique' : ''}`}
              />
            ))}
        </>
      )}
      {info.foreignKeys.length > 0 && (
        <>
          <Row
            id={`${base}/keys`}
            depth={depth}
            expandable
            open={keysOpen}
            onToggle={() => setKeysOpen()}
            muted
            icon={<Link2 className="text-faint" />}
            label="Foreign keys"
            detail={info.foreignKeys.length}
          />
          {keysOpen &&
            info.foreignKeys.map((fk) => (
              <Row
                key={fk.name}
                id={`${base}/fk:${fk.name}`}
                depth={depth + 1}
                icon={<Link2 className="text-syn-fn" />}
                label={fk.name}
                detail={`${fk.columns.join(', ')} → ${fk.refTable}(${fk.refColumns.join(', ')})`}
                onOpen={() =>
                  openTable(connection.id, database, fk.refSchema, fk.refTable, 'table')
                }
              />
            ))}
        </>
      )}
      {info.triggers.length > 0 && (
        <>
          <Row
            id={`${base}/triggers`}
            depth={depth}
            expandable
            open={triggersOpen}
            onToggle={() => setTriggersOpen()}
            muted
            icon={<Zap className="text-faint" />}
            label="Triggers"
            detail={info.triggers.length}
            onMenu={
              editTriggers
                ? (e) =>
                    showContextMenu(e, [
                      { label: 'New trigger…', icon: <Plus />, onSelect: () => designTrigger(null) }
                    ])
                : undefined
            }
          />
          {triggersOpen &&
            info.triggers.map((t) => (
              <Row
                key={t.name}
                id={`${base}/tr:${t.name}`}
                depth={depth + 1}
                icon={<Zap className={t.enabled ? 'text-syn-fn' : 'text-faint'} />}
                label={t.name}
                title={t.definition ?? undefined}
                detail={`${t.timing} ${t.events.join(' OR ')}`.toLowerCase()}
                onOpen={
                  editTriggers
                    ? () => designTrigger(t.name)
                    : t.definition
                      ? () => newQueryTab(connection.id, database, t.definition ?? '')
                      : undefined
                }
                onMenu={(e) =>
                  showContextMenu(e, [
                    { heading: t.name },
                    ...(editTriggers
                      ? [
                          {
                            label: 'Edit trigger…',
                            icon: <Pencil />,
                            onSelect: () => designTrigger(t.name)
                          }
                        ]
                      : []),
                    ...(t.definition
                      ? [
                          {
                            label: 'Open definition in editor',
                            icon: <Code2 />,
                            onSelect: () => newQueryTab(connection.id, database, t.definition ?? '')
                          }
                        ]
                      : []),
                    ...(editTriggers
                      ? [
                          'separator' as const,
                          {
                            label: 'Drop trigger…',
                            icon: <Trash2 />,
                            danger: true,
                            onSelect: () => designTrigger(t.name, true)
                          }
                        ]
                      : [])
                  ])
                }
              />
            ))}
        </>
      )}
    </>
  )
}

function RoutineChildren({
  connection,
  database,
  obj,
  depth
}: {
  connection: ConnectionConfig
  database: string
  obj: DbObject
  depth: number
}): React.JSX.Element {
  const base = `c:${connection.id}/d:${database}/o:${obj.schema ?? ''}.${obj.name}(${obj.detail ?? ''})`
  const q = useQuery(
    queries.routine(connection.id, database, obj.schema, obj.name, obj.kind, obj.detail)
  )
  if (q.isPending) return <EmptyRow depth={depth}>Loading…</EmptyRow>
  if (q.isError) return <ErrorRow depth={depth} error={q.error} onRetry={() => void q.refetch()} />
  const { params, returns } = q.data
  return (
    <>
      {params.map((p, i) => {
        const out = /^(OUT|OUTPUT)$/i.test(p.mode)
        const inout = /^INOUT$/i.test(p.mode)
        return (
          <Row
            key={`${p.name}:${i}`}
            id={`${base}/p:${i}`}
            depth={depth}
            icon={
              inout ? (
                <ArrowLeftRight className="text-syn-number" />
              ) : out ? (
                <ArrowLeft className="text-syn-number" />
              ) : (
                <ArrowRight className="text-faint" />
              )
            }
            label={p.name || `$${i + 1}`}
            detail={
              <span className="font-mono">
                {p.dataType}
                {p.mode !== 'IN' && <span className="text-faint/70"> {p.mode.toLowerCase()}</span>}
              </span>
            }
          />
        )
      })}
      {returns && (
        <Row
          id={`${base}/returns`}
          depth={depth}
          icon={<CornerDownLeft className="text-syn-type" />}
          label="returns"
          muted
          detail={<span className="font-mono">{returns}</span>}
        />
      )}
      {!params.length && !returns && <EmptyRow depth={depth}>No parameters</EmptyRow>}
    </>
  )
}

function CollectionList({
  connection,
  database,
  depth
}: {
  connection: ConnectionConfig
  database: string
  depth: number
}): React.JSX.Element {
  const filter = useContext(FilterContext)
  const q = useQuery(queries.objects(connection.id, database, null))
  if (q.isPending) return <EmptyRow depth={depth}>Loading…</EmptyRow>
  if (q.isError) return <ErrorRow depth={depth} error={q.error} onRetry={() => void q.refetch()} />
  const visible = q.data.filter((o) => matches(filter, o.name))
  if (!q.data.length) return <EmptyRow depth={depth}>No collections</EmptyRow>
  return (
    <>
      {visible.map((obj) => (
        <Row
          key={obj.name}
          id={`c:${connection.id}/d:${database}/col:${obj.name}`}
          depth={depth}
          icon={
            obj.kind === 'view' ? (
              <Eye className="text-syn-type" />
            ) : (
              <Leaf className="text-mongo" />
            )
          }
          label={obj.name}
          detail={
            obj.kind === 'view'
              ? `view on ${obj.detail}`
              : obj.kind === 'timeseries'
                ? 'time series'
                : undefined
          }
          onOpen={() => openCollection(connection.id, database, obj.name)}
          onMenu={(e) => showContextMenu(e, collectionMenu(connection.id, database, obj))}
          actions={
            <Button
              size="icon-sm"
              variant="ghost"
              title="New shell"
              onClick={() =>
                newQueryTab(
                  connection.id,
                  database,
                  `${shellCollection(obj.name)}.find({})\n  .limit(50)`
                )
              }
            >
              <Code2 className="size-3.5" />
            </Button>
          }
        />
      ))}
    </>
  )
}

/* ---------- Panel ---------- */

export function Explorer(): React.JSX.Element {
  const connections = connectionsStore.use()
  const [filter, setFilter] = useState('')
  const groups = useMemo(() => {
    const map = new Map<string, ConnectionConfig[]>()
    const sorted = [...connections].sort((a, b) =>
      connectionLabel(a).localeCompare(connectionLabel(b))
    )
    for (const c of sorted) {
      const key = c.group.trim()
      map.set(key, [...(map.get(key) ?? []), c])
    }
    return [...map.entries()].sort(([a], [b]) =>
      a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)
    )
  }, [connections])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between pr-1.5 pl-3">
        <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">
          Explorer
        </span>
        <div className="flex items-center">
          <Button
            size="icon-sm"
            variant="ghost"
            title="New connection"
            onClick={() => openConnectionDialog()}
          >
            <Plus className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Import or export connections"
            onClick={(e) =>
              showMenuAt(e.currentTarget, [
                {
                  label: 'Import from pgpass, DBeaver or DataGrip…',
                  icon: <FileInput />,
                  onSelect: openImportConnections
                },
                {
                  label: 'Export connections (without passwords)…',
                  icon: <FileOutput />,
                  disabled: !connections.length,
                  onSelect: () => void exportConnectionsToFile()
                }
              ])
            }
          >
            <ArrowDownUp className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Refresh all"
            onClick={() => {
              void loadConnections()
              void queryClient.invalidateQueries({ queryKey: ['conn'] })
            }}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title="Collapse all"
            onClick={() => expandedStore.set({})}
          >
            <ChevronsDownUp className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
            placeholder="Filter objects"
            spellCheck={false}
            className="h-7 w-full rounded-md border border-line bg-canvas pr-7 pl-7 text-[12px] text-bright placeholder:text-faint focus:border-accent/50 focus:outline-none"
          />
          {filter && (
            <button
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-faint hover:text-bright"
              onClick={() => setFilter('')}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <FilterContext.Provider value={filter}>
        <div role="tree" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-4">
          {groups.map(([group, list]) => (
            <ConnectionGroup key={group || '__none'} group={group} connections={list} />
          ))}
          {!connections.length && (
            <div className="space-y-3 px-4 py-6 text-center text-xs text-muted">
              <p>No connections yet.</p>
              <Button size="sm" variant="primary" onClick={() => openConnectionDialog()}>
                <Plus className="size-3.5" /> New connection
              </Button>
              <Button size="sm" variant="ghost" onClick={openImportConnections}>
                <FileInput className="size-3.5" /> Import from another client
              </Button>
            </div>
          )}
        </div>
      </FilterContext.Provider>
    </div>
  )
}

function ConnectionGroup({
  group,
  connections
}: {
  group: string
  connections: ConnectionConfig[]
}): React.JSX.Element {
  const [open, setOpen] = useExpanded(`g:${group}`, true)
  if (!group)
    return (
      <>
        {connections.map((c) => (
          <ConnectionNode key={c.id} connection={c} />
        ))}
      </>
    )
  return (
    <>
      <div
        onClick={() => setOpen()}
        className="flex h-6 cursor-default items-center gap-1 px-2 pt-1 text-[10.5px] font-semibold tracking-wider text-faint uppercase hover:text-muted"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {group}
        <span className="font-normal">{connections.length}</span>
      </div>
      {open && connections.map((c) => <ConnectionNode key={c.id} connection={c} />)}
    </>
  )
}
