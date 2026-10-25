import { describe, expect, it } from 'vitest'
import type { Cell, ResultSet } from '../api'
import {
  canUninstallPlugin,
  createExtensionSql,
  dropExtensionSql,
  extensionFlavor,
  extensionHint,
  extensionsSql,
  installPluginSql,
  installSonameSql,
  isInstalledPlugin,
  MARIADB_PLUGINS_SQL,
  moveExtensionSql,
  MYSQL_PLUGINS_SQL,
  parsePgExtensions,
  parsePlugins,
  PG_EXTENSIONS_SQL,
  pgUpdateAvailable,
  uninstallPluginSql,
  updateExtensionSql
} from '../extensions'

const set = (names: string[], rows: Cell[][]): ResultSet => ({
  columns: names.map((name) => ({ name, typeName: 'text' })),
  rows,
  rowCount: rows.length,
  truncated: false
})

const PG_COLUMNS = [
  'name',
  'installed_version',
  'default_version',
  'schema',
  'relocatable',
  'superuser',
  'trusted',
  'requires',
  'versions',
  'comment'
]

describe('extensionFlavor', () => {
  it('maps engines and tells MariaDB from MySQL', () => {
    expect(extensionFlavor('postgres', null)).toBe('postgres')
    expect(extensionFlavor('mysql', { product: 'MariaDB 11.4.2', version: '11.4.2-MariaDB' })).toBe(
      'mariadb'
    )
    expect(extensionFlavor('mysql', { product: 'MySQL 8.4.0', version: '8.4.0' })).toBe('mysql')
    expect(extensionFlavor('mssql', null)).toBeNull()
    expect(extensionFlavor('sqlite', null)).toBeNull()
  })

  it('picks the listing for each flavor', () => {
    expect(extensionsSql('postgres')).toBe(PG_EXTENSIONS_SQL)
    expect(extensionsSql('mariadb')).toBe(MARIADB_PLUGINS_SQL)
    expect(extensionsSql('mysql')).toBe(MYSQL_PLUGINS_SQL)
    expect(MARIADB_PLUGINS_SQL).toContain('ALL_PLUGINS')
    expect(MYSQL_PLUGINS_SQL).not.toContain('ALL_PLUGINS')
  })
})

describe('parsePgExtensions', () => {
  const extensions = parsePgExtensions(
    set(PG_COLUMNS, [
      ['plpgsql', '1.0', '1.0', 'pg_catalog', false, false, true, null, '1.0', 'PL/pgSQL'],
      [
        'pg_trgm',
        '1.5',
        '1.6',
        'public',
        't',
        'f',
        't',
        null,
        '1.3, 1.4, 1.5, 1.6',
        'trigram matching'
      ],
      ['earthdistance', null, '1.2', null, true, false, true, 'cube', '1.1, 1.2', null],
      ['plperlu', null, '1.0', null, false, true, null, '', '1.0', 'untrusted']
    ])
  )

  it('reads installed and available extensions', () => {
    expect(extensions.map((e) => e.name)).toEqual([
      'plpgsql',
      'pg_trgm',
      'earthdistance',
      'plperlu'
    ])
    expect(extensions[1]).toMatchObject({
      installedVersion: '1.5',
      defaultVersion: '1.6',
      schema: 'public',
      relocatable: true,
      superuser: false,
      trusted: true,
      versions: ['1.3', '1.4', '1.5', '1.6']
    })
    expect(extensions[2]).toMatchObject({ installedVersion: null, requires: ['cube'] })
    expect(extensions[3]).toMatchObject({ requires: [], superuser: true, trusted: null })
  })

  it('flags extensions with an update', () => {
    expect(extensions.map(pgUpdateAvailable)).toEqual([false, true, false, false])
  })

  it('handles no result', () => {
    expect(parsePgExtensions(null)).toEqual([])
  })
})

