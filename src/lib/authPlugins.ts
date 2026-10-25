/**
 * MySQL and MariaDB authentication plugins: the ones the user designer offers, the
 * IDENTIFIED clause that sets them, and whether this app can sign in as accounts that use
 * them (its driver, mysql_async, answers mysql_native_password, caching_sha2_password,
 * ed25519 and parsec).
 */
import type { Cell, ServerInfo } from './api'
import { mariaDbAtLeast } from './mariadb'

export interface AuthPlugin {
  name: string
  /** Takes a password: MariaDB USING PASSWORD(), MySQL BY */
  password: boolean
  hint: string
  /** Why this app can't sign in as accounts that use it; undefined when it can */
  noLogin?: string
  /** Loads it, when the server doesn't ship it loaded */
  install?: string
  /** First MariaDB version that has it */
  since?: [major: number, minor: number]
}

const noClient = (name: string): string =>
  `This app can't sign in as ${name} accounts yet: its MySQL driver lacks the ${name} client plugin. Other clients can.`

const SOCKET =
  "Signs in only over the server's local socket, as the OS user of the same name. This app connects over TCP, so it can't sign in as this account."

const MARIADB_PLUGINS: AuthPlugin[] = [
  {
    name: 'mysql_native_password',
    password: true,
    hint: "SHA-1 password hash; MariaDB's default"
  },
  {
    name: 'ed25519',
    password: true,
    hint: 'Elliptic-curve signature; the password hash never crosses the network',
    install: "INSTALL SONAME 'auth_ed25519'"
  },
  {
    name: 'parsec',
    password: true,
    hint: 'Salted PBKDF2 key with an ed25519 signature (MariaDB 11.6+)',
    install: "INSTALL SONAME 'auth_parsec'",
    since: [11, 6]
  },
  { name: 'unix_socket', password: false, hint: 'The OS user of a local socket', noLogin: SOCKET },
  {
    name: 'gssapi',
    password: false,
    hint: 'Kerberos, or Windows SSPI',
    noLogin: noClient('gssapi'),
    install: "INSTALL SONAME 'auth_gssapi'"
  },
  {
    name: 'pam',
    password: false,
    hint: "The server's PAM stack (system passwords, LDAP, one-time codes)",
    noLogin: noClient('pam (dialog)'),
    install: "INSTALL SONAME 'auth_pam'"
  }
]

const MYSQL_PLUGINS: AuthPlugin[] = [
  {
    name: 'caching_sha2_password',
    password: true,
    hint: "SHA-256 password hash; MySQL's default since 8.0"
  },
  {
    name: 'mysql_native_password',
    password: true,
    hint: 'SHA-1 password hash; deprecated, off by default in MySQL 8.4 and gone in 9.0'
  },
  {
    name: 'sha256_password',
    password: true,
    hint: 'SHA-256 password hash; deprecated',
    noLogin: noClient('sha256_password')
  },
  {
    name: 'auth_socket',
    password: false,
    hint: 'The OS user of a local socket',
    noLogin: SOCKET,
    install: "INSTALL PLUGIN auth_socket SONAME 'auth_socket.so'"
  }
]

/** Server-side plugins that fail over TCP without asking the client, so the next method runs */
const SOCKET_PLUGINS = new Set(['unix_socket', 'auth_socket'])

/**
 * The server's authentication plugins and their status ('ACTIVE', 'NOT INSTALLED'), tried in
 * order: MariaDB lists the ones it could load too, MySQL only loaded ones.
 */
export const AUTH_PLUGINS_QUERIES = [
  "SELECT PLUGIN_NAME, PLUGIN_STATUS FROM information_schema.ALL_PLUGINS WHERE PLUGIN_TYPE = 'AUTHENTICATION'",
  "SELECT PLUGIN_NAME, PLUGIN_STATUS FROM information_schema.PLUGINS WHERE PLUGIN_TYPE = 'AUTHENTICATION'"
]

const text = (cell: Cell | undefined): string => (typeof cell === 'string' ? cell : '')

/** Status by plugin name; a plugin listed twice (pam's two libraries) is active if either is. */
export function parseAuthPluginRows(rows: Cell[][]): Map<string, string> {
  const status = new Map<string, string>()
  for (const r of rows) {
    const name = text(r[0])
    if (name && status.get(name) !== 'ACTIVE') status.set(name, text(r[1]).toUpperCase())
  }
  return status
}

export interface AuthPluginChoice {
  plugin: AuthPlugin
  /** Loaded and active on the server; unknown servers count as having everything */
  available: boolean
  /** Why it can't be picked, when it isn't available */
  unavailable?: string
}

