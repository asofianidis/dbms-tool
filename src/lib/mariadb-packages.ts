/**
 * MariaDB packages (CREATE PACKAGE / CREATE PACKAGE BODY, 10.3+) and routines
 * stored under sql_mode=ORACLE. Packages first needed Oracle mode; 11.4 also
 * accepts them in the default mode.
 */
import type { ServerInfo } from './api'
import { mariaDbAtLeast } from './mariadb'

type InfoLike = Pick<ServerInfo, 'product' | 'version'> | null | undefined

/** True when the server has packages: MariaDB 10.3 or newer. */
export function supportsPackages(info: InfoLike): boolean {
  return mariaDbAtLeast(info, 10, 3)
}

/** True when the server accepts packages outside sql_mode=ORACLE (MariaDB 11.4+). */
export function packagesInDefaultMode(info: InfoLike): boolean {
  return mariaDbAtLeast(info, 11, 4)
}

/** True when a stored sql_mode (information_schema.ROUTINES.SQL_MODE) includes ORACLE. */
export function isOracleMode(sqlMode: string | null | undefined): boolean {
  return !!sqlMode && /(^|,)\s*ORACLE\s*(,|$)/i.test(sqlMode)
}

/** A statement and the sql_mode it was stored under. */
export interface ModedStatement {
  sql: string
  mode: string | null
}

/**
 * Joins statements into a runnable script. Oracle-mode DDL quotes names with
 * `"` and uses Oracle syntax, so when any statement needs ORACLE the script
 * switches to each statement's mode and restores the session's mode at the end
 * (as mysqldump does). Otherwise the statements are joined unchanged.
 */
export function withSqlModes(statements: ModedStatement[]): string {
  const terminated = statements.map((s) => ({ ...s, sql: terminate(s.sql) }))
  if (!terminated.some((s) => isOracleMode(s.mode))) {
    return terminated.map((s) => s.sql).join('\n\n')
  }
  const lines = ['SET @saved_sql_mode = @@sql_mode;']
  let current: string | null = null
  for (const s of terminated) {
    const mode = s.mode ?? ''
    if (mode !== current) {
      lines.push(`SET sql_mode = '${mode.replace(/'/g, "''")}';`)
      current = mode
    }
    lines.push('', s.sql, '')
  }
  lines.push('SET sql_mode = @saved_sql_mode;')
  return lines.join('\n')
}

function terminate(sql: string): string {
  const body = sql.trim()
  return body.endsWith(';') ? body : `${body};`
}

/**
 * Splits a package definition (the spec, then the body when there is one, as
 * the backend returns them) into its two CREATE statements.
 */
export function packageParts(definition: string): { spec: string; body: string | null } {
  const text = definition.trim()
  const match = /;\s*\n(?=\s*CREATE\b[^\n]*?\bPACKAGE\s+BODY\b)/i.exec(text)
  if (!match) return { spec: text, body: null }
  return { spec: text.slice(0, match.index), body: text.slice(match.index + match[0].length) }
}

/** Turns `CREATE [DEFINER=…] PACKAGE [BODY]` into `CREATE OR REPLACE …`. */
function orReplace(statement: string): string {
  return statement.replace(/^(\s*CREATE)\s+(?!OR\s+REPLACE\b)/i, '$1 OR REPLACE ')
}

/** The sql_mode of a package's spec and body (information_schema.ROUTINES). */
export interface PackageModes {
  spec: string | null
  body: string | null
}

/**
 * A runnable script for a package's spec and body, each under its own
 * sql_mode. With `replace` (Modify) both become CREATE OR REPLACE; replacing
 * the spec drops the body, so the body is always recreated after it.
 */
export function packageScript(definition: string, modes: PackageModes, replace = false): string {
  const { spec, body } = packageParts(definition)
  const edit = replace ? orReplace : (s: string) => s
  const statements: ModedStatement[] = [{ sql: edit(spec), mode: modes.spec }]
  if (body) statements.push({ sql: edit(body), mode: modes.body ?? modes.spec })
  return withSqlModes(statements)
}

const USAGE =
  '-- Members are called by name: SELECT new_package.double_it(21); CALL new_package.show_calls();'

/**
 * Starter code for a new package: a spec and a body. Before 11.4 packages need
 * sql_mode=ORACLE, so the script switches to it and back.
 */
