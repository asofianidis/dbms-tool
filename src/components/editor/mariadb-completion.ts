import type { CompletionSource } from '@codemirror/autocomplete'
import { MariaSQL, SQLDialect } from '@codemirror/lang-sql'
import type { ServerInfo } from '@/lib/api'
import { isMariaDb, mariaDbVersion, type ServerVersion } from '@/lib/mariadb'
import { phraseCompletion, type Phrase as BasePhrase } from './phrase-completion'

/*
 * MariaDB connects through the MySQL dialect. When the server is MariaDB the editor
 * highlights with lang-sql's MariaSQL plus the words MariaDB added since (RETURNING,
 * sequences, system versioning, application-time periods, its column types), and
 * completes MariaDB's multi-word clauses.
 */

export const MariaDbSQL = SQLDialect.define({
  ...MariaSQL.spec,
  keywords: `${MariaSQL.spec.keywords} returning sequence sequences nocache nocycle increment minvalue restart history period system_time versioning nested previous`,
  types: `${MariaSQL.spec.types} inet4 inet6 uuid vector`
})

/** The version to complete for when the server is MariaDB, else undefined (MySQL). */
export function editorMariaDb(
  info: Pick<ServerInfo, 'product' | 'version'> | null | undefined
): ServerVersion | undefined {
  if (!isMariaDb(info)) return undefined
  // An unreadable version offers everything rather than nothing
  return mariaDbVersion(info) ?? [Infinity, 0, 0]
}

interface Phrase extends BasePhrase {
  since: [major: number, minor: number]
}

/** Right after a table in FROM or JOIN */
const FROM_TABLE = /\b(?:from|join)\s+[\w$.`]+$/i
const TABLE_DDL = /^\s*(?:create\s+(?:or\s+replace\s+)?|alter\s+)table\b/i
const SET_OP = /\bselect\b/i

const PHRASES: Phrase[] = [
  // System-versioned tables
  {
    words: 'FOR SYSTEM_TIME AS OF',
    tail: " TIMESTAMP '${2024-01-01 00:00:00}'",
    since: [10, 3],
    where: FROM_TABLE
  },
  {
    words: 'FOR SYSTEM_TIME BETWEEN',
    tail: " '${start}' AND '${end}'",
    since: [10, 3],
    where: FROM_TABLE
  },
  {
    words: 'FOR SYSTEM_TIME FROM',
    tail: " '${start}' TO '${end}'",
    since: [10, 3],
    where: FROM_TABLE
  },
  { words: 'FOR SYSTEM_TIME ALL', since: [10, 3], where: FROM_TABLE },
  {
    words: 'WITH SYSTEM VERSIONING',
    since: [10, 3],
    where: /^\s*create\s+(?:or\s+replace\s+)?table\b/i
  },
  { words: 'ADD SYSTEM VERSIONING', since: [10, 3], where: /^\s*alter\s+table\b/i },
  { words: 'DROP SYSTEM VERSIONING', since: [10, 3], where: /^\s*alter\s+table\b/i },
  {
    words: 'DELETE HISTORY FROM',
    tail: " ${table} BEFORE SYSTEM_TIME '${2024-01-01 00:00:00}'",
    since: [10, 3],
    start: true
  },
  {
    words: 'PERIOD FOR SYSTEM_TIME',
    tail: '(${row_start}, ${row_end})',
    since: [10, 3],
    where: TABLE_DDL
  },
  // Application-time periods
  {
    words: 'PERIOD FOR',
    tail: ' ${period}(${start_column}, ${end_column})',
    since: [10, 4],
    where: TABLE_DDL
  },
  // Sequences
  { words: 'NEXT VALUE FOR', tail: ' ${sequence}', since: [10, 3] },
  { words: 'PREVIOUS VALUE FOR', tail: ' ${sequence}', since: [10, 3] },
  // Set operations (INTERSECT and EXCEPT alone are plain keywords)
  { words: 'INTERSECT ALL', since: [10, 5], where: SET_OP },
  { words: 'EXCEPT ALL', since: [10, 5], where: SET_OP },
  // Administration
  { words: 'KILL QUERY ID', tail: ' ${query_id}', since: [10, 0], start: true },
  { words: 'ANALYZE FORMAT=JSON', tail: ' ${SELECT}', since: [10, 1], start: true },
  { words: 'SHOW EXPLAIN FOR', tail: ' ${connection_id}', since: [10, 0], start: true }
]

const atLeast = (v: ServerVersion, [major, minor]: [number, number]): boolean =>
  v[0] > major || (v[0] === major && v[1] >= minor)

/**
 * MariaDB's multi-word clauses. Each completes from whichever of its words is being typed,
 * so `FOR SYSTEM_TIME` offers `AS OF`, `ALL`… once `FOR ` is written.
 */
export function mariaDbCompletion(version: ServerVersion): CompletionSource {
  return phraseCompletion(
    PHRASES.filter((p) => atLeast(version, p.since)),
    (p) => `MariaDB ${p.since.join('.')}+`,
    /(?:FORMAT=)?[\w$]*/i
  )
}
