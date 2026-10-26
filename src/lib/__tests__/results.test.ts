import { describe, expect, it } from 'vitest'
import type { ColumnMeta, CompletionTable } from '../api'
import {
  binaryExtension,
  hexLines,
  imageType,
  isBinaryColumn,
  parseBinary,
  utf8Text
} from '../binary'
import { displayTimestamp, type TimeDisplay } from '../datetime'
import { columnFilter, columnKeys, moveColumn, viewColumns, emptyLayout } from '../grid-layout'
import { diffResults } from '../result-diff'
import { isReadOnlyQuery, resolveTable, singleTableSource } from '../result-source'
import { allSnippets, snippetFields, BUILTIN_SNIPPETS } from '../snippets'

const cols = (...names: string[]): ColumnMeta[] => names.map((name) => ({ name, typeName: '' }))

describe('timestamps in a time zone', () => {
  const utc: TimeDisplay = { timeZone: 'UTC', assumeUtc: false, format: 'iso' }

  it('converts values that carry an offset, keeping their precision', () => {
    expect(displayTimestamp('2024-03-01 12:30:00.123456+02', 'timestamptz', utc)).toBe(
      '2024-03-01 10:30:00.123456 +00:00'
    )
    expect(displayTimestamp('2024-03-01 12:30:00 +05:30', 'datetimeoffset', utc)).toBe(
      '2024-03-01 07:00:00 +00:00'
    )
    expect(
      displayTimestamp('2024-07-01 12:00:00Z', 'timestamptz', { ...utc, timeZone: 'Europe/Berlin' })
    ).toBe('2024-07-01 14:00:00 +02:00')
  })

  it('leaves zone-less values alone unless told they are UTC', () => {
    expect(displayTimestamp('2024-03-01 12:30:00', 'timestamp', utc)).toBeNull()
    expect(
      displayTimestamp('2024-03-01 12:30:00', 'datetime', {
        ...utc,
        timeZone: 'Asia/Tokyo',
        assumeUtc: true
      })
    ).toBe('2024-03-01 21:30:00 +09:00')
  })

  it('ignores text columns and an unset zone', () => {
    expect(displayTimestamp('2024-03-01 12:30:00+00', 'text', utc)).toBeNull()
    expect(
      displayTimestamp('2024-03-01 12:30:00+00', 'timestamptz', { ...utc, timeZone: '' })
    ).toBeNull()
  })
})

