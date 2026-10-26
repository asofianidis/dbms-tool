import { describe, expect, it } from 'vitest'
import type { ExecOutput } from '../api'
import {
  layoutPlan,
  parsePlan,
  parseXml,
  PLAN_NODE,
  planFormat,
  walkPlan,
  type Plan
} from '../plan'
import { explainSql } from '../sql'

function output(...cells: string[][]): ExecOutput {
  return {
    results: cells.map((rows) => ({
      columns: [{ name: 'QUERY PLAN', typeName: 'text' }],
      rows: rows.map((c) => [c]),
      rowCount: rows.length,
      truncated: false
    })),
    messages: [],
    error: null,
    elapsedMs: 5,
    cancelled: false,
    database: null,
    inTransaction: null
  }
}

function ops(plan: Plan): string[] {
  const out: string[] = []
  for (const t of plan.trees) walkPlan(t.root, (n) => out.push(n.op))
  return out
}

const PG_ANALYZE = JSON.stringify([
  {
    Plan: {
      'Node Type': 'Hash Join',
      'Join Type': 'Inner',
      'Startup Cost': 1.07,
      'Total Cost': 2041.5,
      'Plan Rows': 50,
      'Actual Total Time': 40.0,
      'Actual Rows': 48,
      'Actual Loops': 1,
      'Hash Cond': '(o.customer_id = c.id)',
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Parent Relationship': 'Outer',
          'Relation Name': 'orders',
          Schema: 'public',
          Alias: 'o',
          'Total Cost': 2030.0,
          'Plan Rows': 50,
          'Actual Total Time': 36.0,
          'Actual Rows': 48,
          'Actual Loops': 1,
          Filter: '(o.amount > 900)',
          'Rows Removed by Filter': 99952,
          Output: ['o.id', 'o.customer_id', 'o.amount']
        },
        {
          'Node Type': 'Hash',
          'Parent Relationship': 'Inner',
          'Total Cost': 1.05,
          'Plan Rows': 5,
          'Actual Total Time': 0.02,
          'Actual Rows': 5,
          'Actual Loops': 1,
          'Hash Batches': 1,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'customers',
              Schema: 'public',
              Alias: 'c',
              'Total Cost': 1.05,
              'Plan Rows': 5,
              'Actual Total Time': 0.01,
              'Actual Rows': 5,
              'Actual Loops': 1
            }
          ]
        }
      ]
    },
    'Planning Time': 0.2,
    Triggers: [],
    'Execution Time': 40.3
  }
])

