import { describe, expect, it } from 'vitest'
import type { ExecOutput } from '../api'
import { planFormat, walkPlan, type Plan, type PlanNode } from '../plan'
import { parseMariaDbPlan } from '../plan-mariadb'
import { sqlWriteKeyword } from '../production'
import { explainSql } from '../sql'
// Captured from MariaDB 11.8 (the PR lists the schema and statements)
import bnl from './fixtures/mariadb-plans/bnl.analyze.json'
import deleteAnalyze from './fixtures/mariadb-plans/delete.analyze.json'
import dependent from './fixtures/mariadb-plans/dependent.analyze.json'
import derived from './fixtures/mariadb-plans/derived.analyze.json'
import filesort from './fixtures/mariadb-plans/filesort.analyze.json'
import hash from './fixtures/mariadb-plans/hash.analyze.json'
import impossible from './fixtures/mariadb-plans/impossible.explain.json'
import joinAnalyze from './fixtures/mariadb-plans/join.analyze.json'
import joinExplain from './fixtures/mariadb-plans/join.explain.json'
import simpleAnalyze from './fixtures/mariadb-plans/simple.analyze.json'
import simpleExplain from './fixtures/mariadb-plans/simple.explain.json'
import sorted from './fixtures/mariadb-plans/sorted.analyze.json'
import spill from './fixtures/mariadb-plans/spill.analyze.json'
import subquery from './fixtures/mariadb-plans/subquery.analyze.json'
import unionAnalyze from './fixtures/mariadb-plans/union.analyze.json'
import unionExplain from './fixtures/mariadb-plans/union.explain.json'
import weedout from './fixtures/mariadb-plans/weedout.analyze.json'
import windowFns from './fixtures/mariadb-plans/window.analyze.json'

/** What the MySQL driver returns for EXPLAIN/ANALYZE FORMAT=JSON: one text cell. */
function output(doc: unknown): ExecOutput {
  return {
    results: [
      {
        columns: [{ name: 'ANALYZE', typeName: 'longtext' }],
        rows: [[typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2)]],
        rowCount: 1,
        truncated: false
      }
    ],
    messages: [],
    error: null,
    elapsedMs: 5,
    cancelled: false,
    database: null,
    inTransaction: null
  }
}

function parse(doc: unknown): Plan {
  const plan = parseMariaDbPlan(output(doc))
  if (!plan) throw new Error('no plan')
  return plan
}

/** `op [label] on target` for every node, indented by depth. */
function shape(plan: Plan): string[] {
  const out: string[] = []
  const depth = new Map<PlanNode, number>()
  walkPlan(plan.trees[0].root, (n, parent) => {
    const d = parent ? depth.get(parent)! + 1 : 0
    depth.set(n, d)
    const label = n.label ? ` [${n.label}]` : ''
    out.push(`${'  '.repeat(d)}${n.op}${label}${n.target ? ` on ${n.target}` : ''}`)
  })
  return out
}

function find(plan: Plan, op: string): PlanNode {
  let found: PlanNode | undefined
  for (const t of plan.trees) walkPlan(t.root, (n) => void (!found && n.op === op && (found = n)))
  if (!found) throw new Error(`no ${op}`)
  return found
}

const titles = (plan: Plan): string[] => plan.hints.map((h) => h.title)

describe('MariaDB EXPLAIN statements', () => {
  it('asks MariaDB for JSON plans and leaves MySQL on FORMAT=TREE', () => {
    expect(explainSql('SELECT 1;', 'mysql', false, false, true)).toBe(
      'EXPLAIN FORMAT=JSON\nSELECT 1'
    )
    expect(explainSql('DELETE FROM t', 'mysql', true, false, true)).toBe(
      'ANALYZE FORMAT=JSON\nDELETE FROM t'
    )
    expect(explainSql('SELECT 1', 'mysql', false, false)).toBe('EXPLAIN FORMAT=TREE\nSELECT 1')
    expect(explainSql('SELECT 1', 'mysql', true, false)).toBe('EXPLAIN ANALYZE\nSELECT 1')
    expect(planFormat('mysql', false, true)).toBe('mariadb-json')
    expect(planFormat('mysql', false)).toBe('mysql-tree')
    // Only the MySQL dialect has a MariaDB variant
    expect(planFormat('postgres', false, true)).toBe('postgres-json')
  })

  it('treats ANALYZE of a write as the write it runs', () => {
    // The production confirmation and read-only guard see the DELETE inside the ANALYZE
    const sql = explainSql("DELETE FROM orders WHERE status = 'void'", 'mysql', true, false, true)
    expect(sqlWriteKeyword(sql, 'mysql')).toBe('DELETE')
    expect(
      sqlWriteKeyword(explainSql('UPDATE t SET a = 1', 'mysql', true, false, true), 'mysql')
    ).toBe('UPDATE')
    expect(
      sqlWriteKeyword(explainSql('SELECT * FROM t', 'mysql', true, false, true), 'mysql')
    ).toBeNull()
  })
})

