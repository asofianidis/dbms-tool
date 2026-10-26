/**
 * Form models for the aggregation designer. A stage's shell text stays the
 * source of truth: `stageForm` reads it into a form when the form can show it
 * exactly, and `formText` writes the form back, so switching between the form
 * and the code editor never loses anything.
 */

import { bsonType, parseShellValue, toShell } from './ejson'

type Json = ReturnType<typeof parseShellValue>
type Doc = { [key: string]: Json }

export type StageCategory = 'Filter & shape' | 'Group & sort' | 'Join & reshape' | 'Output'

export const STAGE_INFO: Record<string, { category: StageCategory; description: string }> = {
  $match: { category: 'Filter & shape', description: 'Keep documents that match conditions' },
  $project: { category: 'Filter & shape', description: 'Pick, drop or compute fields' },
  $addFields: { category: 'Filter & shape', description: 'Add computed fields' },
  $set: { category: 'Filter & shape', description: 'Add or overwrite fields' },
  $unset: { category: 'Filter & shape', description: 'Remove fields' },
  $limit: { category: 'Filter & shape', description: 'Keep the first N documents' },
  $skip: { category: 'Filter & shape', description: 'Skip the first N documents' },
  $sample: { category: 'Filter & shape', description: 'Pick N random documents' },
  $group: { category: 'Group & sort', description: 'Group by keys and aggregate values' },
  $sort: { category: 'Group & sort', description: 'Order documents' },
  $count: { category: 'Group & sort', description: 'Count documents into one field' },
  $sortByCount: {
    category: 'Group & sort',
    description: 'Group by a field and count, largest first'
  },
  $bucket: { category: 'Group & sort', description: 'Group into ranges' },
  $facet: { category: 'Group & sort', description: 'Run several sub-pipelines at once' },
  $setWindowFields: {
    category: 'Group & sort',
    description: 'Running totals, ranks, moving averages'
  },
  $densify: { category: 'Group & sort', description: 'Fill gaps in a sequence' },
  $lookup: { category: 'Join & reshape', description: 'Join documents from another collection' },
  $graphLookup: { category: 'Join & reshape', description: 'Follow references recursively' },
  $unwind: { category: 'Join & reshape', description: 'One document per array element' },
  $unionWith: {
    category: 'Join & reshape',
    description: 'Append documents from another collection'
  },
  $replaceRoot: { category: 'Join & reshape', description: 'Promote an embedded document' },
  $replaceWith: {
    category: 'Join & reshape',
    description: 'Replace each document with an expression'
  },
  $out: { category: 'Output', description: 'Write results to a collection, replacing it' },
  $merge: { category: 'Output', description: 'Merge results into a collection' }
}

/* ---------- Values typed into form boxes ---------- */

