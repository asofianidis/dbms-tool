import type { RoutineAttributes } from './api'

/** One attribute of a PostgreSQL routine, shown as a badge. */
export interface RoutineAttributeItem {
  label: string
  tone: 'neutral' | 'warning' | 'danger' | 'info'
  title: string
}

export const SECURITY_DEFINER_TITLE =
  "SECURITY DEFINER: the function runs with its owner's privileges, not the caller's. Anyone allowed to EXECUTE it gets the owner's rights for what it does, so check who can call it and pin its search_path."

/** The `search_path` the routine sets for itself, or null when it inherits the caller's. */
export function routineSearchPath(attrs: RoutineAttributes): string | null {
  const entry = attrs.config.find((c) => /^search_path=/i.test(c))
  return entry ? entry.slice(entry.indexOf('=') + 1) : null
}

/**
 * Why a SECURITY DEFINER routine's name resolution is unsafe, or null. Without
 * its own search_path, a caller can put a schema of theirs first and have the
 * function call their objects with the owner's privileges. Without pg_temp
 * listed last, the caller's temporary schema is searched first for tables.
 */
export function searchPathWarning(attrs: RoutineAttributes): string | null {
  if (!attrs.securityDefiner) return null
  const path = routineSearchPath(attrs)
  if (path === null) {
    return "SECURITY DEFINER without SET search_path: callers can shadow the tables and functions it uses with their own and run them with the owner's privileges. Add SET search_path = <trusted schemas>, pg_temp."
  }
  const schemas = path.split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
  if (schemas[schemas.length - 1] !== 'pg_temp') {
    return "search_path doesn't end with pg_temp, so the caller's temporary schema is searched first for tables. List pg_temp last."
  }
  return null
}

const VOLATILITY_TITLES: Record<RoutineAttributes['volatility'], string> = {
  IMMUTABLE: 'IMMUTABLE: same result for the same arguments forever; usable in indexes',
  STABLE: 'STABLE: same result for the same arguments within one statement',
  VOLATILE: 'VOLATILE: may return a different result on every call or change data'
}

const PARALLEL_TITLES: Record<RoutineAttributes['parallel'], string> = {
  SAFE: 'PARALLEL SAFE: can run in parallel workers',
  RESTRICTED: 'PARALLEL RESTRICTED: runs only in the parallel group leader',
  UNSAFE: 'PARALLEL UNSAFE: any query calling it runs without parallelism'
}

/**
 * The attributes worth showing for a routine. Procedures only have security
 * and SET options; the rest describe how the planner may call a function.
 */
export function routineAttributeItems(
  attrs: RoutineAttributes,
  kind: 'function' | 'procedure'
): RoutineAttributeItem[] {
  const items: RoutineAttributeItem[] = []
  if (attrs.securityDefiner) {
    items.push({
      label: 'SECURITY DEFINER',
      tone: searchPathWarning(attrs) ? 'danger' : 'warning',
      title: SECURITY_DEFINER_TITLE
    })
  }
  if (kind === 'function') {
    items.push({
      label: attrs.volatility,
      tone: 'neutral',
      title: VOLATILITY_TITLES[attrs.volatility]
    })
    if (attrs.strict) {
      items.push({
        label: 'STRICT',
        tone: 'neutral',
        title: 'STRICT: returns NULL without being called when any argument is NULL'
      })
    }
    items.push({
      label: `PARALLEL ${attrs.parallel}`,
      tone: 'neutral',
      title: PARALLEL_TITLES[attrs.parallel]
    })
    if (attrs.leakproof) {
      items.push({
        label: 'LEAKPROOF',
        tone: 'info',
        title:
          'LEAKPROOF: reveals nothing about its arguments except through its result, so the planner may push it below row-level security and security barrier views'
      })
    }
    items.push({
      label: `COST ${formatNumber(attrs.cost)}`,
      tone: 'neutral',
      title: 'Estimated execution cost, in units of cpu_operator_cost'
    })
    if (attrs.rows > 0) {
      items.push({
        label: `ROWS ${formatNumber(attrs.rows)}`,
        tone: 'neutral',
        title: 'Estimated number of rows the function returns'
      })
    }
  }
  for (const option of attrs.config) {
    const eq = option.indexOf('=')
    items.push({
      label: eq < 0 ? `SET ${option}` : `SET ${option.slice(0, eq)} = ${option.slice(eq + 1)}`,
      tone: 'info',
      title: 'Set for the duration of each call and restored afterwards'
    })
  }
  return items
}

const formatNumber = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2))
