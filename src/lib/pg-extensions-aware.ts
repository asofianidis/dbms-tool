/**
 * pgvector and PostGIS support: which of them a PostgreSQL database has, the
 * column types, index methods and operator classes they add, and how their
 * values are shown in the grid. Everything here is inert unless the extension
 * is installed (`pg_extension`) or the column has one of its types.
 */
import type { Cell } from './api'
import { decodeEwkb, isSpatialType, toEwkt } from './ewkb'

export { isSpatialType } from './ewkb'

/** Installed versions, null when the extension isn't in the database. */
export interface PgExtensions {
  vector: string | null
  postgis: string | null
}

export const NO_PG_EXTENSIONS: PgExtensions = { vector: null, postgis: null }

export const pgExtensionsSql = `SELECT extname::text, extversion::text FROM pg_extension WHERE extname IN ('vector', 'postgis')`

export function parsePgExtensions(rows: Cell[][]): PgExtensions {
  const out = { ...NO_PG_EXTENSIONS }
  for (const [name, version] of rows) {
    if (name === 'vector' || name === 'postgis') out[name] = String(version ?? '')
  }
  return out
}

/** Names of the installed extensions, for gating completion. */
export function installedExtensions(ext: PgExtensions): string[] {
  return (['vector', 'postgis'] as const).filter((k) => ext[k] !== null)
}

/** Whether `version` (e.g. `0.8.0`) is at least major.minor. */
export function atLeast(version: string | null, major: number, minor: number): boolean {
  if (version === null) return false
  const [a = 0, b = 0] = version.split('.').map((n) => parseInt(n, 10) || 0)
  return a > major || (a === major && b >= minor)
}

/* ---------- Table designer ---------- */

/** Column types the extensions add, spelled as format_type() spells them. */
export function extensionColumnTypes(ext: PgExtensions): string[] {
  const out: string[] = []
  if (ext.vector !== null) {
    out.push('vector(1536)')
    // halfvec and sparsevec arrived in pgvector 0.7
    if (atLeast(ext.vector, 0, 7)) out.push('halfvec(1536)', 'sparsevec(1536)')
  }
  if (ext.postgis !== null) {
    out.push(
      'geometry',
      'geometry(Point,4326)',
      'geometry(LineString,4326)',
      'geometry(Polygon,4326)',
      'geometry(MultiPolygon,4326)',
      'geometry(PointZ,4326)',
      'geography(Point,4326)',
      'geography(Polygon,4326)'
    )
  }
  return out
}

/** Index access methods beyond PostgreSQL's own. */
export function extensionIndexMethods(ext: PgExtensions): string[] {
  return ext.vector !== null ? ['hnsw', 'ivfflat'] : []
}

/** Methods that have no default operator class, so the designer has to name one. */
export const needsOpclass = (method: string): boolean => /^(hnsw|ivfflat)$/i.test(method.trim())

/** Operator classes worth offering for an index method, the usual one first. */
export function indexOpclasses(method: string, ext: PgExtensions): string[] {
  const m = method.trim().toLowerCase()
  const v7 = atLeast(ext.vector, 0, 7)
  if (ext.vector !== null && (m === 'hnsw' || m === 'ivfflat')) {
    const kinds = ['vector', ...(v7 ? ['halfvec'] : [])]
    const ops = m === 'hnsw' && v7 ? ['l2', 'cosine', 'ip', 'l1'] : ['l2', 'cosine', 'ip']
    const out = kinds.flatMap((k) => ops.map((o) => `${k}_${o}_ops`))
    if (v7) {
      if (m === 'hnsw') out.push(...ops.map((o) => `sparsevec_${o}_ops`))
      out.push('bit_hamming_ops', ...(m === 'hnsw' ? ['bit_jaccard_ops'] : []))
    }
    return out
  }
  if (ext.postgis !== null && m === 'gist')
    return ['gist_geometry_ops_2d', 'gist_geometry_ops_nd', 'gist_geography_ops']
  if (ext.postgis !== null && m === 'spgist')
    return [
      'spgist_geometry_ops_2d',
      'spgist_geometry_ops_3d',
      'spgist_geometry_ops_nd',
      'spgist_geography_ops_nd'
    ]
  return []
}

export interface IndexParam {
  name: string
  /** pgvector's default, shown as the placeholder */
  fallback: number
  hint: string
}

/** Storage parameters (`WITH (…)`) of the pgvector methods. */
export function indexParams(method: string): IndexParam[] {
  switch (method.trim().toLowerCase()) {
    case 'hnsw':
      return [
        { name: 'm', fallback: 16, hint: 'Connections per layer' },
        { name: 'ef_construction', fallback: 64, hint: 'Candidate list size while building' }
      ]
    case 'ivfflat':
      return [{ name: 'lists', fallback: 100, hint: 'Inverted lists; about rows / 1000' }]
    default:
      return []
  }
}

