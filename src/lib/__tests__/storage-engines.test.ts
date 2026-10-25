import { describe, expect, it } from 'vitest'
import type { ForeignKeyInfo } from '../api'
import {
  newColumn,
  newForeignKey,
  newIndex,
  newTableDraft,
  tableStatements,
  type TableDraft
} from '../ddl'
import {
  countOptionChanges,
  DEFAULT_TABLE_OPTIONS,
  engineTraits,
  inboundKeysSql,
  optionsFromStorage,
  parseCollations,
  parseEngines,
  parseTableStorage,
  rowFormatChoices,
  tableOptionClauses,
  tableOptionProblem,
  tableOptionWarnings,
  withEngine,
  withTableOptions,
  type OptionsContext,
  type TableOptions
} from '../storage-engines'

// What MariaDB 11.8 reports from information_schema.ENGINES
const engines = parseEngines([
  ['MEMORY', 'YES', 'Hash based, stored in memory', 'NO'],
  ['CSV', 'YES', 'Stores tables as CSV files', 'NO'],
  ['PERFORMANCE_SCHEMA', 'YES', 'Performance Schema', 'NO'],
  ['Aria', 'YES', 'Crash-safe tables with MyISAM heritage', 'NO'],
  ['MyISAM', 'YES', 'Non-transactional engine', 'NO'],
  ['InnoDB', 'DEFAULT', 'Supports transactions, row-level locking, foreign keys', 'YES'],
  ['SEQUENCE', 'YES', 'Generated tables filled with sequential values', 'YES'],
  ['ROCKSDB', 'YES', 'RocksDB storage engine', 'YES']
])

const collations = parseCollations([
  ['utf8mb4_uca1400_ai_ci', 'utf8mb4'],
  ['utf8mb4_bin', 'utf8mb4'],
  ['latin1_swedish_ci', 'latin1'],
  ['uca1400_ai_ci', null]
])

const options = (patch: Partial<TableOptions>): TableOptions => ({
  ...DEFAULT_TABLE_OPTIONS,
  ...patch
})

const innodb = options({
  engine: 'InnoDB',
  charset: 'utf8mb4',
  collation: 'utf8mb4_uca1400_ai_ci'
})

/** An existing table `shop`.`orders` with one column. */
function existing(patch: Partial<TableDraft> = {}): TableDraft {
  const id = newColumn('mysql', { name: 'id', dataType: 'int', nullable: false })
  return {
    ...newTableDraft('mysql', 'shop'),
    name: 'orders',
    columns: [{ ...id, original: { ...id } }],
    primaryKey: [id.id],
    original: { name: 'orders', primaryKey: [id.id], primaryKeyName: 'PRIMARY' },
    ...patch
  }
}

const loadedFk = () => ({
  ...newForeignKey({
    name: 'fk_customer',
    refTable: 'customers',
    columns: ['x'],
    refColumns: ['id']
  }),
  original: { name: 'fk_customer' } as ForeignKeyInfo
})

const context = (patch: Partial<OptionsContext> = {}): OptionsContext => ({
  engines,
  original: innodb,
  inbound: [],
  ...patch
})

