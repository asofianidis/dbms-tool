import type {
  CompletionContext,
  CompletionResult,
  CompletionSource
} from '@codemirror/autocomplete'

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
