import type { RoutineInfo, RoutineParam } from './api'
import type { Dialect } from './engines'
import { literal, qualified, quoteIdent, type TableRef } from './sql'

/** How a parameter's value is supplied in a generated call. */
export type ArgMode = 'value' | 'null' | 'default' | 'expression'

export interface RoutineArg {
  mode: ArgMode
  value: string
}

export function isOutput(param: RoutineParam): boolean {
  return /^(OUT|INOUT|OUTPUT)$/i.test(param.mode)
}

export function isInput(param: RoutineParam): boolean {
  return !/^OUT$/i.test(param.mode)
}

function argSql(dialect: Dialect, param: RoutineParam, arg: RoutineArg | undefined): string | null {
  const a = arg ?? { mode: 'default', value: '' }
  switch (a.mode) {
    case 'null':
      return 'NULL'
    case 'default':
      return null
    case 'expression':
      return a.value.trim() || 'NULL'
    case 'value':
      return literal(dialect, a.value, param.dataType)
  }
}

/** A T-SQL variable name for an OUTPUT parameter. */
function outVar(param: RoutineParam): string {
  return param.name.startsWith('@') ? param.name : `@${param.name}`
}

/**
 * Builds the statement that runs a routine with the given arguments:
 * EXEC for T-SQL procedures (declaring OUTPUT variables), CALL for
 * PostgreSQL/MySQL procedures and SELECT for functions.
 */
export function callScript(
  dialect: Dialect,
  ref: TableRef,
  kind: 'procedure' | 'function',
  info: RoutineInfo,
  args: Record<string, RoutineArg>
): string {
  const target = qualified(dialect, ref)
  const params = info.params

  if (dialect === 'tsql') {
    if (kind === 'procedure') {
      const outputs = params.filter(isOutput)
      const declares = outputs.map((p) => {
        const init = argSql(dialect, p, args[p.name])
        return `DECLARE ${outVar(p)} ${p.dataType}${init ? ` = ${init}` : ''};`
      })
      const parts = params.flatMap((p) => {
        if (isOutput(p)) return [`${p.name} = ${outVar(p)} OUTPUT`]
        const value = argSql(dialect, p, args[p.name])
        return value === null ? [] : [`${p.name} = ${value}`]
      })
      const lines = [
        ...declares,
        `EXEC ${target}${parts.length ? `\n  ${parts.join(',\n  ')}` : ''};`
      ]
      if (outputs.length) {
        lines.push(
          `SELECT ${outputs.map((p) => `${outVar(p)} AS ${quoteIdent(dialect, p.name)}`).join(', ')};`
        )
      }
      return lines.join('\n')
    }
    // T-SQL functions take positional arguments; DEFAULT keeps a parameter's default
    const list = params.map((p) => argSql(dialect, p, args[p.name]) ?? 'DEFAULT').join(', ')
    return info.returns === 'TABLE'
      ? `SELECT *\nFROM ${target}(${list});`
      : `SELECT ${target}(${list}) AS ${quoteIdent(dialect, ref.name)};`
  }

  if (dialect === 'postgres') {
    // Named notation lets omitted parameters fall back to their defaults
    const parts = params.flatMap((p) => {
      if (/^OUT$/i.test(p.mode))
        return kind === 'procedure' ? [`${quoteIdent(dialect, p.name)} => NULL`] : []
      const value = argSql(dialect, p, args[p.name])
      if (value === null) return []
      return p.name ? [`${quoteIdent(dialect, p.name)} => ${value}`] : [value]
    })
    const call = `${target}(${parts.join(', ')})`
    return kind === 'procedure' ? `CALL ${call};` : `SELECT *\nFROM ${call};`
  }

  // MySQL: OUT parameters go through session variables
  const values = params.map((p) => {
    if (/^OUT$/i.test(p.mode)) return `@${p.name}`
    if (/^INOUT$/i.test(p.mode)) return `@${p.name}`
    return argSql(dialect, p, args[p.name]) ?? 'NULL'
  })
  if (kind === 'function')
    return `SELECT ${target}(${values.join(', ')}) AS ${quoteIdent(dialect, ref.name)};`
  const inout = params.filter((p) => /^INOUT$/i.test(p.mode))
  const outs = params.filter(isOutput)
  const lines = [
    ...inout.map((p) => `SET @${p.name} = ${argSql(dialect, p, args[p.name]) ?? 'NULL'};`),
    `CALL ${target}(${values.join(', ')});`
  ]
  if (outs.length)
    lines.push(
      `SELECT ${outs.map((p) => `@${p.name} AS ${quoteIdent(dialect, p.name)}`).join(', ')};`
    )
  return lines.join('\n')
}

/** Starter code for a new procedure or function. */
export function routineTemplate(
  dialect: Dialect,
  kind: 'procedure' | 'function',
  schema: string | null,
  babelfish: boolean
): string {
  const name = kind === 'procedure' ? 'new_procedure' : 'new_function'
  const target = schema && dialect !== 'mysql' ? `${quoteIdent(dialect, schema)}.${name}` : name
  switch (dialect) {
    case 'postgres':
      return kind === 'procedure'
        ? `CREATE OR REPLACE PROCEDURE ${target}(p_id integer)
LANGUAGE plpgsql
AS $$
BEGIN
  -- procedure body
  RAISE NOTICE 'Called with %', p_id;
END;
$$;`
        : `CREATE OR REPLACE FUNCTION ${target}(p_value integer)
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN p_value * 2;
END;
$$;`
    case 'mysql':
      return kind === 'procedure'
        ? `CREATE PROCEDURE ${target}(IN p_id INT, OUT p_count INT)
BEGIN
  -- procedure body
  SELECT COUNT(*) INTO p_count FROM information_schema.tables WHERE table_schema = DATABASE();
END;`
        : `CREATE FUNCTION ${target}(p_value INT)
RETURNS INT
DETERMINISTIC
BEGIN
  RETURN p_value * 2;
END;`
    case 'tsql': {
      // Babelfish doesn't support CREATE OR ALTER for routines
      const create = babelfish ? 'CREATE' : 'CREATE OR ALTER'
      return kind === 'procedure'
        ? `${create} PROCEDURE ${target}
  @Id INT,
  @Count INT = NULL OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  -- procedure body
  SELECT @Count = COUNT(*) FROM sys.objects;
END
GO`
        : `${create} FUNCTION ${target}
(
  @Value INT
)
RETURNS INT
AS
BEGIN
  RETURN @Value * 2;
END
GO`
    }
    case 'sqlite':
      return '-- SQLite has no stored procedures or functions'
  }
}

/** Turns a stored definition into an editable script (ALTER for T-SQL, CREATE OR REPLACE elsewhere). */
export function modifyScript(
  dialect: Dialect,
  definition: string,
  ref: TableRef,
  kind: 'procedure' | 'function'
): string {
  const body = definition.trim()
  if (dialect === 'tsql') {
    return `${body.replace(/^((?:\s|--[^\n]*\n|\/\*(?:[^*]|\*(?!\/))*\*\/)*)create\b/i, '$1ALTER')}\nGO`
  }
  if (dialect === 'mysql') {
    // MySQL can't replace routines in place
    return `DROP ${kind.toUpperCase()} IF EXISTS ${qualified(dialect, ref)};\n\n${body};`
  }
  // pg_get_functiondef already emits CREATE OR REPLACE
  return body.endsWith(';') ? body : `${body};`
}
