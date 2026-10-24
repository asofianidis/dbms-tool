import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Braces,
  ClipboardCopy,
  Columns3,
  Eye,
  FileJson,
  Filter,
  Rows3,
  Table2,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import type { Cell, ColumnMeta } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { Dialect } from '@/lib/engines'
import { copyText, serialize, toTsv } from '@/lib/export'
import { isMod } from '@/lib/keys'
import { isNumericType } from '@/lib/sql'
import { showContextMenu, type MenuItem } from '../ContextMenu'
import { ValueInspector } from './ValueInspector'

const ROW_HEIGHT = 26
const HEADER_HEIGHT = 30
const GUTTER = 52
const MIN_WIDTH = 56
const MAX_AUTO_WIDTH = 360

export type RowStatus = 'inserted' | 'deleted' | undefined

export interface GridEditing {
  /** Commit a new value for data row `row`, column `col` */
  onEdit: (row: number, col: number, value: Cell) => void
  rowStatus: (row: number) => RowStatus
  isModified: (row: number, col: number) => boolean
  onDeleteRows: (rows: number[]) => void
  onRevertRows: (rows: number[]) => void
  /** Columns that can't be edited (generated / identity) */
  readOnlyColumns?: Set<number>
}

export type SortState = { col: number; dir: 'asc' | 'desc' } | null

