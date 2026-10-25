import type { Cell } from '@/lib/api'
import { extensionsSql, parseExtensions, parseTypes, typesSql } from '@/lib/catalog'
import type { SnapshotObject } from '@/lib/compare'
import {
  extensionDefinition,
  parsePgTableExtras,
  parsePgTypeDetails,
  pgConstraintsSql,
  pgExtrasFor,
  pgPartitionsSql,
  pgTypeDetailsSql,
  typeDetailFor
} from '@/lib/compare-pg'

/** Types are created in this order, so domains can use enums and composites can use both. */
const TYPE_ORDER = ['enum', 'range', 'domain', 'composite']

/**
 * Adds what a PostgreSQL comparison needs beyond the object list: constraints
 * and partitions on each table and, unless only a table is compared, types and
 * extensions. Whatever can't be read is named in `failed` and left out.
 */
export async function loadPgExtras(
  rows: (sql: string) => Promise<Cell[][]>,
  schemas: string[],
  withTypes: boolean,
  objects: SnapshotObject[],
  failed: string[]
): Promise<void> {
  try {
    const [constraints, partitions] = await Promise.all([
      rows(pgConstraintsSql(schemas)),
      rows(pgPartitionsSql(schemas))
    ])
    const extras = parsePgTableExtras(constraints, partitions)
    for (const o of objects)
      if (o.table && o.kind === 'table') o.pg = pgExtrasFor(extras, o.schema, o.name)
  } catch {
    failed.push('constraints and partitions')
  }
  if (!withTypes) return

  try {
    const [details, ...perSchema] = await Promise.all([
      rows(pgTypeDetailsSql(schemas)),
      ...schemas.map((s) => rows(typesSql('postgres', s)!))
    ])
    const detailOf = parsePgTypeDetails(details)
    const types = perSchema
      .flatMap((r) => parseTypes('postgres', r))
      .sort((a, b) => TYPE_ORDER.indexOf(a.kind) - TYPE_ORDER.indexOf(b.kind))
    for (const t of types)
      objects.push({
        schema: t.schema,
        name: t.name,
        kind: 'type',
        detail: t.kind,
        definition: t.definition,
        pgType: typeDetailFor(detailOf, t.schema, t.name)
      })
  } catch {
    failed.push('types')
  }

  try {
    const extensions = parseExtensions(await rows(extensionsSql('postgres')!))
    for (const e of extensions) {
      // Every database has plpgsql
      if (e.name === 'plpgsql') continue
      objects.push({
        schema: e.schema,
        name: e.name,
        kind: 'extension',
        detail: e.detail,
        definition: extensionDefinition(e.schema, e.name, e.detail)
      })
    }
  } catch {
    failed.push('extensions')
  }
}
