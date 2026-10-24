import { describe, expect, it } from 'vitest'
import type { Cell, ColumnMeta } from '../api'
import { serialize, toTsv } from '../export'

const columns: ColumnMeta[] = [
  { name: 'id', typeName: 'int4' },
  { name: 'note', typeName: 'text' }
]

describe('serialize', () => {
  const rows: Cell[][] = [
    ['1', null],
    ['2', ''],
    ['3', 'a,b'],
    ['4', 'say "hi"']
  ]

  it('writes NULL as an empty field and an empty string as "" in CSV', () => {
    expect(serialize('csv', columns, rows).split('\r\n')).toEqual([
      'id,note',
      '1,',
      '2,""',
      '3,"a,b"',
      '4,"say ""hi"""'
    ])
  })

  it('follows the same rule for TSV and clipboard TSV', () => {
    expect(serialize('tsv', columns, rows.slice(0, 2))).toBe('id\tnote\r\n1\t\r\n2\t""')
    expect(toTsv(columns, rows.slice(0, 2))).toBe('1\t\r\n2\t""')
  })

  it('keeps null in JSON and shows NULL in Markdown', () => {
    expect(JSON.parse(serialize('json', columns, rows.slice(0, 2)))).toEqual([
      { id: '1', note: null },
      { id: '2', note: '' }
    ])
    expect(
      serialize('markdown', columns, [
        ['1', null],
        ['2', 'a|b']
      ]).split('\n')
    ).toEqual(['| id | note |', '| --- | --- |', '| 1 | NULL |', '| 2 | a\\|b |'])
  })

  it('writes NULL as NULL in SQL', () => {
    expect(serialize('sql', columns, [['1', null]], { table: 't' })).toBe(
      'INSERT INTO t (id, note) VALUES (1, NULL);'
    )
  })
})
