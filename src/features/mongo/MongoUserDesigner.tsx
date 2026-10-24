import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Plus, Save, Trash2, X } from 'lucide-react'
import { api, type Ejson } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  BUILTIN_ADMIN_ROLES,
  BUILTIN_DATABASE_ROLES,
  COMMON_ACTIONS,
  commandScript,
  dropRoleCommand,
  dropUserCommand,
  mongoPrincipalKey,
  parseRoles,
  parseRolesInfo,
  parseUsersInfo,
  privilegeText,
  roleCommands,
  roleMemberCommands,
  roleRefKey,
  sortPrincipals,
  userCommands,
  validateRole,
  validateUser,
  type MongoCommand,
  type MongoPrincipal,
  type MongoRole,
  type MongoRoleRef,
  type MongoUser
} from '@/lib/mongo-users'
import { confirmProductionWrite } from '@/lib/production'
import { queries, queryClient } from '@/lib/queries'
import { createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import { connectionsStore } from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Input,
  Modal,
  Segmented,
  Select,
  Spinner
} from '@/components/ui'

interface Request {
  connectionId: string
  kind: 'user' | 'role'
  /** The user's authentication database, or the role's database */
  db: string
  /** null to create one */
  name: string | null
  /** Open straight on the drop confirmation */
  drop?: boolean
}

const mongoUserDesignerStore = createStore<Request | null>(null)

export function openMongoUserDesigner(
  connectionId: string,
  kind: 'user' | 'role',
  db: string,
  name: string | null = null,
  drop = false
): void {
  mongoUserDesignerStore.set({ connectionId, kind, db, name, drop })
}

const close = (): void => mongoUserDesignerStore.set(null)

export function MongoUserDesignerHost(): React.JSX.Element | null {
  const request = mongoUserDesignerStore.use()
  if (!request) return null
  return (
    <MongoUserDesigner
      key={`${request.connectionId}/${request.kind}/${request.db}/${request.name}/${request.drop}`}
      {...request}
    />
  )
}

async function command(
  connectionId: string,
  database: string,
  cmd: Record<string, Ejson>
): Promise<Ejson> {
  const out = await api.mongo(connectionId, '__meta', { op: 'runCommand', database, command: cmd })
  return out.value
}

interface MongoAccounts {
  users: MongoUser[]
  /** Custom roles; built-in ones aren't listed */
  roles: MongoRole[]
}

/** Every user, and the custom roles of every database, as far as the account can see. */
async function loadAccounts(connectionId: string): Promise<MongoAccounts> {
  const users = await command(connectionId, 'admin', { usersInfo: { forAllDBs: true } })
    .catch(() => command(connectionId, 'admin', { usersInfo: 1 }))
    .then(parseUsersInfo)
  // Custom roles of every database live in admin.system.roles
  const roles = await api
    .mongo(connectionId, '__meta', {
      op: 'find',
      database: 'admin',
      collection: 'system.roles',
      limit: 5000
    })
    .then((out) => parseRoles(out.documents))
    .catch(() => command(connectionId, 'admin', { rolesInfo: 1 }).then(parseRolesInfo))
  return { users, roles }
}

/** The explorer's listing of users and custom roles. */
export const mongoAccountsQuery = (connectionId: string) => ({
  queryKey: ['conn', connectionId, 'mongoAccounts'] as const,
  queryFn: () => loadAccounts(connectionId)
})

export async function listMongoPrincipals(connectionId: string): Promise<MongoPrincipal[]> {
  const { users, roles } = await loadAccounts(connectionId)
  return sortPrincipals([
    ...users.map((u) => ({ kind: 'user' as const, name: u.user, db: u.db })),
    ...roles.map((r) => ({ kind: 'role' as const, name: r.role, db: r.db }))
  ])
}

interface Loaded {
  user: MongoUser | null
  role: MongoRole | null
}

