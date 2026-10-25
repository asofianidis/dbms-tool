import type { Cell } from './api'
import type { Change, SnapshotObject } from './compare'
import { literal, qualified, quoteIdent } from './sql'

/**
 * The parts of a PostgreSQL schema compare needs beyond what `describe_table`
 * reports: user-defined types, extensions, CHECK / UNIQUE / EXCLUDE
 * constraints and partitioning. Catalog SQL and parsers here; the loader is
 * `features/compare/load-pg.ts`.
 */

/* ---------- Shapes ---------- */

export interface PgConstraint {
  name: string
  type: 'check' | 'unique' | 'exclude'
  /** pg_get_constraintdef: `CHECK ((qty > 0))`, `EXCLUDE USING gist (room WITH =, during WITH &&)` … */
  definition: string
  /** Index that enforces a UNIQUE or EXCLUDE constraint, which isn't compared as a plain index */
  index: string | null
}

export interface PgPartition {
  schema: string
  name: string
  /** Direct parent: the table itself or, for a sub-partition, another partition */
  parentSchema: string
  parent: string
  /** `FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')`, `DEFAULT` … */
  bound: string
  /** Partition key when the partition is itself partitioned */
  key: string | null
}

/** Per-table extras; partitions are every level below the table, parents first. */
export interface PgTableExtras {
  constraints: PgConstraint[]
  /** pg_get_partkeydef, e.g. `RANGE (created_at)`; null for a plain table */
  partitionKey: string | null
  partitions: PgPartition[]
}

export type PgTypeDetail =
  | { type: 'enum'; labels: string[] }
  | { type: 'composite'; attributes: { name: string; type: string }[] }
  | {
      type: 'domain'
      base: string
      default: string | null
      notNull: boolean
      checks: { name: string; definition: string }[]
    }
  | { type: 'range' }

/* ---------- Catalog SQL ---------- */

const inList = (schemas: string[]): string =>
  schemas.map((s) => literal('postgres', s)).join(', ') || 'NULL'

/** CHECK, UNIQUE and EXCLUDE constraints of the tables in the schemas. */
export function pgConstraintsSql(schemas: string[]): string {
  // Columns: schema, table, name, type, definition, enforcing index
  return `SELECT n.nspname::text, c.relname::text, con.conname::text, con.contype::text,
  pg_get_constraintdef(con.oid), i.relname::text
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_class i ON i.oid = con.conindid
WHERE n.nspname IN (${inList(schemas)}) AND con.contype IN ('c', 'u', 'x') AND con.conislocal
ORDER BY 1, 2, 3`
}

/** Partitioned tables and partitions whose parent is in the schemas. */
export function pgPartitionsSql(schemas: string[]): string {
  // Columns: schema, name, parent schema, parent, bound, partition key
  // Top-level partitioned tables come with a null parent
  return `SELECT n.nspname::text, c.relname::text, pn.nspname::text, p.relname::text,
  pg_get_expr(c.relpartbound, c.oid), CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid AND c.relispartition
LEFT JOIN pg_class p ON p.oid = i.inhparent
LEFT JOIN pg_namespace pn ON pn.oid = p.relnamespace
WHERE (c.relispartition AND c.relkind IN ('r', 'p') AND pn.nspname IN (${inList(schemas)}))
   OR (c.relkind = 'p' AND NOT c.relispartition AND n.nspname IN (${inList(schemas)}))
ORDER BY 1, 2`
}

