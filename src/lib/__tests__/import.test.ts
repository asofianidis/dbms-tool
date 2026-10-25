import { describe, expect, it } from 'vitest'
import {
  autoMap,
  createTableStatements,
  csvDocuments,
  detectFormat,
  documentBatches,
  insertBatches,
  jsonCell,
  JsonNumber,
  mongoValue,
  parseCsv,
  parseFile,
  parseJson,
  profileColumn,
  sqlType,
  tableNameFromPath,
  toCell,
  uniqueColumnNames,
  DEFAULT_CSV
} from '../import'

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded newlines and CRLF', () => {
    const text = 'a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"line\nbreak",\r\n'
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', 'line\nbreak', '']
    ])
  })

  it('strips a BOM and keeps a last record without a newline', () => {
    expect(parseCsv('\ufeffa;b\n1;2', ';')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('reads lone CR line endings and tabs', () => {
    expect(parseCsv('a\tb\r1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('treats quotes literally when quoting is off', () => {
    expect(parseCsv('"a",b', ',', '')).toEqual([['"a"', 'b']])
  })
})

describe('parseFile', () => {
  it('pads ragged CSV rows and names missing headers', () => {
    const parsed = parseFile('id,id,\n1,2,3,4\n5', 'csv', DEFAULT_CSV)
    expect(parsed.columns).toEqual(['id', 'id_2', 'column_3', 'column_4'])
    expect(parsed.rows).toEqual([
      ['1', '2', '3', '4'],
      ['5', '', '', '']
    ])
  })

  it('numbers columns when there is no header', () => {
    const parsed = parseFile('1,2', 'csv', { ...DEFAULT_CSV, header: false })
    expect(parsed.columns).toEqual(['column_1', 'column_2'])
    expect(parsed.rows).toEqual([['1', '2']])
  })

  it('collects JSON keys in order of appearance', () => {
    const parsed = parseFile('[{"a":1,"b":true},{"c":{"x":1},"a":null}]', 'json', DEFAULT_CSV)
    expect(parsed.columns).toEqual(['a', 'b', 'c'])
    expect(parsed.rows).toEqual([
      ['1', true, null],
      [null, null, '{"x":1}']
    ])
    expect(parsed.documents).toHaveLength(2)
  })

  it('reads JSON lines, including mongoexport output saved as .json', () => {
    const text = '{"_id":{"$oid":"abc"}}\n\n{"_id":{"$oid":"def"}}\n'
    expect(parseFile(text, 'jsonl', DEFAULT_CSV).rows).toEqual([['abc'], ['def']])
    expect(parseFile(text, 'json', DEFAULT_CSV).rows).toEqual([['abc'], ['def']])
  })

  it('reports the line of a bad JSON line', () => {
    expect(() => parseFile('{"a":1}\n{oops', 'jsonl', DEFAULT_CSV)).toThrow(/Line 2/)
  })

  it('keeps every digit of JSON numbers', () => {
    const text =
      '[{"id":12345678901234567890,"amount":0.1000000000000000055,"n":7,"big":9007199254740993,"e":1.5e3,"nested":{"x":123456789012345678901234567890}}]'
    const parsed = parseFile(text, 'json', DEFAULT_CSV)
    expect(parsed.rows).toEqual([
      [
        '12345678901234567890',
        '0.1000000000000000055',
        '7',
        '9007199254740993',
        '1.5e3',
        '{"x":123456789012345678901234567890}'
      ]
    ])
    // MongoDB gets Int64 / Decimal128 for integers a double can't hold
    expect(parsed.documents).toEqual([
      {
        id: { $numberDecimal: '12345678901234567890' },
        amount: 0.1,
        n: 7,
        big: { $numberLong: '9007199254740993' },
        e: 1500,
        nested: { x: { $numberDecimal: '123456789012345678901234567890' } }
      }
    ])
  })
})

describe('parseJson', () => {
  it('reads what JSON.parse reads', () => {
    const text =
      ' {"s":"a\\"b\\u00e9\\n","t":true,"f":false,"z":null,"a":[1,-2.5,[]],"o":{},"__proto__":1} '
    const value = parseJson(text) as Record<string, unknown>
    expect(value.s).toBe('a"bé\n')
    expect(value.a).toEqual([new JsonNumber('1'), new JsonNumber('-2.5'), []])
    expect(Object.keys(value)).toEqual(['s', 't', 'f', 'z', 'a', 'o', '__proto__'])
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(mongoValue(value)).toEqual(JSON.parse(text))
  })

  it('rejects malformed JSON', () => {
    for (const bad of ['', '{', '[1,]', '{"a" 1}', '01', '"open', 'tru', '1 2', '"tab\there"'])
      expect(() => parseJson(bad), bad).toThrow(SyntaxError)
  })
})

describe('detectFormat', () => {
  it('follows the extension', () => {
    expect(detectFormat('C:\\data\\x.TSV')).toEqual({ format: 'csv', delimiter: '\t' })
    expect(detectFormat('/x.ndjson').format).toBe('jsonl')
    expect(detectFormat('/x.json').format).toBe('json')
    expect(detectFormat('/x.txt').format).toBe('csv')
  })
})

describe('jsonCell', () => {
  it('unwraps extended JSON', () => {
    expect(jsonCell({ $date: '2024-01-01T00:00:00Z' })).toBe('2024-01-01T00:00:00Z')
    expect(jsonCell({ $numberLong: '9007199254740993' })).toBe('9007199254740993')
    expect(jsonCell({ $date: { $numberLong: '0' } })).toBe('0')
    expect(jsonCell([1, 2])).toBe('[1,2]')
  })
})

describe('type inference', () => {
  const kind = (...values: (string | null)[]): string | null =>
    profileColumn(
      values.map((v) => [v]),
      0
    ).kind

  it('picks the narrowest kind that fits', () => {
    expect(kind('1', '', null, '-3')).toBe('integer')
    expect(kind('1', '3000000000')).toBe('bigint')
    expect(kind('1', '2.50')).toBe('numeric')
    expect(kind('1.5', '1e3')).toBe('float')
    expect(kind('true', 'FALSE')).toBe('boolean')
    expect(kind('2024-01-02', '2024-01-02 10:00')).toBe('timestamp')
    expect(kind('2024-01-02T10:00:00Z')).toBe('timestamptz')
    expect(kind('{"a":1}', '[1]')).toBe('json')
    expect(kind('1', 'abc')).toBe('text')
    expect(kind('', null)).toBeNull()
  })

  it('keeps leading zeros as text', () => {
    expect(kind('02134', '10001')).toBe('text')
  })

  it('maps kinds to dialect types', () => {
    const p = profileColumn([['12.345'], ['1234.5']], 0)
    expect(sqlType('postgres', p)).toBe('numeric')
    expect(sqlType('mysql', p)).toBe('decimal(9,3)')
    expect(sqlType('tsql', p)).toBe('decimal(9,3)')
    expect(sqlType('sqlite', p)).toBe('REAL')
    const long = profileColumn([['x'.repeat(300)]], 0)
    expect(sqlType('tsql', long)).toBe('nvarchar(4000)')
    expect(sqlType('mysql', long)).toBe('text')
    expect(sqlType('postgres', profileColumn([[null]], 0))).toBe('text')
  })
})

describe('names', () => {
  it('derives table names from file names', () => {
    expect(tableNameFromPath('C:\\x\\Sales Report 2024.csv')).toBe('sales_report_2024')
    expect(tableNameFromPath('/x/2024.csv')).toBe('t_2024')
    expect(tableNameFromPath('/x/---.csv')).toBe('imported')
  })

  it('dedupes column names case-insensitively', () => {
    expect(uniqueColumnNames(['A', 'a', ' ', 'a'])).toEqual(['A', 'a_2', 'column_3', 'a_3'])
  })

  it('auto-maps by loose name, once per table column', () => {
    expect(autoMap(['First Name', 'ID', 'id', 'zzz'], ['id', 'first_name'])).toEqual([
      'first_name',
      'id',
      null,
      null
    ])
  })
})

describe('insertBatches', () => {
  const cols = [
    { name: 'id', dataType: 'int' },
    { name: 'name', dataType: 'nvarchar(50)' },
    { name: 'active', dataType: 'bit' }
  ]

  it('builds multi-row inserts with dialect quoting and literals', () => {
    const [batch] = insertBatches(
      'tsql',
      { schema: 'dbo', name: 'people' },
      cols,
      [
        ['1', "O'Brien", 'yes'],
        ['2', '', '0']
      ],
      true
    )
    expect(batch.rows).toBe(2)
    expect(batch.sql).toBe(
      "INSERT INTO [dbo].[people] ([id], [name], [active]) VALUES\n(1, N'O''Brien', 1),\n(2, NULL, 0)"
    )
  })

  it('keeps empty strings when asked', () => {
    const [batch] = insertBatches(
      'postgres',
      { schema: null, name: 't' },
      cols,
      [['1', '', null]],
      false
    )
    expect(batch.sql).toContain("(1, '', NULL)")
  })

  it('splits by row count and statement size', () => {
    const rows = Array.from({ length: 5 }, (_, i) => [String(i), 'x', null])
    const ref = { schema: null, name: 't' }
    expect(
      insertBatches('mysql', ref, cols, rows, true, { maxRows: 2, maxBytes: 1e6 }).map(
        (b) => b.rows
      )
    ).toEqual([2, 2, 1])
    expect(
      insertBatches('mysql', ref, cols, rows, true, { maxRows: 100, maxBytes: 70 }).every(
        (b) => b.rows === 1
      )
    ).toBe(true)
  })

  it('converts boolean words for boolean columns only', () => {
    expect(toCell('yes', 'tinyint(1)', true)).toBe(true)
    expect(toCell('no', 'boolean', true)).toBe(false)
    expect(toCell('yes', 'text', true)).toBe('yes')
    expect(toCell('', 'text', false)).toBe('')
  })

  it('stores inferred SQLite booleans as 1/0', () => {
    const dataType = sqlType('sqlite', profileColumn([['true'], ['FALSE']], 0))
    expect(dataType).toBe('BOOLEAN')
    const [batch] = insertBatches(
      'sqlite',
      { schema: null, name: 't' },
      [{ name: 'flag', dataType }],
      [['true'], ['FALSE'], [true]],
      true
    )
    expect(batch.sql).toBe('INSERT INTO t (flag) VALUES\n(1),\n(0),\n(1)')
  })
})

describe('createTableStatements', () => {
  it('creates a table from inferred columns', () => {
    const [sql] = createTableStatements('postgres', { schema: 'public', name: 'people' }, [
      { name: 'id', dataType: 'integer' },
      { name: 'Full Name', dataType: 'text' }
    ])
    expect(sql).toContain('CREATE TABLE public.people')
    expect(sql).toContain('id integer')
    expect(sql).toContain('"Full Name" text')
  })
})

describe('MongoDB documents', () => {
  it('types CSV values and nests dotted headers', () => {
    const docs = csvDocuments(
      ['name', 'address.city', 'address.zip', 'age', 'vip', 'big', 'note'],
      [['Ann', 'Oslo', '0150', '42', 'true', '9007199254740993', '']],
      true,
      true
    )
    expect(docs).toEqual([
      {
        name: 'Ann',
        address: { city: 'Oslo', zip: '0150' },
        age: 42,
        vip: true,
        big: { $numberLong: '9007199254740993' },
        note: null
      }
    ])
  })

  it('keeps strings when typing is off', () => {
    expect(csvDocuments(['n'], [['42']], false, false)).toEqual([{ n: '42' }])
  })

  it('batches by count and size', () => {
    expect(documentBatches([1, 2, 3, 4, 5], 2).map((b) => b.length)).toEqual([2, 2, 1])
    expect(documentBatches(['aaaa', 'bbbb'], 10, 8).map((b) => b.length)).toEqual([1, 1])
  })
})
