import { describe, expect, it } from 'vitest'
import type { Engine, ResultSet } from '../api'
import {
  maintenanceScript,
  maintenanceSteps,
  maintenanceTasks,
  mongoReplyLines,
  newMaintenanceDraft,
  optionInfo,
  resultErrors,
  resultLines,
  validateMaintenance,
  type MaintenanceDraft
} from '../maintenance'

const draft = (engine: Engine, patch: Partial<MaintenanceDraft> = {}): MaintenanceDraft => ({
  ...newMaintenanceDraft(engine),
  options: {},
  ...patch
})

const sqls = (
  engine: Engine,
  d: MaintenanceDraft,
  tables = [] as { schema: string | null; name: string }[]
) => maintenanceSteps(engine, 'shop', d, tables).map((s) => ('sql' in s ? s.sql : s.command))

describe('maintenance tasks', () => {
  it('offers tasks for every engine but Babelfish', () => {
    for (const engine of ['postgres', 'mysql', 'mssql', 'sqlite', 'mongo'] as Engine[]) {
      expect(maintenanceTasks(engine).length).toBeGreaterThan(0)
    }
    expect(maintenanceTasks('babelfish')).toEqual([])
  })

  it('explains every task and option in a tooltip', () => {
    for (const engine of ['postgres', 'mysql', 'mssql', 'sqlite', 'mongo'] as Engine[]) {
      for (const task of maintenanceTasks(engine)) {
        expect(task.hint.length).toBeGreaterThan(task.description.length)
        for (const option of task.options) {
          expect(optionInfo(engine, task.value, option).hint).toBeTruthy()
        }
      }
    }
  })

  it('defaults Postgres to VACUUM (ANALYZE)', () => {
    const d = newMaintenanceDraft('postgres')
    expect(d.task).toBe('vacuum')
    expect(sqls('postgres', d)).toEqual(['VACUUM (ANALYZE)'])
  })
})

describe('postgres', () => {
  const tables = [
    { schema: 'public', name: 'orders' },
    { schema: 'Sales', name: 'line items' }
  ]

  it('vacuums the whole database in one statement', () => {
    expect(sqls('postgres', draft('postgres', { options: { full: true, verbose: true } }))).toEqual(
      ['VACUUM (FULL, VERBOSE)']
    )
  })

  it('vacuums chosen tables one at a time', () => {
    const d = draft('postgres', { scope: 'tables', tables, options: { analyze: true } })
    expect(sqls('postgres', d)).toEqual([
      'VACUUM (ANALYZE) public.orders',
      'VACUUM (ANALYZE) "Sales"."line items"'
    ])
  })

  it('reindexes the database or tables, optionally concurrently', () => {
    expect(sqls('postgres', draft('postgres', { task: 'reindex' }))).toEqual([
      'REINDEX DATABASE shop'
    ])
    const d = draft('postgres', {
      task: 'reindex',
      scope: 'tables',
      tables: tables.slice(0, 1),
      options: { concurrently: true, verbose: true }
    })
    expect(sqls('postgres', d)).toEqual(['REINDEX (VERBOSE) TABLE CONCURRENTLY public.orders'])
  })

  it('analyzes', () => {
    expect(sqls('postgres', draft('postgres', { task: 'analyze' }))).toEqual(['ANALYZE'])
  })
})

describe('mysql', () => {
  const tables = [
    { schema: null, name: 'orders' },
    { schema: null, name: 'users' }
  ]

  it('runs table statements once per table even for the whole database', () => {
    const d = draft('mysql', { task: 'optimize', options: { local: true } })
    expect(sqls('mysql', d, tables)).toEqual([
      'OPTIMIZE NO_WRITE_TO_BINLOG TABLE `orders`',
      'OPTIMIZE NO_WRITE_TO_BINLOG TABLE `users`'
    ])
  })

  it('checks and repairs with EXTENDED', () => {
    expect(
      sqls(
        'mysql',
        draft('mysql', { task: 'check', options: { extended: true } }),
        tables.slice(0, 1)
      )
    ).toEqual(['CHECK TABLE `orders` EXTENDED'])
    expect(sqls('mysql', draft('mysql', { task: 'repair' }), tables.slice(1))).toEqual([
      'REPAIR TABLE `users`'
    ])
  })

  it('needs tables to run on', () => {
    const d = draft('mysql', { task: 'analyze' })
    const steps = maintenanceSteps('mysql', 'shop', d, [])
    expect(validateMaintenance('mysql', d, steps)).toBe('There are no tables to run this on')
    const chosen = draft('mysql', { task: 'analyze', scope: 'tables' })
    expect(validateMaintenance('mysql', chosen, [])).toBe('Choose at least one table')
  })
})

