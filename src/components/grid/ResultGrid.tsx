import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Braces,
  ClipboardCopy,
  Columns3,
  EyeOff,
  Eye,
  FileJson,
  Filter,
  ListFilter,
  Pin,
  PinOff,
  RotateCcw,
  Rows3,
  Table2,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import type { Cell, ColumnMeta } from '@/lib/api'
import { cn } from '@/lib/cn'
import { displayTimestamp } from '@/lib/datetime'
import type { Dialect } from '@/lib/engines'
import { copyText, serialize, toTsv } from '@/lib/export'
import {
  columnFilter,
  columnKeys,
  emptyLayout,
  gridLayoutStore,
  moveColumn,
  resetLayout,
  updateLayout,
  viewColumns,
  type GridLayout
} from '@/lib/grid-layout'
import { isMod } from '@/lib/keys'
import { settingsStore } from '@/lib/settings'
import { isNumericType } from '@/lib/sql'
import { showContextMenu, type MenuItem } from '../ContextMenu'
import { ValueInspector } from './ValueInspector'

const ROW_HEIGHT = 26
const HEADER_HEIGHT = 30
const FILTER_HEIGHT = 28
const GUTTER = 52
const MIN_WIDTH = 56
const MAX_AUTO_WIDTH = 360
/** Shared so a grid without a saved layout gets the same object every render */
const NO_LAYOUT = emptyLayout()

export type RowStatus = 'inserted' | 'deleted' | 'changed' | undefined

export interface GridEditing {
  /** Commit a new value for data row `row`, column `col` */
  onEdit: (row: number, col: number, value: Cell) => void
  rowStatus: (row: number) => RowStatus
  isModified: (row: number, col: number) => boolean
  onDeleteRows: (rows: number[]) => void
  onRevertRows: (rows: number[]) => void
  /** Columns that can't be edited (generated / identity, or not from the table) */
  readOnlyColumns?: Set<number>
}

/** Row and cell highlights without editing, e.g. for comparing results */
export interface GridMarks {
  rowStatus?: (row: number) => RowStatus
  isModified?: (row: number, col: number) => boolean
}

export type SortState = { col: number; dir: 'asc' | 'desc' } | null

interface Props {
  columns: ColumnMeta[]
  rows: Cell[][]
  editing?: GridEditing
  marks?: GridMarks
  /** When set, sorting is delegated (e.g. to an ORDER BY) instead of done in memory */
  sort?: SortState
  onSortChange?: (sort: SortState) => void
  /** Client-side quick filter */
  filter?: string
  /** Show the per-column filter row; uncontrolled when absent */
  columnFilters?: boolean
  onColumnFiltersChange?: (open: boolean) => void
  /** Remembers widths, order, hidden and frozen columns under this key */
  layoutKey?: string
  dialect?: Dialect
  tableName?: string
  /** "Filter by this value" in the context menu */
  onFilterByValue?: (column: string, value: Cell) => void
  /** Extra context menu items for a cell, by data row and column */
  cellMenuItems?: (row: number, col: number) => MenuItem[]
  /** Fetches a cell's whole value (binary cells arrive cut short) */
  onLoadValue?: (row: number, col: number) => Promise<Cell>
  /** Row numbers start here (for paged views) */
  rowOffset?: number
  className?: string
  onSelectionSummary?: (summary: string | null) => void
}

/** Selection and focus are in view coordinates: filtered/sorted row, displayed column. */
interface Pos {
  r: number
  c: number
}

function looksNumeric(rows: Cell[][], col: number): boolean {
  let seen = 0
  for (let i = 0; i < rows.length && seen < 20; i++) {
    const v = rows[i][col]
    if (v === null || v === '') continue
    if (typeof v !== 'string' || !/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)) return false
    seen++
  }
  return seen > 0
}

function compare(a: Cell, b: Cell, numeric: boolean): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  if (numeric) return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

