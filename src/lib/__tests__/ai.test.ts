import { describe, expect, it } from 'vitest'
import type { CompletionTable, ExecOutput } from '../api'
import {
  describeCollections,
  describeDocuments,
  fitHistory,
  describeRows,
  describeSchema,
  mongoReadOnly,
  mongoWriteHint,
  parseDashboardSpec,
  parseMongoRead,
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
    expect(describeRows(output, 2)).toBe(
      'id,note\n1,"a, b"\n2,NULL\n(Only the first 2 rows are shown; more matched, and how many is unknown. Use count(*) to find out.)'
    )
    // The backend stopped at the limit: the count it gives is not the total
    const cut = {
      ...output,
      results: [
        {
          ...output.results[0],
          rows: output.results[0].rows.slice(0, 2),
          rowCount: 3,
          truncated: true
        }
      ]
    }
    expect(describeRows(cut, 2)).toContain('how many is unknown')
    const whole = { ...output, results: [{ ...output.results[0], truncated: false }] }
    expect(describeRows(whole, 5)).not.toContain('Only the first')
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

describe('MongoDB requests from the model', () => {
  it('reads JSON requests without evaluating anything', () => {
    expect(
      parseMongoRead('{"op":"find","collection":"orders","filter":{"a":1},"limit":5}', 'shop')
    ).toEqual({
      op: 'find',
      database: 'shop',
      collection: 'orders',
      filter: { a: 1 },
      projection: undefined,
      sort: undefined,
      limit: 5
    })
    expect(() => parseMongoRead('db.orders.find()', 'shop')).toThrow('JSON')
    expect(() => parseMongoRead('{"op":"deleteMany","collection":"o"}', 'shop')).toThrow()
    expect(() =>
      parseMongoRead('{"op":"aggregate","collection":"o","pipeline":[{"$out":"x"}]}', 'shop')
    ).toThrow('$out')
  })

  it('flags writes from the text alone', () => {
    expect(mongoWriteHint('db.orders.find({})')).toBeNull()
    expect(mongoWriteHint('db.orders.deleteMany({})')).toBe('Runs deleteMany')
    expect(mongoWriteHint('db.o.aggregate([{ $merge: "x" }])')).toBe('Writes with $merge')
  })
})

describe('dashboards from the model', () => {
  it('reads and normalizes a dashboard block', () => {
    const spec = parseDashboardSpec(
      JSON.stringify({
        name: 'Sales',
        refreshSecs: 45,
        widgets: [
          { title: 'Orders', kind: 'stat', query: 'SELECT count(*) AS n FROM orders', y: ['n'] },
          { title: 'By day', kind: 'pie', query: 'SELECT 1', span: 9 }
        ]
      })
    )
    expect(spec.name).toBe('Sales')
    expect(spec.refreshSecs).toBe(0)
    expect(spec.widgets[0]).toMatchObject({ kind: 'stat', span: 1, x: null, y: ['n'] })
    expect(spec.widgets[1]).toMatchObject({ kind: 'table', span: 2 })
  })

  it('rejects broken blocks', () => {
    expect(() => parseDashboardSpec('{')).toThrow()
    expect(() => parseDashboardSpec('{"widgets": []}')).toThrow('no widgets')
    expect(() => parseDashboardSpec('{"widgets": [{"title": "x"}]}')).toThrow('no query')
  })
})

describe('limits', () => {
  it('keeps MongoDB reads in the tab’s database', () => {
    expect(() =>
      parseMongoRead('{"op":"find","database":"admin","collection":"system.users"}', 'shop')
    ).toThrow("tab's database")
    expect(() => parseMongoRead('{"op":"find","collection":"system.profile"}', 'shop')).toThrow(
      'system collections'
    )
    expect(
      parseMongoRead('{"op":"count","database":"shop","collection":"o"}', 'shop')
    ).toMatchObject({ database: 'shop' })
  })

  it('caps distinct values', () => {
    const out = {
      kind: 'value' as const,
      documents: [],
      value: ['a', 'b', 'c', 'd'],
      total: null,
      truncated: false,
      elapsedMs: 1,
      cancelled: false
    }
    expect(describeDocuments(out, 2)).toBe(
      '["a","b"]\n(Only the first 2 values are shown; there are more.)'
    )
  })

  it('trims history to the budget, keeping the latest result and question', () => {
    const big = 'x'.repeat(1000)
    const messages = [
      { role: 'user' as const, content: `first ${big}` },
      { role: 'assistant' as const, content: 'ok <run_query>SELECT 1</run_query>' },
      { role: 'user' as const, content: `<query_result>\n${big}\n</query_result>` },
      { role: 'assistant' as const, content: 'more <run_query>SELECT 2</run_query>' },
      { role: 'user' as const, content: `<query_result>\nlatest ${big}\n</query_result>` },
      { role: 'assistant' as const, content: 'answer' },
      { role: 'user' as const, content: 'next question' }
    ]
    const fitted = fitHistory(messages, 1500)
    expect(fitted[0].role).toBe('user')
    expect(fitted.at(-1)?.content).toBe('next question')
    expect(fitted.some((m) => m.content.includes('latest'))).toBe(true)
    expect(fitted.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(1500)
    // Under budget, only older results shrink
    const roomy = fitHistory(messages, 100_000)
    expect(roomy).toHaveLength(messages.length)
    expect(roomy[2].content).toContain('left out')
    expect(roomy[4].content).toContain('latest')
  })
})
