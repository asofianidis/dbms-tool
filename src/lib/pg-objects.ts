/**
 * PostgreSQL objects the explorer lists at the database level: event triggers,
 * foreign servers (with their user mappings and foreign tables) and pg_cron jobs,
 * plus the scripts for aggregates and window functions, which the backend lists
 * beside functions (kinds `aggregate` / `window_function`).
 */
import type { Cell, DbObject } from './api'
import { catalogRows } from './catalog'
import { literal, quoteIdent } from './sql'

const text = (cell: Cell | undefined): string | null => (typeof cell === 'string' ? cell : null)
const q = (name: string): string => quoteIdent('postgres', name)
const lit = (value: string): string => literal('postgres', value)

/* ---------- Aggregates and window functions ---------- */

/** The argument list in DROP / ALTER: `*` for an aggregate over no arguments, like count(*). */
export function routineSignature(obj: Pick<DbObject, 'kind' | 'detail'>): string {
  const args = obj.detail ?? ''
  return obj.kind === 'aggregate' && !args.trim() ? '*' : args
}

export function dropRoutineSql(obj: Pick<DbObject, 'schema' | 'name' | 'kind' | 'detail'>): string {
  const what = obj.kind === 'aggregate' ? 'AGGREGATE' : 'FUNCTION'
  const target = obj.schema ? `${q(obj.schema)}.${q(obj.name)}` : q(obj.name)
  return `DROP ${what} ${target}(${routineSignature(obj)});`
}

/* ---------- Event triggers ---------- */

export interface EventTrigger {
  name: string
  /** ddl_command_start | ddl_command_end | sql_drop | table_rewrite | login */
  event: string
  /** O (enabled), D (disabled), R (replica), A (always) */
  enabled: string
  tags: string[]
  function: string
  owner: string | null
  comment: string | null
  definition: string
}

/** Columns: name, event, enabled, tags, function, owner, comment, definition. */
export const EVENT_TRIGGERS_SQL = `SELECT e.evtname::text, e.evtevent::text, e.evtenabled::text,
  array_to_string(e.evttags, chr(31)), e.evtfoid::regproc::text, pg_get_userbyid(e.evtowner)::text,
  obj_description(e.oid, 'pg_event_trigger'),
  format('CREATE EVENT TRIGGER %I ON %s%s' || chr(10) || '  EXECUTE %s %s();', e.evtname, e.evtevent,
    CASE WHEN e.evttags IS NOT NULL THEN chr(10) || '  WHEN TAG IN ('
      || (SELECT string_agg(quote_literal(t), ', ') FROM unnest(e.evttags) t) || ')' ELSE '' END,
    -- EXECUTE FUNCTION is PostgreSQL 11+; PROCEDURE still works there
    CASE WHEN current_setting('server_version_num')::int >= 110000 THEN 'FUNCTION' ELSE 'PROCEDURE' END,
    e.evtfoid::regproc)
  || CASE e.evtenabled
    WHEN 'D' THEN format(chr(10) || 'ALTER EVENT TRIGGER %I DISABLE;', e.evtname)
    WHEN 'R' THEN format(chr(10) || 'ALTER EVENT TRIGGER %I ENABLE REPLICA;', e.evtname)
    WHEN 'A' THEN format(chr(10) || 'ALTER EVENT TRIGGER %I ENABLE ALWAYS;', e.evtname)
    ELSE '' END
FROM pg_event_trigger e
ORDER BY 1`

export function parseEventTriggers(rows: Cell[][]): EventTrigger[] {
  return rows.map((r) => ({
    name: text(r[0]) ?? '',
    event: text(r[1]) ?? '',
    enabled: text(r[2]) ?? 'O',
    tags: text(r[3])?.split('\u001f').filter(Boolean) ?? [],
    function: text(r[4]) ?? '',
    owner: text(r[5]),
    comment: text(r[6]),
    definition: text(r[7]) ?? ''
  }))
}

export const isEventTriggerEnabled = (t: Pick<EventTrigger, 'enabled'>): boolean =>
  t.enabled !== 'D'

/** Short state for the tree row: null when enabled normally. */
export function eventTriggerStateLabel(t: Pick<EventTrigger, 'enabled'>): string | null {
  switch (t.enabled) {
    case 'D':
      return 'disabled'
    case 'R':
      return 'replica only'
    case 'A':
      return 'always'
    default:
      return null
  }
}

