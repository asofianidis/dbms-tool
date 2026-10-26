import { describe, expect, it } from 'vitest'
import {
  createDatabaseStatements,
  databaseNameProblem,
  dropDatabaseStatements,
  emptyDatabase,
  isSystemDatabase,
  maintenanceDatabase,
  mongoDatabaseProblem,
  pgMajorVersion,
  renameDatabaseStatements
} from '../databases'

describe('createDatabaseStatements', () => {
  it('writes a bare CREATE DATABASE by default', () => {
    expect(createDatabaseStatements('postgres', { ...emptyDatabase(), name: 'shop' })).toEqual([
      'CREATE DATABASE shop'
    ])
    expect(createDatabaseStatements('mssql', { ...emptyDatabase(), name: 'Shop' })).toEqual([
      'CREATE DATABASE [Shop]'
    ])
  })

  it('adds PostgreSQL options and a comment', () => {
    expect(
      createDatabaseStatements('postgres', {
        ...emptyDatabase(),
        name: 'My App',
        owner: 'app',
        template: 'template0',
        encoding: 'UTF8',
        comment: "Alex's app"
      })
    ).toEqual([
      `CREATE DATABASE "My App" WITH OWNER = app TEMPLATE = template0 ENCODING = 'UTF8'`,
      `COMMENT ON DATABASE "My App" IS 'Alex''s app'`
    ])
  })

  it('adds a SQL Server collation, but not on Babelfish', () => {
    const db = { ...emptyDatabase(), name: 'x', collation: 'Latin1_General_100_CI_AS_SC_UTF8' }
    expect(createDatabaseStatements('mssql', db)).toEqual([
      'CREATE DATABASE [x] COLLATE Latin1_General_100_CI_AS_SC_UTF8'
    ])
    expect(createDatabaseStatements('babelfish', db)).toEqual(['CREATE DATABASE [x]'])
    expect(() =>
      createDatabaseStatements('mssql', { ...db, collation: 'x; DROP DATABASE y' })
    ).toThrow()
  })
})

describe('renaming and dropping', () => {
  it('disconnects other sessions when forced', () => {
    expect(renameDatabaseStatements('postgres', 'old', 'new', true)).toEqual([
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'old' AND pid <> pg_backend_pid()",
      'ALTER DATABASE old RENAME TO new'
    ])
    expect(renameDatabaseStatements('mssql', 'old', 'new', true)).toEqual([
      'ALTER DATABASE [old] SET SINGLE_USER WITH ROLLBACK IMMEDIATE',
      'ALTER DATABASE [old] MODIFY NAME = [new]',
      'ALTER DATABASE [new] SET MULTI_USER'
    ])
  })

  it('uses WITH (FORCE) from PostgreSQL 13', () => {
    expect(dropDatabaseStatements('postgres', 'shop', true, 16)).toEqual([
      'DROP DATABASE shop WITH (FORCE)'
    ])
    expect(dropDatabaseStatements('postgres', 'shop', true, 12)).toHaveLength(2)
    expect(dropDatabaseStatements('postgres', 'shop', false, 16)).toEqual(['DROP DATABASE shop'])
  })

  it('has no single-user mode on Babelfish', () => {
    expect(dropDatabaseStatements('mssql', 'shop', true)).toEqual([
      'ALTER DATABASE [shop] SET SINGLE_USER WITH ROLLBACK IMMEDIATE',
      'DROP DATABASE [shop]'
    ])
    expect(dropDatabaseStatements('babelfish', 'shop', true)).toEqual(['DROP DATABASE [shop]'])
  })
})

describe('helpers', () => {
  it('checks names', () => {
    expect(databaseNameProblem('postgres', ' ', [])).toMatch(/Enter/)
    expect(databaseNameProblem('postgres', 'Shop', ['shop'])).toBeNull()
    expect(databaseNameProblem('mssql', 'Shop', ['shop'])).toMatch(/already/)
    expect(databaseNameProblem('postgres', 'x'.repeat(64), [])).toMatch(/63 bytes/)
  })

  it('knows system databases', () => {
    expect(isSystemDatabase('postgres', 'template1')).toBe(true)
    expect(isSystemDatabase('postgres', 'postgres')).toBe(false)
    expect(isSystemDatabase('mssql', 'MSDB')).toBe(true)
  })

  it('never runs in the database being changed', () => {
    expect(maintenanceDatabase('postgres', 'shop', 'postgres')).toBe('postgres')
    expect(maintenanceDatabase('postgres', 'shop', 'shop')).toBe('postgres')
    expect(maintenanceDatabase('postgres', 'postgres', 'postgres')).toBe('template1')
    expect(maintenanceDatabase('mssql', 'shop', 'shop')).toBe('master')
  })

  it('reads PostgreSQL versions', () => {
    expect(pgMajorVersion('16.2')).toBe(16)
    expect(pgMajorVersion('PostgreSQL 12.9 on x86_64')).toBe(12)
    expect(pgMajorVersion('')).toBeNull()
  })

  it('checks MongoDB names', () => {
    expect(mongoDatabaseProblem('my app', [])).toMatch(/spaces/)
    expect(mongoDatabaseProblem('Shop', ['shop'])).toMatch(/already/)
    expect(mongoDatabaseProblem('shop_2', ['shop'])).toBeNull()
  })
})
