import { describe, expect, it } from 'vitest'
import type { RoutineInfo } from '../api'
import { callScript, modifyScript, routineTemplate } from '../routines'
import { splitStatements } from '../sql'

const proc = (params: RoutineInfo['params']): RoutineInfo => ({
  params,
  returns: null,
  language: null
})

describe('callScript', () => {
  it('builds T-SQL EXEC with OUTPUT variables', () => {
    const info = proc([
      { name: '@x', dataType: 'int', mode: 'IN' },
      { name: '@y', dataType: 'nvarchar(10)', mode: 'OUTPUT' }
    ])
    expect(
      callScript('tsql', { schema: 'dbo', name: 'probe_proc' }, 'procedure', info, {
        '@x': { mode: 'value', value: '5' }
      })
    ).toBe(
      'DECLARE @y nvarchar(10);\nEXEC [dbo].[probe_proc]\n  @x = 5,\n  @y = @y OUTPUT;\nSELECT @y AS [@y];'
    )
  })

  it('omits T-SQL procedure parameters left at their default', () => {
    const info = proc([{ name: '@x', dataType: 'int', mode: 'IN' }])
    expect(callScript('tsql', { schema: 'dbo', name: 'p' }, 'procedure', info, {})).toBe(
      'EXEC [dbo].[p];'
    )
  })

  it('selects T-SQL scalar and table-valued functions', () => {
    const scalar: RoutineInfo = {
      params: [{ name: '@a', dataType: 'int', mode: 'IN' }],
      returns: 'int',
      language: null
    }
    expect(
      callScript('tsql', { schema: 'dbo', name: 'f' }, 'function', scalar, {
        '@a': { mode: 'value', value: '1' }
      })
    ).toBe('SELECT [dbo].[f](1) AS [f];')
    expect(
      callScript(
        'tsql',
        { schema: 'dbo', name: 't' },
        'function',
        { ...scalar, returns: 'TABLE' },
        {}
      )
    ).toBe('SELECT *\nFROM [dbo].[t](DEFAULT);')
  })

  it('uses named notation in PostgreSQL', () => {
    const fn: RoutineInfo = {
      params: [
        { name: 'a', dataType: 'integer', mode: 'IN' },
        { name: 'b', dataType: 'integer', mode: 'IN' }
      ],
      returns: 'integer',
      language: 'sql'
    }
    expect(
      callScript('postgres', { schema: 'public', name: 'probe_fn' }, 'function', fn, {
        a: { mode: 'value', value: '1' }
      })
    ).toBe('SELECT *\nFROM public.probe_fn(a => 1);')
    const p = proc([
      { name: 'x', dataType: 'integer', mode: 'IN' },
      { name: 'y', dataType: 'text', mode: 'INOUT' }
    ])
    expect(
      callScript('postgres', { schema: 'public', name: 'probe_proc' }, 'procedure', p, {
        x: { mode: 'value', value: '3' },
        y: { mode: 'null', value: '' }
      })
    ).toBe('CALL public.probe_proc(x => 3, y => NULL);')
  })

  it('routes MySQL OUT parameters through session variables', () => {
    const p = proc([
      { name: 'x', dataType: 'int', mode: 'IN' },
      { name: 'y', dataType: 'int', mode: 'OUT' }
    ])
    expect(
      callScript('mysql', { schema: 'probe', name: 'probe_proc' }, 'procedure', p, {
        x: { mode: 'expression', value: '2 + 2' }
      })
    ).toBe('CALL `probe`.`probe_proc`(2 + 2, @y);\nSELECT @y AS `y`;')
  })
})

describe('routine scripts', () => {
  it('turns CREATE into ALTER for T-SQL', () => {
    expect(
      modifyScript(
        'tsql',
        'CREATE PROCEDURE dbo.p AS SELECT 1',
        { schema: 'dbo', name: 'p' },
        'procedure'
      )
    ).toBe('ALTER PROCEDURE dbo.p AS SELECT 1\nGO')
  })

  it('keeps leading comments before the T-SQL CREATE', () => {
    const ref = { schema: 'dbo', name: 'p' }
    expect(
      modifyScript(
        'tsql',
        '-- note\n/* a */ /* b */\nCREATE PROC dbo.p AS SELECT 1',
        ref,
        'procedure'
      )
    ).toBe('-- note\n/* a */ /* b */\nALTER PROC dbo.p AS SELECT 1\nGO')
    // Linear on runs of comment delimiters (was exponential)
    const odd = `/*${'*//*'.repeat(60)}`
    expect(modifyScript('tsql', odd, ref, 'procedure')).toBe(`${odd}\nGO`)
  })

  it('avoids CREATE OR ALTER on Babelfish', () => {
    expect(routineTemplate('tsql', 'procedure', 'dbo', true)).toMatch(/^CREATE PROCEDURE/)
    expect(routineTemplate('tsql', 'procedure', 'dbo', false)).toMatch(/^CREATE OR ALTER PROCEDURE/)
  })

  it('keeps MySQL routine bodies in one statement', () => {
    const sql = `${routineTemplate('mysql', 'procedure', null, false)}\nCALL new_procedure(1, @c);`
    const parts = splitStatements(sql, 'mysql')
    expect(parts).toHaveLength(2)
    expect(parts[0].text).toMatch(/^CREATE PROCEDURE[\s\S]*END$/)
    expect(parts[1].text).toBe('CALL new_procedure(1, @c)')
  })

  it('does not treat END IF as the end of a body', () => {
    const sql =
      'CREATE FUNCTION f(a INT) RETURNS INT DETERMINISTIC BEGIN IF a > 0 THEN RETURN 1; END IF; RETURN 0; END; SELECT f(1);'
    expect(splitStatements(sql, 'mysql')).toHaveLength(2)
  })
})
