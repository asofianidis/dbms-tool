import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import { MariaSQL, SQLDialect } from '@codemirror/lang-sql'
import type { ServerInfo } from '@/lib/api'
import { isMariaDb, mariaDbVersion, type ServerVersion } from '@/lib/mariadb'
import { statementAround } from './sql-completion'

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

interface Phrase {
  /** The words, completed one or more at a time */
  words: string
  /** Snippet text after the last word, with `${field}` placeholders */
  tail?: string
  since: [major: number, minor: number]
  /** Only at the start of a statement */
  start?: boolean
  /** Only in statements whose text before the phrase matches */
  where?: RegExp
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
  const phrases = PHRASES.filter((p) => atLeast(version, p.since))
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/(?:FORMAT=)?[\w$]*/i)
    if (!word || (word.from === word.to && !context.explicit)) return null
    const doc = context.state.doc.toString()
    const { from } = statementAround(doc, context.pos)
    const before = doc.slice(from, word.from)
    // The statement's words before the one being typed, most recent last
    const typed = before.trim() ? before.trim().split(/\s+/) : []
    const current = word.text.toUpperCase()
    const out: Completion[] = []
    for (const p of phrases) {
      const words = p.words.split(' ')
      for (let k = 0; k < words.length; k++) {
        // The phrase's first k words are the last k typed
        if (k > typed.length) break
        const lead = typed.slice(typed.length - k)
        if (lead.some((w, i) => w.toUpperCase() !== words[i])) continue
        if (!words[k].startsWith(current)) continue
        const rest = typed.slice(0, typed.length - k)
        if (p.start && rest.length) continue
        if (p.where && !p.where.test(rest.join(' '))) continue
        const label = words.slice(k).join(' ')
        out.push(
          snippetCompletion(label + (p.tail ?? ''), {
            label,
            detail: `MariaDB ${p.since.join('.')}+`,
            type: 'keyword'
          })
        )
        break
      }
    }
    return out.length ? { from: word.from, options: out } : null
  }
}
