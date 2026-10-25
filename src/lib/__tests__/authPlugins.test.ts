import { describe, expect, it } from 'vitest'
import {
  authLoginProblem,
  authPluginChoices,
  identifiedVia,
  parseAuthMethods,
  parseAuthPluginRows,
  takesPassword
} from '../authPlugins'

const maria = (version: string) => ({
  product: `MariaDB ${version}`,
  version: `${version}-MariaDB`
})

describe('authentication plugins', () => {
  it('reads MariaDB sign-in methods from mysql.global_priv', () => {
    // As MariaDB 11.8 stores them
    expect(parseAuthMethods('ed25519', '')).toEqual(['ed25519'])
    expect(parseAuthMethods('mysql_native_password', '[{"plugin":"unix_socket"},{}]')).toEqual([
      'unix_socket',
      'mysql_native_password'
    ])
    expect(
      parseAuthMethods(
        'mysql_native_password',
        '[{},{"plugin":"ed25519","authentication_string":"fi+u3n"}]'
      )
    ).toEqual(['mysql_native_password', 'ed25519'])
    expect(
      parseAuthMethods(
        'parsec',
        '[{"plugin":"unix_socket"},{"plugin":"ed25519","authentication_string":"Gv2J"},{}]'
      )
    ).toEqual(['unix_socket', 'ed25519', 'parsec'])
    expect(parseAuthMethods('', '')).toEqual([])
    expect(parseAuthMethods('caching_sha2_password', 'not json')).toEqual(['caching_sha2_password'])
  })

  it('writes MariaDB and MySQL IDENTIFIED clauses', () => {
    expect(identifiedVia(['ed25519'], true, "'pw'")).toBe(
      " IDENTIFIED VIA ed25519 USING PASSWORD('pw')"
    )
    expect(identifiedVia(['unix_socket'], true, "'pw'")).toBe(' IDENTIFIED VIA unix_socket')
    expect(identifiedVia(['unix_socket', 'mysql_native_password'], true, "'pw'")).toBe(
      " IDENTIFIED VIA unix_socket OR mysql_native_password USING PASSWORD('pw')"
    )
    expect(identifiedVia(['caching_sha2_password'], false, "'pw'")).toBe(
      " IDENTIFIED WITH caching_sha2_password BY 'pw'"
    )
    expect(identifiedVia(['auth_socket'], false, "'pw'")).toBe(' IDENTIFIED WITH auth_socket')
    expect(takesPassword(['unix_socket', 'gssapi'], true)).toBe(false)
    expect(takesPassword(['unix_socket', 'parsec'], true)).toBe(true)
  })

  it("offers the server's active plugins and says how to load the rest", () => {
    // information_schema.ALL_PLUGINS on MariaDB 11.8 with ed25519 loaded
    const status = parseAuthPluginRows([
      ['mysql_native_password', 'ACTIVE'],
      ['unix_socket', 'ACTIVE'],
      ['ed25519', 'ACTIVE'],
      ['pam', 'NOT INSTALLED'],
      ['pam', 'NOT INSTALLED'],
      ['caching_sha2_password', 'NOT INSTALLED']
    ])
    const choices = authPluginChoices(maria('11.8.9'), true, status, [])
    const byName = Object.fromEntries(choices.map((c) => [c.plugin.name, c]))
    expect(byName.ed25519.available).toBe(true)
    expect(byName.parsec).toMatchObject({
      available: false,
      unavailable: "needs INSTALL SONAME 'auth_parsec'"
    })
    expect(byName.pam.unavailable).toBe("needs INSTALL SONAME 'auth_pam'")
    // Not a MariaDB plugin this app knows, and not loaded
    expect(byName.caching_sha2_password).toBeUndefined()

    // parsec is MariaDB 11.6+
    const old = authPluginChoices(maria('10.11.6'), true, status, [])
    expect(old.map((c) => c.plugin.name)).not.toContain('parsec')
    // Unreadable plugin list: everything known is offered
    expect(authPluginChoices(maria('11.8.9'), true, null, []).every((c) => c.available)).toBe(true)
  })

  it('offers MySQL plugins, and keeps unknown active ones and the account’s own', () => {
    // information_schema.PLUGINS on MySQL 8.4
    const status = parseAuthPluginRows([
      ['sha256_password', 'ACTIVE'],
      ['caching_sha2_password', 'ACTIVE'],
      ['mysql_native_password', 'DISABLED'],
      ['authentication_ldap_simple', 'ACTIVE']
    ])
    const choices = authPluginChoices(null, false, status, ['mysql_old_password'])
    const byName = Object.fromEntries(choices.map((c) => [c.plugin.name, c]))
    expect(byName.caching_sha2_password.available).toBe(true)
    expect(byName.mysql_native_password.unavailable).toBe('disabled on this server')
    expect(byName.auth_socket.unavailable).toBe(
      "needs INSTALL PLUGIN auth_socket SONAME 'auth_socket.so'"
    )
    expect(byName.authentication_ldap_simple.available).toBe(true)
    expect(byName.mysql_old_password.available).toBe(true)
  })

  it('says when this app could not sign in as the account', () => {
    expect(authLoginProblem(['mysql_native_password'], true)).toBeNull()
    expect(authLoginProblem(['caching_sha2_password'], false)).toBeNull()
    expect(authLoginProblem([], true)).toBeNull()
    expect(authLoginProblem(['ed25519'], true)).toBeNull()
    expect(authLoginProblem(['parsec', 'mysql_native_password'], true)).toBeNull()
    expect(authLoginProblem(['gssapi'], true)).toMatch(/can't sign in as gssapi/)
    expect(authLoginProblem(['unix_socket'], true)).toMatch(/connects over TCP/)
    // unix_socket fails over TCP and the server moves on
    expect(authLoginProblem(['unix_socket', 'mysql_native_password'], true)).toBeNull()
    expect(authLoginProblem(['mysql_native_password', 'unix_socket'], true)).toBeNull()
    expect(authLoginProblem(['mysql_native_password', 'ed25519'], true)).toBeNull()
    expect(authLoginProblem(['mysql_native_password', 'pam'], true)).toMatch(
      /mistyped password falls through to pam/
    )
    expect(authLoginProblem(['sha256_password'], false)).toMatch(/sha256_password/)
  })
})
