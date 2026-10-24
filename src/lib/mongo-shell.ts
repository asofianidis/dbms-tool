/**
 * A small mongosh-compatible front end. Scripts are evaluated as JavaScript
 * against a recording `db` object: every call such as
 * `db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(10)` becomes a
 * `MongoRequest` that runs on the server afterwards, in order. Results aren't
 * available to the script itself, which keeps evaluation synchronous, so
 * anything that reads them (`forEach`, `.length`, `if (n > 0)`) raises a
 * `ShellError` instead of quietly seeing nothing.
 */

import type { MongoCursorOptions, MongoRequest } from './api'
import { Ejson, shellHelpers, toEjson } from './ejson'

export type ShellOp =
  | { kind: 'request'; label: string; request: MongoRequest; single?: boolean }
  | { kind: 'use'; database: string }
  | { kind: 'show'; what: 'dbs' | 'collections'; database: string }
  | { kind: 'print'; text: string }

export class ShellError extends Error {}

/** Cursor methods that don't change which documents come back. */
const CURSOR_NOOPS = ['batchSize', 'noCursorTimeout', 'pretty', 'toArray']

const READ_PREFERENCES = [
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest'
]

function args(list: unknown[]): string {
  return list.length ? '…' : ''
}

function notAvailable(label: string, use: string): ShellError {
  return new ShellError(
    `${use} isn't supported here: ${label} runs on the server after the script has finished, ` +
      `so the script never sees its results. The results are listed in the output instead.`
  )
}

/** Options findAndModify takes as they are. */
const FIND_AND_MODIFY_OPTIONS = [
  'arrayFilters',
  'collation',
  'hint',
  'maxTimeMS',
  'bypassDocumentValidation',
  'comment'
]

function pick(options: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((k) => options[k] !== undefined).map((k) => [k, options[k]])
  )
}

function upsertOption(method: string, options: unknown): boolean | undefined {
  const upsert = checkOptions(method, options, ['upsert']).upsert
  return upsert === undefined ? undefined : !!upsert
}

/** Throws on option keys this shell would otherwise drop. */
function checkOptions(
  method: string,
  options: unknown,
  allowed: string[]
): Record<string, unknown> {
  if (options === undefined || options === null) return {}
  if (typeof options !== 'object' || Array.isArray(options))
    throw new ShellError(`${method}: options must be an object`)
  const unknown = Object.keys(options).filter((k) => !allowed.includes(k))
  if (unknown.length)
    throw new ShellError(
      `${method}: ${unknown.join(', ')} ${unknown.length === 1 ? 'isn’t' : 'aren’t'} supported in this shell` +
        (allowed.length ? ` (supported: ${allowed.join(', ')})` : '')
    )
  return options as Record<string, unknown>
}

const CURSOR_OPTIONS = [
  'hint',
  'maxTimeMS',
  'collation',
  'allowDiskUse',
  'comment',
  'readPreference',
  'readConcern'
]

/** `{ hint, maxTimeMS, … }` from a find/aggregate/count options argument. */
function cursorOptions(method: string, options: Record<string, unknown>): MongoCursorOptions {
  const out: MongoCursorOptions = {}
  if (options.hint !== undefined) out.hint = toEjson(options.hint)
  if (options.maxTimeMS !== undefined) out.maxTimeMS = Number(options.maxTimeMS)
  if (options.collation !== undefined) out.collation = toEjson(options.collation)
  if (options.allowDiskUse !== undefined) out.allowDiskUse = !!options.allowDiskUse
  if (options.comment !== undefined) out.comment = toEjson(options.comment)
  if (options.readPreference !== undefined)
    out.readPreference = readPreference(method, options.readPreference)
  if (options.readConcern !== undefined) {
    const rc = options.readConcern
    out.readConcern = String(rc && typeof rc === 'object' ? (rc as { level?: unknown }).level : rc)
  }
  return out
}

function readPreference(method: string, mode: unknown): string {
  const value =
    mode && typeof mode === 'object' ? (mode as { mode?: unknown }).mode : (mode as unknown)
  if (typeof value !== 'string' || !READ_PREFERENCES.includes(value))
    throw new ShellError(`${method}: read preference must be one of ${READ_PREFERENCES.join(', ')}`)
  return value
}

