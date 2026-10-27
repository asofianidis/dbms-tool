import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ban, Braces, CalendarDays, Clock, List, Plus, X } from 'lucide-react'
import type { Cell } from '@/lib/api'
import {
  formatPgArray,
  isValidJson,
  mergePicked,
  parsePgArray,
  pickerValue,
  respaceJson,
  type ArrayItem,
  type CellEditorKind
} from '@/lib/cell-edit'
import { cn } from '@/lib/cn'
import { isMod } from '@/lib/keys'
import { toast } from '@/lib/toast'
import { CodeEditor } from '../editor/CodeEditor'
import { Button } from '../ui'

export interface Move {
  r: number
  c: number
}

const PICKER_TYPE = { date: 'date', datetime: 'datetime-local', time: 'time' } as const

/**
 * The inline editor for one grid cell: a text input, plus a date picker for
 * temporal columns and a larger editor for JSON and PostgreSQL arrays.
 */
export function CellEditor({
  width,
  style,
  initial,
  kind,
  onDone
}: {
  width: number
  style?: React.CSSProperties
  initial: Cell
  kind: CellEditorKind
  onDone: (value: Cell | undefined, move?: Move) => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial === null ? '' : String(initial))
  // What an empty input means; Backspace or Delete on an empty input switches it
  const [emptyIsNull, setEmptyIsNull] = useState(initial === null)
  const [panel, setPanel] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // The open panel's value, committed when focus leaves the editor altogether; undefined when invalid
  const panelValue = useRef<() => string | undefined>(() => value)
  const result = (): Cell => (value === '' && emptyIsNull ? null : value)
  const done = useRef(false)
  const finish = (v: Cell | undefined, move?: Move): void => {
    if (done.current) return
    done.current = true
    onDone(v, move)
  }

  const badJson = kind === 'json' && value.trim() !== '' && !isValidJson(value)
  const array = kind === 'array' ? parsePgArray(value.trim() || '{}') : null
  const temporal = kind === 'date' || kind === 'datetime' || kind === 'time' ? kind : null
  const expandable = kind === 'json' || array !== null

  /** A panel's value, or the cell as it was when the panel only re-spaced or re-quoted it */
  const settle = (v: string): Cell => {
    if (v === value) return result()
    // A cleared JSON editor means NULL; '' isn't JSON
    if (kind === 'json' && v === '') return null
    if (
      kind === 'json' &&
      isValidJson(v) &&
      isValidJson(value) &&
      respaceJson(v, 0) === respaceJson(value, 0)
    )
      return result()
    if (kind === 'array' && array && v === formatPgArray(array)) return result()
    return v
  }

  const openExtra = (): void => {
    if (expandable) setPanel(true)
    else if (temporal) {
      try {
        pickerRef.current?.showPicker()
      } catch {
        // No picker in this webview; the text input still works
      }
    }
  }

  /** Commits unless focus went somewhere that's still part of this editor. */
  const onBlur = (e: React.FocusEvent): void => {
    const to = e.relatedTarget as Node | null
    if (to && (boxRef.current?.contains(to) || panelRef.current?.contains(to))) return
    // The window lost focus (a native picker, another app): keep editing
    if (!document.hasFocus()) return
    // Commit the field focus left: the panel's draft, or the inline input edited after it
    const fromPanel = panel && !!panelRef.current?.contains(e.target as Node)
    const next = fromPanel ? panelValue.current() : badJson ? undefined : value
    if (next === undefined) {
      // Enter and Apply refuse invalid JSON, so clicking away doesn't save it either
      toast('Invalid JSON was not saved', 'error')
      finish(undefined)
    } else finish(fromPanel ? settle(next) : result())
  }

  const closePanel = (): void => {
    // Focus moves back before the panel goes, so its blur isn't taken as leaving
    inputRef.current?.focus()
    setPanel(false)
  }

  const ExtraIcon =
    kind === 'json' ? Braces : kind === 'array' ? List : kind === 'time' ? Clock : CalendarDays
  const extraTitle =
    kind === 'json'
      ? 'Edit JSON (Alt+↓)'
      : kind === 'array'
        ? 'Edit elements (Alt+↓)'
        : 'Pick a value (Alt+↓)'

  return (
    <div ref={boxRef} className="relative z-10 shrink-0" style={{ width, ...style }}>
      <input
        ref={inputRef}
        autoFocus
        value={value}
        placeholder={emptyIsNull ? 'NULL' : 'empty string'}
        title={
          badJson
            ? 'Not valid JSON'
            : 'Backspace on an empty value switches between NULL and empty string'
        }
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={onBlur}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            // Invalid JSON stays open for fixing; Escape gives up
            if (badJson) return
            finish(result(), e.key === 'Enter' ? { r: 1, c: 0 } : { r: 0, c: e.shiftKey ? -1 : 1 })
          } else if (e.key === 'Escape') finish(undefined)
          else if (e.key === 'ArrowDown' && e.altKey && (expandable || temporal)) {
            e.preventDefault()
            openExtra()
          } else if ((e.key === 'Backspace' || e.key === 'Delete') && value === '') {
            e.preventDefault()
            setEmptyIsNull((n) => !n)
          }
        }}
        className={cn(
          'absolute inset-0 z-10 h-full w-full bg-raised px-2 font-mono text-[12px] text-bright outline outline-2 -outline-offset-2 outline-accent placeholder:text-faint placeholder:italic',
          (expandable || temporal) && 'pr-6',
          badJson && 'outline-danger'
        )}
      />
      {temporal && (
        <input
          ref={pickerRef}
          type={PICKER_TYPE[temporal]}
          step={1}
          tabIndex={-1}
          aria-hidden
          value={pickerValue(value, temporal)}
          onChange={(e) => {
            setValue(mergePicked(value, e.target.value, temporal))
            inputRef.current?.focus()
          }}
          className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
        />
      )}
      {(expandable || temporal) && (
        <button
          type="button"
          tabIndex={-1}
          title={extraTitle}
          // Keep focus in the input so it doesn't commit
          onMouseDown={(e) => e.preventDefault()}
          onClick={openExtra}
          className="absolute top-0 right-0 z-20 flex h-full w-6 items-center justify-center text-muted hover:text-bright"
        >
          <ExtraIcon className="size-3.5" />
        </button>
      )}
      {panel &&
        createPortal(
          <Popover
            anchor={boxRef.current}
            panelRef={panelRef}
            wide={kind === 'json'}
            onBlur={onBlur}
          >
            {kind === 'json' ? (
              <JsonPanel
                initial={value}
                valueRef={panelValue}
                onApply={(v) => finish(settle(v))}
                onCancel={closePanel}
              />
            ) : (
              <ArrayPanel
                initial={array ?? []}
                valueRef={panelValue}
                onApply={(items) => finish(settle(formatPgArray(items)))}
                onCancel={closePanel}
              />
            )}
          </Popover>,
          document.body
        )}
    </div>
  )
}

