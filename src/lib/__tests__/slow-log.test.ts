import { describe, expect, it } from 'vitest'
import type { ResultSet } from '../api'
import {
  explainable,
  groupSlowLog,
  groupsToSet,
  logsToTable,
  normalizeStatement,
  parseSlowLogStatus,
  slowLogCountSql,
  slowLogEntriesSql,
  slowLogGroupSql,
  slowLogStatusSql,
  sortGroups
} from '../slow-log'

const set = (names: string[], rows: (string | null)[][]): ResultSet => ({
  columns: names.map((name) => ({ name, typeName: '' })),
  rows,
  rowCount: rows.length,
  truncated: false
})

describe('slow log status', () => {
  it('reads the MariaDB-only settings on MariaDB alone', () => {
    expect(slowLogStatusSql(true)).toMatch(
      /@@GLOBAL.log_slow_verbosity[\s\S]*@@GLOBAL.log_slow_filter/
    )
    expect(slowLogStatusSql(false)).not.toMatch(/log_slow_verbosity|log_slow_filter/)
    expect(slowLogStatusSql(false)).toMatch(/@@GLOBAL.long_query_time AS long_query_time/)
    expect(slowLogStatusSql(false)).toMatch(/@@GLOBAL.slow_query_log AS slow_query_log/)
  })

  it('parses the status row', () => {
    const status = parseSlowLogStatus(
      set(['slow_query_log', 'long_query_time', 'log_output'], [['1', '0.500000', 'FILE,TABLE']])
    )!
    expect(status.enabled).toBe(true)
    expect(status.longQueryTime).toBe(0.5)
    expect(status.outputs).toEqual(['FILE', 'TABLE'])
    expect(logsToTable(status)).toBe(true)
    const off = parseSlowLogStatus(
      set(['slow_query_log', 'long_query_time', 'log_output'], [['0', '10.000000', 'FILE']])
    )!
    expect(off.enabled).toBe(false)
    expect(logsToTable(off)).toBe(false)
    expect(parseSlowLogStatus(null)).toBeNull()
  })
})

describe('slow log queries', () => {
  const recent = { range: { minutes: 60 }, hideOwn: true }

  it('pages, sorts and filters entries', () => {
    const sql = slowLogEntriesSql(recent, { sort: 'query_time', page: 2, mariadb: false })
    expect(sql).toMatch(/FROM mysql\.slow_log/)
    expect(sql).toMatch(/start_time >= NOW\(6\) - INTERVAL 60 MINUTE/)
    expect(sql).toMatch(/CONVERT\(sql_text USING utf8mb4\) NOT LIKE '%mysql\.slow_log%'/)
    expect(sql).toMatch(/ORDER BY query_time DESC, start_time DESC\nLIMIT 100 OFFSET 200$/)
    expect(sql).not.toMatch(/rows_affected/)
    expect(slowLogEntriesSql(recent, { sort: 'start_time', page: 0, mariadb: true })).toMatch(
      /rows_affected[\s\S]*ORDER BY start_time DESC\n/
    )
  })

  it('keeps the fraction of query_time on MySQL and MariaDB alike', () => {
    expect(slowLogGroupSql(recent)).toMatch(
      /FLOOR\(TIME_TO_SEC\(query_time\)\) \+ MICROSECOND\(query_time\) \* 0.000001/
    )
  })

  it('takes explicit bounds only when they are timestamps', () => {
    const sql = slowLogCountSql({
      range: { from: '2026-10-01T08:30', to: "2026-10-02'; DROP TABLE x" },
      hideOwn: false
    })
    expect(sql).toBe(
      "SELECT COUNT(*) AS entries FROM mysql.slow_log\nWHERE start_time >= '2026-10-01 08:30'"
    )
    expect(slowLogCountSql({ range: { minutes: null }, hideOwn: false })).toBe(
      'SELECT COUNT(*) AS entries FROM mysql.slow_log'
    )
  })
})

