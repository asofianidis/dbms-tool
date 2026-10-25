import type { ExecOutput } from './api'
import { blankNode, buildPlan, type Parsed, type Plan, type PlanNode, type RawHint } from './plan'

/**
 * MariaDB `EXPLAIN FORMAT=JSON` and `ANALYZE FORMAT=JSON` read into the same plan model
 * the other engines use. MariaDB lists the tables of a join in order under `nested_loop`
 * and wraps them in the steps that consume them (`filesort`, `temporary_table`, …);
 * ANALYZE adds `r_*` members with what really happened.
 */

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

const ACCESS: Record<string, string> = {
  ALL: 'Table scan',
  index: 'Index scan',
  range: 'Index range scan',
  ref: 'Index lookup',
  eq_ref: 'Unique key lookup',
  ref_or_null: 'Index lookup or NULL',
  const: 'Constant row',
  system: 'Constant row',
  index_merge: 'Index merge',
  fulltext: 'Full-text search',
  unique_subquery: 'Unique subquery lookup',
  index_subquery: 'Index subquery lookup',
  hash_ALL: 'Hash table scan',
  hash_index: 'Hash index scan',
  hash_range: 'Hash range scan',
  hash_index_merge: 'Hash index merge'
}

/**
 * Reads the whole table or index, and so could use a better index. A hash join's scans
 * (`hash_ALL`) are left out: they build the hash table once per join buffer on purpose.
 */
const FULL_SCANS = new Set(['ALL', 'index'])

const JOIN_BUFFERS: Record<string, string> = {
  BNL: 'Block nested loop',
  BNLH: 'Hash join',
  BKA: 'Batched key access',
  BKAH: 'Batched key access (hash)'
}

/** Members whose value is a step of the plan rather than a property of its holder */
const STEPS = new Set([
  'query_block',
  'table',
  'block-nl-join',
  'nested_loop',
  'duplicates_removal',
  'filesort',
  'temporary_table',
  'read_sorted_file',
  'union_result',
  'query_specifications',
  'subqueries',
  'materialized',
  'subquery_cache',
  'expression_cache',
  'window_functions_computation',
  'sorts',
  'range-checked-for-each-record'
])

const OPS: Record<string, string> = {
  duplicates_removal: 'Duplicate weedout',
  filesort: 'Sort',
  temporary_table: 'Temporary table',
  read_sorted_file: 'Read sorted file',
  union_result: 'Union result',
  materialized: 'Materialize',
  subquery_cache: 'Subquery cache',
  expression_cache: 'Subquery cache',
  window_functions_computation: 'Window functions',
  'range-checked-for-each-record': 'Range checked for each record'
}

