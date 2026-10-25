/// <reference types="node" />
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IndexInfo, TableInfo } from '../api'
import {
  compareSnapshots,
  defaultSelection,
  migrationScript,
  type CompareContext,
  type Snapshot,
  type SnapshotObject
} from '../compare'
import { loadPgExtras } from '@/features/compare/load-pg'

/**
 * Compares two live PostgreSQL databases, applies the generated script to the
 * target and compares again. Runs only when `DBMS_TEST_PG=host:port:user:password`
 * is set, through `psql` on the PATH, or through `DBMS_TEST_PSQL` (for example
 * `docker exec -i dbms-pg psql`, which ignores host and port).
 */
const raw = process.env.DBMS_TEST_PG
const [host, port, user, password] = (raw ?? '').split(':')
const SOURCE = 'pg_compare_a'
const TARGET = 'pg_compare_b'

const UNIT = '\u001f'
const RECORD = '\u001e'
const NULL = '\u0001'

function psql(database: string, sql: string): (string | null)[][] {
  const custom = process.env.DBMS_TEST_PSQL?.split(' ').filter(Boolean)
  const [cmd, ...prefix] = custom ?? ['psql', '-h', host, '-p', port]
  const out = spawnSync(
    cmd,
    [
      ...prefix,
      '-U',
      user,
      '-d',
      database,
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-F',
      UNIT,
      '-R',
      RECORD,
      '-P',
      `null=${NULL}`
    ],
    { input: sql, encoding: 'utf8', env: { ...process.env, PGPASSWORD: password } }
  )
  if (out.status !== 0) throw new Error(`psql failed: ${out.stderr || out.error}`)
  return out.stdout
    .replace(/\n$/, '')
    .split(RECORD)
    .filter((r: string) => r.length)
    .map((r: string) => r.split(UNIT).map((c) => (c === NULL ? null : c)))
}

const SOURCE_SQL = `
CREATE EXTENSION btree_gist;
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
CREATE DOMAIN qty AS integer DEFAULT 1 NOT NULL CONSTRAINT qty_positive CHECK (VALUE > 0);
CREATE TYPE pair AS (a integer, b text);
CREATE TYPE floatrange AS RANGE (subtype = float8);
CREATE TABLE booking (id int PRIMARY KEY, room int NOT NULL, during tstzrange NOT NULL, m mood, n qty, code text,
  CONSTRAINT booking_code_key UNIQUE (code),
  CONSTRAINT booking_room_check CHECK (room > 0),
  CONSTRAINT booking_no_overlap EXCLUDE USING gist (room WITH =, during WITH &&));
CREATE INDEX booking_room_idx ON booking (room);
CREATE TABLE events (id int, at date NOT NULL, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01') PARTITION BY HASH (id);
CREATE TABLE events_2025_h0 PARTITION OF events_2025 FOR VALUES WITH (MODULUS 2, REMAINDER 0);
CREATE TABLE events_2025_h1 PARTITION OF events_2025 FOR VALUES WITH (MODULUS 2, REMAINDER 1);
CREATE INDEX events_at_idx ON events (at);
CREATE TABLE stock (id int PRIMARY KEY, amount int CHECK (amount >= 0));
`

const TARGET_SQL = `
CREATE TYPE mood AS ENUM ('sad', 'happy');
CREATE DOMAIN qty AS integer CONSTRAINT qty_positive CHECK (VALUE >= 0);
CREATE TYPE pair AS (a bigint, c text);
CREATE TABLE stock (id int PRIMARY KEY, amount int, CONSTRAINT stock_old CHECK (amount < 100));
CREATE TABLE events (id int, at date NOT NULL, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2024-07-01');
CREATE TABLE events_old PARTITION OF events FOR VALUES FROM ('2020-01-01') TO ('2021-01-01');
`

const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** The table structure `describe_table` reports (columns, keys and indexes; no foreign keys here). */
function describeTable(database: string, table: string): TableInfo {
  const rel = `format('%I.%I', 'public', ${literal(table)})::regclass`
  const columns = psql(
    database,
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
  pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum),
  a.attidentity <> '' OR a.attgenerated <> '' OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%',
  a.attidentity <> ''
FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
WHERE a.attrelid = ${rel} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`
  )
  const indexes: IndexInfo[] = psql(
    database,
    `SELECT i.relname, ix.indisunique, ix.indisprimary, am.amname,
  array_to_json(ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k, true) FROM generate_series(1, ix.indnkeyatts) k)),
  pg_get_indexdef(ix.indexrelid)
FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_am am ON am.oid = i.relam
WHERE ix.indrelid = ${rel} ORDER BY ix.indisprimary DESC, i.relname`
  ).map((r) => ({
    name: String(r[0]),
    unique: r[1] === 't',
    primary: r[2] === 't',
    method: r[3],
    columns: JSON.parse(String(r[4])) as string[],
    definition: r[5]
  }))
  const primaryKey = indexes.find((ix) => ix.primary)?.columns ?? []
  return {
    columns: columns.map((r) => ({
      name: String(r[0]),
      dataType: String(r[1]),
      nullable: r[2] === 't',
      default: r[3],
      comment: r[4],
      isGenerated: r[5] === 't',
      isIdentity: r[6] === 't',
      isPrimaryKey: primaryKey.includes(String(r[0])),
      extra: null
    })),
    primaryKey,
    indexes,
    foreignKeys: [],
    triggers: []
  }
}

async function snapshot(database: string): Promise<Snapshot> {
  const tables = psql(
    database,
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY 1`
  )
  const objects: SnapshotObject[] = tables.map((r) => ({
    schema: 'public',
    name: String(r[0]),
    kind: 'table',
    detail: null,
    table: describeTable(database, String(r[0]))
  }))
  const failed: string[] = []
  await loadPgExtras(async (sql) => psql(database, sql), ['public'], true, objects, failed)
  expect(failed).toEqual([])
  return { database, schema: 'public', schemas: [], objects }
}

const compare = async (): Promise<ReturnType<typeof compareSnapshots>> => {
  const ctx: CompareContext = {
    dialect: 'postgres',
    scope: 'schema',
    source: await snapshot(SOURCE),
    target: await snapshot(TARGET)
  }
  return compareSnapshots(ctx)
}

const dropDatabases = (): void =>
  void psql('postgres', `DROP DATABASE IF EXISTS ${SOURCE}; DROP DATABASE IF EXISTS ${TARGET};`)

describe.skipIf(!raw)('schema compare against a live PostgreSQL server', () => {
  beforeAll(() => {
    dropDatabases()
    psql('postgres', `CREATE DATABASE ${SOURCE}; CREATE DATABASE ${TARGET};`)
    psql(SOURCE, SOURCE_SQL)
    psql(TARGET, TARGET_SQL)
  })
  afterAll(() => {
    if (raw) dropDatabases()
  })

  it('scripts types, extensions, constraints and partitions so the target matches', async () => {
    const items = await compare()
    const byName = (name: string) => items.find((i) => i.name === name)!
    expect(byName('btree_gist').action).toBe('create')
    expect(byName('mood').action).toBe('alter')
    expect(byName('floatrange').action).toBe('create')
    expect(byName('booking').action).toBe('create')
    expect(byName('events').changes.map((c) => `${c.action} ${c.what} ${c.name}`)).toEqual(
      expect.arrayContaining([
        'add partition events_2025',
        'change partition events_2024',
        'drop partition events_old'
      ])
    )

    const script = migrationScript('postgres', items, defaultSelection(items))
    psql(TARGET, script)

    // The exclusion constraint came across as a constraint, not a plain gist index
    expect(() =>
      psql(
        TARGET,
        `INSERT INTO booking (id, room, during) VALUES (1, 1, '[2024-01-01,2024-01-03)'), (2, 1, '[2024-01-02,2024-01-04)')`
      )
    ).toThrow(/booking_no_overlap/)
    expect(psql(TARGET, `SELECT enum_range(NULL::mood)::text`)).toEqual([['{sad,ok,happy}']])
    expect(
      psql(
        TARGET,
        `SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE c.relkind IN ('r', 'p') AND c.relname LIKE 'events_20%'`
      )
    ).toEqual([['4']])

    const again = await compare()
    // The detached partition is a standalone table now, offered as a drop
    expect(again.filter((i) => i.action !== 'same').map((i) => `${i.action} ${i.name}`)).toEqual([
      'drop events_old'
    ])
  }, 60_000)
})
