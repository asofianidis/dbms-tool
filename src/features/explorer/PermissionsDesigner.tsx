import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FilePlus2, Save } from 'lucide-react'
import { api, type Cell } from '@/lib/api'
import { ddlScript, draftId } from '@/lib/ddl'
import { cn } from '@/lib/cn'
import { ENGINES, type Dialect } from '@/lib/engines'
import {
  PUBLIC_PRINCIPAL,
  SECURABLE_LABELS,
  defaultsQuery,
  grantQuery,
  grantStatements,
  isBulkKind,
  isObjectKind,
  levelOf,
  membershipQueries,
  membershipStatements,
  needsContainer,
  objectSecurableKind,
  parseDefaultRows,
  parseGrantRows,
  parseMembershipRows,
  parsePrincipals,
  principalKey,
  principalLabel,
  principalQueries,
  privilegeOptions,
  securableComplete,
  securableKinds,
  securableLabel,
  validateGrant,
  type GrantLevel,
  type GrantMap,
  type GrantState,
  type Principal,
  type Securable,
  type SecurableKind
} from '@/lib/grants'
import { knownMariaDb } from '@/lib/mariadb'
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
  Modal,
  Segmented,
  Select,
  Spinner,
  Toggle
} from '@/components/ui'

interface Request {
  connectionId: string
  /** Database the catalog queries and statements run in */
  database: string
  /** What to open on; null for the database */
  securable: Securable | null
  /** principalKey of the user or role to open on */
  grantee: string | null
}

const permissionsDesignerStore = createStore<Request | null>(null)

export function openPermissionsDesigner(
  connectionId: string,
  database: string,
  securable: Securable | null = null,
  grantee: string | null = null
): void {
  permissionsDesignerStore.set({ connectionId, database, securable, grantee })
}

const close = (): void => permissionsDesignerStore.set(null)

export function PermissionsDesignerHost(): React.JSX.Element | null {
  const request = permissionsDesignerStore.use()
  if (!request) return null
  return (
    <PermissionsDesigner
      key={`${request.connectionId}/${request.database}/${JSON.stringify(request.securable)}/${request.grantee}`}
      {...request}
    />
  )
}

/** Runs catalog queries on the metadata session until one succeeds, and returns its rows. */
async function firstRows(
  connectionId: string,
  database: string,
  sqls: string[]
): Promise<Cell[][]> {
  let error: Error | null = null
  for (const sql of sqls) {
    const out = await api.execute(connectionId, '__meta', database, sql)
    if (!out.error) return out.results[0]?.rows ?? []
    error = new Error(out.error.message)
  }
  throw error ?? new Error('No catalog query to run')
}

function databaseSecurable(dialect: Dialect, database: string): Securable {
  return dialect === 'mysql' && !database
    ? { kind: 'server', schema: null, name: null, args: null }
    : { kind: 'database', schema: null, name: database, args: null }
}

type Mode = 'privileges' | 'membership'

/** Edits made to a loaded state, kept only while the grantee and securable stay the same. */
interface Edits<T> {
  key: string
  state: T
}

const checkbox = 'size-3.5 accent-accent disabled:opacity-40'

function Check({
  checked,
  indeterminate,
  disabled,
  title,
  onChange
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  title?: string
  onChange: () => void
}): React.JSX.Element {
  return (
    <input
      type="checkbox"
      className={checkbox}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate
      }}
      checked={checked}
      disabled={disabled}
      title={title}
      onChange={onChange}
    />
  )
}

const isHeld = (level: GrantLevel): boolean => level === 'grant' || level === 'grantable'

