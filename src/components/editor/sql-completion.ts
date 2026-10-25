import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view'
import type { CompletionTable } from '@/lib/api'
import type { Dialect } from '@/lib/engines'
import type { ServerVersion } from '@/lib/mariadb'
import { resolveTable, unquoteIdent } from '@/lib/result-source'
import type { Snippet } from '@/lib/snippets'
import { quoteIdent, stripComments } from '@/lib/sql'
import { functionsFor } from '@/lib/sql-functions'

/*
 * CodeMirror's schema completion offers every schema and table name for any
 * bare word, so on a database with a schema (or table) per customer, typing in
 * a SELECT list or WHERE clause pops up a list of customers. Bare names are
 * only offered where a table goes; `schema.` and `table.` still complete
 * anywhere, and so do the statement's aliases.
 */

/** A table in a FROM list, with an optional alias, followed by a comma */
const LISTED_TABLE = String.raw`[\w$."\`\[\]]+(?:\s+(?:as\s+)?\w+)?\s*,\s*`
const TABLE_POSITION = new RegExp(
  String.raw`\b(?:from|join|into|update|table|truncate|describe|desc)\s+(?:${LISTED_TABLE})*$`,
  'i'
)

/** Whether a name starting at `from` in `before` (the text up to it) is where a table goes. */
export function expectsTable(before: string): boolean {
  // Only the current statement matters, and only its recent part
  const statement = before.slice(before.lastIndexOf(';') + 1).slice(-2000)
  return TABLE_POSITION.test(statement)
}

export function tableAwareCompletion(source: CompletionSource): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const result = await source(context)
    if (!result) return result
    const before = context.state.sliceDoc(0, result.from)
    // Qualified (`schema.`, `alias.`) or quoted after a dot: what's listed belongs there
    if (/\.["`[]?$/.test(before) || expectsTable(before)) return result
    // Elsewhere keep only the statement's aliases, which lang-sql types "constant"
    const options = result.options.filter((o) => o.type === 'constant')
    return options.length ? { ...result, options } : null
  }
}

/*
 * Completions that know the statement being written: the columns of the
 * tables it reads, joins along foreign keys, built-in functions with their
 * signatures, and the user's snippets.
 */

export interface StatementTable {
  table: CompletionTable
  alias: string | null
}

