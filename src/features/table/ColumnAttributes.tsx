import { EyeOff, FileArchive } from 'lucide-react'
import { cn } from '@/lib/cn'
import { isCompressible, type ColumnFeatures } from '@/lib/column-types'
import type { ColumnDraft } from '@/lib/ddl'

/** Whether the designer shows the attributes cell for this server. */
export const hasColumnAttributes = (features: ColumnFeatures): boolean =>
  features.invisible || features.compressed

/** Table designer cell with the INVISIBLE and COMPRESSED toggles of one column. */
export function ColumnAttributes({
  column: c,
  features,
  disabled,
  onChange
}: {
  column: ColumnDraft
  features: ColumnFeatures
  disabled: boolean
  onChange: (change: Partial<ColumnDraft>) => void
}): React.JSX.Element {
  const compressible = isCompressible(c.dataType)
  return (
    <span className="flex justify-center gap-0.5">
      {(features.invisible || c.invisible) && (
        <Toggle
          on={c.invisible}
          disabled={disabled}
          title={
            c.invisible
              ? 'Invisible: SELECT * leaves it out; name it to read or write it'
              : 'Make invisible (SELECT * leaves it out)'
          }
          onClick={() => onChange({ invisible: !c.invisible })}
        >
          <EyeOff className="size-3.5" />
        </Toggle>
      )}
      {(features.compressed || c.compressed) && (
        <Toggle
          on={c.compressed}
          // Leave it switchable off when the type changed to one that can't be compressed
          disabled={disabled || (!compressible && !c.compressed)}
          title={
            compressible || c.compressed
              ? c.compressed
                ? 'Compressed: MariaDB stores the value zlib-compressed'
                : 'Compress the column (MariaDB)'
              : 'Only BLOB, TEXT, VARCHAR and VARBINARY columns can be compressed'
          }
          onClick={() => onChange({ compressed: !c.compressed })}
        >
          <FileArchive className="size-3.5" />
        </Toggle>
      )}
    </span>
  )
}

function Toggle({
  on,
  disabled,
  title,
  onClick,
  children
}: {
  on: boolean
  disabled: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-6 items-center justify-center rounded-md transition-colors disabled:opacity-40',
        on ? 'bg-accent/15 text-accent' : 'text-faint enabled:hover:text-bright'
      )}
    >
      {children}
    </button>
  )
}
