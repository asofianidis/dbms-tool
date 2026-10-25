import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableInfo } from '../api'
import { draftFromTable, newColumn, newTableDraft } from '../ddl'
import { newCondition } from '../filters'
import { dangerousStatements } from '../sql'
import {
  editKey,
  normalizeTimestamp,
  notVersioned,
  parseVersioning,
  purgeHistoryScript,
  rowHistoryQuery,
  supportsVersioning,
  systemTimeClause,
  systemTimeProblem,
  versionedCount,
  versionedSelect,
  versionedTableStatements,
  versioningProblem,
  versioningWarnings,
  type Versioning
} from '../versioning'

const ref = { schema: 'app', name: 'prices' }

const implicit: Versioning = { ...notVersioned, versioned: true }
const explicit: Versioning = {
  versioned: true,
  rowStart: 'valid_from',
  rowEnd: 'valid_to',
  explicit: true,
  hidden: true
}

const column = (patch: Partial<ColumnInfo> & { name: string }): ColumnInfo => ({
  dataType: 'int(11)',
  nullable: true,
  default: null,
  isPrimaryKey: false,
  isGenerated: false,
  isIdentity: false,
  comment: null,
  extra: null,
  ...patch
})

/** What describe_table reports for a table that declares its period columns. */
const explicitTable: TableInfo = {
  columns: [
    column({ name: 'id', nullable: false, isPrimaryKey: true }),
    column({ name: 'price', dataType: 'decimal(10,2)' }),
    column({
      name: 'valid_from',
      dataType: 'timestamp(6)',
      isGenerated: true,
      extra: 'STORED GENERATED, INVISIBLE'
    }),
    column({
      name: 'valid_to',
      dataType: 'timestamp(6)',
      isPrimaryKey: true,
      isGenerated: true,
      extra: 'STORED GENERATED, INVISIBLE'
    })
  ],
  // MariaDB appends the row end column to the key
  primaryKey: ['id', 'valid_to'],
  indexes: [
    {
      name: 'PRIMARY',
      columns: ['id', 'valid_to'],
      unique: true,
      primary: true,
      method: 'BTREE',
      definition: null
    }
  ],
  foreignKeys: [],
  triggers: []
}

/** The implicit ROW_START / ROW_END never show up in the catalog. */
const implicitTable: TableInfo = {
  ...explicitTable,
  columns: explicitTable.columns.slice(0, 2),
  primaryKey: ['id'],
  indexes: [{ ...explicitTable.indexes[0], columns: ['id'] }]
}

describe('supportsVersioning', () => {
  it('needs MariaDB 10.3', () => {
    expect(supportsVersioning({ product: 'MariaDB 11.8.2', version: '11.8.2-MariaDB' })).toBe(true)
    expect(supportsVersioning({ product: 'MariaDB 10.3.39', version: '10.3.39-MariaDB' })).toBe(
      true
    )
    expect(supportsVersioning({ product: 'MariaDB 10.2.44', version: '10.2.44-MariaDB' })).toBe(
      false
    )
    expect(supportsVersioning({ product: 'MySQL 8.4.3', version: '8.4.3' })).toBe(false)
    expect(supportsVersioning(null)).toBe(false)
  })
})

describe('parseVersioning', () => {
  it('reads the table type and the declared period columns', () => {
    expect(parseVersioning([['BASE TABLE', null, null, null]])).toEqual(notVersioned)
    expect(parseVersioning([])).toEqual(notVersioned)
    expect(parseVersioning([['SYSTEM VERSIONED', null, null, null]])).toEqual(implicit)
    expect(
      parseVersioning([
        ['SYSTEM VERSIONED', 'valid_from', 'ROW START', 'STORED GENERATED, INVISIBLE'],
        ['SYSTEM VERSIONED', 'valid_to', 'ROW END', 'STORED GENERATED, INVISIBLE']
      ])
    ).toEqual(explicit)
    expect(
      parseVersioning([
        ['SYSTEM VERSIONED', 's', 'ROW START', 'STORED GENERATED'],
        ['SYSTEM VERSIONED', 'e', 'ROW END', 'STORED GENERATED']
      ])
    ).toEqual({ versioned: true, rowStart: 's', rowEnd: 'e', explicit: true, hidden: false })
  })
})

