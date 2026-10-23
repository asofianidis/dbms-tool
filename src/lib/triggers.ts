import type { TriggerInfo } from './api'
import type { Dialect } from './engines'
import { qualified, quoteIdent } from './sql'

export type TriggerTiming = 'BEFORE' | 'AFTER' | 'INSTEAD OF'
export type TriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'

/** The table or view a trigger is attached to. */
export interface TriggerTarget {
  schema: string | null
  table: string
  isView: boolean
}

export interface TriggerState {
  name: string
  timing: TriggerTiming
  events: TriggerEvent[]
  /** FOR EACH ROW; T-SQL triggers always run once per statement */
  rowLevel: boolean
  enabled: boolean
  /** PostgreSQL: UPDATE OF columns, empty for any column */
  updateColumns: string[]
  /** PostgreSQL WHEN condition, without the parentheses */
  condition: string
  /** PostgreSQL REFERENCING clause (transition tables), kept as written */
  referencing: string
  /** PostgreSQL trigger function and the arguments passed to it */
  functionSchema: string
  functionName: string
  functionArgs: string
  language: string
  /** T-SQL WITH options (EXECUTE AS, ENCRYPTION …) and NOT FOR REPLICATION, kept as written */
  withOptions: string
  notForReplication: boolean
  /** Function body (PostgreSQL) or trigger body (MySQL, T-SQL) */
  body: string
}

export interface TriggerDraft extends TriggerState {
  /** The trigger as loaded; null when creating one */
  original: TriggerState | null
  /** PostgreSQL: create a function for this trigger rather than use an existing one */
  newFunction: boolean
  /** PostgreSQL: the selected existing function's source, to tell whether the body was edited */
  loadedBody: string
}

/** Tables take triggers everywhere; views take INSTEAD OF triggers on PostgreSQL and SQL Server. */
export function canHaveTriggers(dialect: Dialect, kind: string): boolean {
  return kind === 'table' || (kind === 'view' && dialect !== 'mysql')
}

export function timingOptions(dialect: Dialect, target: TriggerTarget): TriggerTiming[] {
  if (dialect === 'mysql') return ['BEFORE', 'AFTER']
  if (target.isView) return ['INSTEAD OF']
  return dialect === 'tsql' ? ['AFTER', 'INSTEAD OF'] : ['BEFORE', 'AFTER']
}

export function eventOptions(dialect: Dialect, target: TriggerTarget): TriggerEvent[] {
  return dialect === 'postgres' && !target.isView
    ? ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']
    : ['INSERT', 'UPDATE', 'DELETE']
}

/** MySQL triggers fire on exactly one event. */
export const singleEvent = (dialect: Dialect): boolean => dialect === 'mysql'

function bodyTemplate(dialect: Dialect, timing: TriggerTiming): string {
  switch (dialect) {
    case 'postgres':
      return timing === 'AFTER'
        ? 'BEGIN\n  -- NEW and OLD hold the affected row\n  RETURN NULL;\nEND;'
        : 'BEGIN\n  -- NEW and OLD hold the affected row\n  RETURN NEW;\nEND;'
    case 'mysql':
      return 'BEGIN\n  -- NEW and OLD hold the affected row\nEND'
    case 'tsql':
      return 'BEGIN\n  SET NOCOUNT ON;\n  -- inserted and deleted hold the affected rows\nEND'
    case 'sqlite':
      return 'BEGIN\n  -- NEW and OLD hold the affected row\n  SELECT 1;\nEND'
  }
}

export function newTriggerDraft(dialect: Dialect, target: TriggerTarget): TriggerDraft {
  const timing = timingOptions(dialect, target)[0]
  return {
    name: '',
    timing,
    events: ['INSERT'],
    rowLevel: dialect !== 'tsql',
    enabled: true,
    updateColumns: [],
    condition: '',
    referencing: '',
    functionSchema: target.schema ?? '',
    functionName: '',
    functionArgs: '',
    language: 'plpgsql',
    withOptions: '',
    notForReplication: false,
    body: bodyTemplate(dialect, timing),
    original: null,
    newFunction: dialect === 'postgres',
    loadedBody: ''
  }
}

export function triggerDraftFrom(state: TriggerState): TriggerDraft {
  return { ...state, original: state, newFunction: false, loadedBody: state.body }
}

/** Catalog details of an existing PostgreSQL trigger that TriggerInfo doesn't carry. */
export interface PgTriggerDetails {
  functionSchema: string
  functionName: string
  language: string
  source: string
  updateColumns: string[]
  /** pg_get_triggerdef output, for the REFERENCING and WHEN clauses and the arguments */
  definition: string
}