/** Enum labels, composite attributes and domain details, as JSON, for the types in the schemas. */
export function pgTypeDetailsSql(schemas: string[]): string {
  // Columns: schema, name, kind letter, detail JSON
  return `SELECT n.nspname::text, t.typname::text, t.typtype::text,
  CASE t.typtype
    WHEN 'e' THEN (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
    WHEN 'c' THEN (SELECT json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
                   FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped)
    WHEN 'd' THEN json_build_object('base', format_type(t.typbasetype, t.typtypmod), 'default', t.typdefault,
      'notNull', t.typnotnull,
      'checks', coalesce((SELECT json_agg(json_build_array(c.conname, pg_get_constraintdef(c.oid)) ORDER BY c.conname)
                          FROM pg_constraint c WHERE c.contypid = t.oid AND c.contype = 'c'), '[]'::json))
  END::text
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname IN (${inList(schemas)}) AND t.typtype IN ('d', 'e', 'c', 'r')
  AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
ORDER BY 1, 2`
}

/* ---------- Parsing ---------- */

const str = (cell: Cell | undefined): string | null => (typeof cell === 'string' ? cell : null)

const json = (cell: Cell | undefined): unknown => {
  try {
    return JSON.parse(str(cell) ?? 'null')
  } catch {
    return null
  }
}

const tableKey = (schema: string, name: string): string => `${schema}\u0000${name}`

const CONSTRAINT_TYPES: Record<string, PgConstraint['type']> = {
  c: 'check',
  u: 'unique',
  x: 'exclude'
}

/** Groups constraint and partition rows by their top-level table (`schema\0name`). */
export function parsePgTableExtras(
  constraintRows: Cell[][],
  partitionRows: Cell[][]
): Map<string, PgTableExtras> {
  const out = new Map<string, PgTableExtras>()
  const of = (key: string): PgTableExtras => {
    let extras = out.get(key)
    if (!extras) {
      extras = { constraints: [], partitionKey: null, partitions: [] }
      out.set(key, extras)
    }
    return extras
  }
  for (const r of constraintRows) {
    const type = CONSTRAINT_TYPES[str(r[3]) ?? '']
    if (!type) continue
    of(tableKey(str(r[0]) ?? '', str(r[1]) ?? '')).constraints.push({
      name: str(r[2]) ?? '',
      type,
      definition: str(r[4]) ?? '',
      index: str(r[5])
    })
  }
  const children = new Map<string, PgPartition[]>()
  for (const r of partitionRows) {
    const schema = str(r[0]) ?? ''
    const name = str(r[1]) ?? ''
    const parent = str(r[3])
    if (parent === null) {
      of(tableKey(schema, name)).partitionKey = str(r[5])
      continue
    }
    const parentSchema = str(r[2]) ?? ''
    const key = tableKey(parentSchema, parent)
    children.set(key, [
      ...(children.get(key) ?? []),
      { schema, name, parentSchema, parent, bound: str(r[4]) ?? '', key: str(r[5]) }
    ])
  }
  // Each top-level table collects its partitions level by level, so parents come first
  for (const [key, extras] of out) {
    if (!extras.partitionKey) continue
    const queue = [...(children.get(key) ?? [])]
    while (queue.length) {
      const p = queue.shift()!
      extras.partitions.push(p)
      queue.push(...(children.get(tableKey(p.schema, p.name)) ?? []))
    }
  }
  return out
}

export function pgExtrasFor(
  extras: Map<string, PgTableExtras>,
  schema: string | null,
  name: string
): PgTableExtras {
  return extras.get(tableKey(schema ?? '', name)) ?? emptyPgExtras()
}

export const emptyPgExtras = (): PgTableExtras => ({
  constraints: [],
  partitionKey: null,
  partitions: []
})