export function packageTemplate(defaultMode: boolean): string {
  if (defaultMode) {
    return `${USAGE}
CREATE OR REPLACE PACKAGE new_package
  FUNCTION double_it(p_value INT) RETURNS INT;
  PROCEDURE show_calls();
END;

CREATE OR REPLACE PACKAGE BODY new_package
  -- Package variables keep their value for the session
  DECLARE calls INT DEFAULT 0;

  FUNCTION double_it(p_value INT) RETURNS INT
  BEGIN
    SET calls = calls + 1;
    RETURN p_value * 2;
  END;

  PROCEDURE show_calls()
  BEGIN
    SELECT calls AS calls;
  END;
END;`
  }
  return `${USAGE}
SET @saved_sql_mode = @@sql_mode;
SET sql_mode = 'ORACLE';

CREATE OR REPLACE PACKAGE new_package AS
  FUNCTION double_it(p_value INT) RETURN INT;
  PROCEDURE show_calls;
END;

CREATE OR REPLACE PACKAGE BODY new_package AS
  -- Package variables keep their value for the session
  calls INT := 0;

  FUNCTION double_it(p_value INT) RETURN INT AS
  BEGIN
    calls := calls + 1;
    RETURN p_value * 2;
  END;

  PROCEDURE show_calls AS
  BEGIN
    SELECT calls AS calls;
  END;
END;

SET sql_mode = @saved_sql_mode;`
}

/* ---------- Statement splitting ---------- */

const PACKAGE_HEAD =
  /^\s*create\s+(or\s+replace\s+)?(definer\s*=\s*\S+\s+)?package\s+(body\s+)?(if\s+not\s+exists\s+)?/i

/**
 * An Oracle-mode routine header: the signature, an optional `RETURN type` and
 * characteristics, then `AS` / `IS`, which opens a declaration section before
 * the body's BEGIN. Matched with parentheses collapsed to `()`.
 */
const ORACLE_ROUTINE_HEAD =
  /^\s*create\s+(or\s+replace\s+)?(definer\s*=\s*\S+\s+)?(procedure|function)\s+(if\s+not\s+exists\s+)?\S+?\s*(\(\))?\s*(return\s+[\w.%]+\s*(\(\))?\s*)?((deterministic|not|language|sql|contains|no|reads|modifies|data|security|definer|invoker|comment\s+'')\s+)*(as|is)\b/i

/** Words that matter for block nesting, plus `;`. */
function tokens(text: string): string[] {
  // Quoted names may hold any word; MySQL strings are emptied by the caller
  const plain = text.replace(/"(?:[^"]|"")*"|`(?:[^`]|``)*`/g, ' x ')
  return (plain.match(/[A-Za-z_][\w$]*|;/g) ?? []).map((t) => t.toLowerCase())
}

/** END that closes IF / LOOP / WHILE / REPEAT, whose openers aren't counted. */
const UNCOUNTED_END = new Set(['if', 'loop', 'while', 'repeat'])

/**
 * Whether the text before a `;` is still inside a MariaDB package or an
 * Oracle-mode routine (so the `;` doesn't end the statement), or null when
 * the text is neither and the usual MySQL rules apply. `text` has comments
 * and string literals removed.
 */
export function insideMariaDbBlock(text: string): boolean | null {
  if (PACKAGE_HEAD.test(text)) return insidePackage(tokens(text.replace(PACKAGE_HEAD, '')))
  let flat = text
  // Each pass shortens the text, innermost parentheses first
  for (let prev = ''; prev !== flat;) {
    prev = flat
    flat = flat.replace(/\((?:[^()]|\(\))+\)/g, '()')
  }
  const head = ORACLE_ROUTINE_HEAD.exec(flat)
  if (head) return insideOracleRoutine(tokens(flat.slice(head[0].length)))
  return null
}

/**
 * The package itself is a block closed by its END. Its subprograms' BEGIN … END
 * nest inside; a BEGIN at package level outside a subprogram is the body's
 * initialization section, which shares the package's END.
 */
function insidePackage(words: string[]): boolean {
  let depth = 1
  // After FUNCTION / PROCEDURE at package level, until the subprogram's BEGIN
  let header = false
  let declares = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === 'end') {
      const next = words[i + 1]
      if (next && UNCOUNTED_END.has(next)) {
        i++
        continue
      }
      if (next === 'case') i++
      depth--
    } else if (w === 'begin') {
      if (header) {
        header = false
        depth++
      } else if (depth > 1) depth++
    } else if (w === 'case') depth++
    else if ((w === 'function' || w === 'procedure') && depth === 1) {
      header = true
      declares = false
    } else if ((w === 'as' || w === 'is') && header) declares = true
    // A spec's declaration, or a one-statement subprogram, ends at `;`
    else if (w === ';' && header && !declares) header = false
  }
  return depth > 0
}

/** Declarations run until the body's BEGIN, which its END closes. */
function insideOracleRoutine(words: string[]): boolean {
  let depth = 0
  let begun = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === 'end') {
      const next = words[i + 1]
      if (next && UNCOUNTED_END.has(next)) {
        i++
        continue
      }
      if (next === 'case') i++
      depth--
    } else if (w === 'begin') {
      begun = true
      depth++
    } else if (w === 'case') depth++
  }
  return !begun || depth > 0
}
