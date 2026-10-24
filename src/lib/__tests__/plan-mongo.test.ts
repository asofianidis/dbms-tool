import { describe, expect, it } from 'vitest'
import { walkPlan, type Plan } from '../plan'
import { parseMongoExplain, suggestIndex } from '../plan-mongo'

function ops(plan: Plan): string[] {
  const out: string[] = []
  for (const t of plan.trees) walkPlan(t.root, (n) => out.push(n.op))
  return out
}

const COLLSCAN_EXPLAIN = {
  queryPlanner: {
    namespace: 'shop.orders',
    winningPlan: {
      stage: 'SORT',
      sortPattern: { createdAt: -1 },
      inputStage: { stage: 'COLLSCAN', filter: { status: { $eq: 'open' } }, direction: 'forward' }
    }
  },
  executionStats: {
    nReturned: 120,
    executionTimeMillis: 48,
    totalKeysExamined: 0,
    totalDocsExamined: 50000,
    executionStages: {
      stage: 'SORT',
      nReturned: 120,
      executionTimeMillisEstimate: 45,
      sortPattern: { createdAt: -1 },
      usedDisk: false,
      inputStage: {
        stage: 'COLLSCAN',
        filter: { status: { $eq: 'open' } },
        nReturned: 120,
        executionTimeMillisEstimate: 40,
        docsExamined: 50000
      }
    }
  }
}

describe('MongoDB explain', () => {
  it('reads classic execution stages with measured rows and time', () => {
    const plan = parseMongoExplain(COLLSCAN_EXPLAIN, {
      collection: 'orders',
      filter: { status: 'open' },
      sort: { createdAt: -1 }
    })!
    expect(plan.format).toBe('mongo-explain')
    expect(plan.analyzed).toBe(true)
    expect(plan.executionMs).toBe(48)
    expect(ops(plan)).toEqual(['Sort', 'Collection Scan'])
    const scan = plan.trees[0].root.children[0]
    expect(scan.fullScan).toBe(true)
    expect(scan.actualRows).toBe(120)
    expect(scan.rowsRemoved).toBe(49880)
    expect(scan.selfMs).toBe(40)
    expect(plan.trees[0].root.selfMs).toBe(5)
  })

  it('suggests an index for a selective collection scan and the in-memory sort', () => {
    const plan = parseMongoExplain(COLLSCAN_EXPLAIN, {
      collection: 'orders',
      filter: { status: 'open' },
      sort: { createdAt: -1 }
    })!
    expect(plan.hints[0]).toMatchObject({
      severity: 'high',
      title: 'Collection scan reads 50,000 documents to return 120',
      sql: 'db.orders.createIndex({ status: 1, createdAt: -1 })'
    })
    const sort = plan.hints.find((h) => h.title === 'Sorted in memory')!
    expect(sort.sql).toBeUndefined()
  })

  it('orders suggested keys equality, sort, range', () => {
    expect(
      suggestIndex({
        collection: 'my orders',
        filter: { $and: [{ total: { $gte: 10 } }, { status: 'open' }] },
        sort: { createdAt: -1 }
      })
    ).toBe('db.getCollection("my orders").createIndex({ status: 1, createdAt: -1, total: 1 })')
    expect(suggestIndex({ collection: 'orders', filter: {} })).toBeNull()
  })

  it('falls back to the query plan for slot-based execution', () => {
    const plan = parseMongoExplain(
      {
        queryPlanner: {
          winningPlan: {
            queryPlan: {
              stage: 'FETCH',
              inputStage: { stage: 'IXSCAN', indexName: 'status_1', keyPattern: { status: 1 } }
            },
            slotBasedPlan: { slots: '…' }
          }
        },
        executionStats: {
          nReturned: 5,
          executionTimeMillis: 2,
          totalKeysExamined: 5,
          totalDocsExamined: 5,
          executionStages: { stage: 'nlj', nReturned: 5 }
        }
      },
      { collection: 'orders', filter: { status: 'open' } }
    )!
    expect(ops(plan)).toEqual(['Fetch', 'Index Scan'])
    expect(plan.trees[0].root.actualRows).toBe(5)
    expect(plan.trees[0].root.children[0].target).toBe('status_1')
    expect(plan.hints).toEqual([])
  })

  it('reads sharded plans and aggregate stages', () => {
    const sharded = parseMongoExplain(
      {
        queryPlanner: {
          winningPlan: {
            stage: 'SHARD_MERGE',
            shards: [
              { shardName: 'rs0', winningPlan: { stage: 'COLLSCAN' } },
              { shardName: 'rs1', winningPlan: { stage: 'COLLSCAN' } }
            ]
          }
        }
      },
      { collection: 'orders' }
    )!
    expect(ops(sharded)).toEqual([
      'Shard Merge',
      'Shard rs0',
      'Collection Scan',
      'Shard rs1',
      'Collection Scan'
    ])
    expect(sharded.analyzed).toBe(false)

    const agg = parseMongoExplain(
      {
        stages: [
          { $cursor: COLLSCAN_EXPLAIN },
          { $group: { _id: '$status' }, nReturned: 3, executionTimeMillisEstimate: 47 }
        ]
      },
      { collection: 'orders' }
    )!
    expect(ops(agg)).toEqual(['$group', 'Sort', 'Collection Scan'])
    expect(agg.trees[0].root.selfMs).toBe(2)
  })

  it('returns null for output without a plan', () => {
    expect(parseMongoExplain({ ok: 1 }, { collection: 'x' })).toBeNull()
    expect(parseMongoExplain(null, { collection: 'x' })).toBeNull()
  })
})
