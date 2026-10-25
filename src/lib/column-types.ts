/**
 * Column types and attributes that depend on the connected server, not just
 * the dialect: MariaDB's INET4 / INET6 / UUID / VECTOR types, INVISIBLE
 * columns (MariaDB 10.3+, MySQL 8.0.23+), MariaDB's COMPRESSED attribute and
 * VECTOR indexes.
 */
import type { ColumnMeta, ServerInfo, TableInfo } from './api'
import type { Dialect } from './engines'
import { isMariaDb, mariaDbAtLeast } from './mariadb'

type InfoLike = Pick<ServerInfo, 'product' | 'version'> | null | undefined

/** True when the server is MySQL (not MariaDB) `major.minor.patch` or newer. */
export function mysqlAtLeast(info: InfoLike, major: number, minor = 0, patch = 0): boolean {
  if (!info || isMariaDb(info)) return false
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(info.version.trim())
  if (!m) return false
  const have = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
  const want = [major, minor, patch]
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i]
  return true
}

/** MariaDB-only types, each with the release that added it. */
const MARIADB_TYPES: [type: string, major: number, minor: number][] = [
  ['inet4', 10, 10],
  ['inet6', 10, 5],
  ['uuid', 10, 7],
  // The dimension count is the embedding model's; 1536 is a common one
  ['vector(1536)', 11, 7]
]

/** The type picker's list for a server: the dialect's types plus what the server adds. */
export function serverTypes(dialect: Dialect, base: string[], info: InfoLike): string[] {
  if (dialect !== 'mysql' || !isMariaDb(info)) return base
  return [
    ...base,
    ...MARIADB_TYPES.filter(([, major, minor]) => mariaDbAtLeast(info, major, minor)).map(
      ([type]) => type
    )
  ]
}

export interface ColumnFeatures {
  /** INVISIBLE columns, which SELECT * leaves out */
  invisible: boolean
  /** MariaDB's COMPRESSED attribute on BLOB / TEXT / VARCHAR / VARBINARY columns */
  compressed: boolean
  /** MariaDB's VECTOR indexes */
  vectorIndex: boolean
}

export function columnFeatures(dialect: Dialect, info: InfoLike): ColumnFeatures {
  const mysql = dialect === 'mysql'
  return {
    invisible: mysql && (mariaDbAtLeast(info, 10, 3) || mysqlAtLeast(info, 8, 0, 23)),
    compressed: mysql && mariaDbAtLeast(info, 10, 3),
    vectorIndex: mysql && mariaDbAtLeast(info, 11, 7)
  }
}

/** Whether MariaDB can compress a column of this type. */
export const isCompressible = (dataType: string): boolean =>
  /^\s*((tiny|medium|long)?(blob|text)|var(char|binary))\b/i.test(dataType)

/** MariaDB reports COMPRESSED inside COLUMN_TYPE as a versioned comment. */
const COMPRESSED = /\s*(?:\/\*M?!\d*\s*COMPRESSED\s*\*\/|\bCOMPRESSED\b)/i

/** Splits MariaDB's `text /*M!100301 COMPRESSED*\/` into the type and the attribute. */
export function splitCompressed(columnType: string): { dataType: string; compressed: boolean } {
  if (!COMPRESSED.test(columnType)) return { dataType: columnType, compressed: false }
  return {
    dataType: columnType.replace(COMPRESSED, '').replace(/\s+/g, ' ').trim(),
    compressed: true
  }
}

/** The type with COMPRESSED where MariaDB wants it: straight after the type, before any charset. */
export function withCompressed(dataType: string): string {
  const at = dataType.search(/\s(character\s+set|charset|collate)\b/i)
  return at < 0
    ? `${dataType} COMPRESSED`
    : `${dataType.slice(0, at)} COMPRESSED${dataType.slice(at)}`
}

/** Whether EXTRA marks the column INVISIBLE (MariaDB: `INVISIBLE`; MySQL: `... INVISIBLE`). */
export const isInvisible = (extra: string | null | undefined): boolean =>
  /\binvisible\b/i.test(extra ?? '')

/**
 * Columns the table browser names instead of `SELECT *`, which leaves
 * invisible columns out; undefined when `*` already returns them all.
 */
export function browseColumns(info: TableInfo | undefined): string[] | undefined {
  if (!info?.columns.some((c) => isInvisible(c.extra))) return undefined
  return info.columns.map((c) => c.name)
}

const TABLE_TYPES = /^(vector|inet4|inet6|uuid)\b/i

/**
 * Result columns with the table's own type where the wire type says less:
 * MariaDB sends VECTOR as varbinary and INET4 / INET6 / UUID as char.
 */
export function tableColumnTypes(columns: ColumnMeta[], info: TableInfo | undefined): ColumnMeta[] {
  if (!info) return columns
  return columns.map((c) => {
    const type = TABLE_TYPES.exec(info.columns.find((t) => t.name === c.name)?.dataType ?? '')
    return type ? { ...c, typeName: type[1].toLowerCase() } : c
  })
}
