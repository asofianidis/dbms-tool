import { useQuery } from '@tanstack/react-query'
import {
  CalendarClock,
  Code2,
  Copy,
  FileCode2,
  History,
  Pause,
  Play,
  Plus,
  ScrollText,
  Server,
  Table2,
  UserRound,
  Zap
} from 'lucide-react'
import { api, type ConnectionConfig } from '@/lib/api'
import {
  createServerSql,
  createUserMappingSql,
  cronHistorySql,
  cronJobLabel,
  cronJobTemplate,
  cronJobTooltip,
  cronScheduleSql,
  cronSetActiveSql,
  cronUnscheduleSql,
  dropEventTriggerSql,
  dropServerSql,
  dropUserMappingSql,
  eventTriggerStateLabel,
  eventTriggerTemplate,
  eventTriggerTooltip,
  foreignServerTemplate,
  formatOptions,
  isEventTriggerEnabled,
  pgObjectQueries,
  setEventTriggerEnabledSql,
  userMappingTemplate,
  type CronJob,
  type EventTrigger,
  type ForeignServer,
  type UserMapping
} from '@/lib/pg-objects'
import { queryClient } from '@/lib/queries'
import { toast, toastError } from '@/lib/toast'
import { newQueryTab, openTable } from '@/lib/workspace'
import { showContextMenu, type MenuItem } from '@/components/ContextMenu'
import { CatalogFolder, EmptyRow, Row, useExpanded } from './Explorer'

/** PostgreSQL event triggers, foreign servers and pg_cron jobs, under a database. */
export function PgDatabaseFolders({
  connection,
  database,
  depth
}: {
  connection: ConnectionConfig
  database: string
  depth: number
}): React.JSX.Element {
  const cron = useQuery(pgObjectQueries.pgCron(connection.id, database))
  return (
    <>
      <EventTriggersFolder connection={connection} database={database} depth={depth} />
      <ForeignServersFolder connection={connection} database={database} depth={depth} />
      {cron.data && <CronJobsFolder connection={connection} database={database} depth={depth} />}
    </>
  )
}

const copyName = (name: string): MenuItem => ({
  label: 'Copy name',
  icon: <Copy />,
  onSelect: () => void navigator.clipboard.writeText(name).then(() => toast('Copied'))
})

const script = (connectionId: string, database: string, sql: string) => () =>
  newQueryTab(connectionId, database, sql)

/** Runs a change on the metadata session; production connections confirm it in `api.execute`. */
async function runChange(
  connectionId: string,
  database: string,
  sql: string,
  done: string,
  queryKey: readonly unknown[]
): Promise<void> {
  try {
    const out = await api.execute(connectionId, '__meta', database, sql)
    if (out.error) throw new Error(out.error.message)
    toast(done)
    void queryClient.invalidateQueries({ queryKey })
  } catch (e) {
    toastError(e)
  }
}

/* ---------- Event triggers ---------- */

function EventTriggersFolder({
  connection,
  database,
  depth
}: {
  connection: ConnectionConfig
  database: string
  depth: number
}): React.JSX.Element {
  const id = `c:${connection.id}/d:${database}/eventTriggers`
  const options = pgObjectQueries.eventTriggers(connection.id, database)
  const menu = (t: EventTrigger): MenuItem[] => {
    const enabled = isEventTriggerEnabled(t)
    return [
      { heading: t.name },
      {
        label: 'DDL',
        icon: <ScrollText />,
        onSelect: script(connection.id, database, t.definition)
      },
      {
        label: 'Script as',
        icon: <FileCode2 />,
        submenu: [
          { label: 'CREATE', onSelect: script(connection.id, database, t.definition) },
          { label: 'DROP', onSelect: script(connection.id, database, dropEventTriggerSql(t.name)) }
        ]
      },
      'separator',
      {
        label: enabled ? 'Disable' : 'Enable',
        icon: enabled ? <Pause /> : <Play />,
        disabled: connection.readOnly,
        onSelect: () =>
          void runChange(
            connection.id,
            database,
            setEventTriggerEnabledSql(t.name, !enabled),
            `${enabled ? 'Disabled' : 'Enabled'} event trigger ${t.name}`,
            options.queryKey
          )
      },
      copyName(t.name)
    ]
  }
  return (
    <CatalogFolder
      id={id}
      depth={depth}
      label="Event triggers"
      options={options}
      itemKey={(t: EventTrigger) => t.name}
      searchText={(t) => [t.name, t.event, t.function]}
      menu={[
        {
          label: 'New event trigger',
          icon: <Plus />,
          onSelect: script(connection.id, database, eventTriggerTemplate())
        }
      ]}
      render={(t) => (
        <Row
          id={`${id}/${t.name}`}
          depth={depth + 1}
          icon={<Zap className="text-syn-fn" />}
          label={t.name}
          muted={!isEventTriggerEnabled(t)}
          detail={[t.event, eventTriggerStateLabel(t), t.tags.length ? t.tags.join(', ') : null]
            .filter(Boolean)
            .join(' · ')}
          title={eventTriggerTooltip(t)}
          onOpen={script(connection.id, database, t.definition)}
          onMenu={(e) => showContextMenu(e, menu(t))}
        />
      )}
    />
  )
}

