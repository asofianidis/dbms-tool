import type { Engine } from './api'
import { newWidget, type Dashboard, type Widget } from './dashboards'

/*
 * A ready-made dashboard that shows off every widget kind. Its queries carry
 * their own sample data, so it runs on any database without touching a table.
 */

export const EXAMPLE_NAME = 'Example: Store sales'

type Value = string | number
type Rows = { columns: string[]; rows: Value[][] }

const MONTHS: [string, number, number, number][] = [
  // month, revenue, orders, refunds
  ['2025-11', 48210.4, 612, 31],
  ['2025-12', 63980.15, 801, 44],
  ['2026-01', 41250.9, 534, 38],
  ['2026-02', 43870.25, 559, 29],
  ['2026-03', 49120.6, 627, 33],
  ['2026-04', 51340.75, 648, 35],
  ['2026-05', 54810.3, 690, 37],
  ['2026-06', 53260.85, 671, 41],
  ['2026-07', 57930.1, 724, 39],
  ['2026-08', 59480.55, 741, 36],
  ['2026-09', 62150.2, 773, 42],
  ['2026-10', 66720.95, 829, 40]
]

const MONTHLY: Rows = {
  columns: ['month', 'revenue', 'orders', 'refunds', 'online', 'in_store'],
  rows: MONTHS.map(([month, revenue, orders, refunds], i) => {
    // Online's share creeps up over the year
    const online = Math.round(orders * (0.56 + i * 0.008))
    return [month, revenue, orders, refunds, online, orders - online]
  })
}

const CATEGORIES: Rows = {
  columns: ['category', 'revenue'],
  rows: [
    ['Electronics', 214870.2],
    ['Books', 182340.5],
    ['Home & garden', 98610.75],
    ['Clothing', 92310.15],
    ['Toys', 64220.4]
  ]
}

const REGIONS: Rows = {
  columns: ['region', 'online', 'in_store'],
  rows: [
    ['North', 1380, 760],
    ['South', 1090, 640],
    ['East', 1240, 560],
    ['West', 1490, 1049]
  ]
}

const PRODUCTS: Rows = {
  columns: ['product', 'category', 'units', 'revenue'],
  rows: [
    ['Noise-cancelling headphones', 'Electronics', 412, 82396.88],
    ['Smart speaker', 'Electronics', 538, 48366.2],
    ['The Long Way Home', 'Books', 1904, 34253.96],
    ['Cast iron skillet', 'Home & garden', 621, 27943.79],
    ['Rain jacket', 'Clothing', 388, 27156.12],
    ['Building blocks set', 'Toys', 457, 22845.43],
    ['E-reader', 'Electronics', 179, 21478.21],
    ['Herb garden kit', 'Home & garden', 702, 17543.98]
  ]
}

/* ---------- SQL: UNION ALL rows run unchanged on PostgreSQL, MySQL and SQL Server ---------- */

function sqlLiteral(v: Value): string {
  return typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`
}

function sqlSource({ columns, rows }: Rows): string {
  const lines = rows.map(
    (row, i) =>
      `  SELECT ${row.map((v, j) => (i ? sqlLiteral(v) : `${sqlLiteral(v)} AS ${columns[j]}`)).join(', ')}`
  )
  return `(\n${lines.join('\n  UNION ALL\n')}\n) AS sales`
}

function sql(select: string, data: Rows, rest = ''): string {
  const note =
    '-- Sample data so the example runs anywhere; swap the subquery for one of your tables'
  return `${note}\nSELECT ${select}\nFROM ${sqlSource(data)}${rest ? `\n${rest}` : ''}`
}

/* ---------- MongoDB: a $documents stage (MongoDB 5.1+) feeds each pipeline ---------- */

function mongoDocs({ columns, rows }: Rows): string {
  const docs = rows.map(
    (row) => `    { ${row.map((v, j) => `${columns[j]}: ${JSON.stringify(v)}`).join(', ')} }`
  )
  return `  // Sample data so the example runs anywhere; use db.<collection>.aggregate on your own data\n  { $documents: [\n${docs.join(',\n')}\n  ] }`
}