describe('sql server', () => {
  const tables = [{ schema: 'dbo', name: "o'rders" }]

  it('checks the database or single tables', () => {
    expect(
      sqls('mssql', draft('mssql', { task: 'checkdb', options: { physicalOnly: true } }))
    ).toEqual(["DBCC CHECKDB (N'shop') WITH NO_INFOMSGS, ALL_ERRORMSGS, PHYSICAL_ONLY"])
    expect(sqls('mssql', draft('mssql', { task: 'checkdb', scope: 'tables', tables }))).toEqual([
      "DBCC CHECKTABLE (N'[dbo].[o''rders]') WITH NO_INFOMSGS, ALL_ERRORMSGS"
    ])
  })

  it('uses sp_updatestats unless a full scan is asked for', () => {
    expect(sqls('mssql', draft('mssql', { task: 'statistics' }), tables)).toEqual([
      'EXEC sp_updatestats'
    ])
    expect(
      sqls('mssql', draft('mssql', { task: 'statistics', options: { fullScan: true } }), tables)
    ).toEqual(["UPDATE STATISTICS [dbo].[o'rders] WITH FULLSCAN"])
  })

  it('rebuilds and reorganizes indexes per table', () => {
    expect(
      sqls('mssql', draft('mssql', { task: 'rebuild', options: { online: true } }), tables)
    ).toEqual(["ALTER INDEX ALL ON [dbo].[o'rders] REBUILD WITH (ONLINE = ON)"])
    expect(sqls('mssql', draft('mssql', { task: 'reorganize' }), tables)).toEqual([
      "ALTER INDEX ALL ON [dbo].[o'rders] REORGANIZE"
    ])
  })

  it('separates batches with GO in the script', () => {
    const d = draft('mssql', { task: 'reorganize' })
    const steps = maintenanceSteps('mssql', 'shop', d, [
      { schema: 'dbo', name: 'a' },
      { schema: 'dbo', name: 'b' }
    ])
    expect(maintenanceScript('mssql', steps)).toBe(
      'ALTER INDEX ALL ON [dbo].[a] REORGANIZE\nGO\nALTER INDEX ALL ON [dbo].[b] REORGANIZE'
    )
  })
})

describe('sqlite', () => {
  it('runs pragmas and database-wide statements', () => {
    expect(sqls('sqlite', draft('sqlite', { task: 'vacuum' }))).toEqual(['VACUUM'])
    expect(
      sqls('sqlite', draft('sqlite', { task: 'integrity', options: { quick: true } }))
    ).toEqual(['PRAGMA quick_check'])
    expect(sqls('sqlite', draft('sqlite', { task: 'checkpoint' }))).toEqual([
      'PRAGMA wal_checkpoint(TRUNCATE)'
    ])
    const d = draft('sqlite', {
      task: 'analyze',
      scope: 'tables',
      tables: [{ schema: null, name: 'order' }]
    })
    expect(sqls('sqlite', d)).toEqual(['ANALYZE "order"'])
  })

  it('ends the script with a semicolon', () => {
    const steps = maintenanceSteps('sqlite', 'main', draft('sqlite', { task: 'vacuum' }), [])
    expect(maintenanceScript('sqlite', steps)).toBe('VACUUM;')
  })
})

describe('mongo', () => {
  const collections = [
    { schema: null, name: 'orders' },
    { schema: null, name: 'users' }
  ]

  it('validates and compacts each collection', () => {
    expect(
      sqls('mongo', draft('mongo', { task: 'validate', options: { full: true } }), collections)
    ).toEqual([
      { validate: 'orders', full: true },
      { validate: 'users', full: true }
    ])
    expect(sqls('mongo', draft('mongo', { task: 'compact' }), collections.slice(0, 1))).toEqual([
      { compact: 'orders' }
    ])
  })

  it('summarizes validate replies', () => {
    expect(
      mongoReplyLines(
        { validate: 'orders' },
        { valid: true, nrecords: 1200, nIndexes: 2, errors: [], warnings: [] }
      )
    ).toEqual({ lines: ['valid (1,200 documents, 2 indexes)'], failed: false })
    const bad = mongoReplyLines(
      { validate: 'orders' },
      { valid: false, nrecords: { $numberLong: '3' }, errors: ['bad index'], warnings: [] }
    )
    expect(bad.failed).toBe(true)
    expect(bad.lines).toEqual(['INVALID (3 documents)', 'error: bad index'])
  })

  it('reports space compact freed', () => {
    expect(mongoReplyLines({ compact: 'orders' }, { bytesFreed: 4096, ok: 1 }).lines).toEqual([
      'compacted, 4,096 bytes freed'
    ])
  })
})

describe('result output', () => {
  const set = (columns: string[], rows: (string | null)[][]): ResultSet => ({
    columns: columns.map((name) => ({ name, typeName: 'text' })),
    rows,
    rowCount: rows.length,
    truncated: false
  })

  it('prints MySQL maintenance rows as type: message and counts errors', () => {
    const out = set(
      ['Table', 'Op', 'Msg_type', 'Msg_text'],
      [
        ['shop.orders', 'check', 'error', 'Corrupt'],
        ['shop.orders', 'check', 'status', 'OK']
      ]
    )
    expect(resultLines(out)).toEqual(['error: Corrupt', 'status: OK'])
    expect(resultErrors(out)).toBe(1)
  })

  it('prints single values bare and other rows as column: value', () => {
    expect(resultLines(set(['integrity_check'], [['ok']]))).toEqual(['ok'])
    expect(resultLines(set(['busy', 'log'], [['0', null]]))).toEqual(['busy: 0  ·  log: NULL'])
  })
})
