import { afterEach, describe, expect, it } from 'vitest'
import { parseShellValue, toShell } from '../ejson'

type Flagged = typeof globalThis & { __pwned?: boolean }
const PAYLOAD = '(globalThis.__pwned = true)'

function roundTrip(value: unknown): unknown {
  return parseShellValue(toShell(value))
}

/** Evaluates `toShell(doc)` and reports whether any injected code ran. */
function ranCode(doc: unknown): boolean {
  try {
    roundTrip(doc)
  } catch {
    // A rejected value is fine; only executing the payload is not
  }
  return (globalThis as Flagged).__pwned === true
}

afterEach(() => {
  delete (globalThis as Flagged).__pwned
})

describe('toShell regexes', () => {
  const regex = (pattern: string, options = '') => ({
    $regularExpression: { pattern, options }
  })

  it('round-trips ordinary patterns as literals', () => {
    for (const pattern of ['^abc', '\\d+\\.\\d*', 'a\\/b', '[/]x']) {
      const text = toShell(regex(pattern, 'i'))
      expect(text.startsWith('/')).toBe(true)
      expect(parseShellValue(text)).toEqual(regex(pattern === '[/]x' ? '[\\/]x' : pattern, 'i'))
    }
  })

  it('keeps patterns JavaScript rejects intact through BSONRegExp', () => {
    for (const pattern of ['a++', '(?i)abc', '', '*', 'a\nb', 'tail\\']) {
      expect(roundTrip(regex(pattern, 'i'))).toEqual(regex(pattern, 'i'))
    }
  })

  it('never lets a pattern or its options close the literal early', () => {
    const payloads = [
      regex(`\\/, x: ${PAYLOAD}, y: 1`, 'i'),
      regex(`\\\\\\/, x: ${PAYLOAD}, y: 1`, 'i'),
      regex(`a\\`, `, x: ${PAYLOAD}`),
      regex('x', `i, y: ${PAYLOAD}`)
    ]
    for (const value of payloads) {
      expect(ranCode({ field: value, after: 'x' })).toBe(false)
    }
  })
})

describe('toShell scalar wrappers', () => {
  it('escapes values that came from $-prefixed fields of plain documents', () => {
    const quote = `'), x: ${PAYLOAD}, y: ('`
    const docs = [
      { $oid: quote },
      { $date: quote },
      { $numberLong: quote },
      { $numberDecimal: quote },
      { $numberInt: `1), x: ${PAYLOAD}, y: (1` },
      { $numberDouble: `1, x: ${PAYLOAD}, y: 1` },
      { $uuid: quote },
      { $binary: { base64: quote, subType: '00' } },
      { $timestamp: { t: `1, x: ${PAYLOAD}`, i: 0 } }
    ]
    for (const doc of docs) {
      expect(ranCode({ field: doc })).toBe(false)
    }
  })

  it('still writes the usual helpers', () => {
    expect(toShell({ $oid: '650000000000000000000001' })).toBe(
      "ObjectId('650000000000000000000001')"
    )
    expect(toShell({ $numberLong: '42' })).toBe("NumberLong('42')")
    expect(toShell({ $numberInt: '7' })).toBe('NumberInt(7)')
    expect(toShell({ $timestamp: { t: 1, i: 2 } })).toBe('Timestamp({ t: 1, i: 2 })')
  })
})
