import { toShell } from './ejson'
import { shellCollection } from './mongo-shell'
import {
  blankNode,
  buildPlan,
  walkPlan,
  type Plan,
  type PlanNode,
  type PlanTree,
  type RawHint
} from './plan'

/**
 * MongoDB `explain` output (find or aggregate, classic or slot-based engine,
 * replica set or sharded) read into the same plan model the SQL engines use.
 */

type Json = Record<string, unknown>

export interface MongoExplainContext {
  collection: string
  /** The query's filter and sort, for the suggested index */
  filter?: unknown
  sort?: unknown
}

const STAGE_NAMES: Record<string, string> = {
  COLLSCAN: 'Collection Scan',
  IXSCAN: 'Index Scan',
  EXPRESS_IXSCAN: 'Express Index Scan',
  EXPRESS_CLUSTERED_IXSCAN: 'Express Clustered Scan',
  CLUSTERED_IXSCAN: 'Clustered Index Scan',
  IDHACK: 'Id Lookup',
  FETCH: 'Fetch',
  SORT: 'Sort',
  SORT_MERGE: 'Sort Merge',
  SORT_KEY_GENERATOR: 'Sort Key Generator',
  PROJECTION_SIMPLE: 'Projection',
  PROJECTION_DEFAULT: 'Projection',
  PROJECTION_COVERED: 'Covered Projection',
  LIMIT: 'Limit',
  SKIP: 'Skip',
  OR: 'Or',
  AND_HASH: 'And (Hash)',
  AND_SORTED: 'And (Sorted)',
  SHARDING_FILTER: 'Sharding Filter',
  SHARD_MERGE: 'Shard Merge',
  SINGLE_SHARD: 'Single Shard',
  COUNT: 'Count',
  COUNT_SCAN: 'Count Scan',
  DISTINCT_SCAN: 'Distinct Scan',
  TEXT_MATCH: 'Text Match',
  TEXT_OR: 'Text Or',
  GEO_NEAR_2D: 'Geo Near',
  GEO_NEAR_2DSPHERE: 'Geo Near',
  GROUP: 'Group',
  EOF: 'Empty Result',
  BATCHED_DELETE: 'Batched Delete',
  UPDATE: 'Update',
  DELETE: 'Delete'
}

const SCAN_STAGES = new Set(['COLLSCAN', 'IXSCAN', 'EXPRESS_IXSCAN', 'CLUSTERED_IXSCAN', 'IDHACK'])

