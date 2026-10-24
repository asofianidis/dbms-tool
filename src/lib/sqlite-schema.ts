/**
 * Reads the parts of SQLite table and index definitions that PRAGMAs don't
 * report: CHECK and UNIQUE constraints, collations, AUTOINCREMENT and partial
 * index predicates. The table designer needs them to rebuild a table without
 * losing anything.
 */

interface Token {
  /** word | quoted (identifier) | string | punct */
  type: 'word' | 'quoted' | 'string' | 'punct'
  text: string
  start: number
  end: number
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (/\s/.test(ch)) {
      i++
    } else if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      i = close < 0 ? sql.length : close + 2
    } else if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const closer = ch === '[' ? ']' : ch
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === closer) {
          // Doubled quotes escape themselves; brackets can't be escaped
          if (closer !== ']' && sql[j + 1] === closer) j += 2
          else break
        } else j++
      }
      tokens.push({
        type: ch === "'" ? 'string' : 'quoted',
        text: sql.slice(i, j + 1),
        start: i,
        end: j + 1
      })
      i = j + 1
    } else if (/[\w$]/.test(ch)) {
      let j = i
      while (j < sql.length && /[\w$]/.test(sql[j])) j++
      tokens.push({ type: 'word', text: sql.slice(i, j), start: i, end: j })
      i = j
    } else {
      tokens.push({ type: 'punct', text: ch, start: i, end: i + 1 })
      i++
    }
  }
  return tokens
}

/** The name a quoted or bare identifier token stands for. */
function unquote(token: Token): string {
  const t = token.text
  if (token.type !== 'quoted' && token.type !== 'string') return t
  const q = t[0]
  const body = t.slice(1, -1)
  return q === '[' ? body : body.split(q + q).join(q)
}

const isWord = (token: Token | undefined, word: string): boolean =>
  token?.type === 'word' && token.text.toUpperCase() === word

/** Index of the token closing the parenthesis opened at `open`. */
function closingParen(tokens: Token[], open: number): number {
  let depth = 0
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].text === '(' && tokens[i].type === 'punct') depth++
    else if (tokens[i].text === ')' && tokens[i].type === 'punct' && --depth === 0) return i
  }
  return tokens.length - 1
}

/** Splits tokens[from..to) at commas outside parentheses. */
function splitTopLevel(tokens: Token[], from: number, to: number): Token[][] {
  const parts: Token[][] = []
  let current: Token[] = []
  let depth = 0
  for (let i = from; i < to; i++) {
    const t = tokens[i]
    if (t.type === 'punct' && t.text === '(') depth++
    else if (t.type === 'punct' && t.text === ')') depth--
    if (depth === 0 && t.type === 'punct' && t.text === ',') {
      parts.push(current)
      current = []
    } else current.push(t)
  }
  if (current.length) parts.push(current)
  return parts
}

export interface SqliteCheck {
  /** null for an unnamed constraint */
  name: string | null
  expression: string
}

export interface SqliteUnique {
  name: string | null
  columns: string[]
}

export interface SqliteColumnShape {
  collate: string | null
  autoincrement: boolean
  /** GENERATED ALWAYS AS (…) columns, which a rebuild can't copy data into */
  generated: boolean
}

export interface SqliteTableShape {
  /** Column shapes keyed by lower-cased name */
  columns: Record<string, SqliteColumnShape>
  /** Column and table CHECK constraints */
  checks: SqliteCheck[]
  /** Column and table UNIQUE constraints */
  uniques: SqliteUnique[]
  /** Table options after the column list, such as `WITHOUT ROWID` or `STRICT` */
  options: string
  /** CREATE VIRTUAL TABLE (FTS and the like), which has no column list to rebuild */
  virtual: boolean
}

const TABLE_CONSTRAINT = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'])