export function eventTriggerTooltip(t: EventTrigger): string {
  return [
    `Event: ${t.event}`,
    `State: ${eventTriggerStateLabel(t) ?? 'enabled'}`,
    `Tags: ${t.tags.length ? t.tags.join(', ') : 'all'}`,
    `Function: ${t.function}()`,
    t.owner && `Owner: ${t.owner}`,
    t.comment
  ]
    .filter(Boolean)
    .join('\n')
}

export function setEventTriggerEnabledSql(name: string, enabled: boolean): string {
  return `ALTER EVENT TRIGGER ${q(name)} ${enabled ? 'ENABLE' : 'DISABLE'};`
}

export function dropEventTriggerSql(name: string): string {
  return `DROP EVENT TRIGGER ${q(name)};`
}

/** Starter code for a new event trigger and its function. */
export function eventTriggerTemplate(): string {
  return `CREATE OR REPLACE FUNCTION public.log_ddl() RETURNS event_trigger
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    RAISE NOTICE '% %', r.command_tag, r.object_identity;
  END LOOP;
END $$;

CREATE EVENT TRIGGER log_ddl ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'ALTER TABLE')
  EXECUTE FUNCTION public.log_ddl();`
}

/* ---------- Foreign servers ---------- */

export type FdwOption = [name: string, value: string | null]

export interface UserMapping {
  /** null for PUBLIC */
  user: string | null
  /** null when the current user may not read the options */
  options: FdwOption[] | null
}

export interface ForeignServer {
  name: string
  wrapper: string
  type: string | null
  version: string | null
  owner: string | null
  options: FdwOption[]
  comment: string | null
  mappings: UserMapping[]
  /** [schema, table] of the foreign tables on this server */
  tables: [string, string][]
}

const optionsJson = (column: string): string =>
  `(SELECT json_agg(json_build_array(o.option_name, o.option_value)) FROM pg_options_to_table(${column}) o)`

/** Columns: name, wrapper, type, version, owner, options, comment, user mappings, foreign tables (JSON). */
export const FOREIGN_SERVERS_SQL = `SELECT s.srvname::text, w.fdwname::text, s.srvtype, s.srvversion,
  pg_get_userbyid(s.srvowner)::text, ${optionsJson('s.srvoptions')}::text,
  obj_description(s.oid, 'pg_foreign_server'),
  -- umoptions is NULL unless the current user may read it
  (SELECT json_agg(json_build_array(CASE WHEN m.umuser = 0 THEN NULL ELSE m.usename END,
     ${optionsJson('m.umoptions')}) ORDER BY m.usename)
   FROM pg_user_mappings m WHERE m.srvid = s.oid)::text,
  (SELECT json_agg(json_build_array(n.nspname, c.relname) ORDER BY n.nspname, c.relname)
   FROM pg_foreign_table ft JOIN pg_class c ON c.oid = ft.ftrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ft.ftserver = s.oid)::text
FROM pg_foreign_server s JOIN pg_foreign_data_wrapper w ON w.oid = s.srvfdw
ORDER BY 1`

function json<T>(cell: Cell | undefined, fallback: T): T {
  const raw = text(cell)
  if (!raw) return fallback
  try {
    return (JSON.parse(raw) as T | null) ?? fallback
  } catch {
    return fallback
  }
}

export function parseForeignServers(rows: Cell[][]): ForeignServer[] {
  return rows.map((r) => ({
    name: text(r[0]) ?? '',
    wrapper: text(r[1]) ?? '',
    type: text(r[2]),
    version: text(r[3]),
    owner: text(r[4]),
    options: json<FdwOption[]>(r[5], []),
    comment: text(r[6]),
    mappings: json<[string | null, FdwOption[] | null][]>(r[7], []).map(([user, options]) => ({
      user,
      // A mapping without options reads as NULL too, but only when allowed is it []
      options
    })),
    tables: json<[string, string][]>(r[8], [])
  }))
}

export const MASK = '********'

/** Options whose values are credentials, never shown or scripted (postgres_fdw's password_required is a flag). */
export const isSecretOption = (name: string): boolean =>
  /pass|secret|token|credential|api_?key/i.test(name) && !/_required$/i.test(name)

export const maskOptions = (options: FdwOption[]): FdwOption[] =>
  options.map(([name, value]) => [name, value !== null && isSecretOption(name) ? MASK : value])

