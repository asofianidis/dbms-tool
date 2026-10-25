import { createPersistentStore } from './store'

export type ThemeMode = 'dark' | 'light' | 'system'

export type CommitMode = 'auto' | 'manual'

export type UpdateChannel = 'stable' | 'nightly'

export interface Settings {
  /** Accent override; empty uses the current theme's accent */
  accent: string
  /** Bumped when accent semantics change, so stored values can be migrated (see themes.ts) */
  accentVersion: number
  themeMode: ThemeMode
  /** Theme used in dark mode */
  darkTheme: string
  /** Theme used in light mode */
  lightTheme: string
  editorFontSize: number
  /** CSS font family for code editors; empty uses the bundled JetBrains Mono */
  editorFontFamily: string
  /** Rows kept per result set; the rest are counted but not transferred */
  maxRows: number
  /** Rows per page in table and collection browsers */
  pageSize: number
  /** Seconds before a query run from an editor is cancelled; 0 never times out */
  queryTimeoutSecs: number
  /** Seconds to wait for a server when connecting */
  connectTimeoutSecs: number
  /** Commit mode for query tabs that haven't picked one */
  defaultCommitMode: CommitMode
  showSystemObjects: boolean
  wordWrap: boolean
  /** Ask before running DELETE/UPDATE without WHERE, DROP, TRUNCATE */
  confirmDangerous: boolean
  sidebarWidth: number
  /** Check GitHub Releases for signed updates in the background */
  autoUpdate: boolean
  /** Release channel updates come from; '' follows the installed build (nightlies have a pre-release version) */
  updateChannel: UpdateChannel | ''
  /** Zone timestamps are shown in: '' as the server sent them, 'local', 'UTC' or an IANA name */
  timeZone: string
  /** Read `timestamp` / `datetime` values without an offset as UTC */
  assumeUtc: boolean
  dateFormat: 'iso' | 'locale'
}

/** Fallback when an accent value is malformed */
export const DEFAULT_ACCENT = '#a8c7fa'

export const ACCENTS = [
  { value: '#a8c7fa', label: 'Sky' },
  { value: '#2563d9', label: 'Blue' },
  { value: '#c4f042', label: 'Lime' },
  { value: '#5fe0c8', label: 'Teal' },
  { value: '#d49bff', label: 'Violet' },
  { value: '#ff9e64', label: 'Orange' },
  { value: '#ff7eb6', label: 'Pink' },
  { value: '#f2c45b', label: 'Gold' }
]

export const settingsStore = createPersistentStore<Settings>('dbms.settings.v1', {
  accent: '',
  accentVersion: 3,
  themeMode: 'dark',
  darkTheme: 'graphite',
  lightTheme: 'paper',
  editorFontSize: 13,
  editorFontFamily: '',
  maxRows: 10_000,
  pageSize: 200,
  queryTimeoutSecs: 0,
  connectTimeoutSecs: 15,
  defaultCommitMode: 'auto',
  showSystemObjects: false,
  wordWrap: false,
  confirmDangerous: true,
  sidebarWidth: 280,
  autoUpdate: true,
  updateChannel: '',
  timeZone: '',
  assumeUtc: false,
  dateFormat: 'iso'
})

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function mix(hex: string, toward: number, t: number): string {
  return (
    '#' +
    [1, 3, 5]
      .map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16)
        return Math.round(c + (toward - c) * t)
          .toString(16)
          .padStart(2, '0')
      })
      .join('')
  )
}

/** Writes the accent and its derived tones to CSS variables. */
export function applyAccent(accent: string): void {
  const hex = /^#[0-9a-f]{6}$/i.test(accent) ? accent : DEFAULT_ACCENT
  const light = luminance(hex) > 0.45
  const root = document.documentElement.style
  root.setProperty('--accent', hex)
  // Bright accents get lighter on hover, deep ones darker, so hover always reads
  root.setProperty('--accent-hover', light ? mix(hex, 255, 0.25) : mix(hex, 0, 0.15))
  root.setProperty('--accent-fg', light ? '#0b0e14' : '#f8fafc')
}
