/**
 * Extended JSON helpers. The backend sends documents as EJSON; the UI shows and
 * edits them in mongosh syntax (`ObjectId('…')`, `ISODate('…')`), and those
 * shell helpers turn edited text back into EJSON.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type BsonType =
  | 'ObjectId'
  | 'String'
  | 'Int32'
  | 'Int64'
  | 'Double'
  | 'Decimal128'
  | 'Boolean'
  | 'Date'
  | 'Null'
  | 'Array'
  | 'Object'
  | 'Binary'
  | 'UUID'
  | 'Regex'
  | 'Timestamp'
  | 'MinKey'
  | 'MaxKey'
  | 'Undefined'
  | 'Symbol'
  | 'Code'

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function onlyKey(v: Record<string, unknown>, key: string): boolean {
  const keys = Object.keys(v)
  return keys.length === 1 && keys[0] === key
}

export function bsonType(v: unknown): BsonType {
  if (v === null || v === undefined) return 'Null'
  if (typeof v === 'string') return 'String'
  if (typeof v === 'boolean') return 'Boolean'
  if (typeof v === 'number') return Number.isInteger(v) ? 'Int32' : 'Double'
  if (Array.isArray(v)) return 'Array'
  if (isObject(v)) {
    if (onlyKey(v, '$oid')) return 'ObjectId'
    if (onlyKey(v, '$date')) return 'Date'
    if (onlyKey(v, '$numberLong')) return 'Int64'
    if (onlyKey(v, '$numberInt')) return 'Int32'
    if (onlyKey(v, '$numberDouble')) return 'Double'
    if (onlyKey(v, '$numberDecimal')) return 'Decimal128'
    if (onlyKey(v, '$binary')) {
      const sub = (v.$binary as { subType?: string })?.subType
      return sub === '04' || sub === '4' ? 'UUID' : 'Binary'
    }
    if (onlyKey(v, '$uuid')) return 'UUID'
    if (onlyKey(v, '$regularExpression')) return 'Regex'
    if (onlyKey(v, '$timestamp')) return 'Timestamp'
    if (onlyKey(v, '$minKey')) return 'MinKey'
    if (onlyKey(v, '$maxKey')) return 'MaxKey'
    if (onlyKey(v, '$undefined')) return 'Undefined'
    if (onlyKey(v, '$symbol')) return 'Symbol'
    if ('$code' in v) return 'Code'
    return 'Object'
  }
  return 'String'
}

export function isContainer(v: unknown): boolean {
  const t = bsonType(v)
  return t === 'Object' || t === 'Array'
}

function dateString(v: unknown): string {
  if (typeof v === 'string') return v
  if (isObject(v) && typeof v.$numberLong === 'string') {
    return new Date(Number(v.$numberLong)).toISOString()
  }
  return String(v)
}

function base64ToHex(b64: string): string {
  try {
    return Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  } catch {
    return ''
  }
}

function hexToBase64(hex: string): string {
  const clean = hex.replace(/[^0-9a-f]/gi, '')
  let bin = ''
  for (let i = 0; i + 1 < clean.length; i += 2)
    bin += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16))
  return btoa(bin)
}

function uuidFromHex(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** One-line rendering of a scalar for grids and tree rows. */
export function scalarText(v: unknown): string {
  const t = bsonType(v)
  const o = v as Record<string, unknown>
  switch (t) {
    case 'Null':
      return 'null'
    case 'String':
      return v as string
    case 'Boolean':
    case 'Int32':
      return String(v)
    case 'Double':
      return typeof v === 'number' ? String(v) : String(o.$numberDouble)
    case 'ObjectId':
      return String(o.$oid)
    case 'Date':
      return dateString(o.$date)
    case 'Int64':
      return String(o.$numberLong)
    case 'Decimal128':
      return String(o.$numberDecimal)
    case 'UUID':
      return '$uuid' in o
        ? String(o.$uuid)
        : uuidFromHex(base64ToHex((o.$binary as { base64: string }).base64))
    case 'Binary': {
      const b = o.$binary as { base64: string; subType: string }
      return `Binary(${b.subType}, ${b.base64.length > 40 ? b.base64.slice(0, 40) + '…' : b.base64})`
    }
    case 'Regex': {
      const r = o.$regularExpression as { pattern: string; options: string }
      return `/${r.pattern}/${r.options}`
    }
    case 'Timestamp': {
      const ts = o.$timestamp as { t: number; i: number }
      return `Timestamp(${ts.t}, ${ts.i})`
    }
    case 'Array':
      return `Array (${(v as unknown[]).length})`
    case 'Object':
      return `Object (${Object.keys(o).length})`
    default:
      return JSON.stringify(v)
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function shellKey(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k)
}

/*
 * `toShell` output is evaluated by `parseShellValue`, and documents come from the
 * database, so every value written into it must stay a literal. MongoDB allows
 * `$`-prefixed field names, so a plain document can look like `{ $oid: '…' }`.
 */

/** A string argument: single-quoted when that's plainly safe, else JSON-quoted. */
function shellString(v: unknown): string {
  const s = String(v)
  return /^[\w.:+\-/=]*$/.test(s) ? `'${s}'` : JSON.stringify(s)
}

/** A numeric argument written verbatim only when it's a number literal. */
function shellNumber(v: unknown): string {
  const s = String(v)
  return /^-?(\d+(\.\d*)?([eE][+-]?\d+)?|NaN|Infinity)$/.test(s) ? s : JSON.stringify(s)
}

/**
 * A regex literal when it can't end early (every `/` escaped, no trailing lone
 * `\`, no line breaks, no `/*` or `//` comment) and JavaScript accepts it;
 * otherwise `BSONRegExp('…', '…')`, which also keeps PCRE-only syntax intact.
 */
function shellRegex(pattern: string, options: string): string {
  const escaped = pattern.replace(/(\\*)\//g, (m, slashes: string) =>
    slashes.length % 2 ? m : `${slashes}\\/`
  )
  const literal =
    escaped !== '' &&
    !escaped.startsWith('*') &&
    !/[\r\n\p{Zl}\p{Zp}]/u.test(escaped) &&
    (escaped.match(/\\*$/)?.[0].length ?? 0) % 2 === 0 &&
    /^[a-z]*$/.test(options)
  if (literal) {
    try {
      new RegExp(escaped, options)
      return `/${escaped}/${options}`
    } catch {
      // Not valid JavaScript (possessive quantifiers, inline flags): keep the text as-is
    }
  }
  return `BSONRegExp(${JSON.stringify(pattern)}, ${JSON.stringify(options)})`
}

/** mongosh-style text for an EJSON value; `parseShellValue` reads it back. */
export function toShell(v: unknown, indent = 2, depth = 0): string {
  const t = bsonType(v)
  const o = v as Record<string, unknown>
  const pad = ' '.repeat(indent * (depth + 1))
  const end = ' '.repeat(indent * depth)
  switch (t) {
    case 'Null':
      return 'null'
    case 'String':
      return JSON.stringify(v)
    case 'Boolean':
    case 'Int32':
      return typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : `NumberInt(${shellNumber(o.$numberInt)})`
    case 'Double': {
      const text = typeof v === 'number' ? String(v) : String(o.$numberDouble)
      if (/^(NaN|-?Infinity)$/.test(text)) return text
      // A literal like `3.0` reads back as an integer, so whole numbers keep the wrapper
      if (shellNumber(text) === text && Number.isInteger(Number(text)))
        return `Double(${text.replace(/\.0*$/, '')})`
      return shellNumber(text) === text ? text : `Double(${JSON.stringify(text)})`
    }
    case 'ObjectId':
      return `ObjectId(${shellString(o.$oid)})`
    case 'Date':
      return `ISODate(${shellString(dateString(o.$date))})`
    case 'Int64':
      return `NumberLong(${shellString(o.$numberLong)})`
    case 'Decimal128':
      return `NumberDecimal(${shellString(o.$numberDecimal)})`
    case 'UUID':
      return `UUID(${shellString(scalarText(v))})`
    case 'Binary': {
      const b = o.$binary as { base64: string; subType: string }
      return `BinData(${parseInt(b.subType, 16)}, ${shellString(b.base64)})`
    }
    case 'Regex': {
      const r = o.$regularExpression as { pattern: string; options: string }
      return shellRegex(String(r.pattern), String(r.options))
    }
    case 'Timestamp': {
      const ts = o.$timestamp as { t: number; i: number }
      return `Timestamp({ t: ${shellNumber(ts.t)}, i: ${shellNumber(ts.i)} })`
    }
    case 'MinKey':
      return 'MinKey()'
    case 'MaxKey':
      return 'MaxKey()'
    case 'Array': {
      const items = v as unknown[]
      if (!items.length) return '[]'
      const parts = items.map((item) => toShell(item, indent, depth + 1))
      if (indent === 0 || (parts.join(', ').length < 60 && !items.some(isContainer))) {
        return `[${parts.join(', ')}]`
      }
      return `[\n${parts.map((p) => pad + p).join(',\n')}\n${end}]`
    }
    case 'Object': {
      const entries = Object.entries(o)
      if (!entries.length) return '{}'
      const parts = entries.map(([k, val]) => `${shellKey(k)}: ${toShell(val, indent, depth + 1)}`)
      if (indent === 0) return `{ ${parts.join(', ')} }`
      return `{\n${parts.map((p) => pad + p).join(',\n')}\n${end}}`
    }
    default:
      return JSON.stringify(v)
  }
}

/* ---------- Shell helpers → EJSON ---------- */

/** Values produced by shell helpers like `ObjectId()`; serialized verbatim. */
export class Ejson {
  constructor(readonly value: Json) {}
  toJSON(): Json {
    return this.value
  }
}

/**
 * A date string read the way mongosh's `ISODate` does: date-times without a zone
 * designator are UTC, not local time.
 */
export function parseIsoDate(s: string): Date {
  const t = String(s).trim()
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(:\d{2}(\.\d+)?)?)$/.exec(t)
  return new Date(local ? `${local[1]}T${local[2]}Z` : t)
}

