import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableInfo } from '../api'
import {
  countChanges,
  ddlScript,
  draftFromTable,
  draftWarnings,
  needsRebuild,
  newColumn,
  newIndex,
  newTableDraft,
  newUnique,
  tableStatements,
  validateDraft,
  type TableDraft
} from '../ddl'
import { parseSqliteTable, retargetDefinition, sqliteIndexWhere } from '../sqlite-schema'
import { parseExtras } from '../table-extras'

const column = (patch: Partial<ColumnInfo> & { name: string }): ColumnInfo => ({
  dataType: 'TEXT',
  nullable: true,
  default: null,
  isPrimaryKey: false,
  isGenerated: false,
  isIdentity: false,
  comment: null,
  extra: null,
  ...patch
})

const CREATE = `CREATE TABLE "users" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  age INTEGER CONSTRAINT adult CHECK (age >= 18),
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  note TEXT DEFAULT 'a, (b)',
  CONSTRAINT uq_team_note UNIQUE (team_id, "note"),
  CHECK (length(email) > 3)
) STRICT`

describe('parseSqliteTable', () => {
  it('reads column and table constraints', () => {
    const shape = parseSqliteTable(CREATE)
    expect(shape.checks).toEqual([
      { name: 'adult', expression: 'age >= 18' },
      { name: null, expression: 'length(email) > 3' }
    ])
    expect(shape.uniques).toEqual([
      { name: null, columns: ['email'] },
      { name: 'uq_team_note', columns: ['team_id', 'note'] }
    ])
    expect(shape.columns.id.autoincrement).toBe(true)
    expect(shape.columns.email.collate).toBe('NOCASE')
    expect(shape.options).toBe('STRICT')
    expect(shape.virtual).toBe(false)
  })

  it('spots generated columns and virtual tables', () => {
    expect(
      parseSqliteTable('CREATE TABLE t (a INT, b INT GENERATED ALWAYS AS (a * 2) STORED)').columns.b
        .generated
    ).toBe(true)
    expect(parseSqliteTable('CREATE VIRTUAL TABLE docs USING fts5(body)').virtual).toBe(true)
  })

  it('reads partial index predicates and retargets definitions', () => {
    expect(
      sqliteIndexWhere('CREATE INDEX ix ON t (a, lower(b)) WHERE a > 0 AND b IS NOT NULL')
    ).toBe('a > 0 AND b IS NOT NULL')
    expect(sqliteIndexWhere('CREATE INDEX ix ON t (a)')).toBeNull()
    expect(retargetDefinition('CREATE INDEX ix ON "users" (a)', 'users', 'people')).toBe(
      'CREATE INDEX ix ON people (a)'
    )
    expect(
      retargetDefinition(
        'CREATE TRIGGER tr AFTER INSERT ON users BEGIN SELECT 1; END',
        'users',
        'people'
      )
    ).toBe('CREATE TRIGGER tr AFTER INSERT ON people BEGIN SELECT 1; END')
  })
})

const usersInfo = (): TableInfo => ({
  columns: [
    column({
      name: 'id',
      dataType: 'INTEGER',
      isPrimaryKey: true,
      isGenerated: true,
      isIdentity: true
    }),
    column({ name: 'email', nullable: false }),
    column({ name: 'age', dataType: 'INTEGER' }),
    column({ name: 'team_id', dataType: 'INTEGER' }),
    column({ name: 'note', default: "'a, (b)'" })
  ],
  primaryKey: ['id'],
  indexes: [
    {
      name: 'sqlite_autoindex_users_1',
      columns: ['email'],
      unique: true,
      primary: false,
      method: null,
      definition: null
    },
    {
      name: 'sqlite_autoindex_users_2',
      columns: ['team_id', 'note'],
      unique: true,
      primary: false,
      method: null,
      definition: null
    },
    {
      name: 'ix_users_age',
      columns: ['age'],
      unique: false,
      primary: false,
      method: null,
      definition: 'CREATE INDEX ix_users_age ON users (age) WHERE age IS NOT NULL'
    }
  ],
  foreignKeys: [
    {
      name: 'fk_users_0',
      columns: ['team_id'],
      refSchema: null,
      refTable: 'teams',
      refColumns: ['id'],
      onDelete: 'CASCADE',
      onUpdate: 'NO ACTION'
    }
  ],
  triggers: [
    {
      name: 'tr_users',
      timing: 'AFTER',
      events: ['INSERT'],
      rowLevel: true,
      enabled: true,
      definition: 'CREATE TRIGGER tr_users AFTER INSERT ON users BEGIN SELECT 1; END'
    }
  ]
})

const load = (): TableDraft => {
  const info = usersInfo()
  const extras = parseExtras('sqlite', { table: [[CREATE]] }, info)
  return draftFromTable('sqlite', null, 'users', info, extras)
}

const col = (draft: TableDraft, name: string) => draft.columns.find((c) => c.name === name)!