// Text that reads as a shell literal: numbers, booleans, null, quoted strings,
// arrays, documents, regexes and helpers like ObjectId('…')
const LITERAL =
  /^(-?(\d|\.\d|Infinity)|NaN$|true$|false$|null$|["'`[{]|\/.+\/[a-z]*$|[A-Z][A-Za-z0-9]*\()/

/** A form value box's text → EJSON. Literals are evaluated; anything else is a plain string. */
export function valueFromText(text: string): Json {
  const trimmed = text.trim()
  if (LITERAL.test(trimmed)) {
    try {
      return parseShellValue(trimmed)
    } catch {
      // Not valid shell syntax after all: keep it as typed
    }
  }
  return text
}

/** EJSON → a value box's text. Strings show bare unless they'd read back as something else. */
export function valueToText(v: Json): string {
  if (typeof v === 'string') return valueFromText(v) === v ? v : JSON.stringify(v)
  return toShell(v, 0)
}

/** Shell text for a stage body: one line when short, indented otherwise. */
export function bodyText(v: Json): string {
  const line = toShell(v, 0)
  return line.length <= 64 ? line : toShell(v, 2)
}

function isDoc(v: Json): v is Doc {
  return bsonType(v) === 'Object'
}

/**
 * `$exists`'s argument as MongoDB reads it: false, null and zero (in any number type)
 * mean "missing"; anything else, even an empty string, means "present".
 */
export function existsFlag(v: Json): boolean {
  switch (bsonType(v)) {
    case 'Null':
    case 'Undefined':
      return false
    case 'Boolean':
      return v === true
    case 'Int32':
    case 'Int64':
    case 'Double':
    case 'Decimal128': {
      const n = typeof v === 'number' ? v : Number(Object.values(v as Doc)[0])
      return n !== 0
    }
    default:
      return true
  }
}

/** A form's `$exists` value text (`true`, `false`, `0`, …) → whether the field must exist. */
export function existsText(text: string): boolean {
  return existsFlag(valueFromText(text))
}

/** `'$price'` → `price`; null for anything that isn't a plain field path. */
function refField(v: Json): string | null {
  return typeof v === 'string' && v.startsWith('$') && !v.startsWith('$$') && v.length > 1
    ? v.slice(1)
    : null
}

function numberText(v: Json): string | null {
  if (typeof v === 'number') return String(v)
  const t = bsonType(v)
  if (t === 'Int64' || t === 'Int32' || t === 'Double') return valueToText(v)
  return null
}

function numberValue(text: string): Json {
  const n = Number(text.trim())
  return text.trim() && Number.isFinite(n) ? n : valueFromText(text)
}

/* ---------- Forms ---------- */

export type MatchOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'exists' | 'regex'

export const MATCH_OPS: { value: MatchOp; label: string }[] = [
  { value: 'eq', label: '=' },
  { value: 'ne', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'in', label: 'in' },
  { value: 'nin', label: 'not in' },
  { value: 'exists', label: 'exists' },
  { value: 'regex', label: 'matches regex' }
]

export interface MatchCondition {
  field: string
  op: MatchOp
  value: string
  /** Regex flags such as `i` */
  options?: string
}

export interface ProjectField {
  field: string
  kind: 'include' | 'exclude' | 'expr'
  expr: string
}

export const ACCUMULATORS = [
  '$sum',
  '$avg',
  '$min',
  '$max',
  '$count',
  '$first',
  '$last',
  '$push',
  '$addToSet',
  '$stdDevPop',
  '$stdDevSamp'
] as const

export type Accumulator = (typeof ACCUMULATORS)[number]

export interface GroupKey {
  /** Output name under `_id`; empty groups by the bare field (`_id: '$field'`) */
  alias: string
  field: string
}

export interface GroupOutput {
  name: string
  op: Accumulator
  expr: string
}

export type StageForm =
  | { kind: 'match'; combine: 'and' | 'or'; conditions: MatchCondition[] }
  | { kind: 'project'; fields: ProjectField[] }
  | { kind: 'addFields'; fields: { field: string; expr: string }[] }
  | { kind: 'unset'; fields: string[] }
  | { kind: 'group'; keys: GroupKey[]; outputs: GroupOutput[] }
  | { kind: 'sort'; keys: { field: string; dir: 1 | -1 }[] }
  | { kind: 'number'; value: string }
  | { kind: 'sample'; size: string }
  | { kind: 'name'; value: string }
  | { kind: 'field'; field: string }
  | {
      kind: 'unwind'
      path: string
      preserveNullAndEmptyArrays: boolean
      includeArrayIndex: string
    }
  | { kind: 'lookup'; from: string; localField: string; foreignField: string; as: string }

/** Operators the form can edit. */
export const FORM_OPERATORS = new Set([
  '$match',
  '$project',
  '$addFields',
  '$set',
  '$unset',
  '$group',
  '$sort',
  '$limit',
  '$skip',
  '$sample',
  '$count',
  '$sortByCount',
  '$unwind',
  '$lookup',
  '$out'
])

const OP_KEYS: Record<string, MatchOp> = {
  $eq: 'eq',
  $ne: 'ne',
  $gt: 'gt',
  $gte: 'gte',
  $lt: 'lt',
  $lte: 'lte',
  $in: 'in',
  $nin: 'nin',
  $exists: 'exists'
}

function listText(v: Json): string {
  if (!Array.isArray(v)) return valueToText(v)
  const items = v.map(valueToText)
  return items.some((t) => t.includes(',')) ? toShell(v, 0) : items.join(', ')
}

function listValue(text: string): Json {
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) return valueFromText(trimmed)
  return trimmed ? trimmed.split(',').map((t) => valueFromText(t.trim())) : []
}

function fieldConditions(doc: Doc): MatchCondition[] | null {
  const out: MatchCondition[] = []
  for (const [field, v] of Object.entries(doc)) {
    if (field.startsWith('$')) return null
    const ops = isDoc(v) ? Object.keys(v) : []
    if (!ops.length || !ops.every((k) => k.startsWith('$'))) {
      out.push({ field, op: 'eq', value: valueToText(v) })
      continue
    }
    const o = v as Doc
    for (const key of ops) {
      if (key === '$options') {
        if (!('$regex' in o)) return null
        continue
      }
      if (key === '$regex') {
        if (typeof o.$regex !== 'string') return null
        const options = o.$options
        if (options !== undefined && typeof options !== 'string') return null
        out.push({ field, op: 'regex', value: o.$regex, options: options ?? '' })
        continue
      }
      const op = OP_KEYS[key]
      if (!op) return null
      const value =
        op === 'in' || op === 'nin'
          ? Array.isArray(o[key])
            ? listText(o[key])
            : null
          : op === 'exists'
            ? String(existsFlag(o[key]))
            : valueToText(o[key])
      if (value === null) return null
      out.push({ field, op, value })
    }
  }
  return out
}

function parseMatch(body: Json): StageForm | null {
  if (!isDoc(body)) return null
  const keys = Object.keys(body)
  if (keys.length === 1 && (keys[0] === '$or' || keys[0] === '$and')) {
    const items = body[keys[0]]
    if (!Array.isArray(items) || !items.every(isDoc)) return null
    const parts = items.map((d) => fieldConditions(d as Doc))
    if (parts.some((p) => p === null)) return null
    // Each $or branch has to be a single condition for the form to show it
    if (keys[0] === '$or' && parts.some((p) => p!.length !== 1)) return null
    return {
      kind: 'match',
      combine: keys[0] === '$or' ? 'or' : 'and',
      conditions: parts.flat() as MatchCondition[]
    }
  }
  const conditions = fieldConditions(body)
  return conditions && { kind: 'match', combine: 'and', conditions }
}

function conditionOp(c: MatchCondition): Doc {
  switch (c.op) {
    case 'regex':
      return c.options ? { $regex: c.value, $options: c.options } : { $regex: c.value }
    case 'in':
    case 'nin':
      return { [`$${c.op}`]: listValue(c.value) }
    case 'exists':
      return { $exists: existsText(c.value) }
    default:
      return { [`$${c.op}`]: valueFromText(c.value) }
  }
}

function single(c: MatchCondition): Doc {
  return { [c.field]: c.op === 'eq' ? valueFromText(c.value) : conditionOp(c) }
}

function matchBody(combine: 'and' | 'or', conditions: MatchCondition[]): Json {
  const list = conditions.filter((c) => c.field.trim())
  if (combine === 'or') return list.length ? { $or: list.map(single) } : {}
  const byField = new Map<string, MatchCondition[]>()
  for (const c of list) byField.set(c.field, [...(byField.get(c.field) ?? []), c])
  const out: Doc = {}
  for (const [field, group] of byField) {
    if (group.length === 1) {
      Object.assign(out, single(group[0]))
      continue
    }
    const merged: Doc = {}
    for (const c of group) {
      const op = c.op === 'eq' ? { $eq: valueFromText(c.value) } : conditionOp(c)
      // The same operator twice on one field can't share a document
      if (Object.keys(op).some((k) => k in merged)) return { $and: list.map(single) }
      Object.assign(merged, op)
    }
    out[field] = merged
  }
  return out
}

function parseGroup(body: Json): StageForm | null {
  if (!isDoc(body) || !('_id' in body)) return null
  const id = body._id
  let keys: GroupKey[]
  if (id === null) keys = []
  else if (refField(id)) keys = [{ alias: '', field: refField(id)! }]
  else if (
    isDoc(id) &&
    Object.entries(id).every(([alias, v]) => !alias.startsWith('$') && refField(v))
  )
    keys = Object.entries(id).map(([alias, v]) => ({ alias, field: refField(v)! }))
  else return null
  const outputs: GroupOutput[] = []
  for (const [name, v] of Object.entries(body)) {
    if (name === '_id') continue
    if (!isDoc(v) || Object.keys(v).length !== 1) return null
    const [op, arg] = Object.entries(v)[0]
    if (!(ACCUMULATORS as readonly string[]).includes(op)) return null
    if (op === '$count' && !(isDoc(arg) && !Object.keys(arg).length)) return null
    outputs.push({ name, op: op as Accumulator, expr: op === '$count' ? '' : valueToText(arg) })
  }
  return { kind: 'group', keys, outputs }
}

function groupBody(keys: GroupKey[], outputs: GroupOutput[]): Json {
  const list = keys.filter((k) => k.field.trim())
  const id: Json =
    list.length === 0
      ? null
      : list.length === 1 && !list[0].alias.trim()
        ? `$${list[0].field}`
        : Object.fromEntries(
            list.map((k) => [k.alias.trim() || k.field.replace(/\./g, '_'), `$${k.field}`])
          )
  const out: Doc = { _id: id }
  for (const o of outputs) {
    if (!o.name.trim()) continue
    const arg: Json =
      o.op === '$count' ? {} : o.expr.trim() ? valueFromText(o.expr) : o.op === '$sum' ? 1 : null
    out[o.name.trim()] = { [o.op]: arg }
  }
  return out
}

function stringList(v: Json): string[] | null {
  if (typeof v === 'string') return [v]
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[]
  return null
}

function onlyKeys(doc: Doc, allowed: string[]): boolean {
  return Object.keys(doc).every((k) => allowed.includes(k))
}

/** The form for a stage body, or null when the form can't represent it exactly. */
export function stageForm(operator: string, body: Json): StageForm | null {
  switch (operator) {
    case '$match':
      return parseMatch(body)
    case '$project': {
      if (!isDoc(body)) return null
      return {
        kind: 'project',
        fields: Object.entries(body).map(([field, v]) =>
          v === 1 || v === true
            ? { field, kind: 'include', expr: '' }
            : v === 0 || v === false
              ? { field, kind: 'exclude', expr: '' }
              : { field, kind: 'expr', expr: valueToText(v) }
        )
      }
    }
    case '$addFields':
    case '$set':
      if (!isDoc(body)) return null
      return {
        kind: 'addFields',
        fields: Object.entries(body).map(([field, v]) => ({ field, expr: valueToText(v) }))
      }
    case '$unset': {
      const fields = stringList(body)
      return fields && { kind: 'unset', fields }
    }
    case '$group':
      return parseGroup(body)
    case '$sort': {
      if (!isDoc(body) || !Object.values(body).every((v) => v === 1 || v === -1)) return null
      return {
        kind: 'sort',
        keys: Object.entries(body).map(([field, dir]) => ({ field, dir: dir as 1 | -1 }))
      }
    }
    case '$limit':
    case '$skip': {
      const value = numberText(body)
      return value === null ? null : { kind: 'number', value }
    }
    case '$sample': {
      if (!isDoc(body) || !onlyKeys(body, ['size'])) return null
      const size = numberText(body.size)
      return size === null ? null : { kind: 'sample', size }
    }
    case '$count':
    case '$out':
      return typeof body === 'string' ? { kind: 'name', value: body } : null
    case '$sortByCount': {
      const field = refField(body)
      return field === null ? null : { kind: 'field', field }
    }
    case '$unwind': {
      if (refField(body))
        return {
          kind: 'unwind',
          path: refField(body)!,
          preserveNullAndEmptyArrays: false,
          includeArrayIndex: ''
        }
      if (
        !isDoc(body) ||
        !onlyKeys(body, ['path', 'preserveNullAndEmptyArrays', 'includeArrayIndex'])
      )
        return null
      const path = refField(body.path)
      const preserve = body.preserveNullAndEmptyArrays ?? false
      const index = body.includeArrayIndex ?? ''
      if (path === null || typeof preserve !== 'boolean' || typeof index !== 'string') return null
      return {
        kind: 'unwind',
        path,
        preserveNullAndEmptyArrays: preserve,
        includeArrayIndex: index
      }
    }
    case '$lookup': {
      const keys = ['from', 'localField', 'foreignField', 'as']
      if (
        !isDoc(body) ||
        Object.keys(body).length !== 4 ||
        !keys.every((k) => typeof body[k] === 'string')
      )
        return null
      return {
        kind: 'lookup',
        from: body.from as string,
        localField: body.localField as string,
        foreignField: body.foreignField as string,
        as: body.as as string
      }
    }
    default:
      return null
  }
}

/** The stage body a form describes. */
export function formBody(form: StageForm): Json {
  switch (form.kind) {
    case 'match':
      return matchBody(form.combine, form.conditions)
    case 'project':
      return Object.fromEntries(
        form.fields
          .filter((f) => f.field.trim())
          .map((f) => [
            f.field.trim(),
            f.kind === 'include' ? 1 : f.kind === 'exclude' ? 0 : valueFromText(f.expr)
          ])
      )
    case 'addFields':
      return Object.fromEntries(
        form.fields
          .filter((f) => f.field.trim())
          .map((f) => [f.field.trim(), valueFromText(f.expr)])
      )
    case 'unset': {
      const fields = form.fields.map((f) => f.trim()).filter(Boolean)
      return fields.length === 1 ? fields[0] : fields
    }
    case 'group':
      return groupBody(form.keys, form.outputs)
    case 'sort':
      return Object.fromEntries(
        form.keys.filter((k) => k.field.trim()).map((k) => [k.field.trim(), k.dir])
      )
    case 'number':
      return numberValue(form.value)
    case 'sample':
      return { size: numberValue(form.size) }
    case 'name':
      return form.value
    case 'field':
      return `$${form.field}`
    case 'unwind': {
      if (!form.preserveNullAndEmptyArrays && !form.includeArrayIndex.trim()) return `$${form.path}`
      const out: Doc = { path: `$${form.path}` }
      if (form.includeArrayIndex.trim()) out.includeArrayIndex = form.includeArrayIndex.trim()
      if (form.preserveNullAndEmptyArrays) out.preserveNullAndEmptyArrays = true
      return out
    }
    case 'lookup':
      return {
        from: form.from,
        localField: form.localField,
        foreignField: form.foreignField,
        as: form.as
      }
  }
}

export function formText(form: StageForm): string {
  return bodyText(formBody(form))
}

/** Stages that write to a collection, so previews, explain and export skip or refuse them */
export const WRITE_STAGES: ReadonlySet<string> = new Set(['$out', '$merge'])

/** Whether a built stage document (`{ $out: … }`) writes. */
export function isWriteStage(stage: unknown): boolean {
  return !!stage && typeof stage === 'object' && Object.keys(stage).some((k) => WRITE_STAGES.has(k))
}

/** Dotted field paths seen in documents, for field pickers. */
export function fieldPaths(documents: unknown[], maxDepth = 3, max = 400): string[] {
  const paths = new Set<string>()
  const visit = (v: unknown, prefix: string, depth: number): void => {
    if (paths.size >= max) return
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 10)) visit(item, prefix, depth)
      return
    }
    if (bsonType(v) !== 'Object') return
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k
      paths.add(path)
      if (depth < maxDepth) visit(child, path, depth + 1)
    }
  }
  for (const doc of documents.slice(0, 200)) visit(doc, '', 1)
  return [...paths].sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : a.localeCompare(b)))
}

/**
 * Stages from pasted pipeline text: a `[...]` array, or a whole
 * `db.coll.aggregate([...])` call.
 */
export function parsePipeline(text: string): { operator: string; body: string }[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('Paste a pipeline array: [{ $match: … }, …]')
  const value = parseShellValue(text.slice(start, end + 1))
  if (!Array.isArray(value)) throw new Error('Expected an array of stages')
  return value.map((stage, i) => {
    const keys = isDoc(stage) ? Object.keys(stage) : []
    if (keys.length !== 1 || !keys[0].startsWith('$'))
      throw new Error(`Stage ${i + 1} should be a document with one $operator`)
    return { operator: keys[0], body: bodyText((stage as Doc)[keys[0]]) }
  })
}