describe('system time', () => {
  it('normalizes timestamps to what a TIMESTAMP literal takes', () => {
    expect(normalizeTimestamp('2024-05-01')).toBe('2024-05-01 00:00:00')
    expect(normalizeTimestamp(' 2024-05-01T10:30 ')).toBe('2024-05-01 10:30:00')
    expect(normalizeTimestamp('2024-05-01 10:30:15.123456')).toBe('2024-05-01 10:30:15.123456')
    expect(normalizeTimestamp('2024-13-01')).toBeNull()
    expect(normalizeTimestamp('yesterday')).toBeNull()
    expect(normalizeTimestamp("2024-05-01'; DROP TABLE x")).toBeNull()
  })

  it('builds the FOR SYSTEM_TIME clause', () => {
    expect(systemTimeClause({ kind: 'current' })).toBe('')
    expect(systemTimeClause({ kind: 'all' })).toBe('FOR SYSTEM_TIME ALL')
    expect(systemTimeClause({ kind: 'asOf', at: '2024-05-01' })).toBe(
      "FOR SYSTEM_TIME AS OF TIMESTAMP '2024-05-01 00:00:00'"
    )
    expect(systemTimeClause({ kind: 'between', from: '2024-05-01', to: '2024-06-01 12:00' })).toBe(
      "FOR SYSTEM_TIME BETWEEN TIMESTAMP '2024-05-01 00:00:00' AND TIMESTAMP '2024-06-01 12:00:00'"
    )
  })

  it('reports times it cannot use', () => {
    expect(systemTimeProblem({ kind: 'all' })).toBeNull()
    expect(systemTimeProblem({ kind: 'asOf', at: '' })).toMatch(/YYYY-MM-DD/)
    expect(systemTimeProblem({ kind: 'between', from: '2024-05-01', to: '' })).toMatch(/both/)
    expect(systemTimeProblem({ kind: 'between', from: '2024-06-01', to: '2024-05-01' })).toMatch(
      /after/
    )
  })
})

describe('versionedSelect', () => {
  it('reads current rows like a plain select', () => {
    expect(versionedSelect(ref, implicit, { kind: 'current' }, { limit: 51 })).toBe(
      'SELECT *\nFROM `app`.`prices`\nLIMIT 51'
    )
  })

  it('puts FOR SYSTEM_TIME after the table and names the hidden period columns', () => {
    expect(
      versionedSelect(
        ref,
        implicit,
        { kind: 'all' },
        { where: '`id` = 1', orderBy: '`id`, `ROW_START`', limit: 51, offset: 50, periods: true }
      )
    ).toBe(
      'SELECT *, `ROW_START`, `ROW_END`\nFROM `app`.`prices` FOR SYSTEM_TIME ALL\nWHERE `id` = 1\nORDER BY `id`, `ROW_START`\nLIMIT 51 OFFSET 50'
    )
    expect(
      versionedSelect(
        ref,
        explicit,
        { kind: 'asOf', at: '2024-05-01' },
        { limit: 10, periods: true }
      )
    ).toBe(
      "SELECT *, `valid_from`, `valid_to`\nFROM `app`.`prices` FOR SYSTEM_TIME AS OF TIMESTAMP '2024-05-01 00:00:00'\nLIMIT 10"
    )
  })

  it("doesn't repeat visible period columns that SELECT * already has", () => {
    const visible = { ...explicit, hidden: false }
    expect(versionedSelect(ref, visible, { kind: 'all' }, { limit: 10, periods: true })).toBe(
      'SELECT *\nFROM `app`.`prices` FOR SYSTEM_TIME ALL\nLIMIT 10'
    )
  })

  it('counts at the system time', () => {
    expect(versionedCount(ref, { kind: 'all' }, '`id` = 1')).toBe(
      'SELECT COUNT(*) FROM `app`.`prices` FOR SYSTEM_TIME ALL WHERE `id` = 1'
    )
    expect(versionedCount(ref, { kind: 'current' })).toBe('SELECT COUNT(*) FROM `app`.`prices`')
  })
})

describe('row editing and history', () => {
  it('edits current rows without the row end column MariaDB adds to the key', () => {
    expect(editKey(['id', 'valid_to'], explicit)).toEqual(['id'])
    expect(editKey(['id'], implicit)).toEqual(['id'])
    expect(editKey(['id', 'valid_to'], undefined)).toEqual(['id', 'valid_to'])
    expect(editKey(['valid_to'], explicit)).toEqual(['valid_to'])
  })

  it('filters by the key and sorts by row start', () => {
    const condition = (c: string, value: unknown) =>
      newCondition({ column: c, op: 'eq', value: String(value) })
    const query = rowHistoryQuery(implicit, ['id', 'region'], ['7', 'eu'], condition)
    expect(query.match).toBe('all')
    expect(query.conditions.map((c) => [c.column, c.value])).toEqual([
      ['id', '7'],
      ['region', 'eu']
    ])
    expect(query.sorts).toEqual([{ column: 'ROW_START', dir: 'asc' }])
  })

  it('purges history through the destructive-statement confirmation', () => {
    const script = purgeHistoryScript(ref, '2024-05-01')
    expect(script).toContain(
      "DELETE HISTORY FROM `app`.`prices` BEFORE SYSTEM_TIME '2024-05-01 00:00:00';"
    )
    expect(dangerousStatements(script, 'mysql')).toEqual(['DELETE HISTORY'])
    expect(dangerousStatements('DELETE FROM t', 'mysql')).toEqual(['DELETE without a WHERE clause'])
  })
})

