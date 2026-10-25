import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableInfo } from '../api'
import { vectorText } from '../binary'
import {
  browseColumns,
  columnFeatures,
  isCompressible,
  mysqlAtLeast,
  serverTypes,
  splitCompressed,
  tableColumnTypes,
  withCompressed
} from '../column-types'
import {
  columnChanged,
  draftFromTable,
  draftWarnings,
  newColumn,
  newIndex,
  newTableDraft,
  tableStatements,
  validateDraft
} from '../ddl'
import { literal, selectRows } from '../sql'

const info = (product: string, version: string) => ({ product, version })
const mariadb = (v: string) => info(`MariaDB ${v}`, `${v}-MariaDB-ubu2404`)
const mysql = (v: string) => info(`MySQL ${v}`, `${v} MySQL Community Server - GPL`)

const column = (patch: Partial<ColumnInfo> & { name: string }): ColumnInfo => ({
  dataType: 'int',
  nullable: true,
  default: null,
  isPrimaryKey: false,
  isGenerated: false,
  isIdentity: false,
  comment: null,
  extra: null,
  ...patch
})

/** A MariaDB table as describe_table reports it. */
const table = (): TableInfo => ({
  columns: [
    column({ name: 'id', nullable: false, isPrimaryKey: true }),
    column({ name: 'secret', extra: 'INVISIBLE' }),
    column({ name: 'notes', dataType: 'text /*M!100301 COMPRESSED*/' }),
    column({ name: 'ip', dataType: 'inet6' }),
    column({ name: 'v', dataType: 'vector(2)', nullable: false })
  ],
  primaryKey: ['id'],
  indexes: [
    {
      name: 'PRIMARY',
      columns: ['id'],
      unique: true,
      primary: true,
      method: 'BTREE',
      definition: null
    },
    {
      name: 'vix',
      columns: ['v'],
      unique: false,
      primary: false,
      method: 'VECTOR',
      definition: null
    }
  ],
  foreignKeys: [],
  triggers: []
})

describe('server types', () => {
  it('adds MariaDB types by release', () => {
    const base = ['int']
    expect(serverTypes('mysql', base, mariadb('10.4.30'))).toEqual(['int'])
    expect(serverTypes('mysql', base, mariadb('10.6.12'))).toEqual(['int', 'inet6'])
    expect(serverTypes('mysql', base, mariadb('10.11.6'))).toEqual([
      'int',
      'inet4',
      'inet6',
      'uuid'
    ])
    expect(serverTypes('mysql', base, mariadb('11.8.2'))).toEqual([
      'int',
      'inet4',
      'inet6',
      'uuid',
      'vector(1536)'
    ])
  })

  it('leaves MySQL and other dialects alone', () => {
    expect(serverTypes('mysql', ['int'], mysql('8.4.0'))).toEqual(['int'])
    expect(serverTypes('mysql', ['int'], null)).toEqual(['int'])
    expect(serverTypes('postgres', ['uuid'], mariadb('11.8.2'))).toEqual(['uuid'])
  })

  it('gates column features on the server', () => {
    expect(columnFeatures('mysql', mariadb('11.8.2'))).toEqual({
      invisible: true,
      compressed: true,
      vectorIndex: true
    })
    expect(columnFeatures('mysql', mariadb('10.6.12'))).toEqual({
      invisible: true,
      compressed: true,
      vectorIndex: false
    })
    expect(columnFeatures('mysql', mariadb('10.2.44')).invisible).toBe(false)
    expect(columnFeatures('mysql', mysql('8.0.23'))).toEqual({
      invisible: true,
      compressed: false,
      vectorIndex: false
    })
    expect(columnFeatures('mysql', mysql('8.0.22')).invisible).toBe(false)
    expect(columnFeatures('postgres', mariadb('11.8.2')).invisible).toBe(false)
  })

  it('compares MySQL versions', () => {
    expect(mysqlAtLeast(mysql('8.4.0'), 8, 0, 23)).toBe(true)
    expect(mysqlAtLeast(mysql('8.0.36'), 8, 0, 23)).toBe(true)
    expect(mysqlAtLeast(mysql('5.7.44'), 8)).toBe(false)
    expect(mysqlAtLeast(mariadb('11.8.2'), 8)).toBe(false)
  })
})

describe('COMPRESSED', () => {
  it('splits and restores the attribute', () => {
    expect(splitCompressed('text /*M!100301 COMPRESSED*/')).toEqual({
      dataType: 'text',
      compressed: true
    })
    expect(splitCompressed('varchar(100)')).toEqual({ dataType: 'varchar(100)', compressed: false })
    expect(withCompressed('text')).toBe('text COMPRESSED')
    // It has to come before the character set
    expect(withCompressed('text CHARACTER SET latin1 COLLATE latin1_bin')).toBe(
      'text COMPRESSED CHARACTER SET latin1 COLLATE latin1_bin'
    )
  })

  it('knows which types compress', () => {
    for (const t of ['blob', 'mediumtext', 'varchar(10)', 'varbinary(8)', 'LONGBLOB'])
      expect(isCompressible(t)).toBe(true)
    for (const t of ['int', 'char(1)', 'json', 'vector(3)']) expect(isCompressible(t)).toBe(false)
  })
})

