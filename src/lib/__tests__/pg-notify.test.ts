import { describe, expect, it } from 'vitest'
import {
  channelProblem,
  foldsCase,
  matchesFilter,
  notificationLine,
  rememberChannels,
  splitChannelList
} from '../pg-notify'

const n = { channel: 'jobs', payload: '{"id":7}', pid: 4242, at: 0 }

describe('splitChannelList', () => {
  it('splits on commas and new lines, keeping case and spaces', () => {
    expect(splitChannelList(' jobs, Orders \n my channel,,')).toEqual([
      'jobs',
      'Orders',
      'my channel'
    ])
  })

  it('drops repeats', () => {
    expect(splitChannelList('a, a, b')).toEqual(['a', 'b'])
  })
})

describe('channelProblem', () => {
  it('accepts up to 63 bytes', () => {
    expect(channelProblem('jobs')).toBeNull()
    expect(channelProblem('x'.repeat(63))).toBeNull()
    expect(channelProblem('x'.repeat(64))).toMatch(/63 bytes/)
    // Two bytes each in UTF-8
    expect(channelProblem('é'.repeat(32))).toMatch(/63 bytes/)
  })

  it('needs a name', () => {
    expect(channelProblem('')).toBe('Enter a channel name')
  })
})

describe('rememberChannels', () => {
  it('puts new ones first without repeats', () => {
    expect(rememberChannels(['a', 'b', 'c'], ['c', 'd'], 4)).toEqual(['c', 'd', 'a', 'b'])
  })
})

describe('foldsCase', () => {
  it('flags names an unquoted NOTIFY would lower-case', () => {
    expect(foldsCase('Jobs')).toBe(true)
    expect(foldsCase('jobs_1')).toBe(false)
  })
})

describe('matchesFilter', () => {
  it('matches channel, payload or pid', () => {
    expect(matchesFilter(n, '')).toBe(true)
    expect(matchesFilter(n, 'JOB')).toBe(true)
    expect(matchesFilter(n, '"id"')).toBe(true)
    expect(matchesFilter(n, '4242')).toBe(true)
    expect(matchesFilter(n, 'orders')).toBe(false)
  })
})

describe('notificationLine', () => {
  it('reads like the query messages', () => {
    expect(notificationLine(n)).toBe('NOTIFY jobs (pid 4242): {"id":7}')
    expect(notificationLine({ ...n, payload: '' })).toBe('NOTIFY jobs (pid 4242)')
  })
})
