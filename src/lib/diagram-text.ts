import type { ColumnInfo } from './api'
import type { ColumnMode, DiagramEdge, DiagramTable, Point } from './diagram'

/* ---------- DBML ---------- */

const dbmlName = (name: string): string => `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const dbmlString = (s: string): string =>
  `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`
const dbmlTable = (t: Pick<DiagramTable, 'schema' | 'name'>): string =>
  t.schema === null ? dbmlName(t.name) : `${dbmlName(t.schema)}.${dbmlName(t.name)}`

/** Bare types like `bigint` or `varchar(255)`; anything else (spaces, arrays) is quoted. */
const dbmlType = (type: string): string =>
  /^[A-Za-z_]\w*(\(\s*\d+(\s*,\s*\d+)?\s*\))?$/.test(type) ? type : dbmlName(type)

/** A column default as DBML: numbers, strings and booleans as such, anything else as an expression. */
function dbmlDefault(raw: string): string {
  const value = raw.trim()
  if (/^-?\d+(\.\d+)?$/.test(value) || /^(true|false|null)$/i.test(value))
    return value.toLowerCase()
  const quoted = /^'((?:[^']|'')*)'(::[\w\s]+)?$/.exec(value)
  if (quoted) return dbmlString(quoted[1].replace(/''/g, "'"))
  return `\`${value.replace(/`/g, "'")}\``
}

const ACTIONS: Record<string, string> = {
  CASCADE: 'cascade',
  RESTRICT: 'restrict',
  'SET NULL': 'set null',
  'SET DEFAULT': 'set default',
  'NO ACTION': 'no action'
}

/** The tables and relationships as a DBML document (dbdiagram.io, dbdocs). */
export function toDbml(tables: DiagramTable[], edges: DiagramEdge[]): string {
  const byKey = new Map(tables.map((t) => [t.key, t]))
  const blocks: string[] = []
  for (const t of tables) {
    const singleKey = t.primaryKey.length === 1 ? t.primaryKey[0] : null
    const uniqueColumns = new Set(
      t.indexes
        .filter((i) => i.unique && !i.primary && i.columns.length === 1)
        .map((i) => i.columns[0])
    )
    const lines = t.columns.map((c: ColumnInfo) => {
      const settings: string[] = []
      if (c.name === singleKey) settings.push('pk')
      if (c.isIdentity) settings.push('increment')
      if (!c.nullable && c.name !== singleKey) settings.push('not null')
      if (uniqueColumns.has(c.name)) settings.push('unique')
      if (c.default !== null && c.default.trim() && !c.isIdentity)
        settings.push(`default: ${dbmlDefault(c.default)}`)
      if (c.comment) settings.push(`note: ${dbmlString(c.comment)}`)
      return `  ${dbmlName(c.name)} ${dbmlType(c.dataType)}${settings.length ? ` [${settings.join(', ')}]` : ''}`
    })
    const indexes: string[] = []
    if (t.primaryKey.length > 1) indexes.push(`    (${t.primaryKey.map(dbmlName).join(', ')}) [pk]`)
    for (const i of t.indexes) {
      if (i.primary || !i.columns.length) continue
      if (i.unique && i.columns.length === 1) continue
      const settings = [...(i.unique ? ['unique'] : []), `name: ${dbmlString(i.name)}`]
      const columns = i.columns.map((c) =>
        t.columns.some((col) => col.name === c) ? dbmlName(c) : `\`${c.replace(/`/g, "'")}\``
      )
      indexes.push(`    (${columns.join(', ')}) [${settings.join(', ')}]`)
    }
    if (indexes.length) lines.push('', '  indexes {', ...indexes, '  }')
    blocks.push(`Table ${dbmlTable(t)} {\n${lines.join('\n')}\n}`)
  }

  const refs: string[] = []
  for (const e of edges) {
    const from = byKey.get(e.from)
    const to = byKey.get(e.to)
    if (!from || !to) continue
    const fk = from.foreignKeys.find((f) => f.name === e.name)
    const endpoint = (t: DiagramTable, columns: string[]): string =>
      columns.length === 1
        ? `${dbmlTable(t)}.${dbmlName(columns[0])}`
        : `${dbmlTable(t)}.(${columns.map(dbmlName).join(', ')})`
    const settings: string[] = []
    const onDelete = fk?.onDelete?.toUpperCase()
    const onUpdate = fk?.onUpdate?.toUpperCase()
    if (onDelete && onDelete !== 'NO ACTION' && ACTIONS[onDelete])
      settings.push(`delete: ${ACTIONS[onDelete]}`)
    if (onUpdate && onUpdate !== 'NO ACTION' && ACTIONS[onUpdate])
      settings.push(`update: ${ACTIONS[onUpdate]}`)
    refs.push(
      `Ref ${dbmlName(e.name)}: ${endpoint(from, e.fromColumns)} ${e.unique ? '-' : '>'} ${endpoint(to, e.toColumns)}${settings.length ? ` [${settings.join(', ')}]` : ''}`
    )
  }
  return [...blocks, ...(refs.length ? [refs.join('\n')] : [])].join('\n\n') + '\n'
}

/* ---------- Mermaid ---------- */