const NAME = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`
const TABLE_ITEM = new RegExp(
  String.raw`^\s*(${NAME}(?:\s*\.\s*${NAME})?)(?:\s+(?:as\s+)?(${NAME}))?`,
  'i'
)
const NOT_ALIAS = new Set([
  'on',
  'using',
  'where',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'outer',
  'natural',
  'group',
  'order',
  'having',
  'limit',
  'offset',
  'union',
  'set',
  'values',
  'window',
  'lateral',
  'fetch',
  'for',
  'with',
  'select',
  'returning',
  'except',
  'intersect'
])
const FROM_END =
  /\b(where|group\s+by|order\s+by|having|limit|offset|union|intersect|except|window|join|inner|left|right|full|cross|natural|on|returning|fetch|for)\b|[;)]/i

/** The text of the statement around `pos`, by semicolons, and where it starts. */
export function statementAround(doc: string, pos: number): { text: string; from: number } {
  const from = doc.lastIndexOf(';', pos - 1) + 1
  const end = doc.indexOf(';', pos)
  return { text: doc.slice(from, end < 0 ? doc.length : end), from }
}

/** Tables the statement reads or writes (FROM lists, JOINs, UPDATE, INTO), with aliases. */
export function tablesInStatement(
  text: string,
  tables: CompletionTable[],
  dialect: Dialect,
  defaultSchema?: string
): StatementTable[] {
  const found: StatementTable[] = []
  const add = (item: string): void => {
    const m = TABLE_ITEM.exec(item)
    if (!m) return
    const parts = m[1].split(/\s*\.\s*/).map((p) => unquoteIdent(p, dialect))
    const table = resolveTable(parts, tables, defaultSchema, dialect)
    if (!table) return
    const alias = m[2] && !NOT_ALIAS.has(m[2].toLowerCase()) ? unquoteIdent(m[2], dialect) : null
    if (!found.some((f) => f.table === table && f.alias === alias)) found.push({ table, alias })
  }
  const clean = stripComments(text)
  for (const m of clean.matchAll(/\bfrom\b/gi)) {
    const rest = clean.slice(m.index + 4)
    const end = FROM_END.exec(rest)
    for (const item of rest.slice(0, end ? end.index : undefined).split(',')) add(item)
  }
  for (const m of clean.matchAll(/\b(?:join|update|into)\b/gi))
    add(clean.slice(m.index + m[0].length))
  return found
}

/** An identifier as written in generated SQL: bare when that's safe. */
function ident(dialect: Dialect, name: string): string {
  if (dialect === 'postgres' || dialect === 'sqlite') return quoteIdent(dialect, name)
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : quoteIdent(dialect, name)
}

function tableName(dialect: Dialect, t: CompletionTable, defaultSchema?: string): string {
  return t.schema && t.schema !== defaultSchema
    ? `${ident(dialect, t.schema)}.${ident(dialect, t.name)}`
    : ident(dialect, t.name)
}

/** Initials of a table name (`order_items` → `oi`), unique among `taken`. */
export function aliasFor(name: string, taken: Set<string>): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  let base = words.map((w) => w[0].toLowerCase()).join('') || 't'
  if (/^\d/.test(base)) base = `t${base}`
  let alias = base
  for (let n = 2; taken.has(alias.toLowerCase()); n++) alias = `${base}${n}`
  return alias
}

const sameTable = (t: CompletionTable, schema: string | null, name: string): boolean =>
  t.name === name && (schema === null || t.schema === null || t.schema === schema)

export interface JoinSuggestion {
  /** The table being joined */
  table: CompletionTable
  alias: string
  /** `a.x = b.y AND …` */
  condition: string
  /** The statement's table it links to */
  via: StatementTable
}

/** Tables reachable from the statement's tables along a foreign key, either way round. */
export function joinSuggestions(
  present: StatementTable[],
  tables: CompletionTable[],
  dialect: Dialect
): JoinSuggestion[] {
  const taken = new Set(present.map((p) => (p.alias ?? p.table.name).toLowerCase()))
  const out: JoinSuggestion[] = []
  const on = (a: string, aCols: string[], b: string, bCols: string[]): string =>
    aCols
      .map(
        (c, i) =>
          `${ident(dialect, a)}.${ident(dialect, c)} = ${ident(dialect, b)}.${ident(dialect, bCols[i])}`
      )
      .join(' AND ')
  for (const p of present) {
    const owner = p.alias ?? p.table.name
    // This table's keys point at the target
    for (const fk of p.table.foreignKeys ?? []) {
      const target = tables.find((t) => sameTable(t, fk.refSchema ?? p.table.schema, fk.refTable))
      if (!target) continue
      const alias = aliasFor(target.name, taken)
      out.push({
        table: target,
        alias,
        via: p,
        condition: on(alias, fk.refColumns, owner, fk.columns)
      })
    }
    // Other tables' keys point at this one
    for (const other of tables) {
      for (const fk of other.foreignKeys ?? []) {
        if (!sameTable(p.table, fk.refSchema ?? other.schema, fk.refTable)) continue
        const alias = aliasFor(other.name, taken)
        out.push({
          table: other,
          alias,
          via: p,
          condition: on(alias, fk.columns, owner, fk.refColumns)
        })
      }
    }
  }
  return out
}

export interface AssistOptions {
  tables: CompletionTable[]
  dialect: Dialect
  defaultSchema?: string
  /** The server's version when a MySQL-dialect connection is MariaDB */
  mariaDb?: ServerVersion
  /** The server's major version when the connection is PostgreSQL */
  postgres?: number
  /** Read at completion time, so edits apply without rebuilding the editor */
  snippets?: () => Snippet[]
}

const JOIN_TABLE = /\bjoin\s+[\w$]*$/i
const JOIN_ON = new RegExp(
  String.raw`\bjoin\s+(${NAME}(?:\s*\.\s*${NAME})?)(?:\s+(?:as\s+)?(${NAME}))?\s+on\s+[\w$]*$`,
  'i'
)

/** Inserts `name()` with the cursor between the parentheses (after them with no parameters). */
function insertCall(name: string, params: number): Completion['apply'] {
  return (view, _completion, from, to) => {
    view.dispatch({
      changes: { from, to, insert: `${name}()` },
      selection: { anchor: from + name.length + (params ? 1 : 2) }
    })
  }
}

/** Columns, joins, functions and snippets for the statement at the cursor. */
export function sqlAssistCompletion(options: AssistOptions): CompletionSource {
  const { dialect, defaultSchema } = options
  const functions = functionsFor(dialect, options.mariaDb, options.postgres)
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[\w$]*/)
    if (!word) return null
    const doc = context.state.doc.toString()
    const before = doc.slice(0, word.from)
    // `schema.` / `alias.` completions belong to the schema source
    if (/[."`[]$/.test(before)) return null
    // An empty word only completes on request, or right after JOIN / ON
    if (!context.explicit && word.from === word.to && !/\b(join|on)\s+$/i.test(before)) return null
    const { text, from } = statementAround(doc, context.pos)
    const present = tablesInStatement(text, options.tables, dialect, defaultSchema)
    const statementBefore = doc.slice(from, word.from)
    const out: Completion[] = []

    if (JOIN_TABLE.test(statementBefore + doc.slice(word.from, context.pos))) {
      for (const j of joinSuggestions(present, options.tables, dialect)) {
        out.push({
          label: `${tableName(dialect, j.table, defaultSchema)} ${j.alias} ON ${j.condition}`,
          detail: `via ${j.via.alias ?? j.via.table.name}`,
          type: 'join',
          boost: 5
        })
      }
      return out.length ? { from: word.from, options: out } : null
    }

    const onMatch = JOIN_ON.exec(statementBefore + doc.slice(word.from, context.pos))
    if (onMatch) {
      const parts = onMatch[1].split(/\s*\.\s*/).map((p) => unquoteIdent(p, dialect))
      const joined = resolveTable(parts, options.tables, defaultSchema, dialect)
      const alias = onMatch[2] ? unquoteIdent(onMatch[2], dialect) : null
      if (joined) {
        const others = present.filter((p) => !(p.table === joined && p.alias === alias))
        const shown = ident(dialect, alias ?? joined.name)
        for (const j of joinSuggestions(others, [joined], dialect)) {
          out.push({
            label: j.condition.replaceAll(`${ident(dialect, j.alias)}.`, `${shown}.`),
            detail: 'foreign key',
            type: 'join',
            boost: 5
          })
        }
      }
    }

    if (expectsTable(before)) return out.length ? { from: word.from, options: out } : null

    // Columns of the statement's tables, qualified where the name is ambiguous
    const counts = new Map<string, number>()
    for (const p of present)
      for (const c of p.table.columns) counts.set(c, (counts.get(c) ?? 0) + 1)
    for (const p of present) {
      const owner = p.alias ?? p.table.name
      for (const c of p.table.columns) {
        const col = ident(dialect, c)
        out.push({
          label: (counts.get(c) ?? 0) > 1 ? `${ident(dialect, owner)}.${col}` : col,
          detail: owner,
          type: 'property',
          boost: 2
        })
      }
    }
    for (const f of functions) {
      const fn = {
        label: f.name,
        detail: `(${f.params.join(', ')})${f.returns ? ` → ${f.returns}` : ''}`,
        info: f.description,
        type: 'function',
        boost: -1
      }
      out.push(
        f.snippet
          ? snippetCompletion(f.snippet, fn)
          : { ...fn, apply: insertCall(f.name, f.params.length) }
      )
    }
    for (const s of options.snippets?.() ?? []) {
      if (!s.prefix || !s.body) continue
      out.push(
        snippetCompletion(s.body, {
          label: s.prefix,
          detail: s.description || 'snippet',
          type: 'text',
          boost: 1
        })
      )
    }
    return out.length ? { from: word.from, options: out } : null
  }
}

