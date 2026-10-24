import { save } from '@tauri-apps/plugin-dialog'
import { api, type Cell, type ColumnMeta } from './api'
import type { Dialect } from './engines'
import { plural } from './format'
import { literal, quoteIdent } from './sql'
import { errorMessage, toast, toastError } from './toast'

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'markdown' | 'sql'
/** Text formats plus Excel, which only goes to a file */
export type FileFormat = ExportFormat | 'xlsx'

/** Most rows a "Save as" export fetches; the toast says when a result has more. */
export const EXPORT_MAX_ROWS = 1_000_000

function cellText(v: Cell): string {
  if (v === null) return ''
  return typeof v === 'boolean' ? String(v) : v
}

/**
 * PostgreSQL's COPY CSV convention, which round-trips: NULL is an empty
 * unquoted field and an empty string is a quoted empty field.
 */
function delimited(columns: ColumnMeta[], rows: Cell[][], sep: string, header = true): string {
  const quote = (s: string): string =>
    s === '' || s.includes(sep) || s.includes('"') || s.includes('\n') || s.includes('\r')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  const field = (v: Cell): string => (v === null ? '' : quote(cellText(v)))
  const lines = rows.map((r) => r.map(field).join(sep))
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
      const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
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

/** A whole result fetched for export; `truncated` when it still stopped short. */
export interface FetchedRows {
  columns: ColumnMeta[]
  rows: Cell[][]
  truncated: boolean
}

export interface FetchedFile {
  /** Text to write, or a writer for binary formats such as XLSX */
  contents: string | ((path: string) => Promise<void>)
  rows: number
  truncated: boolean
}

/**
 * Asks for the file first, then fetches and writes it, so a cancelled dialog
 * doesn't cost a long fetch. When the fetch fails, `onFetchError` may hand
 * back something else to write (e.g. the rows already loaded); without it, or
 * when it returns null, nothing is written.
 */
export async function saveFetched(
  defaultName: string,
  extension: string,
  fetch: () => Promise<FetchedFile>,
  onFetchError?: (error: unknown) => Promise<FetchedFile | null>
): Promise<boolean> {
  let path: string | null
  try {
    path = await pickSavePath(defaultName, extension)
  } catch (e) {
    toastError(e)
    return false
  }
  if (!path) return false
  toast('Fetching all rows for export…', 'info')
  let file: FetchedFile | null
  try {
    file = await fetch()
  } catch (e) {
    if (!onFetchError) {
      toast(`Export cancelled: ${errorMessage(e)}`, 'error')
      return false
    }
    file = await onFetchError(e)
  }
  if (!file) return false
  try {
    if (typeof file.contents === 'string') await api.writeText(path, file.contents)
    else await file.contents(path)
  } catch (e) {
    toastError(e)
    return false
  }
  const what = plural(file.rows, 'row')
  if (file.truncated)
    toast(`Saved only ${what} to ${fileName(path)}; the result has more than that`, 'error')
  else toast(`Saved ${what} to ${fileName(path)}`)
  return true
}

/** "Save as" for a whole result, fetched by `fetch` rather than taken from what's loaded. */
export async function exportAll(
  format: FileFormat,
  name: string,
  fetch: () => Promise<FetchedRows>,
  options: {
    dialect?: Dialect
    table?: string
    onFetchError?: (error: unknown) => Promise<FetchedRows | null>
  } = {}
): Promise<void> {
  const render = (set: FetchedRows): FetchedFile => ({
    contents:
      format === 'xlsx'
        ? (path) => api.writeXlsx(path, set.columns, set.rows)
        : serialize(format, set.columns, set.rows, options),
    rows: set.rows.length,
    truncated: set.truncated
  })
  const onFetchError = options.onFetchError
  await saveFetched(
    name,
    EXTENSIONS[format],
    async () => render(await fetch()),
    onFetchError &&
      (async (e) => {
        const set = await onFetchError(e)
        return set && render(set)
      })
  )
}

export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(what)
  } catch (e) {
    toastError(e)
  }
}