/** Type details keyed `schema\0name`. */
export function parsePgTypeDetails(rows: Cell[][]): Map<string, PgTypeDetail> {
  const out = new Map<string, PgTypeDetail>()
  for (const r of rows) {
    const key = tableKey(str(r[0]) ?? '', str(r[1]) ?? '')
    const value = json(r[3])
    switch (str(r[2])) {
      case 'e':
        out.set(key, { type: 'enum', labels: Array.isArray(value) ? value.map(String) : [] })
        break
      case 'c':
        out.set(key, {
          type: 'composite',
          attributes: (Array.isArray(value) ? value : []).map((a) => ({
            name: String((a as unknown[])[0]),
            type: String((a as unknown[])[1])
          }))
        })
        break
      case 'd': {
        const d = (value ?? {}) as {
          base?: string
          default?: string | null
          notNull?: boolean
          checks?: [string, string][]
        }
        out.set(key, {
          type: 'domain',
          base: d.base ?? '',
          default: d.default ?? null,
          notNull: !!d.notNull,
          checks: (d.checks ?? []).map(([name, definition]) => ({ name, definition }))
        })
        break
      }
      case 'r':
        out.set(key, { type: 'range' })
    }
  }
  return out
}

export const typeDetailFor = (
  details: Map<string, PgTypeDetail>,
  schema: string | null,
  name: string
): PgTypeDetail | undefined => details.get(tableKey(schema ?? '', name))

/* ---------- Comparing ---------- */

/** Where a step goes in the script; compare.ts maps these onto its phases. */
export type PgPhase =
  'extensions' | 'types' | 'detach' | 'dropConstraints' | 'tables' | 'dropTypes' | 'dropExtensions'

export interface PgEnv {
  /** Rewrites the source's schema qualifiers into the target's */
  text: (s: string) => string
  schema: (s: string | null) => string | null
  /** Schema an object's statements use in the target */
  qualifier: (schema: string | null) => string | null
}

export interface PgOut {
  changes: Change[]
  warnings: string[]
  step: (phase: PgPhase, sql: string) => void
}

const q = (name: string): string => quoteIdent('postgres', name)
const name = (qualifier: string | null, n: string): string =>
  qualified('postgres', { schema: qualifier, name: n })

/** Indexes that enforce constraints; they come and go with their constraint. */
export const pgConstraintIndexes = (extras: PgTableExtras | undefined): Set<string> =>
  new Set((extras?.constraints ?? []).flatMap((c) => (c.index ? [c.index] : [])))

/** A partitioned table's index definition replays `ON ONLY`, which wouldn't reach the partitions. */
export const pgIndexSql = (definition: string): string =>
  definition.replace(/^(CREATE\s+(?:UNIQUE\s+)?INDEX\s+.*?\s+ON\s+)ONLY\s+/i, '$1')

/** CREATE TABLE … (…) PARTITION BY key */
export function withPartitionKey(sql: string, key: string | null): string {
  return key && /^CREATE\s+TABLE\b/i.test(sql) ? `${sql} PARTITION BY ${key}` : sql
}

const CONSTRAINT_LABEL: Record<PgConstraint['type'], string> = {
  check: 'check',
  unique: 'unique constraint',
  exclude: 'exclusion constraint'
}