function PermissionsDesigner(request: Request): React.JSX.Element {
  const { connectionId, database } = request
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const dialect: Dialect = (connection && ENGINES[connection.engine].dialect) || 'postgres'
  // Babelfish has no DENY
  const canDeny = dialect === 'tsql' && connection?.engine !== 'babelfish'

  const mariadb = knownMariaDb(statusStore.use()[connectionId])
  const principals = useQuery({
    queryKey: ['conn', connectionId, 'principals', database],
    queryFn: async () => {
      const list = parsePrincipals(
        await firstRows(connectionId, database, principalQueries(dialect, mariadb))
      )
      return dialect === 'postgres' ? [PUBLIC_PRINCIPAL, ...list] : list
    },
    staleTime: 0
  })
  const [granteeKey, setGranteeKey] = useState(request.grantee)
  const grantee = principals.data?.find((p) => principalKey(p) === granteeKey) ?? null
  const [securable, setSecurable] = useState<Securable>(
    request.securable ?? databaseSecurable(dialect, database)
  )
  const [mode, setMode] = useState<Mode>('privileges')
  const canJoinRoles = !!grantee && grantee.kind !== 'public'
  const activeMode: Mode = canJoinRoles ? mode : 'privileges'

  const ready = !!grantee && securableComplete(dialect, securable)
  const grantsKey = ['conn', connectionId, 'grants', database, granteeKey, securable] as const
  const grants = useQuery({
    queryKey: grantsKey,
    enabled: ready && activeMode === 'privileges',
    queryFn: async (): Promise<GrantState> => {
      const defaults = dialect === 'postgres' ? defaultsQuery(grantee!, securable) : null
      const [rows, defaultRows] = await Promise.all([
        firstRows(connectionId, database, [grantQuery(dialect, grantee!, securable)]),
        defaults ? firstRows(connectionId, database, [defaults]) : Promise.resolve([])
      ])
      return {
        ...parseGrantRows(dialect, securable, rows),
        defaults: parseDefaultRows(defaultRows)
      }
    },
    staleTime: 0
  })
  const membersKey = ['conn', connectionId, 'memberships', database, granteeKey] as const
  const memberships = useQuery({
    queryKey: membersKey,
    enabled: canJoinRoles && activeMode === 'membership',
    queryFn: async () =>
      parseMembershipRows(
        await firstRows(connectionId, database, membershipQueries(dialect, grantee!))
      ),
    staleTime: 0
  })

  const grantEditKey = JSON.stringify([granteeKey, securable])
  const [grantEdits, setGrantEdits] = useState<Edits<GrantState> | null>(null)
  const original = grants.data
  const draft = grantEdits?.key === grantEditKey ? grantEdits.state : original
  const editGrants = (fn: (s: GrantState) => GrantState): void => {
    if (draft) setGrantEdits({ key: grantEditKey, state: fn(draft) })
  }

  const [memberEdits, setMemberEdits] = useState<Edits<GrantMap> | null>(null)
  const memberOriginal = memberships.data
  const memberDraft = memberEdits?.key === granteeKey ? memberEdits.state : memberOriginal
  const roles = roleCandidates(dialect, principals.data ?? [], grantee, memberOriginal ?? {})

  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const statements = !grantee
    ? []
    : activeMode === 'privileges'
      ? original && draft && ready
        ? grantStatements(dialect, grantee, securable, original, draft)
        : []
      : memberOriginal && memberDraft
        ? membershipStatements(dialect, grantee, roles, memberOriginal, memberDraft)
        : []
  const script = ddlScript(dialect, statements)
  const problem =
    activeMode === 'privileges' && draft
      ? validateGrant(dialect, grantee, securable, draft)
      : grantee
        ? null
        : 'Pick a user or role'

  const apply = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    const session = `designer-${draftId()}`
    try {
      const out = await api.execute(connectionId, session, database, script)
      if (out.error) throw new Error(out.error.message)
      toast(
        activeMode === 'privileges'
          ? `Updated ${principalLabel(grantee!)}'s privileges on ${securableLabel(securable)}`
          : `Updated ${principalLabel(grantee!)}'s roles`
      )
      // Stay open on the fresh state so more can be granted
      setGrantEdits(null)
      setMemberEdits(null)
      await queryClient.invalidateQueries({ queryKey: ['conn', connectionId, 'grants'] })
      await queryClient.invalidateQueries({ queryKey: ['conn', connectionId, 'memberships'] })
    } catch (e) {
      setError(errorMessage(e))
      // XACT_ABORT doesn't roll back after every error, which can leave the transaction open
      if (dialect === 'tsql') {
        await api
          .execute(connectionId, session, database, 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;')
          .catch(() => undefined)
      }
    } finally {
      setRunning(false)
      void api.closeSession(connectionId, session).catch(() => undefined)
    }
  }

  return (
    <Modal
      width="xl"
      title="Permissions"
      description={
        <span className="font-mono">
          {connection?.name || connection?.host}
          {database && ` / ${database}`}
        </span>
      }
      onClose={close}
      footer={
        <>
          {problem && <span className="mr-auto text-xs text-danger">{problem}</span>}
          {connection?.readOnly && <Badge tone="warning">read-only connection</Badge>}
          <Button
            variant="secondary"
            disabled={!script || !!problem}
            onClick={() => {
              newQueryTab(connectionId, database, script)
              close()
            }}
          >
            <FilePlus2 className="size-3.5" /> Open in editor
          </Button>
          <Button
            variant="primary"
            disabled={!script || !!problem || running || connection?.readOnly}
            onClick={() => void apply()}
          >
            {running ? <Spinner className="text-current" /> : <Save className="size-3.5" />}
            Apply changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="User or role" className="min-w-56 flex-1">
            <GranteePicker
              principals={principals.data}
              loading={principals.isPending}
              value={granteeKey}
              onChange={setGranteeKey}
            />
          </Field>
          {canJoinRoles && (
            <Segmented
              className="mb-0.5 h-8"
              value={activeMode}
              options={[
                { value: 'privileges', label: 'Privileges' },
                { value: 'membership', label: 'Role membership' }
              ]}
              onChange={setMode}
            />
          )}
        </div>
        {principals.isError && <ErrorText error={principals.error} />}

        {activeMode === 'privileges' ? (
          <>
            <SecurablePicker
              connectionId={connectionId}
              database={database}
              dialect={dialect}
              value={securable}
              onChange={setSecurable}
            />
            {!grantee ? (
              <Hint>Pick who to grant privileges to.</Hint>
            ) : !ready ? (
              <Hint>Pick what to grant privileges on.</Hint>
            ) : grants.isError ? (
              <ErrorText error={grants.error} />
            ) : !original || !draft ? (
              <Loading />
            ) : (
              <PrivilegeMatrix
                dialect={dialect}
                kind={securable.kind}
                canDeny={canDeny}
                original={original}
                draft={draft}
                onChange={editGrants}
                granteeLabel={principalLabel(grantee)}
                schema={securable.schema}
              />
            )}
          </>
        ) : memberships.isError ? (
          <ErrorText error={memberships.error} />
        ) : !memberOriginal || !memberDraft ? (
          <Loading />
        ) : (
          <MembershipList
            dialect={dialect}
            roles={roles}
            original={memberOriginal}
            draft={memberDraft}
            onChange={(state) => setMemberEdits({ key: granteeKey ?? '', state })}
          />
        )}

        {statements.some((s) => / CASCADE$/.test(s)) && (
          <p className="text-xs text-warn">
            Revoking a grant option also revokes what {grantee && principalLabel(grantee)} granted
            to others from it (CASCADE).
          </p>
        )}
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
            <ErrorText error={error} />
          </div>
        )}
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-muted">Statements</p>
          <div className="h-32 overflow-hidden rounded-lg border border-line bg-canvas">
            <CodeEditor
              value={script || '-- No changes'}
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

export function Hint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-muted">
      {children}
    </p>
  )
}

