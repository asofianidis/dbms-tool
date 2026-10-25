/**
 * MariaDB sequences (10.3+). MySQL has none; on MariaDB they're listed with kind 'sequence'.
 * A sequence is also a one-row table: `SELECT * FROM seq` reads its state.
 */
import type { ExecOutput } from './api'
import { qualified, type TableRef } from './sql'

/** A sequence's state, as `SELECT * FROM seq` returns it. Numbers stay text, as they're 64-bit. */
export interface SequenceState {
  /** The next value not yet handed to a session's cache */
  nextNotCached: string
  minimum: string
  maximum: string
  start: string
  increment: string
  cache: string
  cycle: boolean
  /** How many times the sequence has wrapped around */
  cycleCount: string
}

export const sequenceStateSql = (ref: TableRef): string =>
  `SELECT * FROM ${qualified('mysql', ref)}`

/** Reads the state from the result of `sequenceStateSql`; null when there's no such row. */
export function parseSequenceState(out: ExecOutput): SequenceState | null {
  const set = out.results[0]
  const row = set?.rows[0]
  if (!set || !row) return null
  const get = (name: string): string => {
    const i = set.columns.findIndex((c) => c.name.toLowerCase() === name)
    const value = i < 0 ? null : row[i]
    return value == null ? '' : String(value)
  }
  return {
    nextNotCached: get('next_not_cached_value'),
    minimum: get('minimum_value'),
    maximum: get('maximum_value'),
    start: get('start_value'),
    increment: get('increment'),
    cache: get('cache_size'),
    cycle: get('cycle_option') === '1' || get('cycle_option') === 'true',
    cycleCount: get('cycle_count')
  }
}

/** Starter code for a new sequence. */
export function sequenceTemplate(): string {
  return `CREATE SEQUENCE new_sequence
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  MAXVALUE 9223372036854775806
  CACHE 1000
  NOCYCLE;`
}

export type SequenceScript = 'nextval' | 'setval' | 'alter' | 'restart'

/** Scripts for using and changing a sequence; SETVAL, ALTER and RESTART start from its state. */
export function sequenceScript(
  kind: SequenceScript,
  ref: TableRef,
  state: SequenceState | null
): string {
  const target = qualified('mysql', ref)
  switch (kind) {
    case 'nextval':
      return `SELECT NEXTVAL(${target});`
    case 'setval':
      return `-- The next value handed out follows this one
SELECT SETVAL(${target}, ${state?.nextNotCached || 1});`
    case 'restart':
      return `ALTER SEQUENCE ${target} RESTART WITH ${state?.start || 1};`
    case 'alter':
      return state
        ? `ALTER SEQUENCE ${target}
  INCREMENT BY ${state.increment}
  MINVALUE ${state.minimum}
  MAXVALUE ${state.maximum}
  CACHE ${state.cache}
  ${state.cycle ? 'CYCLE' : 'NOCYCLE'};`
        : `ALTER SEQUENCE ${target}
  INCREMENT BY 1;`
  }
}

interface SequenceDdl {
  /** The `AS` type, when not the default bigint */
  type: string | null
  /** `start with … cycle`, which ALTER SEQUENCE takes as is */
  options: string
}

/** Splits `SHOW CREATE SEQUENCE` output into its type and options, leaving out the table options. */
export function parseSequenceDdl(ddl: string): SequenceDdl | null {
  const m =
    /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`(?:[^`]|``)+`|[\w$]+)(?:\.(?:`(?:[^`]|``)+`|[\w$]+))?\s+(?:AS\s+(.+?)\s+)?(START\s+WITH\b[\s\S]*?\b(?:NO)?CYCLE)\b/i.exec(
      ddl
    )
  if (!m) return null
  return { type: m[1]?.trim() ?? null, options: m[2].replace(/\s+/g, ' ') }
}

/**
 * Statements that change the target sequence to the source's definition without recreating it,
 * which would restart it. MariaDB won't change the type in the same statement as the options.
 * Null when either definition can't be read, so the caller recreates it instead.
 */
export function sequenceAlterStatements(
  target: string,
  sourceDdl: string,
  targetDdl: string | null | undefined
): string[] | null {
  const source = parseSequenceDdl(sourceDdl)
  const current = targetDdl ? parseSequenceDdl(targetDdl) : null
  if (!source || !current) return null
  const statements: string[] = []
  const type = (d: SequenceDdl): string => (d.type ?? 'bigint').toLowerCase()
  if (type(source) !== type(current))
    statements.push(`ALTER SEQUENCE ${target} AS ${source.type ?? 'bigint'}`)
  if (source.options.toLowerCase() !== current.options.toLowerCase())
    statements.push(`ALTER SEQUENCE ${target} ${source.options}`)
  return statements
}
