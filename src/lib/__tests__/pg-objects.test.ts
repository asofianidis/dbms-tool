import { describe, expect, it } from 'vitest'
import {
  CRON_JOBS_SQL,
  EVENT_TRIGGERS_SQL,
  FOREIGN_SERVERS_SQL,
  createServerSql,
  createUserMappingSql,
  cronHistorySql,
  cronJobLabel,
  cronJobTooltip,
  cronScheduleSql,
  cronSetActiveSql,
  cronUnscheduleSql,
  dropEventTriggerSql,
  dropRoutineSql,
  dropServerSql,
  dropUserMappingSql,
  eventTriggerStateLabel,
  eventTriggerTooltip,
  formatOptions,
  isEventTriggerEnabled,
  isSecretOption,
  parseCronJobs,
  parseEventTriggers,
  parseForeignServers,
  routineSignature,
  setEventTriggerEnabledSql
} from '../pg-objects'

describe('aggregates and window functions', () => {
  it('drops with the identity signature, * for no arguments', () => {
    const agg = { schema: 'public', name: 'my sum', kind: 'aggregate' as const, detail: 'integer' }
    expect(dropRoutineSql(agg)).toBe('DROP AGGREGATE public."my sum"(integer);')
    expect(dropRoutineSql({ ...agg, name: 'cnt', detail: '' })).toBe(
      'DROP AGGREGATE public.cnt(*);'
    )
    expect(
      dropRoutineSql({ ...agg, name: 'pct', detail: 'double precision ORDER BY anyelement' })
    ).toBe('DROP AGGREGATE public.pct(double precision ORDER BY anyelement);')
    expect(
      dropRoutineSql({ schema: 'pg_catalog', name: 'rank', kind: 'window_function', detail: '' })
    ).toBe('DROP FUNCTION pg_catalog.rank();')
    expect(routineSignature({ kind: 'window_function', detail: null })).toBe('')
  })
})

describe('event triggers', () => {
  // Rows as EVENT_TRIGGERS_SQL returns them (tags joined with chr(31))
  const [tagged, disabled] = parseEventTriggers([
    [
      'audit',
      'ddl_command_start',
      'O',
      'CREATE TABLE\u001fDROP TABLE',
      'public.log_ddl',
      'postgres',
      'Logs DDL',
      "CREATE EVENT TRIGGER audit ON ddl_command_start\n  WHEN TAG IN ('CREATE TABLE', 'DROP TABLE')\n  EXECUTE FUNCTION public.log_ddl();"
    ],
    [
      'Drops',
      'sql_drop',
      'D',
      null,
      'log_ddl',
      'postgres',
      null,
      'CREATE EVENT TRIGGER "Drops" ON sql_drop\n  EXECUTE FUNCTION log_ddl();\nALTER EVENT TRIGGER "Drops" DISABLE;'
    ]
  ])

  it('parses state and tags', () => {
    expect(tagged.tags).toEqual(['CREATE TABLE', 'DROP TABLE'])
    expect(disabled.tags).toEqual([])
    expect(isEventTriggerEnabled(tagged)).toBe(true)
    expect(isEventTriggerEnabled(disabled)).toBe(false)
    expect(eventTriggerStateLabel(tagged)).toBeNull()
    expect(eventTriggerStateLabel(disabled)).toBe('disabled')
    expect(eventTriggerStateLabel({ enabled: 'R' })).toBe('replica only')
    expect(eventTriggerStateLabel({ enabled: 'A' })).toBe('always')
    expect(eventTriggerTooltip(tagged)).toContain('Tags: CREATE TABLE, DROP TABLE')
    expect(eventTriggerTooltip(disabled)).toContain('Tags: all')
    expect(eventTriggerTooltip(disabled)).toContain('State: disabled')
  })

  it('scripts enable, disable and drop with quoted names', () => {
    expect(setEventTriggerEnabledSql('Drops', true)).toBe('ALTER EVENT TRIGGER "Drops" ENABLE;')
    expect(setEventTriggerEnabledSql('audit', false)).toBe('ALTER EVENT TRIGGER audit DISABLE;')
    expect(dropEventTriggerSql('Drops')).toBe('DROP EVENT TRIGGER "Drops";')
    // The DDL keeps a disabled trigger disabled
    expect(disabled.definition).toMatch(/\nALTER EVENT TRIGGER "Drops" DISABLE;$/)
  })

  it('builds DDL that works before PostgreSQL 11', () => {
    expect(EVENT_TRIGGERS_SQL).toContain("THEN 'FUNCTION' ELSE 'PROCEDURE'")
  })
})

