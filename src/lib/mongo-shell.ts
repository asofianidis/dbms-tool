/**
 * A small mongosh-compatible front end. Scripts are evaluated as JavaScript
 * against a recording `db` object: every call such as
 * `db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(10)` becomes a
 * `MongoRequest` that runs on the server afterwards, in order. Results aren't
 * available to the script itself, which keeps evaluation synchronous.
 */

import type { MongoRequest } from './api'
import { Ejson, shellHelpers, toEjson } from './ejson'

export type ShellOp =
  | { kind: 'request'; label: string; request: MongoRequest; single?: boolean }
  | { kind: 'use'; database: string }
  | { kind: 'show'; what: 'dbs' | 'collections'; database: string }
  | { kind: 'print'; text: string }

export class ShellError extends Error {}

const CURSOR_NOOPS = [
  'batchSize',
  'collation',
  'comment',
  'hint',
  'maxTimeMS',
  'noCursorTimeout',
  'readPref',
  'allowDiskUse',
  'readConcern',
  'pretty',
  'toArray',
  'forEach',
  'map'
]

function args(list: unknown[]): string {
  return list.length ? '…' : ''
}

export function parseShell(script: string, database: string): ShellOp[] {
  const ops: ShellOp[] = []
  let current = database

  const push = (
    label: string,
    request: MongoRequest,
    single?: boolean
  ): { kind: 'request'; label: string; request: MongoRequest; single?: boolean } => {
    const op = { kind: 'request' as const, label, request, single }
    ops.push(op)
    return op
  }

  const cursor = (op: ReturnType<typeof push>): unknown => {
    const handle: Record<string, unknown> = {}
    const req = op.request as Extract<MongoRequest, { op: 'find' }>
    handle.sort = (s: unknown) => ((req.sort = toEjson(s)), handle)
    handle.limit = (n: number) => ((req.limit = n), handle)
    handle.skip = (n: number) => ((req.skip = n), handle)
    handle.projection = (p: unknown) => ((req.projection = toEjson(p)), handle)
    handle.project = handle.projection
    handle.count = () => {
      op.request = {
        op: 'count',
        database: req.database,
        collection: req.collection,
        filter: req.filter
      }
      op.label = op.label.replace(/\.find\(/, '.count(')
      return handle
    }
    handle.size = handle.count
    handle.itcount = handle.count
    handle.explain = (verbosity = 'queryPlanner') => {
      const find: Record<string, unknown> = { find: req.collection, filter: req.filter ?? {} }
      if (req.sort) find.sort = req.sort
      if (req.projection) find.projection = req.projection
      if (req.limit) find.limit = req.limit
      if (req.skip) find.skip = req.skip
      op.request = {
        op: 'runCommand',
        database: req.database,
        command: { explain: find, verbosity }
      }
      op.label += '.explain()'
      return handle
    }
    for (const name of CURSOR_NOOPS) handle[name] = () => handle
    return handle
  }

  const aggregateCursor = (op: ReturnType<typeof push>): unknown => {
    const handle: Record<string, unknown> = {}
    handle.explain = (verbosity = 'queryPlanner') => {
      const req = op.request as Extract<MongoRequest, { op: 'aggregate' }>
      op.request = {
        op: 'runCommand',
        database: req.database,
        command: {
          explain: { aggregate: req.collection || 1, pipeline: req.pipeline, cursor: {} },
          verbosity
        }
      }
      op.label += '.explain()'
      return handle
    }
    for (const name of CURSOR_NOOPS) handle[name] = () => handle
    return handle
  }

  const collection = (dbName: () => string, name: string): unknown => {
    const database = (): string => dbName()
    const label = (method: string, a: unknown[]): string => `${name}.${method}(${args(a)})`
    const methods: Record<string, (...a: never[]) => unknown> = {
      find: (filter?: unknown, projection?: unknown) =>
        cursor(
          push(label('find', [filter]), {
            op: 'find',
            database: database(),
            collection: name,
            filter: toEjson(filter ?? {}),
            projection: projection ? toEjson(projection) : undefined
          })
        ),
      findOne: (filter?: unknown, projection?: unknown) =>
        cursor(
          push(
            label('findOne', [filter]),
            {
              op: 'find',
              database: database(),
              collection: name,
              filter: toEjson(filter ?? {}),
              projection: projection ? toEjson(projection) : undefined,
              limit: 1
            },
            true
          )
        ),
      aggregate: (...a: unknown[]) => {
        const pipeline = Array.isArray(a[0]) ? (a[0] as unknown[]) : a
        return aggregateCursor(
          push(label('aggregate', [pipeline]), {
            op: 'aggregate',
            database: database(),
            collection: name,
            pipeline: pipeline.map(toEjson)
          })
        )
      },
      countDocuments: (filter?: unknown) =>
        push(label('countDocuments', [filter]), {
          op: 'count',
          database: database(),
          collection: name,
          filter: toEjson(filter ?? {})
        }),
      count: (filter?: unknown) =>
        push(label('count', [filter]), {
          op: 'count',
          database: database(),
          collection: name,
          filter: toEjson(filter ?? {})
        }),
      estimatedDocumentCount: () =>
        push(label('estimatedDocumentCount', []), {
          op: 'count',
          database: database(),
          collection: name
        }),
      distinct: (field: string, filter?: unknown) =>
        push(label('distinct', [field]), {
          op: 'distinct',
          database: database(),
          collection: name,
          field,
          filter: toEjson(filter ?? {})
        }),
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
      updateOne: (filter: unknown, update: unknown, options?: { upsert?: boolean }) =>
        push(label('updateOne', [filter]), {
          op: 'updateOne',
          database: database(),
          collection: name,
          filter: toEjson(filter),
          update: toEjson(update),
          upsert: options?.upsert
        }),
      updateMany: (filter: unknown, update: unknown, options?: { upsert?: boolean }) =>
        push(label('updateMany', [filter]), {
          op: 'updateMany',
          database: database(),
          collection: name,
          filter: toEjson(filter),
          update: toEjson(update),
          upsert: options?.upsert
        }),
      replaceOne: (filter: unknown, replacement: unknown, options?: { upsert?: boolean }) =>
        push(label('replaceOne', [filter]), {
          op: 'replaceOne',
          database: database(),
          collection: name,
          filter: toEjson(filter),
          replacement: toEjson(replacement),
          upsert: options?.upsert
        }),
      deleteOne: (filter: unknown) =>
        push(label('deleteOne', [filter]), {
          op: 'deleteOne',
          database: database(),
          collection: name,
          filter: toEjson(filter ?? {})
        }),
      deleteMany: (filter: unknown) => {
        if (filter === undefined)
          throw new ShellError('deleteMany needs a filter; use {} to delete every document')
        return push(label('deleteMany', [filter]), {
          op: 'deleteMany',
          database: database(),
          collection: name,
          filter: toEjson(filter)
        })
      },
      findOneAndUpdate: (filter: unknown, update: unknown, options?: Record<string, unknown>) =>
        push(label('findOneAndUpdate', [filter]), {
          op: 'runCommand',
          database: database(),
          command: toEjson({
            findAndModify: name,
            query: filter,
            update,
            new: options?.returnDocument === 'after' || options?.returnNewDocument === true,
            upsert: options?.upsert ?? false,
            ...(options?.sort ? { sort: options.sort } : {}),
            ...(options?.projection ? { fields: options.projection } : {})
          })
        }),
      findOneAndDelete: (filter: unknown) =>
        push(label('findOneAndDelete', [filter]), {
          op: 'runCommand',
          database: database(),
          command: toEjson({ findAndModify: name, query: filter, remove: true })
        }),
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
        if (prop in target) return target[prop]
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
      getCollectionNames: () => ops.push({ kind: 'show', what: 'collections', database: dbName() }),
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
        if (prop in target) return target[prop]
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
        text: values.map((v) => (typeof v === 'string' ? v : JSON.stringify(toEjson(v)))).join(' ')
      }),
    printjson: (value: unknown) =>
      ops.push({ kind: 'print', text: JSON.stringify(toEjson(value), null, 2) }),
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
