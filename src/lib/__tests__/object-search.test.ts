import { describe, expect, it } from 'vitest'
import { likePattern, objectSearchSql, parseSearchRows } from '../object-search'

describe('object search', () => {
  it('escapes LIKE wildcards and lower-cases the term', () => {
    expect(likePattern('postgres', 'Order_Items%')).toBe('%order\\_items\\%%')
    expect(likePattern('postgres', 'ord', true)).toBe('ord%')
    // T-SQL brackets are character classes
    expect(likePattern('tsql', 'a[b')).toBe('%a\\[b%')
    expect(likePattern('postgres', 'a[b')).toBe('%a[b%')
  })

  it('searches PostgreSQL relations and routines outside the system schemas', () => {
    const sql = objectSearchSql('postgres', "o'rd", 25)
    expect(sql).toContain("c.relname ILIKE '%o''rd%' ESCAPE '\\'")
    expect(sql).toContain("p.proname ILIKE '%o''rd%' ESCAPE '\\'")
    expect(sql).toContain("n.nspname !~ '^pg_'")
    expect(sql).toContain('NOT c.relispartition')
    expect(sql).toMatch(/LIMIT 25$/)
  })

  it('searches every MySQL database with the default backslash escape', () => {
    const sql = objectSearchSql('mysql', 'a_b')
    // literal() doubles the backslash, which MySQL reads back as one
    expect(sql).toContain("lower(table_name) LIKE '%a\\\\_b%'")
    expect(sql).not.toContain('ESCAPE')
    expect(sql).toContain('table_schema AS db_name')
    expect(sql).toContain('char_length(object_name)')
  })

  it('uses TOP on SQL Server and sqlite_master on SQLite', () => {
    expect(objectSearchSql('tsql', 'x', 10)).toMatch(/^SELECT TOP \(10\)/)
    expect(objectSearchSql('tsql', 'x')).toContain("o.type IN ('U', 'V', 'P'")
    const sqlite = objectSearchSql('sqlite', 'x')
    expect(sqlite).toContain('FROM sqlite_master')
    expect(sqlite).toContain("lower(name) LIKE '%x%' ESCAPE '\\'")
  })

  it('parses hits and skips rows without a name', () => {
    expect(
      parseSearchRows([
        ['shop', null, 'orders', 'table', null],
        [null, 'public', 'f', 'function', 'a integer'],
        [null, null, null, 'table', null]
      ])
    ).toEqual([
      { database: 'shop', schema: null, name: 'orders', kind: 'table', detail: null },
      { database: null, schema: 'public', name: 'f', kind: 'function', detail: 'a integer' }
    ])
  })
})