function MongoUserDesigner(request: Request): React.JSX.Element {
  const { connectionId, kind, db, name } = request
  const accounts = useQuery({ ...mongoAccountsQuery(connectionId), staleTime: 0 })
  const current = useQuery({
    queryKey: ['conn', connectionId, 'mongoAccount', kind, db, name],
    enabled: name !== null,
    queryFn: async (): Promise<Loaded> =>
      kind === 'user'
        ? {
            user:
              parseUsersInfo(
                await command(connectionId, db, { usersInfo: { user: name, db } })
              )[0] ?? null,
            role: null
          }
        : {
            user: null,
            role:
              parseRolesInfo(
                await command(connectionId, db, {
                  rolesInfo: { role: name, db },
                  showPrivileges: true
                })
              )[0] ?? null
          },
    staleTime: 0
  })
  const missing = current.isSuccess && !current.data.user && !current.data.role
  const loading = !accounts.isFetchedAfterMount || (name !== null && !current.isFetchedAfterMount)
  if (accounts.isError || current.isError || missing || loading) {
    return (
      <Modal width="sm" title={name ?? `New ${kind}`} onClose={close}>
        {accounts.isError ? (
          <ErrorText error={accounts.error} />
        ) : current.isError ? (
          <ErrorText error={current.error} />
        ) : missing ? (
          <ErrorText error={`${name}@${db} no longer exists`} />
        ) : (
          <div className="flex justify-center py-6">
            <Spinner className="size-5" />
          </div>
        )}
      </Modal>
    )
  }
  return (
    <MongoUserForm
      request={request}
      accounts={accounts.data!}
      user={current.data?.user ?? null}
      role={current.data?.role ?? null}
    />
  )
}

type Section = 'general' | 'members'