describe('PostgreSQL JSON plans', () => {
  it('explains in JSON so the plan can be drawn', () => {
    expect(explainSql('SELECT 1;', 'postgres', true, false)).toBe(
      'EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON)\nSELECT 1'
    )
    expect(planFormat('postgres', false)).toBe('postgres-json')
  })

  it('reads the tree with self times and costs', () => {
    const plan = parsePlan(output([PG_ANALYZE]), 'postgres-json')!
    expect(plan.analyzed).toBe(true)
    expect(plan.metrics).toEqual(['time', 'cost'])
    expect(plan.executionMs).toBe(40.3)
    expect(plan.planningMs).toBe(0.2)
    expect(ops(plan)).toEqual(['Hash Join', 'Seq Scan', 'Hash', 'Seq Scan'])
    const [join, scan] = [plan.trees[0].root, plan.trees[0].root.children[0]]
    expect(scan.target).toBe('public.orders o')
    expect(scan.fullScan).toBe(true)
    expect(scan.rowsRemoved).toBe(99952)
    expect(join.selfMs).toBeCloseTo(40 - 36 - 0.02)
    expect(scan.selfMs).toBe(36)
  })

  it('points at the scan that throws most rows away', () => {
    const plan = parsePlan(output([PG_ANALYZE]), 'postgres-json')!
    const scanId = plan.trees[0].root.children[0].id
    const titles = plan.hints.filter((h) => h.nodeId === scanId).map((h) => h.title)
    expect(titles).toEqual(['Full scan of public.orders o to find 48 of 100,000 rows'])
    expect(plan.hints[0].severity).toBe('high')
    expect(plan.hints[0].detail).toMatch(/^This step is 90% of the execution time\./)
  })

  it('names joins and aggregates the way the text format does', () => {
    const json = JSON.stringify([
      {
        Plan: {
          'Node Type': 'Aggregate',
          Strategy: 'Hashed',
          'Total Cost': 10,
          'Plan Rows': 1,
          Plans: [
            {
              'Node Type': 'Nested Loop',
              'Join Type': 'Left',
              'Total Cost': 9,
              'Plan Rows': 10,
              Plans: [
                {
                  'Node Type': 'Index Scan',
                  'Relation Name': 'a',
                  'Index Name': 'a_pkey',
                  'Total Cost': 1,
                  'Plan Rows': 1
                }
              ]
            }
          ]
        }
      }
    ])
    const plan = parsePlan(output([json]), 'postgres-json')!
    expect(plan.analyzed).toBe(false)
    expect(plan.metrics).toEqual(['cost'])
    expect(ops(plan)).toEqual(['HashAggregate', 'Nested Loop Left Join', 'Index Scan'])
    expect(plan.trees[0].root.children[0].children[0].target).toBe('a using a_pkey')
  })

  it('flags repeated scans, bad estimates and spills', () => {
    const json = JSON.stringify([
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Join Type': 'Inner',
          'Total Cost': 500,
          'Plan Rows': 10,
          'Actual Total Time': 900,
          'Actual Rows': 20000,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Sort',
              'Total Cost': 20,
              'Plan Rows': 2,
              'Actual Total Time': 10,
              'Actual Rows': 2000,
              'Actual Loops': 1,
              'Sort Space Type': 'Disk',
              'Sort Space Used': 4096
            },
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'items',
              'Total Cost': 40,
              'Plan Rows': 10,
              'Actual Total Time': 0.4,
              'Actual Rows': 10,
              'Actual Loops': 2000
            }
          ]
        },
        'Execution Time': 901
      }
    ])
    const plan = parsePlan(output([json]), 'postgres-json')!
    const titles = plan.hints.map((h) => h.title)
    expect(titles).toContain('items is scanned 2,000 times')
    expect(titles).toContain('Row estimate off by 1,000×')
    expect(titles).toContain('Sort spilled to disk')
    // Parent inherits the child's bad estimate, so only the source is reported
    expect(titles.filter((t) => t.startsWith('Row estimate'))).toHaveLength(1)
  })

  it('spreads parallel worker time back to wall-clock time', () => {
    const json = JSON.stringify([
      {
        Plan: {
          'Node Type': 'Gather',
          'Total Cost': 100,
          'Plan Rows': 30,
          'Workers Launched': 2,
          'Actual Total Time': 12,
          'Actual Rows': 30,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Parallel Aware': true,
              'Relation Name': 't',
              'Total Cost': 90,
              'Plan Rows': 10,
              'Actual Total Time': 10,
              'Actual Rows': 10,
              'Actual Loops': 3
            }
          ]
        }
      }
    ])
    const scan = parsePlan(output([json]), 'postgres-json')!.trees[0].root.children[0]
    expect(scan.op).toBe('Parallel Seq Scan')
    expect(scan.timeMs).toBe(10)
    expect(scan.actualRows).toBe(30)
  })

  it("doesn't call a parallel scan's workers repeated scans", () => {
    const json = JSON.stringify([
      {
        Plan: {
          'Node Type': 'Gather',
          'Workers Launched': 2,
          'Actual Total Time': 120,
          'Actual Rows': 300000,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Parallel Aware': true,
              'Relation Name': 'big',
              'Plan Rows': 100000,
              'Actual Total Time': 100,
              'Actual Rows': 100000,
              'Actual Loops': 3
            }
          ]
        }
      }
    ])
    const plan = parsePlan(output([json]), 'postgres-json')!
    expect(plan.trees[0].root.children[0].parallel).toBe(3)
    expect(plan.hints.map((h) => h.title).filter((t) => /scanned/.test(t))).toEqual([])

    const text = [
      'Gather  (cost=0.00..100.00 rows=300000 width=4) (actual time=0.1..120.0 rows=300000 loops=1)',
      '  Workers Planned: 2',
      '  Workers Launched: 2',
      '  ->  Parallel Seq Scan on big  (cost=0.00..90.00 rows=100000 width=4) (actual time=0.1..100.0 rows=100000 loops=3)'
    ]
    const fromText = parsePlan(output(text), 'postgres-text')!
    expect(fromText.trees[0].root.children[0].parallel).toBe(3)
    expect(fromText.hints.map((h) => h.title).filter((t) => /scanned/.test(t))).toEqual([])
  })

  it('still flags a scan repeated inside parallel workers', () => {
    const json = JSON.stringify([
      {
        Plan: {
          'Node Type': 'Gather',
          'Workers Launched': 2,
          'Actual Total Time': 900,
          'Actual Rows': 30,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Nested Loop',
              'Actual Total Time': 800,
              'Actual Rows': 10,
              'Actual Loops': 3,
              Plans: [
                {
                  'Node Type': 'Seq Scan',
                  'Parallel Aware': true,
                  'Relation Name': 'outer_t',
                  'Actual Total Time': 1,
                  'Actual Rows': 100,
                  'Actual Loops': 3
                },
                {
                  'Node Type': 'Seq Scan',
                  'Relation Name': 'inner_t',
                  'Actual Total Time': 2,
                  'Actual Rows': 1000,
                  'Actual Loops': 300
                }
              ]
            }
          ]
        }
      }
    ])
    const titles = parsePlan(output([json]), 'postgres-json')!.hints.map((h) => h.title)
    expect(titles.filter((t) => /scanned/.test(t))).toEqual(['inner_t is scanned 300 times'])
  })

  it('charges an InitPlan to the step that evaluates it', () => {
    const json = JSON.stringify([
      {
        Plan: {
          'Node Type': 'Hash Join',
          'Actual Total Time': 36,
          'Actual Rows': 1,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Aggregate',
              'Subplan Name': 'InitPlan 1',
              'Actual Total Time': 23,
              'Actual Rows': 1,
              'Actual Loops': 1
            },
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'orders',
              Filter: '(created > (InitPlan 1).col1)',
              'Actual Total Time': 35,
              'Actual Rows': 1,
              'Actual Loops': 1
            }
          ]
        }
      }
    ])
    const root = parsePlan(output([json]), 'postgres-json')!.trees[0].root
    expect(root.selfMs).toBe(1)
    expect(root.children[0].selfMs).toBe(23)
    expect(root.children[1].selfMs).toBe(12)
  })

  it('returns null for output that is not a plan', () => {
    expect(parsePlan(output(['hello']), 'postgres-json')).toBeNull()
    expect(parsePlan(output(['[{"x": 1}]']), 'postgres-json')).toBeNull()
  })
})

