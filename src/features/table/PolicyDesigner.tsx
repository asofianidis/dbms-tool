import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, FilePlus2, Save, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { catalogQueries } from '@/lib/catalog'
import { cn } from '@/lib/cn'
import { ddlScript, draftId } from '@/lib/ddl'
import {
  POLICY_COMMANDS,
  PUBLIC_ROLE,
  dropPolicyStatement,
  newPolicyDraft,
  policyDraftFrom,
  policyStatements,
  rlsQueries,
  takesUsing,
  takesWithCheck,
  validatePolicy,
  type PolicyDraft,
  type TableRls
} from '@/lib/rls'
import type { TableRef } from '@/lib/sql'
import { createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import { connectionsStore, newQueryTab, refreshConnection } from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { Badge, Button, ErrorText, Field, Input, Modal, Segmented, Spinner } from '@/components/ui'

interface Request {
  connectionId: string
  database: string
  schema: string | null
  table: string
  /** Policy to modify; null to create one */
  policy: string | null
  /** Open straight on the drop confirmation */
  drop?: boolean
}

const policyDesignerStore = createStore<Request | null>(null)

/** Creates, edits or drops a PostgreSQL row-level security policy. */
export function openPolicyDesigner(
  connectionId: string,
  database: string,
  schema: string | null,
  table: string,
  policy: string | null = null,
  drop = false
): void {
  policyDesignerStore.set({ connectionId, database, schema, table, policy, drop })
}

const close = (): void => policyDesignerStore.set(null)

export function PolicyDesignerHost(): React.JSX.Element | null {
  const request = policyDesignerStore.use()
  if (!request) return null
  return (
    <PolicyDesigner
      key={`${request.connectionId}/${request.database}/${request.schema}.${request.table}/${request.policy}/${request.drop}`}
      {...request}
    />
  )
}

function PolicyDesigner(request: Request): React.JSX.Element {
  const { connectionId, database, schema, table, policy } = request
  const rls = useQuery({ ...rlsQueries.table(connectionId, database, schema, table), staleTime: 0 })
  const roles = useQuery(catalogQueries.principals(connectionId, 'postgres', database))
  const existing = policy === null ? null : rls.data?.policies.find((p) => p.name === policy)
  const missing = !!rls.data && policy !== null && !existing
  // Wait for the fresh fetch only; later refetches mustn't unmount the form and lose edits
  if (!rls.isFetchedAfterMount || !rls.data || missing || roles.isPending) {
    return (
      <Modal width="sm" title={policy ?? 'New policy'} onClose={close}>
        {rls.isError ? (
          <ErrorText error={rls.error} />
        ) : missing ? (
          <p className="text-[13px] text-fg">The policy {policy} no longer exists.</p>
        ) : (
          <div className="flex justify-center py-6">
            <Spinner className="size-5" />
          </div>
        )}
      </Modal>
    )
  }
  // Without access to pg_roles the form still works with PUBLIC and the policy's own roles
  const names = (roles.data ?? []).filter((r) => !r.builtin).map((r) => r.name)
  return (
    <PolicyForm
      request={request}
      rls={rls.data}
      roles={names}
      initial={existing ? policyDraftFrom(existing) : newPolicyDraft()}
    />
  )
}

function PolicyForm({
  request,
  rls,
  roles,
  initial
}: {
  request: Request
  rls: TableRls
  roles: string[]
  initial: PolicyDraft
}): React.JSX.Element {
  const { connectionId, database } = request
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const target = useMemo<TableRef>(
    () => ({ schema: request.schema, name: request.table }),
    [request.schema, request.table]
  )
  const [draft, setDraft] = useState(initial)
  const [dropping, setDropping] = useState(!!request.drop && !!request.policy)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roleFilter, setRoleFilter] = useState('')
  const creating = !draft.original
  const tableLabel = target.schema ? `${target.schema}.${target.name}` : target.name
  const patch = (change: Partial<PolicyDraft>): void => setDraft((d) => ({ ...d, ...change }))

  const statements = useMemo(
    () =>
      dropping ? [dropPolicyStatement(target, request.policy!)] : policyStatements(target, draft),
    [dropping, target, request.policy, draft]
  )
  const script = ddlScript('postgres', statements)
  const problem = dropping
    ? null
    : validatePolicy(
        draft,
        rls.policies.map((p) => p.name)
      )
  const recreates = !creating && !dropping && /^DROP POLICY/.test(statements[0] ?? '')

  const apply = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    const session = `designer-${draftId()}`
    try {
      // Several statements run as one implicit transaction on PostgreSQL
      const out = await api.execute(connectionId, session, database, script)
      if (out.error) throw new Error(out.error.message)
      const name = draft.name.trim()
      toast(
        dropping
          ? `Dropped policy ${request.policy}`
          : creating
            ? `Created policy ${name}`
            : `Updated policy ${name}`
      )
      refreshConnection(connectionId)
      close()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRunning(false)
      void api.closeSession(connectionId, session).catch(() => undefined)
    }
  }

  // PUBLIC first, then every role, keeping selected ones even when they aren't listed
  const allRoles = [
    PUBLIC_ROLE,
    ...roles,
    ...draft.roles.filter((r) => r !== PUBLIC_ROLE && !roles.includes(r))
  ]
  const shownRoles = roleFilter
    ? allRoles.filter(
        (r) => draft.roles.includes(r) || r.toLowerCase().includes(roleFilter.toLowerCase())
      )
    : allRoles
  const toggleRole = (role: string): void =>
    setDraft((d) => {
      if (role === PUBLIC_ROLE) return { ...d, roles: [PUBLIC_ROLE] }
      const named = d.roles.filter((r) => r !== PUBLIC_ROLE)
      const next = named.includes(role) ? named.filter((r) => r !== role) : [...named, role]
      return { ...d, roles: next.length ? allRoles.filter((r) => next.includes(r)) : [PUBLIC_ROLE] }
    })

  const title = dropping
    ? `Drop policy ${request.policy}?`
    : creating
      ? 'New policy'
      : `Edit policy ${draft.original!.name}`

  return (
    <Modal
      width="xl"
      title={title}
      description={<span className="font-mono">{tableLabel}</span>}
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
              disabled={connection?.readOnly}
              onClick={() => setDropping(true)}
            >
              <Trash2 className="size-3.5" /> Drop policy…
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
            disabled={!script || !!problem}
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
            {dropping ? 'Drop policy' : creating ? 'Create policy' : 'Apply changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {dropping ? (
          <p className="text-[13px] text-fg">
            <span className="font-mono text-bright">{request.policy}</span> will stop applying to{' '}
            <span className="font-mono text-bright">{tableLabel}</span>.
            {rls.enabled &&
              rls.policies.length === 1 &&
              ' It is the only policy, so with row-level security on, only the owner and roles that bypass RLS will see rows.'}
          </p>
        ) : (
          <>
            {!rls.enabled && (
              <p className="text-xs text-warn">
                Row-level security is off for {tableLabel}, so policies don&apos;t apply until
                it&apos;s enabled.
              </p>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Name" className="min-w-48 flex-1">
                <Input
                  mono
                  value={draft.name}
                  placeholder="policy_name"
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field label="Type">
                <Segmented
                  className="h-8"
                  value={draft.permissive ? 'permissive' : 'restrictive'}
                  options={[
                    { value: 'permissive', label: 'permissive' },
                    { value: 'restrictive', label: 'restrictive' }
                  ]}
                  onChange={(v) => patch({ permissive: v === 'permissive' })}
                />
              </Field>
              <Field label="Command">
                <Segmented
                  className="h-8"
                  value={draft.command}
                  options={POLICY_COMMANDS.map((c) => ({ value: c, label: c.toLowerCase() }))}
                  onChange={(command) => patch({ command })}
                />
              </Field>
            </div>
            <Field
              label="Roles"
              hint={draft.roles.includes(PUBLIC_ROLE) ? 'PUBLIC applies to every role' : undefined}
            >
              <div className="space-y-1.5">
                {allRoles.length > 12 && (
                  <Input
                    value={roleFilter}
                    placeholder="Filter roles"
                    onChange={(e) => setRoleFilter(e.target.value)}
                  />
                )}
                <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
                  {shownRoles.map((r) => {
                    const on = draft.roles.includes(r)
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() => toggleRole(r)}
                        className={cn(
                          'h-6 rounded px-2 font-mono text-[11px] ring-1 ring-inset',
                          on
                            ? 'bg-accent/10 text-accent ring-accent/40'
                            : 'text-muted ring-line hover:text-bright'
                        )}
                      >
                        {r === PUBLIC_ROLE ? 'PUBLIC' : r}
                      </button>
                    )
                  })}
                </div>
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <ExpressionField
                label="USING (rows the policy lets the command see)"
                value={draft.using}
                disabled={!takesUsing(draft.command)}
                disabledNote="INSERT policies take only WITH CHECK."
                placeholder="owner = current_user"
                onChange={(using) => patch({ using })}
              />
              <ExpressionField
                label="WITH CHECK (rows the command may write)"
                value={draft.withCheck}
                disabled={!takesWithCheck(draft.command)}
                disabledNote={`${draft.command} policies take only USING.`}
                placeholder={
                  takesUsing(draft.command) ? 'Defaults to the USING expression' : 'true'
                }
                onChange={(withCheck) => patch({ withCheck })}
              />
            </div>
            {recreates && (
              <p className="text-xs text-warn">
                ALTER POLICY can&apos;t change the type or command, or remove an expression, so
                applying drops the policy and creates it again in one transaction.
              </p>
            )}
          </>
        )}
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
            <ErrorText error={error} />
          </div>
        )}
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-muted">Statements</p>
          <div className="h-36 overflow-hidden rounded-lg border border-line bg-canvas">
            <CodeEditor
              value={script || '-- No changes'}
              language={{ kind: 'sql', dialect: 'postgres' }}
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

function ExpressionField({
  label,
  value,
  disabled,
  disabledNote,
  placeholder,
  onChange
}: {
  label: string
  value: string
  disabled: boolean
  disabledNote: string
  placeholder: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[11px] font-medium text-muted">{label}</p>
      <div
        className={cn(
          'h-24 overflow-hidden rounded-lg border border-line bg-canvas',
          disabled && 'opacity-50'
        )}
      >
        <CodeEditor
          value={disabled ? '' : value}
          onChange={onChange}
          language={{ kind: 'sql', dialect: 'postgres' }}
          readOnly={disabled}
          lineNumbers={false}
          className="h-full"
          fontSize={12}
        />
      </div>
      <p className="mt-1 text-[11px] text-faint">
        {disabled ? disabledNote : `e.g. ${placeholder}`}
      </p>
    </div>
  )
}
