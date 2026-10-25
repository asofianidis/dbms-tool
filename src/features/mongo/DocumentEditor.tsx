import { useMemo, useState } from 'react'
import type { KeyBinding } from '@codemirror/view'
import { api } from '@/lib/api'
import { parseShellValue, sameEjson, toShell } from '@/lib/ejson'
import { MOD } from '@/lib/keys'
import { errorMessage, toast } from '@/lib/toast'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { Button, Modal } from '@/components/ui'

export interface DocumentEditorRequest {
  mode: 'edit' | 'insert'
  connectionId: string
  database: string
  collection: string
  /** Document being edited, or the template for an insert */
  document?: Record<string, unknown>
}

/** Edits one document in shell syntax and saves it with replaceOne / insertOne. */
export function DocumentEditor({
  request,
  onClose,
  onSaved
}: {
  request: DocumentEditorRequest
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const initial = useMemo(() => {
    if (request.document) {
      if (request.mode === 'insert') {
        // Cloning: drop the _id so the server assigns a new one
        const { _id, ...rest } = request.document
        void _id
        return toShell(rest)
      }
      return toShell(request.document)
    }
    return '{\n  \n}'
  }, [request])
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    let doc: unknown
    try {
      doc = parseShellValue(text)
    } catch (e) {
      setError(errorMessage(e))
      return
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      setError('A document must be an object: { … }')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (request.mode === 'edit') {
        const id = request.document?._id
        if (id === undefined)
          throw new Error('The original document has no _id, so it can’t be replaced safely')
        const next = doc as Record<string, unknown>
        if (!sameEjson(next._id, id))
          throw new Error('_id can’t be changed. Clone the document instead.')
        const out = await api.mongo(request.connectionId, '__meta', {
          op: 'replaceOne',
          database: request.database,
          collection: request.collection,
          filter: { _id: id },
          replacement: next
        })
        const matched = (out.value as { matchedCount?: number } | null)?.matchedCount
        if (matched === 0) throw new Error('No document matched; it may have been deleted')
        toast('Document saved')
      } else {
        await api.mongo(request.connectionId, '__meta', {
          op: 'insertOne',
          database: request.database,
          collection: request.collection,
          document: doc
        })
        toast('Document inserted')
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }

  const keys = useMemo<KeyBinding[]>(
    () => [
      { key: 'Mod-s', run: () => (void save(), true) },
      { key: 'Mod-Enter', run: () => (void save(), true) }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text]
  )

  return (
    <Modal
      width="xl"
      title={request.mode === 'edit' ? 'Edit document' : 'Insert document'}
      description={
        <span>
          {request.database}.{request.collection} · shell syntax:{' '}
          <span className="font-mono">ObjectId()</span>,{' '}
          <span className="font-mono">ISODate()</span>,{' '}
          <span className="font-mono">NumberLong()</span> keep their BSON types
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {error && (
            <p className="mr-auto max-w-[60%] truncate text-xs text-danger" title={error}>
              {error}
            </p>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving} title={`${MOD}S`}>
            {request.mode === 'edit' ? 'Replace document' : 'Insert'}
          </Button>
        </>
      }
    >
      <div className="h-[55vh] overflow-hidden rounded-lg border border-line bg-canvas">
        <CodeEditor
          value={text}
          onChange={setText}
          language={{ kind: 'mongo' }}
          keys={keys}
          className="h-full"
          fontSize={12.5}
          autoFocus
        />
      </div>
    </Modal>
  )
}
