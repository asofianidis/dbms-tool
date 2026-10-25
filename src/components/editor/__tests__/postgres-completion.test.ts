import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { sql } from '@codemirror/lang-sql'
import { EditorState } from '@codemirror/state'
import { functionsFor } from '@/lib/sql-functions'
import { POSTGRES_FUNCTIONS } from '@/lib/sql-functions-postgres'
import { editorPostgres, PostgresSQL, postgresCompletion } from '../postgres-completion'
import { sqlAssistCompletion } from '../sql-completion'

const context = (doc: string, explicit = false): CompletionContext =>
  new CompletionContext(
    EditorState.create({ doc, extensions: sql({ dialect: PostgresSQL }) }),
    doc.length,
    explicit
  )

async function phrases(doc: string, version = 17): Promise<string[]> {
  const result = await postgresCompletion(version)(context(doc))
  return result?.options.map((o) => o.label) ?? []
}

describe('PostgreSQL clause completion', () => {
  it('completes MERGE and its WHEN clauses', async () => {
    expect(await phrases('MER')).toEqual(['MERGE INTO'])
    expect(await phrases('SELECT 1; MERGE I')).toEqual(['INTO'])
    expect(await phrases('MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED B')).toEqual([
      'BY TARGET THEN INSERT',
      'BY SOURCE THEN DELETE',
      'BY SOURCE THEN UPDATE SET'
    ])
    expect(await phrases('MERGE INTO t USING s ON t.id = s.id W')).toEqual(
      expect.arrayContaining(['WHEN MATCHED THEN UPDATE SET', 'WHEN NOT MATCHED THEN INSERT'])
    )
    // Not outside MERGE
    expect(await phrases('SELECT CASE W')).not.toContain('WHEN MATCHED THEN DELETE')
  })

  it('leaves out clauses newer than the server', async () => {
    expect(await phrases('MER', 14)).toEqual([])
    expect(await phrases('MERGE INTO t USING s ON true WHEN NOT MATCHED B', 16)).toEqual([])
    expect(await phrases('MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE R', 16)).toEqual([])
    expect(await phrases('MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE R')).toEqual([
      'RETURNING'
    ])
    expect(await phrases("SELECT '{}' IS J", 15)).toEqual([])
    expect(await phrases("SELECT '{}' IS J", 16)).toEqual(
      expect.arrayContaining(['JSON', 'JSON OBJECT', 'JSON WITH UNIQUE KEYS'])
    )
  })

  it('completes ON CONFLICT and RETURNING in writes only', async () => {
    expect(await phrases('INSERT INTO t VALUES (1) ON C')).toEqual([
      'CONFLICT DO NOTHING',
      'CONFLICT',
      'CONFLICT ON CONSTRAINT'
    ])
    expect(await phrases('SELECT * FROM a JOIN b ON C')).not.toContain('CONFLICT')
    expect(await phrases('UPDATE t SET a = 1 RET', 13)).toEqual(['RETURNING'])
    expect(await phrases('SELECT 1 RET', 13)).toEqual([])
  })

  it('completes FROM items, grouping and FILTER in queries', async () => {
    expect(await phrases('SELECT * FROM unnest(a) W')).toContain('WITH ORDINALITY')
    expect(await phrases('SELECT * FROM t C')).toEqual(['CROSS JOIN LATERAL'])
    expect(await phrases('SELECT * FROM t LEFT JOIN L')).toEqual(['LATERAL'])
    expect(await phrases('SELECT D')).toEqual(['DISTINCT ON'])
    expect(await phrases('SELECT count(*) FI')).toEqual(['FILTER'])
    expect(await phrases('SELECT a FROM t GROUP BY G')).toContain('GROUPING SETS')
    expect(await phrases('SELECT a FROM t GROUP BY R')).toEqual(['ROLLUP'])
  })

  it('inserts snippets with fields', async () => {
    const result = await postgresCompletion(17)(context('INSERT INTO t VALUES (1) ON CONFLICT'))
    const option = result?.options.find((o) => o.label === 'CONFLICT')
    expect(option?.detail).toBe('PostgreSQL')
    expect(typeof option?.apply).toBe('function')
  })

  it('reads the major version from the server info', () => {
    expect(editorPostgres({ product: 'PostgreSQL 17.2' })).toBe(17)
    expect(editorPostgres({ product: 'PostgreSQL 13.16' })).toBe(13)
    expect(editorPostgres({ product: 'PostgreSQL' })).toBe(Infinity)
    expect(editorPostgres({ product: 'MariaDB 11.4.2' })).toBeUndefined()
    expect(editorPostgres(null)).toBeUndefined()
  })
})

describe('PostgreSQL functions', () => {
  const names = (version?: number): string[] =>
    functionsFor('postgres', null, version).map((f) => f.name)

  it('adds each function once, for PostgreSQL only', () => {
    const own = POSTGRES_FUNCTIONS.map((f) => f.name)
    expect(new Set(own).size).toBe(own.length)
    const all = names()
    for (const name of own) expect(all.filter((n) => n === name)).toHaveLength(1)
    expect(functionsFor('mysql').map((f) => f.name)).not.toContain('jsonb_path_query')
    expect(functionsFor('tsql').map((f) => f.name)).not.toContain('json_table')
  })

  it('gates functions by the server version', () => {
    expect(names(13)).toContain('jsonb_path_query')
    expect(names(13)).not.toContain('date_bin')
    expect(names(14)).toContain('date_bin')
    expect(names(15)).toContain('regexp_like')
    expect(names(15)).not.toContain('json_array')
    expect(names(16)).toEqual(expect.arrayContaining(['json_array', 'json_objectagg', 'any_value']))
    expect(names(16)).not.toContain('json_table')
    expect(names(17)).toEqual(expect.arrayContaining(['json_table', 'json_value', 'merge_action']))
    expect(names()).toContain('json_table')
  })

  it('completes them in the editor for the server version', async () => {
    const run = async (postgres?: number): Promise<string[]> => {
      const result = await sqlAssistCompletion({ tables: [], dialect: 'postgres', postgres })(
        context('SELECT json_', true)
      )
      return result?.options.map((o) => o.label) ?? []
    }
    expect(await run(17)).toContain('json_table')
    expect(await run(16)).not.toContain('json_table')
    expect(await run(16)).toContain('json_array')
  })
})
