/** PostgreSQL LISTEN / NOTIFY helpers for the Notifications tab. */

import type { PgNotification } from './api'

/** Longest channel name PostgreSQL keeps (NAMEDATALEN - 1 bytes). */
export const MAX_CHANNEL_BYTES = 63

/**
 * `orders, jobs` → `['orders', 'jobs']`. Commas or new lines separate, so a
 * channel can hold spaces; names are kept exactly, as `pg_notify()` takes them.
 */
export function splitChannelList(text: string): string[] {
  const seen = new Set<string>()
  for (const part of text.split(/[,\n]/)) {
    const name = part.trim()
    if (name) seen.add(name)
  }
  return [...seen]
}

/** Why `name` can't be a channel, or null when it can. */
export function channelProblem(name: string): string | null {
  if (!name) return 'Enter a channel name'
  if (new TextEncoder().encode(name).length > MAX_CHANNEL_BYTES)
    return `Channel names are at most ${MAX_CHANNEL_BYTES} bytes: ${name}`
  return null
}

/** `added` first, then the rest of `recent` without repeats, at most `max`. */
export function rememberChannels(recent: string[], added: string[], max = 20): string[] {
  return [...new Set([...added, ...recent])].slice(0, max)
}

/** Unquoted names fold to lower case in SQL, so `NOTIFY Jobs` reaches `jobs`. */
export function foldsCase(name: string): boolean {
  return name !== name.toLowerCase()
}

export function matchesFilter(n: PgNotification, filter: string): boolean {
  const f = filter.trim().toLowerCase()
  return (
    !f ||
    n.channel.toLowerCase().includes(f) ||
    n.payload.toLowerCase().includes(f) ||
    String(n.pid) === f
  )
}

/** One line as the query messages show it: `NOTIFY chan (pid 123): payload`. */
export function notificationLine(n: PgNotification): string {
  return n.payload
    ? `NOTIFY ${n.channel} (pid ${n.pid}): ${n.payload}`
    : `NOTIFY ${n.channel} (pid ${n.pid})`
}
