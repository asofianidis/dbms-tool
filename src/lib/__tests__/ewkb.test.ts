import { describe, expect, it } from 'vitest'
import {
  decodeEwkb,
  ewkbToEwkt,
  formatOrdinate,
  geometryLabel,
  isSpatialType,
  pointCount,
  toEwkt,
  toGeoJson
} from '../ewkb'

/**
 * `geom::text` and `ST_AsEWKT(geom)` from PostGIS 3.5.2 (postgis/postgis:17-3.5),
 * for each source text: SELECT src::geometry::text, ST_AsEWKT(src::geometry).
 */
const FIXTURES: [source: string, hex: string, ewkt: string][] = [
  ['POINT(1 2)', '0101000000000000000000F03F0000000000000040', 'POINT(1 2)'],
  [
    'SRID=4326;POINT(-71.064544 42.28787)',
    '0101000020E6100000CB49287D21C451C0F0BF95ECD8244540',
    'SRID=4326;POINT(-71.064544 42.28787)'
  ],
  ['POINT Z (1 2 3)', '0101000080000000000000F03F00000000000000400000000000000840', 'POINT(1 2 3)'],
  ['POINTM(1 2 4)', '0101000040000000000000F03F00000000000000400000000000001040', 'POINTM(1 2 4)'],
  [
    'SRID=3857;POINT ZM (1 2 3 4)',
    '01010000E0110F0000000000000000F03F000000000000004000000000000008400000000000001040',
    'SRID=3857;POINT(1 2 3 4)'
  ],
  ['POINT EMPTY', '0101000000000000000000F87F000000000000F87F', 'POINT EMPTY'],
  [
    'LINESTRING(0 0,1 1,2 1.5)',
    '01020000000300000000000000000000000000000000000000000000000000F03F000000000000F03F0000000000000040000000000000F83F',
    'LINESTRING(0 0,1 1,2 1.5)'
  ],
  [
    'SRID=4326;POLYGON((0 0,10 0,10 10,0 10,0 0),(2 2,2 3,3 3,3 2,2 2))',
    '0103000020E610000002000000050000000000000000000000000000000000000000000000000024400000000000000000000000000000244000000000000024400000000000000000000000000000244000000000000000000000000000000000050000000000000000000040000000000000004000000000000000400000000000000840000000000000084000000000000008400000000000000840000000000000004000000000000000400000000000000040',
    'SRID=4326;POLYGON((0 0,10 0,10 10,0 10,0 0),(2 2,2 3,3 3,3 2,2 2))'
  ],
  [
    'MULTIPOINT((0 0),(1 2))',
    '0104000000020000000101000000000000000000000000000000000000000101000000000000000000F03F0000000000000040',
    'MULTIPOINT(0 0,1 2)'
  ],
  [
    'SRID=4326;MULTILINESTRING((0 0,1 1),(2 2,3 3))',
    '0105000020E61000000200000001020000000200000000000000000000000000000000000000000000000000F03F000000000000F03F0102000000020000000000000000000040000000000000004000000000000008400000000000000840',
    'SRID=4326;MULTILINESTRING((0 0,1 1),(2 2,3 3))'
  ],
  [
    'MULTIPOLYGON(((0 0,1 0,1 1,0 0)),((5 5,6 5,6 6,5 5)))',
    '0106000000020000000103000000010000000400000000000000000000000000000000000000000000000000F03F0000000000000000000000000000F03F000000000000F03F000000000000000000000000000000000103000000010000000400000000000000000014400000000000001440000000000000184000000000000014400000000000001840000000000000184000000000000014400000000000001440',
    'MULTIPOLYGON(((0 0,1 0,1 1,0 0)),((5 5,6 5,6 6,5 5)))'
  ],
  [
    'SRID=4326;GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,1 1))',
    '0107000020E6100000020000000101000000000000000000F03F000000000000004001020000000200000000000000000000000000000000000000000000000000F03F000000000000F03F',
    'SRID=4326;GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,1 1))'
  ],
  ['GEOMETRYCOLLECTION EMPTY', '010700000000000000', 'GEOMETRYCOLLECTION EMPTY'],
  ['POLYGON EMPTY', '010300000000000000', 'POLYGON EMPTY'],
  [
    'POINT(0.3333333333333333 123456789.123456)',
    '0101000000555555555555D53F406B7E54346F9D41',
    'POINT(0.333333333333333 123456789.123456)'
  ],
  [
    'POINT(1e-7 -2.5e20)',
    '010100000048AFBC9AF2D77A3E50EFE2D6E41A2BC4',
    'POINT(0.0000001 -2.5e+20)'
  ],
  [
    'LINESTRING Z (0 0 0,1 1 1)',
    '010200008002000000000000000000000000000000000000000000000000000000000000000000F03F000000000000F03F000000000000F03F',
    'LINESTRING(0 0 0,1 1 1)'
  ],
  // geography: 'SRID=4326;POINT(-71.06 42.28)'::geography::text
  [
    'SRID=4326;POINT(-71.06 42.28)',
    '0101000020E6100000A4703D0AD7C351C0A4703D0AD7234540',
    'SRID=4326;POINT(-71.06 42.28)'
  ]
]

