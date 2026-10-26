import { describe, expect, it } from 'vitest'
import type { ResultSet } from '../api'
import {
  concurrentRefreshBlocker,
  isUnpopulatedError,
  matviewStatusSql,
  parseMatviewStatus,
  refreshMatviewSql
} from '../matviews'
import { sqlWriteKeyword } from '../production'

const set = (rows: ResultSet['rows']): ResultSet => ({ rows }) as ResultSet

describe('materialized views', () => {
  it('reads status for one schema', () => {
    const sql = matviewStatusSql("o'brien")
    expect(sql).toContain("n.nspname = 'o''brien'")
    expect(sql).toContain("c.relkind = 'm'")
    // A catalog read, so the production guard doesn't ask about it
    expect(sqlWriteKeyword(sql, 'postgres')).toBeNull()
  })

  it('parses text and boolean cells', () => {
    expect(
      parseMatviewStatus(
        set([
          ['sales', 't', 'f'],
          ['stats', false, true],
          [null, 't', 't']
        ])
      )
    ).toEqual({
      sales: { populated: true, concurrentKey: false },
      stats: { populated: false, concurrentKey: true }
    })
    expect(parseMatviewStatus(undefined)).toEqual({})
  })

  it('scripts each refresh mode with quoted names', () => {
    const ref = { schema: 'app', name: 'Sales By Region' }
    expect(refreshMatviewSql(ref, 'normal')).toBe(
      'REFRESH MATERIALIZED VIEW app."Sales By Region";'
    )
    expect(refreshMatviewSql(ref, 'concurrently')).toBe(
      'REFRESH MATERIALIZED VIEW CONCURRENTLY app."Sales By Region";'
    )
    expect(refreshMatviewSql(ref, 'no-data')).toBe(
      'REFRESH MATERIALIZED VIEW app."Sales By Region" WITH NO DATA;'
    )
    expect(sqlWriteKeyword(refreshMatviewSql(ref, 'normal'), 'postgres')).toBe('REFRESH')
  })

  it('explains when CONCURRENTLY is unavailable', () => {
    expect(concurrentRefreshBlocker(undefined)).toBeNull()
    expect(concurrentRefreshBlocker({ populated: true, concurrentKey: true })).toBeNull()
    expect(concurrentRefreshBlocker({ populated: false, concurrentKey: true })).toMatch(
      /not populated/i
    )
    expect(concurrentRefreshBlocker({ populated: true, concurrentKey: false })).toMatch(
      /unique index/i
    )
  })

  it('recognizes the unpopulated error', () => {
    expect(isUnpopulatedError('materialized view "order_stats" has not been populated')).toBe(true)
    expect(isUnpopulatedError('relation "order_stats" does not exist')).toBe(false)
  })
})
