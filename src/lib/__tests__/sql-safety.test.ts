import { describe, expect, it } from 'vitest'
import { findParams } from '../params'
import { sqlWriteKeyword } from '../production'
import { dangerousStatements, splitStatements } from '../sql'

const texts = (sql: string, dialect: Parameters<typeof splitStatements>[1]): string[] =>
  splitStatements(sql, dialect).map((s) => s.text)

describe('sqlWriteKeyword', () => {
  it('reads # as a comment only in MySQL', () => {
    expect(sqlWriteKeyword("SELECT j #>> '{a}' FROM t; DELETE FROM t;", 'postgres')).toBe('DELETE')
    expect(sqlWriteKeyword('SELECT * FROM #tmp; DROP TABLE users', 'tsql')).toBe('DROP')
    expect(sqlWriteKeyword('SELECT 1 # DELETE\nFROM t', 'mysql')).toBeNull()
  })

  it('reads backslash escapes only in MySQL and PostgreSQL E strings', () => {
    for (const dialect of ['postgres', 'tsql', 'sqlite'] as const) {
      expect(sqlWriteKeyword("SELECT 'C:\\dir\\' AS p; DELETE FROM users;", dialect)).toBe('DELETE')
    }
    expect(sqlWriteKeyword("SELECT 'a\\' DELETE ' FROM t", 'mysql')).toBeNull()
    expect(sqlWriteKeyword("SELECT E'a\\' DELETE ' FROM t", 'postgres')).toBeNull()
  })

  it('handles doubled quotes and ]] in brackets', () => {
    expect(sqlWriteKeyword("SELECT 'it''s delete' FROM t", 'postgres')).toBeNull()
    expect(sqlWriteKeyword("SELECT 'it''s'; DELETE FROM t", 'postgres')).toBe('DELETE')
    expect(sqlWriteKeyword('SELECT [a]]delete] FROM t', 'tsql')).toBeNull()
    expect(sqlWriteKeyword('SELECT [a]]b]; DELETE FROM t', 'tsql')).toBe('DELETE')
  })
})