describe('designer', () => {
  const load = (info: TableInfo) => draftFromTable('mysql', 'app', 'prices', info)

  it('creates a table WITH SYSTEM VERSIONING', () => {
    const draft = { ...newTableDraft('mysql', 'app'), name: 'prices' }
    const [create] = versionedTableStatements(draft, {}, null, true)
    expect(create).toMatch(/^CREATE TABLE `app`\.`prices` \([\s\S]*\) WITH SYSTEM VERSIONING$/)
    expect(versionedTableStatements(draft, {}, null, false)[0]).not.toMatch(/VERSIONING/)
  })

  it('adds system versioning after the other changes', () => {
    const draft = load(implicitTable)
    expect(versionedTableStatements(draft, {}, notVersioned, true)).toEqual([
      'ALTER TABLE `app`.`prices` ADD SYSTEM VERSIONING'
    ])
    draft.name = 'price_list'
    expect(versionedTableStatements(draft, {}, notVersioned, true)).toEqual([
      'RENAME TABLE `app`.`prices` TO `app`.`price_list`',
      'ALTER TABLE `app`.`price_list` ADD SYSTEM VERSIONING'
    ])
  })

  it('drops system versioning first, with a warning that the history goes', () => {
    const draft = load(implicitTable)
    expect(versionedTableStatements(draft, {}, implicit, false)).toEqual([
      'SET SESSION system_versioning_alter_history = KEEP',
      'ALTER TABLE `app`.`prices` DROP SYSTEM VERSIONING'
    ])
    expect(versioningWarnings(draft, implicit, false, 0)[0]).toMatch(/deletes the table's history/)
  })

  it('drops declared period columns along with system versioning', () => {
    const draft = load(explicitTable)
    expect(versionedTableStatements(draft, {}, explicit, false)).toEqual([
      'SET SESSION system_versioning_alter_history = KEEP',
      'ALTER TABLE `app`.`prices`\n  DROP SYSTEM VERSIONING,\n  DROP PERIOD FOR SYSTEM_TIME,\n  DROP COLUMN `valid_from`,\n  DROP COLUMN `valid_to`'
    ])
    // Marking them dropped as well doesn't drop them twice
    for (const c of draft.columns) if (c.name.startsWith('valid_')) c.dropped = true
    expect(versionedTableStatements(draft, {}, explicit, false).join('\n')).not.toMatch(
      /DROP COLUMN `valid_from`[\s\S]*DROP COLUMN `valid_from`/
    )
    expect(versioningWarnings(draft, explicit, false, 0)[0]).toMatch(/valid_from and valid_to/)
  })

  it('alters a versioned table with history kept, leaving the period columns alone', () => {
    const draft = load(explicitTable)
    expect(versionedTableStatements(draft, {}, explicit, true)).toEqual([])
    draft.columns.push(newColumn('mysql', { name: 'currency', dataType: 'char(3)' }))
    const price = draft.columns.find((c) => c.name === 'price')!
    price.dataType = 'decimal(12,2)'
    const statements = versionedTableStatements(draft, {}, explicit, true)
    expect(statements[0]).toBe('SET SESSION system_versioning_alter_history = KEEP')
    expect(statements).toHaveLength(2)
    expect(statements[1]).toMatch(/MODIFY COLUMN `price` decimal\(12,2\)/)
    expect(statements[1]).toMatch(/ADD COLUMN `currency` char\(3\)/)
    expect(statements[1]).not.toMatch(/valid_|PRIMARY KEY/)
    expect(versioningWarnings(draft, explicit, true, 2)[0]).toMatch(/history rows change/)
  })

  it("won't drop a period column while versioning stays on", () => {
    const draft = load(explicitTable)
    draft.columns.find((c) => c.name === 'valid_from')!.dropped = true
    expect(versioningProblem(draft, explicit, true)).toMatch(/turn off system versioning/)
    expect(versioningProblem(draft, explicit, false)).toBeNull()
    expect(versionedTableStatements(draft, {}, explicit, true)).toEqual([])
  })

  it('never sees the implicit period columns', () => {
    const draft = load(implicitTable)
    expect(draft.columns.map((c) => c.name)).toEqual(['id', 'price'])
    expect(versioningProblem(draft, implicit, true)).toBeNull()
  })
})