export function pgTriggerState(info: TriggerInfo, details: PgTriggerDetails): TriggerState {
  const def = details.definition
  return {
    name: info.name,
    timing: info.timing as TriggerTiming,
    events: info.events as TriggerEvent[],
    rowLevel: info.rowLevel,
    enabled: info.enabled,
    updateColumns: details.updateColumns,
    condition: /\bWHEN\s+\((.*)\)\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\b/is.exec(def)?.[1] ?? '',
    referencing: /\b(REFERENCING\s+.*?)\s+FOR\s+EACH\b/is.exec(def)?.[1] ?? '',
    functionSchema: details.functionSchema,
    functionName: details.functionName,
    functionArgs: /\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+.*?\((.*)\)\s*$/is.exec(def)?.[1] ?? '',
    language: details.language,
    withOptions: '',
    notForReplication: false,
    body: details.source
  }
}

const TSQL_NAME = String.raw`(?:\[(?:[^\]]|\]\])*\]|"(?:[^"]|"")*"|[^\s.\[]+)`

const TSQL_HEADER =
  /\b(FOR|AFTER|INSTEAD\s+OF)\s+((?:INSERT|UPDATE|DELETE)(?:\s*,\s*(?:INSERT|UPDATE|DELETE))*)(\s+WITH\s+APPEND)?(\s+NOT\s+FOR\s+REPLICATION)?\s+AS\b\s*/i

/** Splits a T-SQL CREATE TRIGGER definition into its header clauses and body; null if it can't. */
export function tsqlTriggerState(info: TriggerInfo): TriggerState | null {
  const def = info.definition
  if (!def) return null
  // Mask comments and strings so header keywords inside them don't match
  const masked = def
    .replace(/--[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length))
  const match = TSQL_HEADER.exec(masked)
  if (!match) return null
  const header = masked.slice(0, match.index)
  const withClause = new RegExp(
    `\\bON\\s+${TSQL_NAME}(?:\\s*\\.\\s*${TSQL_NAME})*\\s+WITH\\s+`,
    'i'
  ).exec(header)
  return {
    name: info.name,
    timing: info.timing as TriggerTiming,
    events: info.events as TriggerEvent[],
    rowLevel: false,
    enabled: info.enabled,
    updateColumns: [],
    condition: '',
    referencing: '',
    functionSchema: '',
    functionName: '',
    functionArgs: '',
    language: '',
    withOptions: withClause
      ? def.slice(withClause.index + withClause[0].length, header.length).trim()
      : '',
    notForReplication: !!match[4],
    body: def.slice(match.index + match[0].length).trimEnd()
  }
}

export function mysqlTriggerState(info: TriggerInfo, body: string): TriggerState {
  return {
    name: info.name,
    timing: info.timing as TriggerTiming,
    events: info.events as TriggerEvent[],
    rowLevel: true,
    enabled: true,
    updateColumns: [],
    condition: '',
    referencing: '',
    functionSchema: '',
    functionName: '',
    functionArgs: '',
    language: '',
    withOptions: '',
    notForReplication: false,
    body
  }
}

export function defaultFunctionName(draft: TriggerDraft, target: TriggerTarget): string {
  return `${target.table}_${draft.name.trim() || 'trigger'}_fn`
}

/** Function body languages whose source is SQL text that can be edited and recreated. */
export const editableLanguage = (language: string): boolean => !['c', 'internal'].includes(language)

export function validateTrigger(dialect: Dialect, draft: TriggerDraft): string | null {
  if (!draft.name.trim()) return 'Name the trigger'
  if (!draft.events.length) return 'Pick at least one event'
  if (dialect === 'postgres') {
    if (draft.events.includes('TRUNCATE') && draft.rowLevel)
      return 'TRUNCATE triggers must run per statement'
    if (draft.timing === 'INSTEAD OF' && !draft.rowLevel)
      return 'INSTEAD OF triggers must run for each row'
    if (draft.timing === 'INSTEAD OF' && draft.condition.trim())
      return "INSTEAD OF triggers can't have a WHEN condition"
    if (!draft.newFunction && !draft.functionName) return 'Pick a trigger function'
  }
  if (!draft.body.trim() && (dialect !== 'postgres' || editableLanguage(draft.language)))
    return dialect === 'postgres' ? 'Write the function body' : 'Write the trigger body'
  return null
}

/** Dollar-quotes a PostgreSQL function body with a tag that doesn't occur in it. */
export function dollarQuote(body: string): string {
  let tag = '$$'
  for (let i = 0; body.includes(tag); i++) tag = `$fn${i || ''}$`
  return `${tag}\n${body.trim()}\n${tag}`
}

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** Strips trailing semicolons, which ddlScript adds back. */
const statementBody = (body: string): string => body.trim().replace(/[;\s]+$/, '')

