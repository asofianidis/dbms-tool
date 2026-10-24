import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableInfo } from '../api'
import {
  countChanges,
  draftFromTable,
  draftWarnings,
  indexChange,
  newCheck,
  newIndex,
  newTableDraft,
  newUnique,
  tableStatements,
  validateDraft,
  type TableDraft
} from '../ddl'
import type { Dialect } from '../engines'
import { checkExpression, extrasQueries, parseExtras, unwrapParens } from '../table-extras'

const column = (patch: Partial<ColumnInfo> & { name: string }): ColumnInfo => ({
  dataType: 'int',
  nullable: true,
  default: null,
  isPrimaryKey: false,
  isGenerated: false,
  isIdentity: false,
  comment: null,
  extra: null,
  ...patch
})

/** orders(id, customer_id, status, total) with an index, a foreign key and constraints. */
const ordersTable = (dialect: Dialect): TableInfo => ({
  columns: [
    column({ name: 'id', nullable: false, isPrimaryKey: true, isIdentity: true }),
    column({ name: 'customer_id' }),
    column({ name: 'status', dataType: 'varchar(10)' }),
    column({ name: 'total', dataType: 'decimal(10,2)' })
  ],
  primaryKey: ['id'],
  indexes: [
    {
      name: 'orders_pkey',
      columns: ['id'],
      unique: true,
      primary: true,
      method: null,
      definition: null
    },
    {
      name: 'ix_orders_customer',
      columns: ['customer_id'],
      unique: false,
      primary: false,
      method: dialect === 'postgres' ? 'btree' : dialect === 'tsql' ? 'nonclustered' : 'BTREE',
      definition:
        dialect === 'postgres'
          ? 'CREATE INDEX ix_orders_customer ON public.orders USING btree (customer_id)'
          : null
    },
    {
      name: 'uq_orders_status',
      columns: ['status', 'customer_id'],
      unique: true,
      primary: false,
      method: null,
      definition: null
    }
  ],
  foreignKeys: [
    {
      name: 'fk_orders_customer',
      columns: ['customer_id'],
      refSchema: dialect === 'mysql' ? 'app' : dialect === 'tsql' ? 'dbo' : 'public',
      refTable: 'customers',
      refColumns: ['id'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION'
    }
  ],
  triggers: []
})

const schemaOf = (dialect: Dialect): string =>
  dialect === 'mysql' ? 'app' : dialect === 'tsql' ? 'dbo' : 'public'

const load = (dialect: Dialect): TableDraft =>
  draftFromTable(dialect, schemaOf(dialect), 'orders', ordersTable(dialect), {
    checks: [{ name: 'ck_orders_total', expression: 'total >= 0' }],
    uniques:
      dialect === 'mysql'
        ? []
        : [
            {
              name: 'uq_orders_status',
              columns: ['status', 'customer_id'],
              index: 'uq_orders_status'
            }
          ],
    indexes: [{ name: 'ix_orders_customer', include: [], where: null }],
    sqlite: null
  })

const col = (draft: TableDraft, name: string) => draft.columns.find((c) => c.name === name)!

describe('loading', () => {
  it('lists unique constraints apart from indexes and leaves untouched tables alone', () => {
    for (const dialect of ['postgres', 'tsql'] as const) {
      const d = load(dialect)
      expect(d.indexes.map((ix) => ix.name)).toEqual(['ix_orders_customer'])
      expect(d.uniques).toHaveLength(1)
      expect(d.checks[0].expression).toBe('total >= 0')
      expect(tableStatements(dialect, d)).toEqual([])
      expect(countChanges(d, dialect)).toBe(0)
    }
    // MySQL keeps unique constraints as unique indexes
    expect(load('mysql').indexes.map((ix) => ix.name)).toEqual([
      'ix_orders_customer',
      'uq_orders_status'
    ])
  })

  it('treats the default index method as no method', () => {
    expect(load('postgres').indexes[0].method).toBe('')
    expect(load('tsql').indexes[0].method).toBe('')
    expect(load('mysql').indexes[0].method).toBe('')
  })

  it('locks indexes the designer could not rebuild faithfully', () => {
    const info = ordersTable('postgres')
    info.indexes[1].definition =
      'CREATE INDEX ix_orders_customer ON public.orders USING btree (customer_id DESC)'
    info.indexes.push({
      name: 'ix_lower',
      columns: ['lower(status)'],
      unique: false,
      primary: false,
      method: 'btree',
      definition: 'CREATE INDEX ix_lower ON public.orders USING btree (lower(status))'
    })
    const d = draftFromTable('postgres', 'public', 'orders', info)
    // Without catalog extras the unique constraint's index is listed too, unlocked
    expect(d.indexes.map((ix) => ix.name)).toEqual([
      'ix_orders_customer',
      'uq_orders_status',
      'ix_lower'
    ])
    expect(d.indexes.map((ix) => !!ix.locked)).toEqual([true, false, true])
  })
})

describe('index options', () => {
  it('writes PostgreSQL methods, INCLUDE and partial indexes', () => {
    const d = newTableDraft('postgres', 'public')
    d.name = 't'
    d.columns[0].name = 'id'
    d.indexes.push(
      newIndex({
        columns: [d.columns[0].id],
        method: 'brin',
        include: [],
        where: 'id > 100'
      })
    )
    expect(tableStatements('postgres', d)[1]).toBe(
      'CREATE INDEX ix_t_id ON public.t USING brin (id) WHERE id > 100'
    )
  })

  it('writes SQL Server clustered, covering and filtered indexes', () => {
    const d = load('tsql')
    d.indexes.push(
      newIndex({
        name: 'ix_status',
        columns: [col(d, 'status').id],
        include: [col(d, 'total').id],
        where: "status = 'open'",
        method: 'CLUSTERED'
      })
    )
    expect(tableStatements('tsql', d)).toEqual([
      "CREATE CLUSTERED INDEX [ix_status] ON [dbo].[orders] ([status]) INCLUDE ([total]) WHERE status = 'open'"
    ])
  })

  it('writes MySQL full-text and hash indexes into the ALTER TABLE', () => {
    const d = load('mysql')
    d.indexes.push(
      newIndex({ name: 'ft', columns: [col(d, 'status').id], method: 'FULLTEXT', unique: true }),
      newIndex({ name: 'hx', columns: [col(d, 'total').id], method: 'HASH' })
    )
    expect(tableStatements('mysql', d)).toEqual([
      'ALTER TABLE `app`.`orders`\n' +
        '  ADD FULLTEXT INDEX `ft` (`status`),\n' +
        '  ADD INDEX `hx` (`total`) USING HASH'
    ])
  })
})

describe('editing existing indexes and foreign keys', () => {
  it('renames an index in place when only its name changes', () => {
    const pg = load('postgres')
    pg.indexes[0].name = 'ix_customer'
    expect(indexChange('postgres', pg, pg.indexes[0])).toBe('rename')
    expect(tableStatements('postgres', pg)).toEqual([
      'ALTER INDEX public.ix_orders_customer RENAME TO ix_customer'
    ])
    const ms = load('tsql')
    ms.indexes[0].name = 'ix_customer'
    expect(tableStatements('tsql', ms)).toEqual([
      "EXEC sp_rename N'[dbo].[orders].[ix_orders_customer]', N'ix_customer', 'INDEX'"
    ])
    const my = load('mysql')
    my.indexes[0].name = 'ix_customer'
    expect(tableStatements('mysql', my)).toEqual([
      'ALTER TABLE `app`.`orders`\n  RENAME INDEX `ix_orders_customer` TO `ix_customer`'
    ])
  })

  it('drops and recreates an index whose shape changed', () => {
    const d = load('postgres')
    Object.assign(d.indexes[0], { unique: true, where: 'customer_id IS NOT NULL' })
    expect(indexChange('postgres', d, d.indexes[0])).toBe('recreate')
    expect(tableStatements('postgres', d)).toEqual([
      'DROP INDEX public.ix_orders_customer',
      'CREATE UNIQUE INDEX ix_orders_customer ON public.orders (customer_id) WHERE customer_id IS NOT NULL'
    ])
    expect(countChanges(d, 'postgres')).toBe(1)
  })

  it('recreates a foreign key with new actions', () => {
    const d = load('postgres')
    d.foreignKeys[0].onDelete = 'CASCADE'
    expect(tableStatements('postgres', d)).toEqual([
      'ALTER TABLE public.orders DROP CONSTRAINT fk_orders_customer',
      'ALTER TABLE public.orders ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES public.customers (id) ON DELETE CASCADE'
    ])
  })

  it('drops a recreated MySQL foreign key in an earlier statement', () => {
    const d = load('mysql')
    d.foreignKeys[0].onDelete = 'SET NULL'
    expect(tableStatements('mysql', d)).toEqual([
      'ALTER TABLE `app`.`orders`\n  DROP FOREIGN KEY `fk_orders_customer`',
      'ALTER TABLE `app`.`orders`\n' +
        '  ADD CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `app`.`customers` (`id`) ON DELETE SET NULL'
    ])
  })

  it('renames constraints where the engine can', () => {
    const d = load('tsql')
    d.foreignKeys[0].name = 'fk_customer'
    d.checks[0].name = 'ck_total'
    expect(tableStatements('tsql', d)).toEqual([
      "EXEC sp_rename N'[dbo].[fk_orders_customer]', N'fk_customer', 'OBJECT'",
      "EXEC sp_rename N'[dbo].[ck_orders_total]', N'ck_total', 'OBJECT'"
    ])
    const pg = load('postgres')
    pg.uniques[0].name = 'uq_status'
    expect(tableStatements('postgres', pg)).toEqual([
      'ALTER TABLE public.orders RENAME CONSTRAINT uq_orders_status TO uq_status'
    ])
  })
})

describe('check and unique constraints', () => {
  it('adds them inline when creating a table', () => {
    const d = newTableDraft('postgres', 'public')
    d.name = 'items'
    d.checks.push(newCheck({ expression: 'id > 0' }))
    d.uniques.push(newUnique({ columns: [d.columns[0].id] }))
    expect(tableStatements('postgres', d)).toEqual([
      `CREATE TABLE public.items (
  id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT uq_items_id UNIQUE (id),
  CONSTRAINT ck_items_1 CHECK (id > 0)
)`
    ])
  })

  it('adds, changes and drops them on an existing table', () => {
    const d = load('postgres')
    d.checks[0].expression = 'total > 0'
    d.uniques[0].dropped = true
    d.checks.push(newCheck({ name: 'ck_status', expression: "status <> ''" }))
    expect(tableStatements('postgres', d)).toEqual([
      'ALTER TABLE public.orders DROP CONSTRAINT ck_orders_total',
      'ALTER TABLE public.orders DROP CONSTRAINT uq_orders_status',
      'ALTER TABLE public.orders ADD CONSTRAINT ck_orders_total CHECK (total > 0)',
      "ALTER TABLE public.orders ADD CONSTRAINT ck_status CHECK (status <> '')"
    ])
    expect(countChanges(d, 'postgres')).toBe(3)
    expect(draftWarnings(d, 'postgres')).toEqual([
      'ck_orders_total, ck_status fail if existing rows break them'
    ])
  })

  it('uses DROP CONSTRAINT for MySQL checks and requires a condition', () => {
    const d = load('mysql')
    d.checks[0].dropped = true
    d.uniques.push(newUnique({ name: 'uq_total', columns: [col(d, 'total').id] }))
    expect(tableStatements('mysql', d)).toEqual([
      'ALTER TABLE `app`.`orders`\n' +
        '  DROP CONSTRAINT `ck_orders_total`,\n' +
        '  ADD CONSTRAINT `uq_total` UNIQUE (`total`)'
    ])
    d.checks.push(newCheck())
    expect(validateDraft('mysql', d)).toBe('Enter the condition for check ck_orders_1')
  })
})

describe('catalog extras', () => {
  it('reads check expressions out of catalog definitions', () => {
    expect(checkExpression('CHECK ((price > (0)::numeric)) NOT VALID')).toBe('price > (0)::numeric')
    expect(unwrapParens('([qty]>(0))')).toBe('[qty]>(0)')
    expect(unwrapParens('(a > 0) AND (b > 0)')).toBe('(a > 0) AND (b > 0)')
  })

  it('quotes the table it queries', () => {
    expect(extrasQueries('tsql', 'dbo', "o'brien").checks).toContain(
      "OBJECT_ID(N'[dbo].[o''brien]')"
    )
    expect(extrasQueries('postgres', 'public', 'Orders').checks).toContain(
      "format('%I.%I', 'public', 'Orders')::regclass"
    )
  })

  it('groups SQL Server rows per constraint and index', () => {
    const info = ordersTable('tsql')
    const extras = parseExtras(
      'tsql',
      {
        checks: [['ck_orders_total', '([total]>=(0))']],
        uniques: [
          ['uq_orders_status', 'status', 'uq_orders_status'],
          ['uq_orders_status', 'customer_id', 'uq_orders_status']
        ],
        indexes: [
          ['ix_orders_customer', 'status', "([status]='open')"],
          ['ix_orders_customer', 'total', "([status]='open')"],
          ['uq_orders_status', null, null]
        ]
      },
      info
    )
    expect(extras.checks).toEqual([{ name: 'ck_orders_total', expression: '[total]>=(0)' }])
    expect(extras.uniques[0].columns).toEqual(['status', 'customer_id'])
    expect(extras.indexes[0]).toEqual({
      name: 'ix_orders_customer',
      include: ['status', 'total'],
      where: "[status]='open'"
    })
  })

  it('parses PostgreSQL JSON arrays', () => {
    const extras = parseExtras(
      'postgres',
      {
        uniques: [['uq', '["status","customer_id"]', 'uq']],
        indexes: [['ix', '["total"]', "(status = 'open'::text)"]]
      },
      ordersTable('postgres')
    )
    expect(extras.uniques[0].columns).toEqual(['status', 'customer_id'])
    expect(extras.indexes[0].include).toEqual(['total'])
  })
})
