import { useSyncExternalStore } from 'react'
import { readPersisted, writePersisted } from './persist'

export interface Store<T> {
  get: () => T
  set: (next: T | ((prev: T) => T)) => void
  use: () => T
  subscribe: (listener: () => void) => () => void
}

/** Minimal external store for UI state shared across components. */
export function createStore<T>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    get: () => state,
    set: (next) => {
      state = typeof next === 'function' ? (next as (prev: T) => T)(state) : next
      for (const listener of listeners) listener()
    },
    use: () => useSyncExternalStore(subscribe, () => state),
    subscribe
  }
}

/** A store persisted under `key` (see `persist.ts`). */
export function createPersistentStore<T>(key: string, initial: T): Store<T> {
  let saved = initial
  try {
    const raw = readPersisted(key)
    if (raw) {
      const parsed = JSON.parse(raw) as T
      // Merge objects so settings added in later versions get their defaults
      const isPlainObject = initial && typeof initial === 'object' && !Array.isArray(initial)
      saved = isPlainObject ? { ...initial, ...parsed } : parsed
    }
  } catch {
    // Fall back to defaults when storage is unavailable or corrupt
  }
  const store = createStore<T>(saved)
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    clearTimeout(timer)
    timer = undefined
    writePersisted(key, JSON.stringify(store.get()))
  }
  store.subscribe(() => {
    clearTimeout(timer)
    timer = setTimeout(flush, 300)
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => timer !== undefined && flush())
  }
  return store
}