export function triggerStatements(
  dialect: Dialect,
  draft: TriggerDraft,
  target: TriggerTarget
): string[] {
  const q = (name: string): string => quoteIdent(dialect, name)
  const table = qualified(dialect, { schema: target.schema, name: target.table })
  const name = draft.name.trim()
  const was = draft.original

  if (dialect === 'postgres') {
    const fn = qualified(dialect, {
      schema: draft.newFunction ? target.schema : draft.functionSchema || null,
      name: draft.newFunction
        ? draft.functionName.trim() || defaultFunctionName(draft, target)
        : draft.functionName
    })
    const events = draft.events
      .map((e) =>
        e === 'UPDATE' && draft.updateColumns.length
          ? `UPDATE OF ${draft.updateColumns.map(q).join(', ')}`
          : e
      )
      .join(' OR ')
    const create = [
      `CREATE TRIGGER ${q(name)}`,
      `${draft.timing} ${events}`,
      `ON ${table}`,
      draft.referencing,
      `FOR EACH ${draft.rowLevel ? 'ROW' : 'STATEMENT'}`,
      draft.condition.trim() && `WHEN (${draft.condition.trim()})`,
      `EXECUTE FUNCTION ${fn}(${draft.functionArgs.trim()})`
    ]
      .filter(Boolean)
      .join('\n')
    const toggle = (enabled: boolean): string =>
      `ALTER TABLE ${table} ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${q(name)}`
    const statements: string[] = []
    if (
      draft.newFunction ||
      (draft.body !== draft.loadedBody && editableLanguage(draft.language))
    ) {
      statements.push(
        `CREATE OR REPLACE FUNCTION ${fn}()\nRETURNS trigger\nLANGUAGE ${draft.newFunction ? 'plpgsql' : draft.language}\nAS ${dollarQuote(draft.body)}`
      )
    }
    if (!was) {
      statements.push(create)
      if (!draft.enabled) statements.push(toggle(false))
      return statements
    }
    const recreate =
      draft.timing !== was.timing ||
      !sameList(draft.events, was.events) ||
      draft.rowLevel !== was.rowLevel ||
      !sameList(draft.updateColumns, was.updateColumns) ||
      draft.condition.trim() !== was.condition ||
      draft.newFunction ||
      draft.functionSchema !== was.functionSchema ||
      draft.functionName !== was.functionName ||
      draft.functionArgs.trim() !== was.functionArgs
    if (recreate) {
      statements.push(`DROP TRIGGER ${q(was.name)} ON ${table}`, create)
      if (!draft.enabled) statements.push(toggle(false))
    } else {
      if (name !== was.name)
        statements.push(`ALTER TRIGGER ${q(was.name)} ON ${table} RENAME TO ${q(name)}`)
      if (draft.enabled !== was.enabled) statements.push(toggle(draft.enabled))
    }
    return statements
  }

  if (dialect === 'mysql') {
    const create = `CREATE TRIGGER ${q(name)}\n${draft.timing} ${draft.events[0]} ON ${table}\nFOR EACH ROW\n${statementBody(draft.body)}`
    if (!was) return [create]
    const changed =
      name !== was.name ||
      draft.timing !== was.timing ||
      !sameList(draft.events, was.events) ||
      statementBody(draft.body) !== statementBody(was.body)
    // MySQL has no ALTER TRIGGER
    return changed ? [`DROP TRIGGER ${q(was.name)}`, create] : []
  }

  // T-SQL: a trigger lives in its table's schema
  const schema = target.schema ?? 'dbo'
  const ref = (n: string): string => `${q(schema)}.${q(n)}`
  const header = (verb: 'CREATE' | 'ALTER'): string =>
    [
      `${verb} TRIGGER ${ref(name)}`,
      `ON ${table}`,
      draft.withOptions && `WITH ${draft.withOptions}`,
      `${draft.timing} ${draft.events.join(', ')}`,
      draft.notForReplication && 'NOT FOR REPLICATION',
      'AS',
      statementBody(draft.body)
    ]
      .filter(Boolean)
      .join('\n')
  const toggle = (enabled: boolean): string =>
    `${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${ref(name)} ON ${table}`
  if (!was) return draft.enabled ? [header('CREATE')] : [header('CREATE'), toggle(false)]
  const renamed = name !== was.name
  const changed =
    draft.timing !== was.timing ||
    !sameList(draft.events, was.events) ||
    statementBody(draft.body) !== statementBody(was.body)
  const statements: string[] = []
  // sp_rename leaves the old name in the stored definition, so a rename recreates the trigger
  if (renamed) statements.push(`DROP TRIGGER ${ref(was.name)}`, header('CREATE'))
  else if (changed) statements.push(header('ALTER'))
  if (draft.enabled !== was.enabled || ((renamed || changed) && !draft.enabled))
    statements.push(toggle(draft.enabled))
  return statements
}

export function dropTriggerStatement(
  dialect: Dialect,
  name: string,
  target: TriggerTarget
): string {
  const q = (n: string): string => quoteIdent(dialect, n)
  switch (dialect) {
    case 'postgres':
      return `DROP TRIGGER ${q(name)} ON ${qualified(dialect, { schema: target.schema, name: target.table })}`
    case 'mysql':
      return `DROP TRIGGER ${q(name)}`
    case 'tsql':
      return `DROP TRIGGER ${q(target.schema ?? 'dbo')}.${q(name)}`
    case 'sqlite':
      // Trigger names are unique per database in SQLite
      return `DROP TRIGGER ${q(name)}`
  }
}