describe('parsePlugins', () => {
  const plugins = parsePlugins(
    set(
      ['NAME', 'TYPE', 'STATUS', 'LIBRARY', 'VERSION', 'MATURITY', 'LOAD_OPTION'],
      [
        ['InnoDB', 'STORAGE ENGINE', 'ACTIVE', null, '11.4', 'Stable', 'DEFAULT'],
        ['ROCKSDB', 'STORAGE ENGINE', 'NOT INSTALLED', 'ha_rocksdb.so', '1.0', 'Stable', 'OFF'],
        ['server_audit', 'AUDIT', 'active', 'server_audit.so', '2.5', 'Stable', 'ON']
      ]
    )
  )

  it('reads plugins case-insensitively by column', () => {
    expect(plugins[1]).toMatchObject({
      name: 'ROCKSDB',
      type: 'STORAGE ENGINE',
      status: 'NOT INSTALLED',
      library: 'ha_rocksdb.so',
      maturity: 'Stable'
    })
    expect(plugins[2]!.status).toBe('ACTIVE')
  })

  it('tells installed, built-in and removable plugins apart', () => {
    expect(plugins.map(isInstalledPlugin)).toEqual([true, false, true])
    expect(plugins.map(canUninstallPlugin)).toEqual([false, false, true])
  })
})

describe('extension statements', () => {
  it('creates extensions with quoting, schema, version and cascade', () => {
    expect(createExtensionSql({ name: 'pg_trgm' })).toBe('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    expect(
      createExtensionSql({
        name: 'uuid-ossp',
        schema: ' Ext ',
        version: "1.1'",
        cascade: true
      })
    ).toBe(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA "Ext" VERSION '1.1''' CASCADE`)
  })

  it('updates, moves and drops', () => {
    expect(updateExtensionSql('postgis')).toBe('ALTER EXTENSION postgis UPDATE')
    expect(updateExtensionSql('postgis', '3.5.0')).toBe("ALTER EXTENSION postgis UPDATE TO '3.5.0'")
    expect(moveExtensionSql('hstore', 'extensions')).toBe(
      'ALTER EXTENSION hstore SET SCHEMA extensions'
    )
    expect(dropExtensionSql('uuid-ossp')).toBe('DROP EXTENSION IF EXISTS "uuid-ossp"')
    expect(dropExtensionSql('cube', true)).toBe('DROP EXTENSION IF EXISTS cube CASCADE')
  })

  it('installs and uninstalls plugins', () => {
    expect(installPluginSql('ROCKSDB', 'ha_rocksdb.so')).toBe(
      "INSTALL PLUGIN `ROCKSDB` SONAME 'ha_rocksdb.so'"
    )
    expect(installSonameSql("it's\\x")).toBe("INSTALL SONAME 'it''s\\\\x'")
    expect(uninstallPluginSql('we`ird')).toBe('UNINSTALL PLUGIN `we``ird`')
  })
})

describe('extensionHint', () => {
  it('explains common PostgreSQL errors', () => {
    expect(extensionHint('permission denied to create extension "plperlu"', 'postgres')).toMatch(
      /superuser/
    )
    expect(
      extensionHint('could not open extension control file ".../postgis.control"', 'postgres')
    ).toMatch(/package/)
    expect(extensionHint('required extension "cube" is not installed', 'postgres')).toMatch(
      /CASCADE/
    )
    expect(
      extensionHint('cannot drop extension cube because other objects depend on it', 'postgres')
    ).toMatch(/CASCADE/)
    expect(extensionHint('syntax error', 'postgres')).toBeNull()
  })

  it('explains common plugin errors', () => {
    expect(
      extensionHint(
        "Can't open shared library 'nope.so' (errno: 2, cannot open shared object file)",
        'mariadb'
      )
    ).toMatch(/plugin_dir/)
    expect(
      extensionHint("INSERT command denied to user 'app'@'%' for table 'plugin'", 'mysql')
    ).toMatch(/mysql\.plugin/)
    expect(extensionHint('Unknown error', 'mariadb')).toBeNull()
  })
})
