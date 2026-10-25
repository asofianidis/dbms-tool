import { describe, expect, it } from 'vitest'
import { connectedInfo, isMariaDb, knownMariaDb, mariaDbAtLeast, mariaDbVersion } from '../mariadb'

const info = (product: string, version: string) => ({ product, version })

describe('MariaDB detection', () => {
  it('tells MariaDB from MySQL', () => {
    expect(isMariaDb(info('MariaDB 11.4.2', '11.4.2-MariaDB-ubu2404 mariadb.org binary'))).toBe(
      true
    )
    expect(isMariaDb(info('MySQL 8.4.0', '8.4.0 MySQL Community Server - GPL'))).toBe(false)
    expect(isMariaDb(null)).toBe(false)
  })

  it('reads the version, skipping the 5.5.5- replication prefix', () => {
    expect(mariaDbVersion(info('MariaDB 11.4.2', '11.4.2-MariaDB-log'))).toEqual([11, 4, 2])
    expect(mariaDbVersion(info('MariaDB 5.5.5', '5.5.5-10.6.12-MariaDB'))).toEqual([10, 6, 12])
    expect(mariaDbVersion(info('MySQL 8.4.0', '8.4.0'))).toBeNull()
  })

  it('compares versions', () => {
    const v = info('MariaDB 10.6.12', '10.6.12-MariaDB')
    expect(mariaDbAtLeast(v, 10, 3)).toBe(true)
    expect(mariaDbAtLeast(v, 10, 6)).toBe(true)
    expect(mariaDbAtLeast(v, 10, 7)).toBe(false)
    expect(mariaDbAtLeast(v, 11)).toBe(false)
    expect(mariaDbAtLeast(info('MySQL 8.4.0', '8.4.0'), 5)).toBe(false)
  })

  it('reads server info only from a connected status', () => {
    const connected = info('MariaDB 11.4.2', '11.4.2-MariaDB')
    expect(
      connectedInfo({
        state: 'connected',
        info: { ...connected, currentDatabase: '', user: '', babelfishVersion: null }
      })?.product
    ).toBe('MariaDB 11.4.2')
    expect(connectedInfo({ state: 'connecting' })).toBeNull()
    expect(connectedInfo(undefined)).toBeNull()
  })

  it('knows the server only once connected', () => {
    const status = (product: string, version: string) => ({
      state: 'connected' as const,
      info: { product, version, currentDatabase: '', user: '', babelfishVersion: null }
    })
    expect(knownMariaDb(status('MariaDB 11.8.3', '11.8.3-MariaDB'))).toBe(true)
    expect(knownMariaDb(status('MySQL 8.4.0', '8.4.0'))).toBe(false)
    expect(knownMariaDb({ state: 'connecting' })).toBeUndefined()
    expect(knownMariaDb(undefined)).toBeUndefined()
  })
})
