import { createPersistentStore } from './store'

export interface Settings {
  accent: string
  editorFontSize: number
  /** Rows kept per result set; the rest are counted but not transferred */
  maxRows: number
  /** Rows per page in table and collection browsers */
  pageSize: number
  showSystemObjects: boolean
  wordWrap: boolean
  /** Ask before running DELETE/UPDATE without WHERE, DROP, TRUNCATE */
  confirmDangerous: boolean
  sidebarWidth: number
}

export const DEFAULT_ACCENT = '#c4f042'

export const ACCENTS = [
  { value: '#c4f042', label: 'Lime' },
  { value: '#a8c7fa', label: 'Sky' },
  { value: '#5fe0c8', label: 'Teal' },
  { value: '#d49bff', label: 'Violet' },
  { value: '#ff9e64', label: 'Orange' },
  { value: '#ff7eb6', label: 'Pink' },
  { value: '#f2c45b', label: 'Gold' }
]

export const settingsStore = createPersistentStore<Settings>('dbms.settings.v1', {
  accent: DEFAULT_ACCENT,
  editorFontSize: 13,
  maxRows: 10_000,
  pageSize: 200,
  showSystemObjects: false,
  wordWrap: false,
  confirmDangerous: true,
  sidebarWidth: 280
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
  const root = document.documentElement.style
  root.setProperty('--accent', hex)
  root.setProperty('--accent-hover', mix(hex, 255, 0.25))
  root.setProperty('--accent-fg', luminance(hex) > 0.45 ? '#11160a' : '#f4f6fa')
}
