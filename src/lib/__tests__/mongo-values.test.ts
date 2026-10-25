import { describe, expect, it } from 'vitest'
import { newCondition, type QueryState } from '../filters'
import { parseShellValue, sameEjson, toShell } from '../ejson'
import { buildMongoFilter } from '../mongo-filters'

const roundTrip = (v: unknown): unknown => parseShellValue(toShell(v))

describe('EJSON number round trips', () => {
  it('keeps whole-number doubles as doubles', () => {
    expect(toShell({ $numberDouble: '3.0' })).toBe('Double(3)')
    expect(roundTrip({ $numberDouble: '3.0' })).toEqual({ $numberDouble: '3.0' })
    expect(roundTrip({ $numberDouble: '-2147483649.0' })).toEqual({
      $numberDouble: '-2147483649.0'
    })
    expect(roundTrip({ $numberDouble: '1000000000000000000000.0' })).toEqual({
      $numberDouble: '1e+21'
    })
    expect(roundTrip({ $numberDouble: '-0.0' })).toEqual({ $numberDouble: '-0.0' })
    expect(roundTrip({ $numberDouble: 'NaN' })).toEqual({ $numberDouble: 'NaN' })
    expect(roundTrip(1.5)).toBe(1.5)
  })

  it('keeps the whole Int32 range as Int32', () => {
    expect(parseShellValue('-2147483648')).toBe(-2147483648)
    expect(parseShellValue('2147483647')).toBe(2147483647)
    expect(parseShellValue('-2147483649')).toEqual({ $numberLong: '-2147483649' })
    expect(parseShellValue('2147483648')).toEqual({ $numberLong: '2147483648' })
  })
})

describe('ISODate', () => {
  it('reads times without a zone as UTC, like mongosh', () => {
    expect(parseShellValue("ISODate('2024-01-15T10:00:00')")).toEqual({
      $date: '2024-01-15T10:00:00.000Z'
    })
    expect(parseShellValue("ISODate('2024-01-15 10:00')")).toEqual({
      $date: '2024-01-15T10:00:00.000Z'
    })
    expect(parseShellValue("ISODate('2024-01-15T10:00:00+02:00')")).toEqual({
      $date: '2024-01-15T08:00:00.000Z'
    })
  })
})

describe('sameEjson', () => {
  it('compares dates by instant and numbers by type and value', () => {
    expect(
      sameEjson(
        { $date: '2024-01-02T03:04:05Z' },
        parseShellValue(toShell({ $date: '2024-01-02T03:04:05Z' }))
      )
    ).toBe(true)
    expect(
      sameEjson({ $date: { $numberLong: '1704164645000' } }, { $date: '2024-01-02T03:04:05.000Z' })
    ).toBe(true)
    expect(
      sameEjson(
        { d: { $date: '2024-01-02T03:04:05Z' }, n: 1 },
        { d: { $date: '2024-01-02T03:04:06Z' }, n: 1 }
      )
    ).toBe(false)
    expect(sameEjson({ $numberInt: '5' }, 5)).toBe(true)
    expect(sameEjson({ $numberDouble: '5.0' }, { $numberDouble: '5' })).toBe(true)
    expect(sameEjson({ $numberLong: '5' }, 5)).toBe(false)
    expect(sameEjson({ $numberDouble: '5.0' }, 5)).toBe(false)
    expect(sameEjson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false)
  })
})

describe('buildMongoFilter keeps BSON number types', () => {
  const types = { price: 'Decimal128', big: 'Int64', ts: 'Timestamp', at: 'Date', n: 'Int32' }
  const one = (patch: Parameters<typeof newCondition>[0]): unknown =>
    buildMongoFilter(
      { match: 'all', conditions: [newCondition(patch)], sorts: [] } as unknown as QueryState,
      types
    )

  it('emits Decimal128, Int64 and Timestamp values', () => {
    expect(one({ column: 'price', op: 'eq', value: '1.10' })).toEqual({
      price: { $numberDecimal: '1.10' }
    })
    expect(one({ column: 'big', op: 'eq', value: '9007199254740993' })).toEqual({
      big: { $numberLong: '9007199254740993' }
    })
    expect(one({ column: 'big', op: 'gt', value: '1.5' })).toEqual({ big: { $gt: 1.5 } })
    expect(one({ column: 'n', op: 'eq', value: '7' })).toEqual({ n: 7 })
    expect(one({ column: 'ts', op: 'gte', value: '2024-01-01T00:00:00Z' })).toEqual({
      ts: { $gte: { $timestamp: { t: 1704067200, i: 0 } } }
    })
    expect(one({ column: 'ts', op: 'eq', value: 'Timestamp(1704067200, 3)' })).toEqual({
      ts: { $timestamp: { t: 1704067200, i: 3 } }
    })
    expect(one({ column: 'ts', op: 'lt', value: '1704067200' })).toEqual({
      ts: { $lt: { $timestamp: { t: 1704067200, i: 0 } } }
    })
  })

  it('reads zone-less dates as UTC', () => {
    expect(one({ column: 'at', op: 'lt', value: '2024-01-15T10:00:00' })).toEqual({
      at: { $lt: { $date: '2024-01-15T10:00:00.000Z' } }
    })
  })
})