export function Loading(): React.JSX.Element {
  return (
    <div className="flex justify-center py-6">
      <Spinner className="size-5" />
    </div>
  )
}

const GRANTEE_GROUPS: { label: string; match: (p: Principal) => boolean }[] = [
  { label: 'Roles', match: (p) => !p.builtin && p.kind === 'role' },
  { label: 'Users', match: (p) => !p.builtin && p.kind === 'user' },
  { label: 'Groups', match: (p) => !p.builtin && p.kind === 'group' },
  { label: 'Built-in', match: (p) => p.builtin }
]

function GranteePicker({
  principals,
  loading,
  value,
  onChange
}: {
  principals: Principal[] | undefined
  loading: boolean
  value: string | null
  onChange: (key: string | null) => void
}): React.JSX.Element {
  return (
    <Select
      selectClassName="font-mono text-xs"
      value={value ?? ''}
      disabled={loading}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{loading ? 'Loading…' : 'Choose…'}</option>
      {GRANTEE_GROUPS.map((group) => {
        const members = (principals ?? []).filter(group.match)
        if (!members.length) return null
        return (
          <optgroup key={group.label} label={group.label}>
            {members.map((p) => (
              <option key={principalKey(p)} value={principalKey(p)}>
                {principalLabel(p)}
              </option>
            ))}
          </optgroup>
        )
      })}
    </Select>
  )
}

