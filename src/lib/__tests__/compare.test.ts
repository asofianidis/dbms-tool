import { describe, expect, it } from 'vitest'
import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from '../api'
import {
  cleanDefinition,
  compareSnapshots,
  defaultSelection,
  dropCount,
  diffLines,
  migrationScript,
  migrationStatements,
  rewriteQualifier,
  type CompareContext,
  type Snapshot,
  type SnapshotObject
} from '../compare'
import {
  parsePgTableExtras,
  type PgConstraint,
  type PgPartition,
  type PgTableExtras,
  type PgTypeDetail
} from '../compare-pg'

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

describe('compareSnapshots: PostgreSQL types, extensions, constraints and partitions', () => {
  const constraint = (patch: Partial<PgConstraint> & { name: string }): PgConstraint => ({
    type: 'check',
    definition: 'CHECK ((qty > 0))',
    index: null,
    ...patch
  })
  const extras = (patch: Partial<PgTableExtras> = {}): PgTableExtras => ({
    constraints: [],
    partitionKey: null,
    partitions: [],
    ...patch
  })
  const enumType = (labels: string[]): SnapshotObject =>
    obj('mood', {
      kind: 'type',
      detail: 'enum',
      definition: `CREATE TYPE public.mood AS ENUM (${labels.map((l) => `'${l}'`).join(', ')});`,
      pgType: { type: 'enum', labels }
    })
  const statementsOf = (items: ReturnType<typeof compareSnapshots>): string[] =>
    migrationStatements(items, new Set(items.map((i) => i.id)))

  it('adds enum labels in place and warns about ones it cannot remove', () => {
    const [item] = compareSnapshots(
      pg(
        snapshot([enumType(['new', 'sad', 'ok', 'happy'])]),
        snapshot([enumType(['sad', 'happy'])])
      )
    )
    expect(item.action).toBe('alter')
    expect(statementsOf([item])).toEqual([
      "ALTER TYPE public.mood ADD VALUE 'new' BEFORE 'sad'",
      "ALTER TYPE public.mood ADD VALUE 'ok' AFTER 'sad'"
    ])
    const [dropped] = compareSnapshots(
      pg(snapshot([enumType(['happy', 'sad'])]), snapshot([enumType(['sad', 'happy', 'meh'])]))
    )
    expect(statementsOf([dropped])).toEqual([])
    expect(dropped.warnings.join('\n')).toMatch(/can't drop enum labels \(meh\)/)
    expect(dropped.warnings.join('\n')).toMatch(/can't reorder enum labels/)
  })

  it('alters domains with ALTER DOMAIN', () => {
    const domain = (
      detail: Omit<Extract<PgTypeDetail, { type: 'domain' }>, 'type'>
    ): SnapshotObject =>
      obj('qty', {
        kind: 'type',
        detail: 'domain',
        definition: `CREATE DOMAIN public.qty AS ${detail.base} ${JSON.stringify(detail)}`,
        pgType: { type: 'domain', ...detail }
      })
    const items = compareSnapshots(
      pg(
        snapshot([
          domain({
            base: 'integer',
            default: '1',
            notNull: true,
            checks: [{ name: 'qty_positive', definition: 'CHECK ((VALUE > 0))' }]
          })
        ]),
        snapshot([
          domain({
            base: 'integer',
            default: null,
            notNull: false,
            checks: [
              { name: 'qty_positive', definition: 'CHECK ((VALUE >= 0))' },
              { name: 'qty_small', definition: 'CHECK ((VALUE < 10))' }
            ]
          })
        ])
      )
    )
    expect(statementsOf(items)).toEqual([
      'ALTER DOMAIN public.qty SET DEFAULT 1',
      'ALTER DOMAIN public.qty SET NOT NULL',
      'ALTER DOMAIN public.qty DROP CONSTRAINT IF EXISTS qty_positive',
      'ALTER DOMAIN public.qty ADD CONSTRAINT qty_positive CHECK ((VALUE > 0))',
      'ALTER DOMAIN public.qty DROP CONSTRAINT IF EXISTS qty_small'
    ])
  })

  it('creates extensions, then types, before the tables that use them, and drops them after', () => {
    const ext = (version: string): SnapshotObject =>
      obj('btree_gist', { kind: 'extension', detail: version, definition: 'x' })
    const booking = obj('booking', {
      table: table({
        columns: [
          column({ name: 'id', nullable: false, isPrimaryKey: true }),
          column({ name: 'm', dataType: 'mood' })
        ]
      }),
      pg: extras()
    })
    const items = compareSnapshots(
      pg(
        snapshot([booking, enumType(['a']), ext('1.7')]),
        snapshot([obj('citext', { kind: 'extension', detail: '1.6', definition: 'x' })])
      )
    )
    expect(items.map((i) => `${i.kind} ${i.action}`)).toEqual([
      'extension create',
      'extension drop',
      'type create',
      'table create'
    ])
    expect(statementsOf(items).map((s) => s.split('\n')[0])).toEqual([
      'CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public',
      "CREATE TYPE public.mood AS ENUM ('a')",
      'CREATE TABLE public.booking (',
      'DROP EXTENSION citext'
    ])
    const [updated] = compareSnapshots(pg(snapshot([ext('1.7')]), snapshot([ext('1.6')])))
    expect(statementsOf([updated])).toEqual(["ALTER EXTENSION btree_gist UPDATE TO '1.7'"])
  })

  it('creates exclusion and unique constraints as constraints, not plain indexes', () => {
    const backing = (name: string, definition: string, unique: boolean): IndexInfo => ({
      name,
      columns: ['room'],
      unique,
      primary: false,
      method: 'gist',
      definition
    })
    const source = obj('booking', {
      table: table({
        indexes: [
          pk('booking_pkey', ['id']),
          backing(
            'booking_no_overlap',
            'CREATE INDEX booking_no_overlap ON public.booking USING gist (room, during)',
            false
          ),
          backing(
            'booking_code_key',
            'CREATE UNIQUE INDEX booking_code_key ON public.booking USING btree (code)',
            true
          )
        ]
      }),
      pg: extras({
        constraints: [
          constraint({
            name: 'booking_no_overlap',
            type: 'exclude',
            definition: 'EXCLUDE USING gist (room WITH =, during WITH &&)',
            index: 'booking_no_overlap'
          }),
          constraint({
            name: 'booking_code_key',
            type: 'unique',
            definition: 'UNIQUE (code)',
            index: 'booking_code_key'
          })
        ]
      })
    })
    const [created] = compareSnapshots(pg(snapshot([source]), snapshot([])))
    expect(statementsOf([created]).slice(1)).toEqual([
      'ALTER TABLE public.booking ADD CONSTRAINT booking_no_overlap EXCLUDE USING gist (room WITH =, during WITH &&)',
      'ALTER TABLE public.booking ADD CONSTRAINT booking_code_key UNIQUE (code)'
    ])
    // Against a target without them: the constraints are added, and their indexes aren't
    const target = obj('booking', {
      table: table({ indexes: [pk('booking_pkey', ['id'])] }),
      pg: extras()
    })
    const [altered] = compareSnapshots(pg(snapshot([source]), snapshot([target])))
    expect(altered.changes.map((c) => `${c.action} ${c.what}`)).toEqual([
      'add exclusion constraint',
      'add unique constraint'
    ])
  })

  it('adds, drops and changes CHECK constraints, suggesting NOT VALID', () => {
    const source = obj('stock', {
      table: table(),
      pg: extras({
        constraints: [
          constraint({ name: 'stock_qty_check' }),
          constraint({ name: 'stock_auto1', definition: 'CHECK ((id > 0))' })
        ]
      })
    })
    const target = obj('stock', {
      table: table(),
      pg: extras({
        constraints: [
          constraint({ name: 'stock_qty_check', definition: 'CHECK ((qty >= 0))' }),
          constraint({ name: 'stock_auto2', definition: 'CHECK ((id > 0))' }),
          constraint({ name: 'stock_old', definition: 'CHECK ((qty < 100))' })
        ]
      })
    })
    const [item] = compareSnapshots(pg(snapshot([source]), snapshot([target])))
    expect(item.action).toBe('alter')
    expect(statementsOf([item])).toEqual([
      'ALTER TABLE public.stock DROP CONSTRAINT IF EXISTS stock_qty_check',
      'ALTER TABLE public.stock DROP CONSTRAINT IF EXISTS stock_old',
      'ALTER TABLE public.stock ADD CONSTRAINT stock_qty_check CHECK ((qty > 0))'
    ])
    expect(item.warnings.join('\n')).toMatch(/NOT VALID/)
  })

  it('creates partitioned tables with PARTITION BY and their partitions', () => {
    const events = obj('events', {
      table: table({
        indexes: [
          pk('events_pkey', ['id']),
          {
            name: 'events_at_idx',
            columns: ['at'],
            unique: false,
            primary: false,
            method: 'btree',
            definition: 'CREATE INDEX events_at_idx ON ONLY public.events USING btree (at)'
          }
        ]
      }),
      pg: extras({
        partitionKey: 'RANGE (at)',
        partitions: [
          {
            schema: 'public',
            name: 'events_2024',
            parentSchema: 'public',
            parent: 'events',
            bound: "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')",
            key: 'HASH (id)'
          },
          {
            schema: 'public',
            name: 'events_2024_h0',
            parentSchema: 'public',
            parent: 'events_2024',
            bound: 'FOR VALUES WITH (modulus 1, remainder 0)',
            key: null
          }
        ]
      })
    })
    const [item] = compareSnapshots(pg(snapshot([events]), snapshot([])))
    const statements = statementsOf([item])
    expect(statements[0]).toMatch(
      /^CREATE TABLE public\.events \([\s\S]*\) PARTITION BY RANGE \(at\)$/
    )
    expect(statements.slice(1)).toEqual([
      'CREATE INDEX events_at_idx ON public.events USING btree (at)',
      "CREATE TABLE public.events_2024 PARTITION OF public.events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01') PARTITION BY HASH (id)",
      'CREATE TABLE public.events_2024_h0 PARTITION OF public.events_2024 FOR VALUES WITH (modulus 1, remainder 0)'
    ])

    // Partition key changes can't be scripted
    const plain = obj('events', { table: events.table, pg: extras() })
    const [rekeyed] = compareSnapshots(pg(snapshot([events]), snapshot([plain])))
    expect(rekeyed.changes).toMatchObject([{ what: 'partition key', to: 'RANGE (at)' }])
    expect(statementsOf([rekeyed])).toEqual([])
    expect(rekeyed.warnings.join('\n')).toMatch(/can't change it in place/)
  })

  it('reattaches partitions whose bound changed and detaches extra ones', () => {
    const partition = (name: string, bound: string): PgPartition => ({
      schema: 'public',
      name,
      parentSchema: 'public',
      parent: 'events',
      bound,
      key: null
    })
    const events = (partitions: PgPartition[]): SnapshotObject =>
      obj('events', { table: table(), pg: extras({ partitionKey: 'LIST (kind)', partitions }) })
    const [item] = compareSnapshots(
      pg(
        snapshot([events([partition('events_a', "FOR VALUES IN ('a', 'b')")])]),
        snapshot([
          events([partition('events_a', "FOR VALUES IN ('a')"), partition('events_x', 'DEFAULT')])
        ])
      )
    )
    expect(statementsOf([item])).toEqual([
      'ALTER TABLE public.events DETACH PARTITION public.events_a',
      'ALTER TABLE public.events DETACH PARTITION public.events_x',
      "ALTER TABLE public.events ATTACH PARTITION public.events_a FOR VALUES IN ('a', 'b')"
    ])
  })
})

describe('parsePgTableExtras', () => {
  it('groups constraints and nests partitions under their top-level table', () => {
    const extras = parsePgTableExtras(
      [['public', 't', 't_ck', 'c', 'CHECK ((a > 0))', null]],
      [
        ['public', 't', null, null, null, 'RANGE (a)'],
        ['public', 't_1_h', 'public', 't_1', 'FOR VALUES WITH (modulus 1, remainder 0)', null],
        ['public', 't_1', 'public', 't', 'FOR VALUES FROM (0) TO (10)', 'HASH (b)']
      ]
    )
    const t = extras.get('public\u0000t')!
    expect(t.constraints).toMatchObject([{ name: 't_ck', type: 'check' }])
    expect(t.partitionKey).toBe('RANGE (a)')
    expect(t.partitions.map((p) => p.name)).toEqual(['t_1', 't_1_h'])
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

describe('column drops in altered tables', () => {
  it('warns, counts and leaves out of the default selection alters that drop columns', () => {
    const source = obj('users', {
      table: table({
        columns: [column({ name: 'id', nullable: false }), column({ name: 'email' })]
      })
    })
    const target = obj('users', {
      table: table({ columns: [column({ name: 'id', nullable: false }), column({ name: 'mail' })] })
    })
    const [item] = compareSnapshots(pg(snapshot([source]), snapshot([target])))
    expect(item.action).toBe('alter')
    expect(dropCount(item)).toBe(1)
    expect(item.warnings).toContainEqual(expect.stringMatching(/^Drops column mail and its data/))
    expect(defaultSelection([item]).size).toBe(0)
  })

  it('still preselects alters that only add columns', () => {
    const source = obj('users', {
      table: table({
        columns: [column({ name: 'id', nullable: false }), column({ name: 'email' })]
      })
    })
    const target = obj('users', {
      table: table({ columns: [column({ name: 'id', nullable: false })] })
    })
    const items = compareSnapshots(pg(snapshot([source]), snapshot([target])))
    expect(dropCount(items[0])).toBe(0)
    expect(defaultSelection(items).size).toBe(1)
  })
})