function pluginsOf(mariadb: boolean): AuthPlugin[] {
  return mariadb ? MARIADB_PLUGINS : MYSQL_PLUGINS
}

/** What the app knows of a plugin; a plain entry for ones it doesn't know. */
export function authPlugin(name: string, mariadb: boolean): AuthPlugin {
  return (
    pluginsOf(mariadb).find((p) => p.name === name) ?? {
      name,
      password: false,
      hint: "This app doesn't know this plugin; add its USING or BY options in the editor"
    }
  )
}

/**
 * The plugins the designer offers: the known ones for the server (with the ones it lacks
 * marked, and how to load them), any other active ones, and the account's own.
 * `status` is null when the server's plugin list couldn't be read.
 */
export function authPluginChoices(
  info: Pick<ServerInfo, 'product' | 'version'> | null,
  mariadb: boolean,
  status: Map<string, string> | null,
  current: string[]
): AuthPluginChoice[] {
  const known = pluginsOf(mariadb).filter(
    (p) => !p.since || !mariadb || mariaDbAtLeast(info, ...p.since) || current.includes(p.name)
  )
  const choices: AuthPluginChoice[] = known.map((plugin) => {
    const s = status?.get(plugin.name)
    if (!status || s === 'ACTIVE' || current.includes(plugin.name))
      return { plugin, available: true }
    return {
      plugin,
      available: false,
      unavailable: plugin.install
        ? `needs ${plugin.install}`
        : s
          ? `${s.toLowerCase()} on this server`
          : 'not on this server'
    }
  })
  const active = [...(status ?? [])].filter(([, s]) => s === 'ACTIVE').map(([name]) => name)
  const names = new Set(known.map((p) => p.name))
  for (const name of [...active, ...current]) {
    if (names.has(name)) continue
    names.add(name)
    choices.push({ plugin: authPlugin(name, mariadb), available: true })
  }
  return choices
}

/**
 * The account's sign-in methods, in the order MariaDB tries them. MariaDB 10.4+ keeps the
 * last-set method in the `plugin` key of mysql.global_priv and, with more than one, all of
 * them in `auth_or`, where `{}` stands for the top-level one. MySQL has just `plugin`.
 */
export function parseAuthMethods(plugin: string, authOr: string): string[] {
  let or: unknown = null
  try {
    or = authOr ? JSON.parse(authOr) : null
  } catch {
    or = null
  }
  if (!Array.isArray(or)) return plugin ? [plugin] : []
  return or
    .map((m: unknown) =>
      m && typeof m === 'object' && 'plugin' in m && typeof m.plugin === 'string'
        ? m.plugin
        : plugin
    )
    .filter(Boolean)
}

/** True when any of the methods takes a password. */
export function takesPassword(plugins: string[], mariadb: boolean): boolean {
  return plugins.some((p) => authPlugin(p, mariadb).password)
}

/**
 * The IDENTIFIED clause that sets the methods: MariaDB `IDENTIFIED VIA a USING
 * PASSWORD('…') OR b`, MySQL `IDENTIFIED WITH a BY '…'` (one method only). `secret` is the
 * password literal, which may be masked.
 */
export function identifiedVia(plugins: string[], mariadb: boolean, secret: string): string {
  if (!mariadb) {
    const p = plugins[0]
    return ` IDENTIFIED WITH ${p}${authPlugin(p, false).password ? ` BY ${secret}` : ''}`
  }
  const methods = plugins.map((p) =>
    authPlugin(p, true).password ? `${p} USING PASSWORD(${secret})` : p
  )
  return ` IDENTIFIED VIA ${methods.join(' OR ')}`
}

/** A plugin name as the clause writes it unquoted. */
export const validPluginName = (name: string): boolean => /^\w+$/.test(name)

/**
 * Why this app couldn't sign in as an account with these methods, or null. The server tries
 * them in order; socket methods fail over TCP and move on, the first other one decides.
 */
export function authLoginProblem(plugins: string[], mariadb: boolean): string | null {
  for (const [i, name] of plugins.entries()) {
    if (SOCKET_PLUGINS.has(name) && i < plugins.length - 1) continue
    const plugin = authPlugin(name, mariadb)
    if (plugin.noLogin) return plugin.noLogin
    // A wrong password moves on to the next method, which this app may not handle
    const later = plugins
      .slice(i + 1)
      .find((p) => !SOCKET_PLUGINS.has(p) && authPlugin(p, mariadb).noLogin)
    if (later)
      return `This app signs in with ${name}, but a mistyped password falls through to ${later}, which this app can't handle yet. Leave ${later} out for accounts this app connects as.`
    return null
  }
  return null
}