function MongoUserForm({
  request,
  accounts,
  user,
  role
}: {
  request: Request
  accounts: MongoAccounts
  user: MongoUser | null
  role: MongoRole | null
}): React.JSX.Element {
  const { connectionId, kind } = request
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const databases = useQuery(queries.databases(connectionId))
  const dbNames = useMemo(
    () => [...new Set(['admin', ...(databases.data ?? []).map((d) => d.name)])],
    [databases.data]
  )
  const isRole = kind === 'role'
  const creating = request.name === null
  const [name, setName] = useState(user?.user ?? role?.role ?? '')
  const [db, setDb] = useState(request.db || 'admin')
  const [password, setPassword] = useState('')
  const [roles, setRoles] = useState<MongoRoleRef[]>(user?.roles ?? role?.roles ?? [])
  const [privileges, setPrivileges] = useState(
    role
      ? privilegeText(role.privileges)
      : privilegeText([
          { resource: { db: request.db || 'admin', collection: '' }, actions: ['find'] }
        ])
  )
  const roleRef: MongoRoleRef = { role: name.trim(), db }
  // Users holding the role as loaded; none for a new one
  const holders = useMemo(() => {
    const key = role ? roleRefKey({ role: role.role, db: role.db }) : null
    return new Set(
      accounts.users
        .filter((u) => u.roles.some((r) => roleRefKey(r) === key))
        .map((u) => mongoPrincipalKey({ name: u.user, db: u.db }))
    )
  }, [accounts.users, role])
  const [members, setMembers] = useState(holders)
  const [section, setSection] = useState<Section>('general')
  const [dropping, setDropping] = useState(!!request.drop && !creating)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const commands = (mask: boolean): MongoCommand[] => {
    if (dropping) {
      const target = { name: request.name!, db: request.db }
      return [isRole ? dropRoleCommand(target) : dropUserCommand(target)]
    }
    if (!isRole) return userCommands({ name, db, password, roles, original: user }, mask)
    return [
      ...roleCommands({ name, db, roles, privileges, original: role }),
      ...roleMemberCommands(roleRef, accounts.users, holders, members)
    ]
  }
  const list = commands(false)
  const shown = commandScript(commands(true))
  const problem = dropping
    ? null
    : isRole
      ? validateRole({ name, db, roles, privileges, original: role })
      : validateUser({ name, db, password, roles, original: user })
  const noun = isRole ? 'role' : 'user'
  const label = request.name ? `${request.name}@${request.db}` : ''

  const apply = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    try {
      const confirmed = await confirmProductionWrite(connection, {
        action: dropping
          ? `This drops the ${noun} ${label}`
          : `This runs ${list.map((c) => Object.keys(c.command)[0]).join(', ')}`,
        dangers: dropping ? [`${isRole ? 'dropRole' : 'dropUser'} removes ${label}`] : [],
        code: shown
      })
      if (!confirmed) return
      // In order: a new role exists before it's granted to its members
      for (const c of list) {
        await api.mongo(
          connectionId,
          '__meta',
          { op: 'runCommand', database: c.database, command: c.command },
          { confirmed: true }
        )
      }
      toast(
        dropping
          ? `Dropped ${label}`
          : creating
            ? `Created ${noun} ${name.trim()}@${db}`
            : `Updated ${label}`
      )
      await queryClient.invalidateQueries({ queryKey: ['conn', connectionId, 'mongoAccounts'] })
      await queryClient.invalidateQueries({ queryKey: ['conn', connectionId, 'mongoAccount'] })
      close()
    } catch (e) {
      setError(errorMessage(e))
      // Some commands may have run; show what's there now
      void queryClient.invalidateQueries({ queryKey: ['conn', connectionId, 'mongoAccounts'] })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Modal
      width="xl"
      title={
        dropping ? `Drop ${noun} ${label}?` : creating ? `New ${noun}` : `Edit ${noun} ${label}`
      }
      description={<span className="font-mono">{connection?.name || connection?.host}</span>}
      icon={
        dropping ? (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
            <AlertTriangle className="size-4" />
          </span>
        ) : undefined
      }
      onClose={close}
      footer={
        <>
          {!creating && !dropping && (
            <Button
              variant="ghost"
              className="mr-auto hover:text-danger"
              onClick={() => setDropping(true)}
            >
              <Trash2 className="size-3.5" /> Drop {noun}…
            </Button>
          )}
          {problem && <span className="mr-auto text-xs text-danger">{problem}</span>}
          {connection?.readOnly && <Badge tone="warning">read-only connection</Badge>}
          {dropping && !request.drop && (
            <Button variant="secondary" onClick={() => setDropping(false)}>
              Back
            </Button>
          )}
          <Button
            variant={dropping ? 'danger' : 'primary'}
            disabled={!list.length || !!problem || running || connection?.readOnly}
            onClick={() => void apply()}
          >
            {running ? (
              <Spinner className="text-current" />
            ) : dropping ? (
              <Trash2 className="size-3.5" />
            ) : (
              <Save className="size-3.5" />
            )}
            {dropping ? `Drop ${noun}` : creating ? `Create ${noun}` : 'Apply changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {dropping ? (
          <p className="text-[13px] text-fg">
            {isRole ? (
              <>
                Dropping <span className="font-mono text-bright">{label}</span> removes it from
                every user and role that holds it
                {holders.size > 0 && <> ({holders.size} users)</>}.
              </>
            ) : (
              <>
                Dropping <span className="font-mono text-bright">{label}</span> removes the user.
                Sessions already signed in as it keep running until they disconnect.
              </>
            )}
          </p>
        ) : (
          <>
            {isRole && (
              <Segmented
                className="h-8"
                value={section}
                options={[
                  { value: 'general', label: 'General' },
                  { value: 'members', label: 'Members' }
                ]}
                onChange={setSection}
              />
            )}
            {section === 'general' ? (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <Field
                    label="Name"
                    className="min-w-48 flex-[2]"
                    hint={creating ? undefined : `MongoDB can't rename ${noun}s`}
                  >
                    <Input
                      mono
                      autoFocus
                      value={name}
                      disabled={!creating}
                      placeholder={isRole ? 'role_name' : 'user_name'}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  <Field
                    label={isRole ? 'Database' : 'Authentication database'}
                    className="min-w-40 flex-1"
                  >
                    <Select
                      selectClassName="font-mono text-xs"
                      value={db}
                      disabled={!creating}
                      onChange={(e) => setDb(e.target.value)}
                    >
                      {dbNames.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                {!isRole && (
                  <Field
                    label="Password"
                    hint={creating ? undefined : 'Leave empty to keep the current password'}
                  >
                    <Input
                      mono
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      placeholder={creating ? '' : '••••••••'}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                )}
                <RoleRefsEditor
                  label={isRole ? 'Inherits from' : 'Roles'}
                  value={roles}
                  onChange={setRoles}
                  customRoles={accounts.roles.filter(
                    (r) => !(isRole && r.role === name.trim() && r.db === db)
                  )}
                  databases={dbNames}
                  defaultDb={db}
                />
                {isRole && (
                  <Field
                    label="Privileges"
                    hint={
                      <>
                        An array of {'{ resource, actions }'}. A resource is{' '}
                        <span className="font-mono">{'{ db, collection }'}</span> (empty strings
                        mean any) or <span className="font-mono">{'{ cluster: true }'}</span>.
                        Common actions: {COMMON_ACTIONS.join(', ')}.
                      </>
                    }
                  >
                    <div className="h-40 overflow-hidden rounded-lg border border-line bg-canvas">
                      <CodeEditor
                        value={privileges}
                        onChange={setPrivileges}
                        language={{ kind: 'json' }}
                        lineNumbers={false}
                        className="h-full"
                        fontSize={12}
                      />
                    </div>
                  </Field>
                )}
              </>
            ) : (
              <RoleMembers
                users={accounts.users}
                draft={members}
                original={holders}
                onChange={setMembers}
              />
            )}
          </>
        )}
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
            <ErrorText error={error} />
          </div>
        )}
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-muted">
            Commands{!isRole && password && <span className="text-faint"> · password hidden</span>}
          </p>
          <div className="h-32 overflow-hidden rounded-lg border border-line bg-canvas">
            <CodeEditor
              value={shown || '// No changes'}
              language={{ kind: 'mongo' }}
              readOnly
              lineNumbers={false}
              className="h-full"
              fontSize={12}
            />
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** The roles held or inherited, with a picker to add more. */
function RoleRefsEditor({
  label,
  value,
  onChange,
  customRoles,
  databases,
  defaultDb
}: {
  label: string
  value: MongoRoleRef[]
  onChange: (refs: MongoRoleRef[]) => void
  customRoles: MongoRole[]
  databases: string[]
  defaultDb: string
}): React.JSX.Element {
  // 'b:<role>' is a database role picked with a database, 'a:<role>' an admin-only role
  // and 'c:<role>@<db>' a custom role
  const [pick, setPick] = useState('b:readWrite')
  const [pickDb, setPickDb] = useState(defaultDb === 'admin' ? '' : defaultDb)
  const kind = pick.slice(0, 1)
  const picked: MongoRoleRef | null =
    kind === 'b'
      ? pickDb
        ? { role: pick.slice(2), db: pickDb }
        : null
      : kind === 'a'
        ? { role: pick.slice(2), db: 'admin' }
        : (() => {
            const r = customRoles.find(
              (c) => `c:${roleRefKey({ role: c.role, db: c.db })}` === pick
            )
            return r ? { role: r.role, db: r.db } : null
          })()
  const held = new Set(value.map(roleRefKey))
  const add = (): void => {
    if (picked && !held.has(roleRefKey(picked))) onChange([...value, picked])
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted">{label}</p>
      <div className="rounded-lg border border-line">
        {value.length === 0 ? (
          <p className="px-3 py-3 text-center text-xs text-muted">No roles</p>
        ) : (
          <div className="max-h-40 overflow-y-auto py-1">
            {value.map((r) => (
              <div
                key={roleRefKey(r)}
                className="flex h-7 items-center gap-2 rounded-md px-2 hover:bg-hover/50"
              >
                <span className="truncate font-mono text-xs text-bright">{r.role}</span>
                <span className="text-xs text-faint">on</span>
                <span className="truncate font-mono text-xs text-fg">{r.db}</span>
                <button
                  type="button"
                  className="ml-auto rounded p-0.5 text-faint hover:bg-hover hover:text-danger"
                  title="Remove"
                  onClick={() => onChange(value.filter((x) => roleRefKey(x) !== roleRefKey(r)))}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Select
          className="min-w-56 flex-[2]"
          selectClassName="font-mono text-xs"
          value={pick}
          onChange={(e) => setPick(e.target.value)}
        >
          <optgroup label="Database roles">
            {BUILTIN_DATABASE_ROLES.map((r) => (
              <option key={r} value={`b:${r}`}>
                {r}
              </option>
            ))}
          </optgroup>
          <optgroup label="All databases (admin)">
            {BUILTIN_ADMIN_ROLES.map((r) => (
              <option key={r} value={`a:${r}`}>
                {r}
              </option>
            ))}
          </optgroup>
          {customRoles.length > 0 && (
            <optgroup label="Custom roles">
              {customRoles.map((r) => {
                const key = roleRefKey({ role: r.role, db: r.db })
                return (
                  <option key={key} value={`c:${key}`}>
                    {key}
                  </option>
                )
              })}
            </optgroup>
          )}
        </Select>
        {kind === 'b' && (
          <Select
            className="min-w-40 flex-1"
            selectClassName="font-mono text-xs"
            value={pickDb}
            onChange={(e) => setPickDb(e.target.value)}
          >
            <option value="">On database…</option>
            {databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        )}
        <Button
          variant="secondary"
          disabled={!picked || held.has(roleRefKey(picked))}
          onClick={add}
        >
          <Plus className="size-3.5" /> Add role
        </Button>
      </div>
    </div>
  )
}

function RoleMembers({
  users,
  original,
  draft,
  onChange
}: {
  users: MongoUser[]
  original: Set<string>
  draft: Set<string>
  onChange: (members: Set<string>) => void
}): React.JSX.Element {
  if (!users.length) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-muted">
        There are no users to add.
      </p>
    )
  }
  return (
    <div className="rounded-lg border border-line">
      <div className="grid h-8 grid-cols-[12px_minmax(0,1fr)_72px] items-center gap-x-3 border-b border-line px-2 text-[11px] font-medium text-muted">
        <span />
        <span>User</span>
        <span className="text-center">Member</span>
      </div>
      <div className="max-h-80 overflow-y-auto py-1">
        {users.map((u) => {
          const key = mongoPrincipalKey({ name: u.user, db: u.db })
          const on = draft.has(key)
          return (
            <div
              key={key}
              className="grid h-7 grid-cols-[12px_minmax(0,1fr)_72px] items-center gap-x-3 rounded-md px-2 hover:bg-hover/50"
            >
              <span
                className={cn(
                  'size-1.5 justify-self-center rounded-full',
                  on !== original.has(key) ? 'bg-warn' : 'bg-line-strong'
                )}
              />
              <span className={cn('truncate font-mono text-xs', on ? 'text-bright' : 'text-fg')}>
                {key}
              </span>
              <span className="flex justify-center">
                <input
                  type="checkbox"
                  className="size-3.5 accent-accent"
                  checked={on}
                  onChange={() => {
                    const next = new Set(draft)
                    if (on) next.delete(key)
                    else next.add(key)
                    onChange(next)
                  }}
                />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
