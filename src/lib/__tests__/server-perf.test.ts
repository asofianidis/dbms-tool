import { describe, expect, it } from 'vitest'
import {
  isLegacyPgStatStatements,
  LOCK_COLUMNS,
  LOCKS_SQL,
  slowQuerySetupHint,
  slowQuerySql
} from '../server-perf'

describe('slow queries', () => {
  it('reads pg_stat_statements with the column names for the server version', () => {
    expect(slowQuerySql('postgres', 'total')).toMatch(/ORDER BY total_exec_time DESC/)
    const legacy = slowQuerySql('postgres', 'mean', { legacy: true })!
    expect(legacy).toMatch(/ORDER BY mean_time DESC/)
    expect(legacy).not.toMatch(/exec_time/)
    expect(isLegacyPgStatStatements('column "total_exec_time" does not exist')).toBe(true)
    expect(isLegacyPgStatStatements('relation "pg_stat_statements" does not exist')).toBe(false)
  })

  it('reads the MySQL digest summary and SQL Server statistics', () => {
    expect(slowQuerySql('mysql', 'calls')).toMatch(
      /events_statements_summary_by_digest[\s\S]*ORDER BY COUNT_STAR DESC/
    )
    expect(slowQuerySql('mssql', 'total')).toMatch(/sys\.dm_exec_query_stats/)
    const store = slowQuerySql('mssql', 'mean', {
      source: { kind: 'query-store', database: 'sales]db' }
    })!
    expect(store).toMatch(/FROM \[sales]]db]\.sys\.query_store_query q/)
    expect(store).toMatch(/ORDER BY mean_ms DESC/)
    expect(slowQuerySql('babelfish', 'total')).toBeNull()
  })

  it('explains how to turn statistics on', () => {
    expect(slowQuerySetupHint('postgres', 'relation "pg_stat_statements" does not exist')).toMatch(
      /CREATE EXTENSION/
    )
    expect(
      slowQuerySetupHint(
        'postgres',
        'pg_stat_statements must be loaded via "shared_preload_libraries"'
      )
    ).toMatch(/restart/)
    expect(slowQuerySetupHint('mysql', 'syntax error')).toBeNull()
  })
})

describe('locks', () => {
  it('has a lock list and tree columns for each SQL engine', () => {
    for (const engine of ['postgres', 'mysql', 'mssql']) {
      const cols = LOCK_COLUMNS[engine]
      expect(LOCKS_SQL[engine]).toContain(cols.blockedBy)
      expect(LOCKS_SQL[engine]).toContain(cols.id)
    }
  })
})