/* ---------- Foreign servers ---------- */

function ForeignServersFolder({
  connection,
  database,
  depth
}: {
  connection: ConnectionConfig
  database: string
  depth: number
}): React.JSX.Element {
  const id = `c:${connection.id}/d:${database}/foreignServers`
  return (
    <CatalogFolder
      id={id}
      depth={depth}
      label="Foreign servers"
      options={pgObjectQueries.foreignServers(connection.id, database)}
      itemKey={(s: ForeignServer) => s.name}
      searchText={(s) => [s.name, s.wrapper]}
      menu={[
        {
          label: 'New foreign server',
          icon: <Plus />,
          onSelect: script(connection.id, database, foreignServerTemplate())
        }
      ]}
      render={(s) => (
        <ForeignServerNode
          key={s.name}
          connection={connection}
          database={database}
          server={s}
          id={`${id}/${s.name}`}
          depth={depth + 1}
        />
      )}
    />
  )
}

function ForeignServerNode({
  connection,
  database,
  server: s,
  id,
  depth
}: {
  connection: ConnectionConfig
  database: string
  server: ForeignServer
  id: string
  depth: number
}): React.JSX.Element {
  const [open, setOpen] = useExpanded(id)
  const options = formatOptions(s.options)
  const mappingMenu = (m: UserMapping): MenuItem[] => [
    { heading: `${m.user ?? 'PUBLIC'} @ ${s.name}` },
    {
      label: 'Script as',
      icon: <FileCode2 />,
      submenu: [
        {
          label: 'CREATE',
          onSelect: script(connection.id, database, createUserMappingSql(s.name, m))
        },
        { label: 'DROP', onSelect: script(connection.id, database, dropUserMappingSql(s.name, m)) }
      ]
    }
  ]
  return (
    <>
      <Row
        id={id}
        depth={depth}
        expandable
        open={open}
        onToggle={() => setOpen()}
        icon={<Server className="text-syn-type" />}
        label={s.name}
        detail={[s.wrapper, options].filter(Boolean).join(' · ')}
        title={[
          `Wrapper: ${s.wrapper}`,
          s.type && `Type: ${s.type}`,
          s.version && `Version: ${s.version}`,
          s.owner && `Owner: ${s.owner}`,
          options && `Options: ${options}`,
          s.comment
        ]
          .filter(Boolean)
          .join('\n')}
        onOpen={script(connection.id, database, createServerSql(s))}
        onMenu={(e) =>
          showContextMenu(e, [
            { heading: s.name },
            {
              label: 'DDL',
              icon: <ScrollText />,
              onSelect: script(connection.id, database, createServerSql(s))
            },
            {
              label: 'Script as',
              icon: <FileCode2 />,
              submenu: [
                { label: 'CREATE', onSelect: script(connection.id, database, createServerSql(s)) },
                { label: 'DROP', onSelect: script(connection.id, database, dropServerSql(s)) }
              ]
            },
            {
              label: 'New user mapping',
              icon: <Plus />,
              onSelect: script(connection.id, database, userMappingTemplate(s.name))
            },
            copyName(s.name)
          ])
        }
      />
      {open && (
        <>
          {s.mappings.map((m) => (
            <Row
              key={`m:${m.user ?? ''}`}
              id={`${id}/m:${m.user ?? ''}`}
              depth={depth + 1}
              icon={<UserRound className="text-syn-keyword" />}
              label={m.user ?? 'PUBLIC'}
              detail={`user mapping · ${formatOptions(m.options)}`}
              onOpen={script(connection.id, database, createUserMappingSql(s.name, m))}
              onMenu={(e) => showContextMenu(e, mappingMenu(m))}
            />
          ))}
          {s.tables.map(([schema, table]) => (
            <Row
              key={`t:${schema}.${table}`}
              id={`${id}/t:${schema}.${table}`}
              depth={depth + 1}
              icon={<Table2 className="text-syn-prop" />}
              label={
                <>
                  <span className="text-muted">{schema}.</span>
                  {table}
                </>
              }
              detail="foreign table"
              onOpen={() => openTable(connection.id, database, schema, table, 'foreign_table')}
              onMenu={(e) =>
                showContextMenu(e, [
                  { heading: `${schema}.${table}` },
                  {
                    label: 'Open data',
                    icon: <Table2 />,
                    onSelect: () =>
                      openTable(connection.id, database, schema, table, 'foreign_table')
                  },
                  {
                    label: 'DDL',
                    icon: <Code2 />,
                    onSelect: () =>
                      openTable(
                        connection.id,
                        database,
                        schema,
                        table,
                        'foreign_table',
                        'definition'
                      )
                  }
                ])
              }
            />
          ))}
          {!s.mappings.length && !s.tables.length && (
            <EmptyRow depth={depth + 1}>No user mappings or foreign tables</EmptyRow>
          )}
        </>
      )}
    </>
  )
}

