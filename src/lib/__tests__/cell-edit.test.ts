import { describe, expect, it } from 'vitest'
import {
  cellEditorKind,
  formatPgArray,
  isValidJson,
  mergePicked,
  parsePgArray,
  pickerValue,
  respaceJson
} from '../cell-edit'

describe('cellEditorKind', () => {
  it('picks an editor from the column type', () => {
    expect(cellEditorKind('postgres', '_int4')).toBe('array')
    expect(cellEditorKind('postgres', 'text[]')).toBe('array')
    expect(cellEditorKind('postgres', '_box')).toBe('text')
    expect(cellEditorKind('mysql', '_int4')).toBe('text')
    expect(cellEditorKind('postgres', 'jsonb')).toBe('json')
    expect(cellEditorKind('mysql', 'json')).toBe('json')
    expect(cellEditorKind('postgres', 'date')).toBe('date')
    expect(cellEditorKind('postgres', 'timestamptz')).toBe('datetime')
    expect(cellEditorKind('tsql', 'datetimeoffset')).toBe('datetime')
    expect(cellEditorKind('mysql', 'datetime')).toBe('datetime')
    expect(cellEditorKind('postgres', 'timetz')).toBe('time')
    expect(cellEditorKind('postgres', 'interval')).toBe('text')
    expect(cellEditorKind('sqlite', '')).toBe('text')
  })
})

describe('PostgreSQL arrays', () => {
  it('parses one-dimensional literals', () => {
    expect(parsePgArray('{}')).toEqual([])
    expect(parsePgArray('{1,2,3}')).toEqual(['1', '2', '3'])
    expect(parsePgArray('{a,"b c",NULL,"NULL",""}')).toEqual(['a', 'b c', null, 'NULL', ''])
    expect(parsePgArray('{"say \\"hi\\"","back\\\\slash"}')).toEqual(['say "hi"', 'back\\slash'])
    expect(parsePgArray('{ x , y }')).toEqual(['x', 'y'])
  })

  it('refuses what it cannot edit as a list', () => {
    expect(parsePgArray('{{1,2},{3,4}}')).toBeNull()
    expect(parsePgArray('[0:1]={1,2}')).toBeNull()
    expect(parsePgArray('{1,,2}')).toBeNull()
    expect(parsePgArray('{"open}')).toBeNull()
    expect(parsePgArray('plain')).toBeNull()
  })

  it('formats with quoting only where needed', () => {
    expect(formatPgArray([])).toBe('{}')
    expect(formatPgArray(['1', '2'])).toBe('{1,2}')
    expect(formatPgArray(['a b', null, 'null', '', 'x,y', 'q"\\'])).toBe(
      '{"a b",NULL,"null","","x,y","q\\"\\\\"}'
    )
  })

  it('round-trips', () => {
    const items = ['plain', 'with space', null, 'NULL', '', '{brace}', 'q"uote', 'back\\']
    expect(parsePgArray(formatPgArray(items))).toEqual(items)
  })
})

describe('JSON', () => {
  it('validates', () => {
    expect(isValidJson('{"a":1}')).toBe(true)
    expect(isValidJson('{a:1}')).toBe(false)
  })

  it('re-spaces without changing values', () => {
    const text = '{"id": 12345678901234567890, "s": "a, b: {c}", "e": [], "o": {}, "l": [1,2]}'
    expect(respaceJson(text, 0)).toBe(
      '{"id":12345678901234567890,"s":"a, b: {c}","e":[],"o":{},"l":[1,2]}'
    )
    expect(respaceJson(text, 2)).toBe(
      '{\n  "id": 12345678901234567890,\n  "s": "a, b: {c}",\n  "e": [],\n  "o": {},\n  "l": [\n    1,\n    2\n  ]\n}'
    )
    expect(respaceJson('"esc \\" quote"', 2)).toBe('"esc \\" quote"')
  })
})

describe('date pickers', () => {
  it('reads the picker value', () => {
    expect(pickerValue('2024-03-05', 'date')).toBe('2024-03-05')
    expect(pickerValue('2024-03-05 10:20:30.123+02', 'datetime')).toBe('2024-03-05T10:20:30')
    expect(pickerValue('2024-03-05 10:20', 'datetime')).toBe('2024-03-05T10:20:00')
    expect(pickerValue('10:20:30+02', 'time')).toBe('10:20:30')
    expect(pickerValue('infinity', 'datetime')).toBe('')
  })

  it('merges a pick, keeping fractions and offsets', () => {
    expect(mergePicked('2024-03-05', '2025-01-02', 'date')).toBe('2025-01-02')
    expect(mergePicked('2024-03-05 10:20:30.123+02', '2025-01-02T08:00', 'datetime')).toBe(
      '2025-01-02 08:00:00.123+02'
    )
    expect(mergePicked('', '2025-01-02T08:00:05', 'datetime')).toBe('2025-01-02 08:00:05')
    expect(mergePicked('10:20:30.5+02', '11:00', 'time')).toBe('11:00:00.5+02')
    expect(mergePicked('anything', '', 'date')).toBe('anything')
  })
})
