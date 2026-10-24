import { describe, expect, it } from 'vitest'
import type { Cell, ResultSet } from '../api'
import {
  chartData,
  createDashboard,
  dragOrder,
  formatValue,
  guessMapping,
  moveWidget,
  newWidget,
  niceTicks,
  numericColumns,
  parseDashboardFile,
  reorderWidgets,
  resolveColumns,
  serializeDashboard,
  statValue,
  uniqueDashboardName,
  upsertWidget,
  type Dashboard
} from '../dashboards'

function result(columns: [string, string][], rows: Cell[][]): ResultSet {
  return {
    columns: columns.map(([name, typeName]) => ({ name, typeName })),
    rows,
    rowCount: rows.length,
    truncated: false
  }
}

const byStatus = result(
  [
    ['status', 'text'],
    ['orders', 'int8'],
    ['revenue', 'numeric']
  ],
  [
    ['paid', '12', '340.5'],
    ['refunded', '3', '-20'],
    [null, '1', null]
  ]
)

function dashboard(patch: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'd1',
    name: 'Orders',
    connectionId: 'c1',
    database: 'shop',
    widgets: [],
    refreshSecs: 0,
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

describe('dashboards', () => {
  it('creates a dashboard with a trimmed name and no widgets', () => {
    const { list, dashboard: d } = createDashboard(
      [],
      { name: '  Sales ', connectionId: 'c1', database: 'shop' },
      7
    )
    expect(list).toEqual([d])
    expect(d).toMatchObject({ name: 'Sales', widgets: [], refreshSecs: 0, createdAt: 7 })
  })

  it('numbers clashing names', () => {
    const list = [dashboard({ name: 'Sales' }), dashboard({ id: 'd2', name: 'sales 2' })]
    expect(uniqueDashboardName(list, 'Sales')).toBe('Sales 3')
    expect(uniqueDashboardName(list, 'Ops')).toBe('Ops')
  })

  it('upserts and moves widgets', () => {
    const a = newWidget({ id: 'a' })
    const b = newWidget({ id: 'b' })
    const c = newWidget({ id: 'c' })
    expect(upsertWidget([a, b], { ...b, title: 'B' }).map((w) => w.title)).toEqual(['', 'B'])
    expect(upsertWidget([a], c).map((w) => w.id)).toEqual(['a', 'c'])
    expect(moveWidget([a, b, c], 'c', 0).map((w) => w.id)).toEqual(['c', 'a', 'b'])
    expect(moveWidget([a, b, c], 'a', 9).map((w) => w.id)).toEqual(['b', 'c', 'a'])
  })

  it('swaps the dragged widget into the target slot', () => {
    expect(dragOrder(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(dragOrder(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
    expect(dragOrder(['a', 'b'], 'a', 'missing')).toEqual(['a', 'b'])
  })

  it('commits a drag order and keeps widgets added meanwhile', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((id) => newWidget({ id }))
    expect(reorderWidgets([a, b, c], ['c', 'a']).map((w) => w.id)).toEqual(['c', 'a', 'b'])
    expect(reorderWidgets([a, b], ['b', 'gone', 'a']).map((w) => w.id)).toEqual(['b', 'a'])
  })

  it('round-trips through an exported file without connection details', () => {
    const d = dashboard({
      refreshSecs: 60,
      widgets: [
        newWidget({
          title: 'By status',
          kind: 'line',
          query: 'select 1',
          x: 'day',
          y: ['n'],
          span: 4
        })
      ]
    })
    const text = serializeDashboard(d)
    expect(text).not.toContain('c1')
    const back = parseDashboardFile(text)
    expect(back).toMatchObject({ name: 'Orders', database: 'shop', refreshSecs: 60 })
    expect(back.widgets[0]).toMatchObject({
      title: 'By status',
      kind: 'line',
      x: 'day',
      y: ['n'],
      span: 4
    })
    expect(back.widgets[0].id).not.toBe(d.widgets[0].id)
  })

  it('rejects files that are not dashboards', () => {
    expect(() => parseDashboardFile('nope')).toThrow(/JSON/)
    expect(() => parseDashboardFile('{"widgets":[]}')).toThrow(/exported dashboard/)
  })

  it('cleans up bad widget fields on import', () => {
    const back = parseDashboardFile(
      JSON.stringify({ format: 'dbms-dashboard', widgets: [{ kind: 'pie', span: 9, y: [1, 'a'] }] })
    )
    expect(back.widgets[0]).toMatchObject({ kind: 'table', span: 2, y: ['a'], query: '' })
    expect(back.name).toBe('Dashboard')
  })
})

describe('shaping results', () => {
  it('finds numeric columns by type and by content', () => {
    const mixed = result(
      [
        ['id', ''],
        ['label', ''],
        ['day', 'date']
      ],
      [
        ['1', 'a', '2024-01-01'],
        ['2', '3', '2024-01-02']
      ]
    )
    expect(numericColumns(byStatus)).toEqual(['orders', 'revenue'])
    expect(numericColumns(mixed)).toEqual(['id'])
  })

  it('guesses bars for categories, lines for dates and a number for one value', () => {
    expect(guessMapping(byStatus)).toEqual({ kind: 'bar', x: 'status', y: ['orders', 'revenue'] })
    const daily = result(
      [
        ['day', 'text'],
        ['n', 'int4']
      ],
      [
        ['2024-01-01', '4'],
        ['2024-01-02', '6']
      ]
    )
    expect(guessMapping(daily).kind).toBe('line')
    expect(guessMapping(result([['count', 'int8']], [['42']]))).toEqual({
      kind: 'stat',
      x: null,
      y: ['count']
    })
    expect(guessMapping(result([['name', 'text']], [['a']])).kind).toBe('table')
  })

  it('falls back to guessed columns when the saved ones are gone', () => {
    expect(resolveColumns(byStatus, { x: 'missing', y: ['gone'] })).toEqual({
      x: 'status',
      y: ['orders', 'revenue']
    })
    expect(resolveColumns(byStatus, { x: 'status', y: ['revenue'] })).toEqual({
      x: 'status',
      y: ['revenue']
    })
  })

  it('builds series with nulls for missing values', () => {
    const data = chartData(byStatus, 'status', ['orders', 'revenue'])
    expect(data.labels).toEqual(['paid', 'refunded', '(null)'])
    expect(data.series).toEqual([
      { name: 'orders', values: [12, 3, 1] },
      { name: 'revenue', values: [340.5, -20, null] }
    ])
    expect(data.hiddenSeries).toBe(0)
  })

  it('caps series at the palette size', () => {
    const y = Array.from({ length: 10 }, (_, i) => `c${i}`)
    expect(chartData(byStatus, null, y)).toMatchObject({ hiddenSeries: 2 })
  })

  it('reads the headline value', () => {
    expect(statValue(byStatus, ['revenue'])).toEqual({
      value: 340.5,
      text: '340.5',
      column: 'revenue'
    })
    expect(statValue(result([['v', 'text']], [['n/a']]), [])).toEqual({
      value: null,
      text: 'n/a',
      column: 'v'
    })
  })

  it('makes round ticks', () => {
    expect(niceTicks(0, 97)).toEqual([0, 25, 50, 75, 100])
    expect(niceTicks(-20, 340)).toEqual([-100, 0, 100, 200, 300, 400])
    expect(niceTicks(0, 0)).toEqual([0, 1])
    expect(niceTicks(5, 5).length).toBeGreaterThan(1)
  })

  it('formats values compactly from ten thousand', () => {
    expect(formatValue(1284)).toBe((1284).toLocaleString())
    expect(formatValue(12_900)).toMatch(/12\.9\s?K/i)
    expect(formatValue(null)).toBe('—')
  })
})
