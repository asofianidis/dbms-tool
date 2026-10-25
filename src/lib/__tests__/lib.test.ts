import { describe, expect, it } from 'vitest'
import { parseShellValue, scalarText, toShell } from '../ejson'
import { parseConnectionString, sslModeFromParam } from '../engines'
import { parseShell } from '../mongo-shell'
import {
  dangerousStatements,
  editStatements,
  literal,
  quoteIdent,
  selectRows,
  splitStatements,
  statementAt
} from '../sql'

describe('splitStatements', () => {
  it('splits on semicolons outside strings and comments', () => {
    const sql = 'SELECT \'a;b\'; -- c;d\nSELECT 2; /* ; */ SELECT "x;y"'
    expect(splitStatements(sql, 'postgres').map((s) => s.text)).toEqual([
      "SELECT 'a;b'",
      '-- c;d\nSELECT 2',
      '/* ; */ SELECT "x;y"'
    ])
  })

  it('keeps PostgreSQL dollar-quoted bodies together', () => {
    const sql =
      'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql; SELECT f()'
    expect(splitStatements(sql, 'postgres')).toHaveLength(2)
  })

  it('splits T-SQL on GO and keeps procedure bodies whole', () => {
    const sql = 'CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END\nGO\nEXEC p;'
    const parts = splitStatements(sql, 'tsql').map((s) => s.text)
    expect(parts).toEqual(['CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END', 'EXEC p'])
  })

  it('handles MySQL backslash escapes', () => {
    expect(splitStatements("SELECT 'it\\'s; fine'; SELECT 2", 'mysql')).toHaveLength(2)
  })

  it('finds the statement at the cursor', () => {
    const sql = 'SELECT 1;\n\nSELECT 2;\nSELECT 3'
    expect(statementAt(sql, 'postgres', sql.indexOf('2'))?.text).toBe('SELECT 2')
    // Cursor just after a semicolon still means that statement
    expect(statementAt(sql, 'postgres', sql.indexOf(';') + 1)?.text).toBe('SELECT 1')
  })
})