/** Steps that bring a table's constraints and partitions in line; `target` undefined creates them. */
export function pgTableSteps(
  env: PgEnv,
  table: string,
  source: PgTableExtras,
  target: PgTableExtras | undefined,
  out: PgOut
): void {
  const creating = !target
  const t = target ?? emptyPgExtras()

  // Constraints: matched by name, then by definition, so generated names don't count
  const sourceConstraints = source.constraints.map((c) => ({
    ...c,
    definition: env.text(c.definition)
  }))
  const free = new Set(sourceConstraints)
  const add = (c: PgConstraint): void => {
    out.step('tables', `ALTER TABLE ${table} ADD CONSTRAINT ${q(c.name)} ${c.definition}`)
    if (creating) return
    if (c.type === 'check' && !/\bNOT VALID$/i.test(c.definition))
      out.warnings.push(
        `Adding ${c.name} checks every row while holding a lock; on a big table add it with NOT VALID and run ALTER TABLE ${table} VALIDATE CONSTRAINT ${q(c.name)} separately`
      )
    else if (c.type !== 'check')
      out.warnings.push(
        `Adding ${c.name} builds an index and blocks writes while it does; on a big table run it in a quiet period`
      )
  }
  const drop = (c: PgConstraint): void =>
    out.step('dropConstraints', `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${q(c.name)}`)
  const unmatched: PgConstraint[] = []
  for (const tc of t.constraints) {
    const sc = [...free].find((c) => c.name === tc.name)
    if (!sc) {
      unmatched.push(tc)
      continue
    }
    free.delete(sc)
    if (sc.definition === tc.definition && sc.type === tc.type) continue
    out.changes.push({
      action: 'change',
      what: CONSTRAINT_LABEL[sc.type],
      name: sc.name,
      from: tc.definition,
      to: sc.definition
    })
    drop(tc)
    add(sc)
  }
  for (const tc of unmatched) {
    const sc = [...free].find((c) => c.definition === tc.definition && c.type === tc.type)
    if (sc) free.delete(sc)
    else {
      out.changes.push({
        action: 'drop',
        what: CONSTRAINT_LABEL[tc.type],
        name: tc.name,
        from: tc.definition
      })
      drop(tc)
    }
  }
  for (const sc of sourceConstraints.filter((c) => free.has(c))) {
    out.changes.push({
      action: 'add',
      what: CONSTRAINT_LABEL[sc.type],
      name: sc.name,
      to: sc.definition
    })
    add(sc)
  }

  // Partitions
  if (!creating && (source.partitionKey ?? '') !== (t.partitionKey ?? '')) {
    out.changes.push({
      action: 'change',
      what: 'partition key',
      name: 'partition key',
      from: t.partitionKey ?? 'not partitioned',
      to: source.partitionKey ?? 'not partitioned'
    })
    out.warnings.push(
      `The partition key differs and PostgreSQL can't change it in place; recreate the table and copy its data by hand`
    )
    return
  }
  if (!source.partitionKey) return
  const where = (schema: string, n: string): string => name(env.qualifier(env.schema(schema)), n)
  const parentOf = (p: PgPartition): string => where(p.parentSchema, p.parent)
  const create = (p: PgPartition): void =>
    out.step(
      'tables',
      withPartitionKey(
        `CREATE TABLE ${where(p.schema, p.name)} PARTITION OF ${parentOf(p)} ${p.bound}`,
        p.key
      )
    )
  const describe = (p: PgPartition): string =>
    `${p.bound} (in ${p.parent})${p.key ? ` PARTITION BY ${p.key}` : ''}`
  const targets = new Map(t.partitions.map((p) => [p.name, p]))
  const seen = new Set<string>()
  for (const raw of source.partitions) {
    const p = { ...raw, bound: env.text(raw.bound), key: raw.key && env.text(raw.key) }
    const tp = targets.get(p.name)
    if (!tp) {
      out.changes.push({ action: 'add', what: 'partition', name: p.name, to: describe(p) })
      create(p)
      continue
    }
    seen.add(tp.name)
    if ((p.key ?? '') !== (tp.key ?? '')) {
      out.changes.push({
        action: 'change',
        what: 'partition',
        name: p.name,
        from: describe(tp),
        to: describe(p)
      })
      out.warnings.push(
        `Partition ${p.name}'s own partition key differs; PostgreSQL can't change it in place`
      )
      continue
    }
    if (p.bound === tp.bound && p.parent === tp.parent) continue
    out.changes.push({
      action: 'change',
      what: 'partition',
      name: p.name,
      from: describe(tp),
      to: describe(p)
    })
    out.step(
      'detach',
      `ALTER TABLE ${where(tp.parentSchema, tp.parent)} DETACH PARTITION ${where(tp.schema, tp.name)}`
    )
    out.step(
      'tables',
      `ALTER TABLE ${parentOf(p)} ATTACH PARTITION ${where(p.schema, p.name)} ${p.bound}`
    )
    out.warnings.push(
      `Reattaching ${p.name} with its new bound scans it to check every row fits, and fails if one doesn't`
    )
  }
  for (const tp of t.partitions) {
    if (seen.has(tp.name)) continue
    // A sub-partition goes with its detached parent
    if (t.partitions.some((x) => x.name === tp.parent && !seen.has(x.name))) continue
    out.changes.push({ action: 'drop', what: 'partition', name: tp.name, from: describe(tp) })
    out.step(
      'detach',
      `ALTER TABLE ${where(tp.parentSchema, tp.parent)} DETACH PARTITION ${where(tp.schema, tp.name)}`
    )
    out.warnings.push(
      `Partition ${tp.name} is detached, not dropped: it stays as a table with its data, and the next comparison offers to drop it`
    )
  }
}

