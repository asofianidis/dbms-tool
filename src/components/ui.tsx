import { forwardRef, useEffect, useRef, type ComponentProps, type ReactNode } from 'react'
import { CheckCircle2, ChevronDown, Info, Loader2, X, XCircle } from 'lucide-react'
import type { Engine } from '@/lib/api'
import { cn } from '@/lib/cn'
import { ENGINES } from '@/lib/engines'
import { dismissToast, useToasts } from '@/lib/toast'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-accent font-medium text-accent-fg hover:bg-accent-hover',
  secondary: 'bg-raised text-bright ring-1 ring-line-strong ring-inset hover:bg-hover',
  ghost: 'text-muted hover:bg-hover hover:text-bright',
  subtle: 'text-fg hover:bg-hover hover:text-bright',
  danger: 'bg-danger/10 text-danger ring-1 ring-danger/30 ring-inset hover:bg-danger/20'
}

export const Button = forwardRef<
  HTMLButtonElement,
  ComponentProps<'button'> & {
    variant?: ButtonVariant
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm'
  }
>(function Button({ variant = 'secondary', size = 'md', className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40',
        size === 'xs' && 'h-6 px-2 text-[11px]',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-8 px-3 text-[13px]',
        size === 'lg' && 'h-10 px-4 text-sm',
        size === 'icon' && 'size-7',
        size === 'icon-sm' && 'size-6',
        buttonVariants[variant],
        className
      )}
      {...props}
    />
  )
})

const inputBase =
  'rounded-md border border-line-strong bg-canvas px-2.5 text-[13px] text-bright transition-colors placeholder:text-faint focus:border-accent/60 focus:ring-3 focus:ring-accent/10 focus:outline-none disabled:opacity-50'

export const Input = forwardRef<HTMLInputElement, ComponentProps<'input'> & { mono?: boolean }>(
  function Input({ className, mono, ...props }, ref) {
    const fullWidth = !/(^|\s)w-/.test(className ?? '')
    return (
      <input
        ref={ref}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          inputBase,
          'h-8',
          fullWidth && 'w-full',
          mono && 'font-mono text-xs',
          className
        )}
        {...props}
      />
    )
  }
)

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  ComponentProps<'textarea'> & { mono?: boolean }
>(function Textarea({ className, mono, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      spellCheck={false}
      className={cn(inputBase, 'min-h-20 w-full py-2', mono && 'font-mono text-xs', className)}
      {...props}
    />
  )
})

export function Select({
  className,
  selectClassName,
  ...props
}: ComponentProps<'select'> & { selectClassName?: string }): React.JSX.Element {
  return (
    <div className={cn('relative', className)}>
      <select
        className={cn(inputBase, 'h-8 w-full appearance-none pr-8', selectClassName)}
        {...props}
      />
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted" />
    </div>
  )
}

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-[11px] leading-snug text-faint">{hint}</span>}
    </label>
  )
}

export function Switch({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative mt-px inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        checked ? 'bg-accent' : 'bg-line-strong'
      )}
    >
      <span
        className={cn(
          'size-3.5 rounded-full shadow-sm transition-transform',
          checked ? 'translate-x-4 bg-accent-fg' : 'translate-x-0.5 bg-muted'
        )}
      />
    </button>
  )
}

/** Toggle switch with a label and description. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  title
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  /** Tooltip with more detail than the description */
  title?: string
}): React.JSX.Element {
  return (
    <label
      title={title}
      className={cn(
        'flex cursor-default items-start gap-3',
        disabled && 'pointer-events-none opacity-40'
      )}
    >
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
      <span>
        <span className="block text-bright">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
    </label>
  )
}

/** Pill-shaped segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = 'md'
}: {
  value: T
  options: { value: T; label: ReactNode; title?: string; count?: number }[]
  onChange: (value: T) => void
  className?: string
  size?: 'sm' | 'md'
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md bg-canvas p-0.5 ring-1 ring-line-strong ring-inset',
        className
      )}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          onClick={() => onChange(option.value)}
          className={cn(
            'flex items-center gap-1.5 rounded-[5px] px-2.5 transition-colors',
            size === 'sm' ? 'h-5 text-[11px]' : 'h-6 text-xs',
            value === option.value ? 'bg-sel text-bright shadow-sm' : 'text-muted hover:text-bright'
          )}
        >
          {option.label}
          {option.count !== undefined && (
            <span
              className={cn('tabular-nums', value === option.value ? 'text-muted' : 'text-faint')}
            >
              {option.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

export function Badge({
  tone = 'neutral',
  children,
  className,
  title
}: {
  tone?: 'neutral' | 'warning' | 'danger' | 'success' | 'info' | 'accent'
  children: ReactNode
  className?: string
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 text-[11px] leading-5 font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-hover text-muted',
        tone === 'warning' && 'bg-warn/10 text-warn',
        tone === 'danger' && 'bg-danger/10 text-danger',
        tone === 'success' && 'bg-ok/10 text-ok',
        tone === 'info' && 'bg-info/10 text-info',
        tone === 'accent' && 'bg-accent/10 text-accent',
        className
      )}
    >
      {children}
    </span>
  )
}

export function Kbd({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-canvas px-1 font-sans text-[10px] text-muted',
        className
      )}
    >
      {children}
    </kbd>
  )
}

/** Engine mark: a two-letter tile in the engine's colour, like a file-type badge. */
export function EngineMark({
  engine,
  size = 'md',
  className
}: {
  engine: Engine
  size?: 'sm' | 'md' | 'lg'
  className?: string
}): React.JSX.Element {
  const info = ENGINES[engine]
  return (
    <span
      title={info.label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-mono font-semibold tracking-tight',
        info.tone,
        size === 'sm' && 'h-4 w-5 rounded-[3px] text-[8.5px]',
        size === 'md' && 'h-5 w-6 rounded text-[9.5px]',
        size === 'lg' && 'size-10 rounded-lg text-sm',
        className
      )}
    >
      {info.mark}
    </span>
  )
}

