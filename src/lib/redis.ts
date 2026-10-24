import type { RData, RedisKeyEntry, RedisReply, RedisRequest } from './api'

/* ---------- Binary-safe values ---------- */

export function isHex(d: RData | null | undefined): d is { $hex: string } {
  return !!d && typeof d === 'object' && '$hex' in d
}

/** Text for display; binary data as `\xNN` escapes, the way redis-cli shows it. */
export function dataText(d: RData | null | undefined): string {
  if (d == null) return ''
  if (!isHex(d)) return d
  return d.$hex.replace(/../g, (h) => {
    const n = parseInt(h, 16)
    return n >= 0x20 && n < 0x7f && n !== 0x5c ? String.fromCharCode(n) : `\\x${h}`
  })
}

export function sameData(a: RData, b: RData): boolean {
  return isHex(a) || isHex(b)
    ? isHex(a) && isHex(b) && a.$hex.toLowerCase() === b.$hex.toLowerCase()
    : a === b
}

export function dataKey(d: RData): string {
  return isHex(d) ? `hex:${d.$hex}` : `str:${d}`
}

/** Byte length of a value (UTF-8 for text). */
export function dataBytes(d: RData): number {
  return isHex(d) ? d.$hex.length / 2 : new TextEncoder().encode(d).length
}

/** Pretty-printed JSON when a string holds an object or array, else null. */
export function prettyJson(text: string): string | null {
  const t = text.trim()
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']')))
    return null
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return null
  }
}

/* ---------- Types ---------- */

export const KEY_TYPES: { value: string; label: string; short: string; tone: string }[] = [
  { value: 'string', label: 'String', short: 'STR', tone: 'bg-info/15 text-info' },
  { value: 'hash', label: 'Hash', short: 'HASH', tone: 'bg-mysql/15 text-mysql' },
  { value: 'list', label: 'List', short: 'LIST', tone: 'bg-ok/15 text-ok' },
  { value: 'set', label: 'Set', short: 'SET', tone: 'bg-babelfish/15 text-babelfish' },
  { value: 'zset', label: 'Sorted set', short: 'ZSET', tone: 'bg-warn/15 text-warn' },
  { value: 'stream', label: 'Stream', short: 'STRM', tone: 'bg-redis/15 text-redis' },
  { value: 'ReJSON-RL', label: 'JSON', short: 'JSON', tone: 'bg-syn-keyword/15 text-syn-keyword' }
]

export function keyType(type: string): { label: string; short: string; tone: string } {
  return (
    KEY_TYPES.find((t) => t.value === type) ?? {
      label: type,
      short: type.slice(0, 4).toUpperCase(),
      tone: 'bg-muted/15 text-muted'
    }
  )
}

/* ---------- TTLs ---------- */

/** `90061000` → `1d 1h`; -1 → `No expiry`. */
export function formatTtl(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return 'No expiry'
  const s = Math.ceil(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  return ms < 1000 ? `${ms}ms` : `${s}s`
}

/** `90`, `90s`, `5m`, `1h30m`, `2d` → milliseconds; empty → null (no expiry). */
export function parseTtl(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '')
  if (!t) return null
  if (/^\d+$/.test(t)) return Number(t) * 1000
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  let total = 0
  let rest = t
  while (rest) {
    const m = rest.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)/)
    if (!m) throw new Error(`Couldn't read "${text}" as a duration (try 90s, 5m, 1h30m or 2d)`)
    total += Number(m[1]) * units[m[2]]
    rest = rest.slice(m[0].length)
  }
  return Math.round(total)
}

/* ---------- Console ---------- */

/** Splits a command line into arguments with redis-cli's quoting rules. */
export function parseCommandLine(line: string): string[] {
  const args: string[] = []
  let i = 0
  const n = line.length
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++
    if (i >= n) break
    let arg = ''
    let quoted = false
    while (i < n && !/\s/.test(line[i])) {
      const c = line[i]
      if (c === '"') {
        quoted = true
        i++
        let closed = false
        while (i < n) {
          const ch = line[i]
          if (ch === '\\' && i + 1 < n) {
            const next = line[i + 1]
            if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
              arg += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16))
              i += 4
              continue
            }
            const escapes: Record<string, string> = {
              n: '\n',
              r: '\r',
              t: '\t',
              b: '\b',
              a: '\x07'
            }
            arg += escapes[next] ?? next
            i += 2
          } else if (ch === '"') {
            closed = true
            i++
            break
          } else {
            arg += ch
            i++
          }
        }
        if (!closed) throw new Error('Unbalanced quotes in the command')
      } else if (c === "'") {
        quoted = true
        i++
        let closed = false
        while (i < n) {
          if (line[i] === '\\' && line[i + 1] === "'") {
            arg += "'"
            i += 2
          } else if (line[i] === "'") {
            closed = true
            i++
            break
          } else {
            arg += line[i++]
          }
        }
        if (!closed) throw new Error('Unbalanced quotes in the command')
      } else {
        arg += c
        i++
      }
    }
    if (arg || quoted) args.push(arg)
  }
  return args
}