describe('PostgreSQL text plans (Babelfish)', () => {
  const lines = [
    'Query Text: SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.amount > 900',
    'Hash Join  (cost=1.11..2041.50 rows=50 width=40) (actual time=0.05..40.00 rows=48 loops=1)',
    '  Hash Cond: (o.customer_id = c.id)',
    '  ->  Seq Scan on orders o  (cost=0.00..2030.00 rows=50 width=20) (actual time=0.01..36.00 rows=48 loops=1)',
    '        Filter: (amount > 900)',
    '        Rows Removed by Filter: 99952',
    '  ->  Hash  (cost=1.05..1.05 rows=5 width=20) (actual time=0.02..0.02 rows=5 loops=1)',
    '        Buckets: 1024  Batches: 1  Memory Usage: 9kB',
    '        ->  Index Scan using customers_pkey on customers c  (cost=0.00..1.05 rows=5 width=20) (never executed)',
    'Planning Time: 0.100 ms',
    'Execution Time: 40.200 ms'
  ]

  it('rebuilds the tree from indentation', () => {
    expect(planFormat('tsql', true)).toBe('postgres-text')
    const plan = parsePlan(output(lines), 'postgres-text')!
    expect(ops(plan)).toEqual(['Hash Join', 'Seq Scan', 'Hash', 'Index Scan'])
    const scan = plan.trees[0].root.children[0]
    expect(scan.target).toBe('orders o')
    expect(scan.filter).toBe('(amount > 900)')
    expect(scan.rowsRemoved).toBe(99952)
    const index = plan.trees[0].root.children[1].children[0]
    expect(index.target).toBe('customers c using customers_pkey')
    expect(index.loops).toBe(0)
    expect(plan.executionMs).toBe(40.2)
    expect(plan.trees[0].timeMs).toBe(40.2)
  })

  it('finds the plan after the statement results', () => {
    const results: ExecOutput = {
      ...output(lines),
      results: [
        {
          columns: [{ name: 'id', typeName: 'int' }],
          rows: [['1']],
          rowCount: 1,
          truncated: false
        },
        ...output(lines).results
      ]
    }
    expect(parsePlan(results, 'postgres-text')?.trees).toHaveLength(1)
  })
})

