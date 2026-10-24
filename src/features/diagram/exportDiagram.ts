import { save } from '@tauri-apps/plugin-dialog'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import interUrl from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import mono400Url from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url'
import { api } from '@/lib/api'
import { buildPdf, type Rect } from '@/lib/diagram'
import { BUILTIN_THEMES, TOKENS, type ThemeColors } from '@/lib/themes'
import { toast } from '@/lib/toast'

export type ExportStyle = 'theme' | 'light'
export type ExportFormat = 'png' | 'svg' | 'pdf'

/** Concrete colours for an export: the live theme, or the built-in light theme for print. */
export function exportPalette(style: ExportStyle): ThemeColors {
  if (style === 'light') return BUILTIN_THEMES.find((t) => t.id === 'paper')!.colors
  const css = getComputedStyle(document.documentElement)
  return Object.fromEntries(
    TOKENS.map(({ key }) => [key, css.getPropertyValue(`--color-${key}`).trim()])
  ) as ThemeColors
}

let fontCss: Promise<string> | null = null

/** @font-face rules with the app fonts inlined, so images render without network access. */
function embeddedFonts(): Promise<string> {
  fontCss ??= (async () => {
    const dataUrl = async (url: string): Promise<string> => {
      const blob = await (await fetch(url)).blob()
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(new Blob([blob], { type: 'font/woff2' }))
      })
    }
    try {
      const [inter, mono] = await Promise.all([dataUrl(interUrl), dataUrl(mono400Url)])
      return (
        `@font-face{font-family:'Inter Variable';font-weight:100 900;src:url(${inter}) format('woff2')}` +
        `@font-face{font-family:'JetBrains Mono';font-weight:400;src:url(${mono}) format('woff2')}`
      )
    } catch {
      // Fall back to the system fonts in the font stacks
      return ''
    }
  })()
  return fontCss
}

const escapeXml = (s: string): string =>
  s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!)

/** A standalone SVG document showing `area` of the scene. */
export async function renderSvg(
  scene: ReactElement,
  area: Rect,
  background: string,
  title: string
): Promise<string> {
  const fonts = await embeddedFonts()
  const { x, y, width, height } = area
  const w = Math.ceil(width)
  const h = Math.ceil(height)
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">` +
    `<title>${escapeXml(title)}</title>` +
    (fonts ? `<style>${fonts}</style>` : '') +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${escapeXml(background)}"/>` +
    renderToStaticMarkup(scene) +
    `</svg>`
  )
}

// Chromium refuses canvases past ~16k a side or ~268M pixels; stay well inside both
const MAX_SIDE = 16_000
const MAX_PIXELS = 100_000_000
const MAX_PDF_PIXELS = 40_000_000

/** Draws the SVG at `scale`, shrinking the scale if the canvas would be too large. */
export async function rasterize(
  svg: string,
  width: number,
  height: number,
  scale: number,
  maxPixels = MAX_PIXELS
): Promise<HTMLCanvasElement> {
  const fit = Math.min(
    scale,
    MAX_SIDE / width,
    MAX_SIDE / height,
    Math.sqrt(maxPixels / (width * height))
  )
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(width * fit))
  canvas.height = Math.max(1, Math.floor(height * fit))
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not create an image canvas')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  } finally {
    URL.revokeObjectURL(url)
  }
  return canvas
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not encode the image'))),
      'image/png'
    )
  )
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** One-page PDF holding the canvas, sized so 1 diagram pixel is 1 CSS pixel (0.75 pt). */
export async function canvasPdf(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  title: string
): Promise<Uint8Array> {
  const ctx = canvas.getContext('2d')!
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const rgb = new Uint8Array(canvas.width * canvas.height * 3)
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i]
    rgb[j + 1] = data[i + 1]
    rgb[j + 2] = data[i + 2]
  }
  // PDF pages are limited to 200 inches a side
  const points = Math.min(0.75, 14_400 / width, 14_400 / height)
  return buildPdf({
    pixels: await deflate(rgb),
    width: canvas.width,
    height: canvas.height,
    pageWidth: width * points,
    pageHeight: height * points,
    title
  })
}

export interface ExportJob {
  scene: ReactElement
  area: Rect
  background: string
  title: string
  scale: number
}

/** Renders the job in `format`, as bytes ready to save. */
export async function exportBytes(job: ExportJob, format: ExportFormat): Promise<Uint8Array> {
  const svg = await renderSvg(job.scene, job.area, job.background, job.title)
  if (format === 'svg') return new TextEncoder().encode(svg)
  const { width, height } = job.area
  if (format === 'png') {
    const canvas = await rasterize(svg, width, height, job.scale)
    return new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer())
  }
  const canvas = await rasterize(svg, width, height, job.scale, MAX_PDF_PIXELS)
  return canvasPdf(canvas, width, height, job.title)
}

export async function copyPng(job: ExportJob): Promise<void> {
  // Start the write right away with a pending blob, so it stays inside the user gesture
  const png = (async () => {
    const svg = await renderSvg(job.scene, job.area, job.background, job.title)
    return canvasBlob(await rasterize(svg, job.area.width, job.area.height, job.scale))
  })()
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  toast('Diagram copied to the clipboard')
}

const FILTERS: Record<ExportFormat, string> = {
  png: 'PNG image',
  svg: 'SVG image',
  pdf: 'PDF document'
}

/** Asks where to save, then writes the export. Returns false if the user cancelled. */
export async function saveExport(
  job: ExportJob,
  format: ExportFormat,
  name: string
): Promise<boolean> {
  const path = await save({
    defaultPath: `${name}.${format}`,
    filters: [{ name: FILTERS[format], extensions: [format] }]
  })
  if (!path) return false
  await api.writeBytes(path, await exportBytes(job, format))
  toast(`Saved ${path.split(/[\\/]/).pop()}`)
  return true
}

export type TextFormat = 'dbml' | 'mermaid'

const TEXT_FILES: Record<TextFormat, { name: string; extension: string }> = {
  dbml: { name: 'DBML schema', extension: 'dbml' },
  mermaid: { name: 'Mermaid diagram', extension: 'mmd' }
}

/** Asks where to save, then writes a text export. Returns false if the user cancelled. */
export async function saveText(text: string, format: TextFormat, name: string): Promise<boolean> {
  const { name: filter, extension } = TEXT_FILES[format]
  const path = await save({
    defaultPath: `${name}.${extension}`,
    filters: [{ name: filter, extensions: [extension] }]
  })
  if (!path) return false
  await api.writeText(path, text)
  toast(`Saved ${path.split(/[\/]/).pop()}`)
  return true
}
