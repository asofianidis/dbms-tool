import type { ExecOutput } from './api'
import type { Dialect } from './engines'

/* ---------- Model ---------- */

/** What the EXPLAIN statement asked the server for, and so how to read its output. */
export type PlanFormat =
  | 'postgres-json'
  | 'postgres-text'
  | 'mysql-tree'
  | 'mariadb-json'
  | 'showplan-xml'
  | 'mongo-explain'

export interface PlanNode {
  /** Depth-first position across the whole plan */
  id: number
  /** Physical operation, e.g. `Seq Scan`, `Hash Join`, `Clustered Index Seek` */
  op: string
  /** Table, index or condition the operation works on */
  target: string | null
  /** Why the node exists when it isn't fed straight to its parent (`SubPlan 1`, `InitPlan 2`) */
  label: string | null
  /** Table the node reads, for hints */
  relation: string | null
  /** Reads every row of a table or index */
  fullScan: boolean
  /** Estimated rows per execution */
  estRows: number | null
  /** Estimated executions, when the server reports them */
  estLoops: number | null
  /** Estimated cost of this node and everything under it */
  cost: number | null
  selfCost: number | null
  /** Rows produced, across every execution */
  actualRows: number | null
  /** How many times the node ran */
  loops: number | null
  /**
   * Processes that each ran the node once under a PostgreSQL Gather (workers
   * plus the leader), so only loops beyond this are repeated passes
   */
  parallel?: number
  /** Time spent in this node and everything under it */
  timeMs: number | null
  selfMs: number | null
  filter: string | null
  /** Rows read and then thrown away by `filter`, across every execution */
  rowsRemoved: number | null
  /** Columns the node passes up, when the server reports them */
  output: string[]
  /** Problems the server flagged on this node (spills, missing statistics, …) */
  warnings: string[]
  /** Everything the server said about the node, for the inspector */
  props: [string, string][]
  children: PlanNode[]
}

export interface PlanTree {
  /** Statement text when a batch has several statements */
  label: string | null
  root: PlanNode
  /** Measured wall time of the statement when the server reports it separately */
  timeMs: number | null
}

export type PlanHintSeverity = 'high' | 'medium' | 'low'

export interface PlanHint {
  severity: PlanHintSeverity
  nodeId: number | null
  title: string
  detail: string
  /** A statement that may fix it, e.g. a CREATE INDEX */
  sql?: string
}

export type PlanMetric = 'time' | 'cost'

export interface Plan {
  format: PlanFormat
  /** The query actually ran, so actual rows and times are known */
  analyzed: boolean
  trees: PlanTree[]
  planningMs: number | null
  executionMs: number | null
  /** Metrics the plan has numbers for, best first */
  metrics: PlanMetric[]
  hints: PlanHint[]
}

export type RawHint = Omit<PlanHint, 'nodeId'> & { node?: PlanNode }

export interface Parsed {
  trees: PlanTree[]
  planningMs?: number | null
  executionMs?: number | null
  hints?: RawHint[]
}