describe('normalizeStatement', () => {
  it('replaces literals and collapses whitespace and case', () => {
    expect(normalizeStatement("select *  from t where id = 42 and name = 'O\\'Brien'")).toBe(
      'SELECT * FROM t WHERE id = ? AND name = ?'
    )
    expect(normalizeStatement('SELECT * FROM t WHERE id=-1.5e3;')).toBe(
      'SELECT * FROM t WHERE id = ?'
    )
    expect(normalizeStatement("SELECT x'0A', 0xFF, \"dq\", N'n', _utf8mb4'u' FROM t")).toBe(
      'SELECT ?, ?, ?, ?, ? FROM t'
    )
  })

  it('keeps identifiers, qualified names and arithmetic', () => {
    expect(normalizeStatement('select a.`order`, t1.c2 - 1 from db1.t1 a')).toBe(
      'SELECT a.`order`, t1.c2 - ? FROM db1.t1 a'
    )
    expect(normalizeStatement('select count(*), sleep(2)')).toBe('SELECT COUNT(*), SLEEP(?)')
  })

  it('drops comments', () => {
    expect(normalizeStatement('/* app:42 */ SELECT 1 -- trailing\n# hash\n')).toBe('SELECT ?')
  })

  it('collapses IN lists and multi-row VALUES', () => {
    const one = normalizeStatement('SELECT * FROM t WHERE id IN (1)')
    const many = normalizeStatement('SELECT * FROM t WHERE id in (1, 2,3, 4)')
    expect(one).toBe('SELECT * FROM t WHERE id IN (...)')
    expect(many).toBe(one)
    expect(normalizeStatement("INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y')")).toBe(
      'INSERT INTO t(a, b) VALUES (...)'
    )
  })

  it('terminates on non-ASCII and unterminated input', () => {
    expect(normalizeStatement('SELECT * FROM café WHERE x = 1')).toBe(
      'SELECT * FROM café WHERE x = ?'
    )
    expect(normalizeStatement("SELECT 'open")).toBe('SELECT ?')
    expect(normalizeStatement('SELECT `open')).toBe('SELECT `open')
  })
})

describe('grouping', () => {
  const entries = set(
    ['start_time', 'query_time_s', 'lock_time_s', 'rows_sent', 'rows_examined', 'db', 'sql_text'],
    [
      [
        '2026-10-25 10:00:01.000000',
        '0.5',
        '0',
        '1',
        '100',
        'shop',
        'SELECT * FROM t WHERE id = 1'
      ],
      ['2026-10-25 10:00:03.000000', '2', '0.1', '1', '300', 'shop', 'select * from t where id=7'],
      ['2026-10-25 10:00:02.000000', '1.5', '0', '10', '10', 'shop', 'SELECT SLEEP(1.5)'],
      ['2026-10-25 10:00:04.000000', '0.1', '0', '0', '0', 'shop', '   ']
    ]
  )

  it('groups by normalized statement with count, total, avg and max', () => {
    const groups = groupSlowLog(entries)
    expect(groups).toHaveLength(2)
    const [first, second] = groups
    expect(first.fingerprint).toBe('SELECT * FROM t WHERE id = ?')
    expect(first.count).toBe(2)
    expect(first.totalSecs).toBe(2.5)
    expect(first.maxSecs).toBe(2)
    expect(first.lastSeen).toBe('2026-10-25 10:00:03.000000')
    // The slowest run is the one to open or explain
    expect(first.sample).toBe('select * from t where id=7')
    expect(second.fingerprint).toBe('SELECT SLEEP(?)')

    expect(sortGroups(groups, 'avg')[0].fingerprint).toBe('SELECT SLEEP(?)')
    expect(sortGroups(groups, 'count')[0].fingerprint).toBe(first.fingerprint)

    const grid = groupsToSet(groups)
    expect(grid.columns.map((c) => c.name)).toContain('avg_s')
    expect(grid.rows[0].slice(0, 4)).toEqual(['2', '2.5', '1.25', '2'])
  })
})

describe('explainable', () => {
  it('accepts statements EXPLAIN takes', () => {
    expect(explainable('/* x */ SELECT 1')).toBe(true)
    expect(explainable('(SELECT 1) UNION (SELECT 2)')).toBe(true)
    expect(explainable('update t set a = 1')).toBe(true)
    expect(explainable('SHOW TABLES')).toBe(false)
    expect(explainable('SET GLOBAL x = 1')).toBe(false)
  })
})