/** Keywords a parenthesis follows without being a call */
const NOT_CALLS = new Set([
  'select',
  'from',
  'where',
  'and',
  'or',
  'not',
  'in',
  'exists',
  'values',
  'as',
  'on',
  'join',
  'when',
  'then',
  'else',
  'case',
  'over',
  'filter',
  'using',
  'into',
  'by',
  'having',
  'with',
  'union',
  'all',
  'any',
  'some',
  'is',
  'like',
  'between',
  'returns',
  'table'
])

/** The innermost unclosed call before `pos`: function name, argument index and `(` position. */
export function callAt(
  doc: string,
  pos: number
): { name: string; arg: number; open: number } | null {
  const start = Math.max(0, pos - 4000)
  const text = doc.slice(start, pos)
  let depth = 0
  let arg = 0
  let quote: string | null = null
  // Walk backwards; a doubled quote inside a string reads as two strings, which balances out
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === ';') return null
    else if (c === ')') depth++
    else if (c === ',' && depth === 0) arg++
    else if (c === '(') {
      if (depth > 0) {
        depth--
        continue
      }
      const name = /([A-Za-z_][\w$]*)\s*$/.exec(text.slice(0, i))?.[1].toLowerCase()
      return name && !NOT_CALLS.has(name) ? { name, arg, open: start + i } : null
    }
  }
  return null
}