/** Commands in a script: one per line, skipping blanks and `#` / `//` comments. */
export function scriptCommands(text: string): { line: number; text: string }[] {
  return text
    .split(/\r?\n/)
    .map((t, i) => ({ line: i + 1, text: t.trim() }))
    .filter((l) => l.text && !l.text.startsWith('#') && !l.text.startsWith('//'))
}

const ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t'
}

/** Double-quoted with escapes; control characters as `\xNN`, other text as is. */
function cliQuote(text: string): string {
  const escaped = text.replace(
    /[\\"\n\r\t]|[\x00-\x1f\x7f]/g,
    (c) => ESCAPES[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`
  )
  return `"${escaped}"`
}

/** Quotes a value for the console when it needs it. */
export function quoteArg(s: string): string {
  return s && !/[\s"'\\\x00-\x1f\x7f]/.test(s) ? s : cliQuote(s)
}

function quoteBulk(d: RData): string {
  if (!isHex(d)) return cliQuote(d)
  // dataText already escapes the binary bytes; only quotes need adding
  return `"${dataText(d).replace(/"/g, '\\"')}"`
}

/** A reply as redis-cli prints it. */
export function formatReply(reply: RedisReply, indent = 0): string {
  switch (reply.t) {
    case 'nil':
      return '(nil)'
    case 'int':
      return `(integer) ${reply.v}`
    case 'double':
      return `(double) ${reply.v}`
    case 'bool':
      return reply.v ? '(true)' : '(false)'
    case 'bulk':
      return quoteBulk(reply.v)
    case 'status':
      return reply.v
    case 'error':
      return `(error) ${reply.v}`
    case 'array':
    case 'set': {
      if (!reply.v.length) return reply.t === 'set' ? '(empty set)' : '(empty array)'
      const width = String(reply.v.length).length
      return reply.v
        .map((item, i) => {
          const label = `${String(i + 1).padStart(width)}) `
          const body = formatReply(item, indent + label.length)
          return (i === 0 ? '' : ' '.repeat(indent)) + label + body
        })
        .join('\n')
    }
    case 'map': {
      if (!reply.v.length) return '(empty hash)'
      const width = String(reply.v.length).length
      return reply.v
        .map(([k, v], i) => {
          const label = `${String(i + 1).padStart(width)}# `
          const key = formatReply(k, indent + label.length)
          const body = formatReply(v, indent + label.length + key.length + 4)
          return (i === 0 ? '' : ' '.repeat(indent)) + `${label}${key} => ${body}`
        })
        .join('\n')
    }
  }
}

/** A reply as plain JSON-ish data, for copying. */
export function replyValue(reply: RedisReply): unknown {
  switch (reply.t) {
    case 'nil':
      return null
    case 'bulk':
      return dataText(reply.v)
    case 'array':
    case 'set':
      return reply.v.map(replyValue)
    case 'map':
      return Object.fromEntries(reply.v.map(([k, v]) => [String(replyValue(k)), replyValue(v)]))
    case 'error':
      return { error: reply.v }
    default:
      return reply.v
  }
}

/* ---------- Write classification (mirrors drivers/redis.rs) ---------- */

const READS = new Set(
  `BITCOUNT BITFIELD_RO BITPOS DBSIZE DUMP ECHO EXISTS EXPIRETIME GEODIST GEOHASH GEOPOS
  GEORADIUSBYMEMBER_RO GEORADIUS_RO GEOSEARCH GET GETBIT GETRANGE HEXISTS HGET HGETALL HKEYS HLEN
  HMGET HRANDFIELD HSCAN HSTRLEN HVALS HTTL HPTTL HEXPIRETIME INFO KEYS LASTSAVE LCS LINDEX LLEN
  LOLWUT LPOS LRANGE MGET PEXPIRETIME PFCOUNT PING PTTL PUBSUB RANDOMKEY ROLE SCAN SCARD SDIFF
  SINTER SINTERCARD SISMEMBER SMEMBERS SMISMEMBER SRANDMEMBER SSCAN STRLEN SUBSTR SUNION TIME TOUCH
  TTL TYPE XLEN XPENDING XRANGE XREAD XREVRANGE ZCARD ZCOUNT ZDIFF ZINTER ZINTERCARD ZLEXCOUNT
  ZMSCORE ZRANDMEMBER ZRANGE ZRANGEBYLEX ZRANGEBYSCORE ZRANK ZREVRANGE ZREVRANGEBYLEX
  ZREVRANGEBYSCORE ZREVRANK ZSCAN ZSCORE JSON.GET JSON.MGET JSON.TYPE JSON.STRLEN JSON.ARRLEN
  JSON.OBJKEYS JSON.OBJLEN JSON.RESP FT.SEARCH FT.AGGREGATE FT.INFO FT._LIST FT.EXPLAIN FT.PROFILE
  TS.GET TS.MGET TS.RANGE TS.REVRANGE TS.MRANGE TS.MREVRANGE TS.INFO TS.QUERYINDEX BF.EXISTS
  BF.MEXISTS BF.INFO CF.EXISTS CF.INFO CMS.QUERY CMS.INFO TOPK.QUERY TOPK.LIST TOPK.INFO EVAL_RO
  EVALSHA_RO FCALL_RO SORT_RO WAIT`.split(/\s+/)
)

const READ_SUBCOMMANDS: Record<string, string[]> = {
  CLIENT: ['LIST', 'INFO', 'GETNAME', 'ID', 'TRACKINGINFO', 'NO-EVICT'],
  CONFIG: ['GET'],
  COMMAND: ['', 'COUNT', 'DOCS', 'INFO', 'LIST', 'GETKEYS', 'GETKEYSANDFLAGS'],
  MEMORY: ['USAGE', 'STATS', 'DOCTOR', 'MALLOC-STATS', 'HELP'],
  OBJECT: ['ENCODING', 'FREQ', 'IDLETIME', 'REFCOUNT', 'HELP'],
  SLOWLOG: ['GET', 'LEN', 'HELP'],
  LATENCY: ['LATEST', 'HISTORY', 'DOCTOR', 'GRAPH', 'HISTOGRAM', 'HELP'],
  ACL: ['WHOAMI', 'LIST', 'USERS', 'GETUSER', 'CAT', 'LOG', 'DRYRUN', 'HELP'],
  XINFO: ['STREAM', 'GROUPS', 'CONSUMERS', 'HELP'],
  CLUSTER: ['INFO', 'NODES', 'SLOTS', 'SHARDS', 'MYID', 'KEYSLOT', 'COUNTKEYSINSLOT'],
  FUNCTION: ['LIST', 'DUMP', 'STATS'],
  SCRIPT: ['EXISTS'],
  MODULE: ['LIST']
}

export function isReadCommand(args: string[]): boolean {
  const name = args[0]?.toUpperCase()
  if (!name) return true
  if (READS.has(name)) return true
  const sub = (args[1] ?? '').toUpperCase()
  return READ_SUBCOMMANDS[name]?.includes(sub) ?? false
}

/** Whether a request can modify data, like `RedisRequest::is_write` in the backend. */
export function redisIsWrite(request: RedisRequest): boolean {
  switch (request.op) {
    case 'scan':
    case 'get':
      return false
    case 'command':
      return !isReadCommand(request.args)
    default:
      return true
  }
}

const DANGEROUS: Record<string, string> = {
  FLUSHALL: 'FLUSHALL deletes every key in every database',
  FLUSHDB: 'FLUSHDB deletes every key in the database',
  SHUTDOWN: 'SHUTDOWN stops the server',
  DEBUG: 'DEBUG can crash or block the server',
  SWAPDB: 'SWAPDB swaps two whole databases',
  MIGRATE: 'MIGRATE moves keys to another server',
  REPLICAOF: 'REPLICAOF turns the server into a replica and discards its data',
  SLAVEOF: 'SLAVEOF turns the server into a replica and discards its data'
}

/** Why a request deserves the connection's name typed, or null when it's routine. */
export function describeRedisDanger(request: RedisRequest): string | null {
  switch (request.op) {
    case 'flush':
      return `FLUSHDB deletes every key in database ${request.database}`
    case 'deleteMatching':
      return `deleting every key matching ${request.pattern}`
    case 'delete':
      return request.keys.length > 1 ? `deleting ${request.keys.length} keys` : null
    case 'command': {
      const name = request.args[0]?.toUpperCase() ?? ''
      if (DANGEROUS[name]) return DANGEROUS[name]
      if (name === 'CONFIG' && request.args[1]?.toUpperCase() === 'SET')
        return 'CONFIG SET changes the server configuration'
      if ((name === 'SCRIPT' || name === 'FUNCTION') && request.args[1]?.toUpperCase() === 'FLUSH')
        return `${name} FLUSH removes every cached ${name === 'SCRIPT' ? 'script' : 'function'}`
      if ((name === 'DEL' || name === 'UNLINK') && request.args.length > 2)
        return `${name} of ${request.args.length - 1} keys`
      return null
    }
    default:
      return null
  }
}

const OP_COMMANDS: Partial<Record<RedisRequest['op'], string>> = {
  set: 'SET',
  hashSet: 'HSET',
  hashDelete: 'HDEL',
  listSet: 'LSET',
  listRemove: 'LREM',
  setAdd: 'SADD',
  setRemove: 'SREM',
  zsetAdd: 'ZADD',
  zsetRemove: 'ZREM',
  streamAdd: 'XADD',
  streamDelete: 'XDEL',
  jsonSet: 'JSON.SET',
  expire: 'PEXPIRE',
  rename: 'RENAMENX',
  delete: 'UNLINK',
  flush: 'FLUSHDB'
}

/** What a write does, for the production confirmation. */
export function redisSummary(request: RedisRequest): string {
  if (request.op === 'command')
    return `This runs ${request.args.map(quoteArg).join(' ').slice(0, 200)} on database ${request.database}`
  if (request.op === 'deleteMatching')
    return `This deletes keys matching ${request.pattern} in database ${request.database}`
  if (request.op === 'listPush')
    return `This runs ${request.head ? 'LPUSH' : 'RPUSH'} on ${dataText(request.key)}`
  const command = OP_COMMANDS[request.op] ?? request.op
  const target = 'key' in request ? ` on ${dataText(request.key)}` : ''
  return `This runs ${command}${target} in database ${request.database}`
}

/* ---------- Key tree ---------- */

export interface KeyFolder {
  /** Prefix including the trailing delimiter, e.g. `user:` */
  prefix: string
  name: string
  folders: Map<string, KeyFolder>
  keys: RedisKeyEntry[]
  /** Keys anywhere below */
  count: number
}

export type KeyRow =
  | { kind: 'folder'; depth: number; folder: KeyFolder }
  | { kind: 'key'; depth: number; entry: RedisKeyEntry; label: string }

/** Groups keys into folders on `delimiter`, the way most Redis GUIs show `user:1:name`. */
export function buildKeyTree(keys: RedisKeyEntry[], delimiter: string): KeyFolder {
  const root: KeyFolder = { prefix: '', name: '', folders: new Map(), keys: [], count: 0 }
  for (const entry of keys) {
    const text = dataText(entry.key)
    const parts = delimiter ? text.split(delimiter) : [text]
    let node = root
    node.count++
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      let child = node.folders.get(name)
      if (!child) {
        child = {
          prefix: node.prefix + name + delimiter,
          name,
          folders: new Map(),
          keys: [],
          count: 0
        }
        node.folders.set(name, child)
      }
      child.count++
      node = child
    }
    node.keys.push(entry)
  }
  return root
}

