import { describe, expect, it } from 'vitest'
import type { ResultSet } from '../api'
import {
  applyNote,
  canAlterSystem,
  contextInfo,
  docsUrl,
  filterSettings,
  formatSettingValue,
  isChanged,
  parseProbe,
  parseScopedValues,
  parseSettings,
  pgMajor,
  pgSettingsSql,
  settingChangeSql,
  settingName,
  settingValueSql,
  sourceLabel,
  toSettingUnits,
  validateSettingValue,
  type PgSetting
} from '../pg-settings'

const set = (names: string[], rows: (string | null)[][]): ResultSet => ({
  columns: names.map((name) => ({ name, typeName: '' })),
  rows,
  rowCount: rows.length,
  truncated: false
})

const setting = (over: Partial<PgSetting>): PgSetting => ({
  name: 'work_mem',
  setting: '4096',
  unit: 'kB',
  category: 'Resource Usage / Memory',
  shortDesc: '',
  extraDesc: null,
  context: 'user',
  vartype: 'integer',
  source: 'default',
  minVal: '64',
  maxVal: '2147483647',
  enumvals: [],
  bootVal: '4096',
  resetVal: '4096',
  sourcefile: null,
  sourceline: null,
  pendingRestart: false,
  canAlterSystem: null,
  ...over
})

describe('pg settings query', () => {
  it('asks for the ALTER SYSTEM privilege on PG15+ only', () => {
    expect(pgSettingsSql(170002)).toMatch(/has_parameter_privilege\(name, 'ALTER SYSTEM'\)/)
    expect(pgSettingsSql(140010)).not.toMatch(/has_parameter_privilege/)
    expect(pgSettingsSql(140010)).toMatch(/NULL::boolean AS can_alter_system/)
  })

  it('reads the probe and the rows, text booleans included', () => {
    expect(parseProbe(set(['version', 'superuser', 'can_reload'], [['170002', 't', 'f']]))).toEqual(
      { version: 170002, superuser: true, canReload: false }
    )
    const [s] = parseSettings(
      set(
        ['name', 'setting', 'unit', 'vartype', 'enumvals', 'pending_restart', 'can_alter_system'],
        [['wal_level', 'replica', null, 'enum', '["minimal","replica","logical"]', 't', 'f']]
      )
    )
    expect(s.enumvals).toEqual(['minimal', 'replica', 'logical'])
    expect(s.pendingRestart).toBe(true)
    expect(s.canAlterSystem).toBe(false)
  })

  it('splits pg_db_role_setting entries by setting', () => {
    const scoped = parseScopedValues(
      set(
        ['database', 'role', 'config'],
        [
          ['app', '', '["work_mem=64MB","search_path=a, b"]'],
          ['', 'alice', '["work_mem=1GB"]']
        ]
      )
    )
    expect(scoped.get('work_mem')).toEqual([
      { database: 'app', role: '', value: '64MB' },
      { database: '', role: 'alice', value: '1GB' }
    ])
    expect(scoped.get('search_path')?.[0].value).toBe('a, b')
  })
})

describe('formatting values', () => {
  it('renders memory in the largest whole unit', () => {
    expect(formatSettingValue('16384', '8kB')).toBe('128 MB')
    expect(formatSettingValue('4096', 'kB')).toBe('4 MB')
    expect(formatSettingValue('1024', 'MB')).toBe('1 GB')
    expect(formatSettingValue('100', '8kB')).toBe('800 kB')
    expect(formatSettingValue('16777216', 'B')).toBe('16 MB')
  })

  it('renders times the same way', () => {
    expect(formatSettingValue('300000', 'ms')).toBe('5 min')
    expect(formatSettingValue('60', 's')).toBe('1 min')
    expect(formatSettingValue('1500', 'ms')).toBe('1500 ms')
    expect(formatSettingValue('1440', 'min')).toBe('1 d')
    expect(formatSettingValue('0.5', 'ms')).toBe('0.5 ms')
  })

  it('leaves zero, negative and unit-less values alone', () => {
    expect(formatSettingValue('0', 'ms')).toBe('0')
    expect(formatSettingValue('-1', 'kB')).toBe('-1')
    expect(formatSettingValue('replica', null)).toBe('replica')
    expect(formatSettingValue('', null)).toBe('')
  })
})