describe('foreign servers', () => {
  const [server] = parseForeignServers([
    [
      'remote',
      'postgres_fdw',
      null,
      null,
      'postgres',
      '[["host", "db1"], ["port", "5432"], ["password_required", "false"]]',
      null,
      '[["alice", [["user", "app"], ["password", "it\'s secret"]]], [null, [["user", "ro"]]], ["bob", null]]',
      '[["public", "orders"], ["sales", "items"]]'
    ]
  ])

  it('parses wrapper, options, mappings and tables', () => {
    expect(server.wrapper).toBe('postgres_fdw')
    expect(server.options).toHaveLength(3)
    expect(server.mappings.map((m) => m.user)).toEqual(['alice', null, 'bob'])
    expect(server.mappings[2].options).toBeNull()
    expect(server.tables).toEqual([
      ['public', 'orders'],
      ['sales', 'items']
    ])
    expect(
      parseForeignServers([['s', 'file_fdw', null, null, null, null, null, null, null]])[0]
    ).toMatchObject({ options: [], mappings: [], tables: [] })
  })

  it('masks password-like options everywhere', () => {
    expect(isSecretOption('password')).toBe(true)
    expect(isSecretOption('sslpassword')).toBe(true)
    expect(isSecretOption('aws_secret_access_key')).toBe(true)
    expect(isSecretOption('user')).toBe(false)
    expect(formatOptions(server.mappings[0].options)).toBe('user=app, password=********')
    expect(formatOptions(server.mappings[2].options)).toBe('options hidden')
    expect(isSecretOption('password_required')).toBe(false)
    expect(formatOptions(server.options)).toBe('host=db1, port=5432, password_required=false')
    const mapping = createUserMappingSql('remote', server.mappings[0])
    expect(mapping).not.toContain('secret')
    expect(mapping).toBe(
      "-- Secret options are shown as '********'; replace them before running\n" +
        "CREATE USER MAPPING FOR alice SERVER remote OPTIONS (\"user\" 'app', password '********');"
    )
  })

  it('scripts servers and mappings', () => {
    expect(createServerSql({ ...server, options: [['host', 'db1']], type: 'pg', version: '17' }))
      .toBe(`CREATE SERVER remote TYPE 'pg' VERSION '17'
  FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'db1');`)
    expect(createUserMappingSql('remote', server.mappings[1])).toBe(
      'CREATE USER MAPPING FOR PUBLIC SERVER remote OPTIONS ("user" \'ro\');'
    )
    expect(createUserMappingSql('remote', server.mappings[2])).toContain(
      "-- The options aren't visible to you"
    )
    expect(dropUserMappingSql('remote', { user: null })).toBe(
      'DROP USER MAPPING FOR PUBLIC SERVER remote;'
    )
    expect(dropServerSql(server)).toBe(
      '-- Fails while 3 user mappings and 2 foreign tables use it; CASCADE drops them too\nDROP SERVER remote;'
    )
    expect(dropServerSql({ name: 'Idle', mappings: [], tables: [] })).toBe('DROP SERVER "Idle";')
  })

  it('reads user mappings through pg_user_mappings', () => {
    expect(FOREIGN_SERVERS_SQL).toContain('pg_user_mappings')
    expect(FOREIGN_SERVERS_SQL).toContain('m.umuser = 0')
  })
})

describe('pg_cron jobs', () => {
  const [named, unnamed, elsewhere] = parseCronJobs([
    [
      '1',
      'nightly-vacuum',
      '0 3 * * *',
      'VACUUM ANALYZE',
      'postgres',
      'postgres',
      'true',
      'succeeded',
      '2026-10-25 03:00:00+00',
      '2026-10-25 03:00:02+00',
      '1 row'
    ],
    ['2', null, '* * * * *', "SELECT 'x$y'", 'postgres', 'app', 'false', null, null, null, null],
    ['3', 'other', '@daily', 'SELECT 1', 'shop', 'app', 'true']
  ])

  it('parses jobs, older pg_cron rows included', () => {
    expect(named).toMatchObject({ id: 1, active: true, lastStatus: 'succeeded' })
    expect(unnamed.active).toBe(false)
    expect(elsewhere.lastStart).toBeNull()
    expect(cronJobLabel(unnamed)).toBe('job 2')
    expect(cronJobTooltip(named)).toContain('Last run: succeeded at 2026-10-25 03:00:00+00 (1 row)')
    expect(cronJobTooltip(elsewhere)).toContain('Last run: never')
  })

  it('scripts schedule, unschedule and activation', () => {
    expect(cronScheduleSql(named, 'postgres')).toBe(
      "SELECT cron.schedule('nightly-vacuum', '0 3 * * *', $$VACUUM ANALYZE$$);"
    )
    // Inactive, and the command has a dollar sign
    expect(cronScheduleSql(unnamed, 'postgres')).toBe(
      "SELECT cron.schedule_in_database('job_2', '* * * * *', 'SELECT ''x$y''', 'postgres', 'app', false);"
    )
    expect(cronScheduleSql(elsewhere, 'postgres')).toBe(
      "SELECT cron.schedule_in_database('other', '@daily', $$SELECT 1$$, 'shop', 'app', true);"
    )
    expect(cronUnscheduleSql(named)).toBe('SELECT cron.unschedule(1); -- nightly-vacuum')
    expect(cronUnscheduleSql(unnamed)).toBe('SELECT cron.unschedule(2);')
    expect(cronSetActiveSql(2, true)).toBe('SELECT cron.alter_job(job_id := 2, active := true);')
    expect(cronHistorySql(1)).toContain('WHERE jobid = 1')
  })

  it('falls back for pg_cron without run details', () => {
    expect(CRON_JOBS_SQL).toHaveLength(2)
    expect(CRON_JOBS_SQL[0]).toContain('cron.job_run_details')
    expect(CRON_JOBS_SQL[1]).not.toContain('job_run_details')
  })
})
