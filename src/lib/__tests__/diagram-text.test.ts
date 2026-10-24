import { describe, expect, it } from 'vitest'
import type { ColumnInfo, ForeignKeyInfo, IndexInfo } from '../api'
import { buildEdges, tableKey, type DiagramTable } from '../diagram'
import { LAYOUT_FORMAT, parseLayout, serializeLayout, toDbml, toMermaid } from '../diagram-text'

const col = (name: string, patch: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  dataType: 'integer',
  nullable: false,
  default: null,
  isPrimaryKey: false,
  isGenerated: false,
  isIdentity: false,
  comment: null,
  extra: null,
  ...patch
})

const table = (
  name: string,
  columns: ColumnInfo[],
  extra: Partial<DiagramTable> = {},
  schema: string | null = 'public'
): DiagramTable => ({
  key: tableKey(schema, name),
  schema,
  name,
  kind: 'table',
  columns,
  primaryKey: columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
  foreignKeys: [],
  indexes: [],
  ...extra
})

const fk = (patch: Partial<ForeignKeyInfo>): ForeignKeyInfo => ({
  name: 'fk',
  columns: [],
  refSchema: 'public',
  refTable: '',
  refColumns: ['id'],
  onUpdate: null,
  onDelete: null,
  ...patch
})

const index = (patch: Partial<IndexInfo>): IndexInfo => ({
  name: 'ix',
  columns: [],
  unique: false,
  primary: false,
  method: null,
  definition: null,
  ...patch
})

const users = table(
  'users',
  [
    col('id', { dataType: 'bigint', isPrimaryKey: true, isIdentity: true }),
    col('email', { dataType: 'character varying(255)' }),
    col('name', { dataType: 'text', nullable: true, comment: 'User\'s "display" name' }),
    col('active', { dataType: 'boolean', default: 'true' }),
    col('role', { dataType: 'text', default: "'member'::text" }),
    col('created_at', { dataType: 'timestamptz', default: 'now()' })
  ],
  {
    indexes: [
      index({ name: 'users_pkey', columns: ['id'], unique: true, primary: true }),
      index({ name: 'users_email_key', columns: ['email'], unique: true }),
      index({ name: 'ix_users_name_role', columns: ['name', 'role'] })
    ]
  }
)

const orders = table(
  'orders',
  [
    col('id', { isPrimaryKey: true }),
    col('user_id', { dataType: 'bigint', nullable: true }),
    col('total', { dataType: 'numeric(10,2)' })
  ],
  {
    foreignKeys: [
      fk({
        name: 'orders_user_id_fkey',
        columns: ['user_id'],
        refTable: 'users',
        onDelete: 'CASCADE'
      })
    ]
  }
)

const profiles = table('profiles', [col('user_id', { dataType: 'bigint', isPrimaryKey: true })], {
  foreignKeys: [fk({ name: 'profiles_user_fk', columns: ['user_id'], refTable: 'users' })]
})

const tables = [orders, profiles, users]
const edges = buildEdges(tables)

describe('toDbml', () => {
  const dbml = toDbml(tables, edges)

  it('writes tables with quoted schema-qualified names and column settings', () => {
    expect(dbml).toContain('Table "public"."users" {')
    expect(dbml).toContain('  "id" bigint [pk, increment]')
    expect(dbml).toContain('  "email" "character varying(255)" [not null, unique]')
    expect(dbml).toContain(`  "name" text [note: 'User\\'s "display" name']`)
    expect(dbml).toContain('  "active" boolean [not null, default: true]')
    expect(dbml).toContain(`  "role" text [not null, default: 'member']`)
    expect(dbml).toContain('  "created_at" timestamptz [not null, default: `now()`]')
    expect(dbml).toContain('  "total" numeric(10,2) [not null]')
  })

  it('lists multi-column indexes but not ones already shown as settings', () => {
    expect(dbml).toContain(`    ("name", "role") [name: 'ix_users_name_role']`)
    expect(dbml).not.toContain('users_email_key')
    expect(dbml).not.toContain('users_pkey')
  })

  it('writes composite primary keys as an index', () => {
    const t = table('pairs', [col('a', { isPrimaryKey: true }), col('b', { isPrimaryKey: true })])
    expect(toDbml([t], [])).toContain('    ("a", "b") [pk]')
  })

  it('writes references with cardinality and actions', () => {
    expect(dbml).toContain(
      'Ref "orders_user_id_fkey": "public"."orders"."user_id" > "public"."users"."id" [delete: cascade]'
    )
    expect(dbml).toContain(
      'Ref "profiles_user_fk": "public"."profiles"."user_id" - "public"."users"."id"'
    )
  })

  it('leaves out the schema for engines without one', () => {
    const t = table('t', [col('id', { isPrimaryKey: true })], {}, null)
    expect(toDbml([t], [])).toContain('Table "t" {')
  })
})

describe('toMermaid', () => {
  const mermaid = toMermaid(tables, edges)

  it('writes entities with aliases, keys and comments', () => {
    expect(mermaid.startsWith('erDiagram\n')).toBe(true)
    expect(mermaid).toContain('  public_users["public.users"] {')
    expect(mermaid).toContain('    bigint id PK')
    expect(mermaid).toContain('    character_varying(255) email UK')
    expect(mermaid).toContain(`    text name "User's 'display' name"`)
    expect(mermaid).toContain('    bigint user_id FK')
    expect(mermaid).toContain('    numeric(10_2) total')
  })

  it('writes relationships from parent to child with crow’s foot cardinality', () => {
    expect(mermaid).toContain('  public_users |o--o{ public_orders : "orders_user_id_fkey"')
    expect(mermaid).toContain('  public_users ||--o| public_profiles : "profiles_user_fk"')
  })

  it('keeps entity ids unique and plain', () => {
    const a = table('a b', [], {}, null)
    const b = table('a_b', [], {}, null)
    const out = toMermaid([a, b], [])
    expect(out).toContain('  a_b["a b"] {')
    expect(out).toContain('  a_b_2["a_b"] {')
  })
})

describe('layout files', () => {
  const layout = {
    positions: { 'public.users': { x: 10, y: 20.4 } },
    hidden: ['public.audit'],
    mode: 'keys' as const,
    showTypes: false,
    views: true
  }

  it('round-trips', () => {
    const text = serializeLayout(layout, { database: 'shop', schema: 'public' })
    expect(JSON.parse(text).format).toBe(LAYOUT_FORMAT)
    expect(parseLayout(text)).toEqual({
      ...layout,
      positions: { 'public.users': { x: 10, y: 20 } },
      database: 'shop',
      schema: 'public'
    })
  })

  it('rejects other files and newer versions', () => {
    expect(() => parseLayout('nope')).toThrow(/valid JSON/)
    expect(() => parseLayout('{"name":"dashboard"}')).toThrow(/Not a diagram layout/)
    expect(() => parseLayout(`{"format":"${LAYOUT_FORMAT}","version":2}`)).toThrow(/newer/)
  })

  it('drops malformed entries and fills defaults', () => {
    const parsed = parseLayout(
      JSON.stringify({
        format: LAYOUT_FORMAT,
        version: 1,
        positions: { a: { x: 1, y: 2 }, b: { x: 'x' }, c: null },
        hidden: ['a', 3],
        mode: 'weird'
      })
    )
    expect(parsed.positions).toEqual({ a: { x: 1, y: 2 } })
    expect(parsed.hidden).toEqual(['a'])
    expect(parsed.mode).toBe('all')
    expect(parsed.showTypes).toBe(true)
  })
})
