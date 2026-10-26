import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { MSSQL, PostgreSQL, schemaCompletionSource, sql } from '@codemirror/lang-sql'
import { EditorState } from '@codemirror/state'
import type { CompletionTable } from '@/lib/api'
import {
  aliasFor,
  callAt,
  expectsTable,
  sqlAssistCompletion,
  tableAwareCompletion,
  tablesInStatement
} from '../sql-completion'

const schema = {
  public: { orders: ['id', 'total'], customers: ['id', 'name'] },
  acme_corp: { orders: ['id'] },
  globex: { orders: ['id'] }
}

/** Completion labels with the cursor at the end of `doc`. */
async function labels(doc: string): Promise<string[]> {
  const state = EditorState.create({ doc, extensions: sql({ dialect: PostgreSQL }) })
  const source = tableAwareCompletion(
    schemaCompletionSource({ dialect: PostgreSQL, schema, defaultSchema: 'public' })
  )
  const result = await source(new CompletionContext(state, doc.length, false))
  return (result?.options.map((o) => o.label) ?? []).sort()
}

describe('SQL name completion', () => {
  it('knows where a table name goes', () => {
    expect(expectsTable('SELECT * FROM ')).toBe(true)
    expect(expectsTable('select * from a x, b as y, ')).toBe(true)
    expect(expectsTable('SELECT * FROM a JOIN ')).toBe(true)
    expect(expectsTable('INSERT INTO ')).toBe(true)
    expect(expectsTable('SELECT ')).toBe(false)
    expect(expectsTable('SELECT * FROM a WHERE ')).toBe(false)
    expect(expectsTable('SELECT * FROM a; SELECT ')).toBe(false)
  })

  it('offers schemas and tables only where a table goes', async () => {
    expect(await labels('SELECT * FROM a')).toEqual(
      expect.arrayContaining(['acme_corp', 'globex', 'orders'])
    )
    expect(await labels('SELECT a')).toEqual([])
    expect(await labels('SELECT * FROM orders WHERE g')).toEqual([])
  })

  it('finds a table outside the default schema by its name', async () => {
    const tsql: CompletionTable[] = [
      { schema: 'dbo', name: 'users', columns: ['id'], foreignKeys: [] },
      { schema: 'event', name: 'session', columns: ['id'], foreignKeys: [] },
      { schema: 'dbo', name: 'odd.name', columns: ['id'], foreignKeys: [] },
      { schema: 'order', name: 'items', columns: ['id'], foreignKeys: [] },
      { schema: 'event', name: 'session]archive', columns: ['id'], foreignKeys: [] }
    ]
    const ns = { dbo: { users: ['id'], 'odd\\.name': ['id'] }, event: { session: ['id'] } }
    const run = async (doc: string) => {
      const state = EditorState.create({ doc, extensions: sql({ dialect: MSSQL }) })
      const source = tableAwareCompletion(
        schemaCompletionSource({ dialect: MSSQL, schema: ns, defaultSchema: 'dbo' }),
        { tables: tsql, dialect: 'tsql', defaultSchema: 'dbo' }
      )
      return (await source(new CompletionContext(state, doc.length, false)))?.options ?? []
    }
    const plain = await run('SELECT * FROM sess')
    expect(plain.map((o) => o.label)).toEqual(
      expect.arrayContaining(['users', 'odd.name', 'event', 'event.session'])
    )
    expect(plain.map((o) => o.label)).not.toContain('dbo.users')
    expect(plain.find((o) => o.label === 'odd.name')?.apply).toBe('"odd.name"')
    // Reserved words and odd characters are quoted when inserted
    expect(plain.find((o) => o.label === 'order.items')?.apply).toBe('[order].[items]')
    expect(plain.find((o) => o.label === 'event.session')?.apply).toBe('[event].[session]')
    const bracketed = (await run('SELECT * FROM [sess')).map((o) => o.label)
    expect(bracketed).toContain('[event].[session]')
    expect(bracketed).toContain('[event].[session]]archive]')
    expect((await run('SELECT * FROM event.')).map((o) => o.label)).toEqual(['session'])
    expect(await run('SELECT sess')).toEqual([])
  })

  it('still completes qualified names and aliases anywhere', async () => {
    expect(await labels('SELECT * FROM orders WHERE acme_corp.')).toEqual(['orders'])
    expect(await labels('SELECT * FROM customers c WHERE c')).toEqual(['c'])
    expect(await labels('SELECT customers.')).toEqual(['id', 'name'])
  })
})

