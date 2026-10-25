import type { CompletionSource } from '@codemirror/autocomplete'
import { PostgreSQL, SQLDialect } from '@codemirror/lang-sql'
import type { ServerInfo } from '@/lib/api'
import { phraseCompletion, type Phrase as BasePhrase } from './phrase-completion'

/*
 * PostgreSQL's own clauses: MERGE (15+, BY SOURCE / TARGET and RETURNING in 17),
 * SQL/JSON predicates (16+), ON CONFLICT, LATERAL, WITH ORDINALITY, FILTER,
 * GROUPING SETS / CUBE / ROLLUP and the like. Highlighting adds the SQL/JSON words
 * lang-sql's PostgreSQL dialect lacks.
 */

export const PostgresSQL = SQLDialect.define({
  ...PostgreSQL.spec,
  keywords: `${PostgreSQL.spec.keywords} target excluded keys scalar conditional unconditional quotes omit keep nested`,
  types: `${PostgreSQL.spec.types} jsonpath`
})

/**
 * The major version to complete for, from the server info; undefined for other
 * servers. An unreadable version offers everything rather than nothing.
 */
export function editorPostgres(
  info: Pick<ServerInfo, 'product'> | null | undefined
): number | undefined {
  if (!info || !/^postgresql\b/i.test(info.product)) return undefined
  const match = /(\d+)/.exec(info.product)
  return match ? Number(match[1]) : Infinity
}

interface Phrase extends BasePhrase {
  /** The major version that added it */
  since: number
}

/** Right after a table or set-returning function in FROM or JOIN */
const FROM_ITEM = /\b(?:from|join|lateral)\b[^;]*$/i
const SELECT = /\bselect\b/i
const MERGE = /^\s*(?:with\b[\s\S]*\)\s*)?merge\b/i
const INSERT = /^\s*(?:with\b[\s\S]*\)\s*)?insert\s+into\b/i
const WRITE = /^\s*(?:with\b[\s\S]*\)\s*)?(?:insert|update|delete)\b/i
/** Where a boolean expression goes */
const PREDICATE = /\b(?:select|where|when|having|check|and|or|on)\b/i

const PHRASES: Phrase[] = [
  // MERGE
  {
    words: 'MERGE INTO',
    tail: ' ${target} AS t\nUSING ${source} AS s\nON ${t.id = s.id}\nWHEN MATCHED THEN\n  UPDATE SET ${column} = s.${column}\nWHEN NOT MATCHED THEN\n  INSERT (${columns}) VALUES (${values})',
    since: 15,
    start: true
  },
  { words: 'WHEN MATCHED THEN UPDATE SET', tail: ' ${column} = ${value}', since: 15, where: MERGE },
  { words: 'WHEN MATCHED THEN DELETE', since: 15, where: MERGE },
  { words: 'WHEN MATCHED THEN DO NOTHING', since: 15, where: MERGE },
  { words: 'WHEN MATCHED AND', tail: ' ${condition} THEN', since: 15, where: MERGE },
  {
    words: 'WHEN NOT MATCHED THEN INSERT',
    tail: ' (${columns}) VALUES (${values})',
    since: 15,
    where: MERGE
  },
  {
    words: 'WHEN NOT MATCHED BY TARGET THEN INSERT',
    tail: ' (${columns}) VALUES (${values})',
    since: 17,
    where: MERGE
  },
  { words: 'WHEN NOT MATCHED BY SOURCE THEN DELETE', since: 17, where: MERGE },
  {
    words: 'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET',
    tail: ' ${column} = ${value}',
    since: 17,
    where: MERGE
  },
  { words: 'RETURNING', tail: ' merge_action(), ${*}', since: 17, where: MERGE },
  // INSERT … ON CONFLICT and RETURNING
  { words: 'ON CONFLICT DO NOTHING', since: 13, where: INSERT },
  {
    words: 'ON CONFLICT',
    tail: ' (${key}) DO UPDATE SET ${column} = EXCLUDED.${column}',
    since: 13,
    where: INSERT
  },
  {
    words: 'ON CONFLICT ON CONSTRAINT',
    tail: ' ${constraint} DO UPDATE SET ${column} = EXCLUDED.${column}',
    since: 13,
    where: INSERT
  },
  { words: 'RETURNING', tail: ' ${*}', since: 13, where: WRITE },
  // FROM items
  { words: 'WITH ORDINALITY', tail: ' AS ${alias}(${value}, ${n})', since: 13, where: FROM_ITEM },
  { words: 'CROSS JOIN LATERAL', tail: ' (${subquery}) AS ${alias}', since: 13, where: FROM_ITEM },
  {
    words: 'LEFT JOIN LATERAL',
    tail: ' (${subquery}) AS ${alias} ON true',
    since: 13,
    where: FROM_ITEM
  },
  {
    words: 'TABLESAMPLE SYSTEM',
    tail: ' (${percent})',
    since: 13,
    where: FROM_ITEM
  },
  // SELECT
  { words: 'DISTINCT ON', tail: ' (${expression})', since: 13, where: /\bselect$/i },
  { words: 'FILTER', tail: ' (WHERE ${condition})', since: 13, where: SELECT },
  { words: 'WITHIN GROUP', tail: ' (ORDER BY ${expression})', since: 13, where: SELECT },
  { words: 'GROUP BY GROUPING SETS', tail: ' ((${a}), (${b}), ())', since: 13, where: SELECT },
  { words: 'GROUP BY ROLLUP', tail: ' (${columns})', since: 13, where: SELECT },
  { words: 'GROUP BY CUBE', tail: ' (${columns})', since: 13, where: SELECT },
  { words: 'FETCH FIRST', tail: ' ${n} ROWS WITH TIES', since: 13, where: /\border\s+by\b/i },
  { words: 'FOR UPDATE SKIP LOCKED', since: 13, where: SELECT },
  // SQL/JSON predicates
  { words: 'IS JSON', since: 16, where: PREDICATE },
  { words: 'IS NOT JSON', since: 16, where: PREDICATE },
  { words: 'IS JSON OBJECT', since: 16, where: PREDICATE },
  { words: 'IS JSON ARRAY', since: 16, where: PREDICATE },
  { words: 'IS JSON SCALAR', since: 16, where: PREDICATE },
  { words: 'IS JSON WITH UNIQUE KEYS', since: 16, where: PREDICATE }
]

/** PostgreSQL's multi-word clauses the server's major version has. */
export function postgresCompletion(version: number): CompletionSource {
  return phraseCompletion(
    PHRASES.filter((p) => version >= p.since),
    (p) => (p.since > 13 ? `PostgreSQL ${p.since}+` : 'PostgreSQL')
  )
}

/** For tests: every phrase, to run against a server */
export const POSTGRES_PHRASES: readonly Phrase[] = PHRASES
