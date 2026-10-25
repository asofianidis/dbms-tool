import type { SqlFunction } from './sql-functions'

/**
 * Functions of pgvector and PostGIS, completed only on PostgreSQL databases
 * that have the extension installed (see functionsFor()).
 */

const vector = (f: Omit<SqlFunction, 'dialects' | 'extension'>): SqlFunction => ({
  ...f,
  description: `${f.description} (pgvector)`,
  dialects: ['postgres'],
  extension: 'vector'
})

const postgis = (f: Omit<SqlFunction, 'dialects' | 'extension'>): SqlFunction => ({
  ...f,
  description: `${f.description} (PostGIS)`,
  dialects: ['postgres'],
  extension: 'postgis'
})

export const PG_EXTENSION_FUNCTIONS: SqlFunction[] = [
  vector({
    name: 'l2_distance',
    params: ['a', 'b'],
    returns: 'double precision',
    description: 'Euclidean distance; the <-> operator, which HNSW / IVFFlat indexes serve'
  }),
  vector({
    name: 'cosine_distance',
    params: ['a', 'b'],
    returns: 'double precision',
    description: 'Cosine distance; the <=> operator'
  }),
  vector({
    name: 'inner_product',
    params: ['a', 'b'],
    returns: 'double precision',
    description: 'Inner product; <#> is its negative'
  }),
  vector({
    name: 'l1_distance',
    params: ['a', 'b'],
    returns: 'double precision',
    description: 'Taxicab distance; the <+> operator'
  }),
  vector({
    name: 'vector_dims',
    params: ['vector'],
    returns: 'integer',
    description: 'Number of dimensions'
  }),
  vector({
    name: 'vector_norm',
    params: ['vector'],
    returns: 'double precision',
    description: 'Euclidean norm'
  }),
  vector({
    name: 'l2_norm',
    params: ['halfvec'],
    returns: 'double precision',
    description: 'Euclidean norm of a halfvec or sparsevec'
  }),
  vector({
    name: 'l2_normalize',
    params: ['vector'],
    returns: 'vector',
    description: 'The vector scaled to length 1'
  }),
  vector({
    name: 'binary_quantize',
    params: ['vector'],
    returns: 'bit',
    description: 'One bit per dimension: whether it is positive'
  }),
  vector({
    name: 'subvector',
    params: ['vector', 'start', 'count'],
    returns: 'vector',
    description: 'Dimensions start (1-based) to start + count - 1'
  }),
  vector({
    name: 'hamming_distance',
    params: ['a bit', 'b bit'],
    returns: 'double precision',
    description: 'Hamming distance; the <~> operator'
  }),
  vector({
    name: 'jaccard_distance',
    params: ['a bit', 'b bit'],
    returns: 'double precision',
    description: 'Jaccard distance; the <%> operator'
  }),

  postgis({
    name: 'ST_AsText',
    params: ['geom'],
    returns: 'text',
    description: 'Well-known text (WKT)'
  }),
  postgis({
    name: 'ST_AsEWKT',
    params: ['geom'],
    returns: 'text',
    description: 'WKT with the SRID: SRID=4326;POINT(1 2)'
  }),
  postgis({
    name: 'ST_AsGeoJSON',
    params: ['geom', 'maxdecimaldigits'],
    returns: 'text',
    description: 'GeoJSON geometry'
  }),
  postgis({
    name: 'ST_GeomFromText',
    params: ['wkt', 'srid'],
    returns: 'geometry',
    description: 'A geometry from WKT'
  }),
  postgis({
    name: 'ST_GeomFromEWKT',
    params: ['ewkt'],
    returns: 'geometry',
    description: 'A geometry from EWKT'
  }),
  postgis({
    name: 'ST_GeomFromGeoJSON',
    params: ['geojson'],
    returns: 'geometry',
    description: 'A geometry from GeoJSON'
  }),
  postgis({
    name: 'ST_MakePoint',
    params: ['x', 'y', 'z', 'm'],
    returns: 'geometry',
    description: 'A point from coordinates'
  }),
  postgis({
    name: 'ST_Point',
    params: ['x', 'y', 'srid'],
    returns: 'geometry',
    description: 'A point, optionally with an SRID'
  }),
  postgis({
    name: 'ST_SetSRID',
    params: ['geom', 'srid'],
    returns: 'geometry',
    description: 'The geometry labelled with an SRID (no reprojection)'
  }),
  postgis({ name: 'ST_SRID', params: ['geom'], returns: 'integer', description: 'The SRID' }),
  postgis({
    name: 'ST_Transform',
    params: ['geom', 'srid'],
    returns: 'geometry',
    description: 'The geometry reprojected to another SRID'
  }),
  postgis({
    name: 'ST_Distance',
    params: ['a', 'b'],
    returns: 'double precision',
    description: 'Minimum distance; meters for geography'
  }),
  postgis({
    name: 'ST_DWithin',
    params: ['a', 'b', 'distance'],
    returns: 'boolean',
    description: 'Whether within a distance; index-assisted'
  }),
  postgis({
    name: 'ST_Intersects',
    params: ['a', 'b'],
    returns: 'boolean',
    description: 'Whether the geometries share any space; index-assisted'
  }),
  postgis({
    name: 'ST_Contains',
    params: ['a', 'b'],
    returns: 'boolean',
    description: 'Whether b lies inside a'
  }),
  postgis({
    name: 'ST_Within',
    params: ['a', 'b'],
    returns: 'boolean',
    description: 'Whether a lies inside b'
  }),
  postgis({
    name: 'ST_Area',
    params: ['geom'],
    returns: 'double precision',
    description: 'Area; square meters for geography'
  }),
  postgis({
    name: 'ST_Length',
    params: ['geom'],
    returns: 'double precision',
    description: 'Length of linear geometries; meters for geography'
  }),
  postgis({
    name: 'ST_Buffer',
    params: ['geom', 'radius'],
    returns: 'geometry',
    description: 'The area within a distance of the geometry'
  }),
  postgis({
    name: 'ST_Centroid',
    params: ['geom'],
    returns: 'geometry',
    description: 'Geometric center'
  }),
  postgis({
    name: 'ST_Envelope',
    params: ['geom'],
    returns: 'geometry',
    description: 'Bounding box as a polygon'
  }),
  postgis({
    name: 'ST_MakeEnvelope',
    params: ['xmin', 'ymin', 'xmax', 'ymax', 'srid'],
    returns: 'geometry',
    description: 'A rectangle polygon'
  }),
  postgis({
    name: 'ST_X',
    params: ['point'],
    returns: 'double precision',
    description: 'X of a point'
  }),
  postgis({
    name: 'ST_Y',
    params: ['point'],
    returns: 'double precision',
    description: 'Y of a point'
  }),
  postgis({
    name: 'ST_GeometryType',
    params: ['geom'],
    returns: 'text',
    description: 'Type name, e.g. ST_Polygon'
  }),
  postgis({
    name: 'ST_IsValid',
    params: ['geom'],
    returns: 'boolean',
    description: 'Whether the geometry is well-formed'
  }),
  postgis({
    name: 'ST_MakeValid',
    params: ['geom'],
    returns: 'geometry',
    description: 'A valid version of an invalid geometry'
  }),
  postgis({
    name: 'ST_Union',
    params: ['geom'],
    returns: 'geometry',
    description: 'Union of the geometries (aggregate) or of two'
  }),
  postgis({
    name: 'ST_Simplify',
    params: ['geom', 'tolerance'],
    returns: 'geometry',
    description: 'Simplified with Douglas-Peucker'
  }),
  postgis({
    name: 'ST_NPoints',
    params: ['geom'],
    returns: 'integer',
    description: 'Number of points'
  })
]
