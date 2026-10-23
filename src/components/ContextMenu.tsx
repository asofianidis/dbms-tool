import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'
import { createStore } from '@/lib/store'

export type MenuItem =
  | {
      label: string
      icon?: ReactNode
      shortcut?: string
      onSelect?: () => void
      danger?: boolean
      disabled?: boolean
      submenu?: MenuItem[]
    }
  | 'separator'
  | { heading: string }

const menuStore = createStore<{ x: number; y: number; items: MenuItem[] } | null>(null)

export function showContextMenu(
  event: {
    clientX: number
    clientY: number
    preventDefault?: () => void
    stopPropagation?: () => void
  },
  items: MenuItem[]
): void {
  event.preventDefault?.()
  event.stopPropagation?.()
  menuStore.set({ x: event.clientX, y: event.clientY, items })
}

/** Opens a menu below an element, e.g. a toolbar dropdown button. */
export function showMenuAt(element: HTMLElement, items: MenuItem[]): void {
  const rect = element.getBoundingClientRect()
  menuStore.set({ x: rect.left, y: rect.bottom + 4, items })
}

export function closeContextMenu(): void {
  menuStore.set(null)
}

function MenuList({
  items,
  x,
  y,
  onDone
}: {
  items: MenuItem[]
  x: number
  y: number
  onDone: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [open, setOpen] = useState<number | null>(null)
  const [active, setActive] = useState(-1)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, y + height > window.innerHeight - 4 ? window.innerHeight - height - 4 : y)
    })
  }, [x, y])

  const selectable = items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => typeof item === 'object' && 'label' in item && !item.disabled)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const idx = selectable.findIndex((s) => s.i === active)
        const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1
        setActive(selectable[(next + selectable.length) % selectable.length]?.i ?? -1)
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault()
        const item = items[active]
        if (typeof item === 'object' && 'label' in item && item.onSelect) {
          onDone()
          item.onSelect()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div
      ref={ref}
      style={pos}
      className="fixed z-[70] min-w-48 animate-rise rounded-lg border border-line-strong bg-raised p-1 shadow-2xl shadow-(color:--shadow)"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item === 'separator') return <div key={i} className="my-1 h-px bg-line-strong" />
        if ('heading' in item) {
          return (
            <div
              key={i}
              className="truncate px-2.5 pt-1.5 pb-1 text-[10.5px] font-medium tracking-wide text-faint uppercase"
            >
              {item.heading}
            </div>
          )
        }
        return (
          <div
            key={i}
            className="relative"
            onMouseEnter={() => (setOpen(item.submenu ? i : null), setActive(i))}
          >
            <button
              type="button"
              disabled={item.disabled}
              onClick={() => {
                if (item.submenu) return setOpen(i)
                onDone()
                item.onSelect?.()
              }}
              className={cn(
                'flex h-7 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] disabled:opacity-40',
                item.danger ? 'text-danger' : 'text-fg',
                active === i && (item.danger ? 'bg-danger/10' : 'bg-hover text-bright')
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center text-muted [&>svg]:size-3.5">
                {item.icon}
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.shortcut && (
                <span className="pl-4 text-[11px] text-faint">{item.shortcut}</span>
              )}
              {item.submenu && <ChevronRight className="size-3.5 text-faint" />}
            </button>
            {item.submenu && open === i && (
              <SubMenu items={item.submenu} anchor={ref} index={i} onDone={onDone} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function SubMenu({
  items,
  anchor,
  index,
  onDone
}: {
  items: MenuItem[]
  anchor: React.RefObject<HTMLDivElement | null>
  index: number
  onDone: () => void
}): React.JSX.Element | null {
  const rect = anchor.current?.getBoundingClientRect()
  const row = anchor.current?.children[index]?.getBoundingClientRect()
  if (!rect || !row) return null
  return <MenuList items={items} x={rect.right - 2} y={row.top - 4} onDone={onDone} />
}

export function ContextMenuHost(): React.JSX.Element | null {
  const menu = menuStore.use()
  useEffect(() => {
    if (!menu) return
    const close = (): void => closeContextMenu()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])
  if (!menu) return null
  return (
    <MenuList
      key={`${menu.x},${menu.y}`}
      items={menu.items}
      x={menu.x}
      y={menu.y}
      onDone={closeContextMenu}
    />
  )
}