/** What switching an index to `method` resets: its operator class and parameters. */
export function methodDefaults(
  method: string,
  ext: PgExtensions
): { opclass: string; params: Record<string, string> } {
  return { opclass: needsOpclass(method) ? (indexOpclasses(method, ext)[0] ?? '') : '', params: {} }
}

/** Why a draft index can't be written, or null. */
export function extensionIndexProblem(ix: { method: string; opclass?: string }): string | null {
  return needsOpclass(ix.method) && !ix.opclass?.trim()
    ? `${ix.method} indexes need an operator class such as vector_l2_ops`
    : null
}

/* ---------- Values ---------- */

/** pgvector's vector, halfvec and sparsevec column types. */
export function isVectorType(typeName: string): boolean {
  return /^(?:"?[\w$]+"?\.)?(vector|halfvec|sparsevec)\b/i.test(typeName.trim())
}

/** Dimensions of a vector's text form: `[1,2,3]` or sparse `{1:0.5,3:2}/5`. */
export function vectorDims(text: string): number | null {
  const t = text.trim()
  const sparse = /^\{[^}]*\}\/(\d+)$/.exec(t)
  if (sparse) return Number(sparse[1])
  if (!t.startsWith('[') || !t.endsWith(']')) return null
  const body = t.slice(1, -1).trim()
  return body ? body.split(',').length : 0
}

/** Values shown before the `…` of a long vector */
const SHOWN_VALUES = 3

/** `[0.12, -0.3, 0.5, … 1536 dims]` for long vectors, the values spaced out for short ones. */
export function compactVector(text: string): string | null {
  const t = text.trim()
  const sparse = /^\{([^}]*)\}\/(\d+)$/.exec(t)
  if (sparse) {
    const entries = sparse[1] ? sparse[1].split(',').map((e) => e.trim()) : []
    const head = entries.slice(0, SHOWN_VALUES).join(', ')
    const more = entries.length > SHOWN_VALUES ? ', …' : ''
    return `{${head}${more}} ${entries.length.toLocaleString()} of ${Number(sparse[2]).toLocaleString()} dims`
  }
  if (!t.startsWith('[') || !t.endsWith(']')) return null
  const body = t.slice(1, -1).trim()
  const values = body ? body.split(',').map((v) => v.trim()) : []
  if (values.length <= SHOWN_VALUES * 2) return `[${values.join(', ')}]`
  return `[${values.slice(0, SHOWN_VALUES).join(', ')}, … ${values.length.toLocaleString()} dims]`
}

/** Grid cells cut spatial values at about this many characters */
const CELL_CHARS = 300

/** Recent conversions; grids redraw the same cells while scrolling */
const cache = new Map<string, string | null>()

/**
 * How the grid shows a PostgreSQL value of an extension type: EWKT for hex
 * EWKB geometry, a compact form for vectors. Null for other values.
 */
export function extensionCellDisplay(value: string, typeName: string): string | null {
  if (!typeName) return null
  if (isSpatialType(typeName)) {
    const hit = cache.get(value)
    if (hit !== undefined) return hit
    const g = decodeEwkb(value)
    const text = g && toEwkt(g, CELL_CHARS)
    if (cache.size > 2000) cache.clear()
    cache.set(value, text)
    return text
  }
  if (isVectorType(typeName)) return compactVector(value)
  return null
}

/** The text to edit a cell as: EWKT for geometry stored as hex EWKB. Null to edit the raw value. */
export function extensionEditText(value: Cell, typeName: string): string | null {
  if (typeof value !== 'string' || !typeName || !isSpatialType(typeName)) return null
  const g = decodeEwkb(value)
  return g && toEwkt(g)
}

/** The SRID a column type declares, e.g. 4326 for `geometry(Point,4326)`; geography defaults to 4326. */
export function declaredSrid(dataType: string): number | null {
  const m = /^(?:"?[\w$]+"?\.)?(geometry|geography)\s*(?:\(\s*[\w]+\s*(?:,\s*(\d+)\s*)?\))?/i.exec(
    dataType.trim()
  )
  if (!m) return null
  if (m[2]) return Number(m[2]) || null
  return m[1].toLowerCase() === 'geography' ? 4326 : null
}

const WKT = /^\s*[a-z]+(?:\s*[zm]{1,2})?\s*(?:\(|empty\b)/i

/**
 * A PostgreSQL literal for a geometry / geography column: WKT gets the
 * column's SRID spelled out, and the literal is cast to the column's type so
 * a bad value fails with PostGIS's message. Hex EWKB and EWKT pass through.
 */
export function spatialLiteral(value: string, dataType: string): string {
  const srid = declaredSrid(dataType)
  const text =
    srid && WKT.test(value) && !/^\s*srid\s*=/i.test(value) ? `SRID=${srid};${value.trim()}` : value
  return `'${text.replace(/'/g, "''")}'::${dataType.trim()}`
}