export function parseShell(script: string, database: string): ShellOp[] {
  const ops: ShellOp[] = []
  let current = database

  type RequestOp = { kind: 'request'; label: string; request: MongoRequest; single?: boolean }

  const push = (label: string, request: MongoRequest, single?: boolean): RequestOp => {
    const op = { kind: 'request' as const, label, request, single }
    ops.push(op)
    return op
  }

  /**
   * What a call hands back to the script: `methods` for chaining, and an error
   * for anything that would need the result, like `.length` or `n > 0`.
   */
  const pending = new WeakMap<object, () => string>()
  const placeholder = (label: () => string, methods: Record<string, unknown> = {}): unknown => {
    const proxy = new Proxy(methods, {
      get: (target, prop) => {
        if (prop === Symbol.toPrimitive || prop === 'valueOf' || prop === 'toString')
          return () => {
            throw notAvailable(label(), 'Using the result in an expression')
          }
        if (typeof prop === 'symbol') return undefined
        if (prop in target) return target[prop]
        if (prop === 'forEach' || prop === 'map')
          return () => {
            throw notAvailable(label(), `.${prop}()`)
          }
        throw notAvailable(label(), `Reading .${prop}`)
      }
    })
    pending.set(proxy, label)
    return proxy
  }
  const printable = (value: unknown): unknown => {
    const label = value && typeof value === 'object' ? pending.get(value) : undefined
    if (label) throw notAvailable(label(), 'Printing a result')
    return value
  }

  /** Sets a cursor option on the op's current request. */
  const setOption = (op: RequestOp, method: string, options: MongoCursorOptions): void => {
    const req = op.request
    if (req.op !== 'find' && req.op !== 'aggregate' && req.op !== 'count')
      throw new ShellError(`Call .${method}() before .explain()`)
    req.options = { ...req.options, ...options }
  }

  const optionMethods = (op: RequestOp, self: () => unknown): Record<string, unknown> => ({
    hint: (h: unknown) => (setOption(op, 'hint', { hint: toEjson(h) }), self()),
    maxTimeMS: (ms: number) => (setOption(op, 'maxTimeMS', { maxTimeMS: Number(ms) }), self()),
    collation: (c: unknown) => (setOption(op, 'collation', { collation: toEjson(c) }), self()),
    allowDiskUse: (allow = true) => (
      setOption(op, 'allowDiskUse', { allowDiskUse: !!allow }),
      self()
    ),
    comment: (c: unknown) => (setOption(op, 'comment', { comment: toEjson(c) }), self()),
    readPref: (mode: unknown, tags?: unknown) => {
      if (tags !== undefined) throw new ShellError('readPref: tag sets aren’t supported')
      setOption(op, 'readPref', { readPreference: readPreference('readPref', mode) })
      return self()
    },
    readConcern: (level: unknown) => (
      setOption(op, 'readConcern', { readConcern: String(level) }),
      self()
    )
  })

  /** Explain options shared by find and aggregate: the ones the server reads from the command. */
  const explainFields = (options: MongoCursorOptions | undefined): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    if (options?.hint !== undefined) out.hint = options.hint
    if (options?.collation !== undefined) out.collation = options.collation
    if (options?.maxTimeMS !== undefined) out.maxTimeMS = options.maxTimeMS
    if (options?.allowDiskUse !== undefined) out.allowDiskUse = options.allowDiskUse
    if (options?.comment !== undefined) out.comment = options.comment
    return out
  }

  const cursor = (op: RequestOp): unknown => {
    const handle: Record<string, unknown> = {}
    const self = (): unknown => proxy
    const req = op.request as Extract<MongoRequest, { op: 'find' }>
    handle.sort = (s: unknown) => ((req.sort = toEjson(s)), self())
    handle.limit = (n: number) => ((req.limit = n), self())
    handle.skip = (n: number) => ((req.skip = n), self())
    handle.projection = (p: unknown) => ((req.projection = toEjson(p)), self())
    handle.project = handle.projection
    handle.count = () => {
      const { allowDiskUse: _, ...options } = req.options ?? {}
      op.request = {
        op: 'count',
        database: req.database,
        collection: req.collection,
        filter: req.filter,
        ...(Object.keys(options).length ? { options } : {})
      }
      op.label = op.label.replace(/\.find\(/, '.count(')
      return self()
    }
    handle.size = handle.count
    handle.itcount = handle.count
    handle.explain = (verbosity = 'queryPlanner') => {
      const find: Record<string, unknown> = { find: req.collection, filter: req.filter ?? {} }
      if (req.sort) find.sort = req.sort
      if (req.projection) find.projection = req.projection
      if (req.limit) find.limit = req.limit
      if (req.skip) find.skip = req.skip
      Object.assign(find, explainFields(req.options))
      op.request = {
        op: 'runCommand',
        database: req.database,
        command: { explain: find, verbosity }
      }
      op.label += '.explain()'
      return self()
    }
    Object.assign(handle, optionMethods(op, self))
    for (const name of CURSOR_NOOPS) handle[name] = () => self()
    const proxy = placeholder(() => op.label, handle)
    return proxy
  }

  const aggregateCursor = (op: RequestOp): unknown => {
    const handle: Record<string, unknown> = {}
    const self = (): unknown => proxy
    handle.explain = (verbosity = 'queryPlanner') => {
      const req = op.request as Extract<MongoRequest, { op: 'aggregate' }>
      op.request = {
        op: 'runCommand',
        database: req.database,
        command: {
          explain: {
            aggregate: req.collection || 1,
            pipeline: req.pipeline,
            cursor: {},
            ...explainFields(req.options)
          },
          verbosity
        }
      }
      op.label += '.explain()'
      return self()
    }
    Object.assign(handle, optionMethods(op, self))
    for (const name of CURSOR_NOOPS) handle[name] = () => self()
    const proxy = placeholder(() => op.label, handle)
    return proxy
  }

  /** Wraps calls that record an op so their return value can't be read by mistake. */
  const recording = (methods: Record<string, (...a: never[]) => unknown>, prop: string) => {
    const fn = methods[prop]
    return (...a: never[]) => {
      const result = fn(...a)
      if (result && typeof result === 'object' && ops.includes(result as ShellOp)) {
        const op = result as ShellOp
        return placeholder(() => (op.kind === 'request' ? op.label : `show ${op.kind}`))
      }
      return result
    }
  }

  const collection = (dbName: () => string, name: string): unknown => {
    const database = (): string => dbName()
    const label = (method: string, a: unknown[]): string => `${name}.${method}(${args(a)})`
    /** find(filter, projection, options) and findOne(…) */
    const find = (method: string, filter: unknown, projection: unknown, opts: unknown) => {
      const o = checkOptions(method, opts, [
        'sort',
        'limit',
        'skip',
        'projection',
        'batchSize',
        'noCursorTimeout',
        ...CURSOR_OPTIONS
      ])
      const options = cursorOptions(method, o)
      const proj = projection ?? o.projection
      return {
        op: 'find' as const,
        database: database(),
        collection: name,
        filter: toEjson(filter ?? {}),
        projection: proj ? toEjson(proj) : undefined,
        ...(o.sort !== undefined ? { sort: toEjson(o.sort) } : {}),
        ...(o.skip !== undefined ? { skip: Number(o.skip) } : {}),
        ...(o.limit !== undefined ? { limit: Number(o.limit) } : {}),
        ...(Object.keys(options).length ? { options } : {})
      }
    }
    const count = (method: string, filter: unknown, opts: unknown): MongoRequest => {
      const options = cursorOptions(
        method,
        checkOptions(
          method,
          opts,
          CURSOR_OPTIONS.filter((k) => k !== 'allowDiskUse')
        )
      )
      return {
        op: 'count',
        database: database(),
        collection: name,
        filter: toEjson(filter ?? {}),
        ...(Object.keys(options).length ? { options } : {})
      }
    }
    const methods: Record<string, (...a: never[]) => unknown> = {
      find: (filter?: unknown, projection?: unknown, options?: unknown) =>
        cursor(push(label('find', [filter]), find('find', filter, projection, options))),
      findOne: (filter?: unknown, projection?: unknown, options?: unknown) =>
        cursor(
          push(
            label('findOne', [filter]),
            { ...find('findOne', filter, projection, options), limit: 1 },
            true
          )
        ),
      aggregate: (...a: unknown[]) => {
        const pipeline = Array.isArray(a[0]) ? (a[0] as unknown[]) : a
        const options = Array.isArray(a[0])
          ? cursorOptions(
              'aggregate',
              checkOptions('aggregate', a[1], [...CURSOR_OPTIONS, 'batchSize', 'cursor'])
            )
          : {}
        return aggregateCursor(
          push(label('aggregate', [pipeline]), {
            op: 'aggregate',
            database: database(),
            collection: name,
            pipeline: pipeline.map(toEjson),
            ...(Object.keys(options).length ? { options } : {})
          })
        )
      },
      countDocuments: (filter?: unknown, options?: unknown) =>
        push(label('countDocuments', [filter]), count('countDocuments', filter, options)),
      count: (filter?: unknown, options?: unknown) =>
        push(label('count', [filter]), count('count', filter, options)),
      estimatedDocumentCount: (options?: unknown) => {
        checkOptions('estimatedDocumentCount', options, ['maxTimeMS'])
        return push(label('estimatedDocumentCount', []), {
          op: 'count',
          database: database(),
          collection: name
        })
      },
      distinct: (field: string, filter?: unknown, options?: unknown) => {
        checkOptions('distinct', options, [])
        return push(label('distinct', [field]), {
          op: 'distinct',
          database: database(),
          collection: name,
          field,
          filter: toEjson(filter ?? {})
        })
      },
      insertOne: (document: unknown) =>
        push(label('insertOne', [document]), {
          op: 'insertOne',
          database: database(),
          collection: name,
          document: toEjson(document)
        }),
      insertMany: (documents: unknown[]) =>
        push(label('insertMany', [documents]), {
          op: 'insertMany',
          database: database(),
          collection: name,
          documents: (documents ?? []).map(toEjson)
        }),
      insert: (doc: unknown) =>
        Array.isArray(doc)
          ? push(label('insertMany', [doc]), {
              op: 'insertMany',
              database: database(),
              collection: name,
              documents: doc.map(toEjson)
            })
          : push(label('insertOne', [doc]), {
              op: 'insertOne',
              database: database(),
              collection: name,
              document: toEjson(doc)
            }),
      updateOne: (filter: unknown, update: unknown, options?: unknown) =>
        push(label('updateOne', [filter]), {
          op: 'updateOne',
          database: database(),
          collection: name,
          filter: toEjson(filter),
          update: toEjson(update),
          upsert: upsertOption('updateOne', options)
        }),
      updateMany: (filter: unknown, update: unknown, options?: unknown) =>
        push(label('updateMany', [filter]), {
          op: 'updateMany',
          database: database(),
          collection: name,
          filter: toEjson(filter),
          update: toEjson(update),
          upsert: upsertOption('updateMany', options)
        }),
      replaceOne: (filter: unknown, replacement: unknown, options?: unknown) =>
        push(label('replaceOne', [filter]), {
          op: 'replaceOne',
          database: database(),
          collection: name,
          filter: toEjson(filter),
          replacement: toEjson(replacement),
          upsert: upsertOption('replaceOne', options)
        }),
      deleteOne: (filter: unknown, options?: unknown) => {
        checkOptions('deleteOne', options, [])
        return push(label('deleteOne', [filter]), {
          op: 'deleteOne',
          database: database(),
          collection: name,
          filter: toEjson(filter ?? {})
        })
      },
      deleteMany: (filter: unknown, options?: unknown) => {
        checkOptions('deleteMany', options, [])
        if (filter === undefined)
          throw new ShellError('deleteMany needs a filter; use {} to delete every document')
        return push(label('deleteMany', [filter]), {
          op: 'deleteMany',
          database: database(),
          collection: name,
          filter: toEjson(filter)
        })
      },
      findOneAndUpdate: (filter: unknown, update: unknown, opts?: unknown) => {
        const options = checkOptions('findOneAndUpdate', opts, [
          'returnDocument',
          'returnNewDocument',
          'upsert',
          'sort',
          'projection',
          ...FIND_AND_MODIFY_OPTIONS
        ])
        return push(label('findOneAndUpdate', [filter]), {
          op: 'runCommand',
          database: database(),
          command: toEjson({
            findAndModify: name,
            query: filter,
            update,
            new: options.returnDocument === 'after' || options.returnNewDocument === true,
            upsert: options.upsert ?? false,
            ...(options.sort ? { sort: options.sort } : {}),
            ...(options.projection ? { fields: options.projection } : {}),
            ...pick(options, FIND_AND_MODIFY_OPTIONS)
          })
        })
      },
      findOneAndDelete: (filter: unknown, opts?: unknown) => {
        const options = checkOptions('findOneAndDelete', opts, [
          'sort',
          'projection',
          ...FIND_AND_MODIFY_OPTIONS
        ])
        return push(label('findOneAndDelete', [filter]), {
          op: 'runCommand',
          database: database(),
          command: toEjson({
            findAndModify: name,
            query: filter,
            remove: true,
            ...(options.sort ? { sort: options.sort } : {}),
            ...(options.projection ? { fields: options.projection } : {}),
            ...pick(options, FIND_AND_MODIFY_OPTIONS)
          })
        })
      },
      createIndex: (keys: unknown, options?: unknown) =>
        push(label('createIndex', [keys]), {
          op: 'createIndex',
          database: database(),
          collection: name,
          keys: toEjson(keys),
          options: options ? toEjson(options) : undefined
        }),
      dropIndex: (indexName: string) =>
        push(label('dropIndex', [indexName]), {
          op: 'dropIndex',
          database: database(),
          collection: name,
          name: indexName
        }),
      getIndexes: () =>
        push(label('getIndexes', []), {
          op: 'listIndexes',
          database: database(),
          collection: name
        }),
      drop: () =>
        push(label('drop', []), { op: 'dropCollection', database: database(), collection: name }),
      stats: () =>
        push(label('stats', []), {
          op: 'runCommand',
          database: database(),
          command: { collStats: name }
        }),
      renameCollection: (to: string) =>
        push(label('renameCollection', [to]), {
          op: 'runCommand',
          database: 'admin',
          command: { renameCollection: `${database()}.${name}`, to: `${database()}.${to}` }
        }),
      getName: () => name
    }
    return new Proxy(methods, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return undefined
        if (prop in target) return recording(target, prop)
        // db.system.profile → collection "system.profile"
        return collection(dbName, `${name}.${prop}`)
      }
    })
  }

  const dbProxy = (dbName: () => string): unknown => {
    const methods: Record<string, (...a: never[]) => unknown> = {
      getCollection: (n: string) => collection(dbName, n),
      getSiblingDB: (n: string) => dbProxy(() => n),
      getName: () => dbName(),
      runCommand: (command: unknown) =>
        push(`db.runCommand(…)`, {
          op: 'runCommand',
          database: dbName(),
          command: toEjson(command)
        }),
      adminCommand: (command: unknown) =>
        push(`db.adminCommand(…)`, {
          op: 'runCommand',
          database: 'admin',
          command: toEjson(command)
        }),
      createCollection: (n: string) =>
        push(`db.createCollection('${n}')`, {
          op: 'createCollection',
          database: dbName(),
          collection: n
        }),
      dropDatabase: () => push(`db.dropDatabase()`, { op: 'dropDatabase', database: dbName() }),
      getCollectionNames: () => {
        const op: ShellOp = { kind: 'show', what: 'collections', database: dbName() }
        ops.push(op)
        return op
      },
      getCollectionInfos: (filter?: unknown) =>
        push(`db.getCollectionInfos()`, {
          op: 'runCommand',
          database: dbName(),
          command: toEjson({ listCollections: 1, filter: filter ?? {} })
        }),
      stats: () =>
        push(`db.stats()`, { op: 'runCommand', database: dbName(), command: { dbStats: 1 } }),
      serverStatus: () =>
        push(`db.serverStatus()`, {
          op: 'runCommand',
          database: 'admin',
          command: { serverStatus: 1 }
        }),
      version: () =>
        push(`db.version()`, { op: 'runCommand', database: 'admin', command: { buildInfo: 1 } }),
      currentOp: () =>
        push(`db.currentOp()`, {
          op: 'aggregate',
          database: 'admin',
          collection: '',
          pipeline: [{ $currentOp: {} }]
        }),
      aggregate: (pipeline: unknown[]) =>
        aggregateCursor(
          push(`db.aggregate(…)`, {
            op: 'aggregate',
            database: dbName(),
            collection: '',
            pipeline: (pipeline ?? []).map(toEjson)
          })
        )
    }
    return new Proxy(methods, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return undefined
        if (prop in target) return recording(target, prop)
        return collection(dbName, prop)
      }
    })
  }

  // `use x` and `show …` aren't JavaScript; rewrite them into calls first
  const source = script
    .split('\n')
    .map((line) => {
      const use = line.match(/^\s*use\s+([^\s;]+)\s*;?\s*(\/\/.*)?$/)
      if (use) return `__use(${JSON.stringify(use[1])});`
      const show = line.match(/^\s*show\s+(dbs|databases|collections|tables)\s*;?\s*$/i)
      if (show) return `__show(${JSON.stringify(show[1].toLowerCase())});`
      return line
    })
    .join('\n')

  const builtins: Record<string, unknown> = {
    ...shellHelpers,
    db: dbProxy(() => current),
    __use: (name: string) => {
      current = name
      ops.push({ kind: 'use', database: name })
    },
    __show: (what: string) =>
      ops.push({
        kind: 'show',
        what: what === 'dbs' || what === 'databases' ? 'dbs' : 'collections',
        database: current
      }),
    print: (...values: unknown[]) =>
      ops.push({
        kind: 'print',
        text: values
          .map(printable)
          .map((v) => (typeof v === 'string' ? v : JSON.stringify(toEjson(v))))
          .join(' ')
      }),
    printjson: (value: unknown) =>
      ops.push({ kind: 'print', text: JSON.stringify(toEjson(printable(value)), null, 2) }),
    Ejson
  }
  const names = Object.keys(builtins)
  let fn: (...a: unknown[]) => unknown
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    fn = new Function(...names, `"use strict";\n${source}`) as typeof fn
  } catch (e) {
    throw new ShellError(`Syntax error: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    fn(...names.map((n) => builtins[n]))
  } catch (e) {
    if (e instanceof ShellError) throw e
    throw new ShellError(e instanceof Error ? e.message : String(e))
  }
  return ops
}

/** Methods offered after `db.<collection>.` in the editor. */
export const COLLECTION_METHODS = [
  'find',
  'findOne',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndDelete',
  'createIndex',
  'dropIndex',
  'getIndexes',
  'stats',
  'drop',
  'renameCollection'
]

export const DB_METHODS = [
  'getCollection',
  'getSiblingDB',
  'runCommand',
  'adminCommand',
  'createCollection',
  'dropDatabase',
  'getCollectionNames',
  'getCollectionInfos',
  'stats',
  'serverStatus',
  'version',
  'currentOp',
  'aggregate'
]

export const QUERY_OPERATORS = [
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$and',
  '$or',
  '$nor',
  '$not',
  '$exists',
  '$type',
  '$regex',
  '$options',
  '$elemMatch',
  '$size',
  '$all',
  '$expr',
  '$text',
  '$search',
  '$mod',
  '$near',
  '$geoWithin',
  // update
  '$set',
  '$unset',
  '$inc',
  '$mul',
  '$rename',
  '$min',
  '$max',
  '$push',
  '$pull',
  '$addToSet',
  '$pop',
  '$currentDate',
  '$setOnInsert',
  '$each',
  '$position',
  '$slice',
  '$sort',
  // aggregation stages
  '$match',
  '$project',
  '$group',
  '$sort',
  '$limit',
  '$skip',
  '$unwind',
  '$lookup',
  '$addFields',
  '$set',
  '$count',
  '$facet',
  '$bucket',
  '$bucketAuto',
  '$sample',
  '$replaceRoot',
  '$replaceWith',
  '$out',
  '$merge',
  '$unionWith',
  '$graphLookup',
  '$sortByCount',
  '$densify',
  '$fill',
  '$setWindowFields',
  '$redact',
  '$geoNear',
  '$documents',
  '$collStats',
  '$indexStats',
  // expressions
  '$sum',
  '$avg',
  '$first',
  '$last',
  '$push',
  '$concat',
  '$toUpper',
  '$toLower',
  '$substr',
  '$dateToString',
  '$cond',
  '$ifNull',
  '$size',
  '$arrayElemAt',
  '$filter',
  '$map',
  '$reduce',
  '$toString',
  '$toInt',
  '$toDate',
  '$objectToArray',
  '$mergeObjects',
  '$switch'
]

/** Shell expression for a collection: `db.users` or `db.getCollection('my-coll')`. */
export function shellCollection(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? `db.${name}`
    : `db.getCollection(${JSON.stringify(name)})`
}
