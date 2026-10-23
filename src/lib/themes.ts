import { getCurrentWindow } from '@tauri-apps/api/window'
import { readPersisted } from './persist'
import { applyAccent, settingsStore } from './settings'
import { createPersistentStore } from './store'

export const TOKENS = [
  { key: 'canvas', label: 'Canvas', group: 'Surfaces', hint: 'Editor and grid background' },
  { key: 'panel', label: 'Panel', group: 'Surfaces', hint: 'Sidebars, toolbars, dialogs' },
  { key: 'raised', label: 'Raised', group: 'Surfaces', hint: 'Cards, menus, toasts' },
  { key: 'hover', label: 'Hover', group: 'Surfaces' },
  { key: 'sel', label: 'Selected', group: 'Surfaces' },
  { key: 'line', label: 'Border', group: 'Surfaces' },
  { key: 'line-strong', label: 'Strong border', group: 'Surfaces' },
  { key: 'bright', label: 'Heading text', group: 'Text' },
  { key: 'fg', label: 'Body text', group: 'Text' },
  { key: 'muted', label: 'Muted text', group: 'Text' },
  { key: 'faint', label: 'Faint text', group: 'Text' },
  { key: 'accent', label: 'Accent', group: 'Accent and status' },
  { key: 'danger', label: 'Danger', group: 'Accent and status' },
  { key: 'warn', label: 'Warning', group: 'Accent and status' },
  { key: 'ok', label: 'Success', group: 'Accent and status' },
  { key: 'info', label: 'Info', group: 'Accent and status' },
  { key: 'syn-keyword', label: 'Keywords', group: 'Syntax' },
  { key: 'syn-string', label: 'Strings', group: 'Syntax' },
  { key: 'syn-number', label: 'Numbers', group: 'Syntax' },
  { key: 'syn-comment', label: 'Comments', group: 'Syntax' },
  { key: 'syn-type', label: 'Types', group: 'Syntax' },
  { key: 'syn-fn', label: 'Functions', group: 'Syntax' },
  { key: 'syn-prop', label: 'Properties', group: 'Syntax' },
  { key: 'syn-operator', label: 'Operators', group: 'Syntax' }
] as const

export type TokenKey = (typeof TOKENS)[number]['key']
export type ThemeColors = Record<TokenKey, string>
export type ThemeBase = 'dark' | 'light'

export interface Theme {
  id: string
  name: string
  base: ThemeBase
  colors: ThemeColors
  builtin?: boolean
}

const graphite: ThemeColors = {
  canvas: '#0a0b0a',
  panel: '#111311',
  raised: '#171a17',
  hover: '#1d211d',
  sel: '#242924',
  line: '#20241f',
  'line-strong': '#2d322c',
  bright: '#eef1ea',
  fg: '#c3c8be',
  muted: '#858c81',
  faint: '#50564d',
  accent: '#a8c7fa',
  danger: '#ff6e61',
  warn: '#f2b84b',
  ok: '#4fd99b',
  info: '#85a9ff',
  'syn-keyword': '#c792ea',
  'syn-string': '#98c379',
  'syn-number': '#f2b84b',
  'syn-comment': '#5c6459',
  'syn-type': '#5fe0c8',
  'syn-fn': '#85a9ff',
  'syn-prop': '#e6c07b',
  'syn-operator': '#9aa394'
}

export const BUILTIN_THEMES: Theme[] = [
  { id: 'graphite', name: 'Graphite', base: 'dark', builtin: true, colors: graphite },
  {
    id: 'midnight',
    name: 'Midnight',
    base: 'dark',
    builtin: true,
    colors: {
      ...graphite,
      canvas: '#0a0d12',
      panel: '#0f131a',
      raised: '#161b24',
      hover: '#1c2330',
      sel: '#252d3c',
      line: '#1e2633',
      'line-strong': '#2a3344',
      bright: '#e6ebf4',
      fg: '#c3cad8',
      muted: '#7f8aa3',
      faint: '#4b556b',
      'syn-comment': '#56607a',
      'syn-operator': '#8f9ab3'
    }
  },
  {
    id: 'paper',
    name: 'Paper',
    base: 'light',
    builtin: true,
    colors: {
      canvas: '#ffffff',
      panel: '#f5f6f4',
      raised: '#ffffff',
      hover: '#eaece8',
      sel: '#e0e5ec',
      line: '#e4e6e2',
      'line-strong': '#cfd3cc',
      bright: '#14171a',
      fg: '#2d322e',
      muted: '#5f665e',
      faint: '#9aa097',
      accent: '#2563d9',
      danger: '#d2372b',
      warn: '#b26b00',
      ok: '#17894f',
      info: '#2563d9',
      'syn-keyword': '#8a3fc7',
      'syn-string': '#3d7f22',
      'syn-number': '#b0570f',
      'syn-comment': '#8c928a',
      'syn-type': '#0b7f75',
      'syn-fn': '#2563d9',
      'syn-prop': '#9a5a12',
      'syn-operator': '#5c625b'
    }
  },
  {
    id: 'sand',
    name: 'Sand',
    base: 'light',
    builtin: true,
    colors: {
      canvas: '#fdfbf6',
      panel: '#f4f0e6',
      raised: '#fffdf8',
      hover: '#ebe5d6',
      sel: '#e3dccb',
      line: '#e6e0d1',
      'line-strong': '#d3cab5',
      bright: '#1f1b14',
      fg: '#3a3428',
      muted: '#6e6655',
      faint: '#a39a85',
      accent: '#b5560f',
      danger: '#c23a2b',
      warn: '#a36a00',
      ok: '#3d7a2a',
      info: '#2f63b8',
      'syn-keyword': '#a3348a',
      'syn-string': '#4c7a1e',
      'syn-number': '#b5560f',
      'syn-comment': '#9c937e',
      'syn-type': '#1f7a70',
      'syn-fn': '#2f63b8',
      'syn-prop': '#8a5a1c',
      'syn-operator': '#6a6250'
    }
  }
]

