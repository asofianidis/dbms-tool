import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource
} from '@codemirror/autocomplete'
import { COLLECTION_METHODS, DB_METHODS, QUERY_OPERATORS } from '@/lib/mongo-shell'

const HELPERS: Completion[] = [
  'ObjectId',
  'ISODate',
  'NumberLong',
  'NumberInt',
  'NumberDecimal',
  'Double',
  'UUID',
  'BinData',
  'Timestamp',
  'MinKey',
  'MaxKey',
  'print',
  'printjson'
].map((label) => ({ label, type: 'function', apply: `${label}(` }))

const CURSOR_METHODS = [
  'sort',
  'limit',
  'skip',
  'projection',
  'count',
  'explain',
  'hint',
  'maxTimeMS',
  'collation',
  'allowDiskUse',
  'comment',
  'readPref',
  'toArray',
  'pretty'
]

/** Completions for `db.`, `db.<collection>.`, cursor chains, `$` operators and shell helpers. */
export function mongoCompletion(collections: string[]): CompletionSource {
  const collectionOptions: Completion[] = collections.map((name) => ({
    label: name,
    type: 'class',
    detail: 'collection',
    apply: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `getCollection(${JSON.stringify(name)})`
  }))
  const dbOptions: Completion[] = DB_METHODS.map((m) => ({
    label: m,
    type: 'method',
    apply: `${m}(`
  }))
  const collMethods: Completion[] = COLLECTION_METHODS.map((m) => ({
    label: m,
    type: 'method',
    apply: `${m}(`
  }))
  const cursorMethods: Completion[] = CURSOR_METHODS.map((m) => ({
    label: m,
    type: 'method',
    apply: `${m}(`
  }))
  const operators: Completion[] = [...new Set(QUERY_OPERATORS)].map((op) => ({
    label: op,
    type: 'keyword'
  }))

  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos)
    const before = line.text.slice(0, context.pos - line.from)

    const op = /(["']?)(\$[\w]*)$/.exec(before)
    if (op) {
      return { from: context.pos - op[2].length, options: operators, validFor: /^\$?\w*$/ }
    }
    const coll = /\bdb\.([A-Za-z_][\w]*|getCollection\(["'][^"']+["']\))\.(\w*)$/.exec(before)
    if (coll) {
      return { from: context.pos - coll[2].length, options: collMethods, validFor: /^\w*$/ }
    }
    const dbDot = /\bdb\.(\w*)$/.exec(before)
    if (dbDot) {
      return {
        from: context.pos - dbDot[1].length,
        options: [...collectionOptions, ...dbOptions],
        validFor: /^\w*$/
      }
    }
    const chain = /\)\s*\.(\w*)$/.exec(before)
    if (chain) {
      return { from: context.pos - chain[1].length, options: cursorMethods, validFor: /^\w*$/ }
    }
    const word = context.matchBefore(/[A-Za-z_]\w*/)
    if (word && (word.from !== word.to || context.explicit)) {
      return {
        from: word.from,
        options: [
          { label: 'db', type: 'variable' },
          { label: 'use', type: 'keyword', apply: 'use ' },
          { label: 'show', type: 'keyword', apply: 'show ' },
          ...HELPERS
        ],
        validFor: /^\w*$/
      }
    }
    return null
  }
}