describe('engine list', () => {
  it('puts the default first and leaves out engines that hold no user tables', () => {
    expect(engines.map((e) => e.name)).toEqual([
      'InnoDB',
      'Aria',
      'CSV',
      'MEMORY',
      'MyISAM',
      'ROCKSDB'
    ])
    expect(engines[0]).toMatchObject({ isDefault: true, transactional: true })
  })

  it('knows what each engine can do', () => {
    expect(engineTraits('InnoDB', engines)).toMatchObject({
      transactional: true,
      foreignKeys: 'enforced',
      fullText: true
    })
    expect(engineTraits('Aria', engines)).toMatchObject({
      transactional: false,
      foreignKeys: 'ignored',
      fullText: true
    })
    expect(engineTraits('ROCKSDB', engines)).toMatchObject({
      transactional: true,
      foreignKeys: 'rejected',
      fullText: false
    })
    expect(engineTraits('MEMORY').blobs).toBe(false)
    expect(engineTraits('CSV')).toMatchObject({ nullable: false, indexes: false })
    // Unknown engines (Spider, ColumnStore, CONNECT…) get the cautious answer
    expect(engineTraits('SPIDER')).toMatchObject({ transactional: false, foreignKeys: 'ignored' })
    // TRANSACTIONS from the server wins over the built-in list
    expect(
      engineTraits('NEWENGINE', [
        { name: 'NEWENGINE', isDefault: false, comment: '', transactional: true }
      ]).transactional
    ).toBe(true)
  })

  it('offers each engine its own row formats', () => {
    expect(rowFormatChoices('InnoDB', '')).toEqual([
      'DYNAMIC',
      'COMPACT',
      'REDUNDANT',
      'COMPRESSED'
    ])
    expect(rowFormatChoices('Aria', '')).toEqual(['PAGE', 'DYNAMIC', 'FIXED'])
    expect(rowFormatChoices('CSV', '')).toEqual([])
    expect(rowFormatChoices('MyISAM', 'COMPRESSED')).toEqual(['DYNAMIC', 'FIXED', 'COMPRESSED'])
    // Switching engines drops a format the new one doesn't take
    expect(
      withEngine(options({ engine: 'InnoDB', rowFormat: 'COMPACT' }), 'Aria', engines).rowFormat
    ).toBe('')
    expect(
      withEngine(options({ engine: 'MyISAM', rowFormat: 'DYNAMIC' }), 'Aria', engines).rowFormat
    ).toBe('DYNAMIC')
  })
})

describe('reading a table back', () => {
  it('parses information_schema.TABLES and finds the explicit row format', () => {
    const storage = parseTableStorage([
      ['InnoDB', 'Compact', 'row_format=COMPACT', 'utf8mb4_uca1400_ai_ci', '16384', '32768', '12']
    ])
    expect(storage).toEqual({
      engine: 'InnoDB',
      rowFormat: 'Compact',
      explicitRowFormat: 'COMPACT',
      collation: 'utf8mb4_uca1400_ai_ci',
      dataLength: 16384,
      indexLength: 32768,
      rows: 12
    })
    expect(optionsFromStorage(storage!, collations)).toEqual({
      engine: 'InnoDB',
      charset: 'utf8mb4',
      collation: 'utf8mb4_uca1400_ai_ci',
      rowFormat: 'COMPACT'
    })
    // Aria reports its implied format in ROW_FORMAT, not CREATE_OPTIONS
    expect(
      parseTableStorage([
        ['Aria', 'Page', 'transactional=1', 'latin1_swedish_ci', '8192', '8192', '0']
      ])?.explicitRowFormat
    ).toBe('')
    // Views have no engine
    expect(parseTableStorage([[null, null, null, null, null, null, null]])).toBeNull()
    expect(parseTableStorage([])).toBeNull()
  })

  it('skips self-references when looking for inbound foreign keys', () => {
    expect(inboundKeysSql('shop', 'orders')).toContain(
      "NOT (CONSTRAINT_SCHEMA = 'shop' AND TABLE_NAME = 'orders')"
    )
  })
})

describe('table option DDL', () => {
  it('appends options to CREATE TABLE and leaves defaults out', () => {
    const draft = { ...newTableDraft('mysql', 'shop'), name: 'events' }
    const plain = tableStatements('mysql', draft)
    expect(withTableOptions(plain, draft, DEFAULT_TABLE_OPTIONS, null)).toEqual(plain)
    const out = withTableOptions(
      plain,
      draft,
      options({ engine: 'Aria', charset: 'utf8mb4', collation: 'utf8mb4_bin', rowFormat: 'PAGE' }),
      null
    )
    expect(out[0]).toMatch(
      /\n\) ENGINE=Aria DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin ROW_FORMAT=PAGE$/
    )
  })

  it('alters only what changed, after the other changes and before a rename', () => {
    const draft = existing({ name: 'orders_old' })
    const out = withTableOptions(
      tableStatements('mysql', draft),
      draft,
      { ...innodb, engine: 'Aria' },
      innodb
    )
    expect(out).toEqual([
      'ALTER TABLE `shop`.`orders`\n  ENGINE=Aria',
      'RENAME TABLE `shop`.`orders` TO `shop`.`orders_old`'
    ])
    expect(tableOptionClauses(innodb, innodb)).toEqual([])
    expect(tableOptionClauses({ ...innodb, charset: 'latin1', collation: '' }, innodb)).toEqual([
      'DEFAULT CHARACTER SET latin1'
    ])
    expect(tableOptionClauses({ ...innodb, collation: 'utf8mb4_bin' }, innodb)).toEqual([
      'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin'
    ])
    // Back to the default row format
    expect(tableOptionClauses(innodb, { ...innodb, rowFormat: 'COMPACT' })).toEqual([
      'ROW_FORMAT=DEFAULT'
    ])
    expect(countOptionChanges({ ...innodb, engine: 'MyISAM', rowFormat: 'FIXED' }, innodb)).toBe(2)
    expect(countOptionChanges(innodb, null)).toBe(0)
  })

  it('waits for the loaded options before altering an existing table', () => {
    const draft = existing()
    expect(withTableOptions([], draft, { ...innodb, engine: 'Aria' }, null)).toEqual([])
  })
})