describe('MariaDB JSON plans', () => {
  it('ignores output that is not a plan', () => {
    expect(parseMariaDbPlan(output({ hello: 1 }))).toBeNull()
    expect(parseMariaDbPlan(output('{ not json'))).toBeNull()
  })

  it('reads an estimated plan with costs and no actuals', () => {
    const plan = parse(simpleExplain)
    expect(plan.format).toBe('mariadb-json')
    expect(plan.analyzed).toBe(false)
    expect(plan.metrics).toEqual(['cost'])
    expect(shape(plan)).toEqual(['Query block #1', '  Table scan on orders'])
    const scan = plan.trees[0].root.children[0]
    expect(scan.fullScan).toBe(true)
    expect(scan.relation).toBe('orders')
    expect(scan.filter).toBe('orders.total > 900')
    expect(scan.estRows).toBe(19847)
    expect(scan.cost).toBeCloseTo(3.328)
    expect(scan.actualRows).toBeNull()
    expect(titles(plan)).toContain('Full scan of orders with a filter')
  })

  it('reads ANALYZE actuals, filtered rows and timings', () => {
    const plan = parse(simpleAnalyze)
    expect(plan.analyzed).toBe(true)
    expect(plan.metrics).toEqual(['time', 'cost'])
    expect(plan.planningMs).toBeCloseTo(0.0485)
    expect(plan.executionMs).toBeCloseTo(4.0237)
    const scan = plan.trees[0].root.children[0]
    expect(scan.loops).toBe(1)
    // r_rows 20000 with r_filtered 9.6%: the scan keeps 1920 and throws 18080 away
    expect(scan.actualRows).toBeCloseTo(1920)
    expect(scan.rowsRemoved).toBeCloseTo(18080)
    expect(titles(plan)).toContain('Full scan of orders to find 1,920 of 20,000 rows')
    const off = plan.hints.find((h) => h.title.startsWith('Row estimate off'))
    expect(off?.detail).toContain('ANALYZE TABLE orders PERSISTENT FOR ALL')
  })

  it('reads a join as a nested loop in join order', () => {
    expect(shape(parse(joinExplain))).toEqual([
      'Query block #1',
      '  Nested loop',
      '    Table scan on o',
      '    Unique key lookup on c using PRIMARY'
    ])
    const plan = parse(joinAnalyze)
    const loop = find(plan, 'Nested loop')
    const lookup = find(plan, 'Unique key lookup')
    expect(lookup.loops).toBe(5000)
    expect(lookup.estLoops).toBe(19847)
    // r_rows is per loop: 1 row each for 5000 loops, 20% of them passing c.country = 'GR'
    expect(lookup.actualRows).toBeCloseTo(1000)
    expect(lookup.estRows).toBeCloseTo(0.2)
    expect(loop.actualRows).toBeCloseTo(1000)
    expect(loop.cost).toBeCloseTo(21.08, 1)
    // The block's cost is what its tables add up to
    expect(plan.trees[0].root.selfCost).toBeCloseTo(0)
    expect(plan.trees[0].root.timeMs).toBeCloseTo(6.6186)
  })

  it('reads sorts over temporary tables and sorted reads', () => {
    const grouped = parse(filesort)
    expect(shape(grouped)).toEqual([
      'Query block #1',
      '  Sort on sum(orders.total) desc',
      '    Temporary table',
      '      Table scan on orders'
    ])
    const sort = find(grouped, 'Sort')
    // The sort starts once the temporary table is filled, so its own time adds to it
    expect(sort.selfMs).toBeCloseTo(0.1365)
    expect(sort.actualRows).toBe(11)

    const plan = parse(sorted)
    expect(shape(plan)).toEqual([
      'Query block #1',
      '  Read sorted file',
      '    Sort on o.created, o.total',
      '      Table scan on o'
    ])
    // Sorting a table reads it as it goes; the scan's time is already in the sort's
    expect(find(plan, 'Sort').timeMs).toBeCloseTo(3.2058)
    expect(find(plan, 'Read sorted file').actualRows).toBe(5)
  })

  it('warns when a sort spills to disk', () => {
    const plan = parse(spill)
    expect(find(plan, 'Sort').warnings).toEqual([
      'Sort spilled to disk (22 merge passes, 31KiB buffer)'
    ])
    expect(plan.hints.find((h) => h.title === 'Sort spilled to disk')?.severity).toBe('high')
  })

  it('reads materialized subqueries and derived tables', () => {
    const plan = parse(subquery)
    expect(shape(plan)).toEqual([
      'Query block #1',
      '  Nested loop',
      '    Table scan on customers',
      '    Unique key lookup on <subquery2> using distinct_key',
      '      Materialize',
      '        Query block #2',
      '          Table scan on orders'
    ])
    const work = find(plan, 'Unique key lookup')
    // MariaDB's own work tables aren't something to index
    expect(work.relation).toBeNull()
    expect(work.actualRows).toBeCloseTo(24)
    expect(work.timeMs).toBeCloseTo(0.0344 + 0.0133 + 2.122 + 1.0357, 3)
    expect(titles(plan)).toContain('Full scan of orders to find 120 of 20,000 rows')

    const view = parse(derived)
    expect(shape(view)).toContain('      Table scan on <derived2>')
    expect(find(view, 'Table scan').fullScan).toBe(false)
    expect(find(view, 'Query block #2').props).toContainEqual(['having_condition', 'n > 10'])
  })

  it('reads dependent subqueries and flags the repeated scan', () => {
    const plan = parse(dependent)
    expect(shape(plan)).toEqual([
      'Query block #1',
      '  Covering index lookup on c using idx_country',
      '  Subquery cache [Subquery] on disabled',
      '    Query block #2',
      '      Table scan on o'
    ])
    const scan = find(plan, 'Table scan')
    expect(scan.loops).toBe(400)
    expect(scan.actualRows).toBeCloseTo(4000)
    expect(scan.rowsRemoved).toBeCloseTo(7996000)
    const hint = plan.hints.find((h) => h.title === 'o is scanned 400 times')
    expect(hint?.severity).toBe('high')
    expect(hint?.nodeId).toBe(scan.id)
    // The outer block's time includes the subquery's
    expect(plan.trees[0].root.selfMs).toBeCloseTo(0.5, 0)
  })

  it('reads UNION results with the operation as the label', () => {
    expect(shape(parse(unionExplain))).toEqual([
      'Union result on <union1,2>',
      '  Query block #1',
      '    Covering index lookup on customers using idx_country',
      '  Query block #2 [UNION]',
      '    Table scan on orders'
    ])
    const plan = parse(unionAnalyze)
    expect(plan.trees[0].root.actualRows).toBe(416)
    expect(plan.trees[0].root.timeMs).toBeCloseTo(0.1638 + 3.1064)
  })

  it('reads join buffers and suggests an index for a block nested loop', () => {
    const plan = parse(bnl)
    expect(shape(plan)).toEqual([
      'Query block #1',
      '  Nested loop',
      '    Table scan on c',
      '    Block nested loop on o',
      '      Table scan on o'
    ])
    const join = find(plan, 'Block nested loop')
    expect(join.loops).toBe(400)
    expect(join.actualRows).toBeCloseTo(3992, 0)
    expect(join.filter).toBe('o.total = c.`id` * 1')
    expect(join.selfMs).toBeCloseTo(825.28, 1)
    const inner = join.children[0]
    // Read once into the buffer, not once per outer row
    expect(inner.estLoops).toBeNull()
    const hint = plan.hints.find((h) => h.title === 'o is joined without an index')
    expect(hint?.nodeId).toBe(inner.id)
    expect(titles(plan)).not.toContain('o is scanned 400 times')

    const hashed = parse(hash)
    expect(find(hashed, 'Hash join').actualRows).toBeCloseTo(4000)
    expect(find(hashed, 'Hash table scan').fullScan).toBe(false)
    expect(titles(hashed).some((t) => t.includes('scanned'))).toBe(false)
  })

  it('reads semi-join duplicate weedout and window functions', () => {
    expect(shape(parse(weedout))).toEqual([
      'Query block #1',
      '  Duplicate weedout',
      '    Table scan on orders',
      '    Unique key lookup on customers using PRIMARY'
    ])
    expect(shape(parse(windowFns))).toEqual([
      'Query block #1',
      '  Window functions',
      '    Sort on orders.customer_id, orders.total',
      '    Temporary table',
      '      Index range scan on orders using PRIMARY'
    ])
  })

  it('reads single-table DELETE plans and server messages', () => {
    const plan = parse(deleteAnalyze)
    expect(shape(plan)).toEqual(['Query block #1', '  Table scan [DELETE] on orders'])
    const scan = find(plan, 'Table scan')
    expect(scan.loops).toBe(1)
    expect(scan.actualRows).toBeCloseTo(30)
    expect(scan.props).toContainEqual(['r_engine_stats.pages_updated', '63'])

    expect(shape(parse(impossible))).toEqual(['Query block #1', '  Impossible WHERE'])
  })
})