describe('where values come from', () => {
  it('names the file and line for configuration file values', () => {
    expect(
      sourceLabel(
        setting({
          source: 'configuration file',
          sourcefile: '/data/postgresql.conf',
          sourceline: 129
        })
      )
    ).toBe('/data/postgresql.conf:129')
    expect(sourceLabel(setting({ source: 'database' }))).toBe('database')
  })

  it('counts a setting as changed when it differs from the built-in default', () => {
    expect(isChanged(setting({ source: 'configuration file', setting: '16384' }))).toBe(true)
    expect(isChanged(setting({ source: 'configuration file' }))).toBe(false)
    expect(isChanged(setting({ context: 'internal', setting: '1', bootVal: '2' }))).toBe(false)
  })

  it('explains contexts', () => {
    expect(contextInfo('postmaster').apply).toBe('restart')
    expect(contextInfo('sighup').apply).toBe('reload')
    expect(contextInfo('user').label).toBe('per session')
    expect(contextInfo('backend').apply).toBe('new-session')
  })
})

describe('docs links', () => {
  it('builds the page from the category and the anchor from the name', () => {
    expect(docsUrl({ name: 'shared_buffers', category: 'Resource Usage / Memory' }, 170002)).toBe(
      'https://www.postgresql.org/docs/17/runtime-config-resource.html#GUC-SHARED-BUFFERS'
    )
    expect(
      docsUrl({ name: 'DateStyle', category: 'Client Connection Defaults / Locale' }, 130010)
    ).toBe('https://www.postgresql.org/docs/13/runtime-config-client.html#GUC-DATESTYLE')
    expect(
      docsUrl({ name: 'autovacuum', category: 'Vacuuming / Automatic Vacuuming' }, 180000)
    ).toBe('https://www.postgresql.org/docs/18/runtime-config-vacuum.html#GUC-AUTOVACUUM')
  })

  it('uses the docs page for settings old servers file elsewhere', () => {
    expect(
      docsUrl({ name: 'lc_collate', category: 'Client Connection Defaults / Locale' }, 130010)
    ).toBe('https://www.postgresql.org/docs/13/runtime-config-preset.html#GUC-LC-COLLATE')
  })

  it('points settings documented together at the shared entry', () => {
    expect(
      docsUrl({ name: 'log_parser_stats', category: 'Statistics / Monitoring' }, 170002)
    ).toMatch(/#GUC-LOG-STATEMENT-STATS$/)
  })

  it('has no link for extension settings', () => {
    expect(
      docsUrl({ name: 'pg_stat_statements.max', category: 'Customized Options' }, 170002)
    ).toBeNull()
  })

  it('formats old major versions with a minor', () => {
    expect(pgMajor(90624)).toBe('9.6')
    expect(pgMajor(160004)).toBe('16')
  })
})

describe('validation', () => {
  it('converts units to the setting unit', () => {
    expect(toSettingUnits('128MB', '8kB')).toEqual({ value: 16384 })
    expect(toSettingUnits('5min', 'ms')).toEqual({ value: 300000 })
    expect(toSettingUnits('1.5 GB', 'MB')).toEqual({ value: 1536 })
    expect(toSettingUnits('42', 'kB')).toEqual({ value: 42 })
    expect(toSettingUnits('128mb', 'kB')).toHaveProperty('error')
    expect(toSettingUnits('5min', 'kB')).toHaveProperty('error')
    expect(toSettingUnits('10ms', null)).toHaveProperty('error')
  })

  it('checks numeric ranges', () => {
    const s = setting({})
    expect(validateSettingValue(s, '64MB')).toBeNull()
    expect(validateSettingValue(s, '32kB')).toMatch(/between 64/)
    expect(validateSettingValue(s, 'lots')).toBe('Not a number')
    const real = setting({ vartype: 'real', unit: null, minVal: '0', maxVal: '1' })
    expect(validateSettingValue(real, '0.2')).toBeNull()
    expect(validateSettingValue(real, '1.5')).toMatch(/between 0 and 1/)
  })

  it('checks enums and booleans', () => {
    const e = setting({ vartype: 'enum', unit: null, enumvals: ['minimal', 'replica', 'logical'] })
    expect(validateSettingValue(e, 'Logical')).toBeNull()
    expect(validateSettingValue(e, 'archive')).toMatch(/minimal, replica, logical/)
    const b = setting({ vartype: 'bool', unit: null })
    expect(validateSettingValue(b, 'on')).toBeNull()
    expect(validateSettingValue(b, 'tr')).toBeNull()
    expect(validateSettingValue(b, 'maybe')).not.toBeNull()
  })

  it('accepts any string', () => {
    expect(validateSettingValue(setting({ vartype: 'string', unit: null }), "it's")).toBeNull()
  })
})

describe('change statements', () => {
  it('quotes names and values', () => {
    expect(settingName('DateStyle')).toBe('datestyle')
    expect(settingName('pg_stat_statements.max')).toBe('pg_stat_statements.max')
    expect(settingValueSql('application_name', "it's")).toBe("'it''s'")
  })

  it('quotes each element of list settings', () => {
    expect(settingValueSql('search_path', '"$user", public')).toBe("'$user', 'public'")
    expect(settingValueSql('shared_preload_libraries', 'pg_stat_statements,auto_explain')).toBe(
      "'pg_stat_statements', 'auto_explain'"
    )
    expect(settingValueSql('shared_preload_libraries', '')).toBe("''")
  })

  it('reloads after ALTER SYSTEM when asked', () => {
    expect(
      settingChangeSql({ scope: { kind: 'system' }, name: 'work_mem', value: '64MB', reload: true })
    ).toEqual(["ALTER SYSTEM SET work_mem = '64MB'", 'SELECT pg_reload_conf()'])
    expect(
      settingChangeSql({ scope: { kind: 'system' }, name: 'work_mem', value: null, reload: false })
    ).toEqual(['ALTER SYSTEM RESET work_mem'])
  })

  it('writes per-database and per-role statements without a reload', () => {
    expect(
      settingChangeSql({
        scope: { kind: 'database', database: 'My App' },
        name: 'work_mem',
        value: '64MB',
        reload: true
      })
    ).toEqual([`ALTER DATABASE "My App" SET work_mem = '64MB'`])
    expect(
      settingChangeSql({
        scope: { kind: 'role-in-database', role: 'alice', database: 'app' },
        name: 'statement_timeout',
        value: null,
        reload: false
      })
    ).toEqual(['ALTER ROLE alice IN DATABASE app RESET statement_timeout'])
  })

  it('says a postmaster change needs a restart', () => {
    const s = setting({ name: 'shared_buffers', context: 'postmaster' })
    expect(
      applyNote(s, { scope: { kind: 'system' }, name: s.name, value: '1GB', reload: false })
    ).toMatch(/restart/)
  })

  it('needs a superuser or the PG15 privilege to edit', () => {
    expect(canAlterSystem(setting({}), { version: 170002, superuser: true, canReload: true })).toBe(
      true
    )
    expect(
      canAlterSystem(setting({}), { version: 170002, superuser: false, canReload: false })
    ).toBe(false)
    expect(
      canAlterSystem(setting({ canAlterSystem: true }), {
        version: 170002,
        superuser: false,
        canReload: false
      })
    ).toBe(true)
    expect(
      canAlterSystem(setting({ context: 'internal' }), {
        version: 170002,
        superuser: true,
        canReload: true
      })
    ).toBe(false)
  })
})

describe('filtering', () => {
  const all = [
    setting({ name: 'work_mem', setting: '65536', source: 'configuration file' }),
    setting({ name: 'shared_buffers', pendingRestart: true, category: 'Resource Usage / Memory' }),
    setting({ name: 'wal_level', category: 'Write-Ahead Log / Settings', shortDesc: 'WAL detail' })
  ]
  it('filters by search, category and state', () => {
    const f = (o: Partial<Parameters<typeof filterSettings>[1]>): string[] =>
      filterSettings(all, { search: '', category: '', filter: 'all', ...o }).map((s) => s.name)
    expect(f({ search: 'wal detail' })).toEqual(['wal_level'])
    expect(f({ category: 'Resource Usage' })).toEqual(['work_mem', 'shared_buffers'])
    expect(f({ filter: 'changed' })).toEqual(['work_mem'])
    expect(f({ filter: 'pending' })).toEqual(['shared_buffers'])
  })
})
