import { describe, expect, it } from 'vitest'
import { editorFontStack } from '../app-settings'
import {
  connectionKey,
  detectFormat,
  exportConnections,
  parseDataGrip,
  parseDbeaver,
  parseExport,
  parseImportFiles,
  parseJdbcUrl,
  parsePgpass
} from '../connection-transfer'
import { newConnection } from '../engines'
import { describeMongoDanger, mongoIsWrite, sqlWriteKeyword } from '../production'
import { isManualCommit } from '../transactions'

describe('parsePgpass', () => {
  it('reads entries, escapes and wildcards', () => {
    const { candidates, skipped } = parsePgpass(
      [
        '# local dev',
        'localhost:5432:app:alice:s3cr\\:et',
        'db.internal:*:*:report:pw',
        '*:5432:*:postgres:x',
        'broken:line'
      ].join('\n')
    )
    expect(candidates).toHaveLength(2)
    expect(candidates[0].config).toMatchObject({
      engine: 'postgres',
      name: 'alice@localhost/app',
      host: 'localhost',
      port: 5432,
      database: 'app',
      user: 'alice',
      savePassword: true,
      id: ''
    })
    expect(candidates[0].password).toBe('s3cr:et')
    expect(candidates[1].config).toMatchObject({ port: 5432, database: 'postgres', user: 'report' })
    expect(skipped).toHaveLength(2)
    expect(skipped[0]).toMatch(/Line 4: wildcard host/)
    expect(skipped[1]).toMatch(/Line 5/)
  })
})

describe('parseJdbcUrl', () => {
  it('reads PostgreSQL and MySQL URLs', () => {
    expect(parseJdbcUrl('jdbc:postgresql://pg1,pg2:5433/shop?sslmode=require&user=bob')).toEqual({
      engine: 'postgres',
      patch: { host: 'pg1', port: 5432, database: 'shop', user: 'bob', ssl: 'require' }
    })
    expect(parseJdbcUrl('jdbc:postgresql://[::1]:6543/db')?.patch).toMatchObject({
      host: '::1',
      port: 6543
    })
    expect(parseJdbcUrl('jdbc:mariadb://maria:3307/crm')).toMatchObject({
      engine: 'mysql',
      patch: { host: 'maria', port: 3307, database: 'crm' }
    })
  })

  it('reads SQL Server property lists', () => {
    expect(
      parseJdbcUrl(
        'jdbc:sqlserver://sql01\\INST:1444;databaseName=Sales;encrypt=true;trustServerCertificate=true;integratedSecurity=true'
      )
    ).toEqual({
      engine: 'mssql',
      patch: {
        host: 'sql01\\INST',
        port: 1444,
        database: 'Sales',
        auth: 'windows',
        trustServerCertificate: true,
        ssl: 'require'
      }
    })
  })

  it('reads SQLite paths and MongoDB URIs without passwords', () => {
    expect(parseJdbcUrl('jdbc:sqlite:C:\\data\\app.db')).toEqual({
      engine: 'sqlite',
      patch: { host: 'C:\\data\\app.db' }
    })
    expect(parseJdbcUrl('mongodb://admin:hunter2@mongo:27017/?authSource=admin')).toEqual({
      engine: 'mongo',
      patch: { uri: 'mongodb://admin@mongo:27017/?authSource=admin' }
    })
    expect(parseJdbcUrl('jdbc:oracle:thin:@host:1521:xe')).toBeNull()
  })
})