function mongo(data: Rows, ...stages: string[]): string {
  return `db.aggregate([\n${[mongoDocs(data), ...stages.map((s) => `  ${s}`)].join(',\n')}\n])`
}

function totals(field: string, expression: string): string {
  return `{ $group: { _id: null, revenue: { $sum: "$revenue" }, orders: { $sum: "$orders" }, refunds: { $sum: "$refunds" } } },\n  { $project: { _id: 0, ${field}: ${expression} } }`
}

export function exampleWidgets(engine: Engine): Widget[] {
  const m = engine === 'mongo'
  const sort = (field: string, dir: 1 | -1): string => `{ $sort: { ${field}: ${dir} } }`
  return [
    newWidget({
      title: 'Revenue, last 12 months',
      kind: 'stat',
      span: 1,
      y: ['revenue'],
      query: m
        ? mongo(MONTHLY, totals('revenue', '"$revenue"'))
        : sql('SUM(revenue) AS revenue', MONTHLY)
    }),
    newWidget({
      title: 'Orders',
      kind: 'stat',
      span: 1,
      y: ['orders'],
      query: m
        ? mongo(MONTHLY, totals('orders', '"$orders"'))
        : sql('SUM(orders) AS orders', MONTHLY)
    }),
    newWidget({
      title: 'Average order value',
      kind: 'stat',
      span: 1,
      y: ['avg_order_value'],
      query: m
        ? mongo(
            MONTHLY,
            totals('avg_order_value', '{ $round: [{ $divide: ["$revenue", "$orders"] }, 2] }')
          )
        : sql('ROUND(SUM(revenue) / SUM(orders), 2) AS avg_order_value', MONTHLY)
    }),
    newWidget({
      title: 'Refund rate (%)',
      kind: 'stat',
      span: 1,
      y: ['refund_rate_pct'],
      query: m
        ? mongo(
            MONTHLY,
            totals(
              'refund_rate_pct',
              '{ $round: [{ $multiply: [100, { $divide: ["$refunds", "$orders"] }] }, 1] }'
            )
          )
        : sql('ROUND(100.0 * SUM(refunds) / SUM(orders), 1) AS refund_rate_pct', MONTHLY)
    }),
    newWidget({
      title: 'Revenue by month',
      kind: 'line',
      span: 2,
      x: 'month',
      y: ['revenue'],
      query: m
        ? mongo(MONTHLY, '{ $project: { _id: 0, month: 1, revenue: 1 } }', sort('month', 1))
        : sql('month, revenue', MONTHLY, 'ORDER BY month')
    }),
    newWidget({
      title: 'Revenue by category',
      kind: 'bar',
      span: 2,
      x: 'category',
      y: ['revenue'],
      query: m
        ? mongo(CATEGORIES, sort('revenue', -1))
        : sql('category, revenue', CATEGORIES, 'ORDER BY revenue DESC')
    }),
    newWidget({
      title: 'Orders online vs. in store',
      kind: 'line',
      span: 2,
      x: 'month',
      y: ['online', 'in_store'],
      query: m
        ? mongo(
            MONTHLY,
            '{ $project: { _id: 0, month: 1, online: 1, in_store: 1 } }',
            sort('month', 1)
          )
        : sql('month, online, in_store', MONTHLY, 'ORDER BY month')
    }),
    newWidget({
      title: 'Orders by region',
      kind: 'bar',
      span: 2,
      x: 'region',
      y: ['online', 'in_store'],
      query: m ? mongo(REGIONS) : sql('region, online, in_store', REGIONS)
    }),
    newWidget({
      title: 'Top products',
      kind: 'table',
      span: 4,
      query: m
        ? mongo(PRODUCTS, sort('revenue', -1))
        : sql('product, category, units, revenue', PRODUCTS, 'ORDER BY revenue DESC')
    })
  ]
}

/** The example's contents; it starts locked, so looking around can't change it. */
export function exampleDashboard(
  engine: Engine
): Pick<Dashboard, 'name' | 'widgets' | 'refreshSecs' | 'locked'> {
  return { name: EXAMPLE_NAME, widgets: exampleWidgets(engine), refreshSecs: 0, locked: true }
}
