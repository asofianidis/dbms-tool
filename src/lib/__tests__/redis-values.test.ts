import { describe, expect, it } from 'vitest'
import type { RedisKeyEntry } from '../api'
import {
  buildKeyTree,
  dataText,
  describeRedisDanger,
  formatJson,
  formatTtl,
  parseCommandLine,
  parseEscapes,
  parseTtl,
  prettyJson,
  quoteData,
  redisIsWrite,
  scanPattern,
  ttlInput,
  zsetScore
} from '../redis'

describe('JSON views keep the text', () => {
  it('re-indents without touching numbers or duplicate keys', () => {
    const text = '{"big":9007199254740993,"d":1.0,"e":1E+2,"a":1,"a":2,"s":"x\\"y,{:}"}'
    expect(prettyJson(text)).toBe(
      '{\n  "big": 9007199254740993,\n  "d": 1.0,\n  "e": 1E+2,\n  "a": 1,\n  "a": 2,\n  "s": "x\\"y,{:}"\n}'
    )
    expect(formatJson(prettyJson(text)!, 0)).toBe(text)
  })

  it('formats like JSON.stringify for ordinary JSON', () => {
    const text = '{ "a": [1, 2, {"b": null}], "c": {}, "d": [ ], "e": "é" }'
    expect(prettyJson(text)).toBe(JSON.stringify(JSON.parse(text), null, 2))
    expect(formatJson(text, 0)).toBe(JSON.stringify(JSON.parse(text)))
    expect(formatJson('{broken', 2)).toBeNull()
  })
})

describe('binary console arguments', () => {
  it('reads \\x escapes as bytes', () => {
    expect(parseCommandLine('GET "\\xff:1"')).toEqual(['GET', { $hex: 'ff3a31' }])
    // UTF-8 written as escapes is the text it encodes, not Latin-1
    expect(parseCommandLine('GET "\\xc3\\xbf"')).toEqual(['GET', 'ÿ'])
    expect(parseCommandLine('GET "ÿ\\x00"')).toEqual(['GET', 'ÿ\x00'])
  })

  it('quotes binary keys so the console reads the same bytes back', () => {
    for (const key of [{ $hex: 'ff3a31' }, { $hex: '5c78ff22' }, 'plain', 'with space']) {
      expect(parseCommandLine(`TYPE ${quoteData(key)}`)).toEqual(['TYPE', key])
    }
  })

  it('classifies binary arguments', () => {
    const args = parseCommandLine('DEL "\\xff" "\\xfe"')
    expect(redisIsWrite({ op: 'command', database: '0', args })).toBe(true)
    expect(redisIsWrite({ op: 'command', database: '0', args: ['GET', { $hex: 'ff' }] })).toBe(
      false
    )
    expect(describeRedisDanger({ op: 'command', database: '0', args })).toMatch(/2 keys/)
  })
})

describe('binary key names', () => {
  it('turns displayed escapes back into bytes', () => {
    const key = { $hex: 'ff3a31' }
    expect(dataText(key)).toBe('\\xff:1')
    expect(parseEscapes('\\xff:2')).toEqual({ $hex: 'ff3a32' })
    expect(parseEscapes(dataText({ $hex: '5c78ff' }))).toEqual({ $hex: '5c78ff' })
    expect(parseEscapes('user:1')).toBe('user:1')
  })
})

describe('folders of binary keys', () => {
  const entry = (key: RedisKeyEntry['key']): RedisKeyEntry => ({ key, type: 'string', ttl: -1 })

  it('keeps binary and look-alike text folders apart, with byte patterns', () => {
    const root = buildKeyTree([entry({ $hex: 'ff3a31' }), entry('\\xff:1'), entry('a*b:1')], ':')
    const folders = [...root.folders.values()]
    expect(folders).toHaveLength(3)
    const binary = folders.find((f) => f.id === 'hex:ff3a')!
    const text = folders.find((f) => f.id === 'str:\\xff:')!
    const glob = folders.find((f) => f.id === 'str:a*b:')!
    expect(binary.name).toBe('\\xff')
    expect(binary.match).toEqual({ $hex: 'ff3a2a' })
    expect(text.match).toBe('\\\\xff:*')
    expect(glob.match).toBe('a\\*b:*')
    // "Show only this folder" puts filter text in the box; it means the same pattern
    for (const f of folders) expect(scanPattern(f.filter)).toEqual(f.match)
  })

  it('reads \\x escapes in the filter as bytes', () => {
    expect(scanPattern('\\xff')).toEqual({ $hex: '2aff2a' })
    expect(scanPattern('user')).toBe('*user*')
    expect(scanPattern('a*b')).toBe('a*b')
    expect(scanPattern('\\x2a*')).toBe('\\**')
    expect(scanPattern('')).toBe('*')
  })
})

describe('sorted-set scores', () => {
  it('sends infinities as text', () => {
    expect(zsetScore('inf')).toBe('+inf')
    expect(zsetScore('+inf')).toBe('+inf')
    expect(zsetScore('-INF')).toBe('-inf')
    expect(zsetScore('Infinity')).toBe('+inf')
    expect(zsetScore(' 1.5 ')).toBe('1.5')
    expect(JSON.parse(JSON.stringify({ score: zsetScore('-inf') }))).toEqual({ score: '-inf' })
    expect(() => zsetScore('abc')).toThrow()
    expect(() => zsetScore('')).toThrow()
  })
})

describe('TTL dialog', () => {
  it('pre-fills an exact TTL that parses back unchanged', () => {
    // 1d 1h 59m shows rounded, but the dialog must not round it
    const ms = 86_400_000 + 3_600_000 + 59 * 60_000 + 12_345
    expect(formatTtl(ms)).toBe('1d 1h')
    expect(ttlInput(ms)).toBe('1d1h59m12s345ms')
    expect(parseTtl(ttlInput(ms))).toBe(ms)
    expect(parseTtl(ttlInput(5000))).toBe(5000)
  })
})