describe('dangerousStatements', () => {
  it('only counts a WHERE outside subqueries', () => {
    expect(
      dangerousStatements('UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)', 'postgres')
    ).toEqual(['UPDATE without a WHERE clause'])
    expect(
      dangerousStatements('UPDATE t SET a = 1 WHERE id IN (SELECT id FROM u)', 'postgres')
    ).toEqual([])
  })

  it('finds writes in CTEs, EXPLAIN ANALYZE and MERGE', () => {
    expect(
      dangerousStatements('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'postgres')
    ).toEqual(['DELETE without a WHERE clause'])
    expect(dangerousStatements('EXPLAIN ANALYZE DELETE FROM t', 'postgres')).toEqual([
      'DELETE without a WHERE clause'
    ])
    expect(dangerousStatements('EXPLAIN DELETE FROM t', 'postgres')).toEqual([])
    expect(
      dangerousStatements(
        'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE',
        'postgres'
      )
    ).toEqual(['MERGE … DELETE'])
    expect(
      dangerousStatements(
        'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a',
        'postgres'
      )
    ).toEqual([])
  })

  it('finds more kinds of DROP', () => {
    expect(dangerousStatements('DROP TEMPORARY TABLE t', 'mysql')).toEqual(['DROP TEMPORARY TABLE'])
    expect(dangerousStatements('DROP USER bob', 'postgres')).toEqual(['DROP USER BOB'])
    expect(dangerousStatements('DROP OWNED BY bob', 'postgres')).toEqual(['DROP OWNED BY'])
  })

  it('blanks MySQL double-quoted strings', () => {
    expect(dangerousStatements('UPDATE t SET note = "where"', 'mysql')).toEqual([
      'UPDATE without a WHERE clause'
    ])
  })

  it('finds T-SQL statements without semicolons', () => {
    expect(dangerousStatements('SELECT 1\nDELETE FROM users', 'tsql')).toEqual([
      'DELETE without a WHERE clause'
    ])
    expect(dangerousStatements('UPDATE t SET a = 1\nDELETE FROM u WHERE id = 1', 'tsql')).toEqual([
      'UPDATE without a WHERE clause'
    ])
  })

  it('ignores clauses that only look like writes', () => {
    for (const sql of [
      'SELECT * FROM t FOR UPDATE',
      'CREATE TABLE t (a int REFERENCES u ON DELETE CASCADE ON UPDATE CASCADE)',
      'INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 1',
      'INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 1',
      'GRANT SELECT, UPDATE, DELETE ON t TO bob',
      'ALTER TABLE t ADD COLUMN a int'
    ])
      expect(dangerousStatements(sql, 'postgres')).toEqual([])
    expect(
      dangerousStatements('CREATE PROCEDURE p AS\nBEGIN\n  DELETE FROM tmp\nEND', 'tsql')
    ).toEqual([])
  })
})

describe('splitStatements', () => {
  it('ignores CREATE VIEW in T-SQL comments and strings', () => {
    expect(texts('-- create view later\nSELECT 1;\nDELETE FROM t;', 'tsql')).toEqual([
      '-- create view later\nSELECT 1',
      'DELETE FROM t'
    ])
    expect(texts("SELECT 'create view v';\nDELETE FROM t;", 'tsql')).toEqual([
      "SELECT 'create view v'",
      'DELETE FROM t'
    ])
  })

  it('keeps CASE … END inside a MySQL routine body', () => {
    const sql = "CREATE PROCEDURE p() BEGIN SELECT CASE WHEN 1 THEN 'a' END; SELECT 2; END;"
    expect(texts(sql, 'mysql')).toEqual([sql.slice(0, -1)])
    const block =
      'CREATE PROCEDURE p() BEGIN CASE x WHEN 1 THEN SELECT 1; END CASE; IF x THEN SELECT 2; END IF; SELECT 3; END;\nSELECT 4;'
    expect(texts(block, 'mysql')).toHaveLength(2)
  })

  it('finds MySQL routines after comments and DEFINER', () => {
    for (const head of [
      '/* x */ CREATE PROCEDURE',
      '# x\nCREATE PROCEDURE',
      'CREATE DEFINER=`root`@`localhost` PROCEDURE',
      "CREATE DEFINER = 'root'@'%' PROCEDURE"
    ]) {
      const sql = `${head} p() BEGIN SELECT 1; DELETE FROM t; END`
      expect(texts(sql, 'mysql')).toEqual([sql])
    }
    const quoted =
      'CREATE PROCEDURE p() BEGIN SELECT \'end\'; SELECT "end"; SELECT 1; END;\nSELECT 2;'
    expect(texts(quoted, 'mysql')).toHaveLength(2)
  })

  it('scans PostgreSQL E strings and nested block comments', () => {
    expect(texts("SELECT E'it\\'s; ok'; SELECT 2;", 'postgres')).toEqual([
      "SELECT E'it\\'s; ok'",
      'SELECT 2'
    ])
    expect(texts('SELECT 1 /* a /* b */ ; */; SELECT 2;', 'postgres')).toEqual([
      'SELECT 1 /* a /* b */ ; */',
      'SELECT 2'
    ])
    // A plain string ending in a backslash
    expect(texts("SELECT 'C:\\'; SELECT 2;", 'postgres')).toHaveLength(2)
  })
})

describe('findParams', () => {
  it('skips PostgreSQL E strings and nested comments', () => {
    expect(findParams("SELECT E'a\\' :x ' FROM t", 'postgres')).toEqual([])
    expect(findParams('SELECT 1 /* a /* b */ :x */ FROM t', 'postgres')).toEqual([])
    expect(findParams("SELECT 'a\\' , :x", 'postgres').map((p) => p.name)).toEqual(['x'])
  })
})
