import { describe, expect, it } from 'vitest'
import type { RoutineAttributes } from '../api'
import { routineAttributeItems, routineSearchPath, searchPathWarning } from '../routine-attributes'

const attrs = (over: Partial<RoutineAttributes> = {}): RoutineAttributes => ({
  securityDefiner: false,
  volatility: 'VOLATILE',
  strict: false,
  parallel: 'UNSAFE',
  leakproof: false,
  cost: 100,
  rows: 0,
  config: [],
  ...over
})

describe('routine attributes', () => {
  it('warns about SECURITY DEFINER without its own search_path', () => {
    expect(searchPathWarning(attrs())).toBeNull()
    expect(searchPathWarning(attrs({ securityDefiner: true }))).toMatch(/without SET search_path/)
    expect(searchPathWarning(attrs({ securityDefiner: true, config: ['work_mem=64MB'] }))).toMatch(
      /without SET search_path/
    )
  })

  it('wants pg_temp last in a SECURITY DEFINER search_path', () => {
    const pinned = attrs({ securityDefiner: true, config: ['search_path=pg_catalog, pg_temp'] })
    expect(routineSearchPath(pinned)).toBe('pg_catalog, pg_temp')
    expect(searchPathWarning(pinned)).toBeNull()
    expect(
      searchPathWarning(attrs({ securityDefiner: true, config: ['search_path="My App", public'] }))
    ).toMatch(/pg_temp/)
    expect(
      searchPathWarning(
        attrs({ securityDefiner: true, config: ['search_path="My App", "pg_temp"'] })
      )
    ).toBeNull()
  })

  it('lists function attributes as written in CREATE FUNCTION', () => {
    const items = routineAttributeItems(
      attrs({
        securityDefiner: true,
        volatility: 'IMMUTABLE',
        strict: true,
        parallel: 'SAFE',
        leakproof: true,
        cost: 5,
        rows: 20,
        config: ['search_path=pg_catalog, pg_temp', 'work_mem=64MB']
      }),
      'function'
    )
    expect(items.map((i) => i.label)).toEqual([
      'SECURITY DEFINER',
      'IMMUTABLE',
      'STRICT',
      'PARALLEL SAFE',
      'LEAKPROOF',
      'COST 5',
      'ROWS 20',
      'SET search_path = pg_catalog, pg_temp',
      'SET work_mem = 64MB'
    ])
    // Pinned search_path: a caution, not a danger
    expect(items[0].tone).toBe('warning')
    expect(items[0].title).toMatch(/owner's privileges/)
  })

  it('flags an unpinned SECURITY DEFINER and keeps procedures to security and SET', () => {
    const items = routineAttributeItems(attrs({ securityDefiner: true }), 'procedure')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ label: 'SECURITY DEFINER', tone: 'danger' })
    expect(routineAttributeItems(attrs(), 'function').map((i) => i.label)).toEqual([
      'VOLATILE',
      'PARALLEL UNSAFE',
      'COST 100'
    ])
  })
})