/** Visible rows: folders first (sorted), then keys, expanding folders in `open`. */
export function flattenKeyTree(root: KeyFolder, open: Set<string>, depth = 0): KeyRow[] {
  const rows: KeyRow[] = []
  const folders = [...root.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
  for (const folder of folders) {
    rows.push({ kind: 'folder', depth, folder })
    if (open.has(folder.prefix)) rows.push(...flattenKeyTree(folder, open, depth + 1))
  }
  const keys = [...root.keys].sort((a, b) => dataText(a.key).localeCompare(dataText(b.key)))
  for (const entry of keys) {
    const text = dataText(entry.key)
    rows.push({ kind: 'key', depth, entry, label: text.slice(root.prefix.length) || text })
  }
  return rows
}

/** A glob pattern matching literal text (escapes `* ? [ ] \`). */
export function globEscape(text: string): string {
  return text.replace(/[*?[\]\\]/g, '\\$&')
}

/* ---------- Server INFO ---------- */

/** `INFO` text → `field → value`; keyspace lines become `db0.keys`, `db0.expires`, … */
export function parseInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim()
    const value = line.slice(i + 1).trim()
    out[key] = value
    if (/^db\d+$/.test(key) || key.startsWith('cmdstat_') || key.startsWith('errorstat_')) {
      for (const part of value.split(',')) {
        const [k, v] = part.split('=')
        if (k && v !== undefined) out[`${key}.${k}`] = v
      }
    }
  }
  return out
}

