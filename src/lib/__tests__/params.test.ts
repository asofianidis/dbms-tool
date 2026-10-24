import { describe, expect, it } from 'vitest'
import { fillParams, findParams, paramNames, sourceOffset, substituteParams } from '../params'
import { beginSql, commitSql, rollbackSql } from '../transactions'

describe('findParams', () => {
  it('finds :name and ${name} placeholders', () => {
    expect(
      paramNames('SELECT * FROM t WHERE a = :id AND b = ${ name } OR c = :id', 'postgres')
    ).toEqual(['id', 'name'])
  })

  it('skips casts, assignments, slices and labels', () => {
    expect(paramNames('SELECT x::text, arr[1:n], a[i:j] FROM t', 'postgres')).toEqual([])
    expect(paramNames('SET @a := 1', 'mysql')).toEqual([])
    expect(paramNames('retry:\n  GOTO retry', 'tsql')).toEqual([])
  })

  it('skips strings, identifiers, comments and dollar quotes', () => {
    const sql = `SELECT ':a', ":b", \`:c\` -- :e
/* :f */ $$ :g $$, $fn$ :h $fn$ FROM t WHERE x = :real`
    expect(paramNames(sql, 'postgres')).toEqual(['real'])
    expect(paramNames("SELECT 'it\\'s :not' WHERE y = :yes # :no", 'mysql')).toEqual(['yes'])
    expect(paramNames('SELECT [:x] WHERE z = :z', 'tsql')).toEqual(['z'])
  })

  it('reports positions', () => {
    expect(findParams('a = :x', 'postgres')).toEqual([{ name: 'x', from: 4, to: 6 }])
  })

  it('counts a parameter after an opening bracket or operator', () => {
    expect(paramNames('IN (:a,:b) AND c>:c', 'sqlite')).toEqual(['a', 'b', 'c'])
  })
})

describe('substituteParams', () => {
  it('quotes text and keeps numbers', () => {
    const out = substituteParams(
      "WHERE name = :name AND age > :age AND note = ':name'",
      'postgres',
      { name: { value: "O'Brien", mode: 'auto' }, age: { value: '42', mode: 'auto' } }
    )
    expect(out).toBe("WHERE name = 'O''Brien' AND age > 42 AND note = ':name'")
  })

  it('honours text and raw modes', () => {
    const values = {
      zip: { value: '007', mode: 'text' as const },
      d: { value: 'now()', mode: 'raw' as const }
    }
    expect(substituteParams('x = :zip AND y < ${d}', 'postgres', values)).toBe(
      "x = '007' AND y < now()"
    )
  })

  it('escapes per dialect', () => {
    const values = { v: { value: 'a\\b', mode: 'auto' as const } }
    expect(substituteParams('= :v', 'mysql', values)).toBe("= 'a\\\\b'")
    expect(substituteParams('= :v', 'tsql', { v: { value: 'Zoë', mode: 'auto' } })).toBe("= N'Zoë'")
  })

  it('leaves placeholders without a value alone', () => {
    expect(substituteParams('a = :a', 'postgres', {})).toBe('a = :a')
  })
})

describe('transaction statements', () => {
  it('uses each dialect’s spelling', () => {
    expect(beginSql('mysql')).toBe('START TRANSACTION')
    expect(beginSql('tsql')).toBe('BEGIN TRANSACTION')
    expect(beginSql('postgres')).toBe('BEGIN')
    expect(commitSql('tsql')).toBe('COMMIT TRANSACTION')
    expect(rollbackSql('sqlite')).toBe('ROLLBACK')
  })
})

describe('fillParams', () => {
  it('maps error offsets in the filled text back to the editor text', () => {
    const sql = 'SELECT * FROM t WHERE name = :name AND id = :id AND oops'
    const { sql: filled, spans } = fillParams(sql, 'postgres', {
      name: { value: 'a much longer value', mode: 'text' },
      id: { value: '7', mode: 'auto' }
    })
    expect(filled).toBe("SELECT * FROM t WHERE name = 'a much longer value' AND id = 7 AND oops")
    // Text after the values lines up with the original
    expect(sourceOffset(filled.indexOf('oops'), spans)).toBe(sql.indexOf('oops'))
    expect(sourceOffset(filled.indexOf('WHERE'), spans)).toBe(sql.indexOf('WHERE'))
    // A position inside a value covers its whole placeholder
    const inside = filled.indexOf('longer')
    expect(sourceOffset(inside, spans)).toBe(sql.indexOf(':name'))
    expect(sourceOffset(inside + 3, spans, 'end')).toBe(sql.indexOf(':name') + ':name'.length)
  })
})
