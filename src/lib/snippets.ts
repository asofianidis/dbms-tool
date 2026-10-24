import { createPersistentStore } from './store'

/**
 * A reusable piece of SQL inserted from autocomplete by typing its prefix.
 * The body uses CodeMirror snippet fields: `${name}` is a placeholder Tab
 * moves through, `${}` the final cursor position.
 */
export interface Snippet {
  id: string
  /** What's typed to offer it, e.g. `selw` */
  prefix: string
  description: string
  body: string
  /** Built-ins can be edited or hidden but come back on reset */
  builtin?: boolean
  hidden?: boolean
}

export const BUILTIN_SNIPPETS: Snippet[] = [
  {
    id: 'b-sel',
    prefix: 'sel',
    description: 'SELECT … FROM …',
    body: 'SELECT ${columns}\nFROM ${table}\nWHERE ${condition};'
  },
  {
    id: 'b-selc',
    prefix: 'selc',
    description: 'Count rows',
    body: 'SELECT count(*)\nFROM ${table}\nWHERE ${condition};'
  },
  {
    id: 'b-selg',
    prefix: 'selg',
    description: 'Count by group',
    body: 'SELECT ${column}, count(*)\nFROM ${table}\nGROUP BY ${column}\nORDER BY count(*) DESC;'
  },
  {
    id: 'b-ins',
    prefix: 'ins',
    description: 'INSERT INTO … VALUES',
    body: 'INSERT INTO ${table} (${columns})\nVALUES (${values});'
  },
  {
    id: 'b-upd',
    prefix: 'upd',
    description: 'UPDATE … SET … WHERE',
    body: 'UPDATE ${table}\nSET ${column} = ${value}\nWHERE ${condition};'
  },
  {
    id: 'b-del',
    prefix: 'del',
    description: 'DELETE … WHERE',
    body: 'DELETE FROM ${table}\nWHERE ${condition};'
  },
  {
    id: 'b-cte',
    prefix: 'cte',
    description: 'WITH … AS (…) SELECT',
    body: 'WITH ${name} AS (\n  ${query}\n)\nSELECT *\nFROM ${name};'
  },
  {
    id: 'b-case',
    prefix: 'case',
    description: 'CASE WHEN … END',
    body: 'CASE\n  WHEN ${condition} THEN ${result}\n  ELSE ${otherwise}\nEND'
  },
  {
    id: 'b-dup',
    prefix: 'dups',
    description: 'Find duplicate values',
    body: 'SELECT ${column}, count(*)\nFROM ${table}\nGROUP BY ${column}\nHAVING count(*) > 1;'
  }
].map((s) => ({ ...s, builtin: true }))

/** User snippets, plus edited or hidden copies of built-ins (same id). */
export const snippetsStore = createPersistentStore<Snippet[]>('dbms.snippets.v1', [])

/** Built-ins (as edited) followed by the user's own, without hidden ones unless asked. */
export function allSnippets(saved: Snippet[], includeHidden = false): Snippet[] {
  const byId = new Map(saved.map((s) => [s.id, s]))
  const builtins = BUILTIN_SNIPPETS.map((b) => byId.get(b.id) ?? b)
  const own = saved.filter((s) => !s.builtin)
  return [...builtins, ...own].filter((s) => includeHidden || !s.hidden)
}

export function saveSnippet(snippet: Snippet): void {
  snippetsStore.set((list) =>
    list.some((s) => s.id === snippet.id)
      ? list.map((s) => (s.id === snippet.id ? snippet : s))
      : [...list, snippet]
  )
}

/** Removes a user snippet; a built-in is hidden instead. */
export function deleteSnippet(snippet: Snippet): void {
  if (snippet.builtin) saveSnippet({ ...snippet, hidden: true })
  else snippetsStore.set((list) => list.filter((s) => s.id !== snippet.id))
}

/** Puts a built-in back as shipped. */
export function resetSnippet(id: string): void {
  snippetsStore.set((list) => list.filter((s) => s.id !== id))
}

export const newSnippet = (): Snippet => ({
  id: crypto.randomUUID(),
  prefix: '',
  description: '',
  body: ''
})

/** Placeholder names in a body, in order of first use. */
export function snippetFields(body: string): string[] {
  const names: string[] = []
  for (const m of body.matchAll(/\$\{([^}]*)\}/g)) {
    if (m[1] && !names.includes(m[1])) names.push(m[1])
  }
  return names
}
