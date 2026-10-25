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

describe('MySQL and MariaDB authentication plugins', () => {
  const mariadb = { mariadb: true }
  const user = (plugins: string[]): PrincipalDraft =>
    draft(newPrincipalDraft('mysql', 'user', mariadb), { name: 'app', plugins })

  it('creates MariaDB users with one or more sign-in methods', () => {
    expect(principalStatements('mysql', { ...user(['ed25519']), password: 'pw' }, mariadb)).toEqual(
      ["CREATE USER 'app'@'%' IDENTIFIED VIA ed25519 USING PASSWORD('pw')"]
    )
    expect(principalStatements('mysql', user(['unix_socket']), mariadb)).toEqual([
      "CREATE USER 'app'@'%' IDENTIFIED VIA unix_socket"
    ])
    const both = { ...user(['unix_socket', 'mysql_native_password']), password: "it's" }
    expect(principalStatements('mysql', both, mariadb)).toEqual([
      "CREATE USER 'app'@'%' IDENTIFIED VIA unix_socket OR mysql_native_password USING PASSWORD('it''s')"
    ])
    // The script preview hides the password
    expect(principalStatements('mysql', both, { ...mariadb, maskPasswords: true })).toEqual([
      "CREATE USER 'app'@'%' IDENTIFIED VIA unix_socket OR mysql_native_password USING PASSWORD('********')"
    ])
    // The server default stays IDENTIFIED BY
    expect(principalStatements('mysql', { ...user([]), password: 'pw' }, mariadb)).toEqual([
      "CREATE USER 'app'@'%' IDENTIFIED BY 'pw'"
    ])
  })

  it('creates MySQL users with a plugin', () => {
    const d = draft(newPrincipalDraft('mysql', 'user'), {
      name: 'app',
      plugins: ['caching_sha2_password'],
      password: 'pw'
    })
    expect(principalStatements('mysql', d)).toEqual([
      "CREATE USER 'app'@'%' IDENTIFIED WITH caching_sha2_password BY 'pw'"
    ])
    expect(principalStatements('mysql', d, { maskPasswords: true })).toEqual([
      "CREATE USER 'app'@'%' IDENTIFIED WITH caching_sha2_password BY '********'"
    ])
    expect(validatePrincipal('mysql', { ...d, plugins: ['a', 'b'] })).toMatch(/one/)
  })

  it('reads the methods back and restates them with a new MariaDB password', () => {
    // mysql.global_priv's plugin and auth_or, as MariaDB 11.8 returns them
    const loaded = parsePrincipalState('mysql', principal('app', { host: '%' }), [
      ['n', '0', 'mysql_native_password', '[{"plugin":"unix_socket"},{}]']
    ])!
    expect(loaded.plugins).toEqual(['unix_socket', 'mysql_native_password'])
    expect(principalStatements('mysql', principalDraftFrom(loaded), mariadb)).toEqual([])
    // IDENTIFIED BY would reset the account to mysql_native_password alone
    const d = { ...principalDraftFrom(loaded), password: 'new' }
    expect(principalStatements('mysql', d, mariadb)).toEqual([
      "ALTER USER 'app'@'%' IDENTIFIED VIA unix_socket OR mysql_native_password USING PASSWORD('new')"
    ])
    const socketOnly = { ...principalDraftFrom(loaded), plugins: ['unix_socket'] }
    expect(validatePrincipal('mysql', socketOnly, mariadb)).toBeNull()
    expect(principalStatements('mysql', socketOnly, mariadb)).toEqual([
      "ALTER USER 'app'@'%' IDENTIFIED VIA unix_socket"
    ])
  })

  it('keeps the MySQL plugin on a password change, and switches it when asked', () => {
    const loaded = parsePrincipalState('mysql', principal('app', { host: '%' }), [
      ['n', '0', 'caching_sha2_password']
    ])!
    expect(loaded.plugins).toEqual(['caching_sha2_password'])
    expect(principalStatements('mysql', { ...principalDraftFrom(loaded), password: 'x' })).toEqual([
      "ALTER USER 'app'@'%' IDENTIFIED BY 'x'"
    ])
    const native = { ...principalDraftFrom(loaded), plugins: ['mysql_native_password'] }
    expect(validatePrincipal('mysql', native)).toMatch(/password for mysql_native_password/)
    expect(principalStatements('mysql', { ...native, password: 'x' })).toEqual([
      "ALTER USER 'app'@'%' IDENTIFIED WITH mysql_native_password BY 'x'"
    ])
  })

  it('needs a password for new password methods, and plain plugin names', () => {
    expect(validatePrincipal('mysql', user(['ed25519']), mariadb)).toMatch(/password for ed25519/)
    expect(validatePrincipal('mysql', user(['unix_socket']), mariadb)).toBeNull()
    expect(validatePrincipal('mysql', user(["x' OR 1"]), mariadb)).toMatch(/plugin name/)
    expect(validatePrincipal('mysql', user(['ed25519', 'ed25519']), mariadb)).toMatch(/once/)
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
