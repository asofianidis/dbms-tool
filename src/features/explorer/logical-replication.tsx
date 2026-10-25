import { useQuery } from '@tanstack/react-query'
import { Code2, Copy, FileCode2, Info, Pause, Play, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import {
  createPublicationSql,
  createSubscriptionSql,
  dropPublicationSql,
  dropSubscriptionSql,
  logicalQueries,
  operationsLabel,
  parsePublicationDetails,
  parseSubscriptionDetails,
  publicationDetailsSql,
  refreshSubscriptionSql,
  setSubscriptionEnabledSql,
  subscriptionDetailsSql,
  TABLE_SYNC_STATES,
  type Publication,
  type Subscription
} from '@/lib/pg-logical'
import { formatLag } from '@/lib/pg-replication'
import { queryClient } from '@/lib/queries'
import { createStore } from '@/lib/store'
import { toast, toastError } from '@/lib/toast'
import { confirm, getConnection, newQueryTab } from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'
import { Badge, Button, ErrorText, Modal, Spinner } from '@/components/ui'

type Request = { connectionId: string; database: string } & (
  | { kind: 'publication'; publication: Publication }
  | { kind: 'subscription'; subscription: Subscription }
)

const detailsStore = createStore<Request | null>(null)

export function LogicalReplicationHost(): React.JSX.Element | null {
  const request = detailsStore.use()
  if (!request) return null
  const close = (): void => detailsStore.set(null)
  return request.kind === 'publication' ? (
    <PublicationDialog key={`p:${request.publication.name}`} request={request} onClose={close} />
  ) : (
    <SubscriptionDialog key={`s:${request.subscription.name}`} request={request} onClose={close} />
  )
}

export const openPublicationDetails = (
  connectionId: string,
  database: string,
  publication: Publication
): void => detailsStore.set({ connectionId, database, kind: 'publication', publication })

export const openSubscriptionDetails = (
  connectionId: string,
  database: string,
  subscription: Subscription
): void => detailsStore.set({ connectionId, database, kind: 'subscription', subscription })

/** server_version_num, to gate catalog columns newer than PG 13. */
const versionQuery = (connectionId: string, database: string) => ({
  queryKey: ['conn', connectionId, 'catalog', database, 'serverVersionNum'],
  queryFn: async (): Promise<number> => {
    const out = await api.execute(
      connectionId,
      '__meta',
      database,
      `SELECT current_setting('server_version_num')`
    )
    if (out.error) throw new Error(out.error.message)
    return Number(out.results[0]?.rows[0]?.[0] ?? 0)
  },
  staleTime: Infinity
})

async function details(connectionId: string, database: string, sql: string) {
  const out = await api.execute(connectionId, '__meta', database, sql)
  if (out.error) throw new Error(out.error.message)
  return out.results
}

const copy = (text: string): void =>
  void navigator.clipboard.writeText(text).then(() => toast('Copied'), toastError)

const invalidateSubscriptions = (connectionId: string, database: string): void =>
  void queryClient.invalidateQueries({
    queryKey: logicalQueries.subscriptions(connectionId, database).queryKey
  })

/** Runs an ALTER SUBSCRIPTION; production connections confirm it in `api.execute`. */
async function alterSubscription(
  connectionId: string,
  database: string,
  sql: string,
  done: string
): Promise<boolean> {
  try {
    const out = await api.execute(connectionId, '__meta', database, sql)
    if (out.error) throw new Error(out.error.message)
    toast(done)
    invalidateSubscriptions(connectionId, database)
    return true
  } catch (e) {
    toastError(e)
    return false
  }
}

async function setEnabled(
  connectionId: string,
  database: string,
  s: Subscription,
  enabled: boolean
): Promise<void> {
  if (!enabled) {
    const ok = await confirm({
      title: `Disable subscription ${s.name}?`,
      message:
        'Its apply worker stops, so changes on the publisher stop arriving here. The replication slot on the publisher stays and keeps WAL until the subscription is enabled again.',
      code: setSubscriptionEnabledSql(s.name, false),
      confirmLabel: 'Disable'
    })
    if (!ok) return
  }
  await alterSubscription(
    connectionId,
    database,
    setSubscriptionEnabledSql(s.name, enabled),
    `${enabled ? 'Enabled' : 'Disabled'} subscription ${s.name}`
  )
}

async function refreshPublication(
  connectionId: string,
  database: string,
  s: Subscription
): Promise<void> {
  const ok = await confirm({
    title: `Refresh the publications of ${s.name}?`,
    message:
      'Tables added to the subscribed publications start replicating, and their existing rows are copied (copy_data defaults to true); tables removed from them stop. The subscription has to be enabled.',
    code: refreshSubscriptionSql(s.name),
    confirmLabel: 'Refresh publication'
  })
  if (!ok) return
  await alterSubscription(
    connectionId,
    database,
    refreshSubscriptionSql(s.name),
    `Refreshed the publications of ${s.name}`
  )
}

/** Fetches the details a CREATE PUBLICATION script needs, then opens it in a query tab. */
async function scriptCreatePublication(
  connectionId: string,
  database: string,
  p: Publication
): Promise<void> {
  try {
    const version = await queryClient.fetchQuery(versionQuery(connectionId, database))
    const sets = await details(connectionId, database, publicationDetailsSql(p.name, version))
    newQueryTab(connectionId, database, createPublicationSql(parsePublicationDetails(p, sets)))
  } catch (e) {
    toastError(e)
  }
}

const copyName = (name: string): MenuItem => ({
  label: 'Copy name',
  icon: <Copy />,
  onSelect: () => copy(name)
})

/** Context menu for a publication, after its heading. */
export function publicationMenuItems(
  connectionId: string,
  database: string,
  p: Publication
): MenuItem[] {
  return [
    {
      label: 'Details…',
      icon: <Info />,
      onSelect: () => openPublicationDetails(connectionId, database, p)
    },
    {
      label: 'Script as',
      icon: <FileCode2 />,
      submenu: [
        {
          label: 'CREATE',
          onSelect: () => void scriptCreatePublication(connectionId, database, p)
        },
        {
          label: 'DROP',
          onSelect: () => newQueryTab(connectionId, database, dropPublicationSql(p.name))
        }
      ]
    },
    copyName(p.name)
  ]
}

/** Context menu for a subscription, after its heading. */
export function subscriptionMenuItems(
  connectionId: string,
  database: string,
  s: Subscription
): MenuItem[] {
  const readOnly = !!getConnection(connectionId)?.readOnly
  return [
    {
      label: 'Details…',
      icon: <Info />,
      onSelect: () => openSubscriptionDetails(connectionId, database, s)
    },
    {
      label: 'Script as',
      icon: <FileCode2 />,
      submenu: [
        {
          label: 'CREATE',
          onSelect: () => newQueryTab(connectionId, database, createSubscriptionSql(s))
        },
        {
          label: 'DROP',
          onSelect: () => newQueryTab(connectionId, database, dropSubscriptionSql(s.name))
        }
      ]
    },
    'separator',
    s.enabled
      ? {
          label: 'Disable',
          icon: <Pause />,
          disabled: readOnly,
          onSelect: () => void setEnabled(connectionId, database, s, false)
        }
      : {
          label: 'Enable',
          icon: <Play />,
          disabled: readOnly,
          onSelect: () => void setEnabled(connectionId, database, s, true)
        },
    {
      label: 'Refresh publication',
      icon: <RefreshCw />,
      disabled: readOnly || !s.enabled,
      onSelect: () => void refreshPublication(connectionId, database, s)
    },
    copyName(s.name)
  ]
}

/** Hover text for a publication row. */
export const publicationTooltip = (p: Publication): string =>
  [
    p.allTables ? 'All tables' : `${p.tableCount ?? '?'} tables`,
    `Publishes ${operationsLabel(p.operations)}`,
    p.viaRoot && 'Via partition root',
    p.owner && `Owner ${p.owner}`,
    p.comment
  ]
    .filter(Boolean)
    .join('\n')

/** Hover text for a subscription row. */
export const subscriptionTooltip = (s: Subscription): string =>
  [
    s.enabled ? 'Enabled' : 'Disabled',
    `Publications: ${s.publications.join(', ') || '—'}`,
    s.conninfo && `Connection: ${s.conninfo}`,
    s.owner && `Owner ${s.owner}`,
    s.comment
  ]
    .filter(Boolean)
    .join('\n')

/* ---------- Details dialogs ---------- */

function Facts({ rows }: { rows: [string, React.ReactNode][] }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 font-mono break-all text-fg select-text">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="mt-4 mb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">
      {children}
    </h3>
  )
}

