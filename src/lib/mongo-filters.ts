import {
  bsonType,
  parseIsoDate,
  parseShellValue,
  shellHelpers,
  toEjson,
  toShell,
  type BsonType
} from './ejson'
import {
  OPERATORS,
  type ColumnKind,
  type FilterCondition,
  type QueryState,
  type SortKey
} from './filters'

/* ---------- Data view query builder, for MongoDB collections ---------- */

type Doc = Record<string, unknown>

export function bsonKind(type: string): ColumnKind {
  switch (type) {
    case 'String':
      return 'text'
    case 'Int32':
    case 'Int64':
    case 'Double':
    case 'Decimal128':
      return 'number'
    case 'Date':
    case 'Timestamp':
      return 'date'
    case 'Boolean':
      return 'boolean'
    default:
      return 'other'
  }
}

/**
 * Dotted field paths seen in sampled documents, with each path's most common
 * non-null BSON type ('' when only nulls were seen).
 */
export function sampleFields(documents: Doc[], maxDepth = 3): Record<string, string> {
  const counts = new Map<string, Map<BsonType, number>>()
  const visit = (obj: Doc, prefix: string, depth: number): void => {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key
      const types = counts.get(path) ?? counts.set(path, new Map()).get(path)!
      const type = bsonType(value)
      if (type !== 'Null') types.set(type, (types.get(type) ?? 0) + 1)
      if (depth >= maxDepth) continue
      if (type === 'Object') visit(value as Doc, path, depth + 1)
      // Dotted paths reach into arrays of subdocuments
      else if (type === 'Array')
        for (const item of (value as unknown[]).slice(0, 25))
          if (bsonType(item) === 'Object') visit(item as Doc, path, depth + 1)
    }
  }
  for (const doc of documents.slice(0, 2000)) visit(doc, '', 0)
  const fields: Record<string, string> = {}
  for (const [path, types] of counts) {
    fields[path] = [...types].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  }
  return fields
}

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** Typed text from the builder: mongosh literals like ObjectId('…') work for any field. */
function typedValue(text: string, type: string): unknown {
  const t = text.trim()
  switch (bsonKind(type)) {
    case 'text':
      return text
    case 'number':
      // Same BSON type as the field: a double never equals Decimal128 1.10, and
      // Int64 values past 2^53 would round
      if (type === 'Decimal128' && DECIMAL.test(t)) return shellHelpers.NumberDecimal(t)
      if (type === 'Int64' && /^[+-]?\d+$/.test(t)) return shellHelpers.NumberLong(BigInt(t))
      if (t && Number.isFinite(Number(t))) return Number(t)
      break
    case 'date': {
      if (type === 'Timestamp') {
        if (/^\d+$/.test(t)) return shellHelpers.Timestamp(Number(t), 0)
        const d = parseIsoDate(t)
        if (t && !/^[A-Za-z]\w*\(/.test(t) && !Number.isNaN(d.getTime()))
          return shellHelpers.Timestamp(Math.floor(d.getTime() / 1000), 0)
        break
      }
      const d = parseIsoDate(t)
      if (t && !Number.isNaN(d.getTime())) return d
      break
    }
    case 'boolean':
      if (t === 'true' || t === 'false') return t === 'true'
      break
    default:
      if (type === 'ObjectId' && /^[0-9a-f]{24}$/i.test(t)) return shellHelpers.ObjectId(t)
  }
  if (/^(-?\d|true$|false$|null$|['"[{]|[A-Za-z]\w*\()/.test(t)) {
    try {
      return parseShellValue(t)
    } catch {
      // Not a literal after all; compare as text
    }
  }
  return text
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** Filter document for one condition (shell values, not yet EJSON), or null while it's incomplete. */
function conditionFilter(c: FilterCondition, type = ''): Doc | null {
  if (c.kind === 'sql') {
    if (!c.sql.trim()) return null
    const value = parseShellValue(c.sql)
    if (bsonType(value) !== 'Object') throw new Error(`Not a filter document: ${c.sql.trim()}`)
    return value as Doc
  }
  if (!c.column.trim()) return null
  const operands = OPERATORS[c.op].operands
  // An empty value only means something as text: = ''
  const emptyText = ['eq', 'neq'].includes(c.op) && ['text', 'other'].includes(bsonKind(type))
  if (operands >= 1 && c.value === '' && !emptyText) return null
  if (operands === 2 && c.value2 === '') return null
  const value = (v: string): unknown => typedValue(v, type)
  // Case-insensitive, like LIKE under most SQL collations
  const regex = (prefix: string, suffix: string): RegExp =>
    new RegExp(`${prefix}${escapeRegex(c.value)}${suffix}`, 'i')
  const list = (): unknown[] =>
    c.value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map(value)
  const field = (condition: unknown): Doc => ({ [c.column.trim()]: condition })
  switch (c.op) {
    case 'eq':
      return field(value(c.value))
    case 'neq':
      return field({ $ne: value(c.value) })
    case 'lt':
      return field({ $lt: value(c.value) })
    case 'lte':
      return field({ $lte: value(c.value) })
    case 'gt':
      return field({ $gt: value(c.value) })
    case 'gte':
      return field({ $gte: value(c.value) })
    case 'contains':
      return field(regex('', ''))
    case 'not_contains':
      return field({ $not: regex('', '') })
    case 'starts':
      return field(regex('^', ''))
    case 'ends':
      return field(regex('', '$'))
    case 'in':
    case 'not_in': {
      const values = list()
      if (!values.length) return null
      return field({ [c.op === 'in' ? '$in' : '$nin']: values })
    }
    case 'between':
      return field({ $gte: value(c.value), $lte: value(c.value2) })
    case 'null':
      // Matches missing fields too
      return field(null)
    case 'not_null':
      return field({ $ne: null })
    case 'true':
    case 'false':
      return field(c.op === 'true')
  }
}

/** The find filter (EJSON) for the enabled, complete conditions, or null for none. */
export function buildMongoFilter(
  query: QueryState,
  types: Record<string, string> = {}
): Doc | null {
  const parts = query.conditions
    .filter((c) => c.enabled)
    .map((c) => conditionFilter(c, types[c.column]))
    .filter((f): f is Doc => !!f)
  if (!parts.length) return null
  const filter = parts.length === 1 ? parts[0] : { [query.match === 'all' ? '$and' : '$or']: parts }
  return toEjson(filter) as Doc
}

export function buildMongoSort(sorts: SortKey[]): Doc | null {
  const keys = sorts.filter((s) => s.column.trim())
  return keys.length
    ? Object.fromEntries(keys.map((s) => [s.column.trim(), s.dir === 'asc' ? 1 : -1]))
    : null
}

/** Both filters must match. */
export function andFilters(...filters: (Doc | null | undefined)[]): Doc {
  const present = filters.filter((f): f is Doc => !!f && Object.keys(f).length > 0)
  return present.length > 1 ? { $and: present } : (present[0] ?? {})
}

/** mongosh text for the builder's preview. */
export function describeMongoQuery(query: QueryState, types: Record<string, string> = {}): string {
  let filter: string
  try {
    const f = buildMongoFilter(query, types)
    filter = f ? `find(${toShell(f, 0)})` : '// no filter'
  } catch (e) {
    filter = `// ${e instanceof Error ? e.message : String(e)}`
  }
  const sort = buildMongoSort(query.sorts)
  return sort ? `${filter}\n.sort(${toShell(sort, 0)})` : filter
}
