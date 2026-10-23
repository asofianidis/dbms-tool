import { describe, expect, it } from 'vitest'
import type { ColumnInfo, ForeignKeyInfo } from '../api'
import {
  approximateMeasure,
  boundsOf,
  buildEdges,
  buildPdf,
  fitText,
  layoutDiagram,
  nodeBox,
  routeEdge,
  tableKey,
  visibleColumns,
  type DiagramTable,
  type NodeBox
} from '../diagram'

const col = (name: string, patch: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType: 'integer',
  nullable: false,
  default: null,
  isPrimaryKey: false,
  isGenerated: false,
  isIdentity: false,
  comment: null,
  extra: null,
  ...patch
})

const fk = (
  name: string,
  columns: string[],
  refTable: string,
  refSchema: string | null = 'public'
): ForeignKeyInfo => ({
  name,
  columns,
  refSchema,
  refTable,
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null
})

const table = (
  name: string,
  columns: ColumnInfo[],
  foreignKeys: ForeignKeyInfo[] = [],
  schema: string | null = 'public'
): DiagramTable => ({
  key: tableKey(schema, name),
  schema,
  name,
  kind: 'table',
  columns,
  primaryKey: columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
  foreignKeys,
  indexes: []
})

const users = table('users', [
  col('id', { isPrimaryKey: true }),
  col('email', { dataType: 'text' })
])
const orders = table(
  'orders',
  [col('id', { isPrimaryKey: true }), col('user_id'), col('coupon_id', { nullable: true })],
  [fk('orders_user', ['user_id'], 'users'), fk('orders_coupon', ['coupon_id'], 'coupons')]
)
const coupons = table('coupons', [col('id', { isPrimaryKey: true })])
const profiles = table(
  'profiles',
  [col('user_id', { isPrimaryKey: true })],
  [fk('profiles_user', ['user_id'], 'users')]
)

describe('buildEdges', () => {
  it('links foreign keys to tables in the set and drops the rest', () => {
    const edges = buildEdges([users, orders])
    expect(edges.map((e) => [e.from, e.to])).toEqual([['public.orders', 'public.users']])
  })

  it('marks nullable references optional and unique ones one-to-one', () => {
    const edges = buildEdges([users, orders, coupons, profiles])
    const byName = Object.fromEntries(edges.map((e) => [e.name, e]))
    expect(byName.orders_user).toMatchObject({ optional: false, unique: false })
    expect(byName.orders_coupon).toMatchObject({ optional: true, unique: false })
    expect(byName.profiles_user).toMatchObject({ unique: true })
  })

  it('matches MySQL references, which name the database, to schemaless tables', () => {
    const a = table('a', [col('id', { isPrimaryKey: true })], [], null)
    const b = table('b', [col('a_id')], [fk('b_a', ['a_id'], 'a', 'shop')], null)
    expect(buildEdges([a, b], 'shop')).toHaveLength(1)
    expect(buildEdges([a, b], 'other')).toHaveLength(0)
  })
})

describe('visibleColumns', () => {
  it('keeps only key columns in keys mode', () => {
    expect(visibleColumns(orders, 'keys').map((c) => c.name)).toEqual([
      'id',
      'user_id',
      'coupon_id'
    ])
    expect(visibleColumns(users, 'keys').map((c) => c.name)).toEqual(['id'])
    expect(visibleColumns(users, 'none')).toEqual([])
  })
})

describe('nodeBox', () => {
  it('grows with the rows shown', () => {
    const all = nodeBox(orders, 'all', true, approximateMeasure, false)
    const none = nodeBox(orders, 'none', true, approximateMeasure, false)
    expect(all.height).toBeGreaterThan(none.height)
    expect(all.width).toBeGreaterThanOrEqual(160)
  })
})

describe('fitText', () => {
  it('ellipsizes text that does not fit', () => {
    expect(fitText('short', 500, '12px x', approximateMeasure)).toBe('short')
    const cut = fitText('a_very_long_column_name', 60, '12px x', approximateMeasure)
    expect(cut.endsWith('…')).toBe(true)
    expect(approximateMeasure(cut, '12px x')).toBeLessThanOrEqual(60)
  })
})