describe('engine change checks', () => {
  it('warns that a change rebuilds the table and loses transactions', () => {
    const warnings = tableOptionWarnings(existing(), { ...innodb, engine: 'MyISAM' }, context())
    expect(warnings).toContain(
      'Changing the engine to MyISAM rebuilds the table, copying every row'
    )
    expect(warnings).toContain(
      "MyISAM has no transactions or foreign keys: writes can't be rolled back"
    )
    expect(tableOptionWarnings(existing(), innodb, context())).toEqual([])
    expect(tableOptionWarnings(existing(), { ...innodb, rowFormat: 'COMPACT' }, context())).toEqual(
      ['Changing the row format rebuilds the table, copying every row']
    )
  })

  it('blocks moving a table with foreign keys off InnoDB until they are dropped', () => {
    const fk = loadedFk()
    const draft = existing({ foreignKeys: [fk] })
    const aria = { ...innodb, engine: 'Aria' }
    expect(tableOptionProblem(draft, aria, context())).toBe(
      "Drop foreign keys fk_customer first: a table with foreign keys can't change to Aria"
    )
    expect(
      tableOptionProblem(existing({ foreignKeys: [{ ...fk, dropped: true }] }), aria, context())
    ).toBeNull()
    expect(
      tableOptionProblem(
        existing(),
        aria,
        context({ inbound: [{ table: 'items', name: 'fk_order' }] })
      )
    ).toBe('Referenced by items.fk_order; drop those foreign keys before changing to Aria')
    expect(tableOptionProblem(draft, innodb, context())).toBeNull()
  })

  it('flags foreign keys an engine ignores or rejects', () => {
    const draft = {
      ...newTableDraft('mysql', 'shop'),
      name: 't',
      foreignKeys: [newForeignKey({ name: 'fk_a' })]
    }
    const create = context({ original: null })
    expect(tableOptionWarnings(draft, options({ engine: 'MyISAM' }), create)).toContain(
      "MyISAM won't enforce foreign key fk_a; the server accepts and ignores it"
    )
    expect(tableOptionProblem(draft, options({ engine: 'ROCKSDB' }), create)).toBe(
      "ROCKSDB doesn't support foreign keys; drop fk_a"
    )
    // The server default (InnoDB) enforces them
    expect(tableOptionWarnings(draft, DEFAULT_TABLE_OPTIONS, create)).toEqual([])
  })

  it('checks full-text indexes and engine-specific column limits', () => {
    const body = newColumn('mysql', { name: 'body', dataType: 'text' })
    const draft = {
      ...newTableDraft('mysql', 'shop'),
      name: 'notes',
      columns: [...newTableDraft('mysql', 'shop').columns, body],
      indexes: [newIndex({ name: 'ft_body', columns: [body.id], method: 'FULLTEXT' })]
    }
    const create = context({ original: null })
    expect(tableOptionProblem(draft, options({ engine: 'ROCKSDB' }), create)).toBe(
      "ROCKSDB doesn't support FULLTEXT indexes like ft_body"
    )
    expect(tableOptionProblem(draft, options({ engine: 'Aria' }), create)).toBeNull()
    expect(tableOptionWarnings(draft, options({ engine: 'MEMORY' }), create)).toContain(
      'MEMORY has no TEXT / BLOB columns, so body fails'
    )
    expect(tableOptionWarnings(draft, options({ engine: 'CSV' }), create)).toEqual(
      expect.arrayContaining([
        'CSV needs every column NOT NULL',
        "CSV doesn't support indexes or primary keys"
      ])
    )
  })
})