/** A panel under (or above) the cell, outside the grid so it isn't clipped. */
function Popover({
  anchor,
  panelRef,
  wide,
  onBlur,
  children
}: {
  anchor: HTMLElement | null
  panelRef: React.RefObject<HTMLDivElement | null>
  wide: boolean
  onBlur: (e: React.FocusEvent) => void
  children: React.ReactNode
}): React.JSX.Element {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const width = wide ? 520 : 340
  useLayoutEffect(() => {
    const cell = anchor?.getBoundingClientRect()
    const height = panelRef.current?.offsetHeight ?? 0
    if (!cell) return
    const below = cell.bottom + 2
    const top = below + height > window.innerHeight - 8 ? Math.max(8, cell.top - height - 2) : below
    const left = Math.max(8, Math.min(cell.left, window.innerWidth - width - 8))
    setPos({ left, top })
  }, [anchor, panelRef, width])
  return (
    <div
      ref={panelRef}
      className="fixed z-[60] flex animate-rise flex-col rounded-lg border border-line-strong bg-raised font-sans text-[12px] shadow-2xl shadow-(color:--shadow)"
      style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? 0 }}
      onBlur={onBlur}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        // Clicks on labels and buttons would move focus to nothing and commit
        if (!(e.target as HTMLElement).closest('input, .cm-editor')) e.preventDefault()
        e.stopPropagation()
      }}
    >
      {children}
    </div>
  )
}

