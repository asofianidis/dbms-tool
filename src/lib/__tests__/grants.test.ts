import { describe, expect, it } from 'vitest'
import {
  PUBLIC_PRINCIPAL,
  emptyGrantState,
  grantQuery,
  grantStatements,
  membershipStatements,
  parseGrantRows,
  parseMembershipRows,
  parsePrincipals,
  principalQueries,
  securableComplete,
  securableFor,
  validateGrant,
  type GrantState,
  type Principal,
  type Securable
} from '../grants'

const role = (name: string, patch: Partial<Principal> = {}): Principal => ({
  name,
  host: null,
  kind: 'role',
  builtin: false,
  ...patch
})

const state = (privileges: GrantState['privileges'], patch: Partial<GrantState> = {}) => ({
  ...emptyGrantState(),
  privileges,
  ...patch
})

const table: Securable = { kind: 'table', schema: 'public', name: 'orders', args: null }

describe('PostgreSQL grants', () => {
  const reader = role('reader')

  it('grants, grants with grant option and revokes in one pass', () => {
    const original = state({ DELETE: 'grant', TRUNCATE: 'grantable' })
    const draft = state({ SELECT: 'grant', INSERT: 'grant', UPDATE: 'grantable', TRUNCATE: 'none' })
    expect(grantStatements('postgres', reader, table, original, draft)).toEqual([
      'REVOKE DELETE ON TABLE public.orders FROM reader',
      'REVOKE TRUNCATE ON TABLE public.orders FROM reader CASCADE',
      'GRANT SELECT, INSERT ON TABLE public.orders TO reader',
      'GRANT UPDATE ON TABLE public.orders TO reader WITH GRANT OPTION'
    ])
  })

  it('drops only the grant option when downgrading', () => {
    expect(
      grantStatements(
        'postgres',
        reader,
        table,
        state({ SELECT: 'grantable' }),
        state({ SELECT: 'grant' })
      )
    ).toEqual(['REVOKE GRANT OPTION FOR SELECT ON TABLE public.orders FROM reader CASCADE'])
  })

  it('writes nothing when nothing changed', () => {
    const s = state({ SELECT: 'grant' })
    expect(grantStatements('postgres', reader, table, s, s)).toEqual([])
  })

  it('grants to PUBLIC and quotes other names', () => {
    const s: Securable = { kind: 'schema', schema: 'Sales', name: null, args: null }
    expect(
      grantStatements('postgres', PUBLIC_PRINCIPAL, s, state({}), state({ USAGE: 'grant' }))
    ).toEqual(['GRANT USAGE ON SCHEMA "Sales" TO PUBLIC'])
    expect(
      grantStatements('postgres', role('App User'), s, state({}), state({ USAGE: 'grant' }))
    ).toEqual(['GRANT USAGE ON SCHEMA "Sales" TO "App User"'])
  })

  it('names routines with their arguments', () => {
    const fn: Securable = {
      kind: 'function',
      schema: 'public',
      name: 'total',
      args: 'integer, text'
    }
    expect(grantStatements('postgres', reader, fn, state({}), state({ EXECUTE: 'grant' }))).toEqual(
      ['GRANT EXECUTE ON FUNCTION public.total(integer, text) TO reader']
    )
  })

  it('leaves partially held bulk privileges alone and sets default privileges', () => {
    const bulk: Securable = { kind: 'tables', schema: 'public', name: null, args: null }
    const original = state({ SELECT: 'partial', INSERT: 'partial' })
    const draft = state({ SELECT: 'grant', INSERT: 'partial' }, { defaults: { SELECT: 'grant' } })
    expect(grantStatements('postgres', reader, bulk, original, draft)).toEqual([
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO reader'
    ])
    expect(
      grantStatements(
        'postgres',
        reader,
        bulk,
        state({}, { defaults: { SELECT: 'grant' } }),
        state({})
      )
    ).toEqual(['ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM reader'])
  })

  it('reads bulk counts as all, some or grantable', () => {
    const bulk: Securable = { kind: 'tables', schema: 'public', name: null, args: null }
    expect(
      parseGrantRows('postgres', bulk, [
        ['SELECT', '3', '0', '3'],
        ['INSERT', '1', '0', '3'],
        ['UPDATE', '3', '3', '3']
      ]).privileges
    ).toEqual({ SELECT: 'grant', INSERT: 'partial', UPDATE: 'grantable' })
  })

  it('looks routines up by identity arguments', () => {
    const fn: Securable = { kind: 'function', schema: 'public', name: 'f', args: 'a integer' }
    const sql = grantQuery('postgres', reader, fn)
    expect(sql).toContain("pg_get_function_identity_arguments(p.oid) = 'a integer'")
    expect(sql).toContain("rolname = 'reader'")
  })

  it('manages role membership and the admin option', () => {
    const roles = [role('readers'), role('writers'), role('pg_read_all_data', { builtin: true })]
    expect(
      membershipStatements(
        'postgres',
        role('alice', { kind: 'user' }),
        roles,
        { readers: 'grant', writers: 'grantable' },
        { readers: 'none', writers: 'grant', pg_read_all_data: 'grantable' }
      )
    ).toEqual([
      'REVOKE ADMIN OPTION FOR writers FROM alice',
      'REVOKE readers FROM alice',
      'GRANT pg_read_all_data TO alice WITH ADMIN OPTION'
    ])
  })
})