export const customThemesStore = createPersistentStore<Theme[]>('dbms.themes.v1', [])

export function allThemes(): Theme[] {
  return [...BUILTIN_THEMES, ...customThemesStore.get()]
}

export function findTheme(id: string, base: ThemeBase): Theme {
  return (
    allThemes().find((t) => t.id === id) ??
    BUILTIN_THEMES.find((t) => t.base === base) ??
    BUILTIN_THEMES[0]
  )
}

const systemDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches

/** The base the app is currently showing, resolving "system". */
export function resolvedBase(): ThemeBase {
  const { themeMode } = settingsStore.get()
  if (themeMode === 'system') return systemDark() ? 'dark' : 'light'
  return themeMode
}

export function currentTheme(): Theme {
  const settings = settingsStore.get()
  const base = resolvedBase()
  return findTheme(base === 'dark' ? settings.darkTheme : settings.lightTheme, base)
}

/** Writes a theme's tokens to CSS variables (the accent may be overridden in Settings). */
export function applyTheme(theme: Theme, accentOverride = settingsStore.get().accent): void {
  const root = document.documentElement
  for (const { key } of TOKENS) {
    if (key !== 'accent') root.style.setProperty(`--color-${key}`, theme.colors[key])
  }
  applyAccent(accentOverride || theme.colors.accent)
  root.dataset.theme = theme.base
  root.style.colorScheme = theme.base
  void getCurrentWindow()
    .setBackgroundColor(theme.colors.canvas)
    .catch(() => {})
}

export function applyCurrentTheme(): void {
  applyTheme(currentTheme())
}

/** Flips between the dark and light theme from the title bar. */
export function toggleThemeMode(): void {
  const next = resolvedBase() === 'dark' ? 'light' : 'dark'
  settingsStore.set((s) => ({ ...s, themeMode: next }))
}

/** Re-applies the theme when settings, custom themes or the OS preference change. */
export function startThemeSync(): () => void {
  applyCurrentTheme()
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = (): void => applyCurrentTheme()
  media.addEventListener('change', onChange)
  const unsubSettings = settingsStore.subscribe(onChange)
  const unsubThemes = customThemesStore.subscribe(onChange)
  return () => {
    media.removeEventListener('change', onChange)
    unsubSettings()
    unsubThemes()
  }
}

export function newThemeId(): string {
  return `custom-${crypto.randomUUID().slice(0, 8)}`
}

/** Parses a shared theme (JSON) and fills any missing tokens from its base. */
export function parseTheme(text: string): Theme {
  const raw = JSON.parse(text) as Partial<Theme>
  if (!raw || typeof raw !== 'object') throw new Error('Not a theme')
  const base: ThemeBase = raw.base === 'light' ? 'light' : 'dark'
  const fallback = BUILTIN_THEMES.find((t) => t.base === base)!.colors
  const colors = { ...fallback }
  for (const { key } of TOKENS) {
    const value = raw.colors?.[key]
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))
      colors[key] = value.toLowerCase()
  }
  return { id: newThemeId(), name: String(raw.name || 'Imported theme').slice(0, 60), base, colors }
}

export function exportTheme(theme: Theme): string {
  return JSON.stringify({ name: theme.name, base: theme.base, colors: theme.colors }, null, 2)
}

/** Settings saved before accents became per-theme stored the old defaults explicitly. */
export function migrateAccentSetting(): void {
  const raw = readPersisted('dbms.settings.v1') ?? ''
  const version = Number(/"accentVersion":\s*(\d+)/.exec(raw)?.[1] ?? 1)
  if (version >= 3) return
  settingsStore.set((s) => ({
    ...s,
    accent: ['#a8c7fa', '#c4f042'].includes(s.accent) ? '' : s.accent,
    accentVersion: 3
  }))
}