function SecurablePicker({
  connectionId,
  database,
  dialect,
  value,
  onChange
}: {
  connectionId: string
  database: string
  dialect: Dialect
  value: Securable
  onChange: (s: Securable) => void
}): React.JSX.Element {
  const container = needsContainer(dialect, value.kind)
  const pickDatabase = dialect === 'mysql' && value.kind === 'database'
  const objectKind = isObjectKind(value.kind)
  // MySQL schemas are databases
  const databases = useQuery({
    ...queries.databases(connectionId),
    enabled: dialect === 'mysql' && (container || pickDatabase)
  })
  const schemas = useQuery({
    ...queries.schemas(connectionId, database),
    enabled: dialect !== 'mysql' && container
  })
  const containers =
    dialect === 'mysql'
      ? (databases.data ?? []).filter((d) => !d.isSystem || d.name === value.schema)
      : (schemas.data ?? []).filter((s) => !s.isSystem || s.name === value.schema)
  // SQL Server lists every schema's objects at once
  const objectScope =
    dialect === 'mysql'
      ? { database: value.schema ?? '', schema: null }
      : { database, schema: dialect === 'tsql' ? null : value.schema }
  const objects = useQuery({
    ...queries.objects(connectionId, objectScope.database, objectScope.schema),
    enabled: objectKind && (dialect === 'tsql' || !!value.schema)
  })
  const matching = (objects.data ?? []).filter(
    (o) => objectSecurableKind(dialect, o.kind) === value.kind
  )
  const objectKey = (schema: string | null, name: string | null, args: string | null): string =>
    JSON.stringify([schema, name, args])
  const routineArgs = (detail: string | null, kind: SecurableKind): string | null =>
    dialect === 'postgres' && (kind === 'function' || kind === 'procedure') ? (detail ?? '') : null

  // Kept when switching kinds; on MySQL it's the database, whichever field holds it
  const current =
    dialect === 'mysql'
      ? (value.schema ?? (value.kind === 'database' ? value.name : null) ?? (database || null))
      : value.schema
  const setKind = (kind: SecurableKind): void => {
    const base: Securable = { kind, schema: null, name: null, args: null }
    if (kind === 'database') onChange({ ...base, name: dialect === 'mysql' ? current : database })
    else if (needsContainer(dialect, kind)) onChange({ ...base, schema: current })
    else onChange(base)
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="On" className="w-52">
        <Select value={value.kind} onChange={(e) => setKind(e.target.value as SecurableKind)}>
          {securableKinds(dialect).map((k) => (
            <option key={k} value={k}>
              {SECURABLE_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      {value.kind === 'database' && !pickDatabase && (
        <Field label="Database" className="min-w-40 flex-1">
          <p className="flex h-8 items-center font-mono text-xs text-bright">{value.name}</p>
        </Field>
      )}
      {(container || pickDatabase) && (
        <Field label={dialect === 'mysql' ? 'Database' : 'Schema'} className="min-w-40 flex-1">
          <Select
            selectClassName="font-mono text-xs"
            value={(pickDatabase ? value.name : value.schema) ?? ''}
            onChange={(e) => {
              const picked = e.target.value || null
              onChange(
                pickDatabase
                  ? { ...value, name: picked }
                  : { ...value, schema: picked, name: null, args: null }
              )
            }}
          >
            <option value="">Choose…</option>
            {containers.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {objectKind && (
        <Field label={SECURABLE_LABELS[value.kind]} className="min-w-48 flex-[2]">
          <Select
            selectClassName="font-mono text-xs"
            value={value.name === null ? '' : objectKey(value.schema, value.name, value.args)}
            disabled={dialect !== 'tsql' && !value.schema}
            onChange={(e) => {
              if (!e.target.value) return onChange({ ...value, name: null, args: null })
              const [schema, name, args] = JSON.parse(e.target.value) as [
                string | null,
                string,
                string | null
              ]
              onChange({ ...value, schema, name, args })
            }}
          >
            <option value="">
              {objects.isFetching ? 'Loading…' : matching.length ? 'Choose…' : 'None found'}
            </option>
            {matching.map((o) => {
              const schema = dialect === 'mysql' ? value.schema : o.schema
              const args = routineArgs(o.detail, value.kind)
              return (
                <option
                  key={objectKey(schema, o.name, args)}
                  value={objectKey(schema, o.name, args)}
                >
                  {dialect === 'tsql' ? `${o.schema}.${o.name}` : o.name}
                  {args !== null && `(${args})`}
                </option>
              )
            })}
          </Select>
        </Field>
      )}
    </div>
  )
}

function PrivilegeMatrix({
  dialect,
  kind,
  canDeny,
  original,
  draft,
  onChange,
  granteeLabel,
  schema
}: {
  dialect: Dialect
  kind: SecurableKind
  canDeny: boolean
  original: GrantState
  draft: GrantState
  onChange: (fn: (s: GrantState) => GrantState) => void
  granteeLabel: string
  schema: string | null
}): React.JSX.Element {
  const options = privilegeOptions(dialect, kind, original)
  // MySQL's grant option covers the whole level, so it's one toggle below the list
  const perPrivilegeOption = dialect !== 'mysql'
  const future = dialect === 'postgres' && isBulkKind(kind)
  const setLevel = (p: string, level: GrantLevel): void =>
    onChange((s) => ({ ...s, privileges: { ...s.privileges, [p]: level } }))
  const setDefault = (p: string, level: GrantLevel): void =>
    onChange((s) => ({ ...s, defaults: { ...s.defaults, [p]: level } }))
  const allHeld = options.every((p) => isHeld(levelOf(draft.privileges, p)))
  const allFuture = options.every((p) => isHeld(levelOf(draft.defaults, p)))
  const grid = cn(
    'grid items-center gap-x-3 px-2',
    future
      ? 'grid-cols-[12px_minmax(0,1fr)_72px_120px_96px]'
      : canDeny
        ? 'grid-cols-[12px_minmax(0,1fr)_72px_120px_56px]'
        : perPrivilegeOption
          ? 'grid-cols-[12px_minmax(0,1fr)_72px_120px]'
          : 'grid-cols-[12px_minmax(0,1fr)_72px]'
  )

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line">
        <div
          className={cn(
            grid,
            'h-8 border-b border-line text-[11px] font-medium text-muted [&>span]:text-center'
          )}
        >
          <span />
          <span className="!text-left">Privilege</span>
          <span className="flex items-center justify-center gap-1.5">
            <Check
              checked={allHeld}
              title={allHeld ? 'Revoke all' : 'Grant all'}
              onChange={() =>
                onChange((s) => ({
                  ...s,
                  privileges: Object.fromEntries(
                    options.map((p) => [p, allHeld ? 'none' : 'grant'] as const)
                  )
                }))
              }
            />
            Grant
          </span>
          {perPrivilegeOption && <span>With grant option</span>}
          {canDeny && !future && <span>Deny</span>}
          {future && (
            <span className="flex items-center justify-center gap-1.5">
              <Check
                checked={allFuture}
                onChange={() =>
                  onChange((s) => ({
                    ...s,
                    defaults: Object.fromEntries(
                      options.map((p) => [p, allFuture ? 'none' : 'grant'] as const)
                    )
                  }))
                }
              />
              Future objects
            </span>
          )}
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {options.map((p) => {
            const level = levelOf(draft.privileges, p)
            const futureLevel = levelOf(draft.defaults, p)
            const changed =
              level !== levelOf(original.privileges, p) ||
              futureLevel !== levelOf(original.defaults, p)
            return (
              <div key={p} className={cn(grid, 'h-7 rounded-md hover:bg-hover/50')}>
                <span
                  className={cn(
                    'size-1.5 justify-self-center rounded-full',
                    changed ? 'bg-warn' : 'bg-line-strong'
                  )}
                />
                <span
                  className={cn(
                    'truncate font-mono text-xs',
                    level === 'deny' ? 'text-danger' : isHeld(level) ? 'text-bright' : 'text-fg'
                  )}
                >
                  {p}
                </span>
                <span className="flex justify-center">
                  <Check
                    checked={isHeld(level)}
                    indeterminate={level === 'partial'}
                    title={
                      level === 'partial'
                        ? 'Held on some objects in the schema; leave it to keep them as they are'
                        : undefined
                    }
                    onChange={() => setLevel(p, isHeld(level) ? 'none' : 'grant')}
                  />
                </span>
                {perPrivilegeOption && (
                  <span className="flex justify-center">
                    <Check
                      checked={level === 'grantable'}
                      onChange={() => setLevel(p, level === 'grantable' ? 'grant' : 'grantable')}
                    />
                  </span>
                )}
                {canDeny && !future && (
                  <span className="flex justify-center">
                    <Check
                      checked={level === 'deny'}
                      onChange={() => setLevel(p, level === 'deny' ? 'none' : 'deny')}
                    />
                  </span>
                )}
                {future && (
                  <span className="flex justify-center">
                    <Check
                      checked={isHeld(futureLevel)}
                      onChange={() => setDefault(p, isHeld(futureLevel) ? 'none' : 'grant')}
                    />
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {!perPrivilegeOption && (
        <Toggle
          checked={draft.grantOption}
          onChange={(grantOption) => onChange((s) => ({ ...s, grantOption }))}
          label="With grant option"
          description={`Lets ${granteeLabel} grant their privileges at this level to others`}
        />
      )}
      {future && (
        <p className="text-[11px] text-faint">
          The schema&apos;s existing objects get the granted privileges. Future objects sets default
          privileges for objects you create in {schema} from now on.
        </p>
      )}
      {canDeny && (
        <p className="text-[11px] text-faint">
          A deny wins over a grant, including one held through a role.
        </p>
      )}
    </div>
  )
}

/** The roles the grantee could join, plus any they're already in. */
export function roleCandidates(
  dialect: Dialect,
  principals: Principal[],
  grantee: Principal | null,
  held: GrantMap
): Principal[] {
  if (!grantee) return []
  const self = principalKey(grantee)
  const others = principals.filter((p) => p.kind !== 'public' && principalKey(p) !== self)
  const roles = others.filter((p) => {
    if (principalKey(p) in held) return true
    if (dialect === 'tsql') return p.kind === 'role' && p.name !== 'public'
    if (dialect === 'mysql') return p.kind === 'role'
    return p.kind === 'role' || p.builtin
  })
  // MySQL 8 can grant any account as a role; without flagged roles, offer them all
  const list = dialect === 'mysql' && !roles.length ? others.filter((p) => !p.builtin) : roles
  return [...list.filter((p) => !p.builtin), ...list.filter((p) => p.builtin)]
}

/** Checkboxes for role memberships, keyed by principalKey of each listed principal. */
export function MembershipList({
  dialect,
  roles,
  original,
  draft,
  onChange,
  label = 'Role',
  empty = 'There are no roles to join.'
}: {
  dialect: Dialect
  roles: Principal[]
  original: GrantMap
  draft: GrantMap
  onChange: (state: GrantMap) => void
  /** Heading of the name column */
  label?: string
  empty?: string
}): React.JSX.Element {
  const admin = dialect !== 'tsql'
  const grid = cn(
    'grid items-center gap-x-3 px-2',
    admin ? 'grid-cols-[12px_minmax(0,1fr)_72px_104px]' : 'grid-cols-[12px_minmax(0,1fr)_72px]'
  )
  if (!roles.length) return <Hint>{empty}</Hint>
  return (
    <div className="rounded-lg border border-line">
      <div
        className={cn(
          grid,
          'h-8 border-b border-line text-[11px] font-medium text-muted [&>span]:text-center'
        )}
      >
        <span />
        <span className="!text-left">{label}</span>
        <span>Member</span>
        {admin && <span>Admin option</span>}
      </div>
      <div className="max-h-80 overflow-y-auto py-1">
        {roles.map((role) => {
          const key = principalKey(role)
          const level = levelOf(draft, key)
          return (
            <div key={key} className={cn(grid, 'h-7 rounded-md hover:bg-hover/50')}>
              <span
                className={cn(
                  'size-1.5 justify-self-center rounded-full',
                  level !== levelOf(original, key) ? 'bg-warn' : 'bg-line-strong'
                )}
              />
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'truncate font-mono text-xs',
                    isHeld(level) ? 'text-bright' : 'text-fg'
                  )}
                >
                  {principalLabel(role)}
                </span>
                {role.builtin && <Badge>built-in</Badge>}
                {role.kind === 'user' && dialect === 'postgres' && <Badge>login</Badge>}
              </span>
              <span className="flex justify-center">
                <Check
                  checked={isHeld(level)}
                  onChange={() => onChange({ ...draft, [key]: isHeld(level) ? 'none' : 'grant' })}
                />
              </span>
              {admin && (
                <span className="flex justify-center">
                  <Check
                    checked={level === 'grantable'}
                    onChange={() =>
                      onChange({ ...draft, [key]: level === 'grantable' ? 'grant' : 'grantable' })
                    }
                  />
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
