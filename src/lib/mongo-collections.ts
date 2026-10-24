import { bsonType, parseShellValue, type BsonType } from './ejson'

/**
 * Commands behind the collection dialogs: `create` with its options, `collMod`
 * for validation rules and `renameCollection`. All run through `runCommand`.
 */

export type CollectionKind = 'collection' | 'capped' | 'timeseries' | 'view'
export type ValidationLevel = 'strict' | 'moderate' | 'off'
export type ValidationAction = 'error' | 'warn'
export type Granularity = '' | 'seconds' | 'minutes' | 'hours'

export interface NewCollection {
  name: string
  kind: CollectionKind
  /** Capped: maximum size in bytes */
  size: string
  /** Capped: maximum number of documents (optional) */
  max: string
  timeField: string
  metaField: string
  granularity: Granularity
  /** Time series: delete documents this many seconds after their time field */
  expireAfterSeconds: string
  /** View: the source collection or view */
  viewOn: string
  /** View: pipeline in shell syntax */
  pipeline: string
  /** Validator in shell syntax; empty for none */
  validator: string
  validationLevel: ValidationLevel
  validationAction: ValidationAction
}

export function emptyCollection(name = ''): NewCollection {
  return {
    name,
    kind: 'collection',
    size: '',
    max: '',
    timeField: '',
    metaField: '',
    granularity: '',
    expireAfterSeconds: '',
    viewOn: '',
    pipeline: '[]',
    validator: '',
    validationLevel: 'strict',
    validationAction: 'error'
  }
}

/** Why `name` can't name a collection, or null when it can. */
export function collectionNameError(name: string): string | null {
  if (!name.trim()) return 'Enter a name'
  if (name !== name.trim()) return "Names can't start or end with spaces"
  if (name.includes('$')) return "Names can't contain $"
  if (name.includes('\0')) return "Names can't contain null characters"
  if (name.startsWith('system.')) return 'The system. prefix is reserved'
  return null
}

function positiveInt(text: string, what: string): number {
  const n = Number(text.trim())
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} must be a whole number above 0`)
  return n
}

function parseObject(text: string, what: string): Record<string, unknown> {
  let value: unknown
  try {
    value = parseShellValue(text)
  } catch (e) {
    throw new Error(`${what}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${what} must be a document, like { $jsonSchema: { … } }`)
  return value as Record<string, unknown>
}

/** The `create` command for `spec`; throws with a readable message when a field is invalid. */
export function createCommand(spec: NewCollection): Record<string, unknown> {
  const nameError = collectionNameError(spec.name)
  if (nameError) throw new Error(nameError)
  const command: Record<string, unknown> = { create: spec.name }
  switch (spec.kind) {
    case 'capped':
      command.capped = true
      command.size = positiveInt(spec.size, 'Size')
      if (spec.max.trim()) command.max = positiveInt(spec.max, 'Maximum documents')
      break
    case 'timeseries': {
      if (!spec.timeField.trim()) throw new Error('Time series collections need a time field')
      const timeseries: Record<string, unknown> = { timeField: spec.timeField.trim() }
      if (spec.metaField.trim()) timeseries.metaField = spec.metaField.trim()
      if (spec.granularity) timeseries.granularity = spec.granularity
      command.timeseries = timeseries
      if (spec.expireAfterSeconds.trim())
        command.expireAfterSeconds = positiveInt(spec.expireAfterSeconds, 'Expire after')
      break
    }
    case 'view': {
      if (!spec.viewOn.trim()) throw new Error('Choose the collection the view reads from')
      let pipeline: unknown
      try {
        pipeline = parseShellValue(spec.pipeline.trim() || '[]')
      } catch (e) {
        throw new Error(`Pipeline: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (!Array.isArray(pipeline)) throw new Error('The pipeline must be an array of stages')
      command.viewOn = spec.viewOn.trim()
      command.pipeline = pipeline
      // Views can't have validators
      return command
    }
  }
  if (spec.validator.trim()) {
    command.validator = parseObject(spec.validator, 'Validator')
    command.validationLevel = spec.validationLevel
    command.validationAction = spec.validationAction
  }
  return command
}

export interface Validation {
  validator: Record<string, unknown> | null
  level: ValidationLevel
  action: ValidationAction
}

