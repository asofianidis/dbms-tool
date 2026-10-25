/**
 * MySQL / MariaDB scheduled events (`CREATE EVENT … ON SCHEDULE …`). The backend lists them
 * with kind `event` and a detail of `STATUS · schedule · last run … · definer …`
 * (drivers/mysql/events.rs); this reads it back and builds the scripts the explorer runs.
 */
import { queryOptions } from '@tanstack/react-query'
import { api, type Cell, type DbObject } from './api'
import { quoteIdent } from './sql'

/** ENABLED | DISABLED | SLAVESIDE_DISABLED (REPLICA_SIDE_DISABLED on newer MySQL) */
export type EventStatus = string

const DETAIL_SEPARATOR = ' · '

/** The event's status, from the first part of its detail. */
export function eventStatus(detail: string | null | undefined): EventStatus {
  return detail?.split(DETAIL_SEPARATOR)[0]?.trim().toUpperCase() || 'ENABLED'
}

export function isEventEnabled(detail: string | null | undefined): boolean {
  return eventStatus(detail) === 'ENABLED'
}

/** Short status for the tree row; null for an enabled event. */
export function eventStatusLabel(detail: string | null | undefined): string | null {
  const status = eventStatus(detail)
  if (status === 'ENABLED') return null
  // Disabled on a replica: it runs on the source server
  if (status.includes('SIDE_DISABLED')) return 'replica-disabled'
  return status.toLowerCase()
}

/** Multi-line tooltip: status, schedule, last run, definer and comment. */
export function eventTooltip(obj: Pick<DbObject, 'detail' | 'comment'>): string {
  const [status, schedule, ...rest] = (obj.detail ?? '').split(DETAIL_SEPARATOR)
  const lines = [`Status: ${status || 'ENABLED'}`]
  if (schedule) lines.push(`Schedule: ${schedule}`)
  for (const part of rest) {
    if (part.startsWith('last run ')) lines.push(`Last run: ${part.slice(9)}`)
    else if (part.startsWith('definer ')) lines.push(`Definer: ${part.slice(8)}`)
  }
  if (!rest.some((p) => p.startsWith('last run '))) lines.push('Last run: never')
  if (obj.comment) lines.push(obj.comment)
  return lines.join('\n')
}

const target = (database: string, name: string): string =>
  `${quoteIdent('mysql', database)}.${quoteIdent('mysql', name)}`

export function setEventEnabledSql(database: string, name: string, enabled: boolean): string {
  return `ALTER EVENT ${target(database, name)} ${enabled ? 'ENABLE' : 'DISABLE'};`
}

export function dropEventSql(database: string, name: string): string {
  return `DROP EVENT IF EXISTS ${target(database, name)};`
}

const withSemicolon = (sql: string): string => {
  const body = sql.trim()
  return body.endsWith(';') ? body : `${body};`
}

/** `SHOW CREATE EVENT` output as a runnable script. */
export function createEventScript(definition: string): string {
  return withSemicolon(definition)
}

/**
 * The definition rewritten as ALTER EVENT, which takes the same clauses, so the
 * schedule, status, comment or body can be edited in place.
 */
export function alterEventScript(definition: string): string {
  return withSemicolon(
    definition
      .trim()
      .replace(/^((?:\s|--[^\n]*\n|\/\*(?:[^*]|\*(?!\/))*\*\/)*)create\b/i, '$1ALTER')
  )
}

/** Starter code for a new event; warns when the scheduler won't run it. */
export function eventTemplate(scheduler: string | null = null): string {
  const note = schedulerNote(scheduler)
  return `${note ? `-- ${note}\n` : ''}CREATE EVENT new_event
ON SCHEDULE EVERY 1 DAY
STARTS CURRENT_TIMESTAMP + INTERVAL 1 HOUR
ON COMPLETION PRESERVE
ENABLE
COMMENT 'What this event does'
DO
BEGIN
  -- event body, e.g. DELETE FROM sessions WHERE expires_at < NOW();
  SET @new_event_ran_at = NOW();
END;`
}

/* ---------- Event scheduler ---------- */

export const EVENT_SCHEDULER_SQL = 'SELECT @@event_scheduler'

/** ON | OFF | DISABLED, from the first cell of `EVENT_SCHEDULER_SQL`. */
export function parseScheduler(cell: Cell | undefined): string | null {
  if (cell === null || cell === undefined) return null
  const value = String(cell).trim().toUpperCase()
  // Older servers report the variable as 1/0
  if (value === '1') return 'ON'
  if (value === '0') return 'OFF'
  return value || null
}

/** Why events won't fire with this scheduler state; null when it's running (or unknown). */
export function schedulerNote(scheduler: string | null): string | null {
  switch (scheduler) {
    case 'OFF':
      return "The event scheduler is OFF, so events don't run. Start it with SET GLOBAL event_scheduler = ON."
    case 'DISABLED':
      return "The event scheduler was disabled at server startup, so events don't run until the server is restarted with event_scheduler enabled."
    default:
      return null
  }
}

/** The server's `@@event_scheduler`, read on the metadata session. */
export const eventSchedulerQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['conn', connectionId, 'eventScheduler'],
    queryFn: async () => {
      const out = await api.execute(connectionId, '__meta', '', EVENT_SCHEDULER_SQL)
      if (out.error) throw new Error(out.error.message)
      return parseScheduler(out.results[0]?.rows[0]?.[0])
    },
    staleTime: 60_000
  })
