import { describe, expect, it } from 'vitest'
import {
  dropSeedObjectsSql,
  mongoSeedBatches,
  mongoSeedIndexes,
  postStatements,
  recreateDatabaseSql,
  schemaStatements,
  seedCell,
  sqlSeedBatches
} from '../seed'

describe('sqlSeedBatches', () => {
  it('covers every table with batches no larger than the dialect allows', () => {
    const rows = new Map<string, number>()
    let last = 0
    for (const b of sqlSeedBatches('postgres', 0.0001, 1)) {
      rows.set(b.table, (rows.get(b.table) ?? 0) + b.rows)
      expect(b.rows).toBeLessThanOrEqual(1000)
      expect(b.progress).toBeGreaterThanOrEqual(last)
      last = b.progress
    }
    expect(rows.get('customers')).toBe(100)
    expect(rows.get('orders')).toBe(500)
    expect(rows.get('metrics')).toBe(10 * 1440)
    expect(rows.size).toBe(schemaStatements('mysql').length)
  })

  it('wraps SQL Server identity tables in IDENTITY_INSERT', () => {
    const batches = [...sqlSeedBatches('tsql', 0.0001, 1)]
    const customers = batches.find((b) => b.table === 'customers')!
    expect(customers.sql).toMatch(
      /^SET IDENTITY_INSERT \[customers\] ON;\nINSERT INTO \[customers\]/
    )
    const countries = batches.find((b) => b.table === 'countries')!
    expect(countries.sql).toMatch(/^INSERT INTO \[countries\]/)
  })

  it('produces the same rows on every run', () => {
    const first = sqlSeedBatches('sqlite', 0.0001, 1).next().value
    const again = sqlSeedBatches('sqlite', 0.0001, 1).next().value
    expect(again).toEqual(first)
  })
})

describe('seedCell', () => {
  it('encodes values the way the CSV generator does', () => {
    expect(seedCell('postgres', new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 6)))).toBe(
      '2026-01-02 03:04:05.006'
    )
    expect(seedCell('mysql', 12.5)).toBe('12.5')
    expect(seedCell('mysql', NaN)).toBeNull()
    expect(seedCell('mysql', { a: 1 })).toBe('{"a":1}')
  })
})

describe('DDL', () => {
  it('splits post-load DDL, keeping T-SQL views and the Postgres function whole', () => {
    const pg = postStatements('postgres')
    expect(pg.some((s) => s.startsWith('CREATE FUNCTION customer_ltv_usd'))).toBe(true)
    const ms = postStatements('tsql')
    expect(ms.some((s) => /^CREATE VIEW v_daily_revenue[\s\S]*GROUP BY/.test(s))).toBe(true)
    expect(ms.some((s) => /^GO$/im.test(s))).toBe(false)
    expect(postStatements('mysql')[0]).toBe('SET foreign_key_checks = 0')
  })

  it('recreates databases and drops existing SQLite seed objects', () => {
    expect(recreateDatabaseSql('postgres', 'acme_prod', false)).toEqual([
      'CREATE DATABASE acme_prod'
    ])
    expect(recreateDatabaseSql('mysql', 'acme_prod', true)[0]).toBe(
      'DROP DATABASE IF EXISTS `acme_prod`'
    )
    expect(
      dropSeedObjectsSql([
        { name: 'customers', kind: 'table' },
        { name: 'v_daily_revenue', kind: 'view' },
        { name: 'notes', kind: 'table' }
      ])
    ).toEqual(['DROP VIEW IF EXISTS v_daily_revenue', 'DROP TABLE IF EXISTS customers'])
  })
})

describe('mongo seed', () => {
  it('runs the seed script into EJSON batches', () => {
    const counts = new Map<string, number>()
    let sample: Record<string, unknown> | undefined
    for (const b of mongoSeedBatches(0.0001, 1)) {
      counts.set(b.collection, (counts.get(b.collection) ?? 0) + b.documents.length)
      if (b.collection === 'orders') sample ??= b.documents[0] as Record<string, unknown>
    }
    expect(counts.get('users')).toBe(100)
    expect(counts.get('warehouses')).toBe(12)
    expect(counts.get('metrics')).toBe(10 * 1440)
    expect(sample?._id).toEqual({ $oid: expect.stringMatching(/^[0-9a-f]{24}$/) })
    expect(sample?.createdAt).toEqual({ $date: expect.any(String) })
  })

  it('reads the index script', () => {
    const indexes = mongoSeedIndexes()
    expect(indexes).toContainEqual({
      collection: 'users',
      keys: { email: 1 },
      options: { unique: true, name: 'email_unique' }
    })
    expect(indexes.filter((i) => i.collection === 'orders')).toHaveLength(5)
  })
})
