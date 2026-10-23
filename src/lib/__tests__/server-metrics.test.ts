import { describe, expect, it } from 'vitest'
import type { ResultSet } from '../api'
import {
  dashboardFor,
  documentToRaw,
  formatMetric,
  formatUptime,
  hitPercent,
  metricKey,
  pairsToRaw,
  rate,
  rowToRaw
} from '../server-metrics'

const set = (names: string[], rows: (string | null)[][]): ResultSet => ({
  columns: names.map((name) => ({ name, typeName: 'text' })),
  rows,
  rowCount: rows.length,
  truncated: false
})

describe('parsing', () => {
  it('normalizes names', () => {
    expect(metricKey('Batch Requests/sec')).toBe('batch_requests_sec')
    expect(metricKey('Total Server Memory (KB)')).toBe('total_server_memory_kb')
    expect(metricKey('Innodb_buffer_pool_reads')).toBe('innodb_buffer_pool_reads')
  })

  it('reads a wide row and name/value pairs', () => {
    expect(rowToRaw(set(['uptime_s', 'Address'], [['42', null]]))).toEqual({
      uptime_s: '42',
      address: null
    })
    expect(
      pairsToRaw(
        set(
          ['Variable_name', 'Value'],
          [
            ['Questions', '100'],
            ['Threads_running', '3']
          ]
        )
      )
    ).toEqual({ questions: '100', threads_running: '3' })
  })

  it('flattens extended JSON documents', () => {
    const raw = documentToRaw({
      uptime: { $numberDouble: '12.5' },
      opcounters: { insert: { $numberLong: '7' }, query: 3 },
      wiredTiger: { cache: { 'bytes currently in the cache': 1024 } },
      repl: { isWritablePrimary: true, hosts: ['a', 'b'] },
      localTime: { $date: '2026-01-02T03:04:05Z' }
    })
    expect(raw).toEqual({
      uptime: '12.5',
      'opcounters.insert': '7',
      'opcounters.query': '3',
      'wiredtiger.cache.bytes_currently_in_the_cache': '1024',
      'repl.iswritableprimary': 'true',
      localtime: '2026-01-02T03:04:05.000Z'
    })
    expect(documentToRaw({ system: { numCores: 8 } }, 'host')).toEqual({
      'host.system.numcores': '8'
    })
  })
})

describe('rates', () => {
  it('turns counter deltas into per-second rates', () => {
    expect(rate({ a: '150', b: '20' }, { a: '100', b: '10' }, 2, 'a', 'b')).toBe(30)
  })

  it('has no rate on the first poll, after a reset or for missing counters', () => {
    expect(rate({ a: '5' }, null, 2, 'a')).toBeNull()
    expect(rate({ a: '5' }, { a: '100' }, 2, 'a')).toBeNull()
    expect(rate({ a: '5' }, { b: '1' }, 2, 'a')).toBeNull()
  })

  it('measures hit ratio over the interval, falling back to lifetime', () => {
    const prev = { hit: '900', miss: '100' }
    expect(hitPercent({ hit: '1890', miss: '110' }, prev, 'hit', 'miss')).toBeCloseTo(99)
    // No traffic in the interval: lifetime ratio
    expect(hitPercent(prev, prev, 'hit', 'miss')).toBeCloseTo(90)
    expect(hitPercent(prev, null, 'hit', 'miss')).toBeCloseTo(90)
    expect(hitPercent({ hit: '0', miss: '0' }, null, 'hit', 'miss')).toBeNull()
  })
})

describe('engine dashboards', () => {
  it('derives PostgreSQL metrics', () => {
    const spec = dashboardFor('postgres', false)
    const prev = {
      commits: '1000',
      rollbacks: '0',
      blks_hit: '9000',
      blks_read: '1000',
      connections: '10',
      max_connections: '100'
    }
    const next = { ...prev, commits: '1090', rollbacks: '10', blks_hit: '9100' }
    const point = spec.derive(next, prev, 5)
    expect(point.tps).toBe(20)
    expect(point.cacheHit).toBe(100)
    expect(point.connections).toBe(10)
  })

  it('derives the MySQL buffer pool hit ratio from read requests', () => {
    const spec = dashboardFor('mysql', false)
    const prev = { innodb_buffer_pool_read_requests: '1000', innodb_buffer_pool_reads: '10' }
    const next = { innodb_buffer_pool_read_requests: '2000', innodb_buffer_pool_reads: '20' }
    expect(spec.derive(next, prev, 1).poolHit).toBeCloseTo(99)
  })

  it('derives SQL Server and MongoDB usage percentages', () => {
    const ms = dashboardFor('mssql', false).derive(
      {
        buffer_cache_hit_ratio: '995',
        buffer_cache_hit_ratio_base: '1000',
        physical_memory_kb: '1000',
        available_physical_memory_kb: '250'
      },
      null,
      0
    )
    expect(ms.cacheHit).toBeCloseTo(99.5)
    expect(ms.memory).toBe(75)

    const mongo = dashboardFor('mongo', false).derive(
      {
        'connections.current': '20',
        'connections.available': '80',
        'mem.resident': '512',
        'host.system.memsizemb': '2048'
      },
      null,
      0
    )
    expect(mongo.connections).toBe(20)
    expect(mongo.memory).toBe(25)
  })

  it('reads SQL Server CPU from the scheduler ring buffer', () => {
    const spec = dashboardFor('mssql', false)
    const cpu_record =
      '<Record id="1"><SchedulerMonitorEvent><SystemHealth><SystemIdle>90</SystemIdle>' +
      '<ProcessUtilization>4</ProcessUtilization></SystemHealth></SchedulerMonitorEvent></Record>'
    const windows = spec.derive({ cpu_record, host_platform: 'Windows' }, null, 0)
    expect(windows.cpu).toBe(4)
    expect(windows.hostCpu).toBe(10)
    // SQL Server on Linux reports SystemIdle as 0, so host CPU is unknown
    expect(spec.derive({ cpu_record, host_platform: 'Linux' }, null, 0).hostCpu).toBeNull()
    expect(spec.derive({}, null, 0).cpu).toBeNull()
  })

  it('uses the limited dashboard for Babelfish on a SQL Server connection', () => {
    expect(dashboardFor('mssql', true)).toBe(dashboardFor('babelfish', false))
  })

  it('keeps SQL probes clear of the read-only guard keywords', () => {
    const blocked = /\b(insert|update|delete|lock|into|exec|execute|replace)\b(?!\s*\()/i
    for (const engine of ['postgres', 'mysql', 'mssql', 'babelfish'] as const)
      for (const probe of dashboardFor(engine, false).probes)
        if ('sql' in probe) {
          const unquoted = probe.sql.replace(/'[^']*'/g, "''").replace(/\[[^\]]*\]/g, '[]')
          expect(unquoted, `${engine}/${probe.id}`).not.toMatch(blocked)
        }
  })
})

describe('formatting', () => {
  it('formats values by unit', () => {
    expect(formatMetric(null, 'count')).toBe('—')
    expect(formatMetric(1284, 'count')).toBe('1.3K')
    expect(formatMetric(3.25, 'perSec')).toBe('3.3/s')
    expect(formatMetric(2048, 'bytesPerSec')).toBe('2.0 KB/s')
    expect(formatMetric(99.42, 'percent')).toBe('99.4%')
    expect(formatMetric(100, 'percent')).toBe('100%')
    expect(formatMetric(3700, 'seconds')).toBe('1h 1m')
  })

  it('formats uptime', () => {
    expect(formatUptime(45)).toBe('45s')
    expect(formatUptime(90061)).toBe('1d 1h')
  })
})