describe('MySQL tree plans', () => {
  const tree = [
    '-> Nested loop inner join  (cost=1050.25 rows=333) (actual time=0.2..25.0 rows=48 loops=1)',
    '    -> Filter: (o.amount > 900)  (cost=1010.00 rows=333) (actual time=0.1..24.0 rows=48 loops=1)',
    '        -> Table scan on o  (cost=1010.00 rows=100000) (actual time=0.05..20.0 rows=100000 loops=1)',
    '    -> Single-row index lookup on c using PRIMARY (id=o.customer_id)  (cost=0.25 rows=1) (actual time=0.01..0.01 rows=1 loops=48)'
  ].join('\n')

  it('reads EXPLAIN ANALYZE output', () => {
    expect(planFormat('mysql', false)).toBe('mysql-tree')
    const plan = parsePlan(output([tree]), 'mysql-tree')!
    expect(ops(plan)).toEqual(['Nested loop inner join', 'Table scan', 'Single-row index lookup'])
    const lookup = plan.trees[0].root.children[1]
    expect(lookup.target).toBe('c using PRIMARY')
    expect(lookup.loops).toBe(48)
    expect(lookup.timeMs).toBeCloseTo(0.48)
  })

  it('folds the WHERE into the scan it filters', () => {
    const plan = parsePlan(output([tree]), 'mysql-tree')!
    const scan = plan.trees[0].root.children[0]
    expect(scan.fullScan).toBe(true)
    expect(scan.filter).toBe('(o.amount > 900)')
    expect(scan.actualRows).toBe(48)
    expect(scan.rowsRemoved).toBe(99952)
    expect(scan.timeMs).toBe(24)
    expect(plan.hints.map((h) => h.title)).toContain('Full scan of o to find 48 of 100,000 rows')
  })

  it('reads estimated trees and newer cost ranges', () => {
    const plan = parsePlan(
      output([
        '-> Sort: t.a  (cost=0.35..2.05 rows=10)\n    -> Table scan on t  (cost=1.25 rows=10)'
      ]),
      'mysql-tree'
    )!
    expect(plan.analyzed).toBe(false)
    expect(plan.trees[0].root.cost).toBe(2.05)
    expect(plan.trees[0].root.target).toBe('t.a')
    expect(plan.trees[0].root.selfCost).toBeCloseTo(0.8)
  })
})

