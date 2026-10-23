import { describe, expect, it } from 'vitest'
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '../api'
import {
  cleanDefinition,
  compareSnapshots,
  defaultSelection,
  diffLines,
  migrationScript,
  migrationStatements,
  rewriteQualifier,
  type CompareContext,
  type Snapshot,
  type SnapshotObject
} from '../compare'

const column = (patch: Partial<ColumnInfo> & { name: string }): ColumnInfo => ({
  dataType: 'integer',
  nullable: true,
  default: null,
  isPrimaryKey: false,
  isGenerated: false,
  isIdentity: false,
  comment: null,
  extra: null,
  ...patch
})

const pk = (name: string, columns: string[]): IndexInfo => ({
  name,
  columns,
  unique: true,
  primary: true,
  method: 'btree',
  definition: null
})

const table = (patch: Partial<TableInfo> = {}): TableInfo => ({
  columns: [column({ name: 'id', nullable: false, isPrimaryKey: true, isIdentity: true })],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
  triggers: [],
  ...patch
})

const obj = (name: string, patch: Partial<SnapshotObject> = {}): SnapshotObject => ({
  schema: 'public',
  name,
  kind: 'table',
  detail: null,
  ...patch
})

const snapshot = (objects: SnapshotObject[], patch: Partial<Snapshot> = {}): Snapshot => ({
  database: 'app',
  schema: 'public',
  schemas: [],
  objects,
  ...patch
})

const pg = (source: Snapshot, target: Snapshot): CompareContext => ({
  dialect: 'postgres',
  scope: 'schema',
  source,
  target
})

const fk = (patch: Partial<ForeignKeyInfo> & { name: string }): ForeignKeyInfo => ({
  columns: ['user_id'],
  refSchema: 'public',
  refTable: 'users',
  refColumns: ['id'],
  onUpdate: 'NO ACTION',
  onDelete: 'NO ACTION',
  ...patch
})

