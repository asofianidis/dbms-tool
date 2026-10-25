import type { Cell } from './api'
import { catalogRows } from './catalog'
import { literal, qualified, quoteIdent, type TableRef } from './sql'

/**
 * PostgreSQL row-level security: a table's RLS flags (relrowsecurity,
 * relforcerowsecurity) and its policies (pg_policy), plus the statements the
 * explorer and the policy designer run. Everything here is PostgreSQL only.
 */

export type PolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'

export const POLICY_COMMANDS: PolicyCommand[] = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']

/** The role list entry that stands for PUBLIC (every role) */
export const PUBLIC_ROLE = 'public'

export interface PolicyState {
  name: string
  /** PERMISSIVE policies are ORed together; RESTRICTIVE ones are ANDed on top */
  permissive: boolean
  command: PolicyCommand
  /** Role names; [PUBLIC_ROLE] (or empty) applies to every role */
  roles: string[]
  /** USING expression; '' for none */
  using: string
  /** WITH CHECK expression; '' for none */
  withCheck: string
}

export interface RlsFlags {
  /** ENABLE ROW LEVEL SECURITY */
  enabled: boolean
  /** FORCE ROW LEVEL SECURITY: the owner is subject to the policies too */
  forced: boolean
}

export interface TableRls extends RlsFlags {
  policies: PolicyState[]
}

const text = (cell: Cell | undefined): string => (typeof cell === 'string' ? cell : '')
const flag = (cell: Cell | undefined): boolean => cell === true || cell === 't' || cell === 'y'

const COMMANDS: Record<string, PolicyCommand> = {
  '*': 'ALL',
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE'
}

const relation = (ref: TableRef): string =>
  `format('%I.%I', ${literal('postgres', ref.schema ?? 'public')}, ${literal('postgres', ref.name)})::regclass`

/** Every table in the database with RLS enabled or forced. Columns: schema, name, enabled, forced */
export const rlsTablesSql = `SELECT n.nspname::text, c.relname::text,
  CASE WHEN c.relrowsecurity THEN 'y' ELSE 'n' END,
  CASE WHEN c.relforcerowsecurity THEN 'y' ELSE 'n' END
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE (c.relrowsecurity OR c.relforcerowsecurity) AND c.relkind IN ('r', 'p')
ORDER BY 1, 2`

/** One table's flags. Columns: enabled, forced */
export function rlsFlagsSql(ref: TableRef): string {
  return `SELECT CASE WHEN relrowsecurity THEN 'y' ELSE 'n' END,
  CASE WHEN relforcerowsecurity THEN 'y' ELSE 'n' END
FROM pg_class WHERE oid = ${relation(ref)}`
}

/** A table's policies. Columns: name, permissive, command, roles (JSON), using, with check */
export function policiesSql(ref: TableRef): string {
  return `SELECT p.polname::text, CASE WHEN p.polpermissive THEN 'y' ELSE 'n' END, p.polcmd::text,
  array_to_json(ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END
    FROM unnest(p.polroles) r ORDER BY 1))::text,
  pg_get_expr(p.polqual, p.polrelid, true), pg_get_expr(p.polwithcheck, p.polrelid, true)
FROM pg_policy p WHERE p.polrelid = ${relation(ref)}
ORDER BY 1`
}

/** Keys are `schema.name` */
export function parseRlsTables(rows: Cell[][]): Map<string, RlsFlags> {
  return new Map(
    rows.map((r) => [`${text(r[0])}.${text(r[1])}`, { enabled: flag(r[2]), forced: flag(r[3]) }])
  )
}

export function parsePolicies(rows: Cell[][]): PolicyState[] {
  return rows.map((r) => {
    let roles: string[] = []
    try {
      roles = JSON.parse(text(r[3]) || '[]') as string[]
    } catch {
      roles = []
    }
    return {
      name: text(r[0]),
      permissive: flag(r[1]),
      command: COMMANDS[text(r[2])] ?? 'ALL',
      roles: roles.length ? roles : [PUBLIC_ROLE],
      using: text(r[4]),
      withCheck: text(r[5])
    }
  })
}

export async function loadTableRls(
  connectionId: string,
  database: string,
  ref: TableRef
): Promise<TableRls> {
  const [flags, policies] = await Promise.all([
    catalogRows(connectionId, database, [rlsFlagsSql(ref)]),
    catalogRows(connectionId, database, [policiesSql(ref)])
  ])
  return {
    enabled: flag(flags[0]?.[0]),
    forced: flag(flags[0]?.[1]),
    policies: parsePolicies(policies)
  }
}

/** Keyed under the connection's catalog so refreshConnection reloads them. */
export const rlsQueries = {
  /** RLS flags of every table in a database, for the explorer's badges */
  tables: (id: string, database: string) => ({
    queryKey: ['conn', id, 'catalog', database, 'rls'] as const,
    queryFn: async () => parseRlsTables(await catalogRows(id, database, [rlsTablesSql]))
  }),
  table: (id: string, database: string, schema: string | null, table: string) => ({
    queryKey: ['conn', id, 'catalog', database, 'policies', schema, table] as const,
    queryFn: () => loadTableRls(id, database, { schema, name: table })
  })
}

/** "on", "forced" or "off", as the structure view shows it */
export function rlsLabel(flags: RlsFlags): 'on' | 'forced' | 'off' {
  return flags.forced && flags.enabled ? 'forced' : flags.enabled ? 'on' : 'off'
}