/** Keys that hold child stages or are shown some other way. */
const STRUCTURAL = new Set([
  'stage',
  'inputStage',
  'inputStages',
  'shards',
  'queryPlan',
  'slotBasedPlan',
  'filter',
  'nReturned',
  'executionTimeMillisEstimate',
  'executionTimeMillis',
  'indexName',
  'keyPattern'
])

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v && typeof v === 'object') {
    const o = v as Json
    const inner = o.$numberLong ?? o.$numberInt ?? o.$numberDouble
    if (inner != null && Number.isFinite(Number(inner))) return Number(inner)
  }
  return null
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function humanize(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function stageLabel(stage: string): string {
  return (
    STAGE_NAMES[stage] ??
    stage
      .toLowerCase()
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  )
}

function short(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Classic stages are upper case; the slot-based engine's execution tree isn't. */
function isClassic(s: unknown): s is Json {
  return isObject(s) && typeof s.stage === 'string' && s.stage === s.stage.toUpperCase()
}

interface Ctx extends MongoExplainContext {
  /** Winning plans per shard, for shards whose execution tree is slot-based */
  shardPlans: Map<string, Json>
}

function applyStats(n: PlanNode, s: Json): void {
  const returned = num(s.nReturned)
  if (returned != null) {
    n.actualRows = returned
    n.loops = 1
  }
  n.timeMs = num(s.executionTimeMillisEstimate) ?? num(s.executionTimeMillis) ?? n.timeMs
}

function stageNode(s: Json, ctx: Ctx): PlanNode {
  const stage = String(s.stage)
  const n = blankNode(stageLabel(stage))
  n.props.push(['Stage', stage])
  if (SCAN_STAGES.has(stage)) n.relation = ctx.collection
  if (stage === 'COLLSCAN') {
    n.fullScan = true
    n.target = ctx.collection
  }
  if (typeof s.indexName === 'string') n.target = s.indexName
  if (s.keyPattern) n.props.push(['Key pattern', toShell(s.keyPattern, 0)])
  if (s.filter) n.filter = short(toShell(s.filter, 0))
  applyStats(n, s)
  const examined =
    num(s.docsExamined) ?? (SCAN_STAGES.has(stage) ? num(s.keysExamined) : null) ?? null
  if (examined != null && n.actualRows != null && examined > n.actualRows)
    n.rowsRemoved = examined - n.actualRows
  if (s.usedDisk === true) n.warnings.push('Sort spilled to disk')
  for (const [k, v] of Object.entries(s)) {
    if (STRUCTURAL.has(k) || v === undefined) continue
    const text = isObject(v) || Array.isArray(v) ? toShell(v, 0) : String(v)
    n.props.push([humanize(k), short(text)])
  }
  if (isObject(s.inputStage)) n.children.push(childNode(s.inputStage, ctx))
  if (Array.isArray(s.inputStages))
    for (const c of s.inputStages) if (isObject(c)) n.children.push(childNode(c, ctx))
  if (Array.isArray(s.shards))
    for (const c of s.shards) if (isObject(c)) n.children.push(shardNode(c, ctx))
  return n
}

function childNode(s: Json, ctx: Ctx): PlanNode {
  return typeof s.stage === 'string' ? stageNode(s, ctx) : blankNode('Unknown')
}

/** One shard's part of a SHARD_MERGE, from queryPlanner or executionStats. */
function shardNode(s: Json, ctx: Ctx): PlanNode {
  const name = String(s.shardName ?? 'shard')
  const n = blankNode(`Shard ${name}`)
  n.target = name
  applyStats(n, s)
  for (const k of ['totalDocsExamined', 'totalKeysExamined'] as const)
    if (num(s[k]) != null) n.props.push([humanize(k), String(num(s[k]))])
  const stages = isClassic(s.executionStages)
    ? s.executionStages
    : winning(isObject(s.winningPlan) ? s.winningPlan : ctx.shardPlans.get(name))
  if (stages) n.children.push(stageNode(stages, ctx))
  return n
}

/** The stage tree inside a winning plan, which the slot-based engine nests under `queryPlan`. */
function winning(plan: unknown): Json | null {
  if (!isObject(plan)) return null
  if (isObject(plan.queryPlan)) return plan.queryPlan
  return typeof plan.stage === 'string' ? plan : null
}

interface Totals {
  returned: number | null
  docsExamined: number | null
  keysExamined: number | null
  timeMs: number | null
}

/** A find-shaped explain: queryPlanner plus, with executionStats verbosity, measured numbers. */
function findTree(v: Json, ctx: Ctx): { root: PlanNode; totals: Totals } | null {
  const qp = isObject(v.queryPlanner) ? v.queryPlanner : null
  const es = isObject(v.executionStats) ? v.executionStats : null
  const wp = qp && isObject(qp.winningPlan) ? qp.winningPlan : null
  if (wp && Array.isArray(wp.shards))
    for (const s of wp.shards)
      if (isObject(s) && typeof s.shardName === 'string') ctx.shardPlans.set(s.shardName, s)
  const totals: Totals = {
    returned: num(es?.nReturned),
    docsExamined: num(es?.totalDocsExamined),
    keysExamined: num(es?.totalKeysExamined),
    timeMs: num(es?.executionTimeMillis)
  }
  let root: PlanNode
  if (isClassic(es?.executionStages)) {
    root = stageNode(es.executionStages, ctx)
  } else {
    const plan = winning(wp)
    if (!plan) return null
    root = stageNode(plan, ctx)
    // Slot-based execution stats don't line up with the plan's stages; show the totals on
    // top. The time stays on the plan, since charging it all to one step would mislead
    if (es) {
      if (totals.returned != null) {
        root.actualRows = totals.returned
        root.loops = 1
      }
      if (totals.docsExamined != null)
        root.props.push(['Docs examined', String(totals.docsExamined)])
      if (totals.keysExamined != null)
        root.props.push(['Keys examined', String(totals.keysExamined)])
    }
  }
  return { root, totals }
}

/** An aggregate explain: `stages` with a `$cursor` at the bottom, or a whole find-shaped plan. */
function aggregateTree(v: Json, ctx: Ctx): { root: PlanNode; totals: Totals } | null {
  if (!Array.isArray(v.stages)) return findTree(v, ctx)
  let child: PlanNode | null = null
  let totals: Totals = { returned: null, docsExamined: null, keysExamined: null, timeMs: null }
  for (const st of v.stages) {
    if (!isObject(st)) continue
    const key = Object.keys(st).find((k) => k.startsWith('$'))
    if (!key) continue
    if (key === '$cursor' && isObject(st.$cursor)) {
      const found = findTree(st.$cursor, ctx)
      if (found) {
        child = found.root
        totals = found.totals
      }
      continue
    }
    const n = blankNode(key)
    n.target = short(toShell(st[key], 0), 80)
    n.props.push(['Stage', short(toShell(st[key], 0))])
    applyStats(n, st)
    if (child) n.children.push(child)
    child = n
  }
  return child ? { root: child, totals } : null
}

/* ---------- Hints ---------- */

const RANGE_OPS = new Set([
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$ne',
  '$nin',
  '$regex',
  '$exists',
  '$not'
])

/** Filter fields split by the equality, sort, range rule. */
function filterFields(filter: unknown, eq: string[], range: string[]): void {
  if (!isObject(filter)) return
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' && Array.isArray(v)) v.forEach((f) => filterFields(f, eq, range))
    if (k.startsWith('$')) continue
    const ops = isObject(v) ? Object.keys(v) : []
    if (ops.some((o) => RANGE_OPS.has(o))) range.push(k)
    else eq.push(k)
  }
}

/** `createIndex` for the query's equality fields, then its sort, then its ranges. */
export function suggestIndex(ctx: MongoExplainContext): string | null {
  const eq: string[] = []
  const range: string[] = []
  filterFields(ctx.filter, eq, range)
  const keys = new Map<string, number>()
  for (const f of eq) keys.set(f, 1)
  if (isObject(ctx.sort))
    for (const [k, v] of Object.entries(ctx.sort))
      if (!keys.has(k)) keys.set(k, num(v) != null && num(v)! < 0 ? -1 : 1)
  for (const f of range) if (!keys.has(f)) keys.set(f, 1)
  if (!keys.size) return null
  const spec = [...keys].map(
    ([k, d]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${d}`
  )
  return `${shellCollection(ctx.collection)}.createIndex({ ${spec.join(', ')} })`
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

function mongoHints(trees: PlanTree[], totals: Totals, ctx: MongoExplainContext): RawHint[] {
  const hints: RawHint[] = []
  const index = suggestIndex(ctx)
  let suggested = false
  /** The index suggestion, attached to the first hint that wants it */
  const withIndex = (): { sql?: string } => {
    if (!index || suggested) return {}
    suggested = true
    return { sql: index }
  }
  const nodes: PlanNode[] = []
  for (const t of trees) walkPlan(t.root, (n) => nodes.push(n))
  const stage = (n: PlanNode): string => n.props.find(([k]) => k === 'Stage')?.[1] ?? ''
  const scans = nodes.filter((n) => stage(n) === 'COLLSCAN')

  for (const node of scans) {
    const read = scans.length === 1 && node.actualRows == null ? totals.docsExamined : null
    const examined = node.actualRows != null ? node.actualRows + (node.rowsRemoved ?? 0) : read
    const kept = node.actualRows ?? (scans.length === 1 ? totals.returned : null)
    const selective = examined != null && kept != null && examined >= 1000 && kept / examined <= 0.2
    if (!index) {
      hints.push({
        severity: 'low',
        node,
        title: `Reads all of ${ctx.collection}`,
        detail: `There's no filter or sort, so MongoDB reads every document${examined != null ? ` (${fmt(examined)} here)` : ''}. That's expected for a full listing; add a filter on an indexed field to read less.`
      })
      continue
    }
    hints.push({
      severity: selective ? 'high' : examined != null && examined >= 1000 ? 'medium' : 'low',
      node,
      title:
        examined != null && kept != null
          ? `Collection scan reads ${fmt(examined)} documents to return ${fmt(kept)}`
          : `Collection scan of ${ctx.collection}`,
      detail: `No index matches the query, so MongoDB reads every document and checks it${node.filter ? ` against ${node.filter}` : ''}. An index with the equality fields first, then the sort fields, then the range fields lets it read only the documents it returns, already in order.`,
      ...withIndex()
    })
  }

  for (const node of nodes) {
    const st = stage(node)
    if (st === 'SORT') {
      hints.push({
        severity: (node.actualRows ?? 0) >= 10_000 || node.warnings.length ? 'high' : 'medium',
        node,
        title: 'Sorted in memory',
        detail:
          'No index returns the documents in the requested order, so they are collected and sorted in memory, which needs every match before the first one can be returned. Sorts over 100 MB spill to disk or fail. An index ending in the sort fields, in the same directions, avoids the sort.',
        ...withIndex()
      })
    }
    if (st === 'IXSCAN' && node.actualRows != null && node.rowsRemoved != null) {
      const keys = node.actualRows + node.rowsRemoved
      if (keys >= 1000 && node.actualRows / keys <= 0.1)
        hints.push({
          severity: 'medium',
          node,
          title: `Index scan reads ${fmt(keys)} keys for ${fmt(node.actualRows)} matches`,
          detail: `${node.target ?? 'The index'} only narrows the search partly. A compound index that puts the equality fields before range fields would keep the scan to matching keys.`,
          ...withIndex()
        })
    }
    if (st === 'FETCH' && node.filter && node.actualRows != null && node.rowsRemoved != null) {
      const read = node.actualRows + node.rowsRemoved
      if (read >= 1000 && node.actualRows / read <= 0.2)
        hints.push({
          severity: 'medium',
          node,
          title: `${fmt(node.rowsRemoved)} fetched documents filtered out`,
          detail: `The index finds candidates, but ${node.filter} can only be checked after loading each document. Adding those fields to the index would filter them out before the fetch.`,
          ...withIndex()
        })
    }
  }
  return hints
}

/** Reads `explain` output; null when it holds no plan. */
export function parseMongoExplain(value: unknown, context: MongoExplainContext): Plan | null {
  if (!isObject(value)) return null
  const ctx: Ctx = { ...context, shardPlans: new Map() }
  let found: { root: PlanNode; totals: Totals } | null
  try {
    if (isObject(value.shards) && !value.queryPlanner && !Array.isArray(value.stages)) {
      // A sharded aggregate: one explain per shard, merged on mongos
      const root = blankNode('Shard Merge')
      for (const [name, sub] of Object.entries(value.shards)) {
        if (!isObject(sub)) continue
        const part = aggregateTree(sub, ctx)
        const n = blankNode(`Shard ${name}`)
        n.target = name
        if (part) {
          n.children.push(part.root)
          n.actualRows = part.root.actualRows
          n.loops = part.root.loops
          n.timeMs = part.root.timeMs
        }
        root.children.push(n)
      }
      found = root.children.length
        ? { root, totals: { returned: null, docsExamined: null, keysExamined: null, timeMs: null } }
        : null
    } else {
      found = aggregateTree(value, ctx)
    }
  } catch {
    return null
  }
  if (!found) return null
  const trees: PlanTree[] = [{ label: null, root: found.root, timeMs: found.totals.timeMs }]
  return buildPlan('mongo-explain', {
    trees,
    executionMs: found.totals.timeMs,
    hints: mongoHints(trees, found.totals, context)
  })
}
