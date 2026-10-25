import { describe, expect, it } from 'vitest'
import {
  isOracleMode,
  packageParts,
  packageScript,
  packageTemplate,
  packagesInDefaultMode,
  supportsPackages,
  withSqlModes
} from '../mariadb-packages'
import { modifyScript } from '../routines'
import { splitStatements } from '../sql'

const info = (product: string, version: string) => ({ product, version })
const texts = (sql: string) => splitStatements(sql, 'mysql').map((s) => s.text)

// As SHOW CREATE returns them on MariaDB 11.8
const ORACLE =
  'PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ORACLE,NO_KEY_OPTIONS,NO_TABLE_OPTIONS,NO_FIELD_OPTIONS,NO_AUTO_CREATE_USER,SIMULTANEOUS_ASSIGNMENT'
const DEFAULT = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER'
const ORACLE_SPEC = `CREATE DEFINER="root"@"localhost" PACKAGE "pkg_o" AS
  FUNCTION f1(a INT) RETURN INT;
  PROCEDURE p1(a INT);
END`
const ORACLE_BODY = `CREATE DEFINER="root"@"localhost" PACKAGE BODY "pkg_o" AS
  cnt INT := 0;
  FUNCTION f1(a INT) RETURN INT AS x INT; BEGIN x := a + 1; IF x > 0 THEN cnt := cnt + 1; END IF; RETURN x; END;
  PROCEDURE p1(a INT) AS BEGIN NULL; END;
BEGIN
  cnt := 10;
END`

describe('MariaDB package support', () => {
  it('needs MariaDB 10.3, and 11.4 for the default sql_mode', () => {
    expect(supportsPackages(info('MariaDB 10.3.39', '10.3.39-MariaDB'))).toBe(true)
    expect(supportsPackages(info('MariaDB 10.2.44', '10.2.44-MariaDB'))).toBe(false)
    expect(supportsPackages(info('MySQL 8.4.0', '8.4.0 MySQL Community Server'))).toBe(false)
    expect(packagesInDefaultMode(info('MariaDB 11.4.2', '11.4.2-MariaDB'))).toBe(true)
    expect(packagesInDefaultMode(info('MariaDB 11.3.2', '11.3.2-MariaDB'))).toBe(false)
  })

  it('recognizes Oracle mode in a stored sql_mode', () => {
    expect(isOracleMode(ORACLE)).toBe(true)
    expect(isOracleMode('ORACLE')).toBe(true)
    expect(isOracleMode(DEFAULT)).toBe(false)
    expect(isOracleMode(null)).toBe(false)
  })
})

