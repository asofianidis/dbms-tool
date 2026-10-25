import { describe, expect, it } from 'vitest'
import { newColumn, newIndex, newTableDraft, tableStatements, validateDraft } from '../ddl'
import {
  compactVector,
  declaredSrid,
  extensionCellDisplay,
  extensionColumnTypes,
  extensionEditText,
  extensionIndexMethods,
  indexOpclasses,
  installedExtensions,
  methodDefaults,
  NO_PG_EXTENSIONS,
  parsePgExtensions,
  spatialLiteral,
  vectorDims,
  type PgExtensions
} from '../pg-extensions-aware'
import { literal } from '../sql'
import { functionsFor } from '../sql-functions'

const BOTH: PgExtensions = { vector: '0.8.0', postgis: '3.5.2' }
const POINT_4326 = '0101000020E6100000CB49287D21C451C0F0BF95ECD8244540'

describe('extension detection', () => {
  it('reads pg_extension rows', () => {
    expect(parsePgExtensions([['vector', '0.8.0']])).toEqual({ vector: '0.8.0', postgis: null })
    expect(parsePgExtensions([])).toEqual(NO_PG_EXTENSIONS)
    expect(installedExtensions(BOTH)).toEqual(['vector', 'postgis'])
    expect(installedExtensions(NO_PG_EXTENSIONS)).toEqual([])
  })
})

describe('designer types and index methods', () => {
  it('offers types only for installed extensions', () => {
    expect(extensionColumnTypes(NO_PG_EXTENSIONS)).toEqual([])
    expect(extensionColumnTypes({ vector: '0.6.2', postgis: null })).toEqual(['vector(1536)'])
    const all = extensionColumnTypes(BOTH)
    expect(all).toContain('halfvec(1536)')
    expect(all).toContain('sparsevec(1536)')
    expect(all).toContain('geometry(Point,4326)')
    expect(all).toContain('geography(Point,4326)')
  })

  it('offers pgvector methods and operator classes', () => {
    expect(extensionIndexMethods(NO_PG_EXTENSIONS)).toEqual([])
    expect(extensionIndexMethods(BOTH)).toEqual(['hnsw', 'ivfflat'])
    expect(indexOpclasses('hnsw', BOTH)).toEqual(
      expect.arrayContaining([
        'vector_l2_ops',
        'vector_cosine_ops',
        'vector_ip_ops',
        'vector_l1_ops'
      ])
    )
    // IVFFlat has no L1 or sparsevec support
    expect(indexOpclasses('ivfflat', BOTH)).not.toContain('vector_l1_ops')
    expect(indexOpclasses('ivfflat', BOTH)).not.toContain('sparsevec_l2_ops')
    expect(indexOpclasses('gist', BOTH)[0]).toBe('gist_geometry_ops_2d')
    expect(indexOpclasses('gist', NO_PG_EXTENSIONS)).toEqual([])
    expect(indexOpclasses('btree', BOTH)).toEqual([])
    expect(methodDefaults('hnsw', BOTH)).toEqual({ opclass: 'vector_l2_ops', params: {} })
    expect(methodDefaults('gist', BOTH)).toEqual({ opclass: '', params: {} })
  })
})

describe('index DDL', () => {
  const draft = (): ReturnType<typeof newTableDraft> => {
    const d = newTableDraft('postgres', 'public')
    d.name = 'items'
    d.columns.push(newColumn('postgres', { name: 'embedding', dataType: 'vector(3)' }))
    d.columns.push(newColumn('postgres', { name: 'geom', dataType: 'geometry(Point,4326)' }))
    return d
  }

  it('writes HNSW with an operator class and parameters', () => {
    const d = draft()
    d.indexes.push(
      newIndex({
        name: 'items_embedding_idx',
        columns: [d.columns[1].id],
        method: 'hnsw',
        opclass: 'vector_cosine_ops',
        params: { m: '16', ef_construction: '64' }
      })
    )
    expect(tableStatements('postgres', d)).toContain(
      'CREATE INDEX items_embedding_idx ON public.items USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)'
    )
  })

  it('writes IVFFlat lists and GiST on geometry', () => {
    const d = draft()
    d.indexes.push(
      newIndex({
        name: 'e',
        columns: [d.columns[1].id],
        method: 'ivfflat',
        opclass: 'vector_l2_ops',
        params: { lists: '100' }
      }),
      newIndex({ name: 'g', columns: [d.columns[2].id], method: 'gist' }),
      newIndex({
        name: 's',
        columns: [d.columns[2].id],
        method: 'spgist',
        opclass: 'spgist_geometry_ops_2d',
        // Parameters that aren't whole numbers are left out
        params: { fillfactor: '' }
      })
    )
    const out = tableStatements('postgres', d)
    expect(out).toContain(
      'CREATE INDEX e ON public.items USING ivfflat (embedding vector_l2_ops) WITH (lists = 100)'
    )
    expect(out).toContain('CREATE INDEX g ON public.items USING gist (geom)')
    expect(out).toContain(
      'CREATE INDEX s ON public.items USING spgist (geom spgist_geometry_ops_2d)'
    )
  })

  it('requires an operator class for pgvector methods', () => {
    const d = draft()
    d.indexes.push(newIndex({ name: 'e', columns: [d.columns[1].id], method: 'hnsw' }))
    expect(validateDraft('postgres', d)).toMatch(/operator class/)
  })

  it('leaves other engines alone', () => {
    const d = newTableDraft('mysql', 'db')
    d.name = 't'
    d.indexes.push(
      newIndex({ name: 'i', columns: [d.columns[0].id], opclass: 'x_ops', params: { m: '16' } })
    )
    expect(tableStatements('mysql', d).join('\n')).not.toMatch(/x_ops|WITH/)
  })
})

