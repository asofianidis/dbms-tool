import { describe, expect, it } from 'vitest'
import type { Principal } from '../grants'
import {
  canRenamePrincipal,
  dropPrincipalStatements,
  memberStatements,
  newPrincipalDraft,
  parsePrincipalState,
  principalDraftFrom,
  principalStatements,
  validatePrincipal,
  type PrincipalDraft
} from '../principals'

const principal = (name: string, patch: Partial<Principal> = {}): Principal => ({
  name,
  host: null,
  kind: 'user',
  builtin: false,
  ...patch
})

const draft = (base: PrincipalDraft, patch: Partial<PrincipalDraft>): PrincipalDraft => ({
  ...base,
  ...patch
})

describe('PostgreSQL roles', () => {
  it('creates a login role with only the attributes that differ from the defaults', () => {
    const d = draft(newPrincipalDraft('postgres', 'user'), {
      name: 'app',
      password: "it's secret",
      createDb: true,
      inherit: false,
      connectionLimit: '10',
      validUntil: '2027-01-01'
    })
    expect(principalStatements('postgres', d)).toEqual([
      "CREATE ROLE app WITH LOGIN CREATEDB NOINHERIT CONNECTION LIMIT 10 PASSWORD 'it''s secret' VALID UNTIL '2027-01-01'"
    ])
    expect(principalStatements('postgres', d, { maskPasswords: true })[0]).toContain(
      "PASSWORD '********'"
    )
  })

  it('creates a group role', () => {
    const d = draft(newPrincipalDraft('postgres', 'role'), { name: 'Readers' })
    expect(principalStatements('postgres', d)).toEqual(['CREATE ROLE "Readers" WITH NOLOGIN'])
  })

  it('renames, then changes only what changed', () => {
    const loaded = parsePrincipalState('postgres', principal('app'), [
      ['y', 'n', 'n', 'n', 'y', 'n', 'n', '-1', '']
    ])!
    expect(loaded).toMatchObject({ type: 'user', inherit: true, connectionLimit: '' })
    const d = draft(principalDraftFrom(loaded), {
      name: 'app2',
      createRole: true,
      type: 'role',
      validUntil: ''
    })
    expect(principalStatements('postgres', d)).toEqual([
      'ALTER ROLE app RENAME TO app2',
      'ALTER ROLE app2 WITH NOLOGIN CREATEROLE'
    ])
    expect(principalStatements('postgres', principalDraftFrom(loaded))).toEqual([])
  })

  it('clears a connection limit and an expiry', () => {
    const loaded = parsePrincipalState('postgres', principal('app'), [
      ['y', 'n', 'n', 'n', 'y', 'n', 'n', '5', '2027-01-01 00:00:00+00']
    ])!
    const d = draft(principalDraftFrom(loaded), { connectionLimit: '', validUntil: '' })
    expect(principalStatements('postgres', d)).toEqual([
      "ALTER ROLE app WITH CONNECTION LIMIT -1 VALID UNTIL 'infinity'"
    ])
  })

  it('drops, optionally with what it owns', () => {
    expect(dropPrincipalStatements('postgres', principal('app'), { dropOwned: true })).toEqual([
      'DROP OWNED BY app',
      'DROP ROLE app'
    ])
  })

  it('adds and removes a role’s members', () => {
    const readers = principal('readers', { kind: 'role' })
    const members = [principal('alice'), principal('bob'), principal('carol')]
    expect(
      memberStatements(
        'postgres',
        readers,
        members,
        { alice: 'grant', bob: 'grantable' },
        { bob: 'grant', carol: 'grantable' }
      )
    ).toEqual([
      'REVOKE readers FROM alice',
      'REVOKE ADMIN OPTION FOR readers FROM bob',
      'GRANT readers TO carol WITH ADMIN OPTION'
    ])
  })
})

describe('MySQL accounts', () => {
  it('creates a user with limits, an expired password and a lock', () => {
    const d = draft(newPrincipalDraft('mysql', 'user'), {
      name: 'app',
      host: '10.0.%',
      password: 'pw',
      connectionLimit: '5',
      expirePassword: true,
      locked: true
    })
    expect(principalStatements('mysql', d)).toEqual([
      "CREATE USER 'app'@'10.0.%' IDENTIFIED BY 'pw' WITH MAX_USER_CONNECTIONS 5 PASSWORD EXPIRE ACCOUNT LOCK"
    ])
  })

  it('creates roles on any host for MySQL and without one for MariaDB', () => {
    const mysql = draft(newPrincipalDraft('mysql', 'role'), { name: 'reader' })
    expect(principalStatements('mysql', mysql)).toEqual(["CREATE ROLE 'reader'@'%'"])
    const maria = draft(newPrincipalDraft('mysql', 'role', { mariadb: true }), { name: 'reader' })
    expect(principalStatements('mysql', maria)).toEqual(["CREATE ROLE 'reader'"])
  })

  it('renames and alters an account', () => {
    const loaded = parsePrincipalState('mysql', principal('app', { host: '%' }), [['n', '0']])!
    expect(loaded.connectionLimit).toBe('')
    const d = draft(principalDraftFrom(loaded), { host: 'localhost', locked: true, password: 'x' })
    expect(principalStatements('mysql', d)).toEqual([
      "RENAME USER 'app'@'%' TO 'app'@'localhost'",
      "ALTER USER 'app'@'localhost' IDENTIFIED BY 'x' ACCOUNT LOCK"
    ])
  })

  it("doesn't rename roles, which MySQL and MariaDB refuse", () => {
    const loaded = parsePrincipalState('mysql', principal('reader', { host: '%', kind: 'role' }), [
      ['n', '0']
    ])!
    expect(principalStatements('mysql', draft(principalDraftFrom(loaded), { name: 'r2' }))).toEqual(
      []
    )
    expect(canRenamePrincipal('mysql', 'role')).toBe(false)
    expect(canRenamePrincipal('mysql', 'user')).toBe(true)
  })

  it('drops users and roles', () => {
    expect(dropPrincipalStatements('mysql', principal('app', { host: '%' }))).toEqual([
      "DROP USER 'app'@'%'"
    ])
    expect(dropPrincipalStatements('mysql', principal('r', { host: '', kind: 'role' }))).toEqual([
      "DROP ROLE 'r'"
    ])
  })

  it('needs a host for users', () => {
    const d = draft(newPrincipalDraft('mysql', 'user'), { name: 'app', host: ' ' })
    expect(validatePrincipal('mysql', d)).toMatch(/host/)
  })
})

