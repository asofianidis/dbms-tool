import { describe, expect, it } from 'vitest'
import {
  alterEventScript,
  createEventScript,
  dropEventSql,
  eventStatus,
  eventStatusLabel,
  eventTemplate,
  eventTooltip,
  isEventEnabled,
  parseScheduler,
  schedulerNote,
  setEventEnabledSql
} from '../events'
import { objectSearchSql } from '../object-search'
import { splitStatements } from '../sql'

// What drivers/mysql/events.rs puts in the detail
const recurring =
  'DISABLED · EVERY 1 HOUR STARTS 2026-01-01 00:00:00 ENDS 2030-01-01 00:00:00 · last run 2026-10-25 10:00:00 · definer root@localhost'
const once = 'ENABLED · AT 2030-05-01 12:00:00 · definer root@localhost'

// SHOW CREATE EVENT output, as MariaDB 11.8 and MySQL 8.4 return it
const definition =
  "CREATE DEFINER=`root`@`localhost` EVENT `ev_every` ON SCHEDULE EVERY 1 HOUR STARTS '2026-01-01 00:00:00' ENDS '2030-01-01 00:00:00' ON COMPLETION NOT PRESERVE DISABLE COMMENT 'hourly cleanup' DO DELETE FROM t"

describe('event status', () => {
  it('reads the status from the detail', () => {
    expect(eventStatus(recurring)).toBe('DISABLED')
    expect(eventStatus(once)).toBe('ENABLED')
    expect(eventStatus(null)).toBe('ENABLED')
    expect(isEventEnabled(once)).toBe(true)
    expect(isEventEnabled(recurring)).toBe(false)
  })

  it('labels only events that are not enabled', () => {
    expect(eventStatusLabel(once)).toBeNull()
    expect(eventStatusLabel(recurring)).toBe('disabled')
    expect(eventStatusLabel('SLAVESIDE_DISABLED · AT x')).toBe('replica-disabled')
    expect(eventStatusLabel('REPLICA_SIDE_DISABLED · AT x')).toBe('replica-disabled')
  })

  it('builds a tooltip with schedule, last run, definer and comment', () => {
    expect(eventTooltip({ detail: recurring, comment: 'hourly cleanup' })).toBe(
      [
        'Status: DISABLED',
        'Schedule: EVERY 1 HOUR STARTS 2026-01-01 00:00:00 ENDS 2030-01-01 00:00:00',
        'Last run: 2026-10-25 10:00:00',
        'Definer: root@localhost',
        'hourly cleanup'
      ].join('\n')
    )
    expect(eventTooltip({ detail: once, comment: null })).toBe(
      [
        'Status: ENABLED',
        'Schedule: AT 2030-05-01 12:00:00',
        'Definer: root@localhost',
        'Last run: never'
      ].join('\n')
    )
  })
})

describe('event scripts', () => {
  it('enables, disables and drops by qualified name', () => {
    expect(setEventEnabledSql('mdb_events', 'ev_once', false)).toBe(
      'ALTER EVENT `mdb_events`.`ev_once` DISABLE;'
    )
    expect(setEventEnabledSql('mdb_events', 'we`ird', true)).toBe(
      'ALTER EVENT `mdb_events`.`we``ird` ENABLE;'
    )
    expect(dropEventSql('mdb_events', 'ev_once')).toBe(
      'DROP EVENT IF EXISTS `mdb_events`.`ev_once`;'
    )
  })

  it('turns the definition into CREATE and ALTER scripts', () => {
    expect(createEventScript(definition)).toBe(`${definition};`)
    expect(alterEventScript(definition)).toBe(`ALTER${definition.slice('CREATE'.length)};`)
    expect(alterEventScript(`-- note\ncreate event e on schedule at now() do select 1;`)).toBe(
      '-- note\nALTER event e on schedule at now() do select 1;'
    )
  })

  it('has a template that runs as one statement', () => {
    const template = eventTemplate()
    expect(template).toMatch(/^CREATE EVENT new_event\nON SCHEDULE EVERY 1 DAY/)
    expect(splitStatements(template, 'mysql')).toHaveLength(1)
  })

  it('warns in the template when the scheduler is off', () => {
    expect(eventTemplate('OFF')).toMatch(/^-- The event scheduler is OFF/)
    expect(eventTemplate('ON')).toMatch(/^CREATE EVENT/)
  })
})

describe('event scheduler', () => {
  it('parses @@event_scheduler', () => {
    expect(parseScheduler('OFF')).toBe('OFF')
    expect(parseScheduler('on')).toBe('ON')
    expect(parseScheduler('DISABLED')).toBe('DISABLED')
    expect(parseScheduler('1')).toBe('ON')
    expect(parseScheduler(null)).toBeNull()
  })

  it('explains why events do not fire', () => {
    expect(schedulerNote('ON')).toBeNull()
    expect(schedulerNote(null)).toBeNull()
    expect(schedulerNote('OFF')).toContain('SET GLOBAL event_scheduler = ON')
    expect(schedulerNote('DISABLED')).toContain('server startup')
  })
})

describe('object search', () => {
  it('finds MySQL events', () => {
    const sql = objectSearchSql('mysql', 'ev')
    expect(sql).toContain("SELECT event_schema, NULL, event_name, 'event', NULL")
    expect(sql).toContain("lower(event_name) LIKE '%ev%'")
  })
})