export const ResultGrid = memo(function ResultGrid({
  columns,
  rows,
  editing,
  marks,
  sort: controlledSort,
  onSortChange,
  filter,
  columnFilters: controlledFilters,
  onColumnFiltersChange,
  layoutKey,
  dialect,
  tableName,
  onFilterByValue,
  cellMenuItems,
  onLoadValue,
  rowOffset = 0,
  className,
  onSelectionSummary
}: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [localSort, setLocalSort] = useState<SortState>(null)
  const sort = onSortChange ? (controlledSort ?? null) : localSort
  const [anchor, setAnchor] = useState<Pos | null>(null)
  const [focus, setFocus] = useState<Pos | null>(null)
  const [editingCell, setEditingCell] = useState<Pos | null>(null)
  const [inspect, setInspect] = useState<{ row: number; col: number } | null>(null)
  const dragging = useRef(false)
  const { timeZone, assumeUtc, dateFormat } = settingsStore.use()
  const timeDisplay = useMemo(
    () => ({ timeZone, assumeUtc, format: dateFormat }),
    [timeZone, assumeUtc, dateFormat]
  )

  // Column layout: persisted under layoutKey, else kept for this grid's lifetime
  const stored = gridLayoutStore.use()
  const [localLayout, setLocalLayout] = useState<GridLayout>(emptyLayout)
  const layout = layoutKey ? (stored[layoutKey] ?? NO_LAYOUT) : localLayout
  const changeLayout = useCallback(
    (update: (l: GridLayout) => Partial<GridLayout>) => {
      if (layoutKey) updateLayout(layoutKey, update)
      else setLocalLayout((l) => ({ ...l, ...update(l) }))
    },
    [layoutKey]
  )
  const keys = useMemo(() => columnKeys(columns), [columns])
  const view = useMemo(() => {
    const v = viewColumns(keys, layout)
    return v.length ? v : keys.map((_, i) => i)
  }, [keys, layout])
  const hiddenCount = columns.length - view.length
  const frozen = Math.max(0, Math.min(layout.frozen, view.length - 1))

  const [localFilters, setLocalFilters] = useState(false)
  const filtersOpen = controlledFilters ?? localFilters
  const setFiltersOpen = (open: boolean): void => {
    if (onColumnFiltersChange) onColumnFiltersChange(open)
    else setLocalFilters(open)
  }
  const [colFilters, setColFilters] = useState<Record<string, string>>({})
  const headerHeight = HEADER_HEIGHT + (filtersOpen ? FILTER_HEIGHT : 0)

  const numeric = useMemo(
    () => columns.map((c, i) => (c.typeName ? isNumericType(c.typeName) : looksNumeric(rows, i))),
    [columns, rows]
  )

  // Initial widths from the header and a sample of values, by data column
  const [autoWidths, setAutoWidths] = useState<number[]>([])
  const [dragWidth, setDragWidth] = useState<{ col: number; width: number } | null>(null)
  useEffect(() => {
    const sample = rows.slice(0, 200)
    setAutoWidths(
      columns.map((c, i) => {
        // Header shows the name and the type side by side
        let chars = c.name.length + (c.typeName ? c.typeName.length * 0.8 + 2 : 0) + 3
        for (const r of sample) {
          const v = r[i]
          const len = v === null ? 4 : typeof v === 'boolean' ? 5 : Math.min(v.length, 60)
          if (len > chars) chars = len
        }
        return Math.max(MIN_WIDTH, Math.min(MAX_AUTO_WIDTH, Math.round(chars * 7.3 + 22)))
      })
    )
    setAnchor(null)
    setFocus(null)
    setEditingCell(null)
    // Column identity changes mean a new result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns])

  const widthOf = useCallback(
    (col: number): number =>
      dragWidth?.col === col
        ? dragWidth.width
        : (layout.widths[keys[col]] ?? autoWidths[col] ?? 120),
    [dragWidth, layout.widths, keys, autoWidths]
  )
  const frozenCols = useMemo(() => view.slice(0, frozen), [view, frozen])
  const scrollCols = useMemo(() => view.slice(frozen), [view, frozen])
  const frozenLefts = useMemo(() => {
    let left = GUTTER
    return frozenCols.map((c) => {
      const at = left
      left += widthOf(c)
      return at
    })
  }, [frozenCols, widthOf])
  const frozenWidth = frozenCols.reduce((n, c) => n + widthOf(c), 0)

  // View order: filter then sort; values are data-row indexes
  const tests = useMemo(
    () =>
      Object.entries(colFilters)
        .map(([key, text]) => {
          const col = keys.indexOf(key)
          const test = col >= 0 ? columnFilter(text, numeric[col]) : null
          return test ? ([col, test] as const) : null
        })
        .filter((t) => t !== null),
    [colFilters, keys, numeric]
  )
  const order = useMemo(() => {
    let idx = rows.map((_, i) => i)
    const q = filter?.trim().toLowerCase()
    if (q)
      idx = idx.filter((i) =>
        rows[i].some((v) => v !== null && String(v).toLowerCase().includes(q))
      )
    if (filtersOpen && tests.length)
      idx = idx.filter((i) => tests.every(([col, test]) => test(rows[i][col])))
    if (sort && !onSortChange) {
      const { col, dir } = sort
      const num = numeric[col]
      idx.sort((a, b) => {
        const d = compare(rows[a][col], rows[b][col], num)
        return dir === 'asc' ? d : -d
      })
    }
    return idx
  }, [rows, filter, filtersOpen, tests, sort, onSortChange, numeric])

  const rowVirtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: scrollCols.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widthOf(scrollCols[i]),
    paddingStart: GUTTER + frozenWidth,
    overscan: 4
  })
  useEffect(() => colVirtualizer.measure(), [widthOf, scrollCols, frozenWidth, colVirtualizer])

  const selection = useMemo(() => {
    if (!anchor || !focus) return null
    return {
      r1: Math.min(anchor.r, focus.r),
      r2: Math.max(anchor.r, focus.r),
      c1: Math.min(anchor.c, focus.c),
      c2: Math.max(anchor.c, focus.c)
    }
  }, [anchor, focus])

  useEffect(() => {
    if (!onSelectionSummary) return
    if (!selection) return onSelectionSummary(null)
    const cells = (selection.r2 - selection.r1 + 1) * (selection.c2 - selection.c1 + 1)
    if (cells <= 1) return onSelectionSummary(null)
    // Sum numeric selections like a spreadsheet
    let sum = 0
    let count = 0
    for (let r = selection.r1; r <= selection.r2 && r - selection.r1 < 5000; r++) {
      for (let c = selection.c1; c <= selection.c2; c++) {
        const v = rows[order[r]]?.[view[c]]
        if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) {
          sum += Number(v)
          count++
        }
      }
    }
    const parts = [`${cells.toLocaleString()} cells`]
    if (count > 0)
      parts.push(
        `Sum ${Number(sum.toPrecision(12)).toLocaleString()}`,
        `Avg ${Number((sum / count).toPrecision(8)).toLocaleString()}`
      )
    onSelectionSummary(parts.join(' · '))
  }, [selection, rows, order, view, onSelectionSummary])

  const isSelected = useCallback(
    (r: number, c: number) =>
      !!selection &&
      r >= selection.r1 &&
      r <= selection.r2 &&
      c >= selection.c1 &&
      c <= selection.c2,
    [selection]
  )

  const scrollTo = (p: Pos): void => {
    rowVirtualizer.scrollToIndex(p.r, { align: 'auto' })
    if (p.c >= frozen) colVirtualizer.scrollToIndex(p.c - frozen, { align: 'auto' })
  }

  const selectedData = (): { cols: ColumnMeta[]; data: Cell[][]; dataRows: number[] } => {
    if (!selection) return { cols: [], data: [], dataRows: [] }
    const shown = view.slice(selection.c1, selection.c2 + 1)
    const cols = shown.map((i) => columns[i])
    const dataRows = order.slice(selection.r1, selection.r2 + 1)
    const data = dataRows.map((r) => shown.map((i) => rows[r][i]))
    return { cols, data, dataRows }
  }

  const copySelection = (withHeaders: boolean): void => {
    const { cols, data } = selectedData()
    if (!cols.length) return
    // Same rule as CSV files: NULL is an empty field, an empty string is ""
    void copyText(
      toTsv(cols, data, withHeaders),
      `Copied ${data.length === 1 && cols.length === 1 ? 'value' : `${data.length} × ${cols.length}`}`
    )
  }

  const copyAs = (format: 'json' | 'csv' | 'sql' | 'markdown'): void => {
    const { cols, data } = selectedData()
    if (!cols.length) return
    void copyText(
      serialize(format, cols, data, { dialect, table: tableName }),
      `Copied as ${format.toUpperCase()}`
    )
  }

  /** Whether data column `col` can be edited */
  const canEdit = (col: number): boolean => !!editing && !editing.readOnlyColumns?.has(col)

  const beginEdit = (p: Pos): void => {
    const row = order[p.r]
    if (!canEdit(view[p.c]) || editing?.rowStatus(row) === 'deleted') return
    setEditingCell(p)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (editingCell) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const maxR = order.length - 1
    const maxC = view.length - 1
    if (isMod(e) && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      copySelection(e.shiftKey)
      return
    }
    if (isMod(e) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setAnchor({ r: 0, c: 0 })
      setFocus({ r: maxR, c: maxC })
      return
    }
    if (!focus) {
      if (e.key.startsWith('Arrow') && order.length) {
        e.preventDefault()
        setAnchor({ r: 0, c: 0 })
        setFocus({ r: 0, c: 0 })
      }
      return
    }
    const move = (dr: number, dc: number): void => {
      e.preventDefault()
      const page = Math.max(
        1,
        Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_HEIGHT) - 1
      )
      const step = (d: number, size: number): number =>
        Math.abs(d) === 1000 ? Math.sign(d) * size : d
      const next = {
        r: Math.max(
          0,
          Math.min(maxR, focus.r + (dr === 999 ? page : dr === -999 ? -page : step(dr, maxR)))
        ),
        c: Math.max(0, Math.min(maxC, focus.c + step(dc, maxC)))
      }
      setFocus(next)
      if (!e.shiftKey) setAnchor(next)
      scrollTo(next)
    }
    const jump = isMod(e) ? 1000 : 1
    switch (e.key) {
      case 'ArrowDown':
        return move(jump, 0)
      case 'ArrowUp':
        return move(-jump, 0)
      case 'ArrowRight':
        return move(0, jump)
      case 'ArrowLeft':
        return move(0, -jump)
      case 'PageDown':
        return move(999, 0)
      case 'PageUp':
        return move(-999, 0)
      case 'Home':
        return move(isMod(e) ? -1000 : 0, -1000)
      case 'End':
        return move(isMod(e) ? 1000 : 0, 1000)
      case 'Tab':
        return move(0, e.shiftKey ? -1 : 1)
      case 'Enter':
      case 'F2':
        e.preventDefault()
        if (editing) beginEdit(focus)
        else setInspect({ row: order[focus.r], col: view[focus.c] })
        return
      case 'Delete':
        if (editing && selection) {
          e.preventDefault()
          const fullRows = selection.c1 === 0 && selection.c2 === maxC
          if (fullRows) editing.onDeleteRows(order.slice(selection.r1, selection.r2 + 1))
          else if (
            selection.r1 === selection.r2 &&
            selection.c1 === selection.c2 &&
            canEdit(view[selection.c1])
          ) {
            editing.onEdit(order[selection.r1], view[selection.c1], null)
          }
        }
        return
    }
    // Typing starts an edit, like a spreadsheet
    if (editing && e.key.length === 1 && !isMod(e) && !e.altKey) {
      beginEdit(focus)
    }
  }

  const onCellMouseDown = (e: React.MouseEvent, p: Pos): void => {
    if (e.button === 2 && isSelected(p.r, p.c)) return
    scrollRef.current?.focus({ preventScroll: true })
    if (e.shiftKey && anchor) setFocus(p)
    else {
      setAnchor(p)
      setFocus(p)
    }
    dragging.current = e.button === 0
  }

  useEffect(() => {
    const up = (): void => {
      dragging.current = false
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const selectRows = (r: number, extend: boolean): void => {
    scrollRef.current?.focus({ preventScroll: true })
    const last = view.length - 1
    if (extend && anchor) setFocus({ r, c: last })
    else {
      setAnchor({ r, c: 0 })
      setFocus({ r, c: last })
    }
  }

  const selectColumn = (c: number, extend: boolean): void => {
    scrollRef.current?.focus({ preventScroll: true })
    const last = Math.max(0, order.length - 1)
    if (extend && anchor) setFocus({ r: last, c })
    else {
      setAnchor({ r: 0, c })
      setFocus({ r: last, c })
    }
  }

  const toggleSort = (col: number): void => {
    const next: SortState =
      sort?.col !== col ? { col, dir: 'asc' } : sort.dir === 'asc' ? { col, dir: 'desc' } : null
    if (onSortChange) onSortChange(next)
    else setLocalSort(next)
  }

  const setWidth = (col: number, width: number): void =>
    changeLayout((l) => ({ widths: { ...l.widths, [keys[col]]: width } }))

  const startResize = (e: React.MouseEvent, col: number): void => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const start = widthOf(col)
    let width = start
    const onMove = (ev: MouseEvent): void => {
      width = Math.max(MIN_WIDTH, start + ev.clientX - startX)
      setDragWidth({ col, width })
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      setDragWidth(null)
      if (width !== start) setWidth(col, width)
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const autoFit = (col: number): void => {
    let chars = columns[col].name.length + 3
    for (const r of rows.slice(0, 2000)) {
      const v = r[col]
      const len = v === null ? 4 : String(v).length
      if (len > chars) chars = len
    }
    setWidth(col, Math.max(MIN_WIDTH, Math.min(900, chars * 7.3 + 22)))
  }

  const hideColumn = (col: number): void => {
    if (view.length <= 1) return
    changeLayout((l) => ({ hidden: [...l.hidden, keys[col]] }))
    setAnchor(null)
    setFocus(null)
  }

  const showColumn = (col: number): void =>
    changeLayout((l) => ({ hidden: l.hidden.filter((k) => k !== keys[col]) }))

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= view.length || from === to) return
    changeLayout(() => ({ order: moveColumn(keys, view, from, to) }))
    setAnchor(null)
    setFocus(null)
  }

  /** Show / hide choices for every column, plus reset. */
  const columnsMenu = (): MenuItem[] => [
    { heading: `${view.length} of ${columns.length} columns shown` },
    ...columns.map((col, i): MenuItem => ({
      label: col.name,
      icon: view.includes(i) ? <Eye /> : <EyeOff />,
      disabled: view.length === 1 && view[0] === i,
      onSelect: () => (view.includes(i) ? hideColumn(i) : showColumn(i))
    })),
    'separator',
    {
      label: 'Show all columns',
      disabled: !hiddenCount,
      onSelect: () => changeLayout(() => ({ hidden: [] }))
    },
    {
      label: 'Reset column layout',
      icon: <RotateCcw />,
      onSelect: () => (layoutKey ? resetLayout(layoutKey) : setLocalLayout(emptyLayout()))
    }
  ]

  const headerMenu = (e: React.MouseEvent, pos: number): void => {
    const col = view[pos]
    const name = columns[col].name
    showContextMenu(e, [
      {
        label: 'Sort ascending',
        icon: <ArrowUp />,
        onSelect: () =>
          onSortChange ? onSortChange({ col, dir: 'asc' }) : setLocalSort({ col, dir: 'asc' })
      },
      {
        label: 'Sort descending',
        icon: <ArrowDown />,
        onSelect: () =>
          onSortChange ? onSortChange({ col, dir: 'desc' }) : setLocalSort({ col, dir: 'desc' })
      },
      {
        label: 'Clear sort',
        icon: <X />,
        disabled: !sort,
        onSelect: () => (onSortChange ? onSortChange(null) : setLocalSort(null))
      },
      'separator',
      {
        label: filtersOpen ? 'Hide column filters' : 'Filter columns',
        icon: <ListFilter />,
        onSelect: () => setFiltersOpen(!filtersOpen)
      },
      {
        label: `Hide “${name}”`,
        icon: <EyeOff />,
        disabled: view.length <= 1,
        onSelect: () => hideColumn(col)
      },
      {
        label: 'Columns',
        icon: <Columns3 />,
        submenu: columnsMenu()
      },
      pos < frozen
        ? {
            label: frozen > 1 ? 'Unfreeze columns' : 'Unfreeze column',
            icon: <PinOff />,
            onSelect: () => changeLayout(() => ({ frozen: 0 }))
          }
        : {
            label: pos === 0 ? `Freeze “${name}”` : `Freeze columns up to “${name}”`,
            icon: <Pin />,
            disabled: pos >= view.length - 1,
            onSelect: () => changeLayout(() => ({ frozen: pos + 1 }))
          },
      {
        label: 'Move left',
        icon: <ArrowLeft />,
        disabled: pos === 0,
        onSelect: () => move(pos, pos - 1)
      },
      {
        label: 'Move right',
        icon: <ArrowRight />,
        disabled: pos === view.length - 1,
        onSelect: () => move(pos, pos + 1)
      },
      'separator',
      {
        label: 'Copy column name',
        icon: <ClipboardCopy />,
        onSelect: () => void copyText(name, 'Copied column name')
      },
      { label: 'Fit width to content', onSelect: () => autoFit(col) }
    ])
  }

  const cellMenu = (e: React.MouseEvent, p: Pos): void => {
    if (!isSelected(p.r, p.c)) {
      setAnchor(p)
      setFocus(p)
    }
    const row = order[p.r]
    const col = view[p.c]
    const value = rows[row]?.[col] ?? null
    const items: MenuItem[] = [
      {
        label: 'Copy',
        icon: <ClipboardCopy />,
        shortcut: 'Ctrl+C',
        onSelect: () => copySelection(false)
      },
      {
        label: 'Copy with headers',
        icon: <Table2 />,
        shortcut: 'Ctrl+Shift+C',
        onSelect: () => copySelection(true)
      },
      {
        label: 'Copy as',
        icon: <Braces />,
        submenu: [
          { label: 'JSON', icon: <FileJson />, onSelect: () => copyAs('json') },
          { label: 'CSV', onSelect: () => copyAs('csv') },
          { label: 'Markdown table', onSelect: () => copyAs('markdown') },
          { label: 'SQL INSERT statements', onSelect: () => copyAs('sql') }
        ]
      },
      {
        label: 'Copy column name',
        icon: <Columns3 />,
        onSelect: () => void copyText(columns[col].name, 'Copied column name')
      },
      'separator',
      {
        label: 'View value',
        icon: <Eye />,
        shortcut: editing ? undefined : 'Enter',
        onSelect: () => setInspect({ row, col })
      }
    ]
    if (onFilterByValue) {
      items.push({
        label: `Filter by this value`,
        icon: <Filter />,
        onSelect: () => onFilterByValue(columns[col].name, value)
      })
    }
    if (cellMenuItems) items.push(...cellMenuItems(row, col))
    if (editing) {
      const sel = selection ?? { r1: p.r, r2: p.r, c1: p.c, c2: p.c }
      const dataRows = order.slice(sel.r1, sel.r2 + 1)
      items.push(
        'separator',
        {
          label: 'Edit cell',
          shortcut: 'F2',
          disabled: !canEdit(col),
          onSelect: () => beginEdit(p)
        },
        {
          label: 'Set to NULL',
          disabled: !canEdit(col),
          onSelect: () => editing.onEdit(row, col, null)
        },
        {
          label: dataRows.length > 1 ? `Delete ${dataRows.length} rows` : 'Delete row',
          icon: <Trash2 />,
          danger: true,
          onSelect: () => editing.onDeleteRows(dataRows)
        },
        { label: 'Revert changes', icon: <Undo2 />, onSelect: () => editing.onRevertRows(dataRows) }
      )
    }
    showContextMenu(e, items)
  }

  const dragCol = useRef<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  const virtualRows = rowVirtualizer.getVirtualItems()
  const virtualCols = colVirtualizer.getVirtualItems()
  const totalWidth = colVirtualizer.getTotalSize()
  const scrollStart = GUTTER + frozenWidth
  const leftPad = (virtualCols[0]?.start ?? scrollStart) - scrollStart
  const rightPad = totalWidth - (virtualCols[virtualCols.length - 1]?.end ?? scrollStart)
  /** View positions rendered in a row: every frozen column, then the virtual window */
  const rendered = [
    ...frozenCols.map((_, i) => ({ pos: i, width: widthOf(view[i]), key: `f${i}` })),
    ...virtualCols.map((vc) => ({ pos: frozen + vc.index, width: vc.size, key: vc.key }))
  ]
  const stickyStyle = (pos: number): React.CSSProperties | undefined =>
    pos < frozen ? { position: 'sticky', left: frozenLefts[pos] } : undefined

  const rowStatusOf = (row: number): RowStatus => editing?.rowStatus(row) ?? marks?.rowStatus?.(row)
  const modifiedOf = (row: number, col: number): boolean =>
    editing?.isModified(row, col) ?? marks?.isModified?.(row, col) ?? false

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        'relative h-full overflow-auto bg-canvas font-mono text-[12px] outline-none',
        className
      )}
    >
      <div
        style={{ width: totalWidth, height: rowVirtualizer.getTotalSize() + headerHeight }}
        className="relative"
      >
        {/* Header */}
        <div className="sticky top-0 z-20 bg-panel" style={{ width: totalWidth }}>
          <div
            className="flex border-b border-line-strong bg-panel"
            style={{ height: HEADER_HEIGHT, width: totalWidth }}
          >
            <div
              className="sticky left-0 z-30 flex shrink-0 items-center justify-end gap-1 border-r border-line bg-panel pr-2 text-[10px] text-faint"
              style={{ width: GUTTER }}
              onMouseDown={(e) => {
                if (e.button !== 0) return
                setAnchor({ r: 0, c: 0 })
                setFocus({ r: order.length - 1, c: view.length - 1 })
              }}
              onContextMenu={(e) => showContextMenu(e, columnsMenu())}
              title={
                hiddenCount
                  ? `Select all · ${hiddenCount} hidden column${hiddenCount > 1 ? 's' : ''} (right-click to show)`
                  : 'Select all · right-click for columns'
              }
            >
              {hiddenCount > 0 && <EyeOff className="size-3 text-warn" />}
              <Rows3 className="size-3" />
            </div>
            {rendered.map(({ pos, width, key }, n) => {
              const col = view[pos]
              const meta = columns[col]
              const sorted = sort?.col === col ? sort.dir : null
              const colSelected =
                !!selection &&
                selection.r1 === 0 &&
                selection.r2 === order.length - 1 &&
                pos >= selection.c1 &&
                pos <= selection.c2
              return (
                <Padded key={key} before={n === frozenCols.length ? leftPad : 0}>
                  <div
                    draggable
                    onDragStart={(e) => {
                      dragCol.current = pos
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', meta.name)
                    }}
                    onDragOver={(e) => {
                      if (dragCol.current === null) return
                      e.preventDefault()
                      setDropAt(pos)
                    }}
                    onDragLeave={() => setDropAt((d) => (d === pos ? null : d))}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (dragCol.current !== null) move(dragCol.current, pos)
                      dragCol.current = null
                      setDropAt(null)
                    }}
                    onDragEnd={() => {
                      dragCol.current = null
                      setDropAt(null)
                    }}
                    className={cn(
                      'group relative flex h-full shrink-0 items-center gap-1 border-r border-line px-2 font-sans text-[11.5px] font-medium',
                      colSelected ? 'bg-accent/10 text-bright' : 'bg-panel text-fg',
                      pos < frozen && 'z-20',
                      pos === frozen - 1 && 'border-r-line-strong shadow-[2px_0_4px_var(--shadow)]',
                      dropAt === pos &&
                        dragCol.current !== pos &&
                        (dragCol.current! > pos
                          ? 'shadow-[inset_2px_0_0_var(--color-accent)]'
                          : 'shadow-[inset_-2px_0_0_var(--color-accent)]')
                    )}
                    style={{ width, ...stickyStyle(pos) }}
                    onMouseDown={(e) => e.button === 0 && selectColumn(pos, e.shiftKey)}
                    onContextMenu={(e) => headerMenu(e, pos)}
                    title={meta.typeName ? `${meta.name} · ${meta.typeName}` : meta.name}
                  >
                    {pos < frozen && <Pin className="size-2.5 shrink-0 text-faint" />}
                    <span className="min-w-0 shrink truncate">{meta.name}</span>
                    {meta.typeName && (
                      <span className="min-w-0 shrink-[2] truncate font-mono text-[10px] font-normal text-faint">
                        {meta.typeName}
                      </span>
                    )}
                    <button
                      type="button"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => toggleSort(col)}
                      className={cn(
                        'ml-auto flex size-4 shrink-0 items-center justify-center rounded text-faint hover:text-bright',
                        !sorted && 'opacity-0 group-hover:opacity-100'
                      )}
                      title="Sort"
                    >
                      {sorted === 'asc' ? (
                        <ArrowUp className="size-3 text-accent" />
                      ) : sorted === 'desc' ? (
                        <ArrowDown className="size-3 text-accent" />
                      ) : (
                        <ArrowUpDown className="size-3" />
                      )}
                    </button>
                    <div
                      className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize hover:bg-accent/40"
                      onMouseDown={(e) => startResize(e, col)}
                      onDoubleClick={() => autoFit(col)}
                    />
                  </div>
                </Padded>
              )
            })}
            {rightPad > 0 && <div style={{ width: rightPad }} className="shrink-0" />}
          </div>
          {filtersOpen && (
            <div
              className="flex border-b border-line-strong bg-panel"
              style={{ height: FILTER_HEIGHT, width: totalWidth }}
            >
              <button
                type="button"
                className="sticky left-0 z-30 flex shrink-0 items-center justify-end border-r border-line bg-panel pr-2 text-faint hover:text-bright"
                style={{ width: GUTTER }}
                title="Clear column filters and hide the filter row"
                onClick={() => {
                  setColFilters({})
                  setFiltersOpen(false)
                }}
              >
                <X className="size-3" />
              </button>
              {rendered.map(({ pos, width, key }, n) => {
                const k = keys[view[pos]]
                return (
                  <Padded key={key} before={n === frozenCols.length ? leftPad : 0}>
                    <div
                      className={cn(
                        'flex h-full shrink-0 items-center border-r border-line bg-panel px-1',
                        pos < frozen && 'z-20'
                      )}
                      style={{ width, ...stickyStyle(pos) }}
                    >
                      <input
                        value={colFilters[k] ?? ''}
                        onChange={(e) => setColFilters((f) => ({ ...f, [k]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setColFilters((f) => ({ ...f, [k]: '' }))
                        }}
                        placeholder="Filter"
                        title="Text matches anywhere. Also =x, !=x, !x, >n, <=n, null, !null"
                        spellCheck={false}
                        className={cn(
                          'h-5 w-full min-w-0 rounded border border-line bg-canvas px-1.5 font-mono text-[11px] text-bright placeholder:text-faint focus:border-accent/50 focus:outline-none',
                          colFilters[k] && 'border-accent/40'
                        )}
                      />
                    </div>
                  </Padded>
                )
              })}
              {rightPad > 0 && <div style={{ width: rightPad }} className="shrink-0" />}
            </div>
          )}
        </div>

        {/* Rows */}
        {virtualRows.map((vr) => {
          const dataRow = order[vr.index]
          const row = rows[dataRow]
          const status = rowStatusOf(dataRow)
          const rowSelected = !!selection && vr.index >= selection.r1 && vr.index <= selection.r2
          const stripe = vr.index % 2 === 1
          return (
            <div
              key={vr.key}
              className={cn(
                'absolute left-0 flex border-b border-line/60',
                stripe && 'bg-bright/[0.025]',
                status === 'inserted' && 'bg-ok/[0.06]',
                status === 'changed' && 'bg-warn/[0.04]',
                status === 'deleted' &&
                  'bg-danger/[0.07] text-faint line-through decoration-danger/60'
              )}
              style={{ top: headerHeight + vr.start, height: ROW_HEIGHT, width: totalWidth }}
            >
              <div
                className={cn(
                  'sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-line bg-panel pr-2 text-[10.5px] tabular-nums',
                  rowSelected ? 'text-accent' : 'text-faint',
                  status === 'inserted' && 'text-ok',
                  status === 'changed' && 'text-warn',
                  status === 'deleted' && 'text-danger'
                )}
                style={{ width: GUTTER }}
                onMouseDown={(e) => e.button === 0 && selectRows(vr.index, e.shiftKey)}
                onMouseEnter={() => {
                  if (dragging.current && anchor) setFocus({ r: vr.index, c: view.length - 1 })
                }}
                onContextMenu={(e) => cellMenu(e, { r: vr.index, c: 0 })}
              >
                {status === 'inserted' && editing ? '+' : rowOffset + dataRow + 1}
              </div>
              {rendered.map(({ pos, width, key }, n) => {
                const c = view[pos]
                const value = row?.[c] ?? null
                const selected = isSelected(vr.index, pos)
                const isFocus = focus?.r === vr.index && focus?.c === pos
                const modified = modifiedOf(dataRow, c)
                const sticky = stickyStyle(pos)
                if (editingCell && editingCell.r === vr.index && editingCell.c === pos) {
                  return (
                    <Padded key={key} before={n === frozenCols.length ? leftPad : 0}>
                      <CellEditor
                        width={width}
                        style={sticky}
                        initial={value}
                        onDone={(next, moveBy) => {
                          setEditingCell(null)
                          if (next !== undefined && next !== value)
                            editing?.onEdit(dataRow, c, next)
                          scrollRef.current?.focus({ preventScroll: true })
                          if (moveBy) {
                            const p = {
                              r: Math.min(order.length - 1, Math.max(0, vr.index + moveBy.r)),
                              c: Math.min(view.length - 1, Math.max(0, pos + moveBy.c))
                            }
                            setAnchor(p)
                            setFocus(p)
                          }
                        }}
                      />
                    </Padded>
                  )
                }
                const shown =
                  typeof value === 'string'
                    ? displayTimestamp(value, columns[c].typeName, timeDisplay)
                    : null
                return (
                  <Padded key={key} before={n === frozenCols.length ? leftPad : 0}>
                    <div
                      className={cn(
                        'relative flex shrink-0 items-center overflow-hidden border-r border-line/60 px-2 whitespace-pre',
                        numeric[c] && 'justify-end',
                        pos < frozen && 'z-[5] bg-canvas',
                        pos < frozen &&
                          stripe &&
                          'bg-[color-mix(in_srgb,var(--color-bright)_2.5%,var(--color-canvas))]',
                        pos === frozen - 1 && 'border-r-line-strong',
                        selected && 'bg-accent/[0.13]',
                        modified && 'bg-warn/[0.13] text-warn',
                        isFocus && 'outline outline-1 -outline-offset-1 outline-accent/80'
                      )}
                      style={{ width, ...sticky }}
                      onMouseDown={(e) => onCellMouseDown(e, { r: vr.index, c: pos })}
                      onMouseEnter={() => {
                        if (dragging.current && anchor) setFocus({ r: vr.index, c: pos })
                      }}
                      onDoubleClick={() =>
                        editing && canEdit(c)
                          ? beginEdit({ r: vr.index, c: pos })
                          : setInspect({ row: dataRow, col: c })
                      }
                      onContextMenu={(e) => cellMenu(e, { r: vr.index, c: pos })}
                      title={shown ? String(value) : undefined}
                    >
                      {value === null ? (
                        <span className="text-faint italic">NULL</span>
                      ) : typeof value === 'boolean' ? (
                        <span className="text-syn-number">{String(value)}</span>
                      ) : (
                        <span
                          className={cn(
                            'truncate',
                            !modified && numeric[c] && 'text-syn-number/90',
                            shown && 'text-syn-type'
                          )}
                        >
                          {shown ??
                            (value.length > 500
                              ? value.slice(0, 500) + '…'
                              : value.replace(/\r?\n/g, '↵ '))}
                        </span>
                      )}
                    </div>
                  </Padded>
                )
              })}
              {rightPad > 0 && <div style={{ width: rightPad }} className="shrink-0" />}
            </div>
          )
        })}
      </div>
      {inspect && (
        <ValueInspector
          column={columns[inspect.col]}
          value={rows[inspect.row]?.[inspect.col] ?? null}
          editable={canEdit(inspect.col) && editing?.rowStatus(inspect.row) !== 'deleted'}
          onSave={(v) => editing?.onEdit(inspect.row, inspect.col, v)}
          onLoadFull={onLoadValue ? () => onLoadValue(inspect.row, inspect.col) : undefined}
          onClose={() => {
            setInspect(null)
            scrollRef.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </div>
  )
})

/** A cell, preceded by the virtual window's left padding where the scrolled columns begin. */
function Padded({
  before,
  children
}: {
  before: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      {before > 0 && <div style={{ width: before }} className="shrink-0" />}
      {children}
    </>
  )
}

function CellEditor({
  width,
  style,
  initial,
  onDone
}: {
  width: number
  style?: React.CSSProperties
  initial: Cell
  onDone: (value: Cell | undefined, move?: Pos) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial === null ? '' : String(initial))
  // What an empty input means; Backspace or Delete on an empty input switches it
  const [emptyIsNull, setEmptyIsNull] = useState(initial === null)
  const result = (): Cell => (value === '' && emptyIsNull ? null : value)
  const done = useRef(false)
  const finish = (v: Cell | undefined, move?: Pos): void => {
    if (done.current) return
    done.current = true
    onDone(v, move)
  }
  return (
    <div className="relative z-10 shrink-0" style={{ width, ...style }}>
      <input
        autoFocus
        value={value}
        placeholder={emptyIsNull ? 'NULL' : 'empty string'}
        title="Backspace on an empty value switches between NULL and empty string"
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => finish(result())}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') finish(result(), { r: 1, c: 0 })
          else if (e.key === 'Tab') {
            e.preventDefault()
            finish(result(), { r: 0, c: e.shiftKey ? -1 : 1 })
          } else if (e.key === 'Escape') finish(undefined)
          else if ((e.key === 'Backspace' || e.key === 'Delete') && value === '') {
            e.preventDefault()
            setEmptyIsNull((n) => !n)
          }
        }}
        className="absolute inset-0 z-10 h-full w-full bg-raised px-2 font-mono text-[12px] text-bright outline outline-2 -outline-offset-2 outline-accent placeholder:text-faint placeholder:italic"
      />
    </div>
  )
}
