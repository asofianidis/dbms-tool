import { describe, expect, it } from 'vitest'
import { newCondition, type QueryState } from '../filters'
import {
  andFilters,
  bsonKind,
  buildMongoFilter,
  buildMongoSort,
  describeMongoQuery,
  sampleFields
} from '../mongo-filters'

const query = (patch: Partial<QueryState>): QueryState => ({
  match: 'all',
  conditions: [],
  sorts: [],
  ...patch
})

describe('sampleFields', () => {
  it('collects dotted paths with their most common type', () => {
    const fields = sampleFields([
      { _id: { $oid: '0123456789abcdef01234567' }, age: 3, address: { city: 'Oslo' } },
      { age: 4.5, items: [{ sku: 'a' }] },
      { age: 7, note: null }
    ])
    expect(fields).toEqual({
      _id: 'ObjectId',
      age: 'Int32',
      address: 'Object',
      'address.city': 'String',
      items: 'Array',
      'items.sku': 'String',
      note: ''
    })
    expect(bsonKind('Int64')).toBe('number')
    expect(bsonKind('ObjectId')).toBe('other')
  })
})

describe('buildMongoFilter', () => {
  const types = { age: 'Int32', name: 'String', _id: 'ObjectId', created: 'Date', ok: 'Boolean' }
  const one = (patch: Parameters<typeof newCondition>[0]): unknown =>
    buildMongoFilter(query({ conditions: [newCondition(patch)] }), types)

  it('types values by the field', () => {
    expect(one({ column: 'age', op: 'gte', value: '21' })).toEqual({ age: { $gte: 21 } })
    expect(one({ column: 'name', op: 'eq', value: '21' })).toEqual({ name: '21' })
    expect(one({ column: '_id', op: 'eq', value: '0123456789ABCDEF01234567' })).toEqual({
      _id: { $oid: '0123456789abcdef01234567' }
    })
    expect(one({ column: 'created', op: 'lt', value: '2024-01-31' })).toEqual({
      created: { $lt: { $date: '2024-01-31T00:00:00.000Z' } }
    })
    expect(one({ column: 'ok', op: 'false' })).toEqual({ ok: false })
    // Shell literals work on fields of unknown type
    expect(
      one({ column: 'other', op: 'eq', value: "ObjectId('0123456789abcdef01234567')" })
    ).toEqual({ other: { $oid: '0123456789abcdef01234567' } })
    expect(one({ column: 'other', op: 'eq', value: 'plain' })).toEqual({ other: 'plain' })
  })

  it('matches text with escaped, case-insensitive regexes', () => {
    expect(one({ column: 'name', op: 'contains', value: 'a.b' })).toEqual({
      name: { $regularExpression: { pattern: 'a\\.b', options: 'i' } }
    })
    expect(one({ column: 'name', op: 'not_contains', value: 'x' })).toEqual({
      name: { $not: { $regularExpression: { pattern: 'x', options: 'i' } } }
    })
    expect(one({ column: 'name', op: 'starts', value: 'Jo' })).toEqual({
      name: { $regularExpression: { pattern: '^Jo', options: 'i' } }
    })
  })

  it('handles lists, ranges and nulls', () => {
    expect(one({ column: 'age', op: 'in', value: '1, 2,,3' })).toEqual({ age: { $in: [1, 2, 3] } })
    expect(one({ column: 'age', op: 'not_in', value: ' ' })).toBeNull()
    expect(one({ column: 'age', op: 'between', value: '1', value2: '9' })).toEqual({
      age: { $gte: 1, $lte: 9 }
    })
    expect(one({ column: 'age', op: 'between', value: '1' })).toBeNull()
    expect(one({ column: 'age', op: 'null' })).toEqual({ age: null })
    expect(one({ column: 'age', op: 'not_null' })).toEqual({ age: { $ne: null } })
    expect(one({ column: 'name', op: 'eq', value: '' })).toEqual({ name: '' })
    expect(one({ column: 'age', op: 'eq', value: '' })).toBeNull()
  })

  it('combines conditions and raw filter documents', () => {
    const conditions = [
      newCondition({ column: 'age', op: 'gt', value: '1' }),
      newCondition({ kind: 'sql', sql: '{ tags: { $size: 2 } }' }),
      newCondition({ column: 'name', op: 'eq', value: 'x', enabled: false })
    ]
    expect(buildMongoFilter(query({ conditions }), types)).toEqual({
      $and: [{ age: { $gt: 1 } }, { tags: { $size: 2 } }]
    })
    expect(buildMongoFilter(query({ match: 'any', conditions }), types)).toEqual({
      $or: [{ age: { $gt: 1 } }, { tags: { $size: 2 } }]
    })
    expect(buildMongoFilter(query({}))).toBeNull()
    expect(() =>
      buildMongoFilter(query({ conditions: [newCondition({ kind: 'sql', sql: '5' })] }))
    ).toThrow(/Not a filter document/)
    expect(andFilters({ a: 1 }, null, {})).toEqual({ a: 1 })
    expect(andFilters({ a: 1 }, { b: 2 })).toEqual({ $and: [{ a: 1 }, { b: 2 }] })
    expect(andFilters()).toEqual({})
  })
})

describe('buildMongoSort', () => {
  it('keeps key order and skips blank fields', () => {
    const sort = buildMongoSort([
      { column: 'b', dir: 'desc' },
      { column: ' ', dir: 'asc' },
      { column: 'a.c', dir: 'asc' }
    ])
    expect(Object.entries(sort!)).toEqual([
      ['b', -1],
      ['a.c', 1]
    ])
    expect(buildMongoSort([])).toBeNull()
  })

  it('describes the query in shell syntax', () => {
    const q = query({
      conditions: [newCondition({ column: 'age', op: 'gte', value: '2' })],
      sorts: [{ column: 'age', dir: 'desc' }]
    })
    expect(describeMongoQuery(q, { age: 'Int32' })).toMatch(
      /^find\(\{.*age.*\$gte.*2.*\}\)\n\.sort\(/
    )
    expect(describeMongoQuery(query({}))).toBe('// no filter')
  })
})
