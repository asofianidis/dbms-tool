import { newColumn, newForeignKey, newIndex, type ForeignKeyAction, type TableDraft } from './ddl'
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  ROW_PAD,
  visibleColumns,
  type ColumnMode,
  type DiagramTable,
  type NodeBox,
  type Point
} from './diagram'
import type { Dialect } from './engines'

/* ---------- Hit testing ---------- */

export interface ColumnRef {
  /** Table key */
  key: string
  /** Column name; null for the table itself (its header, or a table drawn without columns) */
  column: string | null
}

/** The topmost table under a point, and the column row it's over. */
export function hitTest(
  tables: DiagramTable[],
  boxes: Map<string, NodeBox>,
  positions: Record<string, Point>,
  mode: ColumnMode,
  point: Point
): ColumnRef | null {
  // Later tables are drawn on top
  for (let i = tables.length - 1; i >= 0; i--) {
    const t = tables[i]
    const box = boxes.get(t.key)
    const at = positions[t.key]
    if (!box || !at) continue
    if (
      point.x < at.x ||
      point.x > at.x + box.width ||
      point.y < at.y ||
      point.y > at.y + box.height
    )
      continue
    return { key: t.key, column: columnAt(t, mode, point.y - at.y) }
  }
  return null
}

/** The column whose row covers `y` (relative to the table's top), or null. */
export function columnAt(table: DiagramTable, mode: ColumnMode, y: number): string | null {
  const index = Math.floor((y - HEADER_HEIGHT - ROW_PAD) / ROW_HEIGHT)
  const rows = visibleColumns(table, mode)
  return index >= 0 && index < rows.length ? rows[index].name : null
}

/* ---------- Drawing a relationship ---------- */

/** A foreign key drawn on the canvas: `child.childColumn` references `parent.parentColumn`. */
export interface LinkSpec {
  child: string
  /** null to add a new column to the child for it */
  childColumn: string | null
  parent: string
  parentColumn: string
}

/** The column alone is the table's primary key or has a unique index of its own. */
export function isKeyColumn(table: DiagramTable, column: string): boolean {
  const alone = (cols: string[]): boolean => cols.length === 1 && cols[0] === column
  return (
    alone(table.primaryKey) ||
    table.indexes.some((i) => (i.unique || i.primary) && alone(i.columns))
  )
}

/** The column a reference to the table should point at: its key, else its first column. */
export function keyColumnOf(table: DiagramTable): string | null {
  if (table.primaryKey.length === 1) return table.primaryKey[0]
  const unique = table.indexes.find((i) => (i.unique || i.primary) && i.columns.length === 1)
  return unique?.columns[0] ?? table.primaryKey[0] ?? table.columns[0]?.name ?? null
}

/**
 * What dragging from a column onto another table means. Dropped on a column, the source
 * references the target, unless only the source is a key (references point at keys).
 * Dropped on a table, a key column gets a new referencing column in that table; any other
 * column references the table's key.
 */
export function orientLink(
  source: { key: string; column: string },
  target: ColumnRef,
  byKey: Map<string, DiagramTable>
): LinkSpec | null {
  const from = byKey.get(source.key)
  const to = byKey.get(target.key)
  if (!from || !to) return null
  if (target.column !== null) {
    if (target.key === source.key && target.column === source.column) return null
    const flip = isKeyColumn(from, source.column) && !isKeyColumn(to, target.column)
    return flip
      ? {
          child: target.key,
          childColumn: target.column,
          parent: source.key,
          parentColumn: source.column
        }
      : {
          child: source.key,
          childColumn: source.column,
          parent: target.key,
          parentColumn: target.column
        }
  }
  if (isKeyColumn(from, source.column) && target.key !== source.key)
    return { child: target.key, childColumn: null, parent: source.key, parentColumn: source.column }
  const key = keyColumnOf(to)
  if (!key || (target.key === source.key && key === source.column)) return null
  return { child: source.key, childColumn: source.column, parent: target.key, parentColumn: key }
}

