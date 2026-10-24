import { api } from './api'
import { settingsStore, type Settings } from './settings'

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-monospace',
  'ui-serif',
  'ui-sans-serif',
  'ui-rounded'
])

/**
 * Turns a font setting such as `Fira Code, Consolas` into a CSS font-family list that
 * falls back to the bundled monospace stack. Names are quoted, so nothing but a font
 * name can reach the stylesheet.
 */
export function editorFontStack(setting: string): string {
  const names = setting
    .split(',')
    .map((n) => n.trim().replace(/^["']|["']$/g, ''))
    .map((n) => n.replace(/["'\\;{}<>]/g, '').trim())
    .filter(Boolean)
  const quoted = names.map((n) => (GENERIC_FAMILIES.has(n.toLowerCase()) ? n : `"${n}"`))
  return [...quoted, 'var(--font-mono)'].join(', ')
}

export const EDITOR_FONTS = [
  'JetBrains Mono',
  'Cascadia Code',
  'Fira Code',
  'Source Code Pro',
  'IBM Plex Mono',
  'Consolas',
  'SF Mono',
  'Menlo'
]

function apply(settings: Settings): void {
  document.documentElement.style.setProperty(
    '--font-editor',
    editorFontStack(settings.editorFontFamily)
  )
}

/** Applies settings that live outside React: the editor font and the backend's connect timeout. */
export function startSettingsSync(): () => void {
  let connectTimeout = -1
  const sync = (): void => {
    const settings = settingsStore.get()
    apply(settings)
    if (settings.connectTimeoutSecs !== connectTimeout) {
      connectTimeout = settings.connectTimeoutSecs
      void api.limitsSet(connectTimeout).catch(() => {})
    }
  }
  sync()
  return settingsStore.subscribe(sync)
}
