import { describe, expect, it } from 'vitest'
import {
  createPolicyStatement,
  dropPolicyStatement,
  newPolicyDraft,
  parsePolicies,
  parseRlsTables,
  policiesSql,
  policyDraftFrom,
  policyStatements,
  rlsDdl,
  rlsFlagsSql,
  rlsLabel,
  rlsStatement,
  validatePolicy,
  type PolicyState
} from '../rls'

const docs = { schema: 'public', name: 'docs' }
const odd = { schema: 'App Data', name: 'Docs' }

const policy = (patch: Partial<PolicyState> = {}): PolicyState => ({
  name: 'own_rows',
  permissive: true,
  command: 'ALL',
  roles: ['public'],
  using: 'owner = CURRENT_USER',
  withCheck: '',
  ...patch
})

describe('catalog SQL', () => {
  it('targets the table by a quoted regclass', () => {
    expect(rlsFlagsSql(odd)).toContain("format('%I.%I', 'App Data', 'Docs')::regclass")
    expect(policiesSql(docs)).toContain("format('%I.%I', 'public', 'docs')::regclass")
    expect(rlsFlagsSql({ schema: null, name: "o'brien" })).toContain("'public', 'o''brien'")
  })
})

describe('parsing', () => {
  it('reads policies from pg_policy rows', () => {
    const rows = [
      ['Admin All', 'n', 'w', '["Rls Admin","rls_app"]', 'true', "owner <> ''::text"],
      ['own_rows', 'y', '*', '["public"]', 'owner = CURRENT_USER', null]
    ]
    expect(parsePolicies(rows)).toEqual([
      {
        name: 'Admin All',
        permissive: false,
        command: 'UPDATE',
        roles: ['Rls Admin', 'rls_app'],
        using: 'true',
        withCheck: "owner <> ''::text"
      },
      policy()
    ])
  })

  it('maps every command code and falls back to PUBLIC for no roles', () => {
    const cmds = ['r', 'a', 'w', 'd', '*'].map(
      (c) => parsePolicies([['p', 'y', c, '[]', null, null]])[0]
    )
    expect(cmds.map((p) => p.command)).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'])
    expect(cmds[0].roles).toEqual(['public'])
    expect(parsePolicies([['p', 'y', '*', 'garbage', null, null]])[0].roles).toEqual(['public'])
  })

  it('keys table flags by schema.name', () => {
    const map = parseRlsTables([
      ['public', 'docs', 'y', 'n'],
      ['app', 'secrets', 'y', 'y']
    ])
    expect(map.get('public.docs')).toEqual({ enabled: true, forced: false })
    expect(rlsLabel(map.get('app.secrets')!)).toBe('forced')
    expect(rlsLabel({ enabled: false, forced: true })).toBe('off')
    expect(rlsLabel({ enabled: true, forced: false })).toBe('on')
  })
})

describe('statements', () => {
  it('toggles RLS flags', () => {
    expect(rlsStatement(docs, 'enable')).toBe('ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY')
    expect(rlsStatement(odd, 'noforce')).toBe(
      'ALTER TABLE "App Data"."Docs" NO FORCE ROW LEVEL SECURITY'
    )
    expect(rlsStatement(docs, 'disable')).toContain('DISABLE ROW')
    expect(rlsStatement(docs, 'force')).toContain(' FORCE ROW')
  })

  it('creates a policy, leaving out default clauses', () => {
    expect(createPolicyStatement(docs, policy())).toBe(
      'CREATE POLICY own_rows ON public.docs\n  USING (owner = CURRENT_USER)'
    )
    expect(
      createPolicyStatement(
        odd,
        policy({
          name: ' Admin All ',
          permissive: false,
          command: 'UPDATE',
          roles: ['Rls Admin', 'rls_app'],
          using: 'true',
          withCheck: "owner <> ''"
        })
      )
    ).toBe(
      `CREATE POLICY "Admin All" ON "App Data"."Docs"
  AS RESTRICTIVE
  FOR UPDATE
  TO "Rls Admin", rls_app
  USING (true)
  WITH CHECK (owner <> '')`
    )
  })

  it('drops the expressions a command does not take', () => {
    const insert = createPolicyStatement(
      docs,
      policy({ command: 'INSERT', using: 'x', withCheck: 'y' })
    )
    expect(insert).not.toContain('USING')
    expect(insert).toContain('WITH CHECK (y)')
    const select = createPolicyStatement(docs, policy({ command: 'SELECT', withCheck: 'y' }))
    expect(select).not.toContain('WITH CHECK')
  })

  it('writes PUBLIC when it is among the roles', () => {
    expect(createPolicyStatement(docs, policy({ roles: ['public', 'a'] }))).not.toContain('TO')
    expect(createPolicyStatement(docs, policy({ roles: [] }))).not.toContain('TO')
  })

  it('drops a policy', () => {
    expect(dropPolicyStatement(odd, 'Admin All')).toBe(
      'DROP POLICY "Admin All" ON "App Data"."Docs"'
    )
  })
})