describe('SQLite table designer', () => {
  it('creates a table with an inline rowid key and constraints', () => {
    const d = newTableDraft('sqlite', null)
    d.name = 'notes'
    const body = newColumn('sqlite', { name: 'body', nullable: false, default: "datetime('now')" })
    d.columns.push(body)
    d.uniques.push(newUnique({ columns: [body.id] }))
    d.indexes.push(newIndex({ columns: [body.id], where: 'body IS NOT NULL' }))
    expect(tableStatements('sqlite', d)).toEqual([
      `CREATE TABLE notes (
  id INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (id),
  CONSTRAINT uq_notes_body UNIQUE (body)
)`,
      'CREATE INDEX ix_notes_body ON notes (body) WHERE body IS NOT NULL'
    ])
    d.columns[0].identity = true
    expect(tableStatements('sqlite', d)[0]).toContain('id INTEGER PRIMARY KEY AUTOINCREMENT')
  })

  it('loads constraints from the definition and leaves an untouched table alone', () => {
    const d = load()
    expect(d.indexes.map((ix) => ix.name)).toEqual(['ix_users_age'])
    expect(d.indexes[0].where).toBe('age IS NOT NULL')
    expect(d.uniques.map((u) => u.name)).toEqual(['', 'uq_team_note'])
    expect(d.checks).toHaveLength(2)
    expect(col(d, 'id').identity).toBe(true)
    expect(tableStatements('sqlite', d)).toEqual([])
    expect(countChanges(d, 'sqlite')).toBe(0)
    expect(validateDraft('sqlite', d)).toBeNull()
  })

  it('uses plain ALTER TABLE for renames, simple new columns and indexes', () => {
    const d = load()
    col(d, 'note').name = 'remark'
    d.columns.push(newColumn('sqlite', { name: 'bio' }))
    d.indexes[0].dropped = true
    d.name = 'people'
    expect(needsRebuild(d)).toBe(false)
    expect(tableStatements('sqlite', d)).toEqual([
      'DROP INDEX ix_users_age',
      'ALTER TABLE users RENAME COLUMN note TO remark',
      'ALTER TABLE users ADD COLUMN bio TEXT',
      'ALTER TABLE users RENAME TO people'
    ])
  })

  it('rebuilds the table for changes ALTER TABLE cannot make', () => {
    const d = load()
    col(d, 'age').dataType = 'REAL'
    col(d, 'note').name = 'remark'
    d.checks[1].dropped = true
    expect(needsRebuild(d)).toBe(true)
    const statements = tableStatements('sqlite', d)
    expect(statements).toEqual([
      'PRAGMA foreign_keys = OFF',
      'PRAGMA legacy_alter_table = ON',
      `CREATE TABLE _users_rebuild (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE,
  age REAL,
  team_id INTEGER,
  remark TEXT DEFAULT 'a, (b)',
  UNIQUE (email),
  CONSTRAINT uq_team_note UNIQUE (team_id, remark),
  CONSTRAINT adult CHECK (age >= 18),
  FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE
) STRICT`,
      'INSERT INTO _users_rebuild (id, email, age, team_id, remark)\n  SELECT id, email, age, team_id, note FROM users',
      'DROP TABLE users',
      'ALTER TABLE _users_rebuild RENAME TO users',
      'CREATE INDEX ix_users_age ON users (age) WHERE age IS NOT NULL',
      'CREATE TRIGGER tr_users AFTER INSERT ON users BEGIN SELECT 1; END',
      'PRAGMA legacy_alter_table = OFF'
    ])
    expect(draftWarnings(d, 'sqlite')).toContain(
      'Rebuilds the table: copies its rows into a new table, then recreates its indexes and triggers'
    )
    // PRAGMAs can't run inside a transaction, so they go around it
    const script = ddlScript('sqlite', statements)
    expect(
      script.startsWith('PRAGMA foreign_keys = OFF;\n\nPRAGMA legacy_alter_table = ON;\n\nBEGIN;')
    ).toBe(true)
    expect(script.endsWith('COMMIT;\n\nPRAGMA legacy_alter_table = OFF;')).toBe(true)
  })

  it('defers foreign keys and skips BEGIN on D1', () => {
    const d = load()
    col(d, 'age').nullable = false
    const statements = tableStatements('sqlite', d, { d1: true })
    expect(statements[0]).toBe('PRAGMA defer_foreign_keys = ON')
    expect(ddlScript('sqlite', statements, { d1: true })).not.toMatch(/^BEGIN;$/m)
    expect(draftWarnings(d, 'sqlite', { d1: true })).toContain(
      'D1 enforces foreign keys, so rows that reference this table with ON DELETE CASCADE are deleted'
    )
  })

  it('refuses rebuilds that would lose columns, and odd auto-increment keys', () => {
    const info = usersInfo()
    const extras = parseExtras(
      'sqlite',
      { table: [['CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, x INT AS (1))']] },
      info
    )
    const d = draftFromTable('sqlite', null, 'users', info, extras)
    col(d, 'email').dataType = 'BLOB'
    expect(validateDraft('sqlite', d)).toMatch(/generated columns/)

    const t = newTableDraft('sqlite', null)
    t.name = 't'
    t.columns[0].identity = true
    t.columns[0].dataType = 'BIGINT'
    expect(validateDraft('sqlite', t)).toMatch(/Only a lone INTEGER primary key/)
  })
})