const DBEAVER = JSON.stringify({
  folders: { Work: {} },
  'connection-types': { strict: { 'confirm-execute': true } },
  connections: {
    'postgres-jdbc-1': {
      provider: 'postgresql',
      driver: 'postgres-jdbc',
      name: 'Orders prod',
      folder: 'Work',
      'read-only': true,
      configuration: {
        host: 'orders.db',
        port: '5433',
        database: 'orders',
        url: 'jdbc:postgresql://orders.db:5433/orders',
        type: 'prod',
        handlers: {
          ssh_tunnel: {
            enabled: true,
            properties: { host: 'bastion', port: 22, authType: 'PUBLIC_KEY', keyPath: '~/.ssh/id' }
          },
          postgre_ssl: { enabled: true, properties: { sslMode: 'verify-full' } }
        }
      }
    },
    'mssql-1': {
      provider: 'sqlserver',
      driver: 'microsoft',
      name: 'Reporting',
      configuration: {
        url: 'jdbc:sqlserver://rep:1433;databaseName=dw',
        type: 'strict',
        'auth-model': 'sqlserver_ntlm'
      }
    },
    'sqlite-1': {
      provider: 'sqlite',
      driver: 'sqlite_jdbc',
      name: 'Local',
      configuration: { database: '/tmp/app.db', type: 'dev' }
    },
    'oracle-1': { provider: 'oracle', name: 'Legacy', configuration: { host: 'ora' } }
  }
})

describe('parseDbeaver', () => {
  it('maps providers, folders, connection types and SSH tunnels', () => {
    const { candidates, skipped } = parseDbeaver(DBEAVER)
    expect(candidates.map((c) => c.config.engine)).toEqual(['postgres', 'mssql', 'sqlite'])
    const [pg, ms, lite] = candidates.map((c) => c.config)
    expect(pg).toMatchObject({
      name: 'Orders prod',
      host: 'orders.db',
      port: 5433,
      database: 'orders',
      group: 'Work',
      readOnly: true,
      production: true,
      ssl: 'require',
      ssh: { enabled: true, host: 'bastion', port: 22, auth: 'key', keyFile: '~/.ssh/id' }
    })
    expect(ms).toMatchObject({ host: 'rep', database: 'dw', auth: 'windows', production: true })
    expect(lite).toMatchObject({ host: '/tmp/app.db', production: false })
    expect(candidates.every((c) => c.password === undefined)).toBe(true)
    expect(skipped).toEqual(["Legacy: oracle isn't supported"])
  })
})

