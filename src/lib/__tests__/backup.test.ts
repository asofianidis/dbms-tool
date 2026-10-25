import { describe, expect, it } from 'vitest'
import type { BackupInspection, ResultSet } from '../api'
import {
  backupJob,
  backupIsFolder,
  builtinCanRun,
  defaultBackupName,
  defaultMoves,
  defaultMssqlBackupPath,
  joinServerPath,
  mssqlBackupScript,
  mssqlRestoreScript,
  newBackupDraft,
  newMssqlBackupDraft,
  newMssqlRestoreDraft,
  newRestoreDraft,
  parseFileList,
  parseHeaderOnly,
  parseMssqlServer,
  restoreJob,
  toolVersionProblem,
  validateBackup,
  validateMssqlBackup,
  validateRestore,
  withExtension,
  type MssqlServer
} from '../backup'

const now = new Date(2026, 9, 22, 14, 5)

const inspection = (patch: Partial<BackupInspection> = {}): BackupInspection => ({
  format: 'custom',
  path: '/b/shop.dump',
  size: 1024,
  gzip: false,
  database: 'shop',
  sourceVersion: '17.2',
  toolVersion: '17.2',
  createsDatabase: false,
  entries: [],
  ...patch
})

const server: MssqlServer = {
  backupDir: 'C:\\SQL\\Backup',
  dataDir: 'D:\\Data\\',
  logDir: 'L:\\Logs\\',
  edition: 2,
  recoveryModel: 'FULL'
}

describe('tool backups', () => {
  it('names backups after the database and format', () => {
    const draft = newBackupDraft('my shop')
    expect(defaultBackupName('postgres', draft, now)).toBe('my_shop_2026-10-22_1405.dump')
    expect(defaultBackupName('postgres', { ...draft, pgFormat: 'directory' }, now)).toBe(
      'my_shop_2026-10-22_1405'
    )
    expect(defaultBackupName('mysql', draft, now)).toBe('my_shop_2026-10-22_1405.sql')
    expect(defaultBackupName('mongo', draft, now)).toBe('my_shop_2026-10-22_1405.archive.gz')
    expect(backupIsFolder('mongo', { ...draft, archive: false })).toBe(true)
  })

  it('swaps extensions only on names it recognises', () => {
    expect(withExtension('/b/shop.dump', '.dump', '.sql')).toBe('/b/shop.sql')
    expect(withExtension('/b/shop', '', '.sql')).toBe('/b/shop.sql')
    expect(withExtension('/b/custom.bak', '.dump', '.sql')).toBe('/b/custom.bak')
    expect(withExtension('', '.dump', '.sql')).toBe('')
  })

  it('validates the chosen scope and destination', () => {
    const draft = { ...newBackupDraft('shop'), path: '/b/x.dump' }
    expect(validateBackup('postgres', draft)).toBeNull()
    expect(validateBackup('postgres', { ...draft, path: ' ' })).toMatch(/where to save/)
    expect(validateBackup('postgres', { ...draft, scope: 'schemas' })).toMatch(/schema/)
    expect(validateBackup('mongo', { ...draft, scope: 'tables' })).toMatch(/collection/)
  })

  it('builds pg_dump jobs with only the chosen scope', () => {
    const draft = {
      ...newBackupDraft('shop'),
      path: ' /b/x.dump ',
      scope: 'tables' as const,
      schemas: ['stale'],
      tables: [{ schema: 'sales', name: 'orders' }]
    }
    const job = backupJob('postgres', draft)
    expect(job).toMatchObject({
      tool: 'pg_dump',
      file: '/b/x.dump',
      schemas: [],
      tables: [{ schema: 'sales', name: 'orders' }]
    })
  })

  it('turns chosen collections into exclusions for mongodump', () => {
    const draft = {
      ...newBackupDraft('shop'),
      path: '/b/x',
      scope: 'tables' as const,
      tables: [{ schema: null, name: 'orders' }]
    }
    expect(backupJob('mongo', draft, ['orders', 'logs', 'users'])).toMatchObject({
      tool: 'mongodump',
      excludeCollections: ['logs', 'users']
    })
    expect(backupJob('mongo', { ...draft, scope: 'all' }, ['orders', 'logs'])).toMatchObject({
      excludeCollections: []
    })
  })

  it('builds mysqldump jobs from table names', () => {
    const draft = {
      ...newBackupDraft('shop'),
      path: 'x.sql',
      scope: 'tables' as const,
      tables: [{ schema: null, name: 'orders' }]
    }
    expect(backupJob('mysql', draft)).toMatchObject({ tool: 'mysqldump', tables: ['orders'] })
  })

  it('warns when pg_dump is older than the server', () => {
    const tool = {
      kind: 'pg_dump' as const,
      path: '/bin/pg_dump',
      version: 'pg_dump (PostgreSQL) 15.4'
    }
    expect(toolVersionProblem(tool, 'PostgreSQL 17.2 on x86_64-pc-linux-gnu')).toMatch(/older/)
    expect(
      toolVersionProblem({ ...tool, version: 'pg_dump (PostgreSQL) 17.0' }, 'PostgreSQL 17.2')
    ).toBeNull()
    expect(toolVersionProblem({ ...tool, path: null }, 'PostgreSQL 17.2')).toBeNull()
  })

  it('runs everything but pg_dump archives without the tools', () => {
    const draft = { ...newBackupDraft('shop'), path: '/b/shop' }
    expect(builtinCanRun(backupJob('postgres', { ...draft, pgFormat: 'plain' }))).toBe(true)
    expect(builtinCanRun(backupJob('postgres', draft))).toBe(false)
    expect(builtinCanRun(backupJob('mysql', draft))).toBe(true)
    expect(builtinCanRun(backupJob('mongo', draft))).toBe(true)
    const restore = { ...newRestoreDraft('copy') }
    expect(builtinCanRun(restoreJob('postgres', restore, inspection({ format: 'plain' })))).toBe(
      true
    )
    expect(builtinCanRun(restoreJob('postgres', restore, inspection({ format: 'custom' })))).toBe(
      false
    )
  })
})

