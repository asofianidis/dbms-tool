import { describe, expect, it } from 'vitest'
import {
  buildOrderBy,
  buildWhere,
  columnKind,
  conditionSql,
  describeCondition,
  newCondition,
  operatorsFor,
  type QueryState
} from '../filters'

const query = (patch: Partial<QueryState>): QueryState => ({
  match: 'all',
  conditions: [],
  sorts: [],
  ...patch
})

describe('columnKind', () => {
  it('groups column types', () => {
    expect(columnKind('character varying(20)')).toBe('text')
    expect(columnKind('nvarchar(max)')).toBe('text')
    expect(columnKind('numeric(10,2)')).toBe('number')
    expect(columnKind('timestamp with time zone')).toBe('date')
    expect(columnKind('bit')).toBe('boolean')
    expect(columnKind('jsonb')).toBe('other')
    expect(operatorsFor('boolean')).toEqual(['true', 'false', 'null', 'not_null'])
  })
})

describe('conditionSql', () => {
  it('compares with typed literals', () => {
    const c = newCondition({ column: 'qty', op: 'gte', value: '5' })
    expect(conditionSql('postgres', c, 'integer')).toBe('qty >= 5')
    expect(conditionSql('tsql', { ...c, op: 'eq', value: "O'Brien" }, 'nvarchar(50)')).toBe(
      "[qty] = N'O''Brien'"
    )
  })

  it('builds case-insensitive LIKE with escaped wildcards', () => {
    const c = newCondition({ column: 'name', op: 'contains', value: '50%_off!' })
    expect(conditionSql('postgres', c, 'text')).toBe(`name::text COLLATE "default" ILIKE '%50!%!_off!!%' ESCAPE '!'`)
    expect(conditionSql('mysql', { ...c, op: 'starts', value: 'a\\b' }, 'varchar(9)')).toBe(
      "`name` LIKE 'a\\\\b%' ESCAPE '!'"
    )
    expect(conditionSql('tsql', { ...c, op: 'not_contains', value: '[x]' }, 'nvarchar(9)')).toBe(
      "[name] NOT LIKE '%![x]%' ESCAPE '!'"
    )
  })

  it('handles lists, ranges, NULL and booleans', () => {
    expect(
      conditionSql('postgres', newCondition({ column: 'id', op: 'in', value: '1, 2,,3' }), 'int')
    ).toBe('id IN (1, 2, 3)')
    expect(
      conditionSql(
        'mysql',
        newCondition({ column: 'd', op: 'between', value: '2024-01-01', value2: '2024-12-31' }),
        'date'
      )
    ).toBe("`d` BETWEEN '2024-01-01' AND '2024-12-31'")
    expect(conditionSql('tsql', newCondition({ column: 'x', op: 'null' }))).toBe('[x] IS NULL')
    expect(conditionSql('tsql', newCondition({ column: 'ok', op: 'true' }), 'bit')).toBe('[ok] = 1')
    expect(conditionSql('postgres', newCondition({ column: 'ok', op: 'false' }), 'boolean')).toBe(
      'ok IS FALSE'
    )
  })

  it('skips incomplete conditions, except = empty text', () => {
    expect(conditionSql('postgres', newCondition({ column: 'n', op: 'gt' }), 'int')).toBeNull()
    expect(conditionSql('postgres', newCondition({ column: 'n', op: 'eq' }), 'int')).toBeNull()
    expect(conditionSql('postgres', newCondition({ column: 's', op: 'eq' }), 'text')).toBe("s = ''")
    expect(
      conditionSql('postgres', newCondition({ column: 'n', op: 'between', value: '1' }), 'int')
    ).toBeNull()
    expect(conditionSql('postgres', newCondition({ kind: 'sql', sql: '  ' }))).toBeNull()
  })
})

describe('buildWhere / buildOrderBy', () => {
  it('joins enabled conditions with AND or OR', () => {
    const conditions = [
      newCondition({ column: 'a', op: 'eq', value: '1' }),
      newCondition({ column: 'b', op: 'null', enabled: false }),
      newCondition({ kind: 'sql', sql: 'c > 2 OR c < 0' })
    ]
    const types = { a: 'integer' }
    expect(buildWhere('postgres', query({ conditions }), types)).toBe('a = 1 AND (c > 2 OR c < 0)')
    expect(buildWhere('postgres', query({ conditions, match: 'any' }), types)).toBe(
      'a = 1 OR (c > 2 OR c < 0)'
    )
    expect(buildWhere('postgres', query({}))).toBe('')
  })

  it('orders by several columns', () => {
    expect(
      buildOrderBy('mysql', [
        { column: 'last', dir: 'asc' },
        { column: 'created', dir: 'desc' }
      ])
    ).toBe('`last` ASC, `created` DESC')
  })

  it('describes conditions for chips', () => {
    expect(
      describeCondition(newCondition({ column: 'n', op: 'between', value: '1', value2: '9' }))
    ).toBe('n between 1 – 9')
    expect(describeCondition(newCondition({ column: 'n', op: 'null' }))).toBe('n is NULL')
  })
})

describe('bit column filters', () => {
  it('compares PostgreSQL bits with bit strings', () => {
    expect(conditionSql('postgres', newCondition({ column: 'on', op: 'true' }), 'bit(1)')).toBe(
      `"on" = B'1'`
    )
    expect(columnKind('bit(3)')).toBe('other')
    expect(columnKind('bit varying(8)')).toBe('other')
    expect(
      conditionSql('postgres', newCondition({ column: 'flags', value: '101' }), 'bit(3)')
    ).toBe("flags = B'101'")
    expect(conditionSql('mysql', newCondition({ column: 'ok', op: 'true' }), 'bit(1)')).toBe(
      '`ok` IS TRUE'
    )
  })
})
