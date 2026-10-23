import { FileCode2, FolderOpen, Plus, Search } from 'lucide-react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { api } from '@/lib/api'
import { ENGINES, ENGINE_ORDER, connectionLabel, connectionSubtitle } from '@/lib/engines'
import { timeAgo } from '@/lib/format'
import { MOD, SHIFT } from '@/lib/keys'
import { toastError } from '@/lib/toast'
import {
  connect,
  connectionsStore,
  newQueryTab,
  openConnectionDialog,
  openPalette,
  statusStore,
  updateTab,
  tabsStore
} from '@/lib/workspace'
import { Button, EngineMark, Eyebrow, Kbd, LogoMark } from '@/components/ui'

const SHORTCUTS: [string, string][] = [
  ['Command palette', `${MOD}K`],
  ['New query', `${MOD}N`],
  ['Run script or selection', `F5 · ${MOD}E`],
  ['Run statement at cursor', `${MOD}Enter`],
  ['Explain statement', `${MOD}L`],
  ['Format SQL', `${SHIFT}Alt+F`],
  ['Toggle results pane', `${MOD}R`],
  ['Save query', `${MOD}S`],
  ['Close tab', `${MOD}W`],
  ['Explorer / history', `${MOD}${SHIFT}E · ${MOD}${SHIFT}H`]
]

export function WelcomeTab(): React.JSX.Element {
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const recent = [...connections].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0)).slice(0, 8)

  const openFile = async (): Promise<void> => {
    const path = await openDialog({
      filters: [{ name: 'Queries', extensions: ['sql', 'js', 'mongodb', 'txt'] }],
      multiple: false
    })
    if (typeof path !== 'string') return
    try {
      const text = await api.readText(path)
      const target =
        connections.find((c) =>
          path.endsWith('.sql') ? c.engine !== 'mongo' : c.engine === 'mongo'
        ) ?? connections[0]
      if (!target) return openConnectionDialog()
      newQueryTab(target.id, undefined, text)
      const tab = tabsStore.get().tabs.find((t) => t.id === tabsStore.get().active)
      if (tab) updateTab(tab.id, { filePath: path, savedText: text })
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas bg-dots">
      <div className="mx-auto max-w-4xl px-10 py-14">
        <div className="flex items-center gap-4">
          <LogoMark size="lg" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-bright">dbms-tool</h1>
            <p className="mt-0.5 text-[13px] text-muted">
              One workbench for{' '}
              {ENGINE_ORDER.map((e) => ENGINES[e].label)
                .join(', ')
                .replace(/, ([^,]*)$/, ' and $1')}
              .
            </p>
          </div>
        </div>

        <div className="mt-10 grid grid-cols-[1.4fr_1fr] gap-10">
          <div className="space-y-8">
            <section>
              <Eyebrow className="mb-3">Start</Eyebrow>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => openConnectionDialog()}>
                  <Plus className="size-3.5" /> New connection
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => newQueryTab()}
                  disabled={!connections.length}
                >
                  <FileCode2 className="size-3.5" /> New query
                </Button>
                <Button variant="secondary" onClick={() => void openFile()}>
                  <FolderOpen className="size-3.5" /> Open file
                </Button>
                <Button variant="ghost" onClick={() => openPalette()}>
                  <Search className="size-3.5" /> Search
                </Button>
              </div>
            </section>

            <section>
              <Eyebrow className="mb-3">Recent connections</Eyebrow>
              {recent.length ? (
                <div className="grid grid-cols-2 gap-2">
                  {recent.map((c) => {
                    const connected = statuses[c.id]?.state === 'connected'
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={async () => {
                          if (await connect(c.id)) newQueryTab(c.id)
                        }}
                        className="group flex items-center gap-3 rounded-lg border border-line bg-panel/80 p-3 text-left transition-colors hover:border-line-strong hover:bg-raised"
                      >
                        <EngineMark engine={c.engine} size="lg" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            {c.color && (
                              <span
                                className="size-1.5 rounded-full"
                                style={{ background: c.color }}
                              />
                            )}
                            <span className="truncate font-medium text-bright">
                              {connectionLabel(c)}
                            </span>
                            {connected && <span className="size-1.5 shrink-0 rounded-full bg-ok" />}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-muted">
                            {connectionSubtitle(c)}
                          </span>
                          {c.lastUsed && (
                            <span className="block text-[11px] text-faint">
                              {timeAgo(c.lastUsed)}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-line-strong p-6 text-center text-xs text-muted">
                  Add a connection to PostgreSQL, MySQL, SQL Server, Babelfish or MongoDB, or paste
                  a connection string.
                </div>
              )}
            </section>
          </div>

          <section>
            <Eyebrow className="mb-3">Keyboard</Eyebrow>
            <div className="divide-y divide-line rounded-lg border border-line bg-panel/80">
              {SHORTCUTS.map(([label, keys]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-[12.5px]"
                >
                  <span className="text-fg">{label}</span>
                  <span className="flex gap-1">
                    {keys.split(' · ').map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-faint">
              Right-click anything in the explorer for scripts, structure and data. Results grids
              copy straight into spreadsheets.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
