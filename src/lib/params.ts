import type { Dialect } from './engines'
import { literal, skipQuoted } from './sql'
import { createPersistentStore } from './store'

/**
 * Query parameters: `:name` and `${name}` placeholders, filled in before a
 * script runs. Strings, quoted identifiers, comments and PostgreSQL
 * dollar-quoted bodies are skipped, as are `::` casts and `:=` assignments.
 */
export interface ParamRef {
  name: string
  from: number
  to: number
}

/** auto: numbers as-is, anything else as a string literal; raw: pasted as SQL */
export type ParamMode = 'auto' | 'text' | 'raw'

export interface ParamValue {
  value: string
  mode: ParamMode
}

/** Values last used per parameter name, so re-running doesn't mean retyping. */
export const paramValuesStore = createPersistentStore<Record<string, ParamValue>>(
  'query-params',
  {}
)

const IDENT_START = /[A-Za-z_]/
const IDENT = /[A-Za-z0-9_]/

export function findParams(sql: string, dialect: Dialect): ParamRef[] {
  const out: ParamRef[] = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    const skip = skipQuoted(sql, i, dialect)
    if (skip >= 0) {
      i = skip
      continue
    }
    if (c === '$' && next === '{') {
      const m = /^\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/.exec(sql.slice(i))
      if (m) {
        out.push({ name: m[1], from: i, to: i + m[0].length })
        i += m[0].length
        continue
      }
    }
    if (c === ':') {
      if (next === ':') {
        // A cast (`::type`); `:::` doesn't occur in valid SQL
        i += 2
        continue
      }
      const prev = i > 0 ? sql[i - 1] : ''
      // `a[1:n]`, `x:y` and the like are slices or labels, not parameters
      const standalone = !prev || !(IDENT.test(prev) || prev === ']' || prev === ')')
      if (standalone && next && IDENT_START.test(next)) {
        let j = i + 1
        while (j < n && IDENT.test(sql[j])) j++
        out.push({ name: sql.slice(i + 1, j), from: i, to: j })
        i = j
        continue
      }
    }
    i++
  }
  return out
}

/** Distinct parameter names in order of first use. */
export function paramNames(sql: string, dialect: Dialect): string[] {
  return [...new Set(findParams(sql, dialect).map((p) => p.name))]
}

const NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i

export function paramSql(dialect: Dialect, param: ParamValue): string {
  if (param.mode === 'raw') return param.value
  if (param.mode === 'auto' && NUMBER.test(param.value.trim())) return param.value.trim()
  return literal(dialect, param.value)
}

/** Where a placeholder was (`from`–`to`) and where its value ended up (`outFrom`–`outTo`). */
export interface Substitution {
  from: number
  to: number
  outFrom: number
  outTo: number
}

/** `sql` with every placeholder replaced by its value's SQL. */
export function substituteParams(
  sql: string,
  dialect: Dialect,
  values: Record<string, ParamValue>
): string {
  return fillParams(sql, dialect, values).sql
}

/** Like `substituteParams`, plus the spans needed to map error positions back. */
export function fillParams(
  sql: string,
  dialect: Dialect,
  values: Record<string, ParamValue>
): { sql: string; spans: Substitution[] } {
  let out = ''
  let last = 0
  const spans: Substitution[] = []
  for (const p of findParams(sql, dialect)) {
    const value = values[p.name]
    if (!value) continue
    out += sql.slice(last, p.from)
    const outFrom = out.length
    out += paramSql(dialect, value)
    spans.push({ from: p.from, to: p.to, outFrom, outTo: out.length })
    last = p.to
  }
  return { sql: out + sql.slice(last), spans }
}

/**
 * Maps an offset in the filled-in text back to the text as written. An offset
 * inside a value maps to its placeholder's start, or its end with `edge: 'end'`.
 */
export function sourceOffset(
  pos: number,
  spans: Substitution[],
  edge: 'start' | 'end' = 'start'
): number {
  let delta = 0
  for (const s of spans) {
    if (pos < s.outFrom) break
    if (pos < s.outTo || (edge === 'end' && pos === s.outTo)) return edge === 'end' ? s.to : s.from
    delta = s.to - s.outTo
  }
  return pos + delta
}
