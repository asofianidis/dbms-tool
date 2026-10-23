import type { Dialect } from './engines'
import { isNumericType, literal, quoteIdent } from './sql'

/* ---------- Data view query builder ---------- */

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'contains'
  | 'not_contains'
  | 'starts'
  | 'ends'
  | 'in'
  | 'not_in'
  | 'between'
  | 'null'
  | 'not_null'
  | 'true'
  | 'false'

export interface FilterCondition {
  id: string
  enabled: boolean
  /** A column comparison, or a raw SQL expression */
  kind: 'column' | 'sql'
  column: string
  op: FilterOp
  value: string
  /** Upper bound for BETWEEN */
  value2: string
  sql: string
}

export interface SortKey {
  column: string
  dir: 'asc' | 'desc'
}

export interface QueryState {
  /** Whether rows must match all conditions or any of them */
  match: 'all' | 'any'
  conditions: FilterCondition[]
  sorts: SortKey[]
}

export const emptyQuery = (): QueryState => ({ match: 'all', conditions: [], sorts: [] })

export type ColumnKind = 'text' | 'number' | 'date' | 'boolean' | 'other'

export function columnKind(dataType: string): ColumnKind {
  const t = dataType.trim().toLowerCase()
  if (/^(bool|boolean|bit)\b/.test(t)) return 'boolean'
  if (isNumericType(t)) return 'number'
  if (/date|time|year|interval/.test(t)) return 'date'
  if (/char|text|uuid|uniqueidentifier|enum|name|citext|string/.test(t)) return 'text'
  return 'other'
}

export const OPERATORS: Record<FilterOp, { label: string; operands: 0 | 1 | 2 }> = {
  eq: { label: 'equals', operands: 1 },
  neq: { label: 'not equal', operands: 1 },
  lt: { label: '<', operands: 1 },
  lte: { label: '≤', operands: 1 },
  gt: { label: '>', operands: 1 },
  gte: { label: '≥', operands: 1 },
  contains: { label: 'contains', operands: 1 },
  not_contains: { label: "doesn't contain", operands: 1 },
  starts: { label: 'starts with', operands: 1 },
  ends: { label: 'ends with', operands: 1 },
  in: { label: 'is one of', operands: 1 },
  not_in: { label: 'is not one of', operands: 1 },
  between: { label: 'between', operands: 2 },
  null: { label: 'is NULL', operands: 0 },
  not_null: { label: 'is not NULL', operands: 0 },
  true: { label: 'is true', operands: 0 },
  false: { label: 'is false', operands: 0 }
}

const TEXT_OPS: FilterOp[] = ['contains', 'not_contains', 'starts', 'ends']
const RANGE_OPS: FilterOp[] = ['lt', 'lte', 'gt', 'gte', 'between']
const NULL_OPS: FilterOp[] = ['null', 'not_null']

export function operatorsFor(kind: ColumnKind): FilterOp[] {
  switch (kind) {
    case 'boolean':
      return ['true', 'false', ...NULL_OPS]
    case 'text':
      return [...TEXT_OPS, 'eq', 'neq', 'in', 'not_in', ...RANGE_OPS, ...NULL_OPS]
    case 'number':
    case 'date':
      return ['eq', 'neq', ...RANGE_OPS, 'in', 'not_in', ...NULL_OPS]
    case 'other':
      return ['eq', 'neq', ...TEXT_OPS, 'in', 'not_in', ...RANGE_OPS, ...NULL_OPS]
  }
}

let seq = 0

export function newCondition(patch: Partial<FilterCondition> = {}): FilterCondition {
  return {
    id: `f${++seq}`,
    enabled: true,
    kind: 'column',
    column: '',
    op: 'eq',
    value: '',
    value2: '',
    sql: '',
    ...patch
  }
}