describe('SQL Server users and roles', () => {
  it('creates a login and a user for it', () => {
    const d = draft(newPrincipalDraft('tsql', 'user'), {
      name: 'app',
      login: 'app_login',
      password: 'P@ss',
      defaultSchema: 'sales'
    })
    expect(principalStatements('tsql', d)).toEqual([
      "CREATE LOGIN [app_login] WITH PASSWORD = N'P@ss'",
      'CREATE USER [app] FOR LOGIN [app_login] WITH DEFAULT_SCHEMA = [sales]'
    ])
  })

  it('creates users for each kind of sign-in', () => {
    const base = draft(newPrincipalDraft('tsql', 'user'), { name: 'u', password: 'p' })
    expect(principalStatements('tsql', { ...base, auth: 'none' })).toEqual([
      'CREATE USER [u] WITHOUT LOGIN'
    ])
    expect(principalStatements('tsql', { ...base, auth: 'password' })).toEqual([
      "CREATE USER [u] WITH PASSWORD = N'p'"
    ])
    expect(principalStatements('tsql', { ...base, auth: 'external' })).toEqual([
      'CREATE USER [u] FROM EXTERNAL PROVIDER'
    ])
  })

  it('reads a user and changes its name, schema and login password', () => {
    const loaded = parsePrincipalState('tsql', principal('app'), [
      ['S ', 'dbo', 'app_login', 'INSTANCE', '']
    ])!
    expect(loaded).toMatchObject({ type: 'user', auth: 'login', login: 'app_login' })
    const d = draft(principalDraftFrom(loaded), {
      name: 'app2',
      defaultSchema: 'sales',
      password: 'new'
    })
    expect(principalStatements('tsql', d)).toEqual([
      'ALTER USER [app] WITH NAME = [app2], DEFAULT_SCHEMA = [sales]',
      "ALTER LOGIN [app_login] WITH PASSWORD = N'new'"
    ])
  })

  it('creates, renames and reassigns roles', () => {
    const d = draft(newPrincipalDraft('tsql', 'role'), { name: 'auditors', owner: 'dbo' })
    expect(principalStatements('tsql', d)).toEqual(['CREATE ROLE [auditors] AUTHORIZATION [dbo]'])
    const loaded = parsePrincipalState('tsql', principal('auditors', { kind: 'role' }), [
      ['R', '', '', 'NONE', 'dbo']
    ])!
    expect(
      principalStatements('tsql', draft(principalDraftFrom(loaded), { name: 'audit', owner: 'me' }))
    ).toEqual([
      'ALTER ROLE [auditors] WITH NAME = [audit]',
      'ALTER AUTHORIZATION ON ROLE::[audit] TO [me]'
    ])
  })

  it("empties a role before dropping it, and drops a user's login on request", () => {
    expect(
      dropPrincipalStatements('tsql', principal('auditors', { kind: 'role' }), {
        members: [principal('alice')]
      })
    ).toEqual(['ALTER ROLE [auditors] DROP MEMBER [alice]', 'DROP ROLE [auditors]'])
    expect(dropPrincipalStatements('tsql', principal('app'), { login: 'app_login' })).toEqual([
      'DROP USER [app]',
      'DROP LOGIN [app_login]'
    ])
  })

  it('adds members to fixed roles', () => {
    const reader = principal('db_datareader', { kind: 'role', builtin: true })
    expect(memberStatements('tsql', reader, [principal('app')], {}, { app: 'grant' })).toEqual([
      'ALTER ROLE [db_datareader] ADD MEMBER [app]'
    ])
  })

  it('needs a login and its password, and a login on Babelfish', () => {
    const base = draft(newPrincipalDraft('tsql', 'user'), { name: 'u' })
    expect(validatePrincipal('tsql', base)).toMatch(/login/)
    expect(validatePrincipal('tsql', { ...base, login: 'l' })).toMatch(/password/)
    expect(validatePrincipal('tsql', { ...base, login: 'l', password: 'p' })).toBeNull()
    expect(validatePrincipal('tsql', { ...base, auth: 'none' }, { babelfish: true })).toMatch(
      /Babelfish/
    )
  })
})
