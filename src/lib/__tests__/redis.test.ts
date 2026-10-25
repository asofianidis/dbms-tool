import { describe, expect, it } from 'vitest'
import type { RedisKeyEntry } from '../api'
import { parseConnectionString, redactUri, connectionLabel, newConnection } from '../engines'
import {
  buildKeyTree,
  completeCommand,
  dataText,
  describeRedisDanger,
  flattenKeyTree,
  formatReply,
  formatTtl,
  globEscape,
  isReadCommand,
  parseClientList,
  parseCommandLine,
  parseInfo,
  parseSlowlog,
  parseTtl,
  prettyJson,
  quoteArg,
  recordsToSet,
  redisIsWrite,
  sameData,
  scriptCommands
} from '../redis'

describe('parseCommandLine', () => {
  it('splits on whitespace', () => {
    expect(parseCommandLine('  SET  user:1   Ada ')).toEqual(['SET', 'user:1', 'Ada'])
  })

  it('reads double quotes with escapes', () => {
    expect(parseCommandLine('SET k "a b\\n\\"c\\"\\x41"')).toEqual(['SET', 'k', 'a b\n"c"A'])
  })

  it('reads single quotes literally', () => {
    expect(parseCommandLine("SET k 'it\\'s \\n raw'")).toEqual(['SET', 'k', "it's \\n raw"])
  })

  it('keeps empty quoted arguments', () => {
    expect(parseCommandLine('SET k ""')).toEqual(['SET', 'k', ''])
  })

  it('joins quoted and bare parts of one argument', () => {
    expect(parseCommandLine('GET user:"a b"')).toEqual(['GET', 'user:a b'])
  })

  it('rejects unbalanced quotes', () => {
    expect(() => parseCommandLine('SET k "oops')).toThrow(/Unbalanced/)
  })
})

describe('quoteArg', () => {
  it('leaves plain words alone and round-trips the rest', () => {
    expect(quoteArg('user:1')).toBe('user:1')
    for (const s of ['a b', '', 'say "hi"', 'line\nbreak', "it's", 'back\\slash', 'é ünï']) {
      expect(parseCommandLine(`SET ${quoteArg(s)}`)).toEqual(['SET', s])
    }
  })
})

describe('scriptCommands', () => {
  it('skips blank lines and comments, keeping line numbers', () => {
    expect(scriptCommands('# setup\nSET a 1\n\n// next\n  GET a  ')).toEqual([
      { line: 2, text: 'SET a 1' },
      { line: 5, text: 'GET a' }
    ])
  })
})

describe('formatReply', () => {
  it('prints scalars like redis-cli', () => {
    expect(formatReply({ t: 'status', v: 'OK' })).toBe('OK')
    expect(formatReply({ t: 'nil' })).toBe('(nil)')
    expect(formatReply({ t: 'int', v: 3 })).toBe('(integer) 3')
    expect(formatReply({ t: 'error', v: 'WRONGTYPE nope' })).toBe('(error) WRONGTYPE nope')
    expect(formatReply({ t: 'bulk', v: 'say "hi"' })).toBe('"say \\"hi\\""')
    expect(formatReply({ t: 'bulk', v: { $hex: '00ff41' } })).toBe('"\\x00\\xffA"')
  })

  it('numbers and indents nested arrays', () => {
    const reply = {
      t: 'array' as const,
      v: [
        { t: 'bulk' as const, v: 'a' },
        {
          t: 'array' as const,
          v: [
            { t: 'int' as const, v: 1 },
            { t: 'int' as const, v: 2 }
          ]
        }
      ]
    }
    expect(formatReply(reply)).toBe('1) "a"\n2) 1) (integer) 1\n   2) (integer) 2')
    expect(formatReply({ t: 'array', v: [] })).toBe('(empty array)')
  })

  it('prints RESP3 maps', () => {
    expect(
      formatReply({
        t: 'map',
        v: [
          [
            { t: 'bulk', v: 'f' },
            { t: 'bulk', v: 'v' }
          ]
        ]
      })
    ).toBe('1# "f" => "v"')
  })
})

describe('binary data', () => {
  it('shows bytes as escapes and compares by content', () => {
    expect(dataText({ $hex: '68690a5c' })).toBe('hi\\x0a\\x5c')
    expect(dataText('plain')).toBe('plain')
    expect(sameData({ $hex: 'AB' }, { $hex: 'ab' })).toBe(true)
    expect(sameData('ab', { $hex: '6162' })).toBe(false)
  })
})

describe('TTLs', () => {
  it('formats remaining time compactly', () => {
    expect(formatTtl(-1)).toBe('No expiry')
    expect(formatTtl(500)).toBe('500ms')
    expect(formatTtl(45_000)).toBe('45s')
    expect(formatTtl(200_000)).toBe('3m 20s')
    expect(formatTtl(3_600_000)).toBe('1h')
    expect(formatTtl(90_061_000)).toBe('1d 1h')
  })

  it('parses durations', () => {
    expect(parseTtl('')).toBeNull()
    expect(parseTtl('90')).toBe(90_000)
    expect(parseTtl('1h30m')).toBe(5_400_000)
    expect(parseTtl('2d')).toBe(172_800_000)
    expect(parseTtl('250ms')).toBe(250)
    expect(() => parseTtl('soon')).toThrow()
  })
})

