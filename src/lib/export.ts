import { save } from '@tauri-apps/plugin-dialog'
import { api, type Cell, type ColumnMeta } from './api'
import type { Dialect } from './engines'
import { literal, quoteIdent } from './sql'
import { toast, toastError } from './toast'

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'markdown' | 'sql'
/** Text formats plus Excel, which only goes to a file */
export type FileFormat = ExportFormat | 'xlsx'

function cellText(v: Cell): string {
  if (v === null) return ''
  return typeof v === 'boolean' ? String(v) : v
}

function delimited(columns: ColumnMeta[], rows: Cell[][], sep: string, header = true): string {
  const quote = (s: string): string =>
    s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  const lines = rows.map((r) => r.map((v) => quote(cellText(v))).join(sep))
  if (header) lines.unshift(columns.map((c) => quote(c.name)).join(sep))
  return lines.join('\r\n')
}

export function toTsv(columns: ColumnMeta[], rows: Cell[][], header = false): string {
  // Spreadsheet paste: tabs between cells, no quoting unless needed
  return delimited(columns, rows, '\t', header)
}

export function serialize(
  format: ExportFormat,
  columns: ColumnMeta[],
  rows: Cell[][],
  options: { dialect?: Dialect; table?: string } = {}
): string {
  switch (format) {
    case 'csv':
      return delimited(columns, rows, ',')
    case 'tsv':
      return delimited(columns, rows, '\t')
    case 'json':
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i]]))),
        null,
        2
      )
    case 'markdown': {
      const esc = (s: string): string => s.replace(/\|/g, '\|').replace(/\n/g, ' ')
      return [
        `| ${columns.map((c) => esc(c.name)).join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
        ...rows.map(
          (r) => `| ${r.map((v) => esc(v === null ? 'NULL' : cellText(v))).join(' | ')} |`
        )
      ].join('\n')
    }
    case 'sql': {
      const dialect = options.dialect ?? 'postgres'
      const table = options.table ?? 'table_name'
      const cols = columns.map((c) => quoteIdent(dialect, c.name)).join(', ')
      return rows
        .map(
          (r) =>
            `INSERT INTO ${table} (${cols}) VALUES (${r
              .map((v, i) => literal(dialect, v, columns[i].typeName))
              .join(', ')});`
        )
        .join('\n')
    }
  }
}

export const EXTENSIONS: Record<FileFormat, string> = {
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  markdown: 'md',
  sql: 'sql',
  xlsx: 'xlsx'
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Asks where to save; null when the dialog was dismissed. */
export async function pickSavePath(defaultName: string, extension: string): Promise<string | null> {
  return save({
    defaultPath: defaultName.includes('.') ? defaultName : `${defaultName}.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }]
  })
}

export async function saveToFile(
  contents: string,
  defaultName: string,
  extension: string
): Promise<boolean> {
  try {
    const path = await pickSavePath(defaultName, extension)
    if (!path) return false
    await api.writeText(path, contents)
    toast(`Saved ${fileName(path)}`)
    return true
  } catch (e) {
    toastError(e)
    return false
  }
}

/** Saves raw bytes, e.g. a binary cell. */
export async function saveBytesToFile(
  bytes: Uint8Array,
  defaultName: string,
  extension: string
): Promise<boolean> {
  try {
    const path = await pickSavePath(defaultName, extension)
    if (!path) return false
    await api.writeBytes(path, bytes)
    toast(`Saved ${fileName(path)}`)
    return true
  } catch (e) {
    toastError(e)
    return false
  }
}

export async function exportRows(
  format: FileFormat,
  columns: ColumnMeta[],
  rows: Cell[][],
  name: string,
  options: { dialect?: Dialect; table?: string } = {}
): Promise<void> {
  if (format !== 'xlsx') {
    await saveToFile(serialize(format, columns, rows, options), name, EXTENSIONS[format])
    return
  }
  try {
    const path = await pickSavePath(name, 'xlsx')
    if (!path) return
    await api.writeXlsx(path, columns, rows)
    toast(`Saved ${fileName(path)}`)
  } catch (e) {
    toastError(e)
  }
}

export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(what)
  } catch (e) {
    toastError(e)
  }
}