function JsonPanel({
  initial,
  valueRef,
  onApply,
  onCancel
}: {
  initial: string
  valueRef: React.RefObject<() => string | undefined>
  onApply: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(() =>
    initial.trim() && isValidJson(initial) ? respaceJson(initial, 2) : initial
  )
  const error = jsonError(draft)
  valueRef.current = () => (error ? undefined : draft.trim() ? respaceJson(draft, 0) : '')
  const apply = (): void => {
    if (error) return
    onApply(draft.trim() ? respaceJson(draft, 0) : '')
  }
  return (
    <>
      <div className="h-72 overflow-hidden rounded-t-lg border-b border-line bg-canvas">
        <CodeEditor
          value={draft}
          onChange={setDraft}
          language={{ kind: 'json' }}
          autoFocus
          lineNumbers
          fontSize={12}
          className="h-full"
          keys={[
            { key: 'Mod-Enter', run: () => (apply(), true) },
            { key: 'Escape', run: () => (onCancel(), true) }
          ]}
        />
      </div>
      <div className="flex items-center gap-1.5 p-1.5">
        <span
          className={cn('min-w-0 flex-1 truncate px-1', error ? 'text-danger' : 'text-faint')}
          title={error ?? undefined}
        >
          {error ?? 'Ctrl+Enter to apply'}
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={!!error || !draft.trim()}
          onClick={() => setDraft(respaceJson(draft, 2))}
        >
          Format
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="primary" disabled={!!error} onClick={apply}>
          Apply
        </Button>
      </div>
    </>
  )
}

function jsonError(text: string): string | null {
  if (!text.trim()) return null
  try {
    JSON.parse(text)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Not valid JSON'
  }
}

function ArrayPanel({
  initial,
  valueRef,
  onApply,
  onCancel
}: {
  initial: ArrayItem[]
  valueRef: React.RefObject<() => string | undefined>
  onApply: (items: ArrayItem[]) => void
  onCancel: () => void
}): React.JSX.Element {
  const [items, setItems] = useState<ArrayItem[]>(initial)
  valueRef.current = () => formatPgArray(items)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const [focusAt, setFocusAt] = useState<number | null>(0)

  useLayoutEffect(() => {
    if (focusAt === null) return
    // An empty array has no input yet, so the panel itself holds focus
    ;(inputs.current[focusAt] ?? rootRef.current)?.focus()
    setFocusAt(null)
  }, [focusAt])

  const set = (i: number, v: ArrayItem): void =>
    setItems((xs) => xs.map((x, j) => (j === i ? v : x)))
  const insert = (at: number): void => {
    setItems((xs) => [...xs.slice(0, at), '', ...xs.slice(at)])
    setFocusAt(at)
  }
  const remove = (i: number): void => {
    const next = Math.max(0, i - 1)
    // Move focus off the input before it unmounts, so its blur isn't taken as leaving
    ;((next !== i ? inputs.current[next] : null) ?? rootRef.current)?.focus()
    setItems((xs) => xs.filter((_, j) => j !== i))
    setFocusAt(next)
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="outline-none"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        } else if (e.key === 'Enter' && isMod(e)) {
          e.preventDefault()
          onApply(items)
        }
      }}
    >
      <div className="max-h-64 overflow-auto p-1.5">
        {items.length === 0 && <div className="px-1 py-2 text-faint">Empty array</div>}
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-1 py-0.5">
            <span className="w-6 shrink-0 text-right text-[10.5px] text-faint tabular-nums">
              {i + 1}
            </span>
            <input
              ref={(el) => {
                inputs.current[i] = el
              }}
              value={item ?? ''}
              placeholder={item === null ? 'NULL' : 'empty string'}
              onChange={(e) => set(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isMod(e)) {
                  e.preventDefault()
                  if (i === items.length - 1) insert(i + 1)
                  else setFocusAt(i + 1)
                } else if (e.key === 'Backspace' && !item) {
                  // Empty → NULL → removed
                  e.preventDefault()
                  if (item === '') set(i, null)
                  else remove(i)
                } else if (e.key === 'ArrowDown' && i < items.length - 1) {
                  e.preventDefault()
                  setFocusAt(i + 1)
                } else if (e.key === 'ArrowUp' && i > 0) {
                  e.preventDefault()
                  setFocusAt(i - 1)
                }
              }}
              className="h-6 min-w-0 flex-1 rounded border border-line-strong bg-canvas px-1.5 font-mono text-[12px] text-bright placeholder:text-faint placeholder:italic focus:border-accent/60 focus:outline-none"
            />
            <button
              type="button"
              tabIndex={-1}
              title="Set NULL"
              disabled={item === null}
              onClick={() => set(i, null)}
              className="flex size-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-bright disabled:opacity-30"
            >
              <Ban className="size-3" />
            </button>
            <button
              type="button"
              tabIndex={-1}
              title="Remove"
              onClick={() => remove(i)}
              className="flex size-6 items-center justify-center rounded text-faint hover:bg-hover hover:text-danger"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5 border-t border-line p-1.5">
        <Button size="xs" variant="ghost" onClick={() => insert(items.length)}>
          <Plus className="size-3" /> Add
        </Button>
        <span className="min-w-0 flex-1 truncate text-faint">Ctrl+Enter to apply</span>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" variant="primary" onClick={() => onApply(items)}>
          Apply
        </Button>
      </div>
    </div>
  )
}
