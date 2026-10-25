import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableInfo } from '../api'
import { deleteRow, editRow, rowKeyOf, toRowEdits, type PendingChange } from '../pending'
import {
  expectOneRow,
  isPhysical,
  locatedEditScript,
  locatedEditStatements,
  parseRowLocator,
  ROW_CHANGED_MESSAGE,
  rowLocatorNote,
  rowLocatorSql,
  withRowLocator
} from '../row-locator'
import { selectRows, splitStatements } from '../sql'

const column = (name: string, dataType: string): ColumnInfo => ({
  name,
  dataType,
  nullable: true,
  default: null,
  isPrimaryKey: false,
  isGenerated: false,
  isIdentity: false,
  comment: null,
  extra: null
})

const info: TableInfo = {
  columns: [column('a', 'integer'), column('b', 'text')],
  primaryKey: [],
  indexes: [],
  foreignKeys: [],
  triggers: []
}
const ref = { schema: 'public', name: 'nopk' }

describe('parseRowLocator', () => {
  it('prefers a unique NOT NULL key', () => {
    expect(parseRowLocator([['r', '["id", "code"]', 'uq_id']])).toEqual({
      kind: 'unique',
      columns: ['id', 'code'],
      hidden: [],
      index: 'uq_id'
    })
  })

  it('falls back to ctid, with tableoid for partitioned tables', () => {
    expect(parseRowLocator([['r', null, null]])).toMatchObject({
      kind: 'ctid',
      columns: ['ctid'],
      hidden: ['ctid']
    })
    expect(parseRowLocator([['p', null, null]])).toMatchObject({
      kind: 'partition-ctid',
      columns: ['tableoid', 'ctid'],
      hidden: ['tableoid', 'ctid']
    })
  })

  it('locates nothing in views, foreign tables or a missing table', () => {
    for (const kind of ['v', 'm', 'f']) expect(parseRowLocator([[kind, null, null]])).toBeNull()
    expect(parseRowLocator([])).toBeNull()
  })

  it('quotes the names in the catalog query', () => {
    const sql = rowLocatorSql("o'neil", 'My Table')
    expect(sql).toContain("c.relname = 'My Table' AND n.nspname = 'o''neil'")
  })
})

describe('editing by ctid', () => {
  const locator = parseRowLocator([['r', null, null]])!
  const keyed = withRowLocator(info, locator)
  const row = { ctid: '(0,2)', a: '1', b: 'x' }

  it('stands the locator in for the primary key, and only without one', () => {
    expect(keyed.primaryKey).toEqual(['ctid'])
    expect(withRowLocator({ ...info, primaryKey: ['a'] }, locator).primaryKey).toEqual(['a'])
    expect(withRowLocator(info, null)).toBe(info)
  })

  it('selects the hidden columns ahead of the table', () => {
    expect(selectRows('postgres', ref, { limit: 101, leadingColumns: locator.hidden })).toBe(
      'SELECT ctid, *\nFROM public.nopk\nLIMIT 101'
    )
    expect(selectRows('postgres', ref, { limit: 101 })).toBe(
      'SELECT *\nFROM public.nopk\nLIMIT 101'
    )
  })

  it('guards updates and deletes so a stale ctid rolls the commit back', () => {
    let changes: PendingChange[] = []
    changes = editRow(changes, keyed.primaryKey, row, 'b', "it's")
    changes = deleteRow(changes, keyed.primaryKey, { ctid: '(0,3)', a: '2', b: 'y' })
    changes = [
      ...changes,
      { id: 'i', kind: 'insert', rowKey: null, original: null, values: { a: '3' } }
    ]
    expect(changes[0].rowKey).toBe(rowKeyOf(['ctid'], row))
    const statements = locatedEditStatements('postgres', ref, keyed, toRowEdits(changes), locator)
    // Deletes run first
    expect(statements).toEqual([
      expectOneRow("DELETE FROM public.nopk WHERE ctid = '(0,3)'"),
      expectOneRow("UPDATE public.nopk SET b = 'it''s' WHERE ctid = '(0,2)'"),
      'INSERT INTO public.nopk (a) VALUES (3)'
    ])
    // The exact script integration_tests.rs runs against a live server
    expect(statements[0]).toBe(
      `DO $dbms_edit$
DECLARE dbms_rows bigint;
BEGIN
  DELETE FROM public.nopk WHERE ctid = '(0,3)';
  GET DIAGNOSTICS dbms_rows = ROW_COUNT;
  IF dbms_rows <> 1 THEN
    RAISE EXCEPTION 'Row changed since it was loaded (it was updated, deleted or moved); refresh and retry';
  END IF;
END
$dbms_edit$`
    )
    const script = locatedEditScript('postgres', ref, keyed, toRowEdits(changes), locator)
    // BEGIN, three statements, COMMIT: the DO bodies don't split
    expect(splitStatements(script, 'postgres')).toHaveLength(5)
  })

  it('locates partitioned rows by tableoid and ctid', () => {
    const parted = parseRowLocator([['p', null, null]])!
    const edits = toRowEdits(
      editRow([], parted.columns, { tableoid: '16402', ctid: '(0,1)', a: '1', b: 'x' }, 'b', 'y')
    )
    expect(
      locatedEditStatements('postgres', ref, withRowLocator(info, parted), edits, parted)
    ).toEqual([
      expectOneRow("UPDATE public.nopk SET b = 'y' WHERE tableoid = '16402' AND ctid = '(0,1)'")
    ])
  })

  it('picks a dollar-quote tag the statement does not contain', () => {
    const guarded = expectOneRow("UPDATE t SET b = '$dbms_edit$' WHERE ctid = '(0,1)'")
    expect(guarded.startsWith('DO $dbms_edit1$\n')).toBe(true)
    expect(guarded.endsWith('\n$dbms_edit1$')).toBe(true)
    expect(guarded).toContain(ROW_CHANGED_MESSAGE)
  })

  it('leaves unique keys and other dialects unguarded', () => {
    const unique = parseRowLocator([['r', '["a"]', 'uq']])!
    const edits = toRowEdits(editRow([], ['a'], { a: '1', b: 'x' }, 'b', 'y'))
    expect(
      locatedEditStatements('postgres', ref, withRowLocator(info, unique), edits, unique)
    ).toEqual(["UPDATE public.nopk SET b = 'y' WHERE a = 1"])
    expect(isPhysical(unique)).toBe(false)
    expect(
      locatedEditStatements('tsql', ref, { ...info, primaryKey: ['a'] }, edits, locator)
    ).toEqual(["UPDATE [public].[nopk] SET [b] = 'y' WHERE [a] = 1"])
  })

  it('describes how rows are edited', () => {
    expect(rowLocatorNote(locator)).toBe('editing by row location (ctid)')
    expect(rowLocatorNote(parseRowLocator([['r', '["a","b"]', 'uq']]))).toBe(
      'editing by unique key (a, b)'
    )
    expect(rowLocatorNote(null)).toBeNull()
  })
})