describe('compareSnapshots: tables', () => {
  it('reports identical tables as the same, with nothing to run', () => {
    const t = obj('users', { table: table() })
    const items = compareSnapshots(pg(snapshot([t]), snapshot([{ ...t }])))
    expect(items.map((i) => i.action)).toEqual(['same'])
    expect(items[0].steps).toEqual([])
  })

  it('alters a table: adds, drops and changes columns', () => {
    const source = obj('users', {
      table: table({
        columns: [
          column({ name: 'id', nullable: false, isPrimaryKey: true, isIdentity: true }),
          column({ name: 'email', dataType: 'text', nullable: false }),
          column({ name: 'age', dataType: 'bigint' })
        ]
      })
    })
    const target = obj('users', {
      table: table({
        columns: [
          column({ name: 'id', nullable: false, isPrimaryKey: true, isIdentity: true }),
          column({ name: 'age', dataType: 'integer' }),
          column({ name: 'legacy', dataType: 'text' })
        ]
      })
    })
    const [item] = compareSnapshots(pg(snapshot([source]), snapshot([target])))
    expect(item.action).toBe('alter')
    expect(item.changes.map((c) => `${c.action} ${c.what} ${c.name}`).sort()).toEqual([
      'add column email',
      'change column age',
      'drop column legacy'
    ])
    expect(migrationStatements([item], new Set([item.id]))).toEqual([
      'ALTER TABLE public.users DROP COLUMN legacy',
      'ALTER TABLE public.users ALTER COLUMN age TYPE bigint USING age::bigint',
      'ALTER TABLE public.users ADD COLUMN email text NOT NULL'
    ])
  })

  it('creates new tables before adding foreign keys between them', () => {
    const users = obj('users', { table: table() })
    const orders = obj('orders', {
      table: table({
        columns: [
          column({ name: 'id', nullable: false, isPrimaryKey: true, isIdentity: true }),
          column({ name: 'user_id', nullable: false })
        ],
        foreignKeys: [fk({ name: 'orders_user_fk', onDelete: 'CASCADE' })]
      })
    })
    const items = compareSnapshots(pg(snapshot([orders, users]), snapshot([])))
    const statements = migrationStatements(items, defaultSelection(items))
    expect(statements.map((s) => s.split('\n')[0])).toEqual([
      'CREATE TABLE public.orders (',
      'CREATE TABLE public.users (',
      'ALTER TABLE public.orders ADD CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE'
    ])
  })

  it('drops a changed foreign key first and adds it back last', () => {
    const source = obj('orders', {
      table: table({
        columns: [column({ name: 'id', nullable: false }), column({ name: 'user_id' })],
        foreignKeys: [fk({ name: 'orders_user_fk', onDelete: 'CASCADE' })]
      })
    })
    const target = obj('orders', {
      table: table({
        columns: [column({ name: 'id', nullable: false }), column({ name: 'user_id' })],
        foreignKeys: [fk({ name: 'orders_user_fk' })]
      })
    })
    const [item] = compareSnapshots(pg(snapshot([source]), snapshot([target])))
    expect(item.changes).toMatchObject([{ action: 'change', what: 'foreign key' }])
    expect(migrationStatements([item], new Set([item.id]))).toEqual([
      'ALTER TABLE public.orders DROP CONSTRAINT orders_user_fk',
      'ALTER TABLE public.orders ADD CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES public.users (id) ON DELETE CASCADE'
    ])
  })

  it('matches indexes by definition when only their names differ', () => {
    const index = (name: string): IndexInfo => ({
      name,
      columns: ['email'],
      unique: false,
      primary: false,
      method: 'btree',
      definition: `CREATE INDEX ${name} ON public.users USING btree (email)`
    })
    const source = obj('users', {
      table: table({ indexes: [pk('users_pkey', ['id']), index('ix_a')] })
    })
    const target = obj('users', {
      table: table({ indexes: [pk('users_pkey', ['id']), index('ix_b')] })
    })
    const [item] = compareSnapshots(pg(snapshot([source]), snapshot([target])))
    expect(item.action).toBe('same')
  })

  it('uses the PostgreSQL index definition for new indexes', () => {
    const partial: IndexInfo = {
      name: 'ix_active',
      columns: ['email'],
      unique: true,
      primary: false,
      method: 'btree',
      definition: 'CREATE UNIQUE INDEX ix_active ON public.users USING btree (email) WHERE active'
    }
    const source = obj('users', { table: table({ indexes: [partial] }) })
    const target = obj('users', { table: table() })
    const [item] = compareSnapshots(pg(snapshot([source]), snapshot([target])))
    expect(migrationStatements([item], new Set([item.id]))).toEqual([partial.definition])
  })

  it('leaves drops out of the default selection', () => {
    const items = compareSnapshots(pg(snapshot([]), snapshot([obj('old', { table: table() })])))
    expect(items[0].action).toBe('drop')
    expect(defaultSelection(items).size).toBe(0)
    expect(migrationStatements(items, new Set([items[0].id]))).toEqual(['DROP TABLE public.old'])
  })

  it('ignores the sequences PostgreSQL identity columns own', () => {
    const items = compareSnapshots(
      pg(
        snapshot([obj('users', { table: table() }), obj('users_id_seq', { kind: 'sequence' })]),
        snapshot([])
      )
    )
    expect(items.map((i) => i.name)).toEqual(['users'])
  })
})