describe('withSqlModes', () => {
  it('leaves default-mode statements alone', () => {
    expect(withSqlModes([{ sql: 'CREATE PROCEDURE p() SELECT 1', mode: DEFAULT }])).toBe(
      'CREATE PROCEDURE p() SELECT 1;'
    )
  })

  it('switches to Oracle mode and restores the session mode', () => {
    const script = withSqlModes([
      {
        sql: 'DROP PROCEDURE IF EXISTS `db`.`p`;\n\nCREATE PROCEDURE "p" AS BEGIN NULL; END',
        mode: ORACLE
      }
    ])
    expect(script).toBe(
      `SET @saved_sql_mode = @@sql_mode;\nSET sql_mode = '${ORACLE}';\n\n` +
        'DROP PROCEDURE IF EXISTS `db`.`p`;\n\nCREATE PROCEDURE "p" AS BEGIN NULL; END;\n\n' +
        'SET sql_mode = @saved_sql_mode;'
    )
  })

  it('sets each statement’s own mode when they differ', () => {
    const script = withSqlModes([
      { sql: 'CREATE PACKAGE "a" AS PROCEDURE p; END', mode: ORACLE },
      { sql: 'CREATE PACKAGE BODY `a` PROCEDURE p() BEGIN END; END', mode: DEFAULT }
    ])
    expect(script.match(/SET sql_mode = '/g)).toHaveLength(2)
    expect(script.indexOf(DEFAULT)).toBeGreaterThan(script.indexOf('CREATE PACKAGE "a"'))
  })
})

describe('package scripts', () => {
  const definition = `${ORACLE_SPEC};\n\n${ORACLE_BODY}`

  it('splits the stored definition into spec and body', () => {
    expect(packageParts(definition)).toEqual({ spec: ORACLE_SPEC, body: ORACLE_BODY })
    expect(packageParts(ORACLE_SPEC)).toEqual({ spec: ORACLE_SPEC, body: null })
  })

  it('recreates both spec and body with CREATE OR REPLACE for Modify', () => {
    const script = packageScript(definition, { spec: ORACLE, body: ORACLE }, true)
    expect(script).toContain('CREATE OR REPLACE DEFINER="root"@"localhost" PACKAGE "pkg_o" AS')
    expect(script).toContain('CREATE OR REPLACE DEFINER="root"@"localhost" PACKAGE BODY "pkg_o"')
    expect(script.match(/SET sql_mode = '/g)).toHaveLength(1)
    // SET, SET, spec, body, restore
    expect(texts(script)).toHaveLength(5)
  })

  it('keeps the stored CREATE for Script as CREATE', () => {
    const script = packageScript(definition, { spec: DEFAULT, body: DEFAULT })
    expect(script).toBe(`${ORACLE_SPEC};\n\n${ORACLE_BODY};`)
  })

  it('handles a package without a body', () => {
    const script = packageScript(ORACLE_SPEC, { spec: ORACLE, body: null }, true)
    expect(script).not.toContain('PACKAGE BODY')
    expect(texts(script)).toHaveLength(4)
  })

  it('has templates that split into their statements', () => {
    expect(texts(packageTemplate(false))).toEqual([
      expect.stringMatching(/^-- Members are called by name:.*\nSET @saved_sql_mode = @@sql_mode$/),
      "SET sql_mode = 'ORACLE'",
      expect.stringMatching(/^CREATE OR REPLACE PACKAGE new_package AS[\s\S]*END$/),
      expect.stringMatching(/^CREATE OR REPLACE PACKAGE BODY new_package AS[\s\S]*END$/),
      'SET sql_mode = @saved_sql_mode'
    ])
    const plain = texts(packageTemplate(true))
    expect(plain).toHaveLength(2)
    expect(plain[1]).toMatch(/^CREATE OR REPLACE PACKAGE BODY new_package\n[\s\S]*END$/)
  })
})

describe('splitting MariaDB packages and Oracle-mode routines', () => {
  it('keeps an Oracle-mode spec and body (with an initialization section) whole', () => {
    expect(texts(`${ORACLE_SPEC};\n${ORACLE_BODY};\nSELECT pkg_o.f1(1);`)).toEqual([
      ORACLE_SPEC,
      ORACLE_BODY,
      'SELECT pkg_o.f1(1)'
    ])
  })

  it('keeps a default-mode package body whole', () => {
    const body = `CREATE PACKAGE BODY pkg_d
  DECLARE n INT DEFAULT 0;
  FUNCTION one() RETURNS INT RETURN 1;
  FUNCTION f2(a INT) RETURNS INT
  BEGIN
    CASE WHEN a > 0 THEN SET n = n + 1; ELSE SET n = 0; END CASE;
    RETURN CASE WHEN a > 1 THEN a * 2 ELSE a END;
  END;
END`
    expect(texts(`${body};\nSELECT 1;`)).toEqual([body, 'SELECT 1'])
  })

  it('keeps Oracle-mode routines with declarations whole', () => {
    const proc = `CREATE OR REPLACE PROCEDURE "p"(a IN VARCHAR2(10)) AS
  v INT := 1;
  CURSOR c IS SELECT 1 FROM dual;
BEGIN
  FOR r IN c LOOP v := v + 1; END LOOP;
END`
    const fn = `CREATE FUNCTION f(a INT) RETURN INT DETERMINISTIC IS
  x INT;
BEGIN
  x := a;
  RETURN x;
END f`
    expect(texts(`${proc};\n${fn};\nSELECT f(1);`)).toEqual([proc, fn, 'SELECT f(1)'])
  })

  it('splits the Modify script of an Oracle-mode routine', () => {
    const stored = `CREATE DEFINER="root"@"localhost" PROCEDURE "ora_proc"(a INT)\nAS BEGIN IF a > 0 THEN NULL; END IF; END`
    const modify = modifyScript('mysql', stored, { schema: 'db', name: 'ora_proc' }, 'procedure')
    const script = withSqlModes([{ sql: modify, mode: ORACLE }])
    expect(texts(script)).toEqual([
      'SET @saved_sql_mode = @@sql_mode',
      `SET sql_mode = '${ORACLE}'`,
      'DROP PROCEDURE IF EXISTS `db`.`ora_proc`',
      stored,
      'SET sql_mode = @saved_sql_mode'
    ])
  })

  it('still splits default-mode routines and plain statements as before', () => {
    expect(texts('CREATE PROCEDURE p() SELECT 1 AS a; SELECT 2;')).toEqual([
      'CREATE PROCEDURE p() SELECT 1 AS a',
      'SELECT 2'
    ])
    expect(texts('CREATE OR REPLACE PROCEDURE p() BEGIN SELECT 1; END; SELECT 2;')).toEqual([
      'CREATE OR REPLACE PROCEDURE p() BEGIN SELECT 1; END',
      'SELECT 2'
    ])
    expect(texts('SELECT x AS y FROM t; SELECT 1;')).toHaveLength(2)
  })
})