describe('policy drafts', () => {
  it('creates a new policy', () => {
    const draft = { ...newPolicyDraft(), name: 'p', using: 'true' }
    expect(policyStatements(docs, draft)).toEqual([
      'CREATE POLICY p ON public.docs\n  USING (true)'
    ])
  })

  it('has no statements when nothing changed', () => {
    expect(policyStatements(docs, policyDraftFrom(policy()))).toEqual([])
    // Whitespace and role order aren't changes
    const roles = policyDraftFrom(policy({ roles: ['b', 'a'] }))
    expect(
      policyStatements(docs, { ...roles, roles: ['a', 'b'], using: ' owner = CURRENT_USER ' })
    ).toEqual([])
  })

  it('alters roles and expressions, then renames', () => {
    const draft = {
      ...policyDraftFrom(policy()),
      name: 'Own Rows',
      roles: ['rls_app'],
      using: 'owner = session_user',
      withCheck: 'true'
    }
    expect(policyStatements(docs, draft)).toEqual([
      'ALTER POLICY own_rows ON public.docs\n  TO rls_app\n  USING (owner = session_user)\n  WITH CHECK (true)',
      'ALTER POLICY own_rows ON public.docs RENAME TO "Own Rows"'
    ])
  })

  it('goes back to PUBLIC with ALTER POLICY', () => {
    const draft = { ...policyDraftFrom(policy({ roles: ['rls_app'] })), roles: ['public'] }
    expect(policyStatements(docs, draft)).toEqual([
      'ALTER POLICY own_rows ON public.docs\n  TO PUBLIC'
    ])
  })

  it('drops and creates for what ALTER POLICY cannot change', () => {
    const base = policyDraftFrom(policy({ withCheck: 'true' }))
    for (const change of [
      { permissive: false },
      { command: 'SELECT' as const },
      { using: '' },
      { withCheck: '' }
    ]) {
      const out = policyStatements(docs, { ...base, ...change })
      expect(out).toHaveLength(2)
      expect(out[0]).toBe('DROP POLICY own_rows ON public.docs')
      expect(out[1]).toMatch(/^CREATE POLICY own_rows ON public\.docs/)
    }
  })

  it('drops by the old name when recreating a renamed policy', () => {
    const draft = { ...policyDraftFrom(policy()), name: 'renamed', command: 'DELETE' as const }
    expect(policyStatements(docs, draft)).toEqual([
      'DROP POLICY own_rows ON public.docs',
      'CREATE POLICY renamed ON public.docs\n  FOR DELETE\n  USING (owner = CURRENT_USER)'
    ])
  })

  it('validates the name', () => {
    expect(validatePolicy(newPolicyDraft(), [])).toMatch(/Name/)
    expect(validatePolicy({ ...newPolicyDraft(), name: 'p' }, ['p'])).toMatch(/already/)
    expect(validatePolicy({ ...policyDraftFrom(policy()) }, ['own_rows'])).toBeNull()
  })
})

describe('rlsDdl', () => {
  it('scripts flags and policies after a CREATE TABLE', () => {
    expect(rlsDdl(docs, { enabled: false, forced: false, policies: [] })).toEqual([])
    expect(rlsDdl(docs, { enabled: true, forced: true, policies: [policy()] })).toEqual([
      'ALTER TABLE public.docs ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.docs FORCE ROW LEVEL SECURITY',
      'CREATE POLICY own_rows ON public.docs\n  USING (owner = CURRENT_USER)'
    ])
  })
})
