import { describe, expect, it } from 'vitest'
import { compareCells, compareNumericText } from '../../components/grid/ResultGrid'

describe('numeric sort', () => {
  const sorted = (values: string[]): string[] => [...values].sort(compareNumericText)

  it('orders big integers exactly', () => {
    expect(sorted(['9007199254740993', '9007199254740992', '-9007199254740993', '0'])).toEqual([
      '-9007199254740993',
      '0',
      '9007199254740992',
      '9007199254740993'
    ])
    expect(compareNumericText('12345678901234567891', '12345678901234567890')).toBeGreaterThan(0)
  })

  it('orders high-precision decimals exactly', () => {
    expect(compareNumericText('0.10000000000000000001', '0.1')).toBeGreaterThan(0)
    expect(compareNumericText('-0.10000000000000000001', '-0.1')).toBeLessThan(0)
    expect(compareNumericText('1.50', '1.5')).toBe(0)
    expect(compareNumericText('007', '7')).toBe(0)
    expect(compareNumericText('-0', '0.000')).toBe(0)
    expect(sorted(['10', '9.99', '-1.5', '-10', '0.5'])).toEqual([
      '-10',
      '-1.5',
      '0.5',
      '9.99',
      '10'
    ])
  })

  it('falls back to doubles for exponent forms', () => {
    expect(compareNumericText('1e3', '999')).toBeGreaterThan(0)
    expect(compareNumericText('2.5E-1', '0.3')).toBeLessThan(0)
  })

  it('keeps NULLs last', () => {
    expect(compareCells(null, '1', true)).toBe(1)
    expect(compareCells('1', null, true)).toBe(-1)
    expect(compareCells(null, null, true)).toBe(0)
  })
})
