/**
 * PostGIS geometry / geography values reach the grid as hex EWKB (the types'
 * text output). This decodes them into a small tree that prints as EWKT (the
 * way `ST_AsEWKT` does, so the text can be edited and written back) and as
 * GeoJSON (as `ST_AsGeoJSON` does).
 */

export type GeometryKind =
  | 'Point'
  | 'LineString'
  | 'Polygon'
  | 'MultiPoint'
  | 'MultiLineString'
  | 'MultiPolygon'
  | 'GeometryCollection'
  | 'CircularString'
  | 'Triangle'

export interface Geometry {
  kind: GeometryKind
  /** 0 when the value carries none */
  srid: number
  hasZ: boolean
  hasM: boolean
  /** Point: one position (none when empty); LineString / CircularString: its positions */
  points?: number[][]
  /** Polygon / Triangle: rings of positions */
  rings?: number[][][]
  /** Multi* and GeometryCollection members */
  parts?: Geometry[]
}

const KINDS: Record<number, GeometryKind> = {
  1: 'Point',
  2: 'LineString',
  3: 'Polygon',
  4: 'MultiPoint',
  5: 'MultiLineString',
  6: 'MultiPolygon',
  7: 'GeometryCollection',
  8: 'CircularString',
  17: 'Triangle'
}

// EWKB flag bits on the type word
const EWKB_Z = 0x80000000
const EWKB_M = 0x40000000
const EWKB_SRID = 0x20000000

/** Whether a column type is PostGIS's geometry or geography. */
export function isSpatialType(typeName: string): boolean {
  return /^(?:"?[\w$]+"?\.)?(geometry|geography)\b/i.test(typeName.trim())
}

const HEX = /^(?:[0-9a-f]{2})+$/i

/** The geometry of a hex EWKB (or ISO WKB) value, or null when it isn't one. */
export function decodeEwkb(hex: string): Geometry | null {
  // A point is 21 bytes; anything shorter than a header and an empty collection isn't WKB
  if (hex.length < 18 || !HEX.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  const view = new DataView(bytes.buffer)
  let at = 0
  const need = (n: number): void => {
    if (at + n > bytes.length) throw new RangeError('short WKB')
  }

  const read = (depth: number, inherited: number): Geometry => {
    if (depth > 32) throw new RangeError('WKB nested too deep')
    need(5)
    const order = bytes[at]
    if (order > 1) throw new RangeError('bad byte order')
    const le = order === 1
    const u32 = (): number => {
      need(4)
      const v = view.getUint32(at, le)
      at += 4
      return v
    }
    at += 1
    const word = u32()
    let srid = inherited
    if (word & EWKB_SRID) srid = u32()
    // ISO WKB spells dimensions as thousands: 1001 is POINT Z, 3001 POINT ZM
    const iso = Math.floor((word & 0xffff) / 1000)
    const base = (word & 0xffff) % 1000
    const kind = KINDS[base]
    if (!kind || iso > 3) throw new RangeError('unknown WKB type')
    const hasZ = !!(word & EWKB_Z) || iso === 1 || iso === 3
    const hasM = !!(word & EWKB_M) || iso === 2 || iso === 3
    const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0)
    const position = (): number[] => {
      need(8 * dims)
      const p: number[] = []
      for (let d = 0; d < dims; d++) {
        p.push(view.getFloat64(at, le))
        at += 8
      }
      return p
    }
    const positions = (): number[][] => {
      const n = u32()
      need(n * 8 * dims)
      return Array.from({ length: n }, position)
    }
    const g: Geometry = { kind, srid, hasZ, hasM }
    switch (kind) {
      case 'Point': {
        const p = position()
        // An empty point is all NaN
        g.points = p.every(Number.isNaN) ? [] : [p]
        break
      }
      case 'LineString':
      case 'CircularString':
        g.points = positions()
        break
      case 'Polygon':
      case 'Triangle': {
        const n = u32()
        need(n * 4)
        g.rings = Array.from({ length: n }, positions)
        break
      }
      default: {
        const n = u32()
        need(n * 9)
        g.parts = Array.from({ length: n }, () => read(depth + 1, srid))
      }
    }
    return g
  }

  try {
    const g = read(0, 0)
    return at === bytes.length ? g : null
  } catch {
    return null
  }
}

/** A coordinate as PostGIS prints it: up to 15 significant digits, exponents from 1e15 and to 1e-8. */
export function formatOrdinate(n: number): string {
  if (Number.isNaN(n)) return 'NaN'
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf'
  const r = Number(n.toPrecision(15))
  if (r === 0) return '0'
  const a = Math.abs(r)
  if (a >= 1e15 || a <= 1e-8) return r.toExponential()
  if (a >= 1e-6) return String(r)
  // JavaScript switches to exponents below 1e-6; PostGIS keeps fixed notation
  const [mantissa, exp] = r.toExponential().split('e')
  const digits = mantissa.replace(/[-.]/g, '')
  return `${r < 0 ? '-' : ''}0.${'0'.repeat(-Number(exp) - 1)}${digits}`
}

const NAMES: Record<GeometryKind, string> = {
  Point: 'POINT',
  LineString: 'LINESTRING',
  Polygon: 'POLYGON',
  MultiPoint: 'MULTIPOINT',
  MultiLineString: 'MULTILINESTRING',
  MultiPolygon: 'MULTIPOLYGON',
  GeometryCollection: 'GEOMETRYCOLLECTION',
  CircularString: 'CIRCULARSTRING',
  Triangle: 'TRIANGLE'
}