interface Props {
  columns: ColumnMeta[]
  rows: Cell[][]
  editing?: GridEditing
  /** When set, sorting is delegated (e.g. to an ORDER BY) instead of done in memory */
  sort?: SortState
  onSortChange?: (sort: SortState) => void
  /** Client-side quick filter */
  filter?: string
  dialect?: Dialect
  tableName?: string
  /** "Filter by this value" in the context menu */
  onFilterByValue?: (column: string, value: Cell) => void
  /** Extra context menu items for a cell, by data row and column */
  cellMenuItems?: (row: number, col: number) => MenuItem[]
  /** Row numbers start here (for paged views) */
  rowOffset?: number
  className?: string
  onSelectionSummary?: (summary: string | null) => void
}

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
  sort: controlledSort,
  onSortChange,
  filter,
  dialect,
  tableName,
  onFilterByValue,
  cellMenuItems,
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

  const numeric = useMemo(
    () => columns.map((c, i) => (c.typeName ? isNumericType(c.typeName) : looksNumeric(rows, i))),
    [columns, rows]
  )

  // Initial widths from the header and a sample of values
  const [widths, setWidths] = useState<number[]>([])
  useEffect(() => {
    const sample = rows.slice(0, 200)
    setWidths(
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

  // View order: filter then sort; values are data-row indexes
  const order = useMemo(() => {
    let idx = rows.map((_, i) => i)
    const q = filter?.trim().toLowerCase()
    if (q)
      idx = idx.filter((i) =>
        rows[i].some((v) => v !== null && String(v).toLowerCase().includes(q))
      )
    if (sort && !onSortChange) {
      const { col, dir } = sort
      const num = numeric[col]
      idx.sort((a, b) => {
        const d = compare(rows[a][col], rows[b][col], num)
        return dir === 'asc' ? d : -d
      })
    }
    return idx
  }, [rows, filter, sort, onSortChange, numeric])

  const rowVirtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12
  })
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => widths[i] ?? 120,
    paddingStart: GUTTER,
    overscan: 4
  })
  useEffect(() => colVirtualizer.measure(), [widths, colVirtualizer])

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
        const v = rows[order[r]]?.[c]
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
  }, [selection, rows, order, onSelectionSummary])

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
    colVirtualizer.scrollToIndex(p.c, { align: 'auto' })
  }

  const selectedData = (): { cols: ColumnMeta[]; data: Cell[][]; dataRows: number[] } => {
    if (!selection) return { cols: [], data: [], dataRows: [] }
    const cols = columns.slice(selection.c1, selection.c2 + 1)
    const dataRows = order.slice(selection.r1, selection.r2 + 1)
    const data = dataRows.map((r) => rows[r].slice(selection.c1, selection.c2 + 1))
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

  const canEdit = (c: number): boolean => !!editing && !editing.readOnlyColumns?.has(c)

  const beginEdit = (p: Pos): void => {
    const row = order[p.r]
    if (!canEdit(p.c) || editing?.rowStatus(row) === 'deleted') return
    setEditingCell(p)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (editingCell) return
    const maxR = order.length - 1
    const maxC = columns.length - 1
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
        else setInspect({ row: order[focus.r], col: focus.c })
        return
      case 'Delete':
        if (editing && selection) {
          e.preventDefault()
          const fullRows = selection.c1 === 0 && selection.c2 === maxC
          if (fullRows) editing.onDeleteRows(order.slice(selection.r1, selection.r2 + 1))
          else if (
            selection.r1 === selection.r2 &&
            selection.c1 === selection.c2 &&
            canEdit(selection.c1)
          ) {
            editing.onEdit(order[selection.r1], selection.c1, null)
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
    const last = columns.length - 1
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

  const toggleSort = (c: number): void => {
    const next: SortState =
      sort?.col !== c ? { col: c, dir: 'asc' } : sort.dir === 'asc' ? { col: c, dir: 'desc' } : null
    if (onSortChange) onSortChange(next)
    else setLocalSort(next)
  }

  const startResize = (e: React.MouseEvent, c: number): void => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const start = widths[c]
    const onMove = (ev: MouseEvent): void => {
      const w = Math.max(MIN_WIDTH, start + ev.clientX - startX)
      setWidths((ws) => ws.map((x, i) => (i === c ? w : x)))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const autoFit = (c: number): void => {
    let chars = columns[c].name.length + 3
    for (const r of rows.slice(0, 2000)) {
      const v = r[c]
      const len = v === null ? 4 : String(v).length
      if (len > chars) chars = len
    }
    setWidths((ws) =>
      ws.map((x, i) => (i === c ? Math.max(MIN_WIDTH, Math.min(900, chars * 7.3 + 22)) : x))
    )
  }

  const cellMenu = (e: React.MouseEvent, p: Pos): void => {
    if (!isSelected(p.r, p.c)) {
      setAnchor(p)
      setFocus(p)
    }
    const row = order[p.r]
    const value = rows[row]?.[p.c] ?? null
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
        onSelect: () => void copyText(columns[p.c].name, 'Copied column name')
      },
      'separator',
      {
        label: 'View value',
        icon: <Eye />,
        shortcut: editing ? undefined : 'Enter',
        onSelect: () => setInspect({ row, col: p.c })
      }
    ]
    if (onFilterByValue) {
      items.push({
        label: `Filter by this value`,
        icon: <Filter />,
        onSelect: () => onFilterByValue(columns[p.c].name, value)
      })
    }
    if (cellMenuItems) items.push(...cellMenuItems(row, p.c))
    if (editing) {
      const sel = selection ?? { r1: p.r, r2: p.r, c1: p.c, c2: p.c }
      const dataRows = order.slice(sel.r1, sel.r2 + 1)
      items.push(
        'separator',
        {
          label: 'Edit cell',
          shortcut: 'F2',
          disabled: !canEdit(p.c),
          onSelect: () => beginEdit(p)
        },
        {
          label: 'Set to NULL',
          disabled: !canEdit(p.c),
          onSelect: () => editing.onEdit(row, p.c, null)
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

  const virtualRows = rowVirtualizer.getVirtualItems()
  const virtualCols = colVirtualizer.getVirtualItems()
  const totalWidth = colVirtualizer.getTotalSize()
  const leftPad = (virtualCols[0]?.start ?? GUTTER) - GUTTER
  const rightPad = totalWidth - (virtualCols[virtualCols.length - 1]?.end ?? GUTTER)

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
        style={{ width: totalWidth, height: rowVirtualizer.getTotalSize() + HEADER_HEIGHT }}
        className="relative"
      >
        {/* Header */}
        <div
          className="sticky top-0 z-20 flex border-b border-line-strong bg-panel"
          style={{ height: HEADER_HEIGHT, width: totalWidth }}
        >
          <div
            className="sticky left-0 z-30 flex shrink-0 items-center justify-end border-r border-line bg-panel pr-2 text-[10px] text-faint"
            style={{ width: GUTTER }}
            onMouseDown={() => {
              setAnchor({ r: 0, c: 0 })
              setFocus({ r: order.length - 1, c: columns.length - 1 })
            }}
            title="Select all"
          >
            <Rows3 className="size-3" />
          </div>
          {leftPad > 0 && <div style={{ width: leftPad }} className="shrink-0" />}
          {virtualCols.map((vc) => {
            const col = columns[vc.index]
            const sorted = sort?.col === vc.index ? sort.dir : null
            const colSelected =
              !!selection &&
              selection.r1 === 0 &&
              selection.r2 === order.length - 1 &&
              vc.index >= selection.c1 &&
              vc.index <= selection.c2
            return (
              <div
                key={vc.key}
                className={cn(
                  'group relative flex shrink-0 items-center gap-1 border-r border-line px-2 font-sans text-[11.5px] font-medium',
                  colSelected ? 'bg-accent/10 text-bright' : 'text-fg'
                )}
                style={{ width: vc.size }}
                onMouseDown={(e) => e.button === 0 && selectColumn(vc.index, e.shiftKey)}
                onContextMenu={(e) =>
                  showContextMenu(e, [
                    {
                      label: 'Sort ascending',
                      icon: <ArrowUp />,
                      onSelect: () =>
                        onSortChange
                          ? onSortChange({ col: vc.index, dir: 'asc' })
                          : setLocalSort({ col: vc.index, dir: 'asc' })
                    },
                    {
                      label: 'Sort descending',
                      icon: <ArrowDown />,
                      onSelect: () =>
                        onSortChange
                          ? onSortChange({ col: vc.index, dir: 'desc' })
                          : setLocalSort({ col: vc.index, dir: 'desc' })
                    },
                    {
                      label: 'Clear sort',
                      icon: <X />,
                      disabled: !sort,
                      onSelect: () => (onSortChange ? onSortChange(null) : setLocalSort(null))
                    },
                    'separator',
                    {
                      label: 'Copy column name',
                      icon: <ClipboardCopy />,
                      onSelect: () => void copyText(col.name, 'Copied column name')
                    },
                    { label: 'Fit width to content', onSelect: () => autoFit(vc.index) }
                  ])
                }
                title={col.typeName ? `${col.name} · ${col.typeName}` : col.name}
              >
                <span className="min-w-0 shrink truncate">{col.name}</span>
                {col.typeName && (
                  <span className="min-w-0 shrink-[2] truncate font-mono text-[10px] font-normal text-faint">
                    {col.typeName}
                  </span>
                )}
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => toggleSort(vc.index)}
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
                  onMouseDown={(e) => startResize(e, vc.index)}
                  onDoubleClick={() => autoFit(vc.index)}
                />
              </div>
            )
          })}
          {rightPad > 0 && <div style={{ width: rightPad }} className="shrink-0" />}
        </div>

        {/* Rows */}
        {virtualRows.map((vr) => {
          const dataRow = order[vr.index]
          const row = rows[dataRow]
          const status = editing?.rowStatus(dataRow)
          const rowSelected = !!selection && vr.index >= selection.r1 && vr.index <= selection.r2
          return (
            <div
              key={vr.key}
              className={cn(
                'absolute left-0 flex border-b border-line/60',
                vr.index % 2 === 1 && 'bg-bright/[0.025]',
                status === 'inserted' && 'bg-ok/[0.06]',
                status === 'deleted' &&
                  'bg-danger/[0.07] text-faint line-through decoration-danger/60'
              )}
              style={{ top: HEADER_HEIGHT + vr.start, height: ROW_HEIGHT, width: totalWidth }}
            >
              <div
                className={cn(
                  'sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-line bg-panel pr-2 text-[10.5px] tabular-nums',
                  rowSelected ? 'text-accent' : 'text-faint',
                  status === 'inserted' && 'text-ok',
                  status === 'deleted' && 'text-danger'
                )}
                style={{ width: GUTTER }}
                onMouseDown={(e) => e.button === 0 && selectRows(vr.index, e.shiftKey)}
                onMouseEnter={() => {
                  if (dragging.current && anchor) setFocus({ r: vr.index, c: columns.length - 1 })
                }}
                onContextMenu={(e) => cellMenu(e, { r: vr.index, c: 0 })}
              >
                {status === 'inserted' ? '+' : rowOffset + dataRow + 1}
              </div>
              {leftPad > 0 && <div style={{ width: leftPad }} className="shrink-0" />}
              {virtualCols.map((vc) => {
                const c = vc.index
                const value = row?.[c] ?? null
                const selected = isSelected(vr.index, c)
                const isFocus = focus?.r === vr.index && focus?.c === c
                const modified = editing?.isModified(dataRow, c)
                if (editingCell && editingCell.r === vr.index && editingCell.c === c) {
                  return (
                    <CellEditor
                      key={vc.key}
                      width={vc.size}
                      initial={value}
                      onDone={(next, moveBy) => {
                        setEditingCell(null)
                        if (next !== undefined && next !== value) editing?.onEdit(dataRow, c, next)
                        scrollRef.current?.focus({ preventScroll: true })
                        if (moveBy) {
                          const p = {
                            r: Math.min(order.length - 1, Math.max(0, vr.index + moveBy.r)),
                            c: Math.min(columns.length - 1, Math.max(0, c + moveBy.c))
                          }
                          setAnchor(p)
                          setFocus(p)
                        }
                      }}
                    />
                  )
                }
                return (
                  <div
                    key={vc.key}
                    className={cn(
                      'relative flex shrink-0 items-center overflow-hidden border-r border-line/60 px-2 whitespace-pre',
                      numeric[c] && 'justify-end',
                      selected && 'bg-accent/[0.13]',
                      modified && 'bg-warn/[0.13] text-warn',
                      isFocus && 'outline outline-1 -outline-offset-1 outline-accent/80'
                    )}
                    style={{ width: vc.size }}
                    onMouseDown={(e) => onCellMouseDown(e, { r: vr.index, c })}
                    onMouseEnter={() => {
                      if (dragging.current && anchor) setFocus({ r: vr.index, c })
                    }}
                    onDoubleClick={() =>
                      editing && canEdit(c)
                        ? beginEdit({ r: vr.index, c })
                        : setInspect({ row: dataRow, col: c })
                    }
                    onContextMenu={(e) => cellMenu(e, { r: vr.index, c })}
                  >
                    {value === null ? (
                      <span className="text-faint italic">NULL</span>
                    ) : typeof value === 'boolean' ? (
                      <span className="text-syn-number">{String(value)}</span>
                    ) : (
                      <span
                        className={cn('truncate', !modified && numeric[c] && 'text-syn-number/90')}
                      >
                        {value.length > 500
                          ? value.slice(0, 500) + '…'
                          : value.replace(/\r?\n/g, '↵ ')}
                      </span>
                    )}
                  </div>
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
          onClose={() => {
            setInspect(null)
            scrollRef.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </div>
  )
})

function CellEditor({
  width,
  initial,
  onDone
}: {
  width: number
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
    <div className="relative shrink-0" style={{ width }}>
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
