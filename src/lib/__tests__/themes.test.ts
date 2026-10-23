import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES, exportTheme, parseTheme, TOKENS } from '../themes'

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('themes', () => {
  it('define every token as a hex colour', () => {
    for (const theme of BUILTIN_THEMES) {
      for (const { key } of TOKENS) {
        expect(theme.colors[key], `${theme.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  it('keep body text and code readable (WCAG AA)', () => {
    for (const t of BUILTIN_THEMES) {
      expect(contrast(t.colors.fg, t.colors.canvas), `${t.id} fg`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t.colors.bright, t.colors.panel), `${t.id} bright`).toBeGreaterThanOrEqual(
        4.5
      )
      for (const key of [
        'syn-keyword',
        'syn-string',
        'syn-number',
        'syn-type',
        'syn-fn'
      ] as const) {
        expect(contrast(t.colors[key], t.colors.canvas), `${t.id} ${key}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('round-trip through JSON and fill missing tokens from the base', () => {
    const original = BUILTIN_THEMES.find((t) => t.id === 'sand')!
    const copy = parseTheme(exportTheme(original))
    expect(copy.colors).toEqual(original.colors)
    expect(copy.id).not.toBe(original.id)

    const partial = parseTheme(
      JSON.stringify({ name: 'Mine', base: 'light', colors: { accent: '#ff0000', canvas: 'red' } })
    )
    expect(partial.colors.accent).toBe('#ff0000')
    // Invalid values fall back to the base palette
    expect(partial.colors.canvas).toBe(BUILTIN_THEMES.find((t) => t.id === 'paper')!.colors.canvas)
  })
})
