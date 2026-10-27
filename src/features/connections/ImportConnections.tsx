import { useMemo, useState } from 'react'
import { dataDir, homeDir, join } from '@tauri-apps/api/path'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { ChevronLeft, FileInput, KeyRound } from 'lucide-react'
import { api, type ConnectionConfig } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  connectionKey,
  exportConnections,
  parseImportFiles,
  type ImportCandidate,
  type ImportFormat
} from '@/lib/connection-transfer'
import { connectionLabel, connectionSubtitle } from '@/lib/engines'
import { plural } from '@/lib/format'
import { isMac } from '@/lib/keys'
import { createStore } from '@/lib/store'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { connectionsStore, loadConnections } from '@/lib/workspace'
import { Badge, Button, EngineMark, Modal } from '@/components/ui'

const importStore = createStore(false)

export function openImportConnections(): void {
  importStore.set(true)
}

/** Saves connections to a JSON file; passwords and SSH secrets are never included. */
export async function exportConnectionsToFile(
  list: ConnectionConfig[] = connectionsStore.get()
): Promise<void> {
  if (!list.length) return toast('There are no connections to export')
  const path = await saveDialog({
    defaultPath: 'dbms-tool-connections.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (!path) return
  try {
    await api.writeText(path, exportConnections(list))
    toast(`Exported ${plural(list.length, 'connection')} without passwords`)
  } catch (e) {
    toastError(e)
  }
}

const isWindows = navigator.userAgent.includes('Windows')

const SOURCES: {
  format: ImportFormat
  label: string
  hint: string
  multiple?: boolean
}[] = [
  {
    format: 'pgpass',
    label: 'pgpass',
    hint: isWindows
      ? '%APPDATA%\\postgresql\\pgpass.conf · passwords are saved to the OS credential manager'
      : '~/.pgpass · passwords are saved to the OS credential manager'
  },
  {
    format: 'dbeaver',
    label: 'DBeaver',
    hint: 'workspace6/General/.dbeaver/data-sources.json · folders, read-only, production type and SSH'
  },
  {
    format: 'datagrip',
    label: 'DataGrip',
    hint: '.idea/dataSources.xml, plus dataSources.local.xml for user names (pick both)',
    multiple: true
  },
  {
    format: 'dbms-tool',
    label: 'dbms-tool export',
    hint: 'A file from "Export connections" on another machine'
  }
]

async function defaultPath(format: ImportFormat): Promise<string | undefined> {
  try {
    const home = await homeDir()
    switch (format) {
      case 'pgpass':
        return isWindows
          ? join(await dataDir(), 'postgresql', 'pgpass.conf')
          : join(home, '.pgpass')
      case 'dbeaver':
        return join(
          isMac ? await join(home, 'Library') : await dataDir(),
          'DBeaverData',
          'workspace6',
          'General',
          '.dbeaver',
          'data-sources.json'
        )
      default:
        return home
    }
  } catch {
    return undefined
  }
}

export function ImportConnectionsHost(): React.JSX.Element | null {
  return importStore.use() ? <ImportConnectionsDialog /> : null
}

interface Found {
  candidates: ImportCandidate[]
  skipped: string[]
}

function ImportConnectionsDialog(): React.JSX.Element {
  const existing = connectionsStore.use()
  const [found, setFound] = useState<Found | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const close = (): void => importStore.set(false)

  const saved = useMemo(() => new Set(existing.map(connectionKey)), [existing])

  const pick = async (source: (typeof SOURCES)[number]): Promise<void> => {
    const picked = await openDialog({
      multiple: !!source.multiple,
      defaultPath: await defaultPath(source.format)
    })
    const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked]
    if (!paths.length) return
    try {
      const texts = await Promise.all(paths.map((p) => api.readText(p)))
      const result = parseImportFiles(texts)
      // Duplicates within the file collapse to the first entry
      const seen = new Set<string>()
      const candidates = result.candidates.filter((c) => {
        const key = connectionKey(c.config)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (!candidates.length && !result.skipped.length) {
        toast('No connections found in that file', 'error')
        return
      }
      setFound({ candidates, skipped: result.skipped })
      setSelected(
        new Set(candidates.flatMap((c, i) => (saved.has(connectionKey(c.config)) ? [] : [i])))
      )
    } catch (e) {
      toast(`Couldn't read that file: ${errorMessage(e)}`, 'error')
    }
  }

  const run = async (): Promise<void> => {
    if (!found) return
    setBusy(true)
    let done = 0
    try {
      for (const i of selected) {
        const { config, password } = found.candidates[i]
        await api.connectionSave(config, password ?? null)
        done++
      }
      toast(`Imported ${plural(done, 'connection')}`)
      close()
    } catch (e) {
      toast(`Imported ${done}, then failed: ${errorMessage(e)}`, 'error')
    } finally {
      setBusy(false)
      void loadConnections()
    }
  }

  const toggle = (i: number): void =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  return (
    <Modal
      width="lg"
      title="Import connections"
      description={
        found
          ? 'Passwords are only imported from pgpass; the others ask on first connect.'
          : 'Pick the settings file of another client. Nothing is changed until you import.'
      }
      onClose={close}
      footer={
        found ? (
          <>
            <Button variant="ghost" onClick={() => setFound(null)} className="mr-auto">
              <ChevronLeft className="size-3.5" /> Back
            </Button>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!selected.size || busy} onClick={() => void run()}>
              Import {selected.size ? plural(selected.size, 'connection') : ''}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
        )
      }
    >
      {!found ? (
        <div className="grid gap-2">
          {SOURCES.map((source) => (
            <button
              key={source.format}
              type="button"
              onClick={() => void pick(source)}
              className="flex items-center gap-3 rounded-lg border border-line bg-raised/40 px-3 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-raised"
            >
              <FileInput className="size-4 shrink-0 text-muted" />
              <span className="min-w-0">
                <span className="block text-[13px] text-bright">{source.label}</span>
                <span className="block truncate text-[11.5px] text-muted">{source.hint}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {found.candidates.length > 0 && (
            <div className="flex items-center justify-between text-xs text-muted">
              <span>{plural(found.candidates.length, 'connection')} found</span>
              <button
                type="button"
                className="hover:text-bright"
                onClick={() =>
                  setSelected(
                    selected.size === found.candidates.length
                      ? new Set()
                      : new Set(found.candidates.map((_, i) => i))
                  )
                }
              >
                {selected.size === found.candidates.length ? 'Select none' : 'Select all'}
              </button>
            </div>
          )}
          <div className="max-h-[45vh] divide-y divide-line overflow-y-auto rounded-lg border border-line">
            {found.candidates.map((c, i) => {
              const duplicate = saved.has(connectionKey(c.config))
              return (
                <label
                  key={i}
                  className={cn(
                    'flex cursor-default items-center gap-2.5 px-3 py-2',
                    !selected.has(i) && 'opacity-60'
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(i)}
                    onChange={() => toggle(i)}
                    className="accent-(--accent)"
                  />
                  <EngineMark engine={c.config.engine} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-bright">
                      {connectionLabel(c.config)}
                      {c.config.group && (
                        <span className="ml-1.5 text-[11px] text-faint">{c.config.group}</span>
                      )}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted">
                      {connectionSubtitle(c.config)}
                    </span>
                  </span>
                  {c.password && (
                    <KeyRound className="size-3.5 shrink-0 text-faint" aria-label="Has password" />
                  )}
                  {c.config.ssh?.enabled && <Badge>SSH</Badge>}
                  {c.config.kube?.enabled && <Badge>K8s pod</Badge>}
                  {c.config.readOnly && <Badge tone="warning">read-only</Badge>}
                  {c.config.production && <Badge tone="danger">production</Badge>}
                  {duplicate && <Badge tone="info">already saved</Badge>}
                </label>
              )
            })}
            {!found.candidates.length && (
              <p className="px-3 py-4 text-center text-xs text-muted">
                Nothing in that file can be imported.
              </p>
            )}
          </div>
          {found.skipped.length > 0 && (
            <details className="text-xs text-muted">
              <summary className="cursor-default hover:text-bright">
                {found.skipped.length} {found.skipped.length === 1 ? 'entry' : 'entries'} skipped
              </summary>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                {found.skipped.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Modal>
  )
}