/** `CLIENT LIST` text → one record per client. */
export function parseClientList(text: string): Record<string, string>[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) =>
      Object.fromEntries(
        line
          .trim()
          .split(' ')
          .map((kv) => {
            const i = kv.indexOf('=')
            return i < 0 ? [kv, ''] : [kv.slice(0, i), kv.slice(i + 1)]
          })
      )
    )
}

/* ---------- Command reference ---------- */

export interface CommandDoc {
  name: string
  args: string
  summary: string
  group: string
}

const DOCS: [string, string, string, string][] = [
  // Generic
  ['DEL', 'key [key ...]', 'Delete keys', 'generic'],
  ['UNLINK', 'key [key ...]', 'Delete keys, freeing memory in the background', 'generic'],
  ['EXISTS', 'key [key ...]', 'Count how many of the keys exist', 'generic'],
  ['EXPIRE', 'key seconds [NX|XX|GT|LT]', 'Set a time to live in seconds', 'generic'],
  ['PEXPIRE', 'key milliseconds [NX|XX|GT|LT]', 'Set a time to live in milliseconds', 'generic'],
  ['EXPIREAT', 'key unix-time-seconds', 'Expire at a Unix timestamp', 'generic'],
  ['PERSIST', 'key', 'Remove the time to live', 'generic'],
  ['TTL', 'key', 'Seconds left to live (-1 none, -2 missing)', 'generic'],
  ['PTTL', 'key', 'Milliseconds left to live', 'generic'],
  ['TYPE', 'key', 'The type of the value stored at a key', 'generic'],
  ['RENAME', 'key newkey', 'Rename a key, overwriting newkey', 'generic'],
  ['RENAMENX', 'key newkey', 'Rename a key only if newkey is free', 'generic'],
  ['COPY', 'source destination [DB db] [REPLACE]', 'Copy a key', 'generic'],
  [
    'SCAN',
    'cursor [MATCH pattern] [COUNT count] [TYPE type]',
    'Iterate keys incrementally',
    'generic'
  ],
  ['KEYS', 'pattern', 'Find all keys matching a pattern (blocks; prefer SCAN)', 'generic'],
  ['RANDOMKEY', '', 'Return a random key', 'generic'],
  ['DUMP', 'key', 'Serialize a value', 'generic'],
  ['OBJECT', 'ENCODING|FREQ|IDLETIME|REFCOUNT key', 'Inspect the internals of a value', 'generic'],
  [
    'MEMORY',
    'USAGE key [SAMPLES count] | STATS | DOCTOR',
    'Memory usage of a key or the server',
    'generic'
  ],
  ['TOUCH', 'key [key ...]', 'Update the last access time of keys', 'generic'],
  [
    'SORT',
    'key [BY pattern] [LIMIT offset count] [ASC|DESC] [ALPHA] [STORE dest]',
    'Sort a list, set or sorted set',
    'generic'
  ],
  // Strings
  ['GET', 'key', 'Get the value of a key', 'string'],
  [
    'SET',
    'key value [NX|XX] [GET] [EX seconds|PX ms|KEEPTTL]',
    'Set the string value of a key',
    'string'
  ],
  ['SETNX', 'key value', 'Set only if the key does not exist', 'string'],
  ['SETEX', 'key seconds value', 'Set with a time to live', 'string'],
  ['GETSET', 'key value', 'Set and return the old value', 'string'],
  ['GETDEL', 'key', 'Get the value and delete the key', 'string'],
  ['GETEX', 'key [EX seconds|PX ms|PERSIST]', 'Get the value and set its expiry', 'string'],
  ['MGET', 'key [key ...]', 'Get the values of several keys', 'string'],
  ['MSET', 'key value [key value ...]', 'Set several keys', 'string'],
  ['APPEND', 'key value', 'Append to a string', 'string'],
  ['STRLEN', 'key', 'Length of a string', 'string'],
  ['INCR', 'key', 'Increment an integer by one', 'string'],
  ['INCRBY', 'key increment', 'Increment an integer', 'string'],
  ['INCRBYFLOAT', 'key increment', 'Increment a float', 'string'],
  ['DECR', 'key', 'Decrement an integer by one', 'string'],
  ['DECRBY', 'key decrement', 'Decrement an integer', 'string'],
  ['GETRANGE', 'key start end', 'Get a substring', 'string'],
  ['SETRANGE', 'key offset value', 'Overwrite part of a string', 'string'],
  ['SETBIT', 'key offset value', 'Set a bit', 'string'],
  ['GETBIT', 'key offset', 'Get a bit', 'string'],
  ['BITCOUNT', 'key [start end [BYTE|BIT]]', 'Count set bits', 'string'],
  // Hashes
  ['HGET', 'key field', 'Get a hash field', 'hash'],
  ['HSET', 'key field value [field value ...]', 'Set hash fields', 'hash'],
  ['HSETNX', 'key field value', 'Set a hash field only if it does not exist', 'hash'],
  ['HMGET', 'key field [field ...]', 'Get several hash fields', 'hash'],
  ['HGETALL', 'key', 'Get every field and value of a hash', 'hash'],
  ['HDEL', 'key field [field ...]', 'Delete hash fields', 'hash'],
  ['HEXISTS', 'key field', 'Whether a hash field exists', 'hash'],
  ['HKEYS', 'key', 'All field names of a hash', 'hash'],
  ['HVALS', 'key', 'All values of a hash', 'hash'],
  ['HLEN', 'key', 'Number of fields in a hash', 'hash'],
  ['HINCRBY', 'key field increment', 'Increment an integer hash field', 'hash'],
  ['HINCRBYFLOAT', 'key field increment', 'Increment a float hash field', 'hash'],
  ['HSCAN', 'key cursor [MATCH pattern] [COUNT count]', 'Iterate hash fields', 'hash'],
  [
    'HEXPIRE',
    'key seconds FIELDS numfields field [field ...]',
    'Set a time to live on hash fields (7.4+)',
    'hash'
  ],
  ['HRANDFIELD', 'key [count [WITHVALUES]]', 'Random fields from a hash', 'hash'],
  // Lists
  ['LPUSH', 'key element [element ...]', 'Prepend to a list', 'list'],
  ['RPUSH', 'key element [element ...]', 'Append to a list', 'list'],
  ['LPOP', 'key [count]', 'Remove and return the first elements', 'list'],
  ['RPOP', 'key [count]', 'Remove and return the last elements', 'list'],
  ['LRANGE', 'key start stop', 'Get a range of elements (0 -1 for all)', 'list'],
  ['LINDEX', 'key index', 'Get an element by index', 'list'],
  ['LSET', 'key index element', 'Set an element by index', 'list'],
  ['LLEN', 'key', 'Length of a list', 'list'],
  ['LREM', 'key count element', 'Remove occurrences of an element', 'list'],
  ['LTRIM', 'key start stop', 'Trim a list to a range', 'list'],
  ['LINSERT', 'key BEFORE|AFTER pivot element', 'Insert next to another element', 'list'],
  ['LPOS', 'key element [RANK rank] [COUNT n]', 'Index of matching elements', 'list'],
  [
    'LMOVE',
    'source destination LEFT|RIGHT LEFT|RIGHT',
    'Pop from one list and push to another',
    'list'
  ],
  ['BLPOP', 'key [key ...] timeout', 'Blocking pop from the head', 'list'],
  ['BRPOP', 'key [key ...] timeout', 'Blocking pop from the tail', 'list'],
  // Sets
  ['SADD', 'key member [member ...]', 'Add members to a set', 'set'],
  ['SREM', 'key member [member ...]', 'Remove members from a set', 'set'],
  ['SMEMBERS', 'key', 'All members of a set', 'set'],
  ['SISMEMBER', 'key member', 'Whether a value is a member', 'set'],
  ['SMISMEMBER', 'key member [member ...]', 'Membership of several values', 'set'],
  ['SCARD', 'key', 'Number of members in a set', 'set'],
  ['SPOP', 'key [count]', 'Remove and return random members', 'set'],
  ['SRANDMEMBER', 'key [count]', 'Random members without removing them', 'set'],
  ['SINTER', 'key [key ...]', 'Intersection of sets', 'set'],
  ['SUNION', 'key [key ...]', 'Union of sets', 'set'],
  ['SDIFF', 'key [key ...]', 'Difference of sets', 'set'],
  ['SSCAN', 'key cursor [MATCH pattern] [COUNT count]', 'Iterate set members', 'set'],
  // Sorted sets
  [
    'ZADD',
    'key [NX|XX] [GT|LT] [CH] [INCR] score member [score member ...]',
    'Add members with scores',
    'zset'
  ],
  ['ZREM', 'key member [member ...]', 'Remove members', 'zset'],
  ['ZSCORE', 'key member', 'Score of a member', 'zset'],
  ['ZINCRBY', 'key increment member', 'Increment the score of a member', 'zset'],
  ['ZCARD', 'key', 'Number of members', 'zset'],
  ['ZCOUNT', 'key min max', 'Members with scores in a range', 'zset'],
  [
    'ZRANGE',
    'key start stop [BYSCORE|BYLEX] [REV] [LIMIT offset count] [WITHSCORES]',
    'A range of members',
    'zset'
  ],
  ['ZREVRANGE', 'key start stop [WITHSCORES]', 'A range of members, highest score first', 'zset'],
  [
    'ZRANGEBYSCORE',
    'key min max [WITHSCORES] [LIMIT offset count]',
    'Members with scores in a range',
    'zset'
  ],
  ['ZRANK', 'key member [WITHSCORE]', 'Rank of a member, lowest first', 'zset'],
  ['ZREVRANK', 'key member [WITHSCORE]', 'Rank of a member, highest first', 'zset'],
  ['ZPOPMIN', 'key [count]', 'Remove and return the lowest scores', 'zset'],
  ['ZPOPMAX', 'key [count]', 'Remove and return the highest scores', 'zset'],
  ['ZSCAN', 'key cursor [MATCH pattern] [COUNT count]', 'Iterate members and scores', 'zset'],
  // Streams
  [
    'XADD',
    'key [MAXLEN [~] n] *|id field value [field value ...]',
    'Append an entry to a stream',
    'stream'
  ],
  ['XRANGE', 'key start end [COUNT count]', 'Entries in an ID range (- + for all)', 'stream'],
  ['XREVRANGE', 'key end start [COUNT count]', 'Entries in reverse order', 'stream'],
  ['XLEN', 'key', 'Number of entries', 'stream'],
  ['XDEL', 'key id [id ...]', 'Delete entries', 'stream'],
  ['XTRIM', 'key MAXLEN|MINID [~] threshold', 'Trim a stream', 'stream'],
  [
    'XREAD',
    '[COUNT count] [BLOCK ms] STREAMS key [key ...] id [id ...]',
    'Read entries from streams',
    'stream'
  ],
  [
    'XGROUP',
    'CREATE key group id|$ [MKSTREAM] | DESTROY key group',
    'Manage consumer groups',
    'stream'
  ],
  [
    'XREADGROUP',
    'GROUP group consumer [COUNT n] [BLOCK ms] STREAMS key [key ...] id [id ...]',
    'Read as a consumer group member',
    'stream'
  ],
  ['XACK', 'key group id [id ...]', 'Acknowledge processed entries', 'stream'],
  [
    'XPENDING',
    'key group [start end count [consumer]]',
    'Entries delivered but not acknowledged',
    'stream'
  ],
  [
    'XINFO',
    'STREAM key | GROUPS key | CONSUMERS key group',
    'Stream and consumer group details',
    'stream'
  ],
  // Pub/Sub, scripting, server
  ['PUBLISH', 'channel message', 'Post a message to a channel', 'pubsub'],
  [
    'PUBSUB',
    'CHANNELS [pattern] | NUMSUB [channel ...] | NUMPAT',
    'Inspect Pub/Sub state',
    'pubsub'
  ],
  ['EVAL', 'script numkeys [key ...] [arg ...]', 'Run a Lua script', 'scripting'],
  ['EVALSHA', 'sha1 numkeys [key ...] [arg ...]', 'Run a cached Lua script', 'scripting'],
  [
    'SCRIPT',
    'LOAD script | EXISTS sha1 [sha1 ...] | FLUSH',
    'Manage the script cache',
    'scripting'
  ],
  ['FCALL', 'function numkeys [key ...] [arg ...]', 'Call a function', 'scripting'],
  ['MULTI', '', 'Start a transaction', 'transactions'],
  ['EXEC', '', 'Run the queued transaction', 'transactions'],
  ['DISCARD', '', 'Abandon the queued transaction', 'transactions'],
  ['WATCH', 'key [key ...]', 'Abort the next EXEC if these keys change', 'transactions'],
  ['PING', '[message]', 'Check the connection', 'connection'],
  ['ECHO', 'message', 'Return the message', 'connection'],
  [
    'CLIENT',
    'LIST | INFO | KILL ID id | SETNAME name | GETNAME',
    'Manage client connections',
    'connection'
  ],
  ['INFO', '[section ...]', 'Server information and statistics', 'server'],
  ['DBSIZE', '', 'Number of keys in the database', 'server'],
  [
    'CONFIG',
    'GET parameter | SET parameter value | REWRITE | RESETSTAT',
    'Read or change the configuration',
    'server'
  ],
  ['SLOWLOG', 'GET [count] | LEN | RESET', 'Slow command log', 'server'],
  ['LATENCY', 'LATEST | DOCTOR | HISTORY event | RESET', 'Latency monitoring', 'server'],
  ['TIME', '', 'Server time', 'server'],
  ['LASTSAVE', '', 'Time of the last successful save', 'server'],
  ['BGSAVE', '[SCHEDULE]', 'Save a snapshot in the background', 'server'],
  ['BGREWRITEAOF', '', 'Rewrite the append-only file', 'server'],
  ['FLUSHDB', '[ASYNC|SYNC]', 'Delete every key in the database', 'server'],
  ['FLUSHALL', '[ASYNC|SYNC]', 'Delete every key in every database', 'server'],
  [
    'ACL',
    'WHOAMI | LIST | USERS | GETUSER name | SETUSER name [rule ...] | LOG',
    'Access control lists',
    'server'
  ],
  ['ROLE', '', 'Replication role', 'server'],
  ['MODULE', 'LIST', 'Loaded modules', 'server'],
  ['COMMAND', 'COUNT | DOCS [name ...] | INFO [name ...]', 'Command metadata', 'server'],
  // Modules
  ['JSON.GET', 'key [path ...]', 'Get JSON at a path (RedisJSON)', 'json'],
  ['JSON.SET', 'key path value [NX|XX]', 'Set JSON at a path (RedisJSON)', 'json'],
  ['JSON.DEL', 'key [path]', 'Delete JSON at a path (RedisJSON)', 'json'],
  [
    'FT.SEARCH',
    'index query [LIMIT offset num] [RETURN n field ...]',
    'Full-text search (RediSearch)',
    'search'
  ],
  ['FT._LIST', '', 'Search indexes (RediSearch)', 'search'],
  ['FT.INFO', 'index', 'Search index details (RediSearch)', 'search']
]