function Table({
  head,
  rows,
  empty
}: {
  head: string[]
  rows: React.ReactNode[][]
  empty: string
}): React.JSX.Element {
  if (!rows.length) return <p className="text-[12px] text-muted">{empty}</p>
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full text-[12px]">
        <thead className="bg-canvas text-muted">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-2 py-1.5 text-left font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((cell, j) => (
                <td key={j} className="px-2 py-1.5 font-mono text-[11.5px] text-fg select-text">
                  {cell ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Ddl({
  connectionId,
  database,
  sql
}: {
  connectionId: string
  database: string
  sql: string
}): React.JSX.Element {
  return (
    <>
      <Heading>DDL</Heading>
      <pre className="max-h-[30vh] overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg select-text">
        {sql}
      </pre>
      <div className="mt-2 flex gap-2">
        <Button size="xs" variant="ghost" onClick={() => copy(sql)}>
          <Copy className="size-3.5" /> Copy
        </Button>
        <Button size="xs" variant="ghost" onClick={() => newQueryTab(connectionId, database, sql)}>
          <Code2 className="size-3.5" /> Open in editor
        </Button>
      </div>
    </>
  )
}

function Loading({
  pending,
  error,
  children
}: {
  pending: boolean
  error: unknown
  children: () => React.ReactNode
}): React.JSX.Element {
  if (error) return <ErrorText error={error} />
  if (pending)
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <Spinner className="size-3.5" /> Loading…
      </div>
    )
  return <>{children()}</>
}

function PublicationDialog({
  request,
  onClose
}: {
  request: Extract<Request, { kind: 'publication' }>
  onClose: () => void
}): React.JSX.Element {
  const { connectionId, database, publication: p } = request
  const version = useQuery(versionQuery(connectionId, database))
  const q = useQuery({
    queryKey: ['conn', connectionId, 'catalog', database, 'publication', p.name, version.data],
    queryFn: async () =>
      parsePublicationDetails(
        p,
        await details(connectionId, database, publicationDetailsSql(p.name, version.data ?? 0))
      ),
    enabled: version.data != null
  })
  const v15 = (version.data ?? 0) >= 150000
  return (
    <Modal
      width="xl"
      title={`Publication ${p.name}`}
      description={`In ${database}`}
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <Facts
        rows={[
          ['Tables', p.allTables ? 'All tables (FOR ALL TABLES)' : 'Listed tables and schemas'],
          ['Publishes', operationsLabel(p.operations)],
          ['Via partition root', p.viaRoot ? 'Yes' : 'No'],
          ['Owner', p.owner ?? '—'],
          ...(p.comment ? [['Comment', p.comment] as [string, string]] : [])
        ]}
      />
      <Loading pending={q.isPending} error={version.error ?? q.error}>
        {() =>
          q.data && (
            <>
              {q.data.schemas.length > 0 && (
                <>
                  <Heading>Schemas</Heading>
                  <p className="font-mono text-[12px] text-fg select-text">
                    {q.data.schemas.join(', ')}
                  </p>
                </>
              )}
              <Heading>Published tables ({q.data.tables.length})</Heading>
              <Table
                head={['Table', 'Columns', 'Row filter']}
                empty="This publication covers no tables yet."
                rows={q.data.tables.map((t) => [
                  `${t.schema}.${t.table}`,
                  t.columns?.join(', ') ?? (v15 ? 'all' : 'all (column lists are PG 15+)'),
                  t.rowFilter ?? (v15 ? '' : '—')
                ])}
              />
              <Ddl
                connectionId={connectionId}
                database={database}
                sql={createPublicationSql(q.data)}
              />
            </>
          )
        }
      </Loading>
    </Modal>
  )
}

function SubscriptionDialog({
  request,
  onClose
}: {
  request: Extract<Request, { kind: 'subscription' }>
  onClose: () => void
}): React.JSX.Element {
  const { connectionId, database } = request
  // The listing refreshes after Enable / Disable; read the current row from it
  const list = useQuery({
    ...logicalQueries.subscriptions(connectionId, database),
    placeholderData: [request.subscription]
  })
  const s = list.data?.find((x) => x.name === request.subscription.name) ?? request.subscription
  const readOnly = !!getConnection(connectionId)?.readOnly
  const version = useQuery(versionQuery(connectionId, database))
  const q = useQuery({
    queryKey: ['conn', connectionId, 'catalog', database, 'subscription', s.name, version.data],
    queryFn: async () =>
      parseSubscriptionDetails(
        await details(connectionId, database, subscriptionDetailsSql(s.name, version.data ?? 0))
      ),
    enabled: version.data != null,
    refetchInterval: 5000
  })
  const after = (): void => void q.refetch()
  return (
    <Modal
      width="xl"
      title={`Subscription ${s.name}`}
      description={`In ${database}`}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="secondary"
            disabled={readOnly}
            onClick={() => void setEnabled(connectionId, database, s, !s.enabled).then(after)}
          >
            {s.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            {s.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="secondary"
            disabled={readOnly || !s.enabled}
            onClick={() => void refreshPublication(connectionId, database, s).then(after)}
          >
            <RefreshCw className="size-3.5" /> Refresh publication
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <Facts
        rows={[
          [
            'State',
            <Badge tone={s.enabled ? 'success' : 'warning'}>
              {s.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          ],
          ['Publications', s.publications.join(', ') || '—'],
          ['Connection', s.conninfo ?? 'Visible to superusers only'],
          ['Slot on publisher', s.slotName ?? 'NONE'],
          ['Synchronous commit', s.synchronousCommit ?? '—'],
          ['Owner', s.owner ?? '—'],
          ...(s.comment ? [['Comment', s.comment] as [string, string]] : [])
        ]}
      />
      <Loading pending={q.isPending} error={version.error ?? q.error}>
        {() =>
          q.data && (
            <>
              <Heading>Workers</Heading>
              <Table
                head={['Worker', 'PID', 'Table', 'Received LSN', 'Reported LSN', 'Last message']}
                empty={
                  s.enabled
                    ? 'No worker is running: check the server log for connection or apply errors.'
                    : 'No worker runs while the subscription is disabled.'
                }
                rows={q.data.workers.map((w) => [
                  w.type,
                  w.pid,
                  w.table ?? '—',
                  w.receivedLsn,
                  w.latestEndLsn,
                  w.lastMessage == null
                    ? '—'
                    : `${formatLag(w.lastMessage)} ago${w.transit != null ? ` (took ${formatLag(w.transit)})` : ''}`
                ])}
              />
              {(q.data.applyErrors != null || q.data.syncErrors != null) && (
                <p className="mt-2 text-[12px] text-muted">
                  Errors since the statistics were reset: {q.data.applyErrors ?? 0} applying
                  changes, {q.data.syncErrors ?? 0} in initial table copies
                </p>
              )}
              <Heading>Tables ({q.data.tables.length})</Heading>
              <Table
                head={['Table', 'State', 'LSN']}
                empty="No tables subscribed; Refresh publication picks up newly published ones."
                rows={q.data.tables.map((t) => [
                  t.table,
                  TABLE_SYNC_STATES[t.state] ?? t.state,
                  t.lsn ?? '—'
                ])}
              />
            </>
          )
        }
      </Loading>
      <Ddl connectionId={connectionId} database={database} sql={createSubscriptionSql(s)} />
    </Modal>
  )
}
