import { describe, expect, it } from 'vitest'
import {
  extensionsSql,
  parseExtensions,
  parsePartitions,
  parseTypes,
  partitionsSql,
  typesSql
} from '../catalog'

describe('catalog', () => {
  it('lists types only where the engine has them', () => {
    expect(typesSql('postgres', "we'ird")).toContain("n.nspname = 'we''ird'")
    expect(typesSql('tsql', null)).toContain('t.is_user_defined = 1')
    expect(typesSql('mysql', null)).toBeNull()
    expect(typesSql('sqlite', null)).toBeNull()
    expect(extensionsSql('postgres')).toContain('pg_extension')
    expect(extensionsSql('tsql')).toBeNull()
  })

  it('scripts SQL Server alias types and keeps PostgreSQL definitions', () => {
    expect(
      parseTypes('tsql', [
        ['dbo', 'Phone', 'alias', 'varchar(20)', '0'],
        ['dbo', 'Ids', 'table_type', null, '1']
      ])
    ).toMatchObject([
      { name: 'Phone', definition: 'CREATE TYPE [dbo].[Phone] FROM varchar(20) NOT NULL;' },
      { name: 'Ids', kind: 'table_type', definition: null }
    ])
    expect(
      parseTypes('postgres', [
        ['public', 'mood', 'enum', null, 'feelings', "CREATE TYPE public.mood AS ENUM ('ok');"]
      ])[0]
    ).toMatchObject({
      kind: 'enum',
      comment: 'feelings',
      definition: expect.stringContaining('ENUM')
    })
  })

  it('scripts extensions with their schema and version', () => {
    expect(parseExtensions([['public', 'uuid-ossp', '1.1', null]])[0].definition).toBe(
      `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public VERSION '1.1';`
    )
  })

  it('finds PostgreSQL child partitions and MySQL partitions', () => {
    expect(partitionsSql('postgres', 'sales', 'Orders')).toContain(`to_regclass('sales."Orders"')`)
    expect(partitionsSql('mysql', 'shop', 'orders')).toContain("table_name = 'orders'")
    expect(partitionsSql('tsql', 'dbo', 't')).toBeNull()
    expect(
      parsePartitions('mysql', [
        ['shop', 'p0', 'subpartition', 'RANGE year 2020', '12', 'p0sp0'],
        ['shop', 'p1', 'partition', 'RANGE year 2021', '-1', null]
      ])
    ).toMatchObject([
      { name: 'p0.p0sp0', rowEstimate: 12 },
      { name: 'p1', rowEstimate: null }
    ])
  })
})