export const COMMAND_DOCS: CommandDoc[] = DOCS.map(([name, args, summary, group]) => ({
  name,
  args,
  summary,
  group
}))

const DOC_INDEX = new Map(COMMAND_DOCS.map((d) => [d.name, d]))

export function commandDoc(name: string | undefined): CommandDoc | undefined {
  return name ? DOC_INDEX.get(name.toUpperCase()) : undefined
}

/** Commands whose name starts with what's typed, most common first. */
export function completeCommand(prefix: string, limit = 8): CommandDoc[] {
  const p = prefix.toUpperCase()
  if (!p) return []
  return COMMAND_DOCS.filter((d) => d.name.startsWith(p) && d.name !== p).slice(0, limit)
}

/** `SLOWLOG GET` reply → one record per entry, newest first. */
export function parseSlowlog(reply: RedisReply | null): Record<string, string>[] {
  if (!reply || reply.t !== 'array') return []
  const text = (r: RedisReply | undefined): string =>
    !r ? '' : r.t === 'bulk' ? dataText(r.v) : r.t === 'int' || r.t === 'status' ? String(r.v) : ''
  return reply.v.flatMap((entry) => {
    if (entry.t !== 'array') return []
    const [id, at, micros, args, client, name] = entry.v
    const command = args?.t === 'array' ? args.v.map((a) => quoteArg(text(a))).join(' ') : ''
    return [
      {
        id: text(id),
        at: new Date(Number(text(at)) * 1000).toLocaleString(),
        duration_ms: (Number(text(micros)) / 1000).toFixed(2),
        command,
        client: text(client),
        name: text(name)
      }
    ]
  })
}

/** Records → a grid result set with the given columns, in order. */
export function recordsToSet(
  records: Record<string, string>[],
  columns: string[]
): {
  columns: { name: string; typeName: string }[]
  rows: (string | null)[][]
  rowCount: number
  truncated: boolean
} {
  return {
    columns: columns.map((name) => ({ name, typeName: 'text' })),
    rows: records.map((r) => columns.map((c) => r[c] ?? null)),
    rowCount: records.length,
    truncated: false
  }
}