/* ---------- Statements ---------- */

export type RlsAction = 'enable' | 'disable' | 'force' | 'noforce'

export function rlsStatement(ref: TableRef, action: RlsAction): string {
  const clause = {
    enable: 'ENABLE',
    disable: 'DISABLE',
    force: 'FORCE',
    noforce: 'NO FORCE'
  }[action]
  return `ALTER TABLE ${qualified('postgres', ref)} ${clause} ROW LEVEL SECURITY`
}

/** Whether a command's policies take a USING / WITH CHECK expression. */
export const takesUsing = (command: PolicyCommand): boolean => command !== 'INSERT'
export const takesWithCheck = (command: PolicyCommand): boolean =>
  command !== 'SELECT' && command !== 'DELETE'

function rolesSql(roles: string[]): string {
  const named = roles.filter((r) => r !== PUBLIC_ROLE)
  // PostgreSQL ignores other roles listed next to PUBLIC
  if (!named.length || named.length < roles.length) return 'PUBLIC'
  return named.map((r) => quoteIdent('postgres', r)).join(', ')
}

const isPublic = (roles: string[]): boolean => rolesSql(roles) === 'PUBLIC'

/** CREATE POLICY, leaving out the clauses that are the defaults. */
export function createPolicyStatement(ref: TableRef, p: PolicyState): string {
  const lines = [
    `CREATE POLICY ${quoteIdent('postgres', p.name.trim())} ON ${qualified('postgres', ref)}`
  ]
  if (!p.permissive) lines.push('  AS RESTRICTIVE')
  if (p.command !== 'ALL') lines.push(`  FOR ${p.command}`)
  if (!isPublic(p.roles)) lines.push(`  TO ${rolesSql(p.roles)}`)
  if (takesUsing(p.command) && p.using.trim()) lines.push(`  USING (${p.using.trim()})`)
  if (takesWithCheck(p.command) && p.withCheck.trim())
    lines.push(`  WITH CHECK (${p.withCheck.trim()})`)
  return lines.join('\n')
}

export function dropPolicyStatement(ref: TableRef, name: string): string {
  return `DROP POLICY ${quoteIdent('postgres', name)} ON ${qualified('postgres', ref)}`
}

export interface PolicyDraft extends PolicyState {
  /** The policy as loaded; null when creating one */
  original: PolicyState | null
}

export function newPolicyDraft(): PolicyDraft {
  return {
    name: '',
    permissive: true,
    command: 'ALL',
    roles: [PUBLIC_ROLE],
    using: '',
    withCheck: '',
    original: null
  }
}

export function policyDraftFrom(p: PolicyState): PolicyDraft {
  return { ...p, roles: [...p.roles], original: { ...p, roles: [...p.roles] } }
}

/** Expressions as they'd be applied: trimmed, and dropped where the command doesn't take them */
function effective(p: PolicyState): PolicyState {
  return {
    ...p,
    name: p.name.trim(),
    roles: isPublic(p.roles) ? [PUBLIC_ROLE] : [...p.roles].sort(),
    using: takesUsing(p.command) ? p.using.trim() : '',
    withCheck: takesWithCheck(p.command) ? p.withCheck.trim() : ''
  }
}

/**
 * Statements that turn the original policy into the draft: CREATE for a new one,
 * ALTER POLICY for roles, expressions and the name, and DROP + CREATE for what
 * ALTER POLICY can't change (PERMISSIVE/RESTRICTIVE, the command, or removing
 * an expression).
 */
export function policyStatements(ref: TableRef, draft: PolicyDraft): string[] {
  const next = effective(draft)
  if (!draft.original) return [createPolicyStatement(ref, next)]
  const prev = effective(draft.original)
  if (
    prev.permissive !== next.permissive ||
    prev.command !== next.command ||
    (prev.using && !next.using) ||
    (prev.withCheck && !next.withCheck)
  ) {
    return [dropPolicyStatement(ref, prev.name), createPolicyStatement(ref, next)]
  }
  const out: string[] = []
  const clauses: string[] = []
  if (prev.roles.join('\n') !== next.roles.join('\n')) clauses.push(`TO ${rolesSql(next.roles)}`)
  if (prev.using !== next.using) clauses.push(`USING (${next.using})`)
  if (prev.withCheck !== next.withCheck) clauses.push(`WITH CHECK (${next.withCheck})`)
  const target = `${quoteIdent('postgres', prev.name)} ON ${qualified('postgres', ref)}`
  if (clauses.length) out.push(`ALTER POLICY ${target}\n  ${clauses.join('\n  ')}`)
  if (prev.name !== next.name)
    out.push(`ALTER POLICY ${target} RENAME TO ${quoteIdent('postgres', next.name)}`)
  return out
}

export function validatePolicy(draft: PolicyDraft, existing: string[]): string | null {
  const name = draft.name.trim()
  if (!name) return 'Name the policy'
  if (name !== draft.original?.name && existing.includes(name))
    return `The table already has a policy named ${name}`
  return null
}

/**
 * RLS flags and policies as DDL that can follow a table's CREATE TABLE; empty
 * when RLS is off and there are no policies.
 */
export function rlsDdl(ref: TableRef, rls: TableRls): string[] {
  const out: string[] = []
  if (rls.enabled) out.push(rlsStatement(ref, 'enable'))
  if (rls.forced) out.push(rlsStatement(ref, 'force'))
  for (const p of rls.policies) out.push(createPolicyStatement(ref, p))
  return out
}
