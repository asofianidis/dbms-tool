import { useEffect, useState } from 'react'
import { ClipboardCopy, Trash2 } from 'lucide-react'
import { copyText } from '@/lib/export'
import { settingsStore } from '@/lib/settings'
import {
  applyCurrentTheme,
  applyTheme,
  BUILTIN_THEMES,
  customThemesStore,
  exportTheme,
  TOKENS,
  type Theme,
  type ThemeBase
} from '@/lib/themes'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/workspace'
import { Button, Field, Input, Modal, Segmented } from '@/components/ui'

const GROUPS = [...new Set(TOKENS.map((t) => t.group))]

function ColorField({
  label,
  hint,
  value,
  onChange
}: {
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <label
      className="flex items-center gap-2.5 rounded-md px-1.5 py-1 hover:bg-hover/60"
      title={hint}
    >
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="size-7 shrink-0 cursor-pointer rounded-md border border-line-strong bg-transparent p-0.5"
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{label}</span>
      <input
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value.toLowerCase())
        }}
        spellCheck={false}
        className="h-7 w-[5.5rem] rounded-md border border-line-strong bg-canvas px-2 font-mono text-[11.5px] text-bright focus:border-accent/50 focus:outline-none"
      />
    </label>
  )
}

/**
 * Edits a custom theme with live preview: changes apply to the whole app while
 * the dialog is open and are reverted on cancel.
 */
export function ThemeEditor({
  theme,
  isNew,
  onClose
}: {
  theme: Theme
  isNew: boolean
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<Theme>(theme)

  // The preview ignores the accent override so the theme's own accent is visible
  useEffect(() => applyTheme(draft, ''), [draft])
  useEffect(() => () => applyCurrentTheme(), [])

  const setColor = (key: keyof Theme['colors'], value: string): void =>
    setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: value } }))

  const setBase = (base: ThemeBase): void => {
    // Switching base starts from that base's palette, keeping the accent
    const palette = BUILTIN_THEMES.find((t) => t.base === base)!.colors
    setDraft((d) =>
      d.base === base ? d : { ...d, base, colors: { ...palette, accent: d.colors.accent } }
    )
  }

  const save = (): void => {
    const saved = { ...draft, name: draft.name.trim() || 'Untitled theme', builtin: undefined }
    customThemesStore.set((list) =>
      list.some((t) => t.id === saved.id)
        ? list.map((t) => (t.id === saved.id ? saved : t))
        : [...list, saved]
    )
    // Show the theme just saved
    settingsStore.set((s) => ({
      ...s,
      themeMode: saved.base,
      ...(saved.base === 'dark' ? { darkTheme: saved.id } : { lightTheme: saved.id })
    }))
    toast(`Saved ${saved.name}`)
    onClose()
  }

  const remove = async (): Promise<void> => {
    if (
      !(await confirm({
        title: `Delete ${draft.name}?`,
        message: 'The theme is removed from this machine.',
        confirmLabel: 'Delete',
        danger: true
      }))
    )
      return
    customThemesStore.set((list) => list.filter((t) => t.id !== draft.id))
    settingsStore.set((s) => ({
      ...s,
      darkTheme: s.darkTheme === draft.id ? 'graphite' : s.darkTheme,
      lightTheme: s.lightTheme === draft.id ? 'paper' : s.lightTheme
    }))
    onClose()
  }

  return (
    <Modal
      width="lg"
      title={isNew ? 'New theme' : `Edit ${theme.name}`}
      description="Changes preview across the app while this dialog is open."
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <Button variant="danger" size="sm" onClick={() => void remove()} className="mr-auto">
              <Trash2 className="size-3.5" /> Delete
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void copyText(exportTheme(draft), 'Copied theme JSON')}
          >
            <ClipboardCopy className="size-3.5" /> Copy JSON
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save theme
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Field label="Name">
            <Input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </Field>
          <Field label="Base">
            <Segmented
              value={draft.base}
              onChange={setBase}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' }
              ]}
            />
          </Field>
        </div>
        {GROUPS.map((group) => (
          <section key={group}>
            <h3 className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
              {group}
            </h3>
            <div className="grid grid-cols-2 gap-x-3">
              {TOKENS.filter((t) => t.group === group).map((t) => (
                <ColorField
                  key={t.key}
                  label={t.label}
                  hint={'hint' in t ? t.hint : undefined}
                  value={draft.colors[t.key]}
                  onChange={(v) => setColor(t.key, v)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  )
}