const SHOWPLAN = `<?xml version="1.0" encoding="utf-16"?>
<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.564" Build="16.0.1000.6">
  <BatchSequence><Batch><Statements>
    <StmtSimple StatementText="SELECT o.Id, o.Amount FROM dbo.Orders o WHERE o.CustomerId = 42" StatementType="SELECT">
      <QueryPlan DegreeOfParallelism="1">
        <MissingIndexes>
          <MissingIndexGroup Impact="97.5">
            <MissingIndex Database="[shop]" Schema="[dbo]" Table="[Orders]">
              <ColumnGroup Usage="EQUALITY"><Column Name="[CustomerId]" ColumnId="2" /></ColumnGroup>
              <ColumnGroup Usage="INCLUDE"><Column Name="[Amount]" ColumnId="3" /></ColumnGroup>
            </MissingIndex>
          </MissingIndexGroup>
        </MissingIndexes>
        <QueryTimeStats CpuTime="30" ElapsedTime="31" />
        <RelOp NodeId="0" PhysicalOp="Parallelism" LogicalOp="Gather Streams" EstimateRows="12" EstimatedTotalSubtreeCost="0.95">
          <OutputList><ColumnReference Table="[Orders]" Alias="[o]" Column="Id" /></OutputList>
          <RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="10" ActualExecutions="1" ActualElapsedms="31" /></RunTimeInformation>
          <Parallelism>
            <RelOp NodeId="1" PhysicalOp="Clustered Index Scan" LogicalOp="Clustered Index Scan" EstimateRows="12" EstimatedTotalSubtreeCost="0.9">
              <OutputList><ColumnReference Table="[Orders]" Alias="[o]" Column="Id" /></OutputList>
              <Warnings><SpillToTempDb SpillLevel="1" /></Warnings>
              <RunTimeInformation>
                <RunTimeCountersPerThread Thread="1" ActualRows="6" ActualRowsRead="50000" ActualExecutions="1" ActualElapsedms="29" />
                <RunTimeCountersPerThread Thread="2" ActualRows="4" ActualRowsRead="50000" ActualExecutions="1" ActualElapsedms="30" />
              </RunTimeInformation>
              <IndexScan Ordered="0">
                <Object Database="[shop]" Schema="[dbo]" Table="[Orders]" Index="[PK_Orders]" Alias="[o]" />
                <Predicate><ScalarOperator ScalarString="[shop].[dbo].[Orders].[CustomerId] as [o].[CustomerId]=(42)" /></Predicate>
              </IndexScan>
            </RelOp>
          </Parallelism>
        </RelOp>
      </QueryPlan>
    </StmtSimple>
  </Statements></Batch></BatchSequence>
</ShowPlanXML>`

