import { useSyncExternalStore } from 'react'

export interface Toast {
  id: number
  message: string
  tone: 'success' | 'error' | 'info'
}

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function toast(message: string, tone: Toast['tone'] = 'success'): void {
  const id = nextId++
  toasts = [...toasts.slice(-4), { id, message, tone }]
  emit()
  setTimeout(() => dismissToast(id), tone === 'error' ? 7000 : 3000)
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

export function toastError(error: unknown): void {
  toast(errorMessage(error), 'error')
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => toasts
  )
}
