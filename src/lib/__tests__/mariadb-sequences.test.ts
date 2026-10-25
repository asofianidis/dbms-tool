import { describe, expect, it } from 'vitest'
import type { ExecOutput } from '../api'
import { compareSnapshots, type CompareContext, type SnapshotObject } from '../compare'
import {
  parseSequenceDdl,
  parseSequenceState,
  sequenceAlterStatements,
  sequenceScript,
  sequenceStateSql,
  sequenceTemplate
} from '../mariadb-sequences'

// As MariaDB 11.8 reports them
const DDL =
  'CREATE SEQUENCE `s1` start with 10 minvalue 1 maxvalue 1000 increment by 5 cache 20 cycle ENGINE=InnoDB'
const INT_DDL =
  'CREATE SEQUENCE `s1` as int start with 10 minvalue 1 maxvalue 1000 increment by 5 cache 20 cycle ENGINE=InnoDB'

const output = (columns: string[], rows: (string | null)[][]): ExecOutput => ({
  results: [
    {
      columns: columns.map((name) => ({ name, typeName: 'bigint' })),
      rows,
      rowCount: rows.length,
      truncated: false
    }
  ],
  messages: [],
  error: null,
  elapsedMs: 1,
  cancelled: false,
  database: null,
  inTransaction: null
})

const STATE_COLUMNS = [
  'next_not_cached_value',
  'minimum_value',
  'maximum_value',
  'start_value',
  'increment',
  'cache_size',
  'cycle_option',
  'cycle_count'
]

const ref = { schema: 'app', name: 'order no' }

describe('MariaDB sequence state', () => {
  it('reads the row SELECT * returns', () => {
    expect(sequenceStateSql(ref)).toBe('SELECT * FROM `app`.`order no`')
    const state = parseSequenceState(
      output(STATE_COLUMNS, [['110', '1', '9223372036854775806', '10', '5', '20', '1', '0']])
    )
    expect(state).toEqual({
      nextNotCached: '110',
      minimum: '1',
      maximum: '9223372036854775806',
      start: '10',
      increment: '5',
      cache: '20',
      cycle: true,
      cycleCount: '0'
    })
    expect(parseSequenceState(output(STATE_COLUMNS, []))).toBeNull()
  })
})

describe('MariaDB sequence scripts', () => {
  const state = parseSequenceState(
    output(STATE_COLUMNS, [['110', '1', '1000', '10', '5', '20', '0', '0']])
  )

  it('builds NEXTVAL, SETVAL, RESTART and ALTER from the state', () => {
    expect(sequenceScript('nextval', ref, null)).toBe('SELECT NEXTVAL(`app`.`order no`);')
    expect(sequenceScript('setval', ref, state)).toContain('SELECT SETVAL(`app`.`order no`, 110);')
    expect(sequenceScript('restart', ref, state)).toBe(
      'ALTER SEQUENCE `app`.`order no` RESTART WITH 10;'
    )
    expect(sequenceScript('alter', ref, state)).toBe(
      'ALTER SEQUENCE `app`.`order no`\n  INCREMENT BY 5\n  MINVALUE 1\n  MAXVALUE 1000\n  CACHE 20\n  NOCYCLE;'
    )
  })

  it('falls back to placeholders without a state', () => {
    expect(sequenceScript('setval', ref, null)).toContain('SETVAL(`app`.`order no`, 1)')
    expect(sequenceScript('restart', ref, null)).toContain('RESTART WITH 1;')
  })

  it('has a template for a new sequence', () => {
    expect(sequenceTemplate()).toMatch(/^CREATE SEQUENCE new_sequence\n[\s\S]*NOCYCLE;$/)
  })
})

describe('MariaDB sequence definitions', () => {
  it('splits SHOW CREATE SEQUENCE into type and options', () => {
    expect(parseSequenceDdl(DDL)).toEqual({
      type: null,
      options: 'start with 10 minvalue 1 maxvalue 1000 increment by 5 cache 20 cycle'
    })
    expect(parseSequenceDdl(INT_DDL)?.type).toBe('int')
    expect(parseSequenceDdl('CREATE SEQUENCE `a``b` start with 1 nocache nocycle')?.options).toBe(
      'start with 1 nocache nocycle'
    )
    expect(parseSequenceDdl('CREATE TABLE t (id int)')).toBeNull()
  })

  it('alters the options, and the type in a statement of its own', () => {
    const target = '`prod`.`s1`'
    const older = DDL.replace('increment by 5', 'increment by 1')
    expect(sequenceAlterStatements(target, DDL, older)).toEqual([
      'ALTER SEQUENCE `prod`.`s1` start with 10 minvalue 1 maxvalue 1000 increment by 5 cache 20 cycle'
    ])
    expect(sequenceAlterStatements(target, INT_DDL, DDL)).toEqual([
      'ALTER SEQUENCE `prod`.`s1` AS int'
    ])
    expect(sequenceAlterStatements(target, DDL, null)).toBeNull()
  })
})

describe('compareSnapshots: MariaDB sequences', () => {
  const seq = (definition: string): SnapshotObject => ({
    schema: null,
    name: 's1',
    kind: 'sequence',
    detail: null,
    definition
  })
  const ctx = (source: SnapshotObject[], target: SnapshotObject[]): CompareContext => ({
    dialect: 'mysql',
    scope: 'database',
    source: { database: 'dev', schema: null, schemas: [], objects: source },
    target: { database: 'prod', schema: null, schemas: [], objects: target }
  })

  it('alters a changed sequence instead of recreating it', () => {
    const [item] = compareSnapshots(ctx([seq(DDL)], [seq(DDL.replace('cache 20', 'cache 1000'))]))
    expect(item.action).toBe('alter')
    expect(item.steps.map((s) => s.sql)).toEqual([
      'ALTER SEQUENCE `prod`.`s1` start with 10 minvalue 1 maxvalue 1000 increment by 5 cache 20 cycle'
    ])
  })

  it('creates and drops sequences', () => {
    const [created] = compareSnapshots(ctx([seq(DDL)], []))
    expect(created.action).toBe('create')
    expect(created.steps.map((s) => s.sql)).toEqual([DDL])
    const [dropped] = compareSnapshots(ctx([], [seq(DDL)]))
    expect(dropped.steps.map((s) => s.sql)).toEqual(['DROP SEQUENCE `prod`.`s1`'])
  })
})
