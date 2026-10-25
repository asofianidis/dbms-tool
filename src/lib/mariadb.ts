/**
 * MariaDB detection. MariaDB connects through the MySQL engine and dialect; the server info
 * (`product` is "MariaDB 11.4.2", `version` the raw VERSION() string) is how features that
 * differ between the two tell them apart.
 */
import type { ServerInfo } from './api'
import type { ConnectionStatus } from './workspace'

export type ServerVersion = [major: number, minor: number, patch: number]

type InfoLike = Pick<ServerInfo, 'product' | 'version'> | null | undefined

/** True when the server is MariaDB (a MySQL-engine connection only). */
export function isMariaDb(info: InfoLike): boolean {
  if (!info) return false
  return /^mariadb\b/i.test(info.product) || /mariadb/i.test(info.version)
}

/** MariaDB's version, or null for MySQL and other servers. */
export function mariaDbVersion(info: InfoLike): ServerVersion | null {
  if (!info || !isMariaDb(info)) return null
  // Replication-era servers report "5.5.5-10.6.12-MariaDB"; the real version follows the prefix
  const raw = info.version.replace(/^5\.5\.5-/, '')
  const match =
    /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw) ?? /(\d+)\.(\d+)(?:\.(\d+))?/.exec(info.product)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** True when the server is MariaDB `major.minor` or newer. */
export function mariaDbAtLeast(info: InfoLike, major: number, minor = 0): boolean {
  const version = mariaDbVersion(info)
  if (!version) return false
  return version[0] > major || (version[0] === major && version[1] >= minor)
}

/** The server info of a connected status, for the helpers above. */
export function connectedInfo(status: ConnectionStatus | undefined): ServerInfo | null {
  return status?.state === 'connected' ? status.info : null
}