describe('write classification', () => {
  it('matches the backend read list', () => {
    expect(isReadCommand(['get', 'k'])).toBe(true)
    expect(isReadCommand(['CONFIG', 'get', 'maxmemory'])).toBe(true)
    expect(isReadCommand(['CONFIG', 'SET', 'maxmemory', '1'])).toBe(false)
    expect(redisIsWrite({ op: 'scan', database: '0' })).toBe(false)
    expect(redisIsWrite({ op: 'command', database: '0', args: ['HGETALL', 'h'] })).toBe(false)
    expect(redisIsWrite({ op: 'command', database: '0', args: ['DEL', 'h'] })).toBe(true)
    expect(redisIsWrite({ op: 'expire', database: '0', key: 'k' })).toBe(true)
  })

  it('flags destructive requests', () => {
    expect(describeRedisDanger({ op: 'flush', database: '3' })).toMatch(/database 3/)
    expect(describeRedisDanger({ op: 'command', database: '0', args: ['flushall'] })).toMatch(
      /every database/
    )
    expect(describeRedisDanger({ op: 'delete', database: '0', keys: ['a'] })).toBeNull()
    expect(describeRedisDanger({ op: 'delete', database: '0', keys: ['a', 'b'] })).toMatch(/2 keys/)
    expect(
      describeRedisDanger({ op: 'command', database: '0', args: ['SET', 'a', '1'] })
    ).toBeNull()
  })
})

describe('key tree', () => {
  const entry = (key: string, type = 'string'): RedisKeyEntry => ({ key, type, ttl: -1 })
  const keys = [entry('user:2:name'), entry('user:1:name'), entry('user:1:email'), entry('config')]

  it('groups keys into folders on the delimiter', () => {
    const root = buildKeyTree(keys, ':')
    expect(root.count).toBe(4)
    expect(root.folders.get('str:user:')?.count).toBe(3)
    expect(root.folders.get('str:user:')?.folders.get('str:user:1:')?.prefix).toBe('user:1:')
  })

  it('flattens open folders, folders first', () => {
    const root = buildKeyTree(keys, ':')
    const closed = flattenKeyTree(root, new Set())
    expect(closed.map((r) => (r.kind === 'folder' ? r.folder.name + '/' : r.label))).toEqual([
      'user/',
      'config'
    ])
    const open = flattenKeyTree(root, new Set(['str:user:', 'str:user:1:']))
    expect(open.map((r) => (r.kind === 'folder' ? r.folder.name + '/' : r.label))).toEqual([
      'user/',
      '1/',
      'email',
      'name',
      '2/',
      'config'
    ])
    expect(open[2].depth).toBe(2)
  })

  it('shows every key flat without a delimiter', () => {
    const rows = flattenKeyTree(buildKeyTree(keys, ''), new Set())
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.kind === 'key')).toBe(true)
  })

  it('escapes glob characters for prefix patterns', () => {
    expect(globEscape('a*b?[c]\\')).toBe('a\\*b\\?\\[c\\]\\\\')
  })
})

describe('server info', () => {
  it('parses INFO with keyspace and command stats', () => {
    const info = parseInfo(
      '# Server\r\nredis_version:7.2.4\r\n# Keyspace\r\ndb0:keys=12,expires=3,avg_ttl=0\r\ncmdstat_get:calls=5,usec=10\r\n'
    )
    expect(info.redis_version).toBe('7.2.4')
    expect(info['db0.keys']).toBe('12')
    expect(info['cmdstat_get.calls']).toBe('5')
  })

  it('parses CLIENT LIST', () => {
    const clients = parseClientList(
      'id=3 addr=127.0.0.1:5000 name= age=10 db=0 cmd=client|list\nid=4 addr=10.0.0.2:6000 name=worker age=2 db=1 cmd=blpop\n'
    )
    expect(clients).toHaveLength(2)
    expect(clients[1]).toMatchObject({ id: '4', name: 'worker', cmd: 'blpop' })
  })
})

describe('console helpers', () => {
  it('completes command names', () => {
    expect(completeCommand('hg').map((d) => d.name)).toEqual(['HGET', 'HGETALL'])
    expect(completeCommand('')).toEqual([])
  })

  it('pretty-prints JSON strings only', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('hello')).toBeNull()
    expect(prettyJson('{broken')).toBeNull()
  })
})

describe('connection strings', () => {
  it('recognises redis URIs and keeps the password out of labels', () => {
    const parsed = parseConnectionString('rediss://default:s3cret@cache.example.com:6380/2')
    expect(parsed?.engine).toBe('redis')
    expect(parsed?.password).toBe('s3cret')
    expect(redactUri('redis://:s3cret@localhost:6379')).toBe('redis://:••••@localhost:6379')
    const c = { ...newConnection('redis'), uri: 'rediss://default:x@cache.example.com:6380/2' }
    expect(connectionLabel(c)).toBe('cache.example.com:6380')
  })
})

describe('slow log', () => {
  it('turns SLOWLOG GET entries into rows', () => {
    const rows = parseSlowlog({
      t: 'array',
      v: [
        {
          t: 'array',
          v: [
            { t: 'int', v: 7 },
            { t: 'int', v: 1_700_000_000 },
            { t: 'int', v: 12_500 },
            {
              t: 'array',
              v: [
                { t: 'bulk', v: 'KEYS' },
                { t: 'bulk', v: '*' }
              ]
            },
            { t: 'bulk', v: '127.0.0.1:5000' },
            { t: 'bulk', v: '' }
          ]
        }
      ]
    })
    expect(rows[0]).toMatchObject({ id: '7', duration_ms: '12.50', command: 'KEYS *' })
    expect(recordsToSet(rows, ['id', 'command']).rows).toEqual([['7', 'KEYS *']])
  })
})