/** The validation rules in a `listCollections` entry. */
export function readValidation(info: unknown): Validation {
  const options = ((info as { options?: unknown } | null)?.options ?? {}) as Record<string, unknown>
  const validator = options.validator
  return {
    validator:
      validator && typeof validator === 'object' && Object.keys(validator).length
        ? (validator as Record<string, unknown>)
        : null,
    level: (options.validationLevel as ValidationLevel | undefined) ?? 'strict',
    action: (options.validationAction as ValidationAction | undefined) ?? 'error'
  }
}

/** `collMod` that replaces the rules; empty `validator` text removes them. */
export function validationCommand(
  collection: string,
  validator: string,
  level: ValidationLevel,
  action: ValidationAction
): Record<string, unknown> {
  return {
    collMod: collection,
    validator: validator.trim() ? parseObject(validator, 'Validator') : {},
    validationLevel: level,
    validationAction: action
  }
}

/** Runs on `admin`. */
export function renameCommand(
  database: string,
  from: string,
  to: string,
  dropTarget = false
): Record<string, unknown> {
  const nameError = collectionNameError(to)
  if (nameError) throw new Error(nameError)
  return { renameCollection: `${database}.${from}`, to: `${database}.${to}`, dropTarget }
}

/* ---------- $jsonSchema from sample documents ---------- */

const SCHEMA_TYPES: Partial<Record<BsonType, string>> = {
  ObjectId: 'objectId',
  String: 'string',
  Int32: 'int',
  Int64: 'long',
  Double: 'double',
  Decimal128: 'decimal',
  Boolean: 'bool',
  Date: 'date',
  Null: 'null',
  Array: 'array',
  Object: 'object',
  Binary: 'binData',
  UUID: 'binData',
  Regex: 'regex',
  Timestamp: 'timestamp',
  MinKey: 'minKey',
  MaxKey: 'maxKey',
  Symbol: 'symbol',
  Code: 'javascript'
}

const NUMERIC = new Set(['int', 'long', 'double', 'decimal'])

function typeSpec(types: Set<string>): string | string[] {
  const list = [...types]
  // Mixed integer and floating point values usually mean "a number"
  if (list.length > 1 && list.every((t) => NUMERIC.has(t))) return 'number'
  if (list.length > 1 && list.filter((t) => t !== 'null').every((t) => NUMERIC.has(t)))
    return ['number', 'null']
  return list.length === 1 ? list[0] : list
}

/**
 * A starting `$jsonSchema` for documents like `docs`: each field's observed types,
 * and the fields every document has marked required. Nested documents recurse to `depth`.
 */
export function schemaFromSample(
  docs: Record<string, unknown>[],
  depth = 3
): Record<string, unknown> {
  const types = new Map<string, Set<string>>()
  const seen = new Map<string, number>()
  const nested = new Map<string, Record<string, unknown>[]>()
  const items = new Map<string, Set<string>>()
  for (const doc of docs) {
    for (const [key, value] of Object.entries(doc)) {
      const t = SCHEMA_TYPES[bsonType(value)] ?? 'string'
      if (!types.has(key)) types.set(key, new Set())
      types.get(key)!.add(t)
      seen.set(key, (seen.get(key) ?? 0) + 1)
      if (t === 'object') {
        if (!nested.has(key)) nested.set(key, [])
        nested.get(key)!.push(value as Record<string, unknown>)
      }
      if (t === 'array') {
        if (!items.has(key)) items.set(key, new Set())
        for (const item of value as unknown[])
          items.get(key)!.add(SCHEMA_TYPES[bsonType(item)] ?? 'string')
      }
    }
  }
  const properties: Record<string, unknown> = {}
  for (const [key, set] of types) {
    const prop: Record<string, unknown> = { bsonType: typeSpec(set) }
    const subDocs = nested.get(key)
    if (set.size === 1 && subDocs && depth > 1) {
      const sub = schemaFromSample(subDocs, depth - 1)
      if (sub.properties) Object.assign(prop, sub)
    }
    const itemTypes = items.get(key)
    if (set.size === 1 && itemTypes?.size) prop.items = { bsonType: typeSpec(itemTypes) }
    properties[key] = prop
  }
  const required = [...seen].filter(([, n]) => n === docs.length).map(([k]) => k)
  return {
    bsonType: 'object',
    ...(required.length ? { required } : {}),
    ...(types.size ? { properties } : {})
  }
}
