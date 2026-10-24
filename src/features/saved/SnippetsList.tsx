import { useMemo, useState } from 'react'
import { ClipboardCopy, EyeOff, Pencil, Plus, RotateCcw, Scissors, Trash2 } from 'lucide-react'
import { copyText } from '@/lib/export'
import {
  allSnippets,
  BUILTIN_SNIPPETS,
  deleteSnippet,
  newSnippet,
  resetSnippet,
  saveSnippet,
  snippetFields,
  snippetsStore,
  type Snippet
} from '@/lib/snippets'
import { showContextMenu } from '@/components/ContextMenu'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { Badge, Button, Field, Input, Modal } from '@/components/ui'

/** Snippets in the sidebar: type a prefix in a SQL editor to insert one. */
export function SnippetsList({ filter }: { filter: string }): React.JSX.Element {
  const saved = snippetsStore.use()
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const list = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return allSnippets(saved, showHidden).filter(
      (s) =>
        !q ||
        s.prefix.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.body.toLowerCase().includes(q)
    )
  }, [saved, filter, showHidden])
  const hiddenCount = allSnippets(saved, true).length - allSnippets(saved).length

  return (
    <>
      <div className="flex items-center gap-1 px-2 pb-2">
        <Button size="xs" variant="secondary" onClick={() => setEditing(newSnippet())}>
          <Plus className="size-3" /> New snippet
        </Button>
        <div className="flex-1" />
        {hiddenCount > 0 && (
          <Button size="xs" variant="ghost" onClick={() => setShowHidden((s) => !s)}>
            {showHidden ? 'Hide removed' : `${hiddenCount} removed`}
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.map((s) => {
          const builtin = BUILTIN_SNIPPETS.find((b) => b.id === s.id)
          const changed = builtin && saved.some((x) => x.id === s.id)
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setEditing(s)}
              onContextMenu={(e) =>
                showContextMenu(e, [
                  { label: 'Edit…', icon: <Pencil />, onSelect: () => setEditing(s) },
                  {
                    label: 'Copy body',
                    icon: <ClipboardCopy />,
                    onSelect: () => void copyText(s.body, 'Copied snippet')
                  },
                  'separator',
                  ...(changed
                    ? [
                        {
                          label: s.hidden ? 'Restore' : 'Reset to built-in',
                          icon: <RotateCcw />,
                          onSelect: () => resetSnippet(s.id)
                        }
                      ]
                    : []),
                  ...(!s.hidden
                    ? [
                        {
                          label: s.builtin ? 'Remove from completions' : 'Delete',
                          icon: s.builtin ? <EyeOff /> : <Trash2 />,
                          danger: !s.builtin,
                          onSelect: () => deleteSnippet(s)
                        }
                      ]
                    : [])
                ])
              }
              className="block w-full border-b border-line/60 px-3 py-2 text-left hover:bg-hover/60"
            >
              <div className="flex items-center gap-1.5 text-[12px]">
                <Scissors className="size-3 shrink-0 text-muted" />
                <span className="font-mono font-medium text-bright">{s.prefix}</span>
                <span className="truncate text-muted">{s.description}</span>
                {s.builtin && <Badge className="ml-auto">built-in</Badge>}
                {s.hidden && <Badge tone="warning">removed</Badge>}
              </div>
              <pre className="mt-1 line-clamp-2 font-mono text-[11.5px] leading-snug whitespace-pre-wrap text-muted">
                {s.body}
              </pre>
            </button>
          )
        })}
        {!list.length && <p className="px-4 py-6 text-center text-xs text-faint">No matches</p>}
        <p className="px-4 py-3 text-[11px] leading-snug text-faint">
          Type a snippet's prefix in a SQL editor and pick it from the suggestions. Tab moves
          between its <span className="font-mono">{'${placeholders}'}</span>.
        </p>
      </div>
      {editing && <SnippetDialog snippet={editing} onClose={() => setEditing(null)} />}
    </>
  )
}

function SnippetDialog({
  snippet,
  onClose
}: {
  snippet: Snippet
  onClose: () => void
}): React.JSX.Element {
  const others = allSnippets(snippetsStore.get(), true).filter((s) => s.id !== snippet.id)
  const [prefix, setPrefix] = useState(snippet.prefix)
  const [description, setDescription] = useState(snippet.description)
  const [body, setBody] = useState(snippet.body)
  const clash = others.find((s) => !s.hidden && s.prefix === prefix.trim())
  const error = !prefix.trim()
    ? 'Give it a prefix'
    : /\s/.test(prefix.trim())
      ? 'Prefixes are one word'
      : clash
        ? `“${clash.prefix}” is taken by another snippet`
        : !body.trim()
          ? 'Write the snippet'
          : null
  const fields = snippetFields(body)

  return (
    <Modal
      width="lg"
      title={snippet.prefix ? `Snippet “${snippet.prefix}”` : 'New snippet'}
      description="Placeholders like ${table} become fields that Tab moves through; ${} marks where the cursor ends."
      onClose={onClose}
      footer={
        <>
          {error && prefix && <span className="mr-auto text-xs text-danger">{error}</span>}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!!error}
            onClick={() => {
              saveSnippet({
                ...snippet,
                prefix: prefix.trim(),
                description: description.trim(),
                body,
                hidden: false
              })
              onClose()
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-3">
          <Field label="Prefix" className="w-36">
            <Input
              mono
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              placeholder="selw"
            />
          </Field>
          <Field label="Description" className="flex-1">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Shown next to the prefix"
            />
          </Field>
        </div>
        <Field
          label="Body"
          hint={fields.length ? `Fields: ${fields.join(', ')}` : 'No placeholders yet'}
        >
          <div className="h-48 overflow-hidden rounded-md border border-line-strong bg-canvas">
            <CodeEditor
              value={body}
              onChange={setBody}
              language={{ kind: 'sql', dialect: 'postgres' }}
              className="h-full"
              fontSize={12.5}
            />
          </div>
        </Field>
      </div>
    </Modal>
  )
}