describe('values', () => {
  it('shows geometry as EWKT in the grid', () => {
    expect(extensionCellDisplay(POINT_4326, 'geometry')).toBe(
      'SRID=4326;POINT(-71.064544 42.28787)'
    )
    expect(extensionCellDisplay(POINT_4326, 'geography')).toBe(
      'SRID=4326;POINT(-71.064544 42.28787)'
    )
    // Not EWKB (e.g. an edited value): shown as it is
    expect(extensionCellDisplay('POINT(1 2)', 'geometry')).toBeNull()
    expect(extensionCellDisplay(POINT_4326, 'text')).toBeNull()
    expect(extensionCellDisplay(POINT_4326, '')).toBeNull()
  })

  it('edits geometry as EWKT', () => {
    expect(extensionEditText(POINT_4326, 'geometry')).toBe('SRID=4326;POINT(-71.064544 42.28787)')
    expect(extensionEditText('[1,2]', 'vector')).toBeNull()
    expect(extensionEditText(null, 'geometry')).toBeNull()
  })

  it('shortens vectors', () => {
    const long = `[${Array.from({ length: 1536 }, (_, i) => (i % 7) / 10).join(',')}]`
    expect(compactVector(long)).toBe('[0, 0.1, 0.2, … 1,536 dims]')
    expect(compactVector('[1,2,3]')).toBe('[1, 2, 3]')
    expect(compactVector('[]')).toBe('[]')
    expect(compactVector('{1:0.5,3:2}/5')).toBe('{1:0.5, 3:2} 2 of 5 dims')
    expect(compactVector('{1:1,2:2,3:3,4:4}/1000')).toBe('{1:1, 2:2, 3:3, …} 4 of 1,000 dims')
    expect(compactVector('0x0102')).toBeNull()
    expect(extensionCellDisplay(long, 'halfvec')).toBe('[0, 0.1, 0.2, … 1,536 dims]')
    expect(vectorDims(long)).toBe(1536)
    expect(vectorDims('{1:0.5}/7')).toBe(7)
    expect(vectorDims('abc')).toBeNull()
  })

  it('writes spatial literals with the column SRID and type', () => {
    expect(declaredSrid('geometry(Point,4326)')).toBe(4326)
    expect(declaredSrid('geometry')).toBeNull()
    expect(declaredSrid('geometry(Point)')).toBeNull()
    expect(declaredSrid('geography')).toBe(4326)
    expect(spatialLiteral('POINT(1 2)', 'geometry(Point,4326)')).toBe(
      "'SRID=4326;POINT(1 2)'::geometry(Point,4326)"
    )
    expect(spatialLiteral('point z (1 2 3)', 'geometry(PointZ,3857)')).toBe(
      "'SRID=3857;point z (1 2 3)'::geometry(PointZ,3857)"
    )
    expect(spatialLiteral('SRID=3857;POINT(1 2)', 'geometry')).toBe(
      "'SRID=3857;POINT(1 2)'::geometry"
    )
    expect(spatialLiteral(POINT_4326, 'geometry(Point,4326)')).toBe(
      `'${POINT_4326}'::geometry(Point,4326)`
    )
    expect(literal('postgres', 'POINT(1 2)', 'geography(Point,4326)')).toBe(
      "'SRID=4326;POINT(1 2)'::geography(Point,4326)"
    )
    expect(literal('postgres', "POINT(1 2)'", 'geometry')).toBe("'POINT(1 2)'''::geometry")
    // Other dialects (MySQL has its own geometry type) are unchanged
    expect(literal('mysql', 'POINT(1 2)', 'geometry')).toBe("'POINT(1 2)'")
    expect(literal('postgres', '[1,2,3]', 'vector(3)')).toBe("'[1,2,3]'")
  })
})

describe('completion', () => {
  it('completes extension functions only where installed', () => {
    const names = (ext?: string[]): string[] =>
      functionsFor('postgres', null, ext).map((f) => f.name)
    expect(names()).not.toContain('l2_distance')
    expect(names()).not.toContain('ST_AsText')
    expect(names(['vector'])).toContain('cosine_distance')
    expect(names(['vector'])).not.toContain('ST_AsText')
    expect(names(['postgis'])).toContain('ST_DWithin')
    expect(functionsFor('mysql', null, ['vector', 'postgis']).map((f) => f.name)).not.toContain(
      'l2_distance'
    )
    const fn = functionsFor('postgres', null, ['vector']).find((f) => f.name === 'l2_distance')
    expect(fn?.description).toMatch(/pgvector/)
  })
})