/** Reads constraints and column attributes out of a CREATE TABLE statement. */
export function parseSqliteTable(sql: string): SqliteTableShape {
  const shape: SqliteTableShape = {
    columns: {},
    checks: [],
    uniques: [],
    options: '',
    virtual: /^\s*create\s+virtual\b/i.test(sql)
  }
  const tokens = tokenize(sql)
  const open = tokens.findIndex((t) => t.type === 'punct' && t.text === '(')
  if (open < 0) return shape
  const close = closingParen(tokens, open)
  shape.options = sql.slice(tokens[close].end).trim().replace(/;\s*$/, '').trim()
  const inner = (from: number, part: Token[]): string => {
    const end = closingParen(part, from)
    return sql.slice(part[from].end, part[end].start).trim()
  }

  for (const part of splitTopLevel(tokens, open + 1, close)) {
    if (!part.length) continue
    const first = part[0]
    const tableLevel = first.type === 'word' && TABLE_CONSTRAINT.has(first.text.toUpperCase())
    const column = tableLevel ? null : unquote(first)
    const attrs: SqliteColumnShape = { collate: null, autoincrement: false, generated: false }
    let pending: string | null = null
    for (let i = tableLevel ? 0 : 1; i < part.length; i++) {
      const t = part[i]
      if (t.type === 'punct' && t.text === '(') {
        // Type arguments, default expressions and the like
        i = closingParen(part, i)
        continue
      }
      if (t.type !== 'word') continue
      const word = t.text.toUpperCase()
      if (word === 'CONSTRAINT' && part[i + 1]) {
        pending = unquote(part[++i])
      } else if (word === 'CHECK' && part[i + 1]?.text === '(') {
        shape.checks.push({ name: pending, expression: inner(i + 1, part) })
        i = closingParen(part, i + 1)
        pending = null
      } else if (word === 'UNIQUE') {
        if (part[i + 1]?.text === '(') {
          const end = closingParen(part, i + 1)
          const columns = splitTopLevel(part, i + 2, end)
            .filter((c) => c.length)
            .map((c) => unquote(c[0]))
          shape.uniques.push({ name: pending, columns })
          i = end
        } else if (column !== null) {
          shape.uniques.push({ name: pending, columns: [column] })
        }
        pending = null
      } else if (word === 'COLLATE' && part[i + 1]) {
        attrs.collate = unquote(part[++i])
      } else if (word === 'AUTOINCREMENT') {
        attrs.autoincrement = true
      } else if (word === 'GENERATED' || (word === 'AS' && part[i + 1]?.text === '(')) {
        attrs.generated = true
      } else if (word === 'REFERENCES' || word === 'FOREIGN') {
        // Foreign keys come from PRAGMA foreign_key_list; skip to the end of the clause
        pending = null
      } else if (['PRIMARY', 'NOT', 'NULL', 'DEFAULT'].includes(word)) {
        pending = null
      }
    }
    if (column !== null) shape.columns[column.toLowerCase()] = attrs
  }
  return shape
}

/** The predicate of a partial index (`CREATE INDEX … ON t (…) WHERE …`), or null. */
export function sqliteIndexWhere(sql: string | null): string | null {
  if (!sql) return null
  const tokens = tokenize(sql)
  const on = tokens.findIndex((t) => isWord(t, 'ON'))
  const open = tokens.findIndex((t, i) => i > on && t.type === 'punct' && t.text === '(')
  if (on < 0 || open < 0) return null
  const close = closingParen(tokens, open)
  const where = tokens[close + 1]
  if (!isWord(where, 'WHERE')) return null
  return sql.slice(where.end).trim().replace(/;\s*$/, '').trim() || null
}

/**
 * Points an index or trigger definition at a renamed table by replacing the
 * name after its `ON`.
 */
export function retargetDefinition(sql: string, table: string, quoted: string): string {
  const tokens = tokenize(sql)
  const on = tokens.findIndex(
    (t, i) => isWord(t, 'ON') && tokens[i + 1] && unquote(tokens[i + 1]) === table
  )
  if (on < 0) return sql
  const target = tokens[on + 1]
  return sql.slice(0, target.start) + quoted + sql.slice(target.end)
}