/** App mark: stacked cylinders on an accent tile. */
export function LogoMark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }): React.JSX.Element {
  const px =
    size === 'sm'
      ? 'size-5 rounded-[5px]'
      : size === 'md'
        ? 'size-6 rounded-md'
        : 'size-14 rounded-2xl'
  const icon = size === 'lg' ? 30 : size === 'md' ? 14 : 12
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center bg-accent text-accent-fg shadow-[0_0_24px_-6px] shadow-accent/60',
        px
      )}
    >
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
      >
        <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
        <path d="M4.5 5.5v6.5c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V5.5" />
        <path d="M4.5 12v6.5c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V12" />
      </svg>
    </span>
  )
}

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return <Loader2 className={cn('size-3.5 animate-spin text-muted', className)} />
}

/** Thin indeterminate bar for in-flight work. */
export function ProgressBar({ active }: { active: boolean }): React.JSX.Element {
  return (
    <div
      className={cn(
        'relative h-px w-full overflow-hidden',
        active ? 'bg-accent/15' : 'bg-transparent'
      )}
    >
      {active && <div className="absolute inset-y-0 w-2/5 animate-indeterminate bg-accent" />}
    </div>
  )
}

export function Eyebrow({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center justify-between text-[11px] font-medium tracking-wide text-faint uppercase',
        className
      )}
    >
      {children}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
  className
}: {
  icon?: ReactNode
  title: ReactNode
  children?: ReactNode
  actions?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-3 bg-dots p-8 text-center',
        className
      )}
    >
      {icon && <div className="text-faint">{icon}</div>}
      <div className="space-y-1">
        <p className="font-medium text-bright">{title}</p>
        {children && <div className="max-w-sm text-xs text-muted">{children}</div>}
      </div>
      {actions && <div className="mt-1 flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function ErrorText({ error }: { error: unknown }): React.JSX.Element | null {
  if (!error) return null
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error && 'message' in error
        ? String(error.message)
        : String(error)
  return <p className="text-xs whitespace-pre-wrap text-danger select-text">{message}</p>
}

export function Toaster(): React.JSX.Element {
  const toasts = useToasts()
  return (
    <div className="pointer-events-none fixed right-4 bottom-9 z-[60] flex w-96 flex-col gap-2">
      {toasts.map((t) => {
        const Icon = t.tone === 'error' ? XCircle : t.tone === 'success' ? CheckCircle2 : Info
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex animate-rise items-start gap-2.5 rounded-lg border border-line-strong bg-raised px-3.5 py-3 text-[13px] shadow-2xl shadow-(color:--shadow)"
          >
            <Icon
              className={cn(
                'mt-px size-4 shrink-0',
                t.tone === 'error' && 'text-danger',
                t.tone === 'success' && 'text-accent',
                t.tone === 'info' && 'text-info'
              )}
            />
            <span className="flex-1 break-words whitespace-pre-wrap text-bright select-text">
              {t.message}
            </span>
            <button onClick={() => dismissToast(t.id)} className="text-muted hover:text-bright">
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  width = 'md',
  icon
}: {
  title: ReactNode
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'
  icon?: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Callers pass inline callbacks; a ref keeps the effect (and the initial focus) to mount only
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKey, true)
    // Focus the first field so dialogs are keyboard-first
    const first = ref.current?.querySelector<HTMLElement>(
      'input, textarea, select, [data-autofocus]'
    )
    first?.focus({ preventScroll: true })
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-(--backdrop) px-4 pt-[10vh] pb-8 backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        role="dialog"
        className={cn(
          'flex max-h-[80vh] w-full animate-rise flex-col rounded-xl border border-line-strong bg-panel shadow-2xl shadow-(color:--shadow)',
          width === 'sm' && 'max-w-sm',
          width === 'md' && 'max-w-lg',
          width === 'lg' && 'max-w-2xl',
          width === 'xl' && 'max-w-4xl',
          width === '2xl' && 'max-w-6xl'
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-4">
          <div className="flex min-w-0 items-start gap-3">
            {icon}
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-bright">{title}</h2>
              {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={onClose}
            aria-label="Close"
            className="-mt-0.5 -mr-1.5"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

/** Toolbar row used at the top of tabs. */
export function Toolbar({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex h-10 shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2',
        className
      )}
    >
      {children}
    </div>
  )
}

export function ToolbarDivider(): React.JSX.Element {
  return <div className="mx-1 h-4 w-px bg-line-strong" />
}