/** `host=db1, port=5432, password=********` for the tree. */
export function formatOptions(options: FdwOption[] | null): string {
  if (!options) return 'options hidden'
  return maskOptions(options)
    .map(([name, value]) => `${name}=${value ?? ''}`)
    .join(', ')
}

function optionsClause(options: FdwOption[] | null): string {
  if (!options?.length) return ''
  const list = maskOptions(options)
    .map(([name, value]) => `${q(name)} ${lit(value ?? '')}`)
    .join(', ')
  return ` OPTIONS (${list})`
}

const maskedNote = (options: FdwOption[] | null): string =>
  options?.some(([name, value]) => value !== null && isSecretOption(name))
    ? `-- Secret options are shown as '${MASK}'; replace them before running\n`
    : ''

export function createServerSql(s: ForeignServer): string {
  return `${maskedNote(s.options)}CREATE SERVER ${q(s.name)}${s.type ? ` TYPE ${lit(s.type)}` : ''}${s.version ? ` VERSION ${lit(s.version)}` : ''}
  FOREIGN DATA WRAPPER ${q(s.wrapper)}${optionsClause(s.options)};`
}

export function dropServerSql(s: Pick<ForeignServer, 'name' | 'mappings' | 'tables'>): string {
  const deps = [
    s.mappings.length && `${s.mappings.length} user mapping${s.mappings.length > 1 ? 's' : ''}`,
    s.tables.length && `${s.tables.length} foreign table${s.tables.length > 1 ? 's' : ''}`
  ].filter(Boolean)
  return `${deps.length ? `-- Fails while ${deps.join(' and ')} use it; CASCADE drops them too\n` : ''}DROP SERVER ${q(s.name)};`
}

const mappingUser = (user: string | null): string => (user === null ? 'PUBLIC' : q(user))

export function createUserMappingSql(server: string, m: UserMapping): string {
  const hidden = m.options === null ? "-- The options aren't visible to you; add them here\n" : ''
  return `${hidden}${maskedNote(m.options)}CREATE USER MAPPING FOR ${mappingUser(m.user)} SERVER ${q(server)}${optionsClause(m.options)};`
}

export function dropUserMappingSql(server: string, m: Pick<UserMapping, 'user'>): string {
  return `DROP USER MAPPING FOR ${mappingUser(m.user)} SERVER ${q(server)};`
}

export function userMappingTemplate(server: string): string {
  return `CREATE USER MAPPING FOR CURRENT_USER SERVER ${q(server)}
  OPTIONS (user 'remote_user', password 'secret');`
}

export function foreignServerTemplate(): string {
  return `CREATE EXTENSION IF NOT EXISTS postgres_fdw;

CREATE SERVER remote_db FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host 'localhost', port '5432', dbname 'postgres');

CREATE USER MAPPING FOR CURRENT_USER SERVER remote_db
  OPTIONS (user 'postgres', password 'secret');

-- IMPORT FOREIGN SCHEMA public FROM SERVER remote_db INTO public;`
}

/* ---------- pg_cron ---------- */

/** The pg_cron version installed in the database, if any. */
export const PG_CRON_SQL = `SELECT extversion FROM pg_extension WHERE extname = 'pg_cron'`

export interface CronJob {
  id: number
  name: string | null
  schedule: string
  command: string
  database: string | null
  user: string | null
  active: boolean
  lastStatus: string | null
  lastStart: string | null
  lastEnd: string | null
  lastMessage: string | null
}

/**
 * Columns: id, name, schedule, command, database, user, active, then the last
 * run's status, start, end and message. cron.job only shows the user's own jobs
 * unless they're a superuser. The second query is for pg_cron before 1.3, which
 * had no job names, active flag or run history.
 */
export const CRON_JOBS_SQL = [
  `SELECT j.jobid::text, j.jobname, j.schedule, j.command, j.database, j.username, j.active::text,
  r.status, r.start_time::text, r.end_time::text, r.return_message
FROM cron.job j
LEFT JOIN (SELECT DISTINCT ON (jobid) jobid, status, start_time, end_time, return_message
           FROM cron.job_run_details ORDER BY jobid, runid DESC) r ON r.jobid = j.jobid
ORDER BY j.jobid`,
  `SELECT j.jobid::text, NULL, j.schedule, j.command, j.database, j.username, 'true'
FROM cron.job j ORDER BY j.jobid`
]