describe('compareSnapshots: other objects and schemas', () => {
  it('renames the source schema into the target', () => {
    const view = (schema: string): SnapshotObject =>
      obj('active_users', {
        schema,
        kind: 'view',
        definition: `CREATE OR REPLACE VIEW ${schema}.active_users AS\n SELECT * FROM ${schema}.users`
      })
    const items = compareSnapshots(
      pg(snapshot([view('dev')], { schema: 'dev' }), snapshot([view('prod')], { schema: 'prod' }))
    )
    expect(items.map((i) => i.action)).toEqual(['same'])
  })

  it('recreates changed views and replaces changed PostgreSQL functions in place', () => {
    const view = (sql: string): SnapshotObject =>
      obj('v', { kind: 'view', definition: `CREATE OR REPLACE VIEW public.v AS\n ${sql}` })
    const fn = (body: string): SnapshotObject =>
      obj('f', {
        kind: 'function',
        detail: '',
        definition: `CREATE OR REPLACE FUNCTION public.f()\n RETURNS integer\n LANGUAGE sql\nAS $function$${body}$function$\n`
      })
    const items = compareSnapshots(
      pg(snapshot([view('SELECT 2'), fn('select 2')]), snapshot([view('SELECT 1'), fn('select 1')]))
    )
    expect(
      migrationStatements(items, defaultSelection(items)).map((s) => s.split('\n')[0])
    ).toEqual([
      'DROP VIEW public.v',
      'CREATE OR REPLACE FUNCTION public.f()',
      'CREATE OR REPLACE VIEW public.v AS'
    ])
  })

  it('creates missing schemas first in a whole-database comparison', () => {
    const ctx: CompareContext = {
      dialect: 'postgres',
      scope: 'database',
      source: snapshot([obj('t', { schema: 'audit', table: table() })], {
        schema: null,
        schemas: ['public', 'audit']
      }),
      target: snapshot([], { schema: null, schemas: ['public'] })
    }
    const items = compareSnapshots(ctx)
    const statements = migrationStatements(items, defaultSelection(items))
    expect(statements[0]).toBe('CREATE SCHEMA audit')
    expect(statements[1]).toMatch(/^CREATE TABLE audit\.t/)
  })

  it('compares MySQL definitions without their DEFINER and across databases', () => {
    const view = (db: string, user: string): SnapshotObject => ({
      schema: db,
      name: 'v',
      kind: 'view',
      detail: null,
      definition: `CREATE ALGORITHM=UNDEFINED DEFINER=\`${user}\`@\`%\` SQL SECURITY DEFINER VIEW \`${db}\`.\`v\` AS select 1 AS \`x\``
    })
    const ctx: CompareContext = {
      dialect: 'mysql',
      scope: 'database',
      source: snapshot([view('dev', 'alice')], { database: 'dev', schema: null }),
      target: snapshot([view('prod', 'bob')], { database: 'prod', schema: null })
    }
    expect(compareSnapshots(ctx).map((i) => i.action)).toEqual(['same'])
  })

  it('wraps SQL Server scripts in a transaction', () => {
    const ctx: CompareContext = {
      dialect: 'tsql',
      scope: 'schema',
      source: snapshot([obj('t', { schema: 'dbo', table: table() })], { schema: 'dbo' }),
      target: snapshot([], { schema: 'dbo' })
    }
    const items = compareSnapshots(ctx)
    const script = migrationScript('tsql', items, defaultSelection(items))
    expect(script).toMatch(
      /^SET XACT_ABORT ON;\nBEGIN TRANSACTION;\nGO\nCREATE TABLE \[dbo\]\.\[t\]/
    )
    expect(script.endsWith('COMMIT TRANSACTION;')).toBe(true)
  })
})

describe('helpers', () => {
  it('rewrites bare and quoted qualifiers', () => {
    expect(
      rewriteQualifier('postgres', 'select * from dev.users join "dev".x', 'dev', 'prod')
    ).toBe('select * from prod.users join prod.x')
    // Only whole qualifiers, not names that end the same way
    expect(rewriteQualifier('postgres', 'select mydev.a, dev.b', 'dev', 'prod')).toBe(
      'select mydev.a, prod.b'
    )
    expect(rewriteQualifier('tsql', 'SELECT * FROM [Dev].[t], DEV.u', 'Dev', 'Prod')).toBe(
      'SELECT * FROM [Prod].[t], [Prod].u'
    )
  })

  it('cleans definitions', () => {
    expect(
      cleanDefinition('mysql', 'CREATE DEFINER=`root`@`localhost` PROCEDURE p() BEGIN END;\r\n')
    ).toBe('CREATE PROCEDURE p() BEGIN END')
  })

  it('diffs lines side by side', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc\nd').map((r) => r.kind)).toEqual([
      'same',
      'changed',
      'same',
      'added'
    ])
    expect(diffLines('', 'x')).toEqual([
      { left: null, right: { line: 1, text: 'x' }, kind: 'added' }
    ])
  })
})
