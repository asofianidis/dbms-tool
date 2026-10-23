import { useMemo, useState } from 'react'
import { Trash2, TriangleAlert } from 'lucide-react'
import type { ConnectionConfig } from '@/lib/api'
import {
  PROVIDERS,
  canSnapshot,
  deleteLeftovers,
  deletePlan,
  stepsScript,
  type CloudDatabase
} from '@/lib/cloud'
import { Button, Field, Input, Modal, Toggle } from '@/components/ui'
import { startDeletion } from './actions'

export function DeleteDialog({
  db,
  saved,
  onClose
}: {
  db: CloudDatabase
  saved?: ConnectionConfig
  onClose: () => void
}): React.JSX.Element {
  const info = PROVIDERS[db.ref.provider]
  const [finalSnapshot, setFinalSnapshot] = useState(canSnapshot(db))
  const [disableProtection, setDisableProtection] = useState(db.deletionProtection)
  const [removeConnection, setRemoveConnection] = useState(!!saved)
  const [typed, setTyped] = useState('')
  const options = { finalSnapshot, disableProtection }
  const script = useMemo(
    () => stepsScript(deletePlan(db, { finalSnapshot, disableProtection }), info.cli),
    [db, finalSnapshot, disableProtection, info.cli]
  )
  const leftovers = deleteLeftovers(db)
  const confirmed = typed.trim() === db.name

  return (
    <Modal
      width="lg"
      title={`Delete ${db.name}?`}
      description={`${db.product} · ${info.label}${db.ref.region ? ` · ${db.ref.region}` : ''}`}
      icon={
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
          <TriangleAlert className="size-4" />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!confirmed}
            onClick={() => {
              startDeletion(db, options, removeConnection ? saved?.id : undefined)
              onClose()
            }}
          >
            <Trash2 className="size-3.5" /> Delete database
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-fg">
          This permanently deletes the {db.ref.kind === 'cosmos' ? 'account' : 'database'} and all
          of its data{finalSnapshot ? ', apart from the final snapshot' : ''}. It can&apos;t be
          undone.
        </p>
        <div className="space-y-3 rounded-lg border border-line bg-raised/40 p-3">
          {canSnapshot(db) && (
            <Toggle
              checked={finalSnapshot}
              onChange={setFinalSnapshot}
              label="Take a final snapshot"
              description="Restore from it later; snapshot storage is billed until you delete it"
            />
          )}
          {db.deletionProtection && (
            <Toggle
              checked={disableProtection}
              onChange={setDisableProtection}
              label="Turn off deletion protection first"
              description="Deletion protection is on, so deleting fails without this"
            />
          )}
          {saved && (
            <Toggle
              checked={removeConnection}
              onChange={setRemoveConnection}
              label={`Also remove the saved connection "${saved.name}"`}
            />
          )}
        </div>
        {leftovers && <p className="text-[11.5px] leading-snug text-muted">{leftovers}</p>}
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-muted">Commands ({info.cli} CLI)</p>
          <pre className="max-h-40 overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg select-text">
            {script}
          </pre>
        </div>
        <Field
          label={
            <>
              Type <span className="font-mono text-bright">{db.name}</span> to confirm
            </>
          }
        >
          <Input
            mono
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={db.name}
          />
        </Field>
      </div>
    </Modal>
  )
}
