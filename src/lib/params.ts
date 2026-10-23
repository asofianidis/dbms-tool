import type { Dialect } from './engines'
import { literal } from './sql'
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
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (c === '#' && dialect === 'mysql') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`' || (c === '[' && dialect === 'tsql')) {
      const close = c === '[' ? ']' : c
      i++
      while (i < n) {
        if (sql[i] === '\\' && dialect === 'mysql') {
          i += 2
          continue
        }
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            i += 2
            continue
          }
          break
        }
        i++
      }
      i++
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
    if (c === '$' && dialect === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length)
        i = end < 0 ? n : end + m[0].length
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

/** `sql` with every placeholder replaced by its value's SQL. */
export function substituteParams(
  sql: string,
  dialect: Dialect,
  values: Record<string, ParamValue>
): string {
  let out = ''
  let last = 0
  for (const p of findParams(sql, dialect)) {
    const value = values[p.name]
    if (!value) continue
    out += sql.slice(last, p.from) + paramSql(dialect, value)
    last = p.to
  }
  return out + sql.slice(last)
}