describe('parseDataGrip', () => {
  const shared = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="true">
    <data-source source="LOCAL" name="shop@localhost" uuid="a1" read-only="true">
      <driver-ref>postgresql</driver-ref>
      <jdbc-url>jdbc:postgresql://localhost:5432/shop</jdbc-url>
    </data-source>
    <data-source source="LOCAL" name="Q&amp;A" uuid="b2">
      <driver-ref>mysql.8</driver-ref>
      <jdbc-url>jdbc:mysql://qa:3306/app</jdbc-url>
    </data-source>
  </component>
</project>`
  const local = `<project version="4">
  <component name="dataSourceStorageLocal">
    <data-source name="shop@localhost" uuid="a1">
      <secret-storage>master_key</secret-storage>
      <user-name>shopper</user-name>
    </data-source>
    <data-source name="orphan" uuid="c3"><user-name>x</user-name></data-source>
  </component>
</project>`

  it('merges dataSources.xml with the local file by uuid', () => {
    const { candidates, skipped } = parseDataGrip([shared, local])
    expect(candidates.map((c) => c.config)).toMatchObject([
      {
        engine: 'postgres',
        name: 'shop@localhost',
        database: 'shop',
        user: 'shopper',
        readOnly: true
      },
      { engine: 'mysql', name: 'Q&A', host: 'qa', database: 'app' }
    ])
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatch(/orphan: no JDBC URL/)
  })

  it('is detected and parsed together through parseImportFiles', () => {
    const result = parseImportFiles([local, shared, 'h:5432:db:u:p'])
    expect(result.formats).toEqual(['datagrip', 'pgpass'])
    expect(result.candidates).toHaveLength(3)
  })
})

describe('export', () => {
  it('drops ids, timestamps and URI passwords, and round-trips', () => {
    const pg = {
      ...newConnection('postgres'),
      id: 'abc',
      name: 'Main',
      lastUsed: 123,
      production: true
    }
    const mongo = {
      ...newConnection('mongo'),
      id: 'def',
      uri: 'mongodb+srv://app:secret@cluster0.example.net/db'
    }
    const text = exportConnections([pg, mongo], new Date('2026-01-01T00:00:00Z'))
    expect(text).not.toContain('secret')
    expect(text).not.toContain('"abc"')
    expect(text).not.toContain('lastUsed')
    expect(detectFormat(text)).toBe('dbms-tool')
    const { candidates } = parseExport(text)
    expect(candidates.map((c) => c.config)).toMatchObject([
      { id: '', name: 'Main', production: true },
      { id: '', engine: 'mongo', uri: 'mongodb+srv://app@cluster0.example.net/db' }
    ])
    expect(() => parseExport('{"connections": []}')).toThrow()
  })

  it('keys connections by server and login', () => {
    const a = { ...newConnection('postgres'), host: 'DB', user: 'App' }
    const b = { ...newConnection('postgres'), host: 'db', user: 'app', port: 0, name: 'other' }
    expect(connectionKey(a)).toBe(connectionKey(b))
    expect(connectionKey(a)).not.toBe(connectionKey({ ...b, database: 'x' }))
  })
})

describe('production write detection', () => {
  it('finds write keywords outside strings and comments', () => {
    expect(sqlWriteKeyword('SELECT * FROM t WHERE a = 1', 'postgres')).toBeNull()
    expect(
      sqlWriteKeyword("SELECT 'drop table' -- delete\n/* update */ FROM t", 'postgres')
    ).toBeNull()
    expect(sqlWriteKeyword('select 1;\nupdate t set a = 1', 'postgres')).toBe('UPDATE')
    expect(sqlWriteKeyword('SELECT * INTO backup_t FROM t', 'postgres')).toBe('INTO')
    expect(sqlWriteKeyword('SELECT "delete" FROM [drop]', 'tsql')).toBeNull()
  })

  it('classifies MongoDB requests', () => {
    const base = { database: 'db', collection: 'c' }
    expect(mongoIsWrite({ op: 'find', ...base })).toBe(false)
    expect(mongoIsWrite({ op: 'aggregate', ...base, pipeline: [{ $match: {} }] })).toBe(false)
    expect(mongoIsWrite({ op: 'aggregate', ...base, pipeline: [{ $out: 'x' }] })).toBe(true)
    expect(mongoIsWrite({ op: 'runCommand', database: 'db', command: { ping: 1 } })).toBe(false)
    expect(mongoIsWrite({ op: 'runCommand', database: 'db', command: { compact: 'c' } })).toBe(true)
    expect(mongoIsWrite({ op: 'runCommand', database: 'db', command: { validate: 'c' } })).toBe(
      false
    )
    expect(
      mongoIsWrite({ op: 'runCommand', database: 'db', command: { validate: 'c', repair: true } })
    ).toBe(true)
    expect(mongoIsWrite({ op: 'deleteOne', ...base, filter: { _id: 1 } })).toBe(true)
    expect(describeMongoDanger({ op: 'deleteMany', ...base, filter: {} })).toMatch(/every document/)
    expect(describeMongoDanger({ op: 'deleteMany', ...base, filter: { a: 1 } })).toBeNull()
  })
})

describe('settings helpers', () => {
  it('builds a quoted editor font stack', () => {
    expect(editorFontStack('')).toBe('var(--font-mono)')
    expect(editorFontStack('Fira Code, monospace')).toBe('"Fira Code", monospace, var(--font-mono)')
    // Nothing that could close the declaration survives
    expect(editorFontStack('"Bad"; } body { color: red')).toBe(
      '"Bad  body  color: red", var(--font-mono)'
    )
  })

  it('falls back to the default commit mode for tabs without a choice', () => {
    expect(isManualCommit('t1', {}, 'auto')).toBe(false)
    expect(isManualCommit('t1', {}, 'manual')).toBe(true)
    expect(isManualCommit('t1', { t1: false }, 'manual')).toBe(false)
    expect(isManualCommit('t1', { t1: true }, 'auto')).toBe(true)
  })
})

describe('Redis connections', () => {
  it('reads Redis URIs without keeping the password', () => {
    expect(parseJdbcUrl('jdbc:redis://:secret@cache:6380/2')).toEqual({
      engine: 'redis',
      patch: { uri: 'redis://cache:6380/2' }
    })
    expect(parseJdbcUrl('rediss://app:pw@cache:6380')?.patch.uri).toBe('rediss://app@cache:6380')
  })
})