/** A LIKE pattern literal with `!` as the escape character, which every dialect accepts. */
function likePattern(dialect: Dialect, value: string, prefix: string, suffix: string): string {
  const special = dialect === 'tsql' ? /[!%_[]/g : /[!%_]/g
  return `${literal(dialect, `${prefix}${value.replace(special, '!$&')}${suffix}`)} ESCAPE '!'`
}

/** SQL for one condition, or null while it's incomplete. */
export function conditionSql(dialect: Dialect, c: FilterCondition, dataType = ''): string | null {
  if (c.kind === 'sql') return c.sql.trim() ? `(${c.sql.trim()})` : null
  if (!c.column) return null
  const column = quoteIdent(dialect, c.column)
  const value = (v: string): string => literal(dialect, v, dataType)
  const operands = OPERATORS[c.op].operands
  // An empty value only means something as text: = ''
  const emptyText = ['eq', 'neq'].includes(c.op) && ['text', 'other'].includes(columnKind(dataType))
  if (operands >= 1 && c.value === '' && !emptyText) return null
  if (operands === 2 && c.value2 === '') return null
  const like = (prefix: string, suffix: string, negate = false): string =>
    // PostgreSQL LIKE is case-sensitive and text-only; MySQL and SQL Server collations usually aren't
    dialect === 'postgres'
      ? `${column}::text ${negate ? 'NOT ' : ''}ILIKE ${likePattern(dialect, c.value, prefix, suffix)}`
      : `${column} ${negate ? 'NOT ' : ''}LIKE ${likePattern(dialect, c.value, prefix, suffix)}`
  const list = (): string[] =>
    c.value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map(value)
  switch (c.op) {
    case 'eq':
      return `${column} = ${value(c.value)}`
    case 'neq':
      return `${column} <> ${value(c.value)}`
    case 'lt':
      return `${column} < ${value(c.value)}`
    case 'lte':
      return `${column} <= ${value(c.value)}`
    case 'gt':
      return `${column} > ${value(c.value)}`
    case 'gte':
      return `${column} >= ${value(c.value)}`
    case 'contains':
      return like('%', '%')
    case 'not_contains':
      return like('%', '%', true)
    case 'starts':
      return like('', '%')
    case 'ends':
      return like('%', '')
    case 'in':
    case 'not_in': {
      const values = list()
      if (!values.length) return null
      return `${column} ${c.op === 'not_in' ? 'NOT IN' : 'IN'} (${values.join(', ')})`
    }
    case 'between':
      return `${column} BETWEEN ${value(c.value)} AND ${value(c.value2)}`
    case 'null':
      return `${column} IS NULL`
    case 'not_null':
      return `${column} IS NOT NULL`
    case 'true':
    case 'false':
      // SQL Server bit columns have no IS TRUE
      return dialect === 'tsql'
        ? `${column} = ${c.op === 'true' ? 1 : 0}`
        : `${column} IS ${c.op === 'true' ? 'TRUE' : 'FALSE'}`
  }
}

/** The WHERE condition for the enabled, complete conditions ('' for none). */
export function buildWhere(
  dialect: Dialect,
  query: QueryState,
  types: Record<string, string> = {}
): string {
  return query.conditions
    .filter((c) => c.enabled)
    .map((c) => conditionSql(dialect, c, types[c.column]))
    .filter((s): s is string => !!s)
    .join(query.match === 'all' ? ' AND ' : ' OR ')
}

export function buildOrderBy(dialect: Dialect, sorts: SortKey[]): string {
  return sorts.map((s) => `${quoteIdent(dialect, s.column)} ${s.dir.toUpperCase()}`).join(', ')
}

/** Short human label for a condition chip. */
export function describeCondition(c: FilterCondition): string {
  if (c.kind === 'sql') return c.sql.trim()
  const op = OPERATORS[c.op]
  const operands =
    op.operands === 0 ? '' : op.operands === 2 ? ` ${c.value} – ${c.value2}` : ` ${c.value}`
  return `${c.column} ${op.label}${operands}`
}