/** Mermaid attribute types and names allow word characters, dashes, brackets and parentheses. */
const mermaidWord = (s: string): string => {
  const word = s.trim().replace(/[^\w()[\]-]+/g, '_')
  return /^[A-Za-z_*]/.test(word) ? word : `_${word}`
}
const mermaidString = (s: string): string => `"${s.replace(/"/g, "'").replace(/\r?\n/g, ' ')}"`

/** The tables and relationships as a Mermaid `erDiagram` (GitHub, GitLab, Notion markdown). */
export function toMermaid(tables: DiagramTable[], edges: DiagramEdge[]): string {
  // Entity ids must be plain words; the real name goes in an alias label when it differs
  const ids = new Map<string, string>()
  const used = new Set<string>()
  for (const t of tables) {
    const base = t.key.replace(/[^\w-]+/g, '_').replace(/^(?=[^A-Za-z_])/, '_')
    let id = base
    for (let n = 2; used.has(id.toLowerCase()); n++) id = `${base}_${n}`
    used.add(id.toLowerCase())
    ids.set(t.key, id)
  }
  const lines = ['erDiagram']
  for (const t of tables) {
    const id = ids.get(t.key)!
    const head = id === t.key ? id : `${id}[${mermaidString(t.key)}]`
    const fkColumns = new Set(t.foreignKeys.flatMap((f) => f.columns))
    const uniqueColumns = new Set(
      t.indexes
        .filter((i) => i.unique && !i.primary && i.columns.length === 1)
        .map((i) => i.columns[0])
    )
    if (!t.columns.length) {
      lines.push(`  ${head} {`, '  }')
      continue
    }
    lines.push(`  ${head} {`)
    for (const c of t.columns) {
      const keys = [
        ...(t.primaryKey.includes(c.name) ? ['PK'] : []),
        ...(fkColumns.has(c.name) ? ['FK'] : []),
        ...(uniqueColumns.has(c.name) ? ['UK'] : [])
      ]
      const parts = [mermaidWord(c.dataType || 'unknown'), mermaidWord(c.name)]
      if (keys.length) parts.push(keys.join(', '))
      if (c.comment) parts.push(mermaidString(c.comment))
      lines.push(`    ${parts.join(' ')}`)
    }
    lines.push('  }')
  }
  for (const e of edges) {
    const parent = ids.get(e.to)
    const child = ids.get(e.from)
    if (!parent || !child) continue
    // Parent end: exactly one, or zero or one when the referencing columns are nullable
    const parentEnd = e.optional ? '|o' : '||'
    const childEnd = e.unique ? 'o|' : 'o{'
    lines.push(`  ${parent} ${parentEnd}--${childEnd} ${child} : ${mermaidString(e.name)}`)
  }
  return lines.join('\n') + '\n'
}

/* ---------- Layout files ---------- */

export const LAYOUT_FORMAT = 'dbms-tool.diagram-layout'

/**
 * A diagram's arrangement, keyed by `schema.table` rather than by connection so it can be
 * shared and loaded against any connection to the same database.
 */
export interface DiagramLayout {
  positions: Record<string, Point>
  hidden: string[]
  mode: ColumnMode
  showTypes: boolean
  views: boolean
}

export function serializeLayout(
  layout: DiagramLayout,
  source: { database: string; schema: string | null }
): string {
  return (
    JSON.stringify(
      {
        format: LAYOUT_FORMAT,
        version: 1,
        database: source.database,
        schema: source.schema,
        mode: layout.mode,
        showTypes: layout.showTypes,
        views: layout.views,
        hidden: layout.hidden,
        positions: layout.positions
      },
      null,
      2
    ) + '\n'
  )
}

/** Reads a layout file, dropping malformed entries. Throws on files that aren't layouts. */
export function parseLayout(text: string): DiagramLayout & {
  database: string | null
  schema: string | null
} {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Not a diagram layout file: it is not valid JSON')
  }
  const obj = (raw ?? {}) as Record<string, unknown>
  if (obj.format !== LAYOUT_FORMAT) throw new Error('Not a diagram layout file')
  if (typeof obj.version !== 'number' || obj.version > 1)
    throw new Error('This layout was saved by a newer version of the app')
  const positions: Record<string, Point> = {}
  if (obj.positions && typeof obj.positions === 'object') {
    for (const [key, p] of Object.entries(obj.positions as Record<string, unknown>)) {
      const point = p as Partial<Point> | null
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y))
        positions[key] = { x: Math.round(point.x!), y: Math.round(point.y!) }
    }
  }
  const modes: ColumnMode[] = ['all', 'keys', 'none']
  return {
    database: typeof obj.database === 'string' ? obj.database : null,
    schema: typeof obj.schema === 'string' ? obj.schema : null,
    positions,
    hidden: Array.isArray(obj.hidden)
      ? obj.hidden.filter((h): h is string => typeof h === 'string')
      : [],
    mode: modes.includes(obj.mode as ColumnMode) ? (obj.mode as ColumnMode) : 'all',
    showTypes: typeof obj.showTypes === 'boolean' ? obj.showTypes : true,
    views: typeof obj.views === 'boolean' ? obj.views : false
  }
}