describe('SQL Server showplan XML', () => {
  it('asks for XML plans', () => {
    expect(explainSql('SELECT 1', 'tsql', false, false)).toContain('SET SHOWPLAN_XML ON;')
    expect(explainSql('SELECT 1', 'tsql', true, false)).toContain('SET STATISTICS XML ON;')
    expect(planFormat('tsql', false)).toBe('showplan-xml')
  })

  it('parses elements, namespaces and entities', () => {
    const doc = parseXml(
      '<?xml version="1.0"?><a:r x="1 &lt; 2 &amp;&#65;"><b/><c y=\'z\'></c></a:r>'
    )
    expect(doc.children[0].name).toBe('r')
    expect(doc.children[0].attrs.x).toBe('1 < 2 &A')
    expect(doc.children[0].children.map((c) => c.name)).toEqual(['b', 'c'])
  })

  it('reads operators, runtime counters and warnings', () => {
    const plan = parsePlan(output([SHOWPLAN]), 'showplan-xml')!
    expect(plan.analyzed).toBe(true)
    expect(ops(plan)).toEqual(['Parallelism (Gather Streams)', 'Clustered Index Scan'])
    const scan = plan.trees[0].root.children[0]
    expect(scan.target).toBe('Orders o using PK_Orders')
    expect(scan.relation).toBe('dbo.Orders')
    expect(scan.actualRows).toBe(10)
    // Two threads each ran it once: not a repeat
    expect(scan.loops).toBe(1)
    expect(scan.timeMs).toBe(30)
    expect(scan.rowsRemoved).toBe(99990)
    expect(scan.filter).toContain('[CustomerId]=(42)')
    expect(scan.warnings).toEqual(['Spilled to tempdb (level 1)'])
    expect(plan.trees[0].timeMs).toBe(31)
    expect(plan.hints.map((h) => h.title).filter((t) => /scanned/.test(t))).toEqual([])
  })

  it('counts executions per thread for parallel operators', () => {
    const counters = (execs: number): string =>
      [1, 2, 3, 4]
        .map(
          (t) =>
            `<RunTimeCountersPerThread Thread="${t}" ActualRows="500" ActualRowsRead="5000" ActualExecutions="${execs}" ActualElapsedms="20" />`
        )
        .join('')
    const xml = (execs: number): string => `<ShowPlanXML><BatchSequence><Batch><Statements>
      <StmtSimple StatementText="SELECT * FROM big"><QueryPlan DegreeOfParallelism="4">
        <RelOp PhysicalOp="Table Scan" LogicalOp="Table Scan" Parallel="true" EstimateRows="2000" EstimatedTotalSubtreeCost="5">
          <RunTimeInformation>${counters(execs)}</RunTimeInformation>
          <TableScan><Object Table="[big]" /><Predicate><ScalarOperator ScalarString="[x]=(1)" /></Predicate></TableScan>
        </RelOp>
      </QueryPlan></StmtSimple>
    </Statements></Batch></BatchSequence></ShowPlanXML>`
    const once = parsePlan(output([xml(1)]), 'showplan-xml')!
    const scan = once.trees[0].root
    expect(scan.loops).toBe(1)
    expect(scan.actualRows).toBe(2000)
    expect(scan.timeMs).toBe(20)
    expect(once.hints.map((h) => h.title).filter((t) => /scanned/.test(t))).toEqual([])
    // Rescanned inside each thread: still a repeat
    const again = parsePlan(output([xml(5)]), 'showplan-xml')!
    expect(again.trees[0].root.loops).toBe(5)
    expect(again.hints.map((h) => h.title)).toContain('big is scanned 5 times')
  })

  it('turns missing index details into a CREATE INDEX', () => {
    const plan = parsePlan(output([SHOWPLAN]), 'showplan-xml')!
    const hint = plan.hints.find((h) => h.title === 'Missing index on Orders')!
    expect(hint.severity).toBe('high')
    expect(hint.nodeId).toBe(plan.trees[0].root.children[0].id)
    expect(hint.sql).toBe(
      'CREATE NONCLUSTERED INDEX [IX_Orders_CustomerId]\nON [dbo].[Orders] ([CustomerId])\nINCLUDE ([Amount]);'
    )
  })

  it('labels each statement of a batch and flags key lookups', () => {
    const lookup = `<ShowPlanXML><BatchSequence><Batch><Statements>
      <StmtSimple StatementText="SET NOCOUNT ON" />
      <StmtSimple StatementText="SELECT 1"><QueryPlan><RelOp PhysicalOp="Constant Scan" LogicalOp="Constant Scan" EstimateRows="1" EstimatedTotalSubtreeCost="0.01"><ConstantScan /></RelOp></QueryPlan></StmtSimple>
      <StmtSimple StatementText="&#xD;&#xA;; SELECT * FROM t WHERE a = 1"><QueryPlan>
        <RelOp PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="500" EstimatedTotalSubtreeCost="2"><NestedLoops>
          <RelOp PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="500" EstimatedTotalSubtreeCost="0.5"><IndexScan><Object Table="[t]" Index="[IX_a]" /></IndexScan></RelOp>
          <RelOp PhysicalOp="Clustered Index Seek" LogicalOp="Clustered Index Seek" EstimateRows="1" EstimateRebinds="499" EstimateRewinds="0" EstimatedTotalSubtreeCost="1.4">
            <OutputList><ColumnReference Column="b" /></OutputList>
            <IndexScan Lookup="1"><Object Table="[t]" Index="[PK_t]" /></IndexScan>
          </RelOp>
        </NestedLoops></RelOp>
      </QueryPlan></StmtSimple>
    </Statements></Batch></BatchSequence></ShowPlanXML>`
    const plan = parsePlan(output([lookup]), 'showplan-xml')!
    expect(plan.trees.map((t) => t.label)).toEqual(['SELECT 1', 'SELECT * FROM t WHERE a = 1'])
    expect(ops(plan)).toEqual([
      'Constant Scan',
      'Nested Loops (Inner Join)',
      'Index Seek',
      'Key Lookup'
    ])
    // Estimated executions come from rebinds + rewinds
    const lookupHint = plan.hints.find((h) => h.title === '500 lookups back into t')!
    expect(lookupHint.severity).toBe('high')
    expect(lookupHint.detail).toContain('Adding b as INCLUDE columns')
  })
})

describe('plan layout', () => {
  it('centres parents over their children and stacks statements', () => {
    const plan = parsePlan(output([PG_ANALYZE]), 'postgres-json')!
    const { positions, width } = layoutPlan(plan.trees)
    const [join, scan, hash, inner] = [0, 1, 2, 3].map((id) => positions.get(id)!)
    expect(scan.y).toBe(join.y + PLAN_NODE.height + PLAN_NODE.gapY)
    expect(inner.x).toBe(hash.x)
    expect(join.x).toBe((scan.x + hash.x) / 2)
    expect(width).toBe(PLAN_NODE.width * 2 + PLAN_NODE.gapX)
  })
})