const tables: CompletionTable[] = [
  {
    schema: 'public',
    name: 'customers',
    columns: ['id', 'name', 'email'],
    foreignKeys: []
  },
  {
    schema: 'public',
    name: 'orders',
    columns: ['id', 'customer_id', 'total'],
    foreignKeys: [
      { columns: ['customer_id'], refSchema: 'public', refTable: 'customers', refColumns: ['id'] }
    ]
  },
  {
    schema: 'public',
    name: 'order_items',
    columns: ['order_id', 'sku'],
    foreignKeys: [
      { columns: ['order_id'], refSchema: 'public', refTable: 'orders', refColumns: ['id'] }
    ]
  }
]

/** Completions from the assist source with the cursor at `|` (or the end). */
async function assist(doc: string, explicit = false): Promise<string[]> {
  const pos = doc.includes('|') ? doc.indexOf('|') : doc.length
  const text = doc.replace('|', '')
  const state = EditorState.create({ doc: text, extensions: sql({ dialect: PostgreSQL }) })
  const source = sqlAssistCompletion({
    tables,
    dialect: 'postgres',
    defaultSchema: 'public',
    snippets: () => [{ id: 's', prefix: 'selw', description: 'select where', body: 'SELECT ${}' }]
  })
  const result = await source(new CompletionContext(state, pos, explicit))
  return result?.options.map((o) => o.label) ?? []
}

describe('statement-aware SQL completion', () => {
  it('finds the tables a statement uses, with aliases', () => {
    const found = tablesInStatement(
      'SELECT * FROM customers c, public.orders AS o JOIN order_items oi ON oi.order_id = o.id WHERE 1',
      tables,
      'postgres',
      'public'
    )
    expect(found.map((f) => [f.table.name, f.alias])).toEqual([
      ['customers', 'c'],
      ['orders', 'o'],
      ['order_items', 'oi']
    ])
    expect(
      tablesInStatement('UPDATE orders SET total = 0', tables, 'postgres', 'public')[0].alias
    ).toBe(null)
  })

  it('reads dots inside a quoted name as part of it', () => {
    const dotted: CompletionTable[] = [
      { schema: 'tx_esc_04_dbo', name: 'escworks.item.group', columns: ['id'], foreignKeys: [] },
      { schema: 'dbo', name: 'item.group', columns: ['id'], foreignKeys: [] }
    ]
    const names = (sql: string, dialect: 'postgres' | 'tsql'): string[] =>
      tablesInStatement(sql, dotted, dialect, 'public').map((f) => f.table.name)
    expect(names('SELECT * FROM tx_esc_04_dbo."escworks.item.group" WHERE ', 'postgres')).toEqual([
      'escworks.item.group'
    ])
    expect(names('SELECT * FROM [dbo].[item.group] g WHERE ', 'tsql')).toEqual(['item.group'])
  })

  it('offers the columns of the statement’s tables in SELECT and WHERE', async () => {
    const labels = await assist('SELECT na| FROM customers c')
    expect(labels).toEqual(expect.arrayContaining(['name', 'email']))
    // Ambiguous names come qualified
    const both = await assist(
      'SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id WHERE i'
    )
    expect(both).toEqual(expect.arrayContaining(['c.id', 'o.id', 'total']))
    expect(both).not.toContain('id')
  })

  it('suggests joins along foreign keys both ways', async () => {
    const labels = await assist('SELECT * FROM orders o JOIN ')
    expect(labels).toEqual([
      'customers c ON c.id = o.customer_id',
      'order_items oi ON oi.order_id = o.id'
    ])
    const on = await assist('SELECT * FROM orders o JOIN customers cu ON ')
    expect(on).toContain('cu.id = o.customer_id')
  })

  it('offers functions and snippets, but not after a dot or where a table goes', async () => {
    expect(await assist('SELECT coal')).toContain('coalesce')
    expect(await assist('sel')).toContain('selw')
    expect(await assist('SELECT * FROM customers c WHERE c.')).toEqual([])
    expect(await assist('SELECT * FROM cust')).toEqual([])
  })

  it('picks unique aliases', () => {
    expect(aliasFor('order_items', new Set())).toBe('oi')
    expect(aliasFor('OrderItems', new Set(['oi']))).toBe('oi2')
  })

  it('finds the call the cursor is in', () => {
    expect(callAt('SELECT coalesce(a, f(b), ', 25)).toEqual({ name: 'coalesce', arg: 2, open: 15 })
    expect(callAt("SELECT round(price, ')'", 23)).toMatchObject({ name: 'round', arg: 1 })
    expect(callAt('SELECT 1; SELECT (', 18)).toBeNull()
    expect(callAt('SELECT a', 8)).toBeNull()
  })
})