/** Constraints and partitions as statements, appended to the side-by-side table text. */
export function pgTableText(
  env: Pick<PgEnv, 'qualifier' | 'schema'>,
  table: string,
  extras: PgTableExtras
): string[] {
  const lines = extras.constraints.map(
    (c) => `ALTER TABLE ${table} ADD CONSTRAINT ${q(c.name)} ${c.definition};`
  )
  if (extras.partitionKey) lines.unshift(`-- PARTITION BY ${extras.partitionKey}`)
  const where = (schema: string, n: string): string => name(env.qualifier(env.schema(schema)), n)
  for (const p of extras.partitions)
    lines.push(
      `${withPartitionKey(`CREATE TABLE ${where(p.schema, p.name)} PARTITION OF ${where(p.parentSchema, p.parent)} ${p.bound}`, p.key)};`
    )
  return lines
}

/* ---------- Types and extensions ---------- */

const typeKeyword = (o: SnapshotObject): string =>
  (o.pgType?.type ?? o.detail) === 'domain' ? 'DOMAIN' : 'TYPE'

/** Makes the target's type or extension match the source's; either side may be missing. */
export function pgObjectSteps(
  env: PgEnv,
  source: SnapshotObject | undefined,
  target: SnapshotObject | undefined,
  out: PgOut
): void {
  const o = (source ?? target)!
  if (o.kind === 'extension') return extensionSteps(env, source, target, out)
  const qualifier = env.qualifier(target?.schema ?? o.schema)
  const typeName = name(qualifier, o.name)
  const create = (): void => {
    if (source?.definition) out.step('types', source.definition.replace(/[;\s]+$/, ''))
    else
      out.warnings.push(`The source's definition of ${o.name} couldn't be read; it isn't scripted`)
  }
  const drop = (t: SnapshotObject): void =>
    out.step('dropTypes', `DROP ${typeKeyword(t)} ${typeName}`)
  if (!target) return create()
  if (!source) {
    out.warnings.push(`Dropping ${o.name} fails while columns, functions or other types use it`)
    return drop(target)
  }
  const s = source.pgType
  const t = target.pgType
  if (!s || !t || s.type !== t.type || s.type === 'range') {
    out.warnings.push(
      `${o.name} is dropped and created again, which fails while anything uses it; change it by hand if it's in use`
    )
    // Both in the types phase, so the new type exists before tables use it
    out.step('types', `DROP ${typeKeyword(target)} ${typeName}`)
    return create()
  }
  if (s.type === 'enum' && t.type === 'enum') return enumSteps(typeName, s.labels, t.labels, out)
  if (s.type === 'composite' && t.type === 'composite')
    return compositeSteps(env, typeName, s.attributes, t.attributes, out)
  if (s.type === 'domain' && t.type === 'domain') return domainSteps(env, typeName, s, t, out)
}