describe('binary values', () => {
  it('parses driver and PostgreSQL hex, noting cut-short values', () => {
    expect(parseBinary('0x89504E47')).toEqual({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      total: 4,
      truncated: false
    })
    expect(parseBinary('\\xdeadbeef')?.bytes.length).toBe(4)
    const cut = parseBinary('0xFFD8FF… (90000 bytes)')
    expect(cut).toMatchObject({ total: 90000, truncated: true })
    expect(parseBinary('0xABC')).toBeNull()
    expect(parseBinary('hello')).toBeNull()
  })

  it('recognizes binary columns and images', () => {
    expect(isBinaryColumn('bytea')).toBe(true)
    expect(isBinaryColumn('varbinary(max)')).toBe(true)
    expect(isBinaryColumn('text')).toBe(false)
    expect(isBinaryColumn('', '0x0102030405')).toBe(true)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
    expect(imageType(png)).toBe('image/png')
    expect(binaryExtension(png)).toBe('png')
    expect(imageType(new TextEncoder().encode('<?xml version="1.0"?><svg width="1">'))).toBe(
      'image/svg+xml'
    )
    const svg = (s: string) => imageType(new TextEncoder().encode(s))
    expect(svg('<!-- a --> <!-- b ---><svg>')).toBe('image/svg+xml')
    // Linear on runs of comment delimiters (was exponential)
    expect(svg(`<!--${'--><!--'.repeat(60)}x`)).toBeNull()
    expect(binaryExtension(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe('pdf')
    expect(binaryExtension(new Uint8Array([1, 2, 3]))).toBe('bin')
  })

  it('dumps hex with offsets and printable text', () => {
    const bytes = new TextEncoder().encode('Hello, world!\n\u0001xyz')
    const [first, second] = hexLines(bytes)
    expect(first.offset).toBe('00000000')
    expect(first.hex).toBe('48 65 6c 6c 6f 2c 20 77  6f 72 6c 64 21 0a 01 78')
    expect(first.ascii).toBe('Hello, world!..x')
    expect(second).toEqual({ offset: '00000010', hex: '79 7a', ascii: 'yz' })
    expect(utf8Text(new TextEncoder().encode('plain text'))).toBe('plain text')
    expect(utf8Text(new Uint8Array([0xff, 0xfe]))).toBeNull()
  })
})

describe('grid column layout', () => {
  it('keys repeated column names apart', () => {
    expect(columnKeys(cols('id', 'name', 'id'))).toEqual(['id', 'name', 'id#2'])
  })

  it('applies a saved order and hidden columns, placing new columns naturally', () => {
    const keys = ['a', 'b', 'c', 'd']
    expect(viewColumns(keys, undefined)).toEqual([0, 1, 2, 3])
    const layout = { ...emptyLayout(), order: ['c', 'a', 'gone'], hidden: ['d'] }
    // b follows a (its data neighbour); d is hidden
    expect(viewColumns(keys, layout)).toEqual([2, 0, 1])
  })

  it('moves a column between view positions', () => {
    const keys = ['a', 'b', 'c']
    expect(moveColumn(keys, [0, 1, 2], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveColumn(keys, [0, 2], 1, 0)).toEqual(['c', 'a', 'b'])
  })

  it('filters columns by text, comparisons and nulls', () => {
    const contains = columnFilter('ann', false)!
    expect(contains('Joanna')).toBe(true)
    expect(contains(null)).toBe(false)
    expect(columnFilter('', false)).toBeNull()
    expect(columnFilter('>10', true)!('11')).toBe(true)
    expect(columnFilter('>10', true)!('9')).toBe(false)
    expect(columnFilter('<=b', false)!('a')).toBe(true)
    expect(columnFilter('=Ann', false)!('ann')).toBe(true)
    expect(columnFilter('=Ann', false)!('Joanna')).toBe(false)
    expect(columnFilter('!=x', false)!('y')).toBe(true)
    expect(columnFilter('!ann', false)!('Joanna')).toBe(false)
    expect(columnFilter('null', false)!(null)).toBe(true)
    expect(columnFilter('!null', false)!(null)).toBe(false)
  })
})

describe('comparing results', () => {
  const before = {
    columns: cols('id', 'name'),
    rows: [
      ['1', 'a'],
      ['2', 'b'],
      ['3', 'c']
    ]
  }
  const after = {
    columns: cols('id', 'name', 'extra'),
    rows: [
      ['1', 'a', 'x'],
      ['2', 'B', null],
      ['4', 'd', null]
    ]
  }

  it('matches whole rows without a key', () => {
    const d = diffResults(
      { columns: cols('id'), rows: [['1'], ['1'], ['2']] },
      { columns: cols('id'), rows: [['1'], ['3']] }
    )
    expect(d.status).toEqual([undefined, 'added', 'removed', 'removed'])
    expect(d.counts).toEqual({ added: 1, removed: 2, changed: 0, same: 1 })
  })

  it('compares rows with the same key cell by cell', () => {
    const d = diffResults(before, after, ['id'])
    expect(d.columns.map((c) => c.name)).toEqual(['id', 'name', 'extra'])
    expect(d.status).toEqual(['changed', 'changed', 'added', 'removed'])
    // Row 1 gained `extra`; row 2 changed its name
    expect([...d.changed].sort()).toEqual(['0:2', '1:1'])
    expect(d.rows[3]).toEqual(['3', 'c', null])
  })
})

describe('where a result comes from', () => {
  it('knows which scripts only read', () => {
    expect(isReadOnlyQuery('SELECT * FROM t; SELECT 1', 'postgres')).toBe(true)
    expect(isReadOnlyQuery('WITH x AS (SELECT 1) SELECT * FROM x', 'postgres')).toBe(true)
    expect(isReadOnlyQuery("SELECT 'delete me' FROM t", 'postgres')).toBe(true)
    expect(
      isReadOnlyQuery('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgres')
    ).toBe(false)
    expect(isReadOnlyQuery('SELECT * INTO copy FROM t', 'tsql')).toBe(false)
    expect(isReadOnlyQuery('UPDATE t SET a = 1', 'mysql')).toBe(false)
    expect(isReadOnlyQuery('SELECT * FROM t FOR UPDATE', 'postgres')).toBe(true)
    expect(isReadOnlyQuery('', 'postgres')).toBe(false)
  })

  it('finds the one table a plain SELECT reads', () => {
    expect(
      singleTableSource('SELECT * FROM public.users u WHERE u.id > 3 ORDER BY 1', 'postgres')
    ).toEqual({
      parts: ['public', 'users'],
      alias: 'u',
      star: true,
      columns: new Set()
    })
    const named = singleTableSource(
      'select u.id, name, upper(email) as email, x.y from Users as u',
      'postgres'
    )
    expect(named?.parts).toEqual(['users'])
    expect([...named!.columns]).toEqual(['id', 'name'])
    expect(
      singleTableSource('SELECT TOP (10) [Id], [Name] FROM [dbo].[Users]', 'tsql')
    ).toMatchObject({
      parts: ['dbo', 'Users'],
      columns: new Set(['Id', 'Name'])
    })
    expect(singleTableSource('SELECT * FROM users LIMIT 5;', 'mysql')?.parts).toEqual(['users'])
  })

  it('refuses joins, grouping, subqueries and scripts', () => {
    for (const sql of [
      'SELECT * FROM a JOIN b ON a.id = b.a_id',
      'SELECT * FROM a, b',
      'SELECT kind, count(*) FROM a GROUP BY kind',
      'SELECT DISTINCT kind FROM a',
      'SELECT * FROM (SELECT 1) x',
      'SELECT * FROM a; SELECT * FROM b',
      'SELECT * FROM a UNION SELECT * FROM b',
      'DELETE FROM a'
    ])
      expect(singleTableSource(sql, 'postgres'), sql).toBeNull()
  })

  it('resolves names against the completion list', () => {
    const tables: CompletionTable[] = [
      { schema: 'public', name: 'users', columns: [], foreignKeys: [] },
      { schema: 'audit', name: 'users', columns: [], foreignKeys: [] },
      { schema: 'dbo', name: 'Orders', columns: [], foreignKeys: [] }
    ]
    expect(resolveTable(['users'], tables, 'public', 'postgres')?.schema).toBe('public')
    expect(resolveTable(['audit', 'users'], tables, 'public', 'postgres')?.schema).toBe('audit')
    expect(resolveTable(['users'], tables, undefined, 'postgres')).toBeNull()
    expect(resolveTable(['orders'], tables, 'dbo', 'tsql')?.name).toBe('Orders')
  })

  it("doesn't guess a table a temporary one shadows", () => {
    const tables: CompletionTable[] = [
      { schema: 'public', name: 'users', columns: [], foreignKeys: [] },
      { schema: 'pg_temp_3', name: 'users', columns: [], foreignKeys: [] },
      { schema: 'public', name: 'orders', columns: [], foreignKeys: [] }
    ]
    expect(resolveTable(['users'], tables, 'public', 'postgres')).toBeNull()
    expect(resolveTable(['public', 'users'], tables, 'public', 'postgres')?.schema).toBe('public')
    // A name in one schema needs no default
    expect(resolveTable(['orders'], tables, undefined, 'postgres')?.schema).toBe('public')
  })
})

describe('snippets', () => {
  it('overlays edited and hidden built-ins and appends own snippets', () => {
    const own = { id: 'u1', prefix: 'mine', description: '', body: 'SELECT 1' }
    const edited = { ...BUILTIN_SNIPPETS[0], body: 'SELECT 2' }
    const hidden = { ...BUILTIN_SNIPPETS[1], hidden: true }
    const list = allSnippets([own, edited, hidden])
    expect(list[0].body).toBe('SELECT 2')
    expect(list.some((s) => s.id === hidden.id)).toBe(false)
    expect(list[list.length - 1]).toBe(own)
    expect(allSnippets([hidden], true).some((s) => s.id === hidden.id)).toBe(true)
  })

  it('lists placeholder names once each', () => {
    expect(snippetFields('SELECT ${col}, count(*) FROM ${table} GROUP BY ${col}${}')).toEqual([
      'col',
      'table'
    ])
  })
})
