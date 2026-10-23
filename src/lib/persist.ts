import { invoke } from '@tauri-apps/api/core'

/**
 * Durable key/value storage for UI state, backed by JSON files in the app data
 * directory. `loadPersistedState` must finish before any store is created.
 */
const cache = new Map<string, string>()
let loaded = false

export async function loadPersistedState(): Promise<void> {
  try {
    const all = await invoke<Record<string, string>>('state_load_all')
    for (const [k, v] of Object.entries(all)) cache.set(k, v)
  } catch {
    // Outside Tauri (tests, plain browser) fall back to localStorage only
  }
  loaded = true
}

export function readPersisted(key: string): string | null {
  if (cache.has(key)) return cache.get(key) ?? null
  // Migrate values written by earlier builds that only used localStorage
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writePersisted(key: string, value: string): void {
  cache.set(key, value)
  if (loaded) void invoke('state_save', { key, value }).catch(() => {})
  try {
    localStorage.setItem(key, value)
  } catch {
    // Quota or privacy mode; the file copy is the durable one anyway
  }
}