/** Stops writing once the text passes `limit` characters. */
class Writer {
  text = ''
  constructor(private readonly limit: number) {}
  get full(): boolean {
    return this.text.length >= this.limit
  }
  put(s: string): void {
    if (!this.full) this.text += s
  }
}

function writeEwkt(g: Geometry, w: Writer, nested: boolean): void {
  // EWKT marks only measure-without-Z; Z and ZM are told apart by the ordinate count
  const tag = g.hasM && !g.hasZ ? 'M' : ''
  const pos = (p: number[]): void => w.put(p.map(formatOrdinate).join(' '))
  const list = (ps: number[][]): void => {
    w.put('(')
    ps.forEach((p, i) => {
      if (w.full) return
      if (i) w.put(',')
      pos(p)
    })
    w.put(')')
  }
  const rings = (rs: number[][][]): void => {
    w.put('(')
    rs.forEach((r, i) => {
      if (w.full) return
      if (i) w.put(',')
      list(r)
    })
    w.put(')')
  }
  // Members of a multi geometry are written bare; a collection names each member
  const name = NAMES[g.kind] + tag
  const empty = g.points ? !g.points.length : g.rings ? !g.rings.length : !g.parts?.length
  if (empty) return w.put(nested ? 'EMPTY' : `${name} EMPTY`)
  if (!nested) w.put(name)
  switch (g.kind) {
    case 'Point':
    case 'LineString':
    case 'CircularString':
      return list(g.points!)
    case 'Polygon':
    case 'Triangle':
      return rings(g.rings!)
    case 'MultiPoint':
      // ST_AsEWKT writes MULTIPOINT(0 0,1 2), without parentheses around each point
      w.put('(')
      g.parts!.forEach((p, i) => {
        if (w.full) return
        if (i) w.put(',')
        if (p.points?.length) pos(p.points[0])
        else w.put('EMPTY')
      })
      return w.put(')')
    default:
      w.put('(')
      g.parts!.forEach((p, i) => {
        if (w.full) return
        if (i) w.put(',')
        writeEwkt(p, w, g.kind !== 'GeometryCollection')
      })
      w.put(')')
  }
}

/**
 * The geometry as EWKT (`SRID=4326;POINT(1 2)`), as ST_AsEWKT spells it. With
 * a `limit` the text is cut near that length and ends in `…`.
 */
export function toEwkt(g: Geometry, limit = Infinity): string {
  const w = new Writer(limit)
  if (g.srid) w.put(`SRID=${g.srid};`)
  writeEwkt(g, w, false)
  return w.full && w.text.length > limit ? w.text.slice(0, limit) + '…' : w.text
}

/** Hex EWKB as EWKT, or null when the value isn't EWKB. */
export function ewkbToEwkt(hex: string, limit = Infinity): string | null {
  const g = decodeEwkb(hex)
  return g && toEwkt(g, limit)
}

type GeoJson = Record<string, unknown>

// ST_AsGeoJSON keeps 9 decimal digits and drops M
const coord = (p: number[], g: Geometry): number[] =>
  p.slice(0, g.hasZ ? 3 : 2).map((n) => Number(n.toFixed(9)))

function geoJsonBody(g: Geometry): GeoJson {
  switch (g.kind) {
    case 'Point':
      return { type: 'Point', coordinates: g.points!.length ? coord(g.points![0], g) : [] }
    case 'LineString':
    case 'CircularString':
      return { type: 'LineString', coordinates: g.points!.map((p) => coord(p, g)) }
    case 'Polygon':
    case 'Triangle':
      return { type: 'Polygon', coordinates: g.rings!.map((r) => r.map((p) => coord(p, g))) }
    case 'MultiPoint':
      return {
        type: 'MultiPoint',
        coordinates: g.parts!.filter((p) => p.points?.length).map((p) => coord(p.points![0], g))
      }
    case 'MultiLineString':
      return {
        type: 'MultiLineString',
        coordinates: g.parts!.map((p) => p.points!.map((q) => coord(q, g)))
      }
    case 'MultiPolygon':
      return {
        type: 'MultiPolygon',
        coordinates: g.parts!.map((p) => p.rings!.map((r) => r.map((q) => coord(q, g))))
      }
    case 'GeometryCollection':
      return { type: 'GeometryCollection', geometries: g.parts!.map(geoJsonBody) }
  }
}

/**
 * The geometry as GeoJSON, as ST_AsGeoJSON writes it: WGS 84 (SRID 4326) is
 * implied, any other SRID is named in a short `crs` member.
 */
export function toGeoJson(g: Geometry): string {
  const { type, ...rest } = geoJsonBody(g)
  const crs =
    g.srid && g.srid !== 4326
      ? { crs: { type: 'name', properties: { name: `EPSG:${g.srid}` } } }
      : {}
  return JSON.stringify({ type, ...crs, ...rest })
}

/** Positions in the geometry, for a size hint. */
export function pointCount(g: Geometry): number {
  if (g.points) return g.points.length
  if (g.rings) return g.rings.reduce((n, r) => n + r.length, 0)
  return (g.parts ?? []).reduce((n, p) => n + pointCount(p), 0)
}

/** `Point`, `Polygon ZM`, … for a badge. */
export function geometryLabel(g: Geometry): string {
  const dims = g.hasZ && g.hasM ? ' ZM' : g.hasZ ? ' Z' : g.hasM ? ' M' : ''
  return g.kind + dims
}
