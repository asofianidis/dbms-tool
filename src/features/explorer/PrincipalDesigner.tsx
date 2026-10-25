import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, FilePlus2, Save, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { catalogQueries, catalogRows } from '@/lib/catalog'
import { ddlScript, draftId } from '@/lib/ddl'
import { ENGINES, type Dialect } from '@/lib/engines'
import {
  membershipQueries,
  membershipStatements,
  parseMembershipRows,
  principalKey,
  principalLabel,
  type GrantMap,
  type Principal
} from '@/lib/grants'
import { connectedInfo, isMariaDb, knownMariaDb } from '@/lib/mariadb'
import {
  TSQL_LOGINS_QUERY,
  canRenamePrincipal,
  draftPrincipal,
  dropPrincipalStatements,
  memberQueries,
  memberStatements,
  newPrincipalDraft,
  parsePrincipalState,
  principalDraftFrom,
  principalStateQueries,
  principalStatements,
  validatePrincipal,
  type PrincipalDraft,
  type PrincipalOptions,
  type PrincipalState,
  type PrincipalType,
  type TsqlAuth
} from '@/lib/principals'
import { confirmProductionWrite } from '@/lib/production'
import { queries, queryClient } from '@/lib/queries'
import { createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import { connectionsStore, newQueryTab, statusStore } from '@/lib/workspace'
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
  Spinner,
  Toggle
} from '@/components/ui'
import { Hint, Loading, MembershipList, roleCandidates } from './PermissionsDesigner'

interface Request {
  connectionId: string
  /** Database the catalog queries and statements run in ('' on MySQL) */
  database: string
  /** principalKey of the user or role to edit; null to create one */
  principal: string | null
  /** What to create; ignored when editing */
  type: PrincipalType
  /** Open straight on the drop confirmation */
  drop?: boolean
}

const principalDesignerStore = createStore<Request | null>(null)

export function openPrincipalDesigner(
  connectionId: string,
  database: string,
  principal: string | null,
  type: PrincipalType = 'user',
  drop = false
): void {
  principalDesignerStore.set({ connectionId, database, principal, type, drop })
}

const close = (): void => principalDesignerStore.set(null)

export function PrincipalDesignerHost(): React.JSX.Element | null {
  const request = principalDesignerStore.use()
  if (!request) return null
  return (
    <PrincipalDesigner
      key={`${request.connectionId}/${request.database}/${request.principal}/${request.type}/${request.drop}`}
      {...request}
    />
  )
}

/** Reloads every list of users, roles, grants and memberships on the connection. */
export function invalidatePrincipals(connectionId: string): Promise<void> {
  const keys = new Set(['principals', 'memberships', 'members', 'principalState', 'grants'])
  return queryClient.invalidateQueries({
    predicate: ({ queryKey: k }) =>
      k[0] === 'conn' &&
      k[1] === connectionId &&
      (keys.has(k[2] as string) || keys.has(k[4] as string))
  })
}

interface Loaded {
  principal: Principal | null
  state: PrincipalState | null
}

function PrincipalDesigner(request: Request): React.JSX.Element {
  const { connectionId, database } = request
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const dialect: Dialect = (connection && ENGINES[connection.engine].dialect) || 'postgres'
  const mariadb = knownMariaDb(statusStore.use()[connectionId])
  const principals = useQuery({
    ...catalogQueries.principals(connectionId, dialect, database, mariadb),
    staleTime: 0
  })
  const principal =
    request.principal === null
      ? null
      : (principals.data?.find((p) => principalKey(p) === request.principal) ?? null)
  const state = useQuery({
    queryKey: ['conn', connectionId, 'principalState', database, request.principal],
    enabled: !!principal,
    queryFn: async (): Promise<Loaded> => ({
      principal,
      state: parsePrincipalState(
        dialect,
        principal!,
        await catalogRows(connectionId, database, principalStateQueries(dialect, principal!))
      )
    }),
    staleTime: 0
  })

  const missing =
    request.principal !== null &&
    ((principals.isSuccess && !principal) || (state.isSuccess && !state.data.state))
  const loading =
    !principals.isSuccess || (request.principal !== null && !state.isFetchedAfterMount)
  if (principals.isError || state.isError || missing || loading) {
    return (
      <Modal width="sm" title={request.principal ?? `New ${request.type}`} onClose={close}>
        {principals.isError ? (
          <ErrorText error={principals.error} />
        ) : state.isError ? (
          <ErrorText error={state.error} />
        ) : missing ? (
          <ErrorText error={`${request.principal} no longer exists`} />
        ) : (
          <Loading />
        )}
      </Modal>
    )
  }
  return (
    <PrincipalForm
      request={request}
      dialect={dialect}
      principals={principals.data}
      principal={principal}
      state={state.data?.state ?? null}
    />
  )
}