/** Reads the plans out of an EXPLAIN/ANALYZE FORMAT=JSON run, or null when there are none. */
export function parseMariaDbPlan(output: ExecOutput): Plan | null {
  const docs = output.results.flatMap((set) =>
    set.rows.flatMap((row) =>
      row.filter((c): c is string => typeof c === 'string' && /^\s*\{/.test(c))
    )
  )
  let parsed: Parsed
  try {
    parsed = parseMariaDbJson(docs)
  } catch {
    return null
  }
  if (!parsed.trees.length) return null
  return buildPlan('mariadb-json', parsed)
}

export function parseMariaDbJson(docs: string[]): Parsed {
  const parsed: Required<Parsed> = { trees: [], planningMs: null, executionMs: null, hints: [] }
  for (const text of docs) {
    const doc: unknown = JSON.parse(text)
    if (!isObj(doc) || !isObj(doc.query_block)) continue
    const ctx: Context = { hints: parsed.hints }
    const root = blockNode(doc.query_block, ctx)
    const planning = isObj(doc.query_optimization)
      ? num(doc.query_optimization.r_total_time_ms)
      : null
    if (planning != null) parsed.planningMs = (parsed.planningMs ?? 0) + planning
    if (root.timeMs != null) parsed.executionMs = (parsed.executionMs ?? 0) + root.timeMs
    parsed.trees.push({ label: null, root, timeMs: root.timeMs })
  }
  return parsed
}

interface Context {
  hints: RawHint[]
  /** Inside a join buffer, where the table is read once per buffer fill, not per outer row */
  buffered?: boolean
}

/** The steps a member of the plan holds, in the order MariaDB lists them. */
function steps(holder: Json, ctx: Context): PlanNode[] {
  const out: PlanNode[] = []
  for (const [key, value] of Object.entries(holder))
    if (STEPS.has(key)) out.push(...step(key, value, ctx))
  return out
}

function step(key: string, value: unknown, ctx: Context): PlanNode[] {
  const list = (v: unknown): PlanNode[] =>
    (Array.isArray(v) ? v : [v]).filter(isObj).flatMap((item) => steps(item, ctx))
  switch (key) {
    case 'query_block':
      return isObj(value) ? [blockNode(value, ctx)] : []
    case 'table':
      return isObj(value) ? [tableNode(value, ctx)] : []
    case 'block-nl-join':
      return isObj(value) ? [joinBufferNode(value, ctx)] : []
    case 'nested_loop': {
      const tables = list(value)
      if (tables.length < 2) return tables
      const n = blankNode('Nested loop')
      n.children = tables
      // What the join produces is what its last table passes on
      n.actualRows = tables[tables.length - 1].actualRows
      rollUp(n, null, null, false)
      return [n]
    }
    case 'query_specifications':
    case 'sorts':
      return list(value)
    case 'subqueries':
      return list(value).map((n) => {
        n.label ??= 'Subquery'
        return n
      })
    case 'duplicates_removal': {
      const n = blankNode(OPS[key])
      n.children = list(value)
      rollUp(n, null, null, false)
      return [n]
    }
    default:
      return isObj(value) ? [stepNode(key, value, ctx)] : []
  }
}

/** Members that aren't steps, flattened for the inspector. */
function props(raw: Json, prefix = ''): [string, string][] {
  const out: [string, string][] = []
  for (const [key, value] of Object.entries(raw)) {
    if (STEPS.has(key) || value == null) continue
    if (isObj(value)) out.push(...props(value, `${prefix}${key}.`))
    else if (Array.isArray(value)) {
      if (value.every((v) => !isObj(v))) out.push([prefix + key, value.map(String).join(', ')])
    } else out.push([prefix + key, String(value)])
  }
  return out
}

/**
 * Fills in cost and time from the steps under `n`. `inclusive` own numbers already
 * cover them (a query block's total); otherwise they're the step's own share and add up.
 */
function rollUp(n: PlanNode, cost: number | null, ms: number | null, inclusive: boolean): void {
  const sum = (pick: (c: PlanNode) => number | null): number | null =>
    n.children.reduce<number | null>((s, c) => {
      const v = pick(c)
      return v == null ? s : (s ?? 0) + v
    }, null)
  const merge = (own: number | null, kids: number | null): number | null =>
    own == null ? kids : kids == null ? own : inclusive ? Math.max(own, kids) : own + kids
  n.cost = merge(
    cost,
    sum((c) => c.cost)
  )
  n.timeMs = merge(
    ms,
    sum((c) => c.timeMs)
  )
}

function blockNode(raw: Json, ctx: Context): PlanNode {
  const id = num(raw.select_id)
  const n = blankNode(id != null ? `Query block #${id}` : 'Query block')
  n.label = str(raw.operation)
  n.loops = num(raw.r_loops)
  n.props = props(raw)
  n.children = steps(raw, ctx)
  // The block above a UNION only holds its result
  if (id == null && n.children.length === 1 && !n.props.length) return n.children[0]
  rollUp(n, num(raw.cost), num(raw.r_total_time_ms), true)
  return n
}

function tableNode(raw: Json, ctx: Context): PlanNode {
  const access = str(raw.access_type)
  const name = str(raw.table_name)
  const key = str(raw.key)
  let op = access ? (ACCESS[access] ?? access) : (str(raw.message) ?? 'Table')
  if (raw.using_index === true && /^(Index|Unique key)/.test(op))
    op = `Covering ${op.charAt(0).toLowerCase()}${op.slice(1)}`
  const n = blankNode(op)
  n.label = raw.delete ? 'DELETE' : raw.update ? 'UPDATE' : null
  n.target = name ? (key ? `${name} using ${key}` : name) : null
  // `<derived2>`, `<subquery2>`, `<union1,2>` are MariaDB's own work tables
  n.relation = name && !name.startsWith('<') ? name : null
  n.fullScan = !!access && FULL_SCANS.has(access) && !!n.relation
  n.filter = str(raw.attached_condition)
  // A hash join's `filtered` is the share of hash matches, not of the condition
  const hashed = !!access?.startsWith('hash_')
  const rows = num(raw.rows)
  const filtered = hashed ? 100 : (num(raw.filtered) ?? 100)
  if (rows != null) n.estRows = (rows * filtered) / 100
  if (!ctx.buffered) n.estLoops = num(raw.loops)

  // Single-table UPDATE and DELETE report r_rows without r_loops
  const loops = num(raw.r_loops) ?? ('r_rows' in raw ? 1 : null)
  let ms: number | null = null
  if (loops != null) {
    n.loops = loops
    const read = (num(raw.r_rows) ?? 0) * loops
    const kept = hashed ? read : (read * (num(raw.r_filtered) ?? 100)) / 100
    n.actualRows = kept
    if (n.filter) n.rowsRemoved = Math.max(0, read - kept)
    const table = num(raw.r_table_time_ms)
    const other = num(raw.r_other_time_ms)
    ms = table != null || other != null ? (table ?? 0) + (other ?? 0) : num(raw.r_total_time_ms)
  }
  n.props = props(raw)
  n.children = steps(raw, { ...ctx, buffered: false })
  rollUp(n, num(raw.cost), ms, false)
  return n
}

function joinBufferNode(raw: Json, ctx: Context): PlanNode {
  const type = str(raw.join_type)
  const n = blankNode((type && JOIN_BUFFERS[type]) ?? 'Join buffer')
  n.filter = str(raw.attached_condition)
  n.props = props(raw)
  n.children = steps(raw, { ...ctx, buffered: true })
  n.target = n.children[0]?.target ?? null
  const loops = num(raw.r_loops)
  let ms: number | null = null
  if (loops != null) {
    n.loops = loops
    const read = loops * (num(raw.r_effective_rows) ?? 0)
    n.actualRows = (read * (num(raw.r_filtered) ?? 100)) / 100
    if (n.filter) n.rowsRemoved = Math.max(0, read - n.actualRows)
    ms = (num(raw.r_unpack_time_ms) ?? 0) + (num(raw.r_other_time_ms) ?? 0)
  }
  rollUp(n, null, ms, false)
  const inner = n.children[0]
  // A hash join or batched key access still uses the join condition; a plain block
  // nested loop compares every buffered row with every row of the table
  if (type === 'BNL' && inner)
    ctx.hints.push({
      severity: 'medium',
      node: inner,
      title: `${inner.target ?? 'A table'} is joined without an index`,
      detail: `MariaDB buffers rows from the tables before it and compares each one with every row of ${inner.target ?? 'the table'} (block nested loop)${n.filter ? `, checking ${n.filter}` : ''}. An index on the join columns would let it look the matching rows up instead.`
    })
  return n
}

/** Sorts, temporary tables, materializations and the other steps that wrap their input. */
function stepNode(key: string, raw: Json, ctx: Context): PlanNode {
  const n = blankNode(OPS[key] ?? key)
  n.props = props(raw)
  n.children = steps(raw, ctx)
  let ms: number | null = null
  let inclusive = false
  if (key === 'filesort') {
    n.target = str(raw.sort_key)
    n.loops = num(raw.r_loops)
    if (n.loops != null) n.actualRows = num(raw.r_output_rows)
    ms = num(raw.r_total_time_ms)
    // Sorting a temporary table starts once it's filled; sorting a table reads it as it goes
    inclusive = !n.children.some((c) => c.op === 'Temporary table')
    const passes = num(raw.r_sort_passes)
    if (passes)
      n.warnings.push(
        `Sort spilled to disk (${passes} merge passes, ${str(raw.r_buffer_size) ?? '?'} buffer)`
      )
  } else if (key === 'read_sorted_file') {
    n.actualRows = num(raw.r_rows)
  } else if (key === 'union_result') {
    n.target = str(raw.table_name)
    const loops = num(raw.r_loops)
    if (loops != null) n.actualRows = (num(raw.r_rows) ?? 0) * loops
  } else if (key === 'subquery_cache' || key === 'expression_cache') {
    n.target = str(raw.state)
  }
  rollUp(n, null, ms, inclusive)
  return n
}