export function blankNode(op: string): PlanNode {
  return {
    id: 0,
    op,
    target: null,
    label: null,
    relation: null,
    fullScan: false,
    estRows: null,
    estLoops: null,
    cost: null,
    selfCost: null,
    actualRows: null,
    loops: null,
    timeMs: null,
    selfMs: null,
    filter: null,
    rowsRemoved: null,
    output: [],
    warnings: [],
    props: [],
    children: []
  }
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

export function walkPlan(node: PlanNode, visit: (n: PlanNode, parent: PlanNode | null) => void) {
  const go = (n: PlanNode, parent: PlanNode | null): void => {
    visit(n, parent)
    for (const c of n.children) go(c, n)
  }
  go(node, null)
}

/* ---------- EXPLAIN statements ---------- */

/** The plan format `explainSql` asks for. MariaDB's are read by `parseMariaDbPlan`. */
export function planFormat(dialect: Dialect, babelfish: boolean, mariadb = false): PlanFormat {
  if (dialect === 'postgres') return 'postgres-json'
  if (dialect === 'mysql') return mariadb ? 'mariadb-json' : 'mysql-tree'
  return babelfish ? 'postgres-text' : 'showplan-xml'
}

/* ---------- Parsing ---------- */

/** Reads the plan out of an EXPLAIN run, or null when the output isn't a plan. */
export function parsePlan(output: ExecOutput, format: PlanFormat): Plan | null {
  const cells = output.results.flatMap((set) =>
    set.rows.flatMap((row) => row.filter((c): c is string => typeof c === 'string'))
  )
  let parsed: Parsed | null = null
  try {
    switch (format) {
      case 'postgres-json': {
        const text = cells.find((c) => /^\s*\[\s*\{/.test(c))
        parsed = text ? parsePgJson(text) : null
        break
      }
      case 'postgres-text': {
        // One row per line; the statement's own results come first under STATISTICS PROFILE
        const set =
          output.results.find((s) => /query plan/i.test(s.columns[0]?.name ?? '')) ??
          output.results.find((s) => s.rows.some((r) => PG_TEXT_NODE.test(String(r[0] ?? ''))))
        parsed = set ? parsePgText(set.rows.map((r) => String(r[0] ?? '')).join('\n')) : null
        break
      }
      case 'mysql-tree': {
        const text = cells.find((c) => /^\s*->/.test(c))
        parsed = text ? parseMysqlTree(text) : null
        break
      }
      case 'showplan-xml': {
        const docs = cells.filter((c) => /^\s*<(\?xml|ShowPlanXML)/.test(c))
        const all = docs.map(parseShowplan)
        parsed = all.length
          ? { trees: all.flatMap((p) => p.trees), hints: all.flatMap((p) => p.hints ?? []) }
          : null
        break
      }
    }
  } catch {
    return null
  }
  if (!parsed || !parsed.trees.length) return null
  return buildPlan(format, parsed)
}

export function buildPlan(format: PlanFormat, parsed: Parsed): Plan {
  let id = 0
  let analyzed = false
  let hasCost = false
  let hasTime = false
  for (const tree of parsed.trees) {
    walkPlan(tree.root, (n) => {
      n.id = id++
      if (n.loops != null) analyzed = true
      if (n.cost != null) hasCost = true
      if (n.timeMs != null) hasTime = true
      const kids = n.children
      if (n.cost != null)
        n.selfCost = Math.max(0, n.cost - kids.reduce((s, c) => s + (c.cost ?? 0), 0))
      // A PostgreSQL InitPlan/SubPlan runs inside whichever step uses it, so its time
      // is already part of a sibling's and mustn't be taken off the parent twice
      const timed = format.startsWith('postgres') ? kids.filter((c) => !c.label) : kids
      if (n.timeMs != null)
        n.selfMs = Math.max(0, n.timeMs - timed.reduce((s, c) => s + (c.timeMs ?? 0), 0))
    })
    if (format.startsWith('postgres')) walkPlan(tree.root, chargeSubplans)
  }
  const plan: Plan = {
    format,
    analyzed,
    trees: parsed.trees,
    planningMs: parsed.planningMs ?? null,
    executionMs: parsed.executionMs ?? null,
    metrics: [...(hasTime ? ['time' as const] : []), ...(hasCost ? ['cost' as const] : [])],
    hints: []
  }
  const raw = [...(parsed.hints ?? []), ...planHints(plan)]
  const order: Record<PlanHintSeverity, number> = { high: 0, medium: 1, low: 2 }
  plan.hints = raw
    .map(({ node, ...h }) => ({ ...h, nodeId: node?.id ?? null }))
    .sort((a, b) => order[a.severity] - order[b.severity])
  return plan
}

/**
 * Takes the time of a PostgreSQL InitPlan/SubPlan off the step that evaluates it, found by
 * its name (`(InitPlan 1).col1`, PostgreSQL 16+) or parameter (`$0`) in that step's conditions.
 */
function chargeSubplans(parent: PlanNode): void {
  for (const sub of parent.children) {
    if (!sub.label || !sub.timeMs) continue
    const refs = [sub.label.replace(/\s*\(.*$/, ''), ...(sub.label.match(/\$\d+/g) ?? [])]
    const mentions = (n: PlanNode): boolean =>
      n.props.some(([, v]) =>
        refs.some((r) => new RegExp(`${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(v))
      )
    let user: PlanNode | undefined
    for (const sibling of parent.children)
      if (sibling !== sub) walkPlan(sibling, (n) => void (mentions(n) && (user = n)))
    if (!user && mentions(parent)) user = parent
    if (user?.selfMs != null) user.selfMs = Math.max(0, user.selfMs - sub.timeMs)
  }
}

/* ----- PostgreSQL EXPLAIN (FORMAT JSON) ----- */

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

function parsePgJson(text: string): Parsed {
  const doc: unknown = JSON.parse(text)
  const trees: PlanTree[] = []
  const hints: RawHint[] = []
  let planningMs: number | null = null
  let executionMs: number | null = null
  for (const item of Array.isArray(doc) ? doc : [doc]) {
    if (!isObj(item) || !isObj(item.Plan)) continue
    const root = pgJsonNode(item.Plan, 1)
    const exec = num(item['Execution Time'])
    planningMs = num(item['Planning Time']) ?? planningMs
    executionMs = exec ?? executionMs
    trees.push({ label: null, root, timeMs: exec })
    for (const t of Array.isArray(item.Triggers) ? item.Triggers : []) {
      if (!isObj(t)) continue
      const ms = num(t.Time) ?? 0
      if (ms >= 1 && exec && ms / exec >= 0.1)
        hints.push({
          severity: ms / exec >= 0.3 ? 'high' : 'medium',
          node: root,
          title: `Trigger ${String(t['Trigger Name'])} took ${fmtMs(ms)}`,
          detail: `It ran ${num(t.Calls) ?? '?'} times on ${String(t.Relation ?? 'the table')}, ${pct(ms / exec)} of the execution time. Triggers run once per affected row, so their cost grows with the number of rows the statement changes.`
        })
    }
  }
  return { trees, planningMs, executionMs, hints }
}

/** `divisor` spreads the time of nodes run by parallel workers back to wall-clock time. */
function pgJsonNode(raw: Json, divisor: number): PlanNode {
  const type = String(raw['Node Type'] ?? '?')
  let op = type
  const join = str(raw['Join Type'])
  if (join && join !== 'Inner')
    op =
      type === 'Nested Loop' ? `Nested Loop ${join} Join` : type.replace(/ Join$/, ` ${join} Join`)
  if (type === 'Aggregate')
    op =
      { Hashed: 'HashAggregate', Sorted: 'GroupAggregate', Mixed: 'MixedAggregate' }[
        String(raw.Strategy)
      ] ?? 'Aggregate'
  if (type === 'SetOp' && raw.Strategy === 'Hashed') op = 'HashSetOp'
  const partial = str(raw['Partial Mode'])
  if (partial && partial !== 'Simple') op = `${partial} ${op}`
  if (raw['Parallel Aware'] === true) op = `Parallel ${op}`

  const n = blankNode(op)
  const rel = str(raw['Relation Name'])
  const schema = str(raw.Schema)
  const alias = str(raw.Alias)
  const index = str(raw['Index Name'])
  const on = rel
    ? `${schema ? `${schema}.` : ''}${rel}${alias && alias !== rel ? ` ${alias}` : ''}`
    : (str(raw['CTE Name']) ?? str(raw['Function Name']) ?? alias)
  n.target = [on, index && `using ${index}`].filter(Boolean).join(' ') || null
  n.relation = rel ? `${schema ? `${schema}.` : ''}${rel}` : null
  n.label = str(raw['Subplan Name'])
  n.fullScan = type === 'Seq Scan'
  n.estRows = num(raw['Plan Rows'])
  n.cost = num(raw['Total Cost'])

  if (divisor > 1) n.parallel = divisor
  const loops = num(raw['Actual Loops'])
  if (loops != null) {
    n.loops = loops
    n.actualRows = (num(raw['Actual Rows']) ?? 0) * loops
    const t = num(raw['Actual Total Time'])
    if (t != null) n.timeMs = (t * loops) / divisor
    const removed = num(raw['Rows Removed by Filter']) ?? num(raw['Rows Removed by Join Filter'])
    if (removed != null) n.rowsRemoved = removed * loops
  }
  n.filter = str(raw.Filter) ?? str(raw['Join Filter'])
  if (Array.isArray(raw.Output)) n.output = raw.Output.map(String)

  if (raw['Sort Space Type'] === 'Disk')
    n.warnings.push(`Sort spilled to disk (${num(raw['Sort Space Used']) ?? '?'} kB)`)
  const batches = num(raw['Hash Batches']) ?? num(raw['HashAgg Batches'])
  if (batches != null && batches > 1)
    n.warnings.push(`Hash table spilled to disk in ${batches} batches`)
  const heapFetches = num(raw['Heap Fetches'])
  if (heapFetches != null && heapFetches >= 1000)
    n.warnings.push(
      `${heapFetches.toLocaleString()} heap fetches; the visibility map is out of date, VACUUM ${n.relation ?? 'the table'}`
    )

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'Plans' || isObj(value)) continue
    if (Array.isArray(value)) n.props.push([key, value.map(String).join(', ')])
    else if (value != null) n.props.push([key, String(value)])
  }

  const workers = /^Gather/.test(type)
    ? (num(raw['Workers Launched']) ?? num(raw['Workers Planned']) ?? 0) + 1
    : divisor
  n.children = (Array.isArray(raw.Plans) ? raw.Plans : [])
    .filter(isObj)
    .map((c) => pgJsonNode(c, workers))
  return n
}

/* ----- PostgreSQL text plans (Babelfish SHOWPLAN_ALL / STATISTICS PROFILE) ----- */

const PG_TEXT_NODE =
  /^(\s*)(?:->\s+)?(\S.*?)\s+\(cost=([\d.]+)\.\.([\d.]+) rows=([\d.]+) width=\d+\)(?:\s+\(actual(?: time=([\d.]+)\.\.([\d.]+))? rows=([\d.]+) loops=(\d+)\)|\s+\((never executed)\))?\s*$/

function parsePgText(text: string): Parsed {
  const trees: PlanTree[] = []
  const stack: { indent: number; node: PlanNode; divisor: number }[] = []
  let planningMs: number | null = null
  let executionMs: number | null = null
  let pendingLabel: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const m = PG_TEXT_NODE.exec(line)
    if (m) {
      const indent = m[1].length
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
      const parent = stack[stack.length - 1]
      const node = pgTextNode(m, parent?.divisor ?? 1)
      node.label = pendingLabel
      pendingLabel = null
      if (parent) parent.node.children.push(node)
      else trees.push({ label: null, root: node, timeMs: null })
      stack.push({ indent, node, divisor: parent?.divisor ?? 1 })
      continue
    }
    const detail = line.trim()
    if (!detail) continue
    const time = /^(Planning|Execution) Time: ([\d.]+) ms/.exec(detail)
    if (time) {
      if (time[1] === 'Planning') planningMs = Number(time[2])
      else executionMs = Number(time[2])
      continue
    }
    if (/^(SubPlan|InitPlan)\b/.test(detail)) {
      pendingLabel = detail
      continue
    }
    const top = stack[stack.length - 1]
    if (top) pgTextDetail(top, detail)
  }
  if (trees.length === 1) trees[0].timeMs = executionMs
  return { trees, planningMs, executionMs }
}

function pgTextNode(m: RegExpExecArray, divisor: number): PlanNode {
  const name = m[2]
  const on = /^(.+?)(?: using (\S+))? on (.+)$/.exec(name)
  const n = blankNode(on ? on[1] : name)
  if (on) {
    n.target = on[2] ? `${on[3]} using ${on[2]}` : on[3]
    if (/Scan$/.test(on[1]) && on[1] !== 'Bitmap Index Scan') n.relation = on[3].split(' ')[0]
  }
  n.fullScan = /(^|\s)Seq Scan$/.test(n.op)
  n.estRows = Number(m[5])
  n.cost = Number(m[4])
  if (divisor > 1) n.parallel = divisor
  if (m[10]) {
    n.loops = 0
    n.actualRows = 0
    n.timeMs = 0
  } else if (m[9]) {
    const loops = Number(m[9])
    n.loops = loops
    n.actualRows = Number(m[8]) * loops
    if (m[7]) n.timeMs = (Number(m[7]) * loops) / divisor
  }
  return n
}

function pgTextDetail(top: { node: PlanNode; divisor: number }, detail: string): void {
  const n = top.node
  const colon = detail.indexOf(': ')
  const key = colon > 0 ? detail.slice(0, colon) : detail
  const value = colon > 0 ? detail.slice(colon + 2) : ''
  n.props.push([key, value])
  if (key === 'Filter' || key === 'Join Filter') n.filter = value
  else if (key === 'Output') n.output = value.split(/,\s*/)
  else if (/^Rows Removed by (Join )?Filter$/.test(key))
    n.rowsRemoved = Number(value) * (n.loops ?? 1)
  else if (key === 'Sort Method' && /Disk:/.test(value))
    n.warnings.push(`Sort spilled to disk (${/Disk:\s*(\S+)/.exec(value)?.[1] ?? '?'})`)
  else if (key === 'Buckets' || key === 'Batches') {
    const batches = Number(/Batches: (\d+)/.exec(detail)?.[1] ?? 1)
    if (batches > 1) n.warnings.push(`Hash table spilled to disk in ${batches} batches`)
  } else if (key === 'Workers Launched' || key === 'Workers Planned') {
    // Children of a Gather run in every worker plus the leader
    if (/^Gather/.test(n.op)) top.divisor = Number(value) + 1
  }
}

/* ----- MySQL EXPLAIN FORMAT=TREE / EXPLAIN ANALYZE ----- */

const N = String.raw`\d+(?:\.\d+)?(?:e[+-]?\d+)?`
const MYSQL_NODE = new RegExp(
  String.raw`^(\s*)-> (.*?)(?:\s+\(cost=(${N})(?:\.\.(${N}))? rows=(${N})\))?` +
    String.raw`(?:\s+\(actual time=(${N})\.\.(${N}) rows=(${N}) loops=(\d+)\)|\s+\((never executed)\))?\s*$`
)

function parseMysqlTree(text: string): Parsed {
  const trees: PlanTree[] = []
  const stack: { indent: number; node: PlanNode }[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = MYSQL_NODE.exec(line)
    if (!m) {
      // A condition that wrapped onto the next line
      const top = stack[stack.length - 1]
      if (top && line.trim()) top.node.props[0][1] += ` ${line.trim()}`
      continue
    }
    const indent = m[1].length
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const node = mysqlNode(m)
    const parent = stack[stack.length - 1]
    if (parent) parent.node.children.push(node)
    else trees.push({ label: null, root: node, timeMs: null })
    stack.push({ indent, node })
  }
  for (const t of trees) t.root = foldFilter(t.root)
  return { trees }
}

/**
 * MySQL shows the WHERE of a scan as a Filter above it; fold it into the scan, as
 * PostgreSQL and SQL Server report it, so the scan's rows are what it keeps.
 */
function foldFilter(n: PlanNode): PlanNode {
  n.children = n.children.map(foldFilter)
  const [scan, ...subqueries] = n.children
  if (n.op !== 'Filter' || !scan?.fullScan || subqueries.some((c) => !/^Select #/.test(c.op)))
    return n
  const read = scan.actualRows
  // A subquery in the WHERE runs as part of the scan's filter
  scan.children.push(...subqueries)
  scan.filter = n.filter
  scan.props.push(['Filter', n.filter ?? ''])
  scan.label = n.label
  scan.estRows = n.estRows ?? scan.estRows
  scan.cost = n.cost ?? scan.cost
  scan.actualRows = n.actualRows
  scan.timeMs = n.timeMs ?? scan.timeMs
  if (read != null && n.actualRows != null) scan.rowsRemoved = Math.max(0, read - n.actualRows)
  return scan
}

function mysqlNode(m: RegExpExecArray): PlanNode {
  const desc = m[2]
  let n: PlanNode
  let condition: string | null = null
  const scan = /^(.*?) on (\S+)(?: using (\S+))?(?: (.*))?$/.exec(desc)
  const colon = /^([^:(]+?):\s*(.*)$/.exec(desc)
  const join = /^(.*?join)\s*\((.*)\)$/i.exec(desc)
  if (scan && !scan[1].includes(':') && /scan|lookup|search/i.test(scan[1])) {
    n = blankNode(scan[1])
    n.relation = scan[2]
    n.target = scan[3] ? `${scan[2]} using ${scan[3]}` : scan[2]
    // `<temporary>` is MySQL's own work table, not something an index can help
    n.fullScan = /^(table scan|(covering )?index scan)$/i.test(scan[1]) && !scan[2].startsWith('<')
    condition = scan[4] ?? null
  } else if (colon) {
    n = blankNode(colon[1])
    condition = colon[2]
    if (colon[1] === 'Filter') n.filter = colon[2]
    else n.target = colon[2]
  } else if (join) {
    n = blankNode(join[1])
    condition = join[2]
  } else {
    n = blankNode(desc)
  }
  n.props.push(['Description', desc])
  if (condition) n.props.push(['Condition', condition])
  n.estRows = num(m[5])
  n.cost = num(m[4] ?? m[3])
  if (m[10]) {
    n.loops = 0
    n.actualRows = 0
    n.timeMs = 0
  } else if (m[9]) {
    const loops = Number(m[9])
    n.loops = loops
    n.actualRows = Number(m[8]) * loops
    n.timeMs = Number(m[7]) * loops
  }
  if (n.cost != null) n.props.push(['Estimated cost', String(n.cost)])
  return n
}

/* ----- SQL Server showplan XML ----- */

export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlElement[]
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decodeXml(s: string): string {
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1))
      : (ENTITIES[e] ?? whole)
  )
}

/** Elements and attributes only; enough for showplans, which carry no text content. */
export function parseXml(text: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] }
  const stack = [root]
  const tag =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
  const attr = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (const m of text.matchAll(tag)) {
    if (!m[2]) continue
    const name = m[2].replace(/^[^:]+:/, '')
    if (m[1]) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const el: XmlElement = { name, attrs: {}, children: [] }
    for (const a of (m[3] ?? '').matchAll(attr))
      el.attrs[a[1].replace(/^[^:]+:/, '')] = decodeXml(a[2] ?? a[3] ?? '')
    stack[stack.length - 1].children.push(el)
    if (!m[4]) stack.push(el)
  }
  return root
}

/** Descendants named `name`, without looking inside nested operators. */
function within(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (c.name === name) out.push(c)
    else if (c.name !== 'RelOp') within(c, name, out)
  }
  return out
}

function everywhere(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (c.name === name) out.push(c)
    everywhere(c, name, out)
  }
  return out
}

const unbracket = (s: string | undefined): string => (s ?? '').replace(/^\[|\]$/g, '')

function humanize(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  return words.charAt(0) + words.slice(1).toLowerCase()
}

function parseShowplan(xml: string): Parsed {
  const doc = parseXml(xml)
  const trees: PlanTree[] = []
  const hints: RawHint[] = []
  const statements = everywhere(doc, 'StmtSimple')
  for (const stmt of statements) {
    const queryPlan = stmt.children.find((c) => c.name === 'QueryPlan')
    const relOp = queryPlan?.children.find((c) => c.name === 'RelOp')
    if (!queryPlan || !relOp) continue
    const root = msNode(relOp)
    for (const w of queryPlan.children.filter((c) => c.name === 'Warnings'))
      root.warnings.push(...msWarnings(w))
    const stats = queryPlan.children.find((c) => c.name === 'QueryTimeStats')
    const text = stmt.attrs.StatementText?.replace(/\s+/g, ' ').replace(/^[;\s]+/, '') ?? null
    trees.push({
      label: statements.length > 1 ? text : null,
      root,
      timeMs: num(stats?.attrs.ElapsedTime)
    })
    for (const group of everywhere(queryPlan, 'MissingIndexGroup'))
      for (const mi of group.children.filter((c) => c.name === 'MissingIndex'))
        hints.push(missingIndexHint(mi, num(group.attrs.Impact), root))
  }
  return { trees, hints }
}

const OPERATOR_SKIP = new Set([
  'OutputList',
  'Warnings',
  'MemoryFractions',
  'RunTimeInformation',
  'RunTimePartitionSummary',
  'InternalInfo'
])

function msNode(rel: XmlElement): PlanNode {
  const a = rel.attrs
  const physical = a.PhysicalOp ?? '?'
  const logical = a.LogicalOp
  const opEl = rel.children.find((c) => !OPERATOR_SKIP.has(c.name))
  const lookup = opEl?.name === 'IndexScan' && /^(1|true)$/.test(opEl.attrs.Lookup ?? '')
  const op = lookup
    ? 'Key Lookup'
    : logical && logical !== physical && !/Scan|Seek|Lookup/.test(physical)
      ? `${physical} (${logical})`
      : physical
  const n = blankNode(op)

  const obj = opEl && within(opEl, 'Object')[0]
  if (obj) {
    const table = unbracket(obj.attrs.Table)
    const schema = unbracket(obj.attrs.Schema)
    const alias = unbracket(obj.attrs.Alias)
    const index = unbracket(obj.attrs.Index)
    n.relation = table ? (schema ? `${schema}.${table}` : table) : null
    n.target =
      [table && `${table}${alias && alias !== table ? ` ${alias}` : ''}`, index && `using ${index}`]
        .filter(Boolean)
        .join(' ') || null
  }
  n.fullScan = ['Table Scan', 'Clustered Index Scan', 'Index Scan'].includes(physical) && !lookup
  n.estRows = num(a.EstimateRows)
  n.estLoops = 1 + (num(a.EstimateRebinds) ?? 0) + (num(a.EstimateRewinds) ?? 0)
  n.cost = num(a.EstimatedTotalSubtreeCost)

  const counters = rel.children
    .find((c) => c.name === 'RunTimeInformation')
    ?.children.filter((c) => c.name === 'RunTimeCountersPerThread')
  let rowsRead: number | null = null
  if (counters?.length) {
    const sum = (k: string): number | null =>
      counters.some((c) => c.attrs[k] != null)
        ? counters.reduce((s, c) => s + (num(c.attrs[k]) ?? 0), 0)
        : null
    n.actualRows = sum('ActualRows') ?? 0
    // Each thread of a parallel operator runs it once, so the threads' sum
    // isn't how often it repeated: take the busiest thread's count instead.
    // Only parallel zones report threads other than 0
    const parallel =
      /^(1|true)$/i.test(a.Parallel ?? '') || counters.some((c) => (num(c.attrs.Thread) ?? 0) !== 0)
    n.loops = parallel
      ? counters.some((c) => c.attrs.ActualExecutions != null)
        ? Math.max(...counters.map((c) => num(c.attrs.ActualExecutions) ?? 0))
        : 0
      : (sum('ActualExecutions') ?? 0)
    rowsRead = sum('ActualRowsRead')
    const elapsed = counters.map((c) => num(c.attrs.ActualElapsedms)).filter((v) => v != null)
    if (elapsed.length) n.timeMs = Math.max(...elapsed)
  }

  const scalar = (el: XmlElement | undefined): string[] =>
    el
      ? everywhere(el, 'ScalarOperator')
          .map((s) => s.attrs.ScalarString ?? '')
          .filter(Boolean)
      : []
  const predicate = opEl && within(opEl, 'Predicate')[0]
  n.filter = scalar(predicate)[0] ?? null
  if (n.filter && rowsRead != null && n.actualRows != null)
    n.rowsRemoved = Math.max(0, rowsRead - n.actualRows)

  n.output = (rel.children.find((c) => c.name === 'OutputList')?.children ?? []).map((c) =>
    [unbracket(c.attrs.Table), unbracket(c.attrs.Column)].filter(Boolean).join('.')
  )
  for (const w of [...rel.children, ...(opEl?.children ?? [])].filter((c) => c.name === 'Warnings'))
    n.warnings.push(...msWarnings(w))

  for (const [k, v] of Object.entries(a)) n.props.push([k, v])
  if (obj) n.props.push(['Object', Object.values(obj.attrs).join('.')])
  const seek = opEl && within(opEl, 'SeekPredicates')[0]
  if (seek) n.props.push(['Seek predicates', scalar(seek).join(' AND ')])
  if (n.filter) n.props.push(['Predicate', n.filter])
  if (rowsRead != null) n.props.push(['Actual rows read', String(rowsRead)])

  n.children = collectRelOps(rel).map(msNode)
  return n
}

function collectRelOps(el: XmlElement, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (c.name === 'RelOp') out.push(c)
    else collectRelOps(c, out)
  }
  return out
}

function msWarnings(w: XmlElement): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(w.attrs)) if (/^(1|true)$/.test(v)) out.push(humanize(k))
  for (const c of w.children) {
    if (c.name === 'SpillToTempDb')
      out.push(`Spilled to tempdb${c.attrs.SpillLevel ? ` (level ${c.attrs.SpillLevel})` : ''}`)
    else if (c.name === 'ColumnsWithNoStatistics')
      out.push(
        `Columns with no statistics: ${everywhere(c, 'ColumnReference')
          .map((r) => unbracket(r.attrs.Column))
          .join(', ')}`
      )
    else if (c.name === 'PlanAffectingConvert')
      out.push(`Type conversion may stop an index seek: ${c.attrs.Expression ?? ''}`.trim())
    else out.push(humanize(c.name))
  }
  return out
}

function missingIndexHint(mi: XmlElement, impact: number | null, root: PlanNode): RawHint {
  const cols = (usage: string): string[] =>
    mi.children
      .filter((g) => g.name === 'ColumnGroup' && g.attrs.Usage === usage)
      .flatMap((g) => g.children.map((c) => c.attrs.Name ?? ''))
  const keys = [...cols('EQUALITY'), ...cols('INEQUALITY')]
  const include = cols('INCLUDE')
  const table = mi.attrs.Table ?? ''
  const name = `IX_${unbracket(table)}_${keys.map(unbracket).join('_')}`.slice(0, 128)
  let node: PlanNode | undefined
  walkPlan(root, (n) => {
    if (!node && n.fullScan && n.relation?.endsWith(unbracket(table))) node = n
  })
  return {
    severity: impact == null || impact >= 30 ? 'high' : 'medium',
    node: node ?? root,
    title: `Missing index on ${unbracket(table)}`,
    detail: `SQL Server estimates this index would cut the query's cost by ${impact != null ? `${impact.toFixed(0)}%` : 'a large amount'}. Check it against the table's existing indexes before creating it.`,
    sql: `CREATE NONCLUSTERED INDEX [${name}]\nON ${mi.attrs.Schema ? `${mi.attrs.Schema}.` : ''}${table} (${keys.join(', ')})${include.length ? `\nINCLUDE (${include.join(', ')})` : ''};`
  }
}

/* ---------- Hints ---------- */

export function fmtMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`
  if (ms < 100) return `${ms.toFixed(1)} ms`
  if (ms < 10_000) return `${Math.round(ms).toLocaleString()} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`
}

function fmtRows(n: number): string {
  return Math.round(n).toLocaleString()
}

/** Total of the metric across the plan, for turning a node's self value into a share. */
export function planTotal(plan: Plan, metric: PlanMetric): number {
  const value = (n: PlanNode): number | null => (metric === 'time' ? n.timeMs : n.cost)
  return plan.trees.reduce((s, t) => {
    // MySQL leaves the steps above a join (sorts, temporary tables) without numbers
    let top = value(t.root)
    if (top == null) walkPlan(t.root, (n) => (top = Math.max(top ?? 0, value(n) ?? 0)))
    return s + (top ?? 0)
  }, 0)
}

export function nodeShare(node: PlanNode, metric: PlanMetric, total: number): number | null {
  const self = metric === 'time' ? node.selfMs : node.selfCost
  return self == null || total <= 0 ? null : Math.min(1, self / total)
}

/** How far the row estimate was off, as a factor ≥ 1, or null when it can't be judged. */
export function misestimate(node: PlanNode): number | null {
  if (node.actualRows == null || !node.loops || node.estRows == null) return null
  const actual = node.actualRows / node.loops
  if (Math.max(actual, node.estRows) < 100) return null
  const factor = Math.max(actual, 1) / Math.max(node.estRows, 1)
  return factor >= 1 ? factor : 1 / factor
}

function statsCommand(format: PlanFormat, relation: string | null): string {
  const target = relation ?? 'the tables involved'
  if (format === 'mysql-tree') return `ANALYZE TABLE ${target}`
  // Plain ANALYZE TABLE leaves MariaDB without the histograms it estimates conditions from
  if (format === 'mariadb-json') return `ANALYZE TABLE ${target} PERSISTENT FOR ALL`
  if (format === 'showplan-xml') return `UPDATE STATISTICS ${target}`
  return `ANALYZE ${target}`
}

function planHints(plan: Plan): RawHint[] {
  const hints: RawHint[] = []
  const metric = plan.metrics[0]
  const total = metric ? planTotal(plan, metric) : 0
  const what = metric === 'time' ? 'the execution time' : 'the estimated cost'
  const share = (n: PlanNode): number => (metric ? (nodeShare(n, metric, total) ?? 0) : 0)
  /** Opens a specific hint with how much the step weighs, when that's notable */
  const weight = (n: PlanNode): string =>
    share(n) >= 0.2 ? `This step is ${pct(share(n))} of ${what}. ` : ''
  const nodes: { node: PlanNode; parent: PlanNode | null }[] = []
  for (const t of plan.trees) walkPlan(t.root, (node, parent) => nodes.push({ node, parent }))

  for (const { node, parent } of nodes) {
    // Scans that read a lot to keep a little, or that repeat for every outer row.
    // MongoDB's parser writes its own, with an index to create
    if (node.fullScan && plan.format !== 'mongo-explain') {
      const where = node.target ?? node.relation ?? 'the table'
      const loops = node.loops ?? node.estLoops ?? 1
      const kept = node.actualRows
      const read =
        kept != null ? kept + (node.rowsRemoved ?? 0) : (node.estRows ?? 0) * (node.estLoops ?? 1)
      // Parallel workers each running the scan once don't make it a repeat
      if (loops > (node.parallel ?? 1) && read >= 1000) {
        hints.push({
          severity: 'high',
          node,
          title: `${where} is scanned ${fmtRows(loops)} times`,
          detail: `${weight(node)}The ${node.op.toLowerCase()} runs again for every row coming from the other side of ${parent ? `the ${parent.op}` : 'the join'}, reading ${fmtRows(read)} rows in total. An index on the join column${node.filter ? ' and the filtered columns' : ''} would turn each pass into a quick lookup.`
        })
      } else if (node.filter && kept != null) {
        if (read >= 1000 && kept / read <= 0.2)
          hints.push({
            severity: share(node) >= 0.2 ? 'high' : share(node) >= 0.05 ? 'medium' : 'low',
            node,
            title: `Full scan of ${where} to find ${fmtRows(kept)} of ${fmtRows(read)} rows`,
            detail: `${weight(node)}Every row is read and then checked against ${node.filter}. An index on the columns in that condition would let the database go straight to the matching rows.`
          })
      } else if (node.filter && share(node) >= 0.2) {
        hints.push({
          severity: share(node) >= 0.5 ? 'high' : 'medium',
          node,
          title: `Full scan of ${where} with a filter`,
          detail: `${weight(node)}Every row is read and checked against ${node.filter}${node.estRows != null ? `, and about ${fmtRows(node.estRows)} are expected to match` : ''}. If that's a small part of the table, an index on the columns in the condition would let the database go straight to them. Run Explain analyze to see the real numbers.`
        })
      }
    }

    // The planner guessed the row count badly, which leads to poor join and memory choices
    const off = misestimate(node)
    if (off != null && off >= 10 && !node.children.some((c) => (misestimate(c) ?? 0) >= 10)) {
      const actual = node.actualRows! / node.loops!
      const under = actual > node.estRows!
      hints.push({
        // Too few rows expected is the dangerous direction: nested loops and undersized memory
        severity: under && off >= 100 ? 'medium' : 'low',
        node,
        title: `Row estimate off by ${off >= 10_000 ? `${fmtRows(off / 1000)}k` : fmtRows(off)}×`,
        detail: `${node.op} expected ${fmtRows(node.estRows!)} rows but got ${fmtRows(actual)}${node.loops! > 1 ? ' per execution' : ''}. ${under ? 'Underestimates lead to nested loops over large inputs and to sorts or hashes that run out of memory.' : 'Overestimates can make the planner pick a heavier plan than needed.'} Refresh statistics with ${statsCommand(plan.format, node.relation)}; if that doesn't help, the condition may be too complex for the planner to estimate.`
      })
    }

    if (node.op === 'Key Lookup' || node.op === 'RID Lookup') {
      const rows = node.actualRows ?? (node.estRows ?? 0) * (node.estLoops ?? 1)
      if (rows >= 100)
        hints.push({
          severity: share(node) >= 0.3 ? 'high' : 'medium',
          node,
          title: `${fmtRows(rows)} lookups back into ${node.relation ?? 'the table'}`,
          detail: `${weight(node)}The index used to find the rows doesn't hold every column the query needs, so each row is fetched again from the table.${node.output.length ? ` Adding ${node.output.join(', ')} as INCLUDE columns on that index would avoid it.` : ' Adding the missing columns as INCLUDE columns on that index would avoid it.'}`
        })
    }

    for (const w of node.warnings)
      hints.push({
        severity: /spill|no join predicate/i.test(w) ? 'high' : 'medium',
        node,
        title: w.split(/[;:(]/)[0].trim(),
        detail: /spill/i.test(w)
          ? `${w}. The step ran out of working memory and used disk instead, which is much slower. This usually follows a row estimate that was too low, or a memory setting (work_mem, sort_buffer_size) that's too small for the data.`
          : w
      })
  }

  // Where the time goes, for heavy steps nothing above explains
  const explained = new Set(hints.map((h) => h.node))
  if (metric && nodes.length > 1) {
    const hot = nodes
      .filter(({ node }) => share(node) >= 0.2 && !explained.has(node))
      .sort((a, b) => share(b.node) - share(a.node))
      .slice(0, 3)
    for (const { node } of hot)
      hints.push({
        severity: share(node) >= 0.5 ? 'high' : 'medium',
        node,
        title: `${node.op}${node.target ? ` on ${node.target}` : ''} is ${pct(share(node))} of ${what}`,
        detail:
          metric === 'time'
            ? `${fmtMs(node.selfMs ?? 0)} is spent in this step itself, not counting the steps under it.`
            : `This step carries a large share of the planner's estimate. Estimates can be wrong, so run Explain analyze to see the real time.`
      })
  }
  return hints
}

/* ---------- Layout ---------- */

export const PLAN_NODE = { width: 236, height: 88, gapX: 28, gapY: 60, labelHeight: 30 }

export interface PlanLayout {
  positions: Map<number, { x: number; y: number }>
  labels: { x: number; y: number; text: string }[]
  width: number
  height: number
}

/** Top-down tree: each parent centred over its children, statements stacked vertically. */
export function layoutPlan(trees: PlanTree[]): PlanLayout {
  const { width: W, height: H, gapX, gapY, labelHeight } = PLAN_NODE
  const positions = new Map<number, { x: number; y: number }>()
  const labels: PlanLayout['labels'] = []
  const widths = new Map<PlanNode, number>()
  const span = (n: PlanNode): number => {
    const kids = n.children.reduce((s, c) => s + span(c), 0) + gapX * (n.children.length - 1)
    const w = Math.max(W, kids)
    widths.set(n, w)
    return w
  }
  const place = (n: PlanNode, left: number, depth: number, top: number): number => {
    const w = widths.get(n)!
    positions.set(n.id, { x: left + (w - W) / 2, y: top + depth * (H + gapY) })
    let bottom = top + depth * (H + gapY) + H
    const kids = n.children.reduce((s, c) => s + widths.get(c)!, 0) + gapX * (n.children.length - 1)
    let x = left + (w - kids) / 2
    for (const c of n.children) {
      bottom = Math.max(bottom, place(c, x, depth + 1, top))
      x += widths.get(c)! + gapX
    }
    return bottom
  }
  let top = 0
  let width = 0
  for (const t of trees) {
    const w = span(t.root)
    if (t.label) {
      labels.push({ x: 0, y: top, text: t.label })
      top += labelHeight
    }
    top = place(t.root, 0, 0, top) + gapY * 1.5
    width = Math.max(width, w)
  }
  return { positions, labels, width, height: Math.max(0, top - gapY * 1.5) }
}
