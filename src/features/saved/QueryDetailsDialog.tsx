import { useState } from 'react'
import { connectionLabel } from '@/lib/engines'
import {
  allFolders,
  allTags,
  findByName,
  parseTags,
  queryKindOf,
  savedQueriesStore,
  updateSavedQuery,
  type SavedQuery
} from '@/lib/saved'
import { connectionsStore } from '@/lib/workspace'
import { Button, Field, Input, Modal, Select } from '@/components/ui'

/** Name, folder, tags and the connection a saved query is tied to. */
export function QueryDetailsDialog({
  query,
  onClose
}: {
  query: SavedQuery
  onClose: () => void
}): React.JSX.Element {
  const saved = savedQueriesStore.use()
  const connections = connectionsStore.use().filter((c) => queryKindOf(c.engine) === query.kind)
  const [name, setName] = useState(query.name)
  const [folder, setFolder] = useState(query.folder ?? '')
  const [tags, setTags] = useState((query.tags ?? []).join(', '))
  const [connectionId, setConnectionId] = useState(query.connectionId ?? '')
  const [database, setDatabase] = useState(query.database ?? '')
  const clash = findByName(saved, name, query.kind)
  const nameError = !name.trim()
    ? 'Give the query a name'
    : clash && clash.id !== query.id
      ? `“${clash.name}” already exists`
      : null

  const save = (): void => {
    if (nameError) return
    const cleanFolder = folder
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('/')
    updateSavedQuery(query.id, {
      name: name.trim(),
      folder: cleanFolder || undefined,
      tags: parseTags(tags),
      connectionId: connectionId || null,
      database: connectionId && database.trim() ? database.trim() : null
    })
    onClose()
  }

  return (
    <Modal
      title="Saved query details"
      onClose={onClose}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!!nameError} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <Field
          label="Name"
          hint={name.trim() && nameError && <span className="text-danger">{nameError}</span>}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Folder" hint="Nest folders with a slash: Reports/Daily">
          <Input
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            list="saved-folders"
            placeholder="No folder"
          />
          <datalist id="saved-folders">
            {allFolders(saved).map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>
        <Field
          label="Tags"
          hint={`Separate with commas or spaces; search with #tag${
            allTags(saved).length ? ` · in use: ${allTags(saved).slice(0, 8).join(', ')}` : ''
          }`}
        >
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="billing, daily"
          />
        </Field>
        <Field
          label="Connection"
          hint="A tied query runs there by default and is listed when that connection is in use"
        >
          <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            <option value="">Any connection</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {connectionLabel(c)}
              </option>
            ))}
          </Select>
        </Field>
        {connectionId && (
          <Field label="Database" hint="Leave empty for the connection's default">
            <Input value={database} onChange={(e) => setDatabase(e.target.value)} />
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