describe('EWKB decoding', () => {
  it.each(FIXTURES)('%s prints as ST_AsEWKT does', (_source, hex, ewkt) => {
    expect(ewkbToEwkt(hex)).toBe(ewkt)
    // Lower-case hex decodes too
    expect(ewkbToEwkt(hex.toLowerCase())).toBe(ewkt)
  })

  it('reads SRID and dimension flags', () => {
    const g = decodeEwkb(FIXTURES[4][1])!
    expect(g).toMatchObject({ kind: 'Point', srid: 3857, hasZ: true, hasM: true })
    expect(geometryLabel(g)).toBe('Point ZM')
    expect(geometryLabel(decodeEwkb(FIXTURES[3][1])!)).toBe('Point M')
  })

  it('reads big-endian and ISO WKB', () => {
    // ST_AsBinary('POINT(1 2)', 'XDR') and ST_AsBinary('POINT Z (1 2 3)') (ISO type 1001)
    expect(ewkbToEwkt('00000000013FF00000000000004000000000000000')).toBe('POINT(1 2)')
    expect(ewkbToEwkt('01E9030000000000000000F03F00000000000000400000000000000840')).toBe(
      'POINT(1 2 3)'
    )
  })

  it('rejects what is not EWKB', () => {
    for (const v of [
      '',
      'POINT(1 2)',
      '\\x0101000000000000000000F03F0000000000000040',
      '0x0101000000000000000000F03F0000000000000040',
      // cut short, trailing bytes, unknown type
      '0101000000000000000000F03F00000000000000',
      '0101000000000000000000F03F0000000000000040FF',
      '0163000000000000000000F03F0000000000000040',
      'deadbeefdeadbeefdeadbeef'
    ])
      expect(decodeEwkb(v)).toBeNull()
  })

  it('cuts long EWKT at the limit', () => {
    const text = toEwkt(decodeEwkb(FIXTURES[7][1])!, 30)
    expect(text).toBe('SRID=4326;POLYGON((0 0,10 0,10…')
  })

  it('counts points', () => {
    expect(pointCount(decodeEwkb(FIXTURES[7][1])!)).toBe(10)
    expect(pointCount(decodeEwkb(FIXTURES[11][1])!)).toBe(3)
  })

  it('formats ordinates as PostGIS does', () => {
    expect(formatOrdinate(1)).toBe('1')
    expect(formatOrdinate(-0)).toBe('0')
    expect(formatOrdinate(1 / 3)).toBe('0.333333333333333')
    // ST_AsEWKT('POINT(-1.5e-9 1e15)'), ('POINT(1e-8 9.9e-9)'), ('POINT(999999999999999 1.5e15)')
    expect(formatOrdinate(-1.5e-9)).toBe('-1.5e-9')
    expect(formatOrdinate(1e15)).toBe('1e+15')
    expect(formatOrdinate(1e-8)).toBe('1e-8')
    expect(formatOrdinate(9.9e-9)).toBe('9.9e-9')
    expect(formatOrdinate(999999999999999)).toBe('999999999999999')
    expect(formatOrdinate(1.5e15)).toBe('1.5e+15')
    expect(formatOrdinate(1.23456789012e-12)).toBe('1.23456789012e-12')
  })
})

describe('GeoJSON', () => {
  // ST_AsGeoJSON(geom) from the same server
  it.each([
    [FIXTURES[1][1], '{"type":"Point","coordinates":[-71.064544,42.28787]}'],
    [
      FIXTURES[4][1],
      '{"type":"Point","crs":{"type":"name","properties":{"name":"EPSG:3857"}},"coordinates":[1,2,3]}'
    ],
    [FIXTURES[3][1], '{"type":"Point","coordinates":[1,2]}'],
    [FIXTURES[5][1], '{"type":"Point","coordinates":[]}'],
    [
      FIXTURES[7][1],
      '{"type":"Polygon","coordinates":[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[2,2],[2,3],[3,3],[3,2],[2,2]]]}'
    ],
    [FIXTURES[8][1], '{"type":"MultiPoint","coordinates":[[0,0],[1,2]]}'],
    [
      FIXTURES[11][1],
      '{"type":"GeometryCollection","geometries":[{"type":"Point","coordinates":[1,2]},{"type":"LineString","coordinates":[[0,0],[1,1]]}]}'
    ],
    [FIXTURES[17][1], '{"type":"Point","coordinates":[-71.06,42.28]}']
  ])('%s matches ST_AsGeoJSON', (hex, json) => {
    expect(JSON.parse(toGeoJson(decodeEwkb(hex)!))).toEqual(JSON.parse(json))
    expect(toGeoJson(decodeEwkb(hex)!)).toBe(json)
  })
})

describe('isSpatialType', () => {
  it('matches PostGIS types only', () => {
    expect(isSpatialType('geometry')).toBe(true)
    expect(isSpatialType('geometry(Point,4326)')).toBe(true)
    expect(isSpatialType('geography(Polygon,4326)')).toBe(true)
    expect(isSpatialType('extensions.geometry(Point,4326)')).toBe(true)
    expect(isSpatialType('text')).toBe(false)
    expect(isSpatialType('geometry_columns')).toBe(false)
  })
})