/** `customers` + `id` → `customer_id`, made unique among the table's columns. */
export function suggestColumnName(parent: string, column: string, taken: string[]): string {
  const singular = /ies$/i.test(parent)
    ? parent.slice(0, -3) + 'y'
    : /[^s]s$/i.test(parent)
      ? parent.slice(0, -1)
      : parent
  const base = `${singular}_${column}`
  const used = new Set(taken.map((t) => t.toLowerCase()))
  let name = base
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}${n}`
  return name
}

const TYPE_ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  int8: 'bigint',
  int2: 'smallint',
  serial: 'integer',
  serial4: 'integer',
  bigserial: 'bigint',
  serial8: 'bigint',
  smallserial: 'smallint',
  'character varying': 'varchar',
  character: 'char',
  bool: 'boolean',
  float8: 'double precision',
  float4: 'real',
  timestamptz: 'timestamp with time zone'
}

function normaliseType(type: string): string {
  const t = type.trim().toLowerCase().replace(/\s+/g, ' ')
  // Display widths and lengths don't stop a reference (int(11) vs int, varchar(50) vs varchar(80))
  const bare = t.replace(/\s*\([^)]*\)/, '')
  return TYPE_ALIASES[bare] ?? bare
}

/** Column types that can't obviously reference each other, e.g. text → integer. */
export function typesDiffer(a: string, b: string): boolean {
  return normaliseType(a) !== normaliseType(b)
}

/** The type a new referencing column takes: the referenced one, without auto-numbering. */
export function referencingType(dialect: Dialect, type: string): string {
  const t = type.trim()
  if (dialect === 'postgres') {
    const serial = /^(big|small)?serial[248]?$/i.exec(t)
    if (serial) return serial[1] ? `${serial[1].toLowerCase()}int` : 'integer'
  }
  return t
}

/** An index already starts with the column, so lookups by it are covered. */
export function hasLeadingIndex(table: DiagramTable, column: string): boolean {
  return table.primaryKey[0] === column || table.indexes.some((i) => i.columns[0] === column)
}

export interface RelationshipChange {
  /** An existing column of the child table, or the new one's name */
  column: string
  /** Set to add `column` as a new column */
  newColumn: { dataType: string; nullable: boolean } | null
  refSchema: string | null
  refTable: string
  refColumn: string
  /** '' for the default name */
  name: string
  onDelete: ForeignKeyAction
  onUpdate: ForeignKeyAction
  /** Also index the referencing column */
  index: boolean
}

/** The child table's draft with the relationship (and its column and index) added. */
export function applyRelationship(
  dialect: Dialect,
  draft: TableDraft,
  change: RelationshipChange
): TableDraft {
  const columns = [...draft.columns]
  if (change.newColumn)
    columns.push(
      newColumn(dialect, {
        name: change.column,
        dataType: change.newColumn.dataType,
        nullable: change.newColumn.nullable
      })
    )
  const id = columns.find((c) => !c.dropped && c.name === change.column)?.id ?? `?${change.column}`
  return {
    ...draft,
    columns,
    foreignKeys: [
      ...draft.foreignKeys,
      newForeignKey({
        name: change.name.trim(),
        columns: [id],
        refSchema: change.refSchema,
        refTable: change.refTable,
        refColumns: [change.refColumn],
        onDelete: change.onDelete,
        onUpdate: change.onUpdate
      })
    ],
    indexes: change.index ? [...draft.indexes, newIndex({ columns: [id] })] : draft.indexes
  }
}

/** The draft with the named foreign key marked for dropping, or null when it isn't there. */
export function dropForeignKey(draft: TableDraft, name: string): TableDraft | null {
  if (!draft.foreignKeys.some((fk) => fk.original?.name === name)) return null
  return {
    ...draft,
    foreignKeys: draft.foreignKeys.map((fk) =>
      fk.original?.name === name ? { ...fk, dropped: true } : fk
    )
  }
}
