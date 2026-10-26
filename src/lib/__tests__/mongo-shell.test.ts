import { describe, expect, it } from 'vitest'
import { parseShell } from '../mongo-shell'

const request = (script: string): unknown => {
  const [op] = parseShell(script, 'app')
  return op.kind === 'request' ? op.request : op
}

describe('cursor size() and itcount()', () => {
  it('apply the cursor skip and limit', () => {
    expect(request("db.users.find({ a: 1 }).skip(5).limit(10).hint('a_1').size()")).toEqual({
      op: 'runCommand',
      database: 'app',
      command: { count: 'users', query: { a: 1 }, skip: 5, limit: 10, hint: 'a_1' }
    })
    expect(request('db.users.find().limit(-3).itcount()')).toMatchObject({
      command: { count: 'users', query: {}, limit: 3 }
    })
    expect(request("db.users.find().limit(3).readConcern('majority').size()")).toMatchObject({
      command: { readConcern: { level: 'majority' } }
    })
  })

  it('stay a plain count without skip or limit', () => {
    expect(request('db.users.find({ a: 1 }).size()')).toMatchObject({
      op: 'count',
      filter: { a: 1 }
    })
    expect(request('db.users.find().itcount()')).toMatchObject({ op: 'count' })
  })

  it('leave count() ignoring skip and limit, like the legacy shell', () => {
    expect(request('db.users.find().skip(2).limit(1).count()')).toMatchObject({ op: 'count' })
  })
})

describe('shell commands', () => {
  it('allow a trailing comment on show and use', () => {
    expect(parseShell('show collections // x', 'app')).toEqual([
      { kind: 'show', what: 'collections', database: 'app' }
    ])
    expect(parseShell('show dbs; // all of them', 'app')[0]).toMatchObject({ what: 'dbs' })
    expect(parseShell('use other // switch', 'app')).toEqual([{ kind: 'use', database: 'other' }])
  })
})