type Section = 'general' | 'memberOf' | 'members'

/** Edits to a loaded map, kept as long as the map they started from. */
function useMapDraft(
  original: GrantMap | undefined
): [GrantMap | undefined, (m: GrantMap) => void] {
  const [edits, setEdits] = useState<{ from: GrantMap; state: GrantMap } | null>(null)
  const draft = original && edits?.from === original ? edits.state : original
  return [draft, (state) => original && setEdits({ from: original, state })]
}

function PrincipalForm({
  request,
  dialect,
  principals,
  principal,
  state
}: {
  request: Request
  dialect: Dialect
  principals: Principal[]
  principal: Principal | null
  state: PrincipalState | null
}): React.JSX.Element {
  const { connectionId, database } = request
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const status = statusStore.use()[connectionId]
  const options: PrincipalOptions = {
    mariadb: isMariaDb(connectedInfo(status)),
    babelfish: connection?.engine === 'babelfish'
  }
  const [draft, setDraft] = useState<PrincipalDraft>(() =>
    state ? principalDraftFrom(state) : newPrincipalDraft(dialect, request.type, options)
  )
  const set = <K extends keyof PrincipalDraft>(key: K, value: PrincipalDraft[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }))
  const original = draft.original
  const creating = !original
  const builtin = !!principal?.builtin
  const isRole = draft.type === 'role'
  const noun = isRole ? 'role' : 'user'
  const [dropping, setDropping] = useState(!!request.drop && !creating && !builtin)
  const [dropOwned, setDropOwned] = useState(false)
  const [dropLogin, setDropLogin] = useState(false)
  const [section, setSection] = useState<Section>(builtin && isRole ? 'members' : 'general')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Who the principal is after the changes, as membership statements name it
  const target = principal && builtin ? principal : draftPrincipal(dialect, draft)

  const memberOf = useQuery({
    queryKey: ['conn', connectionId, 'memberships', database, request.principal],
    enabled: !!principal,
    queryFn: async () =>
      parseMembershipRows(
        await catalogRows(connectionId, database, membershipQueries(dialect, principal!))
      ),
    staleTime: 0
  })
  const members = useQuery({
    queryKey: ['conn', connectionId, 'members', database, request.principal],
    enabled: !!principal && isRole,
    queryFn: async () =>
      parseMembershipRows(
        await catalogRows(connectionId, database, memberQueries(dialect, principal!))
      ),
    staleTime: 0
  })
  const memberOfOriginal = creating ? EMPTY : memberOf.data
  const membersOriginal = creating ? EMPTY : members.data
  const [memberOfDraft, setMemberOf] = useMapDraft(memberOfOriginal)
  const [membersDraft, setMembers] = useMapDraft(membersOriginal)
  const roles = roleCandidates(dialect, principals, principal ?? target, memberOfOriginal ?? {})
  const memberCandidates = useMemo(
    () => memberCandidatesOf(dialect, principals, principal, membersOriginal ?? {}),
    [dialect, principals, principal, membersOriginal]
  )

  const logins = useQuery({
    queryKey: ['conn', connectionId, 'logins'],
    enabled: dialect === 'tsql' && !isRole,
    queryFn: async () =>
      (await catalogRows(connectionId, database, [TSQL_LOGINS_QUERY])).map((r) =>
        typeof r[0] === 'string' ? r[0] : ''
      ),
    staleTime: 0
  })
  const schemas = useQuery({
    ...queries.schemas(connectionId, database),
    enabled: dialect === 'tsql' && !isRole
  })

  const build = (mask: boolean): string[] => {
    if (dropping && principal) {
      return dropPrincipalStatements(dialect, principal, {
        dropOwned,
        login: dropLogin ? original?.login : '',
        members: memberCandidates.filter((m) => principalKey(m) in (membersOriginal ?? {}))
      })
    }
    return [
      ...(builtin ? [] : principalStatements(dialect, draft, { ...options, maskPasswords: mask })),
      ...(memberOfOriginal && memberOfDraft
        ? membershipStatements(dialect, target, roles, memberOfOriginal, memberOfDraft)
        : []),
      ...(isRole && membersOriginal && membersDraft
        ? memberStatements(dialect, target, memberCandidates, membersOriginal, membersDraft)
        : [])
    ]
  }
  const script = ddlScript(dialect, build(false))
  const shown = ddlScript(dialect, build(true))
  const problem = dropping || builtin ? null : validatePrincipal(dialect, draft, options)
  const hasSecret = shown !== script

  const apply = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    const session = `designer-${draftId()}`
    try {
      // The confirmation shows the script with its passwords hidden
      if (!(await confirmProductionWrite(connection, { sql: shown }))) return
      const out = await api.execute(connectionId, session, database, script, { confirmed: true })
      if (out.error) throw new Error(out.error.message)
      const label = principalLabel(target)
      toast(
        dropping
          ? `Dropped ${principalLabel(principal!)}`
          : creating
            ? `Created ${noun} ${label}`
            : `Updated ${label}`
      )
      await invalidatePrincipals(connectionId)
      close()
    } catch (e) {
      setError(errorMessage(e))
      // XACT_ABORT doesn't roll back after every error, which can leave the transaction open
      if (dialect === 'tsql') {
        await api
          .execute(connectionId, session, database, 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;', {
            confirmed: true
          })
          .catch(() => undefined)
      }
    } finally {
      setRunning(false)
      void api.closeSession(connectionId, session).catch(() => undefined)
    }
  }

  const label = principal ? principalLabel(principal) : ''
  const title = dropping
    ? `Drop ${noun} ${label}?`
    : creating
      ? `New ${noun}`
      : `${builtin ? '' : 'Edit '}${noun} ${label}`
  const sections: { value: Section; label: string }[] = [
    { value: 'general', label: 'General' },
    // Fixed and predefined roles don't join other roles
    ...(builtin && isRole ? [] : [{ value: 'memberOf' as const, label: 'Member of' }]),
    ...(isRole ? [{ value: 'members' as const, label: 'Members' }] : [])
  ]

  return (
    <Modal
      width="xl"
      title={title}
      description={
        <span className="font-mono">
          {connection?.name || connection?.host}
          {database && ` / ${database}`}
        </span>
      }
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
          {!creating && !dropping && !builtin && (
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
            variant="secondary"
            disabled={!script || !!problem || hasSecret}
            title={hasSecret ? "Scripts with a password aren't opened in an editor tab" : undefined}
            onClick={() => {
              newQueryTab(connectionId, database, script)
              close()
            }}
          >
            <FilePlus2 className="size-3.5" /> Open in editor
          </Button>
          <Button
            variant={dropping ? 'danger' : 'primary'}
            disabled={!script || !!problem || running || connection?.readOnly}
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
          <DropNotes
            dialect={dialect}
            database={database}
            principal={principal!}
            state={original!}
            memberCount={Object.keys(membersOriginal ?? {}).length}
            dropOwned={dropOwned}
            onDropOwned={setDropOwned}
            dropLogin={dropLogin}
            onDropLogin={setDropLogin}
          />
        ) : (
          <>
            <Segmented className="h-8" value={section} options={sections} onChange={setSection} />
            {section === 'general' ? (
              builtin ? (
                <Hint>
                  {label} is built in: its attributes can&apos;t change, but you can manage who{' '}
                  {isRole ? 'belongs to it' : 'it belongs to'}.
                </Hint>
              ) : (
                <GeneralFields
                  dialect={dialect}
                  draft={draft}
                  set={set}
                  options={options}
                  principals={principals}
                  logins={logins.data ?? []}
                  schemas={(schemas.data ?? []).map((s) => s.name)}
                />
              )
            ) : section === 'memberOf' ? (
              memberOf.isError ? (
                <ErrorText error={memberOf.error} />
              ) : !memberOfOriginal || !memberOfDraft ? (
                <Loading />
              ) : (
                <MembershipList
                  dialect={dialect}
                  roles={roles}
                  original={memberOfOriginal}
                  draft={memberOfDraft}
                  onChange={setMemberOf}
                />
              )
            ) : members.isError ? (
              <ErrorText error={members.error} />
            ) : !membersOriginal || !membersDraft ? (
              <Loading />
            ) : (
              <MembershipList
                dialect={dialect}
                roles={memberCandidates}
                original={membersOriginal}
                draft={membersDraft}
                onChange={setMembers}
                label="User or role"
                empty="There are no users or roles to add."
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
            Statements{hasSecret && <span className="text-faint"> · passwords hidden</span>}
          </p>
          <div className="h-32 overflow-hidden rounded-lg border border-line bg-canvas">
            <CodeEditor
              value={shown || '-- No changes'}
              language={{ kind: 'sql', dialect }}
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

const EMPTY: GrantMap = {}

/** Who could join the role: other users and roles, plus anyone already in it. */
function memberCandidatesOf(
  dialect: Dialect,
  principals: Principal[],
  role: Principal | null,
  held: GrantMap
): Principal[] {
  const self = role ? principalKey(role) : null
  const list = principals.filter((p) => {
    const key = principalKey(p)
    if (key === self || p.kind === 'public') return false
    if (key in held) return true
    // SQL Server's fixed roles can't join other roles, and nor can its public role
    return !p.builtin && !(dialect === 'tsql' && p.name === 'public')
  })
  return [...list.filter((p) => p.kind === 'user'), ...list.filter((p) => p.kind !== 'user')]
}

const TSQL_AUTH: { value: TsqlAuth; label: string; hint: string }[] = [
  { value: 'login', label: 'Server login', hint: 'Signs in with a SQL Server or Windows login' },
  {
    value: 'password',
    label: 'Contained user (password)',
    hint: 'Signs in to this database directly; needs a contained database or Azure SQL'
  },
  {
    value: 'external',
    label: 'Microsoft Entra ID',
    hint: 'An Entra ID user or group by name (Azure SQL and SQL Server 2022+)'
  },
  { value: 'none', label: 'Without login', hint: "Can't sign in; for impersonation and signing" }
]

function GeneralFields({
  dialect,
  draft,
  set,
  options,
  principals,
  logins,
  schemas
}: {
  dialect: Dialect
  draft: PrincipalDraft
  set: <K extends keyof PrincipalDraft>(key: K, value: PrincipalDraft[K]) => void
  options: PrincipalOptions
  principals: Principal[]
  logins: string[]
  schemas: string[]
}): React.JSX.Element {
  const creating = !draft.original
  const isRole = draft.type === 'role'
  const renamable = creating || canRenamePrincipal(dialect, draft.type)
  const hasHost = dialect === 'mysql' && !(isRole && options.mariadb)
  // PostgreSQL roles can all have passwords, but only login roles use them
  const hasPassword =
    dialect === 'postgres'
      ? !isRole
      : dialect === 'mysql'
        ? !isRole
        : !isRole &&
          (draft.auth === 'password' ||
            (draft.auth === 'login' && (creating ? draft.createLogin : !options.babelfish)))
  const passwordHint = creating
    ? dialect === 'postgres'
      ? 'Leave empty for roles that sign in another way (peer, certificate, IAM)'
      : undefined
    : dialect === 'tsql' && draft.auth === 'login'
      ? `Changes the password of the login ${draft.login || draft.original?.login}; leave empty to keep it`
      : 'Leave empty to keep the current password'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Name"
          className="min-w-48 flex-[2]"
          hint={
            !renamable
              ? "MySQL and MariaDB roles can't be renamed"
              : dialect === 'postgres' && !creating && draft.name !== draft.original?.name
                ? 'Renaming clears an MD5 password; SCRAM passwords are kept'
                : undefined
          }
        >
          <Input
            mono
            autoFocus
            value={draft.name}
            placeholder={isRole ? 'role_name' : 'user_name'}
            disabled={!renamable}
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>
        {hasHost && (
          <Field label="Host" className="min-w-32 flex-1" hint="'%' for any host">
            <Input
              mono
              value={draft.host}
              placeholder="%"
              onChange={(e) => set('host', e.target.value)}
            />
          </Field>
        )}
      </div>

      {dialect === 'tsql' && !isRole && (
        <TsqlUserFields
          draft={draft}
          set={set}
          options={options}
          logins={logins}
          schemas={schemas}
        />
      )}

      {dialect === 'tsql' && isRole && (
        <Field label="Owner" className="w-64" hint="Leave empty for you (the creator)">
          <Select
            selectClassName="font-mono text-xs"
            value={draft.owner}
            onChange={(e) => set('owner', e.target.value)}
          >
            <option value="">{draft.original?.owner || 'Default'}</option>
            {principals
              .filter((p) => p.name !== draft.original?.owner && p.name !== 'public')
              .map((p) => (
                <option key={principalKey(p)} value={p.name}>
                  {p.name}
                </option>
              ))}
          </Select>
        </Field>
      )}

      {hasPassword && (
        <Field label="Password" hint={passwordHint}>
          <Input
            mono
            type="password"
            autoComplete="new-password"
            value={draft.password}
            placeholder={creating ? '' : '••••••••'}
            onChange={(e) => set('password', e.target.value)}
          />
        </Field>
      )}

      {dialect === 'postgres' && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Toggle
            checked={draft.type === 'user'}
            onChange={(on) => set('type', on ? 'user' : 'role')}
            label="Can log in"
            description="LOGIN: a user rather than a group role"
          />
          <Toggle
            checked={draft.inherit}
            onChange={(on) => set('inherit', on)}
            label="Inherit privileges"
            description="INHERIT: uses its roles' privileges without SET ROLE"
          />
          <Toggle
            checked={draft.createDb}
            onChange={(on) => set('createDb', on)}
            label="Create databases"
            description="CREATEDB"
          />
          <Toggle
            checked={draft.createRole}
            onChange={(on) => set('createRole', on)}
            label="Create roles"
            description="CREATEROLE: create, change and drop other roles"
          />
          <Toggle
            checked={draft.replication}
            onChange={(on) => set('replication', on)}
            label="Replication"
            description="REPLICATION: streaming replication and backups"
          />
          <Toggle
            checked={draft.bypassRls}
            onChange={(on) => set('bypassRls', on)}
            label="Bypass row-level security"
            description="BYPASSRLS"
          />
          <Toggle
            checked={draft.superuser}
            onChange={(on) => set('superuser', on)}
            label="Superuser"
            description="SUPERUSER: bypasses every permission check"
          />
        </div>
      )}

      {dialect === 'mysql' && !isRole && (
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Toggle
            checked={draft.locked}
            onChange={(on) => set('locked', on)}
            label="Account locked"
            description="ACCOUNT LOCK: can't sign in until unlocked"
          />
          <Toggle
            checked={draft.expirePassword}
            onChange={(on) => set('expirePassword', on)}
            label="Expire password"
            description="PASSWORD EXPIRE: must pick a new one at the next sign-in"
          />
        </div>
      )}

      {(dialect === 'postgres' || (dialect === 'mysql' && !isRole)) && (
        <div className="flex flex-wrap gap-3">
          <Field
            label={dialect === 'postgres' ? 'Connection limit' : 'Max connections'}
            className="w-44"
            hint="Empty for unlimited"
          >
            <Input
              mono
              inputMode="numeric"
              value={draft.connectionLimit}
              onChange={(e) => set('connectionLimit', e.target.value)}
            />
          </Field>
          {dialect === 'postgres' && (
            <Field label="Password valid until" className="w-64" hint="Empty for no expiry">
              <Input
                mono
                value={draft.validUntil}
                placeholder="2027-12-31 23:59:59+00"
                onChange={(e) => set('validUntil', e.target.value)}
              />
            </Field>
          )}
        </div>
      )}
    </div>
  )
}

function TsqlUserFields({
  draft,
  set,
  options,
  logins,
  schemas
}: {
  draft: PrincipalDraft
  set: <K extends keyof PrincipalDraft>(key: K, value: PrincipalDraft[K]) => void
  options: PrincipalOptions
  logins: string[]
  schemas: string[]
}): React.JSX.Element {
  const creating = !draft.original
  const methods = options.babelfish ? TSQL_AUTH.filter((a) => a.value === 'login') : TSQL_AUTH
  const method = TSQL_AUTH.find((a) => a.value === draft.auth)
  const newLogin = creating && draft.createLogin
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Authentication" className="w-64" hint={creating ? method?.hint : undefined}>
          <Select
            value={draft.auth}
            disabled={!creating}
            onChange={(e) => set('auth', e.target.value as TsqlAuth)}
          >
            {methods.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default schema" className="min-w-40 flex-1">
          <Select
            selectClassName="font-mono text-xs"
            value={draft.defaultSchema}
            onChange={(e) => set('defaultSchema', e.target.value)}
          >
            <option value="">dbo (default)</option>
            {schemas
              .filter((s) => s !== 'dbo')
              .map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      {draft.auth === 'login' && (
        <div className="space-y-3">
          {creating && (
            <Toggle
              checked={draft.createLogin}
              onChange={(on) => set('createLogin', on)}
              label="Create a new SQL login"
              description="CREATE LOGIN with the password below, then a user for it"
            />
          )}
          <Field label="Login" className="w-80">
            {newLogin ? (
              <Input
                mono
                value={draft.login}
                placeholder={draft.name || 'login_name'}
                onChange={(e) => set('login', e.target.value)}
              />
            ) : (
              <Select
                selectClassName="font-mono text-xs"
                value={draft.login}
                onChange={(e) => set('login', e.target.value)}
              >
                <option value="">Choose…</option>
                {[...new Set([...(draft.login ? [draft.login] : []), ...logins])].map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      )}
    </div>
  )
}

function DropNotes({
  dialect,
  database,
  principal,
  state,
  memberCount,
  dropOwned,
  onDropOwned,
  dropLogin,
  onDropLogin
}: {
  dialect: Dialect
  database: string
  principal: Principal
  state: PrincipalState
  memberCount: number
  dropOwned: boolean
  onDropOwned: (on: boolean) => void
  dropLogin: boolean
  onDropLogin: (on: boolean) => void
}): React.JSX.Element {
  const label = <span className="font-mono text-bright">{principalLabel(principal)}</span>
  return (
    <div className="space-y-3 text-[13px] text-fg">
      {dialect === 'postgres' ? (
        <>
          <p>
            Dropping {label} removes its memberships and the privileges granted to it. It fails
            while {label} owns objects or holds privileges in another database.
          </p>
          <Toggle
            checked={dropOwned}
            onChange={onDropOwned}
            label={`Drop what it owns in ${database} first (DROP OWNED)`}
            description="Drops its objects in this database and revokes its privileges here"
          />
        </>
      ) : dialect === 'mysql' ? (
        <p>
          Dropping {label} removes the account and every privilege granted to it. Sessions already
          signed in as it keep running until they disconnect.
        </p>
      ) : principal.kind === 'role' ? (
        <p>
          Dropping {label} removes it from {database}
          {memberCount > 0 && <> and first takes its {memberCount} members out of it</>}. It fails
          while the role owns a schema or other objects.
        </p>
      ) : (
        <>
          <p>
            Dropping {label} removes the user from {database}. It fails while the user owns a schema
            or other objects.
          </p>
          {state.login && (
            <Toggle
              checked={dropLogin}
              onChange={onDropLogin}
              label={`Also drop the login ${state.login}`}
              description="Removes the server login, which other databases' users may map to"
            />
          )}
        </>
      )}
    </div>
  )
}