/* ---------- pg_cron ---------- */

function CronJobsFolder({
  connection,
  database,
  depth
}: {
  connection: ConnectionConfig
  database: string
  depth: number
}): React.JSX.Element {
  const id = `c:${connection.id}/d:${database}/cronJobs`
  const options = pgObjectQueries.cronJobs(connection.id, database)
  const menu = (j: CronJob): MenuItem[] => [
    { heading: cronJobLabel(j) },
    {
      label: 'Run history',
      icon: <History />,
      onSelect: () =>
        newQueryTab(connection.id, database, cronHistorySql(j.id), {
          autorun: true,
          title: `${cronJobLabel(j)} runs`
        })
    },
    {
      label: 'Script as',
      icon: <FileCode2 />,
      submenu: [
        {
          label: 'cron.schedule',
          onSelect: script(connection.id, database, cronScheduleSql(j, database))
        },
        {
          label: 'cron.unschedule',
          onSelect: script(connection.id, database, cronUnscheduleSql(j))
        }
      ]
    },
    'separator',
    {
      label: j.active ? 'Deactivate' : 'Activate',
      icon: j.active ? <Pause /> : <Play />,
      disabled: connection.readOnly,
      onSelect: () =>
        void runChange(
          connection.id,
          database,
          cronSetActiveSql(j.id, !j.active),
          `${j.active ? 'Deactivated' : 'Activated'} ${cronJobLabel(j)}`,
          options.queryKey
        )
    },
    copyName(j.name ?? String(j.id))
  ]
  return (
    <CatalogFolder
      id={id}
      depth={depth}
      label="Scheduled jobs (pg_cron)"
      options={options}
      itemKey={(j: CronJob) => String(j.id)}
      searchText={(j) => [j.name, j.command, j.schedule]}
      menu={[
        {
          label: 'New job',
          icon: <Plus />,
          onSelect: script(connection.id, database, cronJobTemplate())
        }
      ]}
      render={(j) => (
        <Row
          id={`${id}/${j.id}`}
          depth={depth + 1}
          icon={<CalendarClock className="text-syn-fn" />}
          label={cronJobLabel(j)}
          muted={!j.active}
          detail={[
            j.schedule,
            !j.active && 'inactive',
            j.lastStatus && `last ${j.lastStatus}`,
            j.database !== database && j.database
          ]
            .filter(Boolean)
            .join(' · ')}
          title={cronJobTooltip(j)}
          onOpen={() =>
            newQueryTab(connection.id, database, cronHistorySql(j.id), {
              autorun: true,
              title: `${cronJobLabel(j)} runs`
            })
          }
          onMenu={(e) => showContextMenu(e, menu(j))}
        />
      )}
    />
  )
}
