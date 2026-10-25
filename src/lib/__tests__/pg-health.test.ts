import { describe, expect, it } from 'vitest'
import type { Cell, ResultSet } from '../api'
import { presetDraft } from '../maintenance'
import {
  dropIndexSql,
  exactBloatSql,
  healthFlags,
  indexIssues,
  indexRows,
  indexUsageSql,
  issueLabel,
  parseHealthContext,
  progressSql,
  reindexSql,
  rowTable,
  tableHealthSql,
  withHealthFlags,
  withIndexIssues,
  type IndexRow
} from '../pg-health'

function set(columns: string[], rows: Cell[][]): ResultSet {
  return {
    columns: columns.map((name) => ({ name, typeName: 'text' })),
    rows,
    rowCount: rows.length,
    truncated: false
  }
}

const reader =
  (values: Record<string, Cell>) =>
  (name: string): Cell =>
    values[name] ?? null

describe('health context', () => {
  it('reads the version, stats reset and privileges', () => {
    const ctx = parseHealthContext(
      set(
        ['version', 'stats_reset', 'all_stats', 'pgstattuple', 'freeze_max_age'],
        [['170002', null, 't', 'f', '200000000']]
      )
    )
    expect(ctx).toEqual({
      version: 170002,
      statsReset: null,
      allStats: true,
      pgstattuple: false,
      freezeMaxAge: 200000000
    })
    expect(parseHealthContext(set(['version'], []))).toBeNull()
  })
})

describe('table health', () => {
  it('reads PostgreSQL 16 scan times only where they exist', () => {
    expect(tableHealthSql(160000)).toMatch(/s\.last_seq_scan, s\.last_idx_scan/)
    expect(tableHealthSql(130000)).not.toMatch(/last_seq_scan/)
    expect(tableHealthSql(130000)).toMatch(/age\(c\.relfrozenxid\) END AS xid_age/)
    expect(tableHealthSql(130000)).toMatch(/AS est_bloat_pct/)
  })

  it('flags dead rows, stale statistics, wraparound, bloat and autovacuum off', () => {
    expect(
      healthFlags(
        reader({
          live_tuples: '1000',
          dead_tuples: '600',
          dead_pct: '37.5',
          modified_since_analyze: '0',
          last_autoanalyze: '2026-01-01',
          xid_age: '160000000',
          freeze_max_age: '200000000',
          est_bloat_pct: '45.0',
          autovacuum: 'f'
        })
      )
    ).toEqual(['vacuum', 'wraparound', 'bloat', 'autovacuum-off'])
    // Past the autovacuum threshold even though under 20%
    expect(
      healthFlags(
        reader({
          live_tuples: '1000000',
          dead_tuples: '250000',
          dead_pct: '10',
          autovacuum_at: '200050',
          last_analyze: 'x',
          autovacuum: 't'
        })
      )
    ).toEqual(['vacuum'])
    expect(
      healthFlags(reader({ live_tuples: '10', modified_since_analyze: '10', autovacuum: 't' }))
    ).toEqual(['analyze'])
    expect(
      healthFlags(
        reader({ live_tuples: '10', dead_tuples: '0', last_analyze: 'x', autovacuum: 't' })
      )
    ).toEqual([])
  })

  it('adds the attention and freeze limit columns and filters to flagged tables', () => {
    const health = set(
      ['schema', 'table', 'dead_tuples', 'dead_pct', 'xid_age', 'freeze_max_age', 'autovacuum'],
      [
        ['public', 'churn', '50', '50', '150000000', '200000000', 't'],
        ['public', 'quiet', '0', '0', '10', '200000000', 't']
      ]
    )
    const all = withHealthFlags(health, false)
    expect(all.columns.map((c) => c.name)).toEqual([
      'attention',
      'schema',
      'table',
      'dead_tuples',
      'dead_pct',
      'xid_age',
      'freeze_limit_pct',
      'freeze_max_age',
      'autovacuum'
    ])
    expect(all.rows[0][0]).toBe('needs vacuum, wraparound')
    expect(all.rows[0][6]).toBe('75.0')
    expect(all.rows[1][0]).toBeNull()
    const flagged = withHealthFlags(health, true)
    expect(flagged.rows).toHaveLength(1)
    expect(rowTable(flagged, 0)).toEqual({ schema: 'public', name: 'churn' })
  })

  it('quotes the table for pgstattuple', () => {
    expect(exactBloatSql({ schema: 'My Schema', name: "O'Brien" })).toMatch(
      /pgstattuple\('"My Schema"\."O''Brien"'\)/
    )
  })

  it('presets the maintenance tab on chosen tables', () => {
    const draft = presetDraft('postgres', {
      task: 'vacuum',
      tables: [{ schema: 'public', name: 'churn' }],
      options: { analyze: true, freeze: true },
      nonce: 1
    })
    expect(draft).toEqual({
      task: 'vacuum',
      scope: 'tables',
      tables: [{ schema: 'public', name: 'churn' }],
      options: { analyze: true, freeze: true }
    })
  })
})

const INDEX_COLUMNS = [
  'schema',
  'table',
  'index',
  'size',
  'idx_scan',
  'valid',
  'primary',
  'unique',
  'constraint',
  'table_oid',
  'method',
  'key_columns',
  'key_opclasses',
  'expressions',
  'predicate'
]

