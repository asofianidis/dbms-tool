import { describe, expect, it } from 'vitest'
import type { CompletionTable, ExecOutput } from '../api'
import {
  describeCollections,
  describeRows,
  describeSchema,
  mongoReadOnly,
  parseReply,
  refusedSql,
  schemaFields,
  systemPrompt,
  takeRunRequest
} from '../ai'

const table = (name: string, columns: string[], schema = 'public'): CompletionTable => ({
  schema,
  name,
  columns,
  foreignKeys: []
})

describe('describeSchema', () => {
  it('lists tables with columns and foreign keys', () => {
    const orders: CompletionTable = {
      ...table('orders', ['id', 'customer_id', 'total']),
      foreignKeys: [
        { columns: ['customer_id'], refSchema: 'public', refTable: 'customers', refColumns: ['id'] }
      ]
    }
    const { text, complete } = describeSchema([table('customers', ['id', 'name']), orders], 10_000)
    expect(text).toContain('public.customers(id, name)')
    expect(text).toContain('public.orders(id, customer_id, total)')
    expect(text).toContain('FK (customer_id) -> public.customers(id)')
    expect(complete).toBe(true)
  })

  it('keeps the tables the question names when the budget runs out', () => {
    const tables = Array.from({ length: 50 }, (_, i) =>
      table(`t${String(i).padStart(2, '0')}`, ['id', 'a', 'b', 'c'])
    )
    const { text, complete } = describeSchema(tables, 200, 'how many rows in t42?')
    expect(text.startsWith('public.t42(')).toBe(true)
    expect(complete).toBe(false)
    expect(text).toContain('More tables (columns not shown)')
  })
})

describe('replies', () => {
  it('splits prose from code blocks', () => {
    const segments = parseReply('Try this:\n\n```sql\nSELECT 1;\n```\n\nIt counts.')
    expect(segments).toEqual([
      { kind: 'text', text: 'Try this:' },
      { kind: 'code', lang: 'sql', code: 'SELECT 1;' },
      { kind: 'text', text: 'It counts.' }
    ])
  })

  it('takes a query request off the end of a reply', () => {
    expect(
      takeRunRequest('Let me check.\n<run_query>\nSELECT count(*) FROM t\n</run_query>')
    ).toEqual({
      text: 'Let me check.',
      query: 'SELECT count(*) FROM t'
    })
    expect(takeRunRequest('<run_query>```sql\nSELECT 1\n```</run_query>').query).toBe('SELECT 1')
    expect(takeRunRequest('No query here').query).toBeNull()
  })
})

describe('data access', () => {
  it('refuses writes, deletes and drops', () => {
    expect(refusedSql('SELECT * FROM t', 'postgres')).toBeNull()
    expect(refusedSql('DELETE FROM t', 'postgres')).toContain('DELETE')
    expect(refusedSql('DROP TABLE t', 'mysql')).toContain('DROP')
    expect(refusedSql('select 1; truncate t', 'tsql')).toContain('TRUNCATE')
  })

  it('only lets Mongo reads through', () => {
    const base = { database: 'd', collection: 'c' }
    expect(mongoReadOnly({ op: 'find', ...base })).toBe(true)
    expect(mongoReadOnly({ op: 'aggregate', ...base, pipeline: [{ $match: {} }] })).toBe(true)
    expect(mongoReadOnly({ op: 'aggregate', ...base, pipeline: [{ $out: 'x' }] })).toBe(false)
    expect(mongoReadOnly({ op: 'deleteMany', ...base, filter: {} })).toBe(false)
    expect(mongoReadOnly({ op: 'dropCollection', ...base })).toBe(false)
  })

  it('describes rows as CSV, capped', () => {
    const output: ExecOutput = {
      results: [
        {
          columns: [
            { name: 'id', typeName: 'int4' },
            { name: 'note', typeName: 'text' }
          ],
          rows: [
            ['1', 'a, b'],
            ['2', null],
            ['3', 'x']
          ],
          rowCount: 3,
          truncated: false
        }
      ],
      messages: [],
      error: null,
      elapsedMs: 1,
      cancelled: false,
      database: null,
      inTransaction: null
    }
    expect(describeRows(output, 2)).toBe('id,note\n1,"a, b"\n2,NULL\n(1 more rows not shown)')
  })

  it('tells the model whether it may read data', () => {
    const base = { engine: 'PostgreSQL', language: 'sql' as const, database: 'app', schema: 'x(y)' }
    expect(systemPrompt({ ...base, data: { allowed: false, maxRows: 50 } })).not.toContain(
      '<run_query>'
    )
    expect(systemPrompt({ ...base, data: { allowed: true, maxRows: 50 } })).toContain('<run_query>')
  })
})

describe('Mongo schema', () => {
  it('flattens sampled fields without values', () => {
    const fields = schemaFields({
      bsonType: 'object',
      properties: {
        name: { bsonType: 'string' },
        address: { bsonType: 'object', properties: { city: { bsonType: 'string' } } },
        tags: { bsonType: 'array', items: { bsonType: 'string' } }
      }
    })
    expect(fields).toEqual([
      'name: string',
      'address: object',
      'address.city: string',
      'tags: array<string>'
    ])
    expect(describeCollections([{ name: 'users', fields }], 1000)).toBe(
      'users { name: string, address: object, address.city: string, tags: array<string> }'
    )
  })
})
