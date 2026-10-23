import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { PostgreSQL, schemaCompletionSource, sql } from '@codemirror/lang-sql'
import { EditorState } from '@codemirror/state'
import { expectsTable, tableAwareCompletion } from '../sql-completion'

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

  it('still completes qualified names and aliases anywhere', async () => {
    expect(await labels('SELECT * FROM orders WHERE acme_corp.')).toEqual(['orders'])
    expect(await labels('SELECT * FROM customers c WHERE c')).toEqual(['c'])
    expect(await labels('SELECT customers.')).toEqual(['id', 'name'])
  })
})