describe('tool restores', () => {
  it('uses psql for plain scripts and pg_restore for archives', () => {
    const draft = { ...newRestoreDraft('copy'), singleTransaction: true }
    expect(restoreJob('postgres', draft, inspection({ format: 'plain' }))).toMatchObject({
      tool: 'psql',
      singleTransaction: true
    })
    // A script that creates its own database can't run in one transaction
    expect(
      restoreJob('postgres', draft, inspection({ format: 'plain', createsDatabase: true }))
    ).toMatchObject({ tool: 'psql', singleTransaction: false })
    expect(restoreJob('postgres', { ...draft, jobs: 4 }, inspection())).toMatchObject({
      tool: 'pg_restore',
      file: '/b/shop.dump',
      exitOnError: true,
      jobs: 1
    })
  })

  it('ignores selections a plain script cannot honour', () => {
    const draft = { ...newRestoreDraft('copy'), scope: 'schemas' as const, schemas: ['sales'] }
    expect(restoreJob('postgres', draft, inspection())).toMatchObject({ schemas: ['sales'] })
    expect(restoreJob('postgres', draft, inspection({ format: 'plain' }))).not.toHaveProperty(
      'schemas'
    )
  })

  it('renames single-database MongoDB backups and keeps several as named', () => {
    const entries = [
      { kind: 'collection', schema: 'shop', name: 'orders' },
      { kind: 'collection', schema: 'shop', name: 'users' }
    ]
    const archive = inspection({ format: 'archive', gzip: true, path: '/b/a.gz', entries })
    const draft = {
      ...newRestoreDraft('copy'),
      scope: 'tables' as const,
      tables: [{ schema: 'shop', name: 'orders' }]
    }
    expect(restoreJob('mongo', draft, archive)).toEqual({
      tool: 'mongorestore',
      path: '/b/a.gz',
      archive: true,
      gzip: true,
      namespaces: ['shop.orders'],
      fromDatabase: 'shop',
      toDatabase: 'copy',
      drop: false,
      stopOnError: true,
      noIndexRestore: false
    })
    const many = inspection({
      format: 'dump',
      database: null,
      entries: [...entries, { kind: 'collection', schema: 'crm', name: 'leads' }]
    })
    expect(restoreJob('mongo', { ...draft, scope: 'all' }, many)).toMatchObject({
      archive: false,
      fromDatabase: null,
      toDatabase: null,
      namespaces: []
    })
    expect(validateRestore('mongo', { ...newRestoreDraft(''), scope: 'all' }, many, [])).toBeNull()
  })

  it('rejects a new database that already exists', () => {
    const draft = { ...newRestoreDraft(''), target: 'new' as const, database: 'Shop' }
    expect(validateRestore('postgres', draft, inspection(), ['shop'])).toMatch(/already exists/)
    expect(validateRestore('postgres', draft, null, [])).toMatch(/Choose a backup/)
    expect(validateRestore('postgres', draft, inspection(), [])).toBeNull()
  })
})