describe('MySQL grants', () => {
  const app = role('app', { host: '%', kind: 'user' })
  const db: Securable = { kind: 'database', schema: null, name: 'shop', args: null }

  it('lists principals with the known server query only', () => {
    const uses = (queries: string[]) =>
      queries.map((q) =>
        q.includes('is_role') ? 'mariadb' : q.includes('account_locked') ? 'mysql' : 'grantees'
      )
    expect(uses(principalQueries('mysql', false))).toEqual(['mysql', 'grantees'])
    expect(uses(principalQueries('mysql', true))).toEqual(['mariadb', 'grantees'])
    // Not connected yet: try MariaDB's query, then MySQL's
    expect(uses(principalQueries('mysql'))).toEqual(['mariadb', 'mysql', 'grantees'])
  })

  it('grants and revokes at the database level', () => {
    expect(
      grantStatements(
        'mysql',
        app,
        db,
        state({ DELETE: 'grant' }),
        state({ SELECT: 'grant', INSERT: 'grant' })
      )
    ).toEqual([
      "REVOKE DELETE ON `shop`.* FROM 'app'@'%'",
      "GRANT SELECT, INSERT ON `shop`.* TO 'app'@'%'"
    ])
  })

  it('adds the grant option to the whole level', () => {
    expect(
      grantStatements(
        'mysql',
        app,
        db,
        state({ SELECT: 'grant' }),
        state({ SELECT: 'grant', INSERT: 'grant' }, { grantOption: true })
      )
    ).toEqual(["GRANT SELECT, INSERT ON `shop`.* TO 'app'@'%' WITH GRANT OPTION"])
    expect(
      grantStatements(
        'mysql',
        app,
        db,
        state({ SELECT: 'grant' }, { grantOption: true }),
        state({ SELECT: 'grant' })
      )
    ).toEqual(["REVOKE GRANT OPTION ON `shop`.* FROM 'app'@'%'"])
  })

  it('targets global, table and routine levels', () => {
    const server: Securable = { kind: 'server', schema: null, name: null, args: null }
    const proc: Securable = { kind: 'procedure', schema: 'shop', name: 'restock', args: null }
    const tbl: Securable = { kind: 'table', schema: 'shop', name: 'orders', args: null }
    const grant = (s: Securable, p: string) =>
      grantStatements('mysql', app, s, state({}), state({ [p]: 'grant' }))[0]
    expect(grant(server, 'PROCESS')).toBe("GRANT PROCESS ON *.* TO 'app'@'%'")
    expect(grant(tbl, 'SELECT')).toBe("GRANT SELECT ON `shop`.`orders` TO 'app'@'%'")
    expect(grant(proc, 'EXECUTE')).toBe("GRANT EXECUTE ON PROCEDURE `shop`.`restock` TO 'app'@'%'")
  })

  it('reads information_schema and procs_priv rows', () => {
    expect(
      parseGrantRows('mysql', db, [
        ['SELECT', 'YES'],
        ['USAGE', 'NO']
      ])
    ).toEqual(state({ SELECT: 'grant' }, { grantOption: true }))
    const proc: Securable = { kind: 'procedure', schema: 'shop', name: 'restock', args: null }
    expect(parseGrantRows('mysql', proc, [['Execute,Alter Routine']])).toEqual(
      state({ EXECUTE: 'grant', 'ALTER ROUTINE': 'grant' })
    )
  })

  it('splits information_schema grantees into user and host', () => {
    expect(parsePrincipals([["'app'@'10.0.%'", null, 'user', 'n']])).toEqual([
      { name: 'app', host: '10.0.%', kind: 'user', builtin: false }
    ])
  })

  it('regrants a role to drop its admin option, and names MariaDB roles without a host', () => {
    const admins = role('admins', { host: '' })
    expect(
      membershipStatements('mysql', app, [admins], parseMembershipRows([['admins', '', 'YES']]), {
        'admins@': 'grant'
      })
    ).toEqual(["REVOKE 'admins' FROM 'app'@'%'", "GRANT 'admins' TO 'app'@'%'"])
  })
})

