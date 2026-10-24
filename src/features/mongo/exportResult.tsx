import { save } from '@tauri-apps/plugin-dialog'
import { Braces, FileBraces, Sheet } from 'lucide-react'
import { api, type MongoExportFormat, type MongoExportRequest } from '@/lib/api'
import { formatBytes, plural } from '@/lib/format'
import type { Plan } from '@/lib/plan'
import { toast, toastError } from '@/lib/toast'
import type { MenuItem } from '@/components/ContextMenu'
import { Modal } from '@/components/ui'
import { PlanView } from '../query/PlanView'

const FORMATS: { format: MongoExportFormat; label: string; icon: React.JSX.Element }[] = [
  { format: 'json', label: 'JSON array', icon: <Braces /> },
  { format: 'jsonl', label: 'JSON lines (mongoimport)', icon: <FileBraces /> },
  { format: 'csv', label: 'CSV', icon: <Sheet /> }
]

/** Menu entries for exporting a whole result, one per format. */
export function exportFormatItems(run: (format: MongoExportFormat) => void): MenuItem[] {
  return FORMATS.map(({ format, label, icon }) => ({ label, icon, onSelect: () => run(format) }))
}

/**
 * Asks where to save, then streams every matching document there. Runs on
 * `session`, so `api.cancel(connectionId, session)` stops it.
 */
export async function exportResult(
  connectionId: string,
  session: string,
  request: Omit<MongoExportRequest, 'format'>,
  format: MongoExportFormat,
  name: string,
  onStart?: () => void
): Promise<void> {
  try {
    const path = await save({
      defaultPath: `${name}.${format}`,
      filters: [
        { name: format === 'jsonl' ? 'JSON lines' : format.toUpperCase(), extensions: [format] }
      ]
    })
    if (!path) return
    onStart?.()
    const out = await api.mongoExport(connectionId, session, { ...request, format }, path)
    if (out.cancelled) {
      toast('Export cancelled', 'info')
      return
    }
    const file = path.split(/[\\/]/).pop()
    toast(`Exported ${plural(out.documents, 'document')} (${formatBytes(out.bytes)}) to ${file}`)
    if (out.droppedFields.length)
      toast(
        `Fields first seen after the first 1,000 documents aren't in the CSV: ${out.droppedFields.slice(0, 8).join(', ')}${out.droppedFields.length > 8 ? '…' : ''}`,
        'info'
      )
  } catch (e) {
    toastError(e)
  }
}

export function ExplainDialog({
  plan,
  title,
  onClose
}: {
  plan: Plan
  title: string
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal width="2xl" title="Explain plan" description={title} onClose={onClose}>
      <div className="h-[62vh] overflow-hidden rounded-lg border border-line">
        <PlanView plan={plan} />
      </div>
    </Modal>
  )
}
