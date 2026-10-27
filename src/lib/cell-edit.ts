/**
 * Typed inline cell editing: which editor a column gets, PostgreSQL array
 * literals, JSON formatting that keeps the text exact, and merging a date
 * picker's value into a timestamp without losing its fraction or offset.
 */
import type { Dialect } from './engines'

export type CellEditorKind = 'text' | 'json' | 'array' | 'date' | 'datetime' | 'time'

/** The editor for a column of type `typeName`; 'text' when nothing better fits. */
export function cellEditorKind(dialect: Dialect | undefined, typeName: string): CellEditorKind {
  const t = typeName.trim().toLowerCase()
  if (!t) return 'text'
  if (dialect === 'postgres' && isPgArrayType(t)) return 'array'
  if (/^jsonb?$/.test(t)) return 'json'
  if (t === 'date') return 'date'
  if (/^(timestamp|timestamptz|datetime|datetime2|smalldatetime|datetimeoffset)\b/.test(t))
    return 'datetime'
  if (/^(time|timetz)\b/.test(t)) return 'time'
  return 'text'
}

/** `_int4` on the wire, `integer[]` from format_type; box arrays use `;` and aren't handled. */
function isPgArrayType(t: string): boolean {
  return (t.startsWith('_') || t.endsWith('[]')) && !/^(_box|box\[\])/.test(t)
}

/* ---------- PostgreSQL arrays ---------- */

export type ArrayItem = string | null

/**
 * The elements of a one-dimensional array literal like `{1,"a b",NULL}`, or
 * null when it isn't one (nested arrays, explicit bounds, malformed text).
 */
export function parsePgArray(text: string): ArrayItem[] | null {
  const s = text.trim()
  if (!s.startsWith('{') || !s.endsWith('}')) return null
  const items: ArrayItem[] = []
  let i = 1
  const end = s.length - 1
  const skipSpace = (): void => {
    while (i < end && /\s/.test(s[i])) i++
  }
  skipSpace()
  if (i === end) return items
  for (;;) {
    skipSpace()
    if (s[i] === '{') return null
    if (s[i] === '"') {
      let out = ''
      i++
      for (;;) {
        if (i >= end) return null
        const c = s[i]
        if (c === '\\') {
          if (i + 1 >= end) return null
          out += s[i + 1]
          i += 2
        } else if (c === '"') {
          i++
          break
        } else {
          out += c
          i++
        }
      }
      items.push(out)
      skipSpace()
    } else {
      const start = i
      while (i < end && s[i] !== ',') {
        if (s[i] === '"' || s[i] === '{' || s[i] === '}') return null
        i++
      }
      const raw = s.slice(start, i).trim()
      if (!raw) return null
      items.push(/^null$/i.test(raw) ? null : raw.replace(/\\(.)/g, '$1'))
    }
    if (i === end) return items
    if (s[i] !== ',') return null
    i++
  }
}

/** A one-dimensional array literal, quoting elements only where PostgreSQL needs it. */
export function formatPgArray(items: ArrayItem[]): string {
  return (
    '{' +
    items
      .map((x) => {
        if (x === null) return 'NULL'
        if (x !== '' && !/[{}",\\\s]/.test(x) && !/^null$/i.test(x)) return x
        return '"' + x.replace(/["\\]/g, '\\$&') + '"'
      })
      .join(',') +
    '}'
  )
}

/* ---------- JSON ---------- */

/** Whether `text` parses as JSON. */
export function isValidJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * Re-spaces JSON without parsing it, so big numbers and duplicate keys come
 * through exactly. `indent` 0 gives the compact form. Expects valid JSON.
 */
export function respaceJson(text: string, indent: number): string {
  let out = ''
  let depth = 0
  const newline = (): string => (indent ? '\n' + ' '.repeat(indent * depth) : '')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '{' || c === '[') {
      // Keep empty objects and arrays on one line
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === (c === '{' ? '}' : ']')) {
        out += c + text[j]
        i = j
      } else {
        depth++
        out += c + newline()
      }
    } else if (c === '}' || c === ']') {
      depth--
      out += newline() + c
    } else if (c === ',') {
      out += ',' + newline()
    } else if (c === ':') {
      out += indent ? ': ' : ':'
    } else if (!/\s/.test(c)) {
      out += c
    }
  }
  return out
}

/* ---------- Dates and times ---------- */

const DATE_PART = /^(\d{4}-\d{2}-\d{2})/
const DATETIME_PART = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/
const TIME_PART = /^(\d{2}:\d{2}(?::\d{2})?)/

const withSeconds = (time: string): string => (time.length === 5 ? time + ':00' : time)

/** The value for a native `<input type="date|datetime-local|time">`, or '' when the text has none. */
export function pickerValue(text: string, kind: 'date' | 'datetime' | 'time'): string {
  const s = text.trim()
  if (kind === 'date') return DATE_PART.exec(s)?.[1] ?? ''
  if (kind === 'time') {
    const m = TIME_PART.exec(s)
    return m ? withSeconds(m[1]) : ''
  }
  const m = DATETIME_PART.exec(s)
  return m ? `${m[1]}T${withSeconds(m[2])}` : ''
}

/**
 * `text` with its date / time replaced by what was picked, keeping anything
 * after it (fractional seconds, a zone offset) as it was.
 */
export function mergePicked(
  text: string,
  picked: string,
  kind: 'date' | 'datetime' | 'time'
): string {
  if (!picked) return text
  const s = text.trim()
  if (kind === 'date') {
    const m = DATE_PART.exec(s)
    return picked + (m ? s.slice(m[0].length) : '')
  }
  if (kind === 'time') {
    const m = TIME_PART.exec(s)
    return withSeconds(picked) + (m ? s.slice(m[0].length) : '')
  }
  const [date, time = '00:00'] = picked.split('T')
  const m = DATETIME_PART.exec(s)
  return `${date} ${withSeconds(time)}` + (m ? s.slice(m[0].length) : '')
}