describe('SQL Server grants', () => {
  const user = role('report_user', { kind: 'user' })
  const obj: Securable = { kind: 'table', schema: 'dbo', name: 'Orders', args: null }

  it('grants, denies and lifts denies', () => {
    expect(
      grantStatements(
        'tsql',
        user,
        obj,
        state({ DELETE: 'grantable', UPDATE: 'deny' }),
        state({ SELECT: 'grant', DELETE: 'deny', UPDATE: 'none' })
      )
    ).toEqual([
      'REVOKE UPDATE ON OBJECT::[dbo].[Orders] FROM [report_user]',
      'DENY DELETE ON OBJECT::[dbo].[Orders] TO [report_user] CASCADE',
      'GRANT SELECT ON OBJECT::[dbo].[Orders] TO [report_user]'
    ])
  })

  it('grants database permissions without an ON clause', () => {
    const db: Securable = { kind: 'database', schema: null, name: 'Sales', args: null }
    expect(
      grantStatements('tsql', user, db, state({}), state({ 'CREATE TABLE': 'grant' }))
    ).toEqual(['GRANT CREATE TABLE TO [report_user]'])
    const schema: Securable = { kind: 'schema', schema: 'dbo', name: null, args: null }
    expect(grantStatements('tsql', user, schema, state({}), state({ EXECUTE: 'grant' }))).toEqual([
      'GRANT EXECUTE ON SCHEMA::[dbo] TO [report_user]'
    ])
  })

  it('reads permission states', () => {
    expect(
      parseGrantRows('tsql', obj, [
        ['SELECT', 'G'],
        ['INSERT', 'W'],
        ['DELETE', 'D']
      ]).privileges
    ).toEqual({ SELECT: 'grant', INSERT: 'grantable', DELETE: 'deny' })
  })

  it('adds and drops role members', () => {
    expect(
      membershipStatements(
        'tsql',
        user,
        [role('db_datareader', { builtin: true }), role('db_datawriter', { builtin: true })],
        { db_datawriter: 'grant' },
        { db_datareader: 'grant', db_datawriter: 'none' }
      )
    ).toEqual([
      'ALTER ROLE [db_datareader] ADD MEMBER [report_user]',
      'ALTER ROLE [db_datawriter] DROP MEMBER [report_user]'
    ])
  })
})

describe('securables', () => {
  it('maps explorer objects', () => {
    const obj = {
      schema: 'public',
      name: 'total',
      kind: 'function' as const,
      detail: 'integer',
      comment: null,
      rowEstimate: null
    }
    expect(securableFor('postgres', 'app', obj)).toEqual({
      kind: 'function',
      schema: 'public',
      name: 'total',
      args: 'integer'
    })
    expect(securableFor('mysql', 'shop', { ...obj, schema: null, kind: 'table' })).toEqual({
      kind: 'table',
      schema: 'shop',
      name: 'total',
      args: null
    })
    expect(securableFor('tsql', 'db', { ...obj, kind: 'synonym' })).toBeNull()
  })

  it('knows when a securable is fully picked', () => {
    expect(
      securableComplete('postgres', { kind: 'tables', schema: null, name: null, args: null })
    ).toBe(false)
    expect(securableComplete('tsql', { kind: 'table', schema: null, name: null, args: null })).toBe(
      false
    )
    expect(
      securableComplete('mysql', { kind: 'server', schema: null, name: null, args: null })
    ).toBe(true)
    expect(
      validateGrant(
        'mysql',
        role('a', { host: '%' }),
        { kind: 'table', schema: null, name: null, args: null },
        state({})
      )
    ).toBe('Pick a database')
  })
})