function enumSteps(typeName: string, want: string[], have: string[], out: PgOut): void {
  const extra = have.filter((l) => !want.includes(l))
  const common = want.filter((l) => have.includes(l))
  const kept = have.filter((l) => want.includes(l))
  if (extra.length) {
    out.changes.push({ action: 'drop', what: 'label', name: extra.join(', ') })
    out.warnings.push(
      `PostgreSQL can't drop enum labels (${extra.join(', ')}); recreate the type by hand if they must go`
    )
  }
  if (common.join('\u0000') !== kept.join('\u0000')) {
    out.changes.push({
      action: 'change',
      what: 'label order',
      name: 'labels',
      from: have.join(', '),
      to: want.join(', ')
    })
    out.warnings.push(`PostgreSQL can't reorder enum labels; recreate the type by hand`)
  }
  const present = new Set(have)
  want.forEach((label, i) => {
    if (present.has(label)) return
    // Placed after the label before it in the source, or before the next one at the start
    const after = want
      .slice(0, i)
      .reverse()
      .find((l) => present.has(l))
    const before = want.slice(i + 1).find((l) => present.has(l))
    const position = after
      ? ` AFTER ${literal('postgres', after)}`
      : before
        ? ` BEFORE ${literal('postgres', before)}`
        : ''
    out.step('types', `ALTER TYPE ${typeName} ADD VALUE ${literal('postgres', label)}${position}`)
    out.changes.push({ action: 'add', what: 'label', name: label })
    present.add(label)
  })
  if (want.some((l) => !have.includes(l)))
    out.warnings.push(
      `New enum labels can't be used until the transaction that adds them commits; if the script runs as one transaction and uses them, run the ALTER TYPE statements first`
    )
}

function compositeSteps(
  env: PgEnv,
  typeName: string,
  want: { name: string; type: string }[],
  have: { name: string; type: string }[],
  out: PgOut
): void {
  for (const a of have)
    if (!want.some((w) => w.name === a.name)) {
      out.changes.push({ action: 'drop', what: 'attribute', name: a.name, from: a.type })
      out.step('types', `ALTER TYPE ${typeName} DROP ATTRIBUTE ${q(a.name)}`)
    }
  for (const w of want) {
    const type = env.text(w.type)
    const a = have.find((x) => x.name === w.name)
    if (!a) {
      out.changes.push({ action: 'add', what: 'attribute', name: w.name, to: type })
      out.step('types', `ALTER TYPE ${typeName} ADD ATTRIBUTE ${q(w.name)} ${type}`)
    } else if (a.type !== type) {
      out.changes.push({
        action: 'change',
        what: 'attribute',
        name: w.name,
        from: a.type,
        to: type
      })
      out.step('types', `ALTER TYPE ${typeName} ALTER ATTRIBUTE ${q(w.name)} SET DATA TYPE ${type}`)
    }
  }
  const order = (xs: { name: string }[], keep: { name: string }[]): string =>
    xs
      .filter((x) => keep.some((k) => k.name === x.name))
      .map((x) => x.name)
      .join('\u0000')
  if (order(want, have) !== order(have, want))
    out.warnings.push(`Attribute order differs; PostgreSQL can't reorder a type's attributes`)
}