describe('SQL Server', () => {
  it('scripts a verified full backup', () => {
    const draft = {
      ...newMssqlBackupDraft("o'brien"),
      path: "C:\\B\\o'brien.bak",
      compression: 'on' as const
    }
    expect(mssqlBackupScript(draft)).toBe(
      [
        "BACKUP DATABASE [o'brien]",
        "TO DISK = N'C:\\B\\o''brien.bak'",
        "WITH INIT, NAME = N'o''brien full backup', COMPRESSION, CHECKSUM, STATS = 5;",
        '',
        `DECLARE @position int = (SELECT MAX(s.position) FROM msdb.dbo.backupset s
  JOIN msdb.dbo.backupmediafamily m ON m.media_set_id = s.media_set_id
  WHERE m.physical_device_name = N'C:\\B\\o''brien.bak');`,
        "RESTORE VERIFYONLY FROM DISK = N'C:\\B\\o''brien.bak' WITH FILE = @position, CHECKSUM;"
      ].join('\n')
    )
  })

  it('scripts differential and log backups', () => {
    const base = {
      ...newMssqlBackupDraft('shop'),
      path: '/var/b/x',
      verify: false,
      checksum: false
    }
    expect(mssqlBackupScript({ ...base, type: 'differential', overwrite: false })).toBe(
      "BACKUP DATABASE [shop]\nTO DISK = N'/var/b/x'\nWITH DIFFERENTIAL, NOINIT, NAME = N'shop differential backup', STATS = 5;"
    )
    expect(mssqlBackupScript({ ...base, type: 'log', copyOnly: true })).toMatch(
      /^BACKUP LOG \[shop\][\s\S]*WITH COPY_ONLY, INIT/
    )
    expect(
      validateMssqlBackup({ ...base, type: 'log' }, { ...server, recoveryModel: 'SIMPLE' })
    ).toMatch(/recovery model/)
  })

  it('places default backups in the server folder with its separator', () => {
    const draft = newMssqlBackupDraft('shop')
    expect(defaultMssqlBackupPath(server, draft, now)).toBe(
      'C:\\SQL\\Backup\\shop_2026-10-22_1405.bak'
    )
    expect(
      defaultMssqlBackupPath(
        { ...server, backupDir: '/var/opt/mssql/data' },
        { ...draft, type: 'log' },
        now
      )
    ).toBe('/var/opt/mssql/data/shop_log_2026-10-22_1405.trn')
    expect(joinServerPath('', 'x.bak')).toBe('x.bak')
  })

  it('reads server defaults', () => {
    expect(parseMssqlServer(['C:\\B', 'D:\\Data\\', null, '4', 'SIMPLE'])).toEqual({
      backupDir: 'C:\\B',
      dataDir: 'D:\\Data\\',
      logDir: 'D:\\Data\\',
      edition: 4,
      recoveryModel: 'SIMPLE'
    })
  })

  it('parses RESTORE HEADERONLY and FILELISTONLY by column name', () => {
    const header: ResultSet = {
      columns: [
        'BackupName',
        'BackupType',
        'Position',
        'DatabaseName',
        'BackupFinishDate',
        'BackupSize'
      ].map((name) => ({ name, typeName: '' })),
      rows: [['nightly', '1', '1', 'shop', '2026-10-22 01:00:00', '1048576']],
      rowCount: 1,
      truncated: false
    }
    expect(parseHeaderOnly(header)).toEqual([
      {
        position: 1,
        type: 'Full',
        database: 'shop',
        name: 'nightly',
        finished: '2026-10-22 01:00:00',
        size: 1048576
      }
    ])
    const files: ResultSet = {
      columns: ['LogicalName', 'PhysicalName', 'Type'].map((name) => ({ name, typeName: '' })),
      rows: [
        ['shop', 'C:\\Old\\shop.mdf', 'D'],
        ['shop_log', 'C:\\Old\\shop_log.ldf', 'L']
      ],
      rowCount: 2,
      truncated: false
    }
    expect(parseFileList(files)).toHaveLength(2)
  })

  it('relocates files so a copy never collides with the original', () => {
    const files = [
      { logical: 'shop', physical: 'C:\\Old\\Shop.mdf', type: 'D' },
      { logical: 'shop_log', physical: 'C:\\Old\\shop_log.ldf', type: 'L' },
      { logical: 'extra', physical: '/var/data/extra.ndf', type: 'D' }
    ]
    expect(defaultMoves(files, 'shop', 'shop_copy', server).map((f) => f.physical)).toEqual([
      'D:\\Data\\shop_copy.mdf',
      'L:\\Logs\\shop_copy_log.ldf',
      'D:\\Data\\shop_copy_extra.ndf'
    ])
    expect(defaultMoves(files, 'shop', 'shop$&$1', server)[0].physical).toBe(
      'D:\\Data\\shop$&$1.mdf'
    )
    const noDefaults = { ...server, dataDir: '', logDir: '' }
    expect(defaultMoves(files, 'shop', 'shop', noDefaults).map((f) => f.physical)).toEqual([
      'C:\\Old\\Shop.mdf',
      'C:\\Old\\shop_log.ldf',
      '/var/data/extra.ndf'
    ])
  })

  it('scripts a restore that frees and releases the database', () => {
    const draft = {
      ...newMssqlRestoreDraft('shop'),
      path: 'C:\\B\\shop.bak',
      position: 2,
      replace: true,
      moves: [{ logical: 'shop', physical: 'D:\\shop.mdf', type: 'D' }]
    }
    expect(mssqlRestoreScript(draft)).toBe(
      [
        "IF DB_ID(N'shop') IS NOT NULL ALTER DATABASE [shop] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;",
        '',
        'RESTORE DATABASE [shop]',
        "FROM DISK = N'C:\\B\\shop.bak'",
        "WITH FILE = 2,\n  MOVE N'shop' TO N'D:\\shop.mdf',\n  REPLACE,\n  RECOVERY,\n  STATS = 5;",
        '',
        "IF DB_ID(N'shop') IS NOT NULL AND DATABASEPROPERTYEX(N'shop', 'Status') = 'ONLINE' ALTER DATABASE [shop] SET MULTI_USER;"
      ].join('\n')
    )
    expect(
      mssqlRestoreScript({ ...draft, closeConnections: false, recovery: false, replace: false })
    ).toBe(
      "RESTORE DATABASE [shop]\nFROM DISK = N'C:\\B\\shop.bak'\nWITH FILE = 2,\n  MOVE N'shop' TO N'D:\\shop.mdf',\n  NORECOVERY,\n  STATS = 5;"
    )
  })
})
