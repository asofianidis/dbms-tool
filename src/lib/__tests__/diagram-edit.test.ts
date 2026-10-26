import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableInfo } from '../api'
import { draftFromTable, tableStatements } from '../ddl'
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  ROW_PAD,
  tableKey,
  type DiagramTable,
  type NodeBox
} from '../diagram'
import {
  applyRelationship,
  columnAt,
  dropForeignKey,
  hitTest,
  isKeyColumn,
  orientLink,
  referencingType,
  suggestColumnName,
  typesDiffer
} from '../diagram-edit'

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

const table = (name: string, columns: ColumnInfo[]): DiagramTable => ({
  key: tableKey('public', name),
  schema: 'public',
  name,
  kind: 'table',
  columns,
  primaryKey: columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
  foreignKeys: [],
  indexes: []
})

const customers = table('customers', [
  col('id', { isPrimaryKey: true }),
  col('email', { dataType: 'text' })
])
customers.indexes.push({
  name: 'ux_email',
  columns: ['email'],
  unique: true,
  primary: false,
  method: null,
  definition: null
})
const orders = table('orders', [
  col('id', { isPrimaryKey: true }),
  col('customer_id', { nullable: true }),
  col('note', { dataType: 'text' })
])
const byKey = new Map([customers, orders].map((t) => [t.key, t]))

const rowMiddle = (index: number): number =>
  HEADER_HEIGHT + ROW_PAD + index * ROW_HEIGHT + ROW_HEIGHT / 2

describe('hit testing', () => {
  it('finds the column row under a point', () => {
    expect(columnAt(orders, 'all', rowMiddle(1))).toBe('customer_id')
    expect(columnAt(orders, 'all', HEADER_HEIGHT / 2)).toBeNull()
    expect(columnAt(orders, 'all', rowMiddle(3))).toBeNull()
    // Keys mode shows only id and no other key column
    expect(columnAt(orders, 'keys', rowMiddle(1))).toBeNull()
  })

  it('picks the topmost table', () => {
    const boxes = new Map<string, NodeBox>([
      [customers.key, { key: customers.key, width: 200, height: 120 }],
      [orders.key, { key: orders.key, width: 200, height: 120 }]
    ])
    const positions = { [customers.key]: { x: 0, y: 0 }, [orders.key]: { x: 100, y: 0 } }
    const hit = hitTest([customers, orders], boxes, positions, 'all', { x: 150, y: rowMiddle(0) })
    expect(hit).toEqual({ key: orders.key, column: 'id' })
    expect(hitTest([customers, orders], boxes, positions, 'all', { x: 500, y: 10 })).toBeNull()
  })
})

describe('orientLink', () => {
  it('makes the dragged column reference the target', () => {
    expect(
      orientLink(
        { key: orders.key, column: 'customer_id' },
        { key: customers.key, column: 'id' },
        byKey
      )
    ).toEqual({
      child: orders.key,
      childColumn: 'customer_id',
      parent: customers.key,
      parentColumn: 'id'
    })
  })

  it('flips when a key is dragged onto a plain column', () => {
    expect(
      orientLink(
        { key: customers.key, column: 'id' },
        { key: orders.key, column: 'customer_id' },
        byKey
      )
    ).toMatchObject({ child: orders.key, childColumn: 'customer_id', parent: customers.key })
  })

  it('adds a new column when a key is dropped on a table', () => {
    expect(
      orientLink({ key: customers.key, column: 'id' }, { key: orders.key, column: null }, byKey)
    ).toEqual({ child: orders.key, childColumn: null, parent: customers.key, parentColumn: 'id' })
  })

  it("references a table's key when a plain column is dropped on it", () => {
    expect(
      orientLink(
        { key: orders.key, column: 'customer_id' },
        { key: customers.key, column: null },
        byKey
      )
    ).toMatchObject({ parent: customers.key, parentColumn: 'id' })
  })

  it('ignores dropping a column on itself', () => {
    expect(
      orientLink({ key: orders.key, column: 'id' }, { key: orders.key, column: 'id' }, byKey)
    ).toBeNull()
  })
})

describe('helpers', () => {
  it('recognises key columns', () => {
    expect(isKeyColumn(customers, 'id')).toBe(true)
    expect(isKeyColumn(customers, 'email')).toBe(true)
    expect(isKeyColumn(orders, 'customer_id')).toBe(false)
  })

  it('names referencing columns', () => {
    expect(suggestColumnName('customers', 'id', ['id'])).toBe('customer_id')
    expect(suggestColumnName('categories', 'id', [])).toBe('category_id')
    expect(suggestColumnName('address', 'id', [])).toBe('address_id')
    expect(suggestColumnName('customers', 'id', ['customer_id'])).toBe('customer_id2')
  })

  it('compares types loosely', () => {
    expect(typesDiffer('int(11)', 'int')).toBe(false)
    expect(typesDiffer('int4', 'integer')).toBe(false)
    expect(typesDiffer('character varying(20)', 'varchar(40)')).toBe(false)
    expect(typesDiffer('text', 'integer')).toBe(true)
  })

  it('drops auto-numbering from referencing types', () => {
    expect(referencingType('postgres', 'bigserial')).toBe('bigint')
    expect(referencingType('postgres', 'serial')).toBe('integer')
    expect(referencingType('mysql', 'int unsigned')).toBe('int unsigned')
  })
})

describe('applying relationships', () => {
  const info: TableInfo = {
    columns: orders.columns,
    primaryKey: ['id'],
    foreignKeys: [],
    indexes: [],
    triggers: []
  } as unknown as TableInfo
  const draft = draftFromTable('postgres', 'public', 'orders', info)
  const base = {
    newColumn: null,
    refSchema: 'public',
    refTable: 'customers',
    refColumn: 'id',
    name: '',
    onDelete: 'CASCADE' as const,
    onUpdate: 'NO ACTION' as const,
    index: false
  }

  it('adds a foreign key on an existing column', () => {
    const sql = tableStatements(
      'postgres',
      applyRelationship('postgres', draft, { ...base, column: 'customer_id', index: true })
    ).join(';\n')
    expect(sql).toContain(
      'ADD CONSTRAINT fk_orders_customer_id FOREIGN KEY (customer_id) REFERENCES public.customers (id) ON DELETE CASCADE'
    )
    expect(sql).toContain('CREATE INDEX ix_orders_customer_id')
  })

  it('adds the column first when it is new', () => {
    const sql = tableStatements(
      'postgres',
      applyRelationship('postgres', draft, {
        ...base,
        column: 'buyer_id',
        newColumn: { dataType: 'integer', nullable: true }
      })
    ).join(';\n')
    expect(sql.indexOf('ADD COLUMN buyer_id integer')).toBeGreaterThan(-1)
    expect(sql.indexOf('ADD COLUMN')).toBeLessThan(sql.indexOf('FOREIGN KEY'))
  })

  it('drops a foreign key by name', () => {
    const linked = draftFromTable('postgres', 'public', 'orders', {
      ...info,
      foreignKeys: [
        {
          name: 'fk_x',
          columns: ['customer_id'],
          refSchema: 'public',
          refTable: 'customers',
          refColumns: ['id'],
          onDelete: null,
          onUpdate: null
        }
      ]
    })
    expect(dropForeignKey(linked, 'missing')).toBeNull()
    expect(tableStatements('postgres', dropForeignKey(linked, 'fk_x')!).join(';')).toContain(
      'DROP CONSTRAINT fk_x'
    )
  })
})