function domainSteps(
  env: PgEnv,
  typeName: string,
  want: Extract<PgTypeDetail, { type: 'domain' }>,
  have: Extract<PgTypeDetail, { type: 'domain' }>,
  out: PgOut
): void {
  const base = env.text(want.base)
  if (base !== have.base) {
    out.changes.push({
      action: 'change',
      what: 'base type',
      name: 'base type',
      from: have.base,
      to: base
    })
    out.warnings.push(
      `A domain's base type can't be changed; drop and recreate ${typeName} by hand once nothing uses it`
    )
  }
  const def = want.default === null ? null : env.text(want.default)
  if (def !== have.default) {
    out.changes.push({
      action: def === null ? 'drop' : have.default === null ? 'add' : 'change',
      what: 'default',
      name: 'default',
      from: have.default ?? undefined,
      to: def ?? undefined
    })
    out.step(
      'types',
      `ALTER DOMAIN ${typeName} ${def === null ? 'DROP DEFAULT' : `SET DEFAULT ${def}`}`
    )
  }
  if (want.notNull !== have.notNull) {
    out.changes.push({
      action: want.notNull ? 'add' : 'drop',
      what: 'not null',
      name: 'NOT NULL'
    })
    out.step('types', `ALTER DOMAIN ${typeName} ${want.notNull ? 'SET' : 'DROP'} NOT NULL`)
  }
  const checks = want.checks.map((c) => ({ ...c, definition: env.text(c.definition) }))
  const add = (c: { name: string; definition: string }): void => {
    out.step('types', `ALTER DOMAIN ${typeName} ADD CONSTRAINT ${q(c.name)} ${c.definition}`)
    if (!/\bNOT VALID$/i.test(c.definition))
      out.warnings.push(
        `Adding ${c.name} checks every column that uses the domain; on big tables add it with NOT VALID and run ALTER DOMAIN … VALIDATE CONSTRAINT separately`
      )
  }
  const drop = (n: string): void =>
    out.step('types', `ALTER DOMAIN ${typeName} DROP CONSTRAINT IF EXISTS ${q(n)}`)
  for (const h of have.checks) {
    const w = checks.find((c) => c.name === h.name)
    if (!w) {
      out.changes.push({ action: 'drop', what: 'check', name: h.name, from: h.definition })
      drop(h.name)
    } else if (w.definition !== h.definition) {
      out.changes.push({
        action: 'change',
        what: 'check',
        name: h.name,
        from: h.definition,
        to: w.definition
      })
      drop(h.name)
      add(w)
    }
  }
  for (const w of checks)
    if (!have.checks.some((h) => h.name === w.name)) {
      out.changes.push({ action: 'add', what: 'check', name: w.name, to: w.definition })
      add(w)
    }
}

/** CREATE EXTENSION without a version: the target gets its default, and a version change is an UPDATE. */
export function extensionDefinition(
  schema: string | null,
  n: string,
  version: string | null
): string {
  return `CREATE EXTENSION IF NOT EXISTS ${q(n)}${schema ? ` WITH SCHEMA ${q(schema)}` : ''}${version ? ` VERSION ${literal('postgres', version)}` : ''}`
}

/** Whether two extensions differ, with the source's schema renamed into the target. */
export function extensionDiffers(
  env: PgEnv,
  source: SnapshotObject,
  target: SnapshotObject
): boolean {
  return (
    env.schema(source.schema) !== target.schema || (source.detail ?? '') !== (target.detail ?? '')
  )
}

function extensionSteps(
  env: PgEnv,
  source: SnapshotObject | undefined,
  target: SnapshotObject | undefined,
  out: PgOut
): void {
  const ext = q((source ?? target)!.name)
  if (!source) {
    out.warnings.push(`Dropping extension ${target!.name} fails while objects use it`)
    out.step('dropExtensions', `DROP EXTENSION ${ext}`)
    return
  }
  const schema = env.schema(source.schema)
  if (!target) {
    out.step('extensions', extensionDefinition(schema, source.name, null))
    if (source.detail)
      out.warnings.push(
        `Creates the target server's default version of ${source.name}; the source has ${source.detail}`
      )
    return
  }
  if (schema !== target.schema && schema) {
    out.changes.push({
      action: 'change',
      what: 'schema',
      name: 'schema',
      from: target.schema ?? '',
      to: schema
    })
    out.step('extensions', `ALTER EXTENSION ${ext} SET SCHEMA ${q(schema)}`)
    out.warnings.push(`Only relocatable extensions can move to another schema`)
  }
  if (source.detail && source.detail !== target.detail) {
    out.changes.push({
      action: 'change',
      what: 'version',
      name: 'version',
      from: target.detail ?? undefined,
      to: source.detail
    })
    out.step('extensions', `ALTER EXTENSION ${ext} UPDATE TO ${literal('postgres', source.detail)}`)
    out.warnings.push(
      `Version ${source.detail} of ${source.name} must be installed on the target server; downgrades usually aren't possible`
    )
  }
}
