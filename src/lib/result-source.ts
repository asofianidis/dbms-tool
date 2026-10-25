import type { CompletionTable } from './api'
import type { Dialect } from './engines'
import { splitStatements, stripComments } from './sql'

/*
 * What a query result can be traced back to: whether running the text again
 * is harmless (to fetch more rows or stream an export), and whether its rows
 * come straight from one table, so they can be edited in place.
 */

const READ_START = /^(select|with|show|values|table|explain|describe|desc|pragma)\b/i
const WRITE_WORD =
  /\b(insert|update|delete|merge|upsert|replace|truncate|drop|alter|create|grant|revoke|call|exec|execute)\b/i

/** Whether every statement only reads, so running the text again changes nothing. */
export function isReadOnlyQuery(sql: string, dialect: Dialect): boolean {
  const statements = splitStatements(sql, dialect)
  if (!statements.length) return false
  return statements.every((s) => {
    const text = stripComments(s.text).trim()
    if (!READ_START.test(text)) return false
    // SELECT … INTO creates a table (T-SQL, PostgreSQL) or writes a file (MySQL)
    if (/\binto\b/i.test(text)) return false
    // A CTE can hold a data-modifying statement; FOR UPDATE takes locks the user meant
    return !WRITE_WORD.test(text.replace(/\bfor\s+update\b/gi, ''))
  })
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`
const TABLE_CLAUSE = new RegExp(
  String.raw`^\s*(${IDENT}(?:\s*\.\s*${IDENT}){0,2})(?:\s+(?:as\s+)?(${IDENT}))?\s*$`,
  'i'
)
const CLAUSE_END =
  /\b(where|order\s+by|limit|offset|fetch|for|option|window|qualify|with\s*\(|tablesample)\b/i
const NOT_SIMPLE =
  /\b(join|union|intersect|except|minus|group\s+by|having|distinct|into|over|pivot|unpivot|apply|lateral|connect\s+by|top\s*\(\s*\d+\s*\)\s*percent)\b/i
const ALIAS_KEYWORDS = new Set(['where', 'order', 'limit', 'offset', 'fetch', 'for', 'option'])

export function unquoteIdent(ident: string, dialect: Dialect): string {
  const t = ident.trim()
  if (t.startsWith('"')) return t.slice(1, -1).replace(/""/g, '"')
  if (t.startsWith('`') || t.startsWith('[')) return t.slice(1, -1)
  // PostgreSQL folds unquoted names to lower case
  return dialect === 'postgres' ? t.toLowerCase() : t
}

/** Splits on commas outside parentheses and quotes. */
function topLevelSplit(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === '`') quote = c
    else if (c === '[') quote = ']'
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim())
}

/** Index of the first top-level `from` keyword, or -1. */
function topLevelFrom(text: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === '`') quote = c
    else if (c === '[') quote = ']'
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (
      depth === 0 &&
      /f/i.test(c) &&
      /^from\b/i.test(text.slice(i, i + 5)) &&
      !/[\w$]/.test(text[i - 1] ?? ' ')
    )
      return i
  }
  return -1
}

export interface SingleTableSource {
  /** The table as written: [name], [schema, name] or [database, schema, name] */
  parts: string[]
  alias: string | null
  /** Every column (`*`) is selected as is */
  star: boolean
  /** Columns selected by plain name, unrenamed */
  columns: Set<string>
}

/**
 * The table a single plain `SELECT … FROM table [WHERE …] [ORDER BY …]` reads,
 * with the columns it passes through unchanged; null for anything else
 * (joins, grouping, subqueries, several statements).
 */
export function singleTableSource(sql: string, dialect: Dialect): SingleTableSource | null {
  const statements = splitStatements(sql, dialect)
  if (statements.length !== 1) return null
  const text = stripComments(statements[0].text).trim().replace(/;\s*$/, '')
  if (!/^select\b/i.test(text) || NOT_SIMPLE.test(text)) return null
  const from = topLevelFrom(text)
  if (from < 0) return null
  const list = text
    .slice(6, from)
    .replace(/^\s*all\b/i, '')
    // T-SQL TOP (n) / TOP n
    .replace(/^\s*top\s*(\(\s*\d+\s*\)|\d+)/i, '')
  const rest = text.slice(from + 4)
  const end = CLAUSE_END.exec(rest)
  const clause = end ? rest.slice(0, end.index) : rest
  if (clause.includes('(') || clause.includes(',')) return null
  const m = TABLE_CLAUSE.exec(clause)
  if (!m) return null
  const parts = m[1].split(/\s*\.\s*/).map((p) => unquoteIdent(p, dialect))
  const rawAlias = m[2] && !ALIAS_KEYWORDS.has(m[2].toLowerCase()) ? m[2] : null
  const alias = rawAlias ? unquoteIdent(rawAlias, dialect) : null
  const qualifiers = new Set(
    [alias, parts[parts.length - 1]].filter((q): q is string => !!q).map((q) => q.toLowerCase())
  )

  let star = false
  const columns = new Set<string>()
  const plain = new RegExp(String.raw`^(?:(${IDENT})\s*\.\s*)?(${IDENT}|\*)$`)
  for (const item of topLevelSplit(list)) {
    const p = plain.exec(item)
    if (!p) continue
    if (p[1] && !qualifiers.has(unquoteIdent(p[1], dialect).toLowerCase())) continue
    if (p[2] === '*') star = true
    else columns.add(unquoteIdent(p[2], dialect))
  }
  return { parts, alias, star, columns }
}

/** Schemas holding session-local temporary tables, which shadow permanent ones. */
const TEMP_SCHEMA = /^(pg_temp(_\d+)?|temp)$/i

/**
 * The completion entry for a table named by `parts`, preferring the default
 * schema when an unqualified name exists in several. Without a default schema
 * an ambiguous name resolves to null rather than a guess, as it does whenever
 * a temporary table shares the name (it shadows whatever search_path finds).
 */
export function resolveTable(
  parts: string[],
  tables: CompletionTable[],
  defaultSchema: string | undefined,
  dialect: Dialect
): CompletionTable | null {
  // MySQL qualifies by database, which completion lists don't carry
  if (dialect === 'mysql' || dialect === 'sqlite') {
    if (parts.length > 1) return null
  } else if (parts.length > 2) return null
  const same = (a: string | null, b: string): boolean =>
    dialect === 'postgres' ? a === b : a?.toLowerCase() === b.toLowerCase()
  const name = parts[parts.length - 1]
  const schema = parts.length === 2 ? parts[0] : null
  const matches = tables.filter((t) => same(t.name, name) && (!schema || same(t.schema, schema)))
  if (matches.length <= 1) return matches[0] ?? null
  if (!schema && matches.some((t) => t.schema && TEMP_SCHEMA.test(t.schema))) return null
  return matches.find((t) => defaultSchema && same(t.schema, defaultSchema)) ?? null
}
