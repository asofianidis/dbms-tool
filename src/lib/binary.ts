/**
 * Binary cells arrive as hex text: `0xDEADBEEF` from the drivers (capped, with
 * a `… (N bytes)` suffix when cut short) or `\xdeadbeef` from PostgreSQL.
 */

export interface BinaryValue {
  bytes: Uint8Array
  /** Size of the whole value; more than `bytes.length` when the cell was cut short */
  total: number
  truncated: boolean
}

const HEX_CELL = /^(?:0x|\\x)([0-9a-f]*)(?:… \((\d+) bytes\))?$/i
const BINARY_TYPE = /bytea|blob|binary|image|geometry|^vector$/i

/** Whether a column holds binary data, by its type or the shape of its values. */
export function isBinaryColumn(typeName: string, sample?: string | null): boolean {
  if (typeName) return BINARY_TYPE.test(typeName)
  return !!sample && /^(?:0x|\\x)[0-9a-f]{8,}/i.test(sample)
}

export function parseBinary(value: string): BinaryValue | null {
  if (value.length > 2 + 2 * 64 * 1024 * 1024) return null
  const m = HEX_CELL.exec(value)
  if (!m || m[1].length % 2) return null
  const hex = m[1]
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const b = parseInt(hex.substr(i * 2, 2), 16)
    if (Number.isNaN(b)) return null
    bytes[i] = b
  }
  const total = m[2] ? Number(m[2]) : bytes.length
  return { bytes, total, truncated: total > bytes.length }
}

const IMAGE_MAGIC: [string, number[], number?][] = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['image/bmp', [0x42, 0x4d]],
  ['image/x-icon', [0x00, 0x00, 0x01, 0x00]],
  // RIFF....WEBP
  ['image/webp', [0x57, 0x45, 0x42, 0x50], 8],
  // ....ftypavif
  ['image/avif', [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 4]
]

/** The image type `bytes` start with, or null. */
export function imageType(bytes: Uint8Array): string | null {
  for (const [mime, magic, at = 0] of IMAGE_MAGIC) {
    if (bytes.length >= at + magic.length && magic.every((b, i) => bytes[at + i] === b)) return mime
  }
  // SVG is text; look for its root element near the start
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 512))
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml'
  return null
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg'
}

/** A file extension for the bytes: the image type's, `pdf`, `zip`, `gz` or `bin`. */
export function binaryExtension(bytes: Uint8Array): string {
  const image = imageType(bytes)
  if (image) return EXTENSIONS[image]
  const starts = (...magic: number[]): boolean => magic.every((b, i) => bytes[i] === b)
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'pdf'
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'zip'
  if (starts(0x1f, 0x8b)) return 'gz'
  return 'bin'
}

export interface HexLine {
  offset: string
  hex: string
  ascii: string
}

/** Classic 16-bytes-per-line dump of `bytes`, from line `from` for `count` lines. */
export function hexLines(bytes: Uint8Array, from = 0, count = Infinity): HexLine[] {
  const lines: HexLine[] = []
  const total = Math.ceil(bytes.length / 16)
  for (let line = from; line < total && lines.length < count; line++) {
    const chunk = bytes.subarray(line * 16, line * 16 + 16)
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0'))
    lines.push({
      offset: (line * 16).toString(16).padStart(8, '0'),
      // A wider gap after the eighth byte, as in xxd and hex editors
      hex: (hex.slice(0, 8).join(' ') + '  ' + hex.slice(8).join(' ')).trimEnd(),
      ascii: Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join(
        ''
      )
    })
  }
  return lines
}

/** UTF-8 text of the bytes when they decode cleanly, else null. */
export function utf8Text(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // Mostly control characters means binary that happens to be valid UTF-8
    const control = text.match(/[\u0000-\u0008\u000e-\u001f]/g)?.length ?? 0
    return control > text.length / 20 ? null : text
  } catch {
    return null
  }
}