/** `$numberDouble` text; whole numbers keep a `.0` like the backend writes them. */
function doubleText(n: number): string {
  if (Object.is(n, -0)) return '-0.0'
  const s = String(n)
  return /^-?\d+$/.test(s) ? `${s}.0` : s
}

let oidCounter = Math.floor(Math.random() * 0xffffff)
const oidRandom = Array.from({ length: 5 }, () =>
  Math.floor(Math.random() * 256)
    .toString(16)
    .padStart(2, '0')
).join('')

export function newObjectIdHex(): string {
  const time = Math.floor(Date.now() / 1000)
    .toString(16)
    .padStart(8, '0')
  oidCounter = (oidCounter + 1) % 0xffffff
  return time + oidRandom + oidCounter.toString(16).padStart(6, '0')
}

export const shellHelpers = {
  ObjectId: (hex?: string) => {
    if (hex !== undefined && !/^[0-9a-f]{24}$/i.test(hex))
      throw new Error(`Invalid ObjectId: ${hex}`)
    return new Ejson({ $oid: (hex ?? newObjectIdHex()).toLowerCase() })
  },
  ISODate: (s?: string) => {
    const d = s === undefined ? new Date() : parseIsoDate(s)
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`)
    return d
  },
  NumberLong: (n: string | number | bigint) => new Ejson({ $numberLong: String(n) }),
  NumberInt: (n: string | number) => new Ejson({ $numberInt: String(Math.trunc(Number(n))) }),
  Int32: (n: string | number) => new Ejson({ $numberInt: String(Math.trunc(Number(n))) }),
  Long: (n: string | number | bigint) => new Ejson({ $numberLong: String(n) }),
  Double: (n: string | number) => new Ejson({ $numberDouble: doubleText(Number(n)) }),
  NumberDecimal: (s: string | number) => new Ejson({ $numberDecimal: String(s) }),
  Decimal128: (s: string | number) => new Ejson({ $numberDecimal: String(s) }),
  UUID: (s?: string) => {
    const hex = (s ?? crypto.randomUUID()).replace(/-/g, '')
    return new Ejson({ $binary: { base64: hexToBase64(hex), subType: '04' } })
  },
  BinData: (subType: number, base64: string) =>
    new Ejson({ $binary: { base64, subType: subType.toString(16).padStart(2, '0') } }),
  Timestamp: (t: number | { t: number; i: number }, i?: number) =>
    new Ejson({ $timestamp: typeof t === 'object' ? { t: t.t, i: t.i } : { t, i: i ?? 0 } }),
  BSONRegExp: (pattern: string, options = '') =>
    new Ejson({ $regularExpression: { pattern: String(pattern), options: String(options) } }),
  MinKey: () => new Ejson({ $minKey: 1 }),
  MaxKey: () => new Ejson({ $maxKey: 1 })
}

/** Converts a JS value built from shell syntax into EJSON. */
export function toEjson(v: unknown): Json {
  if (v === undefined) return null
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { $numberDouble: String(v) }
    if (Number.isInteger(v) && (v < -(2 ** 31) || v > 2 ** 31 - 1))
      return { $numberLong: String(v) }
    return v
  }
  if (typeof v === 'bigint') return { $numberLong: v.toString() }
  if (v instanceof Ejson) return v.value
  if (v instanceof Date) {
    const year = v.getUTCFullYear()
    return year >= 1970 && year <= 9999
      ? { $date: v.toISOString() }
      : { $date: { $numberLong: String(v.getTime()) } }
  }
  if (v instanceof RegExp)
    return { $regularExpression: { pattern: v.source, options: v.flags.replace(/[gyd]/g, '') } }
  if (Array.isArray(v)) return v.map(toEjson)
  if (typeof v === 'object') {
    const out: Record<string, Json> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val !== undefined) out[k] = toEjson(val)
    }
    return out
  }
  return String(v)
}

/** Evaluates shell-syntax text (`{ _id: ObjectId('…') }`) into EJSON. */
export function parseShellValue(text: string): Json {
  const source = text.trim()
  if (!source) return null
  const names = Object.keys(shellHelpers)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...names, 'Date', `"use strict"; return (${source}\n);`)
  const DateCtor = function (this: unknown, ...args: unknown[]) {
    // `new Date(...)` and `Date()` both yield a Date
    return new (Date as unknown as new (...a: unknown[]) => Date)(...args)
  }
  return toEjson(fn(...names.map((n) => shellHelpers[n as keyof typeof shellHelpers]), DateCtor))
}

function dateMillis(v: unknown): number {
  if (isObject(v) && typeof v.$numberLong === 'string') return Number(v.$numberLong)
  return Date.parse(String(v))
}

/** One spelling per value: dates as epoch millis, numbers tagged with their BSON type. */
function canonicalEjson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalEjson)
  const o = v as Record<string, unknown>
  switch (bsonType(v)) {
    case 'Date':
      return { $date: dateMillis(o.$date) }
    case 'Int32':
      return { $numberInt: String(Number(typeof v === 'number' ? v : o.$numberInt)) }
    case 'Double':
      return { $numberDouble: String(Number(typeof v === 'number' ? v : o.$numberDouble)) }
    case 'Int64':
      try {
        return { $numberLong: BigInt(String(o.$numberLong)).toString() }
      } catch {
        return v
      }
    case 'Object':
      return Object.fromEntries(Object.entries(o).map(([k, val]) => [k, canonicalEjson(val)]))
    default:
      return v
  }
}

/**
 * Whether two EJSON values hold the same BSON value, however each is spelled
 * (`…05Z` or `…05.000Z`, `{ $numberInt: '5' }` or `5`). Field order counts.
 */
export function sameEjson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalEjson(a)) === JSON.stringify(canonicalEjson(b))
}

/** Value at a dotted path, for table views of documents. */
export function getPath(doc: unknown, path: string): unknown {
  let current: unknown = doc
  for (const part of path.split('.')) {
    if (!isObject(current) && !Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