describe('designer round trip', () => {
  const load = () => draftFromTable('mysql', 'app', 't', table())
  const col = (d: ReturnType<typeof load>, name: string) => d.columns.find((c) => c.name === name)!

  it('reads INVISIBLE, COMPRESSED and VECTOR indexes', () => {
    const d = load()
    expect(col(d, 'secret').invisible).toBe(true)
    expect(col(d, 'notes')).toMatchObject({ dataType: 'text', compressed: true, invisible: false })
    const vix = d.indexes.find((ix) => ix.name === 'vix')!
    expect(vix.method).toBe('VECTOR')
    expect(vix.locked).toBeNull()
    // Unchanged columns stay out of the ALTER
    expect(tableStatements('mysql', d)).toEqual([])
  })

  it('writes attribute changes as MODIFY COLUMN', () => {
    const d = load()
    col(d, 'secret').invisible = false
    col(d, 'notes').compressed = false
    col(d, 'ip').invisible = true
    expect(columnChanged(d, col(d, 'secret'))).toBe(true)
    expect(tableStatements('mysql', d)).toEqual([
      'ALTER TABLE `app`.`t`\n' +
        '  MODIFY COLUMN `secret` int NULL,\n' +
        '  MODIFY COLUMN `notes` text NULL,\n' +
        '  MODIFY COLUMN `ip` inet6 NULL INVISIBLE'
    ])
  })

  it('creates tables with the attributes and a vector index', () => {
    const d = newTableDraft('mysql', 'app')
    d.name = 'docs'
    const body = newColumn('mysql', { name: 'body', dataType: 'mediumtext', compressed: true })
    const tag = newColumn('mysql', { name: 'tag', default: '0', invisible: true })
    const emb = newColumn('mysql', { name: 'emb', dataType: 'vector(3)', nullable: false })
    d.columns.push(body, tag, emb)
    d.indexes.push(newIndex({ name: 'ix_emb', columns: [emb.id], method: 'VECTOR' }))
    expect(tableStatements('mysql', d)).toEqual([
      'CREATE TABLE `app`.`docs` (\n' +
        '  `id` bigint NOT NULL AUTO_INCREMENT,\n' +
        '  `body` mediumtext COMPRESSED NULL,\n' +
        '  `tag` varchar(255) NULL DEFAULT 0 INVISIBLE,\n' +
        '  `emb` vector(3) NOT NULL,\n' +
        '  PRIMARY KEY (`id`),\n' +
        '  VECTOR INDEX `ix_emb` (`emb`)\n' +
        ')'
    ])
  })

  it('validates the attributes', () => {
    const d = load()
    col(d, 'ip').compressed = true
    expect(validateDraft('mysql', d)).toMatch(/can be compressed, so ip can't/)
    col(d, 'ip').compressed = false
    for (const c of d.columns) c.invisible = true
    expect(validateDraft('mysql', d)).toBe('A table needs at least one visible column')
  })

  it('warns about invisible NOT NULL columns without a default', () => {
    const d = load()
    const c = newColumn('mysql', { name: 'hidden', nullable: false, invisible: true })
    d.columns.push(c)
    expect(
      draftWarnings(d, 'mysql').some((w) => w.startsWith('Invisible NOT NULL column hidden'))
    ).toBe(true)
  })

  it('leaves other dialects without the attributes', () => {
    const d = draftFromTable('postgres', 'public', 't', {
      ...table(),
      columns: [column({ name: 'id', extra: 'INVISIBLE' })]
    })
    expect(d.columns[0].invisible).toBe(false)
  })
})

describe('browsing and editing', () => {
  it('names the columns when some are invisible', () => {
    expect(browseColumns(table())).toEqual(['id', 'secret', 'notes', 'ip', 'v'])
    expect(browseColumns({ ...table(), columns: [column({ name: 'id' })] })).toBeUndefined()
    expect(
      selectRows('mysql', { schema: 'app', name: 't' }, { limit: 10, columns: ['id', 'secret'] })
    ).toBe('SELECT `id`, `secret`\nFROM `app`.`t`\nLIMIT 10')
    expect(selectRows('mysql', { schema: 'app', name: 't' }, { limit: 10 })).toBe(
      'SELECT *\nFROM `app`.`t`\nLIMIT 10'
    )
  })

  it('types result columns from the table', () => {
    const typed = tableColumnTypes(
      [
        { name: 'id', typeName: 'int' },
        { name: 'ip', typeName: 'char' },
        { name: 'v', typeName: 'varbinary' }
      ],
      table()
    )
    expect(typed.map((c) => c.typeName)).toEqual(['int', 'inet6', 'vector'])
  })

  it('writes vector values as hex or VEC_FromText', () => {
    expect(literal('mysql', '0x0000803F', 'vector(1)')).toBe('0x0000803F')
    expect(literal('mysql', '[1, -2.5]', 'vector(2)')).toBe("VEC_FromText('[1, -2.5]')")
    // Anything else stays a string literal
    expect(literal('mysql', "[1]'); DROP TABLE t; --", 'vector(1)')).toBe(
      "'[1]''); DROP TABLE t; --'"
    )
    expect(literal('mysql', '::1', 'inet6')).toBe("'::1'")
    // A varchar that happens to look like an array is still text
    expect(literal('mysql', '[1,2]', 'varchar(10)')).toBe("'[1,2]'")
  })

  it('shows vector bytes as a float array', () => {
    // 1.0, -2.5, 0.1 as little-endian float32s
    const bytes = new Uint8Array([0, 0, 0x80, 0x3f, 0, 0, 0x20, 0xc0, 0xcd, 0xcc, 0xcc, 0x3d])
    expect(vectorText(bytes)).toBe('[1,-2.5,0.1]')
    expect(vectorText(new Uint8Array([1, 2, 3]))).toBeNull()
    expect(vectorText(new Uint8Array())).toBe('[]')
  })
})
