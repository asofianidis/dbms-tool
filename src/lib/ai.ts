import type {
  AiProvider,
  Cell,
  CompletionTable,
  ExecOutput,
  MongoOutput,
  MongoRequest
} from './api'
import type { Dialect } from './engines'
import { walkPlan, type Plan, type PlanNode } from './plan'
import { sqlWriteKeyword } from './production'

/* ---------- Providers ---------- */

export interface ProviderInfo {
  label: string
  /** One line under the picker */
  description: string
  /** How it signs in: the CLI's own login, a saved key, or a server URL */
  auth: 'cli' | 'key' | 'local'
  /** Suggested models; the first is what an empty model means */
  models: { value: string; label: string }[]
  /** Where to get it, for the status line */
  setup: string
}

export const AI_PROVIDERS: Record<AiProvider, ProviderInfo> = {
  'claude-code': {
    label: 'Claude (subscription)',
    description:
      'Uses your Claude Pro or Max plan through the Claude Code CLI you already signed in to',
    auth: 'cli',
    models: [
      { value: '', label: 'Claude Code default' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
      { value: 'haiku', label: 'Haiku' },
      { value: 'fable', label: 'Fable' }
    ],
    setup: 'Install Claude Code (claude.com/claude-code), then run `claude` once to sign in'
  },
  cursor: {
    label: 'Cursor (subscription)',
    description: 'Uses your Cursor plan through the Cursor CLI you already signed in to',
    auth: 'cli',
    models: [{ value: '', label: 'Cursor default (auto)' }],
    setup: 'Install the Cursor CLI (cursor.com/cli), then run `cursor-agent login`'
  },
  anthropic: {
    label: 'Anthropic API key',
    description: 'Calls the Claude API with your own key, billed to your Anthropic account',
    auth: 'key',
    models: [
      { value: '', label: 'Claude Opus 5.5' },
      { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      { value: 'claude-fable-5-1', label: 'Claude Fable 5.1' }
    ],
    setup: 'Create a key at platform.claude.com'
  },
  'openai-compatible': {
    label: 'Local model',
    description:
      'Ollama, LM Studio, llama.cpp or any OpenAI-compatible server; nothing leaves your network',
    auth: 'local',
    models: [],
    setup: 'Start the server, e.g. `ollama serve`, and pull a model'
  }
}

export const AI_PROVIDER_ORDER: AiProvider[] = [
  'claude-code',
  'cursor',
  'anthropic',
  'openai-compatible'
]

/* ---------- Context ---------- */

/** Characters of schema to send; Cursor's prompt goes on a command line */
export function schemaBudget(provider: AiProvider): number {
  if (provider === 'cursor') return /windows/i.test(navigator.userAgent) ? 12_000 : 60_000
  if (provider === 'openai-compatible') return 24_000
  return 120_000
}

function qualified(schema: string | null | undefined, name: string): string {
  return schema ? `${schema}.${name}` : name
}

/**
 * The tables, columns and foreign keys as compact text. Names only: never a
 * row. Tables named in `focus` (the question, the editor text) come first, so
 * they survive when the budget runs out; the rest are then listed by name.
 */
export function describeSchema(
  tables: CompletionTable[],
  budget: number,
  focus = ''
): { text: string; tables: number; complete: boolean } {
  const words = new Set(focus.toLowerCase().match(/[\p{L}\p{N}_$#]+/gu) ?? [])
  const mentioned = (t: CompletionTable): boolean => words.has(t.name.toLowerCase())
  const ordered = [...tables].sort(
    (a, b) =>
      Number(mentioned(b)) - Number(mentioned(a)) ||
      qualified(a.schema, a.name).localeCompare(qualified(b.schema, b.name))
  )
  const lines: string[] = []
  let used = 0
  let full = 0
  for (const t of ordered) {
    const keys = t.foreignKeys.map(
      (k) =>
        `\n  FK (${k.columns.join(', ')}) -> ${qualified(k.refSchema, k.refTable)}(${k.refColumns.join(', ')})`
    )
    const line = `${qualified(t.schema, t.name)}(${t.columns.join(', ')})${keys.join('')}`
    if (used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
    full++
  }
  const rest = ordered.slice(full).map((t) => qualified(t.schema, t.name))
  if (rest.length) {
    let names = ''
    for (const name of rest) {
      if (used + names.length + name.length + 2 > budget + 4000) {
        names += ', …'
        break
      }
      names += (names ? ', ' : '') + name
    }
    lines.push(`\nMore tables (columns not shown): ${names}`)
  }
  return { text: lines.join('\n'), tables: tables.length, complete: rest.length === 0 }
}

/** A plan as an indented tree of operations with their numbers, for "why is this slow". */
export function describePlan(plan: Plan): string {
  const out: string[] = [
    `Plan format: ${plan.format}${plan.analyzed ? ' (executed: actual rows and times included)' : ' (estimates only)'}`
  ]
  if (plan.planningMs != null) out.push(`Planning time: ${plan.planningMs} ms`)
  if (plan.executionMs != null) out.push(`Execution time: ${plan.executionMs} ms`)
  for (const tree of plan.trees) {
    if (tree.label) out.push(`\nStatement: ${tree.label}`)
    const depth = new Map<PlanNode, number>()
    walkPlan(tree.root, (node, parent) => {
      const d = parent ? (depth.get(parent) ?? 0) + 1 : 0
      depth.set(node, d)
      const facts = [
        node.estRows != null && `est rows ${node.estRows}`,
        node.actualRows != null && `actual rows ${node.actualRows}`,
        node.loops != null && node.loops !== 1 && `loops ${node.loops}`,
        node.cost != null && `cost ${node.cost}`,
        node.timeMs != null && `time ${node.timeMs} ms`,
        node.fullScan && 'full scan',
        node.filter && `filter ${node.filter}`,
        node.rowsRemoved != null && `rows removed by filter ${node.rowsRemoved}`,
        ...node.warnings.map((w) => `warning: ${w}`)
      ].filter(Boolean)
      out.push(
        `${'  '.repeat(d)}-> ${node.label ? `[${node.label}] ` : ''}${node.op}${node.target ? ` on ${node.target}` : ''}${facts.length ? ` (${facts.join('; ')})` : ''}`
      )
    })
  }
  if (plan.hints.length) {
    out.push('\nThe app already flagged:')
    for (const h of plan.hints) out.push(`- [${h.severity}] ${h.title}: ${h.detail}`)
  }
  return out.join('\n')
}

/* ---------- Prompt ---------- */

export interface PromptTarget {
  /** e.g. "PostgreSQL 16" */
  engine: string
  language: 'sql' | 'mongo'
  database: string
  schema: string
  /** Whether it may ask for read-only queries, and how many rows come back */
  data: { allowed: boolean; maxRows: number }
}

export const RUN_OPEN = '<run_query>'
export const RUN_CLOSE = '</run_query>'

export function systemPrompt(target: PromptTarget): string {
  const lang = target.language === 'sql' ? 'SQL' : 'MongoDB shell (mongosh)'
  const fence = target.language === 'sql' ? 'sql' : 'javascript'
  const lines = [
    `You are the query assistant built into a database client. The user is connected to ${target.engine}, database "${target.database}", and writes ${lang} in the editor next to you.`,
    '',
    'How to answer:',
    `- Write queries for exactly this engine and its dialect, using only the tables, columns and keys in the schema below. If something the user needs isn't in the schema, say so rather than inventing names.`,
    `- Put each query in its own fenced \`\`\`${fence} block, ready to run. The user inserts it into the editor and runs it themselves, so keep it complete.`,
    '- Prefer reads. Only write statements that change data or structure (INSERT, UPDATE, DELETE, DROP, ALTER…) when the user explicitly asks for one, and then say plainly what it changes; the app makes them confirm before it runs.',
    '- When explaining a query or a plan, be concrete: name the tables, operations and numbers involved, and say what to change.',
    '- When fixing an error, explain the cause in a sentence or two and give the corrected query in full.',
    '- Be brief. No preamble.'
  ]
  if (target.data.allowed) {
    lines.push(
      '',
      'Reading data: you cannot connect to the database, but you may ask the app to run one read-only query for you when the answer depends on the data itself (which values exist, how many rows match). To do that, end your reply with',
      `${RUN_OPEN}`,
      target.language === 'sql'
        ? 'SELECT …'
        : '{"op": "find", "collection": "orders", "filter": {"status": "open"}, "sort": {"_id": -1}, "limit": 20}',
      `${RUN_CLOSE}`,
      ...(target.language === 'mongo'
        ? [
            'For MongoDB the request is a JSON object, not shell code: "op" is find (with filter, projection, sort, limit), aggregate (with pipeline), count (with filter) or distinct (with field, filter). Use Extended JSON for dates and ids, e.g. {"$date": "2024-01-01T00:00:00Z"}.'
          ]
        : []),
      `and write nothing after it. The app shows it to the user, who may decline; then you get back at most ${target.data.maxRows} rows inside <query_result>. Only read queries run: anything that writes, deletes, drops or changes settings is refused. Keep queries small (filters, LIMIT, aggregates) and ask for one at a time. Don't ask for data when the schema alone answers the question.`
    )
  } else {
    lines.push(
      '',
      "Privacy: you only get the schema (names, never rows) and what the user attaches. You can't see or query data. If the answer depends on the data, give the user a query to run themselves."
    )
  }
  lines.push(
    '',
    'Dashboards: when the user asks for a dashboard (or charts, a report page, KPIs), design one and reply with a short description followed by a single fenced ```dashboard block holding JSON:',
    '{"name": "Orders overview", "refreshSecs": 0, "widgets": [{"title": "Orders today", "kind": "stat", "query": "…", "x": null, "y": ["orders"], "span": 1}]}',
    '- kind is "stat" (one number: the first row\'s y column), "bar" or "line" (x is the category or time column, y the numeric columns, at most 8), or "table".',
    "- span is how many of the grid's 4 columns the widget takes: 1 for stats, 2 for most charts, 4 for wide tables or long time series.",
    target.language === 'sql'
      ? '- query is one read-only SELECT (or WITH … SELECT) for this engine, returning exactly the columns x and y name, with clear aliases. Aggregate in SQL and keep results small (top N, recent periods); widgets cap at 5000 rows. Line charts: order by x.'
      : '- query is one mongosh find() or aggregate() on db.<collection>, using $group / $project so field names match x and y. Keep results small; widgets cap at 5000 documents.',
    '- 3 to 8 widgets: a few stats first, then charts, then a table. refreshSecs is 0, 30, 60, 300 or 900. Dashboard queries only read; the app runs them, and you never see their results.',
    '- Only use tables and columns from the schema.'
  )
  lines.push('', '<schema>', target.schema || '(no tables found)', '</schema>')
  return lines.join('\n')
}

/* ---------- Replies ---------- */

export type ReplySegment =
  { kind: 'text'; text: string } | { kind: 'code'; lang: string; code: string }

/** Splits a reply into prose and fenced code blocks. */
export function parseReply(text: string): ReplySegment[] {
  const segments: ReplySegment[] = []
  const fence = /```([\w+-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g
  let last = 0
  for (const m of text.matchAll(fence)) {
    const before = text.slice(last, m.index).trim()
    if (before) segments.push({ kind: 'text', text: before })
    segments.push({ kind: 'code', lang: m[1].toLowerCase(), code: m[2].replace(/\n$/, '') })
    last = m.index + m[0].length
  }
  const rest = text.slice(last).trim()
  if (rest) segments.push({ kind: 'text', text: rest })
  return segments
}

/** The query a reply asks the app to run, and the reply without it. */
export function takeRunRequest(text: string): { text: string; query: string | null } {
  const start = text.lastIndexOf(RUN_OPEN)
  if (start < 0) return { text, query: null }
  const end = text.indexOf(RUN_CLOSE, start)
  let query = text.slice(start + RUN_OPEN.length, end < 0 ? undefined : end).trim()
  // Models sometimes fence the query inside the tags
  query = query
    .replace(/^```[\w-]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim()
  return { text: text.slice(0, start).trim(), query: query || null }
}

/** Why the app won't run a SQL query the assistant asked for, or null. The backend checks again. */
export function refusedSql(sql: string, dialect: Dialect): string | null {
  const keyword = sqlWriteKeyword(sql, dialect)
  return keyword ? `it contains ${keyword}, and the assistant can only read data` : null
}

/** Which Mongo requests the assistant may have run, like `ai_mongo_query` in the backend. */
export function mongoReadOnly(request: MongoRequest): boolean {
  switch (request.op) {
    case 'find':
    case 'count':
    case 'distinct':
    case 'listIndexes':
      return true
    case 'aggregate':
      return !request.pipeline.some(
        (stage) => !!stage && typeof stage === 'object' && ('$out' in stage || '$merge' in stage)
      )
    default:
      return false
  }
}

const MAX_CELL = 200

function cellText(cell: Cell): string {
  if (cell === null) return 'NULL'
  const text = String(cell)
  return text.length > MAX_CELL ? text.slice(0, MAX_CELL) + '…' : text
}

function csvField(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** A query's result as CSV for the model, at most `maxRows` rows per set. */
export function describeRows(output: ExecOutput, maxRows: number): string {
  if (output.error) return `The query failed: ${output.error.message}`
  if (!output.results.length) return 'The query ran and returned no result set.'
  return output.results
    .map((set, i) => {
      const rows = set.rows.slice(0, maxRows)
      const head = set.columns.map((c) => csvField(c.name)).join(',')
      const body = rows.map((r) => r.map((c) => csvField(cellText(c))).join(',')).join('\n')
      const more =
        set.rowCount > rows.length ? `\n(${set.rowCount - rows.length} more rows not shown)` : ''
      const label = output.results.length > 1 ? `Result set ${i + 1}:\n` : ''
      return `${label}${head}\n${body}${more}`
    })
    .join('\n\n')
}

export function describeDocuments(output: MongoOutput, maxRows: number): string {
  if (output.kind === 'value') return JSON.stringify(output.value)
  const docs = output.documents.slice(0, maxRows).map((d) => {
    const text = JSON.stringify(d)
    return text.length > MAX_CELL * 5 ? text.slice(0, MAX_CELL * 5) + '…' : text
  })
  const more =
    output.truncated || output.documents.length > docs.length ? '\n(more documents not shown)' : ''
  return (docs.join('\n') || '(no documents)') + more
}

/* ---------- MongoDB ---------- */

/** Field paths and BSON types of a `$jsonSchema` (from `schemaFromSample`), e.g. `address.city: string`. */
export function schemaFields(schema: Record<string, unknown>, prefix = ''): string[] {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  return Object.entries(properties).flatMap(([key, prop]) => {
    const path = prefix ? `${prefix}.${key}` : key
    const type = Array.isArray(prop.bsonType) ? prop.bsonType.join('|') : String(prop.bsonType)
    const items = (prop.items as { bsonType?: unknown } | undefined)?.bsonType
    const line = `${path}: ${type}${items ? `<${Array.isArray(items) ? items.join('|') : String(items)}>` : ''}`
    return [line, ...(prop.properties ? schemaFields(prop, path) : [])]
  })
}

/** Collections with their sampled field names and types (never values), within `budget`. */
export function describeCollections(
  collections: { name: string; fields: string[] | null }[],
  budget: number
): string {
  const lines: string[] = []
  let used = 0
  for (const c of collections) {
    const line = c.fields?.length ? `${c.name} { ${c.fields.join(', ')} }` : c.name
    if (used + line.length > budget) {
      lines.push(`(${collections.length - lines.length} more collections not shown)`)
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

/**
 * A MongoDB read the assistant asked for, as JSON:
 * `{"op":"find","collection":"orders","filter":{…},"sort":{…},"limit":20}`.
 * Parsed as data, never evaluated: shell text runs as JavaScript in the app,
 * so text from the model must not go through `parseShell`.
 */
export function parseMongoRead(text: string, database: string): MongoRequest {
  let raw: unknown
  try {
    raw = JSON.parse(text.trim())
  } catch {
    throw new Error('the request must be a JSON object, not shell code')
  }
  const r = (raw ?? {}) as Record<string, unknown>
  const collection = r.collection
  if (typeof collection !== 'string' || !collection)
    throw new Error('the request names no collection')
  const object = (v: unknown, name: string): Record<string, unknown> | undefined => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name} must be an object`)
    return v as Record<string, unknown>
  }
  const db = typeof r.database === 'string' && r.database ? r.database : database
  const base = { database: db, collection }
  let request: MongoRequest
  switch (r.op) {
    case 'find': {
      const limit = Number(r.limit ?? 20)
      request = {
        op: 'find',
        ...base,
        filter: object(r.filter, 'filter') ?? {},
        projection: object(r.projection, 'projection'),
        sort: object(r.sort, 'sort'),
        limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20
      }
      break
    }
    case 'aggregate':
      if (!Array.isArray(r.pipeline)) throw new Error('pipeline must be an array')
      request = { op: 'aggregate', ...base, pipeline: r.pipeline }
      break
    case 'count':
      request = { op: 'count', ...base, filter: object(r.filter, 'filter') ?? {} }
      break
    case 'distinct':
      if (typeof r.field !== 'string') throw new Error('distinct needs a field')
      request = { op: 'distinct', ...base, field: r.field, filter: object(r.filter, 'filter') }
      break
    default:
      throw new Error('only find, aggregate, count and distinct can run for the assistant')
  }
  if (!mongoReadOnly(request)) throw new Error('$out and $merge write to collections')
  return request
}

const MONGO_WRITE =
  /\.\s*(insertOne|insertMany|insert|updateOne|updateMany|update|replaceOne|deleteOne|deleteMany|remove|drop|dropDatabase|dropIndex|dropIndexes|createIndex|createIndexes|createCollection|renameCollection|bulkWrite|findOneAndUpdate|findOneAndDelete|findOneAndReplace|findAndModify|runCommand|adminCommand)\s*\(|["']?\$(out|merge)["']?\s*:/

/**
 * What a MongoDB snippet would change, read from its text: shell code from the
 * model is never evaluated just to show a badge.
 */
export function mongoWriteHint(code: string): string | null {
  const m = MONGO_WRITE.exec(code)
  if (!m) return null
  return m[1] ? `Runs ${m[1]}` : `Writes with $${m[2]}`
}

/* ---------- Dashboards ---------- */

export const DASHBOARD_FENCE = 'dashboard'

export interface DashboardSpec {
  name: string
  refreshSecs: number
  widgets: {
    title: string
    kind: 'stat' | 'bar' | 'line' | 'table'
    query: string
    x: string | null
    y: string[]
    span: 1 | 2 | 3 | 4
  }[]
}

/** A ```dashboard block from the assistant, read as JSON. */
export function parseDashboardSpec(text: string): DashboardSpec {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('The dashboard isn’t valid JSON')
  }
  const d = (raw ?? {}) as Record<string, unknown>
  if (!Array.isArray(d.widgets) || !d.widgets.length)
    throw new Error('The dashboard has no widgets')
  const kinds = ['stat', 'bar', 'line', 'table'] as const
  const widgets = d.widgets.slice(0, 24).map((item: unknown) => {
    const w = (item ?? {}) as Record<string, unknown>
    const kind = kinds.find((k) => k === w.kind) ?? 'table'
    const span = Math.round(Number(w.span))
    return {
      title: typeof w.title === 'string' ? w.title.slice(0, 120) : '',
      kind,
      query: typeof w.query === 'string' ? w.query.trim() : '',
      x: typeof w.x === 'string' && w.x ? w.x : null,
      y: Array.isArray(w.y) ? w.y.filter((c): c is string => typeof c === 'string') : [],
      span: (span >= 1 && span <= 4 ? span : kind === 'stat' ? 1 : 2) as 1 | 2 | 3 | 4
    }
  })
  if (widgets.some((w) => !w.query)) throw new Error('A widget has no query')
  const refresh = Number(d.refreshSecs)
  return {
    name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 120) : 'Dashboard',
    refreshSecs: [30, 60, 300, 900].includes(refresh) ? refresh : 0,
    widgets
  }
}