describe('literals and identifiers', () => {
  it('quotes per dialect', () => {
    expect(quoteIdent('postgres', 'users')).toBe('users')
    expect(quoteIdent('postgres', 'User')).toBe('"User"')
    expect(quoteIdent('postgres', 'order')).toBe('"order"')
    expect(quoteIdent('mysql', 'a`b')).toBe('`a``b`')
    expect(quoteIdent('tsql', 'a]b')).toBe('[a]]b]')
  })

  it('formats values', () => {
    expect(literal('postgres', null)).toBe('NULL')
    expect(literal('postgres', '42', 'integer')).toBe('42')
    expect(literal('postgres', '42', 'text')).toBe("'42'")
    expect(literal('postgres', "O'Brien")).toBe("'O''Brien'")
    expect(literal('mysql', 'a\\b')).toBe("'a\\\\b'")
    expect(literal('tsql', 'ä', 'nvarchar(10)')).toBe("N'ä'")
    expect(literal('tsql', 'a', 'nchar(1)')).toBe("N'a'")
    expect(literal('tsql', 'a', 'ntext')).toBe("N'a'")
    expect(literal('tsql', 'a', 'varchar(10)')).toBe("'a'")
    expect(literal('postgres', 't', 'boolean')).toBe('TRUE')
  })

  it('pages with LIMIT or OFFSET/FETCH', () => {
    expect(
      selectRows('postgres', { schema: 'public', name: 't' }, { limit: 10, offset: 20 })
    ).toContain('LIMIT 10 OFFSET 20')
    expect(selectRows('tsql', { schema: 'dbo', name: 't' }, { limit: 10 })).toContain('TOP (10)')
    expect(
      selectRows(
        'tsql',
        { schema: 'dbo', name: 't' },
        { limit: 10, offset: 10, keyColumns: ['id'] }
      )
    ).toContain('ORDER BY [id]\nOFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY')
  })

  it('builds edit statements keyed by primary key', () => {
    const info = {
      columns: [
        {
          name: 'id',
          dataType: 'int',
          nullable: false,
          default: null,
          isPrimaryKey: true,
          isGenerated: true,
          isIdentity: true,
          comment: null,
          extra: null
        },
        {
          name: 'name',
          dataType: 'text',
          nullable: true,
          default: null,
          isPrimaryKey: false,
          isGenerated: false,
          isIdentity: false,
          comment: null,
          extra: null
        }
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
      triggers: []
    }
    const statements = editStatements('postgres', { schema: 'public', name: 't' }, info, [
      { kind: 'update', original: { id: '1', name: 'a' }, values: { name: 'b' } },
      { kind: 'delete', original: { id: '2', name: null } },
      { kind: 'insert', values: { name: 'c' } }
    ])
    expect(statements).toEqual([
      "UPDATE public.t SET name = 'b' WHERE id = 1",
      'DELETE FROM public.t WHERE id = 2',
      "INSERT INTO public.t (name) VALUES ('c')"
    ])
  })

  it('flags destructive statements', () => {
    expect(dangerousStatements('DELETE FROM t', 'postgres')).toEqual([
      'DELETE without a WHERE clause'
    ])
    expect(
      dangerousStatements("DELETE FROM t WHERE id = 1; UPDATE t SET a = 'where'", 'postgres')
    ).toEqual(['UPDATE without a WHERE clause'])
    expect(dangerousStatements('DROP TABLE users', 'postgres')).toEqual(['DROP TABLE USERS'])
    expect(dangerousStatements('SELECT * FROM t', 'postgres')).toEqual([])
  })
})

describe('parseConnectionString', () => {
  it('reads URIs', () => {
    const pg = parseConnectionString(
      'postgresql://me:p%40ss@db.example.com:6543/app?sslmode=require'
    )
    expect(pg?.engine).toBe('postgres')
    expect(pg?.patch).toMatchObject({
      host: 'db.example.com',
      port: 6543,
      user: 'me',
      database: 'app',
      ssl: 'require'
    })
    expect(pg?.password).toBe('p@ss')
    expect(parseConnectionString('mongodb+srv://u:pw@cluster0.x.net/db')?.engine).toBe('mongo')
  })

  it('maps TLS modes and certificate files', () => {
    const pg = parseConnectionString(
      'postgres://me@db.example.com/app?sslmode=verify-full&sslrootcert=%2Fcerts%2Fca.pem&sslcert=%2Fcerts%2Fc.crt&sslkey=%2Fcerts%2Fc.key'
    )
    expect(pg?.patch).toMatchObject({
      ssl: 'verify-full',
      sslRootCert: '/certs/ca.pem',
      sslClientCert: '/certs/c.crt',
      sslClientKey: '/certs/c.key'
    })
    const my = parseConnectionString('mysql://u@h/db?ssl-mode=VERIFY_CA&ssl-ca=ca.pem')
    expect(my?.patch).toMatchObject({ ssl: 'verify-ca', sslRootCert: 'ca.pem' })
    expect(parseConnectionString('postgres://u@h/db')?.patch).not.toHaveProperty('sslRootCert')
    expect(sslModeFromParam('VERIFY_IDENTITY')).toBe('verify-full')
    expect(sslModeFromParam('REQUIRED')).toBe('require')
    expect(sslModeFromParam('DISABLED')).toBe('disable')
    expect(sslModeFromParam('allow')).toBe('prefer')
  })

  it('reads ADO.NET strings', () => {
    const ms = parseConnectionString(
      'Server=tcp:sql.example.com,1444;Database=Shop;User Id=sa;Password=x;TrustServerCertificate=True'
    )
    expect(ms?.engine).toBe('mssql')
    expect(ms?.patch).toMatchObject({
      host: 'sql.example.com',
      port: 1444,
      database: 'Shop',
      user: 'sa',
      trustServerCertificate: true
    })
    expect(ms?.password).toBe('x')
  })
})

describe('EJSON', () => {
  it('round-trips shell syntax', () => {
    const doc = {
      _id: { $oid: '65a1f0c2e4b0a1b2c3d4e5f6' },
      at: { $date: '2024-01-02T03:04:05.678Z' },
      n: { $numberLong: '9007199254740993' },
      d: { $numberDouble: '2.0' },
      f: 1.5,
      i: 3,
      tags: ['a', 'b'],
      nested: { ok: true, none: null }
    }
    const text = toShell(doc)
    expect(text).toContain("ObjectId('65a1f0c2e4b0a1b2c3d4e5f6')")
    expect(text).toContain("NumberLong('9007199254740993')")
    expect(text).toContain('d: Double(2)')
    const back = parseShellValue(text) as Record<string, unknown>
    expect(back._id).toEqual(doc._id)
    expect(back.at).toEqual(doc.at)
    expect(back.n).toEqual(doc.n)
    expect(back.d).toEqual(doc.d)
    expect(back.i).toBe(3)
    expect(back.tags).toEqual(['a', 'b'])
  })

  it('renders scalars', () => {
    expect(scalarText({ $oid: 'abc' })).toBe('abc')
    expect(scalarText({ $binary: { base64: 'AAECAwQFBgcICQoLDA0ODw==', subType: '04' } })).toBe(
      '00010203-0405-0607-0809-0a0b0c0d0e0f'
    )
  })
})

describe('parseShell', () => {
  it('records chained find calls', () => {
    const ops = parseShell(
      'db.users.find({ age: { $gt: 30 } }, { name: 1 }).sort({ name: -1 }).limit(5)',
      'app'
    )
    expect(ops).toHaveLength(1)
    const op = ops[0]
    expect(op.kind).toBe('request')
    if (op.kind !== 'request') return
    expect(op.request).toMatchObject({
      op: 'find',
      database: 'app',
      collection: 'users',
      filter: { age: { $gt: 30 } },
      projection: { name: 1 },
      sort: { name: -1 },
      limit: 5
    })
  })

  it('handles use, show, helpers and odd collection names', () => {
    const ops = parseShell(
      "use shop\nshow collections\ndb.getCollection('order-items').insertOne({ _id: ObjectId('65a1f0c2e4b0a1b2c3d4e5f6'), at: ISODate('2024-01-01T00:00:00Z') })\ndb.system.profile.find()",
      'app'
    )
    expect(ops.map((o) => o.kind)).toEqual(['use', 'show', 'request', 'request'])
    const insert = ops[2]
    if (insert.kind !== 'request' || insert.request.op !== 'insertOne')
      throw new Error('expected insert')
    expect(insert.request.database).toBe('shop')
    expect(insert.request.collection).toBe('order-items')
    expect(insert.request.document).toEqual({
      _id: { $oid: '65a1f0c2e4b0a1b2c3d4e5f6' },
      at: { $date: '2024-01-01T00:00:00.000Z' }
    })
    const profile = ops[3]
    expect(
      profile.kind === 'request' && profile.request.op === 'find' && profile.request.collection
    ).toBe('system.profile')
  })

  it('turns count() and explain() into the right requests', () => {
    const [count] = parseShell('db.users.find({ a: 1 }).count()', 'app')
    expect(count.kind === 'request' && count.request.op).toBe('count')
    const [explain] = parseShell('db.users.find({ a: 1 }).explain()', 'app')
    expect(explain.kind === 'request' && explain.request.op).toBe('runCommand')
  })

  it('accepts aggregate with an array or varargs', () => {
    const [a] = parseShell("db.o.aggregate([{ $match: { s: 'x' } }, { $count: 'n' }])", 'app')
    const [b] = parseShell("db.o.aggregate({ $match: { s: 'x' } }, { $count: 'n' })", 'app')
    expect(a.kind === 'request' && a.request).toEqual(b.kind === 'request' && b.request)
  })

  it('reports syntax errors', () => {
    expect(() => parseShell('db.users.find({ a: }', 'app')).toThrow(/Syntax error/)
  })

  it('sends cursor options instead of dropping them', () => {
    const [find] = parseShell(
      "db.users.find({ a: 1 }).hint({ a: 1 }).maxTimeMS(500).collation({ locale: 'fr' }).allowDiskUse().readPref('secondary')",
      'app'
    )
    expect(find.kind === 'request' && find.request).toMatchObject({
      op: 'find',
      options: {
        hint: { a: 1 },
        maxTimeMS: 500,
        collation: { locale: 'fr' },
        allowDiskUse: true,
        readPreference: 'secondary'
      }
    })
    const [agg] = parseShell(
      "db.o.aggregate([{ $sort: { x: 1 } }], { allowDiskUse: true, hint: 'x_1' })",
      'app'
    )
    expect(agg.kind === 'request' && agg.request).toMatchObject({
      op: 'aggregate',
      options: { allowDiskUse: true, hint: 'x_1' }
    })
    const [count] = parseShell("db.users.find({ a: 1 }).hint('a_1').count()", 'app')
    expect(count.kind === 'request' && count.request).toMatchObject({
      op: 'count',
      options: { hint: 'a_1' }
    })
    const [explain] = parseShell("db.users.find({ a: 1 }).hint('a_1').explain()", 'app')
    expect(explain.kind === 'request' && explain.request).toMatchObject({
      op: 'runCommand',
      command: { explain: { find: 'users', hint: 'a_1' } }
    })
  })

  it('rejects scripts that read query results', () => {
    expect(() => parseShell('db.users.find().forEach((d) => print(d.name))', 'app')).toThrow(
      /forEach\(\) isn't supported/
    )
    expect(() => parseShell('db.users.find().map((d) => d.name)', 'app')).toThrow(/map/)
    expect(() => parseShell('const docs = db.users.find().toArray(); docs.length', 'app')).toThrow(
      /\.length/
    )
    expect(() => parseShell('if (db.users.countDocuments() > 0) print("x")', 'app')).toThrow(
      /expression/
    )
    expect(() => parseShell('print(db.users.findOne())', 'app')).toThrow(/Printing/)
    // A trailing toArray() only shows the results, which is fine
    expect(parseShell('db.users.find().toArray()', 'app')).toHaveLength(1)
  })

  it('rejects options it would otherwise ignore', () => {
    expect(() =>
      parseShell("db.u.updateOne({}, { $set: { 'a.$[x]': 1 } }, { arrayFilters: [] })", 'app')
    ).toThrow(/arrayFilters/)
    expect(() => parseShell('db.u.deleteMany({}, { hint: { a: 1 } })', 'app')).toThrow(/hint/)
    expect(() => parseShell('db.u.find({}, null, { tailable: true })', 'app')).toThrow(/tailable/)
    const [upd] = parseShell(
      "db.u.findOneAndUpdate({}, { $set: { a: 1 } }, { arrayFilters: [{ 'x.y': 1 }] })",
      'app'
    )
    expect(upd.kind === 'request' && upd.request).toMatchObject({
      command: { arrayFilters: [{ 'x.y': 1 }] }
    })
  })
})
