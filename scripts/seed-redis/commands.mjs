// Redis commands for the seed dataset: the rows scripts/seed-sql/data.mjs generates, kept the way an
// app would keep them in Redis. Every data type shows up: hashes for records, strings for lookups,
// JSON documents and counters, lists for queues and line items, sets for memberships, sorted sets
// for leaderboards and time indexes, streams for event logs, a geo index and HyperLogLogs. Sessions
// and carts expire, so TTLs count down in the key browser.
//
// Shared by the app's "Seed sample database" dialog (src/lib/seed.ts) and scripts/seed-redis.sh.
import { PgArray, configure, genReference, hash32, plan } from '../seed-sql/data.mjs'

const DAY_S = 86_400

/** A field value as Redis stores it: text, with objects as JSON. */
function text(v) {
  if (v instanceof Date) return v.toISOString()
  if (v instanceof PgArray) return JSON.stringify(v.items)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const ms = (v) => (v instanceof Date ? v.getTime() : Date.parse(v))
const day = (v) => text(v).slice(0, 10)

/** HSET with every non-null column except `omit`. */
function hset(key, row, omit = []) {
  const args = ['HSET', key]
  for (const [k, v] of Object.entries(row))
    if (v !== null && v !== undefined && !omit.includes(k)) args.push(k, text(v))
  return args
}

/** A row as a JSON document without the parent's id, for lists of children. */
function json(row, omit = []) {
  const out = {}
  for (const [k, v] of Object.entries(row))
    if (v !== null && v !== undefined && !omit.includes(k))
      out[k] = v instanceof Date ? v.toISOString() : v instanceof PgArray ? v.items : v
  return JSON.stringify(out)
}

/** XADD fields: the scalar columns, skipping nulls. */
function fields(row, keep) {
  const out = []
  for (const k of keep) if (row[k] !== null && row[k] !== undefined) out.push(k, text(row[k]))
  return out
}

const OPEN_TICKETS = new Set(['new', 'open', 'pending'])

/** Commands for one generated row of `table`. */
export function rowCommands(table, r) {
  switch (table) {
    case 'countries':
      return [hset(`country:${r.code}`, r)]
    case 'warehouses':
      return [
        hset(`warehouse:${r.id}`, r),
        ['GEOADD', 'warehouses:geo', String(r.lng), String(r.lat), r.code]
      ]
    case 'categories':
      return [hset(`category:${r.id}`, r)]
    case 'brands':
      return [hset(`brand:${r.id}`, r)]
    case 'support_agents':
      return [hset(`agent:${r.id}`, r), ['SADD', `agents:team:${r.team}`, String(r.id)]]
    case 'customers': {
      const out = [
        hset(`customer:${r.id}`, r),
        ['SET', `customer:email:${r.email}`, String(r.id)],
        ['ZADD', 'customers:signups', String(ms(r.created_at)), String(r.id)],
        ['SADD', `customers:tier:${r.tier}`, String(r.id)]
      ]
      // Some customers are signed in or have a cart; both expire like they would in production
      const h = hash32(11, r.id)
      if (h % 100 < 15) {
        const token = hash32(12, r.id).toString(16).padStart(8, '0') + hash32(13, r.id).toString(16)
        const session = JSON.stringify({ customerId: r.id, locale: r.locale, tier: r.tier })
        out.push(['SET', `session:${token}`, session, 'EX', String(600 + (h % (2 * DAY_S)))])
      }
      if (h % 100 >= 95) {
        const cart = ['HSET', `cart:${r.id}`]
        for (let n = 0; n < 1 + (h % 4); n++)
          cart.push(`product:${1 + (hash32(14 + n, r.id) % 100)}`, String(1 + ((h >>> n) % 3)))
        out.push(cart, ['EXPIRE', `cart:${r.id}`, String(7 * DAY_S - (h % DAY_S))])
      }
      return out
    }
    case 'customer_addresses':
      return [['RPUSH', `customer:${r.customer_id}:addresses`, json(r, ['customer_id'])]]
    case 'customer_tags':
      return [['SADD', `customer:${r.customer_id}:tags`, r.tag]]
    case 'products':
      return [
        hset(`product:${r.id}`, r),
        ['SET', `product:sku:${r.sku}`, String(r.id)],
        ['SADD', `category:${r.category_id}:products`, String(r.id)],
        ['SADD', `brand:${r.brand_id}:products`, String(r.id)],
        ['ZADD', 'products:by_price', String(r.price), String(r.id)],
        ['ZADD', 'products:by_rating', String(r.rating_avg ?? 0), String(r.id)]
      ]
    case 'product_variants':
      return [['RPUSH', `product:${r.product_id}:variants`, json(r, ['product_id'])]]
    case 'inventory': {
      const out = [
        ['HSET', `inventory:${r.product_id}`, `warehouse:${r.warehouse_id}`, String(r.on_hand)]
      ]
      if (r.on_hand < r.reorder_point)
        out.push(['SADD', 'inventory:reorder', `${r.product_id}:${r.warehouse_id}`])
      return out
    }
    case 'orders':
      return [
        hset(`order:${r.id}`, r),
        ['SET', `order:number:${r.order_number}`, String(r.id)],
        ['ZADD', `customer:${r.customer_id}:orders`, String(ms(r.created_at)), String(r.id)],
        ['SADD', `orders:status:${r.status}`, String(r.id)],
        ['HINCRBYFLOAT', 'stats:revenue:daily', day(r.created_at), String(r.total_usd)],
        ['INCR', 'stats:orders:total']
      ]
    case 'order_items':
      return [
        ['RPUSH', `order:${r.order_id}:items`, json(r, ['order_id', 'id'])],
        ['ZINCRBY', 'leaderboard:products:revenue', String(r.line_total), String(r.product_id)],
        ['ZINCRBY', 'leaderboard:products:units', String(r.qty), String(r.product_id)]
      ]
    case 'order_status_history':
      return [['RPUSH', `order:${r.order_id}:history`, json(r, ['order_id', 'id'])]]
    case 'payments':
      return [['RPUSH', `order:${r.order_id}:payments`, json(r, ['order_id'])]]
    case 'refunds':
      return [['RPUSH', `order:${r.order_id}:refunds`, json(r, ['order_id'])]]
    case 'shipments':
      return [hset(`order:${r.order_id}:shipment`, r, ['order_id'])]
    case 'reviews':
      return [
        ['SET', `review:${r.id}`, json(r)],
        ['ZADD', `product:${r.product_id}:reviews`, String(ms(r.created_at)), String(r.id)]
      ]
    case 'events': {
      const visitor = r.customer_id ? `customer:${r.customer_id}` : r.anonymous_id
      const out = [
        [
          'XADD',
          'events',
          '*',
          ...fields(r, [
            'ts',
            'type',
            'customer_id',
            'anonymous_id',
            'session_id',
            'page_path',
            'device_type',
            'country_code',
            'duration_ms'
          ]),
          ...(r.props ? ['props', text(r.props)] : [])
        ],
        ['PFADD', `visitors:${day(r.ts)}`, visitor],
        ['INCR', `stats:events:${r.type}`]
      ]
      if (r.page_path) out.push(['ZINCRBY', 'pages:top', '1', r.page_path])
      return out
    }
    case 'tickets': {
      const out = [hset(`ticket:${r.id}`, r)]
      if (OPEN_TICKETS.has(r.status))
        out.push(['RPUSH', `queue:tickets:${r.priority}`, String(r.id)])
      if (r.assignee_id) out.push(['SADD', `agent:${r.assignee_id}:tickets`, String(r.id)])
      return out
    }
    case 'ticket_messages':
      return [
        [
          'XADD',
          `ticket:${r.ticket_id}:messages`,
          '*',
          ...fields(r, ['seq', 'author_type', 'agent_id', 'body', 'is_internal', 'created_at'])
        ]
      ]
    case 'hosts':
      return [hset(`host:${r.id}`, r), ['SADD', `hosts:service:${r.service}`, r.hostname]]
    case 'metrics':
      // The last day per host, as a capped stream
      return [
        [
          'XADD',
          `metrics:host:${r.host_id}`,
          'MAXLEN',
          '~',
          '1440',
          '*',
          ...fields(r, ['ts', 'cpu_pct', 'mem_pct', 'rps', 'latency_p99_ms', 'errors_5xx'])
        ]
      ]
    default:
      return r.id === undefined ? [] : [hset(`${table}:${r.id}`, r)]
  }
}

/** Keys that don't come from rows: flags, a banner, and consumer groups with pending entries. */
export function finishCommands() {
  return [
    [
      'HSET',
      'config:features',
      'new_checkout',
      'on',
      'dark_mode',
      'on',
      'recommendations',
      'beta',
      'gift_cards',
      'off'
    ],
    [
      'SET',
      'site:banner',
      JSON.stringify({ text: 'Free shipping this weekend', level: 'info' }),
      'EX',
      '3600'
    ],
    ['SET', 'lock:reports:daily', 'worker-3', 'PX', '90000'],
    ['XGROUP', 'CREATE', 'events', 'analytics', '0'],
    ['XREADGROUP', 'GROUP', 'analytics', 'worker-1', 'COUNT', '25', 'STREAMS', 'events', '>'],
    ['XGROUP', 'CREATE', 'events', 'fraud-check', '$'],
    ['SET', 'seed:info', JSON.stringify({ dataset: 'acme', source: 'dbms-tool' })]
  ]
}

/**
 * Batches of commands for the whole dataset, generated lazily. `rows` counts the generated
 * records behind a batch; `progress` is the share of the dataset done, 0–1.
 */
export function* redisSeedBatches(scale, metricDays, batchSize = 2000) {
  configure(scale, metricDays)
  let buffer = []
  let rows = 0
  let entity = 'reference data'
  const emit = (table, row) => {
    rows++
    for (const c of rowCommands(table, row)) buffer.push(c)
  }
  const jobs = plan()
  const total = 1 + jobs.reduce((sum, [, , count]) => sum + count, 0)
  let done = 0
  const take = () => {
    const batch = { entity, commands: buffer, rows, progress: done / total }
    buffer = []
    rows = 0
    return batch
  }
  genReference(emit)
  done++
  for (const [name, gen, count] of jobs) {
    entity = name
    for (let i = 0; i < count; i++) {
      gen(i, emit)
      done++
      if (buffer.length >= batchSize) yield take()
    }
  }
  entity = 'consumer groups'
  for (const c of finishCommands()) buffer.push(c)
  yield take()
}