export function parseCronJobs(rows: Cell[][]): CronJob[] {
  return rows.map((r) => ({
    id: Number(text(r[0]) ?? 0),
    name: text(r[1]),
    schedule: text(r[2]) ?? '',
    command: text(r[3]) ?? '',
    database: text(r[4]),
    user: text(r[5]),
    active: text(r[6]) !== 'false' && text(r[6]) !== 'f',
    lastStatus: text(r[7]),
    lastStart: text(r[8]),
    lastEnd: text(r[9]),
    lastMessage: text(r[10])
  }))
}

export const cronJobLabel = (j: Pick<CronJob, 'id' | 'name'>): string => j.name ?? `job ${j.id}`

export function cronJobTooltip(j: CronJob): string {
  return [
    `Schedule: ${j.schedule}`,
    `Command: ${j.command}`,
    j.database && `Database: ${j.database}`,
    j.user && `User: ${j.user}`,
    `Active: ${j.active ? 'yes' : 'no'}`,
    j.lastStart
      ? `Last run: ${j.lastStatus ?? '?'} at ${j.lastStart}${j.lastMessage ? ` (${j.lastMessage})` : ''}`
      : 'Last run: never'
  ]
    .filter(Boolean)
    .join('\n')
}

/** The command dollar-quoted for readability; a plain literal when it has dollars of its own. */
const quoteCommand = (body: string): string => (body.includes('$') ? lit(body) : `$$${body}$$`)

/**
 * `cron.schedule` recreating the job; `cron.schedule_in_database` (pg_cron 1.4+)
 * when it runs in another database than pg_cron's, or is inactive.
 */
export function cronScheduleSql(j: CronJob, cronDatabase: string): string {
  const name = j.name ?? `job_${j.id}`
  const elsewhere = !!j.database && j.database !== cronDatabase
  if (elsewhere || !j.active)
    return `SELECT cron.schedule_in_database(${lit(name)}, ${lit(j.schedule)}, ${quoteCommand(j.command)}, ${lit(j.database ?? cronDatabase)}${j.user ? `, ${lit(j.user)}` : ', NULL'}, ${j.active});`
  return `SELECT cron.schedule(${j.name ? `${lit(j.name)}, ` : ''}${lit(j.schedule)}, ${quoteCommand(j.command)});`
}

export function cronUnscheduleSql(j: Pick<CronJob, 'id' | 'name'>): string {
  return `SELECT cron.unschedule(${j.id});${j.name ? ` -- ${j.name}` : ''}`
}

export function cronSetActiveSql(id: number, active: boolean): string {
  return `SELECT cron.alter_job(job_id := ${id}, active := ${active});`
}

export function cronHistorySql(id: number): string {
  return `SELECT runid, status, start_time, end_time, end_time - start_time AS duration, return_message, command
FROM cron.job_run_details
WHERE jobid = ${id}
ORDER BY start_time DESC NULLS LAST
LIMIT 100;`
}

export function cronJobTemplate(): string {
  return `-- Runs every 5 minutes (cron syntax, in the server's cron.timezone)
SELECT cron.schedule('new-job', '*/5 * * * *', $$DELETE FROM sessions WHERE expires_at < now()$$);`
}

/* ---------- Explorer queries ---------- */

/** Keyed under the database's catalog, so its Refresh reloads them. */
export const pgObjectQueries = {
  eventTriggers: (id: string, database: string) => ({
    queryKey: ['conn', id, 'catalog', database, 'eventTriggers'] as const,
    queryFn: async () => parseEventTriggers(await catalogRows(id, database, [EVENT_TRIGGERS_SQL]))
  }),
  foreignServers: (id: string, database: string) => ({
    queryKey: ['conn', id, 'catalog', database, 'foreignServers'] as const,
    queryFn: async () => parseForeignServers(await catalogRows(id, database, [FOREIGN_SERVERS_SQL]))
  }),
  /** The installed pg_cron version, or null */
  pgCron: (id: string, database: string) => ({
    queryKey: ['conn', id, 'catalog', database, 'pgCron'] as const,
    queryFn: async () => text((await catalogRows(id, database, [PG_CRON_SQL]))[0]?.[0]),
    staleTime: 60_000
  }),
  cronJobs: (id: string, database: string) => ({
    queryKey: ['conn', id, 'catalog', database, 'cronJobs'] as const,
    queryFn: async () => parseCronJobs(await catalogRows(id, database, CRON_JOBS_SQL))
  })
}