function index(
  name: string,
  keys: string,
  extra: Partial<Record<(typeof INDEX_COLUMNS)[number], Cell>> = {}
): Cell[] {
  const v: Record<string, Cell> = {
    schema: 'public',
    table: 't',
    index: name,
    size: '8 kB',
    idx_scan: '5',
    valid: 't',
    primary: 'f',
    unique: 'f',
    constraint: null,
    table_oid: '100',
    method: 'btree',
    key_columns: keys,
    key_opclasses: `{${keys
      .split(' ')
      .map(() => '1978')
      .join(',')}}`,
    expressions: null,
    predicate: null,
    ...extra
  }
  return INDEX_COLUMNS.map((c) => v[c] ?? null)
}

describe('index usage', () => {
  it('reads last_idx_scan from PostgreSQL 16', () => {
    expect(indexUsageSql(160000)).toMatch(/s\.last_idx_scan,/)
    expect(indexUsageSql(150000)).toMatch(/NULL::timestamptz AS last_idx_scan/)
    expect(indexUsageSql(150000)).toMatch(/i\.indkey\[0:i\.indnkeyatts - 1\]/)
  })

  it('finds unused, duplicate, redundant and invalid indexes', () => {
    const rows = indexRows(
      set(INDEX_COLUMNS, [
        index('t_pkey', '1', { primary: 't', unique: 't', constraint: 't_pkey', idx_scan: '0' }),
        index('t_a', '2'),
        index('t_a_dup', '2', { idx_scan: '0' }),
        index('t_ab', '2 3'),
        index('t_a_part', '2', { predicate: '(b > 0)' }),
        index('t_a_hash', '2', { method: 'hash' }),
        index('t_bad', '4', { valid: 'f', idx_scan: '0' }),
        index('t_a_uniq', '2', { unique: 't' }),
        index('other_a', '2', { table_oid: '200' })
      ])
    )
    const issues = indexIssues(rows)
    const of = (name: string): string | undefined => {
      const entry = issues.get(rows.findIndex((r) => r.index === name))
      return entry && issueLabel(entry)
    }
    expect(of('t_pkey')).toBeUndefined()
    // t_a is a prefix of t_ab and the same as the unique t_a_uniq; t_a_dup is also the same as t_a
    expect(of('t_a')).toBe('prefix of t_ab, duplicate of t_a_uniq')
    expect(of('t_a_dup')).toBe('unused, duplicate of t_a, prefix of t_ab')
    expect(of('t_ab')).toBeUndefined()
    expect(of('t_a_part')).toBeUndefined()
    expect(of('t_a_hash')).toBeUndefined()
    expect(of('t_bad')).toBe('invalid')
    // A unique index enforces something the plain ones don't, so it's what they duplicate
    expect(of('t_a_uniq')).toBeUndefined()
    expect(of('other_a')).toBeUndefined()
  })

  it('filters the grid by issue and maps rows back', () => {
    const health = set(INDEX_COLUMNS, [
      index('t_a', '2'),
      index('t_unused', '3', { idx_scan: '0' }),
      index('t_bad', '4', { valid: 'f', idx_scan: '0' })
    ])
    const problems = withIndexIssues(health, 'problems')
    expect(problems.set.columns.map((c) => c.name)).toEqual([
      'issue',
      'schema',
      'table',
      'index',
      'size',
      'idx_scan',
      'valid',
      'primary',
      'unique',
      'constraint'
    ])
    expect(problems.set.rows.map((r) => r[0])).toEqual(['unused', 'invalid'])
    expect(problems.source).toEqual([1, 2])
    expect(withIndexIssues(health, 'invalid').source).toEqual([2])
    expect(withIndexIssues(health, 'all').set.rows).toHaveLength(3)
  })

  it('scripts dropping an index, or the constraint behind it', () => {
    const base: IndexRow = indexRows(set(INDEX_COLUMNS, [index('Big Idx', '2')]))[0]
    const idx = { ...base, schema: 'My Schema' }
    expect(dropIndexSql(idx, { concurrently: true })).toMatch(
      /^-- .*\nDROP INDEX CONCURRENTLY IF EXISTS "My Schema"\."Big Idx";$/
    )
    expect(dropIndexSql(idx, { concurrently: false })).toBe(
      'DROP INDEX IF EXISTS "My Schema"."Big Idx";'
    )
    expect(dropIndexSql({ ...idx, constraint: 't_u' }, { concurrently: true })).toMatch(
      /ALTER TABLE "My Schema"\.t DROP CONSTRAINT t_u;$/
    )
    expect(reindexSql(idx)).toMatch(/REINDEX INDEX CONCURRENTLY "My Schema"\."Big Idx";$/)
  })
})

describe('progress', () => {
  it('reads COPY progress from PostgreSQL 14 and index counts from 17', () => {
    const pg13 = progressSql(130000)
    expect(pg13).not.toMatch(/pg_stat_progress_copy/)
    expect(pg13).not.toMatch(/indexes_processed/)
    for (const view of ['vacuum', 'analyze', 'create_index', 'cluster', 'basebackup'])
      expect(pg13).toContain(`pg_stat_progress_${view}`)
    expect(progressSql(140000)).toMatch(/pg_stat_progress_copy/)
    expect(progressSql(170000)).toMatch(/p\.indexes_processed/)
    expect(pg13).toMatch(/LEFT JOIN pg_stat_activity a ON a\.pid = g\.pid/)
  })
})