describe('layoutDiagram', () => {
  const box = (key: string, height = 100): NodeBox => ({ key, width: 200, height })
  const overlaps = (boxes: NodeBox[], pos: Record<string, { x: number; y: number }>): boolean =>
    boxes.some((a, i) =>
      boxes.some(
        (b, j) =>
          i < j &&
          pos[a.key].x < pos[b.key].x + b.width &&
          pos[b.key].x < pos[a.key].x + a.width &&
          pos[a.key].y < pos[b.key].y + b.height &&
          pos[b.key].y < pos[a.key].y + a.height
      )
    )

  it('places referenced tables left of the tables that reference them', () => {
    const boxes = ['users', 'orders', 'items', 'lonely'].map((k) => box(k))
    const pos = layoutDiagram(boxes, [
      { from: 'orders', to: 'users' },
      { from: 'items', to: 'orders' }
    ])
    expect(pos.users.x).toBeLessThan(pos.orders.x)
    expect(pos.orders.x).toBeLessThan(pos.items.x)
    // Unrelated tables go underneath
    expect(pos.lonely.y).toBeGreaterThan(pos.users.y + 100)
    expect(overlaps(boxes, pos)).toBe(false)
  })

  it('survives cycles and self references', () => {
    const boxes = ['a', 'b', 'c'].map((k) => box(k))
    const pos = layoutDiagram(boxes, [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
      { from: 'a', to: 'a' }
    ])
    expect(Object.keys(pos).sort()).toEqual(['a', 'b', 'c'])
    expect(overlaps(boxes, pos)).toBe(false)
  })

  it('wraps a very full rank into several columns without overlaps', () => {
    const children = Array.from({ length: 40 }, (_, i) => box(`t${i}`, 300))
    const boxes = [box('hub'), ...children]
    const pos = layoutDiagram(
      boxes,
      children.map((c) => ({ from: c.key, to: 'hub' }))
    )
    const xs = new Set(children.map((c) => pos[c.key].x))
    expect(xs.size).toBeGreaterThan(1)
    expect(overlaps(boxes, pos)).toBe(false)
  })
})

describe('routeEdge', () => {
  const left = { x: 0, y: 0, width: 100, height: 100 }
  const right = { x: 300, y: 0, width: 100, height: 100 }

  it('leaves and enters on the facing sides', () => {
    const r = routeEdge(right, 50, left, 20)
    expect(r.start).toEqual({ x: 300, y: 50, dir: -1 })
    expect(r.end).toEqual({ x: 100, y: 20, dir: 1 })
    expect(r.path.startsWith('M 300 50')).toBe(true)
  })

  it('loops self references out of the right side', () => {
    const r = routeEdge(left, 40, left, 40, true)
    expect(r.start.dir).toBe(1)
    expect(r.end.dir).toBe(1)
    expect(r.end.y).not.toBe(r.start.y)
  })
})

describe('boundsOf', () => {
  it('encloses every rect', () => {
    expect(
      boundsOf([
        { x: 10, y: 20, width: 30, height: 40 },
        { x: -5, y: 0, width: 10, height: 10 }
      ])
    ).toEqual({ x: -5, y: 0, width: 45, height: 60 })
  })
})

describe('buildPdf', () => {
  it('writes a well-formed single page PDF with a correct xref table', () => {
    const pdf = buildPdf({
      pixels: new Uint8Array([1, 2, 3, 4]),
      width: 2,
      height: 1,
      pageWidth: 150,
      pageHeight: 75,
      title: 'shop (public) — schema'
    })
    const text = new TextDecoder('latin1').decode(pdf)
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text).toContain('/MediaBox [0 0 150 75]')
    expect(text).toContain('/Title (shop \\(public\\) ? schema)')

    // Every xref offset must point at its object, counted in bytes
    const bytes = Array.from(pdf, (b) => String.fromCharCode(b)).join('')
    const startxref = Number(/startxref\n(\d+)/.exec(bytes)![1])
    expect(bytes.slice(startxref, startxref + 4)).toBe('xref')
    const offsets = [...bytes.slice(startxref).matchAll(/(\d{10}) 00000 n/g)].map((m) => +m[1])
    expect(offsets).toHaveLength(6)
    offsets.forEach((offset, i) =>
      expect(bytes.slice(offset, offset + 8)).toBe(`${i + 1} 0 obj\n`.slice(0, 8))
    )
  })
})