/** A tooltip with the signature of the function call the cursor is in. */
export function signatureHelp(
  dialect: Dialect,
  mariaDb?: ServerVersion,
  postgres?: number
): Extension {
  const byName = new Map(functionsFor(dialect, mariaDb, postgres).map((f) => [f.name, f]))
  const tooltip = (state: EditorState): Tooltip | null => {
    const sel = state.selection.main
    if (!sel.empty) return null
    const call = callAt(
      state.sliceDoc(Math.max(0, sel.head - 4000), sel.head),
      Math.min(sel.head, 4000)
    )
    const fn = call && byName.get(call.name)
    if (!call || !fn || !fn.params.length) return null
    return {
      pos: sel.head - Math.min(sel.head, 4000) + call.open,
      above: true,
      strictSide: false,
      arrow: false,
      create: () => {
        const dom = document.createElement('div')
        dom.className = 'cm-signature'
        dom.append(`${fn.name}(`)
        fn.params.forEach((p, i) => {
          if (i) dom.append(', ')
          const span = document.createElement('span')
          span.textContent = p
          // A trailing `…` stands for every later argument
          if (i === call.arg || (p === '…' && call.arg >= i)) span.className = 'cm-signature-active'
          dom.append(span)
        })
        dom.append(`)${fn.returns ? ` → ${fn.returns}` : ''}`)
        const info = document.createElement('div')
        info.className = 'cm-signature-info'
        info.textContent = fn.description
        dom.append(info)
        return { dom }
      }
    }
  }
  // Shown only while the editor has focus, so it doesn't linger over the rest of the app
  const field = StateField.define<{ focused: boolean; tip: Tooltip | null }>({
    create: (state) => ({ focused: false, tip: tooltip(state) }),
    update: (value, tr) => {
      let focused = value.focused
      for (const e of tr.effects) if (e.is(setFocused)) focused = e.value
      if (!focused) return { focused, tip: null }
      if (tr.docChanged || tr.selection || focused !== value.focused)
        return { focused, tip: tooltip(tr.state) }
      return value
    },
    provide: (f) => showTooltip.from(f, (v) => v.tip)
  })
  return [field, EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing))]
}

const setFocused = StateEffect.define<boolean>()
