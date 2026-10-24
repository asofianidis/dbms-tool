/**
 * Display of timestamps in a chosen time zone. Servers send timestamps as
 * text; only values that carry an offset (or that the user says are UTC) name
 * an instant, so only those are converted. Copy and export keep the raw text.
 */

export interface TimeDisplay {
  /** '' shows values as the server sent them; else 'local', 'UTC' or an IANA zone */
  timeZone: string
  /** Treat `timestamp` / `datetime` values without an offset as UTC */
  assumeUtc: boolean
  format: 'iso' | 'locale'
}

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/
const TEMPORAL_TYPE = /time|date/i
const NAIVE_TYPE = /^(timestamp(?!tz)|datetime(?!offset)|datetime2|smalldatetime)/i

/** Every zone the platform knows, for the settings picker. */
export function timeZones(): string[] {
  try {
    return (
      (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ??
      []
    )
  } catch {
    return []
  }
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone === 'local') return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function offsetMinutes(offset: string): number {
  if (offset === 'Z') return 0
  const sign = offset.startsWith('-') ? -1 : 1
  const digits = offset.slice(1).replace(':', '')
  const hours = Number(digits.slice(0, 2))
  const minutes = Number(digits.slice(2, 4) || '0')
  return sign * (hours * 60 + minutes)
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

/** Wall-clock fields of `instant` in `zone` (undefined zone = local). */
function wallClock(
  instant: Date,
  zone: string | undefined
): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(instant)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    y: get('year'),
    mo: get('month'),
    d: get('day'),
    h: get('hour'),
    mi: get('minute'),
    s: get('second')
  }
}

/**
 * `value` shown in the configured zone, or null to show it unchanged (not a
 * timestamp, no zone chosen, or no instant to convert).
 */
export function displayTimestamp(
  value: string,
  typeName: string,
  display: TimeDisplay
): string | null {
  if (!display.timeZone || value.length < 19 || value.length > 40) return null
  if (typeName && !TEMPORAL_TYPE.test(typeName)) return null
  const m = TIMESTAMP.exec(value)
  if (!m) return null
  const [, y, mo, d, h, mi, s, fraction = '', offset] = m
  if (!offset && !(display.assumeUtc && NAIVE_TYPE.test(typeName))) return null
  const utc =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) -
    offsetMinutes(offset ?? 'Z') * 60_000
  const instant = new Date(utc)
  if (Number.isNaN(instant.getTime())) return null
  const zone = display.timeZone === 'local' ? undefined : display.timeZone
  try {
    if (display.format === 'locale') {
      return instant.toLocaleString(undefined, {
        timeZone: zone,
        dateStyle: 'medium',
        timeStyle: 'medium'
      })
    }
    const w = wallClock(instant, zone)
    const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
    const shown = Math.round((asUtc - utc) / 60_000)
    // Sub-second digits don't change with whole-minute offsets, so keep the server's precision
    return `${w.y}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${fraction} ${formatOffset(shown)}`
  } catch {
    return null
  }
}
