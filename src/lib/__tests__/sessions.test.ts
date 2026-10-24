import { describe, expect, it } from 'vitest'
import {
  blockedCount,
  blockingEdges,
  blockingIds,
  blockingTree,
  mongoOpId,
  sessionActionSql,
  sessionActions,
  type BlockingNode
} from '../sessions'

describe('session actions', () => {
  it('offers cancel only where the engine has it', () => {
    expect(sessionActions('postgres')).toEqual(['cancel', 'kill'])
    expect(sessionActions('mssql')).toEqual(['kill'])
    expect(sessionActions('sqlite')).toEqual([])
  })

  it('builds the statement per engine', () => {
    expect(sessionActionSql('postgres', 'cancel', '42')).toBe('SELECT pg_cancel_backend(42)')
    expect(sessionActionSql('postgres', 'kill', '42')).toBe('SELECT pg_terminate_backend(42)')
    expect(sessionActionSql('mysql', 'cancel', '7')).toBe('KILL QUERY 7')
    expect(sessionActionSql('babelfish', 'kill', '55')).toBe('KILL 55')
    expect(sessionActionSql('mssql', 'cancel', '55')).toBeNull()
  })

  it('refuses ids that are not session numbers', () => {
    expect(sessionActionSql('mysql', 'kill', '1; DROP TABLE t')).toBeNull()
    expect(sessionActionSql('mysql', 'kill', null)).toBeNull()
  })

  it('reads MongoDB operation ids', () => {
    expect(mongoOpId('123')).toBe(123)
    expect(mongoOpId('shard01:456')).toBe('shard01:456')
    expect(mongoOpId(null)).toBeNull()
  })
})

describe('blocking', () => {
  const columns = [
    { name: 'pid', typeName: 'int4' },
    { name: 'blocked_by', typeName: 'text' }
  ]
  const rows = [
    ['1', ''],
    ['2', '1'],
    ['3', '1, 2'],
    ['4', null]
  ]

  it('counts blocked sessions and names the blockers', () => {
    expect(blockedCount('postgres', columns, rows)).toBe(2)
    expect([...blockingIds('postgres', columns, rows)].sort()).toEqual(['1', '2'])
  })

  it('treats 0 as not blocked (sysprocesses)', () => {
    const cols = [
      { name: 'spid', typeName: 'int' },
      { name: 'blocked', typeName: 'int' }
    ]
    expect(
      blockedCount('babelfish', cols, [
        ['5', '0'],
        ['6', '5']
      ])
    ).toBe(1)
  })
})

describe('blocking tree', () => {
  const shape = (nodes: BlockingNode[]): unknown =>
    nodes.map((n) =>
      n.children.length ? { [n.id]: shape(n.children) } : n.cycle ? `${n.id}*` : n.id
    )

  it('reads waiter and blocker pairs, skipping self and empty blockers', () => {
    const columns = [
      { name: 'pid', typeName: 'int4' },
      { name: 'blocked_by', typeName: 'text' }
    ]
    expect(
      blockingEdges(
        columns,
        [
          ['1', ''],
          ['2', '1'],
          ['3', '{1,2}'],
          ['3', '1'],
          ['4', '4'],
          ['5', '0']
        ],
        'pid',
        'blocked_by'
      )
    ).toEqual([
      ['2', '1'],
      ['3', '1'],
      ['3', '2']
    ])
  })

  it('roots chains at sessions that wait on no one', () => {
    const forest = blockingTree([
      ['2', '1'],
      ['3', '2'],
      ['10', '1'],
      ['7', '6']
    ])
    expect(shape(forest)).toEqual([{ 1: [{ 2: ['3'] }, '10'] }, { 6: ['7'] }])
  })

  it('shows a deadlock cycle once, marked', () => {
    const forest = blockingTree([
      ['1', '2'],
      ['2', '1']
    ])
    expect(shape(forest)).toEqual([{ 1: [{ 2: ['1*'] }] }])
    expect(forest[0].children[0].children[0].cycle).toBe(true)
  })
})
