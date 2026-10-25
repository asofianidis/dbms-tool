import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { keywordCompletionSource, MySQL, sql, type SQLDialect } from '@codemirror/lang-sql'
import { EditorState } from '@codemirror/state'
import type { ServerVersion } from '@/lib/mariadb'
import { editorMariaDb, MariaDbSQL, mariaDbCompletion } from '../mariadb-completion'
import { sqlAssistCompletion } from '../sql-completion'

const context = (doc: string, explicit = false): CompletionContext =>
  new CompletionContext(
    EditorState.create({ doc, extensions: sql({ dialect: MariaDbSQL }) }),
    doc.length,
    explicit
  )

async function phrases(doc: string, version: ServerVersion = [11, 8, 0]): Promise<string[]> {
  const result = await mariaDbCompletion(version)(context(doc))
  return result?.options.map((o) => o.label) ?? []
}

describe('MariaDB clause completion', () => {
  it('completes FOR SYSTEM_TIME after a table, word by word', async () => {
    expect(await phrases('SELECT * FROM t F')).toEqual(
      expect.arrayContaining(['FOR SYSTEM_TIME AS OF', 'FOR SYSTEM_TIME ALL'])
    )
    expect(await phrases('SELECT * FROM t FOR SYSTEM_TIME A')).toEqual(['AS OF', 'ALL'])
    expect(await phrases('select * from t for s')).toEqual(
      expect.arrayContaining(['SYSTEM_TIME AS OF', 'SYSTEM_TIME BETWEEN'])
    )
    expect(await phrases('SELECT F')).not.toContain('FOR SYSTEM_TIME AS OF')
  })

  it('completes statement-start commands only at the start', async () => {
    expect(await phrases('KI')).toEqual(['KILL QUERY ID'])
    expect(await phrases('SELECT 1; KILL Q')).toEqual(['QUERY ID'])
    expect(await phrases('SELECT KI')).toEqual([])
    expect(await phrases('SH')).toEqual(['SHOW EXPLAIN FOR'])
    expect(await phrases('ANALYZE FORMAT=J')).toEqual(['FORMAT=JSON'])
    expect(await phrases('DELETE H')).toEqual(['HISTORY FROM'])
  })

  it('completes table options in DDL and sequences anywhere', async () => {
    expect(await phrases('CREATE TABLE t (a INT) W')).toEqual(['WITH SYSTEM VERSIONING'])
    expect(await phrases('ALTER TABLE t A')).toEqual(['ADD SYSTEM VERSIONING'])
    expect(await phrases('CREATE TABLE t (s DATE, e DATE, P')).toEqual(
      expect.arrayContaining(['PERIOD FOR', 'PERIOD FOR SYSTEM_TIME'])
    )
    expect(await phrases('SELECT N')).toEqual(['NEXT VALUE FOR'])
    expect(await phrases('SELECT 1 INTERSECT A')).toEqual(['ALL'])
  })

  it('leaves out clauses newer than the server', async () => {
    expect(await phrases('SELECT N', [10, 2, 0])).toEqual([])
    expect(await phrases('SELECT 1 INTERSECT A', [10, 4, 0])).toEqual([])
  })

  it('completes the next word on request', async () => {
    const source = mariaDbCompletion([11, 8, 0])
    expect(await source(context('SELECT * FROM t FOR '))).toBeNull()
    const asked = await source(context('SELECT * FROM t FOR ', true))
    expect(asked?.options.map((o) => o.label)).toEqual(
      expect.arrayContaining(['SYSTEM_TIME AS OF'])
    )
  })
})

describe('MariaDB dialect', () => {
  const keywords = async (dialect: SQLDialect, doc: string): Promise<string[]> => {
    const state = EditorState.create({ doc, extensions: sql({ dialect }) })
    const result = await keywordCompletionSource(
      dialect,
      true
    )(new CompletionContext(state, doc.length, false))
    return result?.options.map((o) => o.label) ?? []
  }

  it('knows RETURNING and the sequence and versioning words, unlike MySQL', async () => {
    expect(await keywords(MariaDbSQL, 'DELETE FROM t RET')).toContain('RETURNING')
    expect(await keywords(MySQL, 'DELETE FROM t RET')).not.toContain('RETURNING')
    for (const word of ['SEQUENCE', 'HISTORY', 'PERIOD', 'VERSIONING', 'SYSTEM_TIME', 'INET6'])
      expect(await keywords(MariaDbSQL, word.slice(0, 3))).toContain(word)
  })

  it('reads the MariaDB version from server info', () => {
    expect(editorMariaDb({ product: 'MariaDB 11.8.3', version: '11.8.3-MariaDB' })).toEqual([
      11, 8, 3
    ])
    expect(editorMariaDb({ product: 'MySQL 8.4.0', version: '8.4.0' })).toBeUndefined()
    expect(editorMariaDb(null)).toBeUndefined()
  })
})

describe('statement-aware completion on MariaDB', () => {
  const assist = async (doc: string, mariaDb?: ServerVersion): Promise<string[]> => {
    const source = sqlAssistCompletion({ tables: [], dialect: 'mysql', mariaDb })
    const result = await source(context(doc))
    return result?.options.map((o) => o.label) ?? []
  }

  it('offers MariaDB functions only to MariaDB', async () => {
    expect(await assist('SELECT vec_', [11, 8, 0])).toEqual(
      expect.arrayContaining(['vec_distance', 'vec_fromtext'])
    )
    expect(await assist('SELECT vec_')).not.toContain('vec_distance')
    expect(await assist('SELECT natural', [10, 6, 0])).not.toContain('natural_sort_key')
  })
})
