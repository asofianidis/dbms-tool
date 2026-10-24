import { describe, expect, it } from 'vitest'
import {
  fieldPaths,
  parsePipeline,
  formBody,
  stageForm,
  valueFromText,
  valueToText,
  type StageForm
} from '../aggregation'
import { parseShellValue } from '../ejson'

/** Body text → form → body, which must come back unchanged. */
function roundTrip(operator: string, text: string): StageForm {
  const body = parseShellValue(text)
  const form = stageForm(operator, body)
  expect(form).not.toBeNull()
  expect(formBody(form!)).toEqual(body)
  return form!
}

describe('form values', () => {
  it('reads literals and keeps everything else a string', () => {
    expect(valueFromText('42')).toBe(42)
    expect(valueFromText('true')).toBe(true)
    expect(valueFromText('active')).toBe('active')
    expect(valueFromText('$price')).toBe('$price')
    expect(valueFromText("ObjectId('65f0a1b2c3d4e5f6a7b8c9d0')")).toEqual({
      $oid: '65f0a1b2c3d4e5f6a7b8c9d0'
    })
    expect(valueFromText('/usr/bin')).toBe('/usr/bin')
  })

  it('quotes strings that would read back as another type', () => {
    expect(valueToText('active')).toBe('active')
    expect(valueToText('42')).toBe('"42"')
    expect(valueToText('null')).toBe('"null"')
    expect(valueFromText(valueToText('42'))).toBe('42')
    expect(valueToText(7)).toBe('7')
  })
})

describe('stageForm', () => {
  it('round-trips $match conditions', () => {
    const form = roundTrip('$match', "{ status: 'active', age: { $gte: 18, $lt: 65 } }")
    expect(form).toMatchObject({
      combine: 'and',
      conditions: [
        { field: 'status', op: 'eq', value: 'active' },
        { field: 'age', op: 'gte', value: '18' },
        { field: 'age', op: 'lt', value: '65' }
      ]
    })
    roundTrip('$match', "{ $or: [{ a: 1 }, { b: { $in: ['x', 'y'] } }] }")
    roundTrip('$match', "{ name: { $regex: '^jo', $options: 'i' }, deleted: { $exists: false } }")
  })

  it('refuses $match shapes it cannot show', () => {
    expect(stageForm('$match', parseShellValue('{ $expr: { $gt: ["$a", "$b"] } }'))).toBeNull()
    expect(stageForm('$match', parseShellValue('{ $or: [{ a: 1, b: 2 }, { c: 3 }] }'))).toBeNull()
    expect(stageForm('$match', parseShellValue('{ tags: { $elemMatch: { a: 1 } } }'))).toBeNull()
  })

  it('writes repeated operators on one field as $and', () => {
    const body = formBody({
      kind: 'match',
      combine: 'and',
      conditions: [
        { field: 'n', op: 'ne', value: '1' },
        { field: 'n', op: 'ne', value: '2' }
      ]
    })
    expect(body).toEqual({ $and: [{ n: { $ne: 1 } }, { n: { $ne: 2 } }] })
  })

  it('round-trips $group keys and accumulators', () => {
    const form = roundTrip(
      '$group',
      "{ _id: '$status', count: { $sum: 1 }, avg: { $avg: '$total' } }"
    )
    expect(form).toMatchObject({ keys: [{ alias: '', field: 'status' }] })
    roundTrip('$group', "{ _id: { y: '$year', m: '$month' }, n: { $count: {} } }")
    roundTrip('$group', '{ _id: null, total: { $sum: "$amount" } }')
    expect(stageForm('$group', parseShellValue("{ _id: { $year: '$at' } }"))).toBeNull()
  })

  it('round-trips the simple stages', () => {
    roundTrip('$project', "{ _id: 0, name: 1, upper: { $toUpper: '$name' } }")
    roundTrip('$sort', '{ count: -1, name: 1 }')
    roundTrip('$limit', '20')
    roundTrip('$sample', '{ size: 10 }')
    roundTrip('$unwind', "'$items'")
    roundTrip('$unwind', "{ path: '$items', preserveNullAndEmptyArrays: true }")
    roundTrip('$unset', "['a', 'b']")
    roundTrip('$count', "'total'")
    roundTrip('$sortByCount', "'$status'")
    roundTrip('$lookup', "{ from: 'users', localField: 'userId', foreignField: '_id', as: 'user' }")
    expect(stageForm('$sort', parseShellValue("{ score: { $meta: 'textScore' } }"))).toBeNull()
  })
})

describe('fieldPaths', () => {
  it('lists nested paths with _id first and skips EJSON wrappers', () => {
    const docs = [
      { _id: { $oid: '65f0a1b2c3d4e5f6a7b8c9d0' }, name: 'a', address: { city: 'x' } },
      { items: [{ sku: 1 }], at: { $date: '2024-01-01T00:00:00Z' } }
    ]
    expect(fieldPaths(docs)).toEqual([
      '_id',
      'address',
      'address.city',
      'at',
      'items',
      'items.sku',
      'name'
    ])
  })
})

describe('parsePipeline', () => {
  it('reads a shell aggregate call', () => {
    expect(parsePipeline('db.orders.aggregate([{ $match: { a: 1 } }, { $limit: 5 }])')).toEqual([
      { operator: '$match', body: '{ a: 1 }' },
      { operator: '$limit', body: '5' }
    ])
    expect(() => parsePipeline('[{ a: 1 }]')).toThrow(/Stage 1/)
  })
})
