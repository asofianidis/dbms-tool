import { AlertTriangle, Download, LoaderCircle, RotateCw } from 'lucide-react'
import { installUpdate, openReleasePage, updateStore } from '@/lib/updater'
import { confirm, runsStore } from '@/lib/workspace'

/** Title-bar pill shown only while an update is downloading or ready to install. */
export function UpdateButton(): React.JSX.Element | null {
  const update = updateStore.use()
  if (update.state === 'downloading') {
    return (
      <span
        className="flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-muted"
        title={`Downloading v${update.version}`}
      >
        <Download className="size-3.5" />v{update.version}
        {update.progress != null && <span className="tabular-nums">{update.progress}%</span>}
      </span>
    )
  }
  if (update.state === 'error' && update.version) {
    return (
      <button
        type="button"
        onClick={() => openReleasePage(update.version)}
        title={`${update.error}\nOpen the release page to download v${update.version} manually.`}
        className="flex h-6 items-center gap-1.5 rounded-md bg-danger/10 px-2 text-[11.5px] font-medium text-danger ring-1 ring-danger/25 ring-inset"
      >
        <AlertTriangle className="size-3.5" /> Update v{update.version} manually
      </button>
    )
  }
  if (update.state !== 'ready' && update.state !== 'installing') return null
  const installing = update.state === 'installing'
  return (
    <button
      type="button"
      disabled={installing}
      onClick={async () => {
        const busy = Object.values(runsStore.get()).some((r) => r.running)
        if (
          busy &&
          !(await confirm({
            title: 'Restart while a query is running?',
            message:
              'Restarting to install the update cancels running queries and closes open connections.',
            confirmLabel: 'Restart and update'
          }))
        ) {
          return
        }
        void installUpdate()
      }}
      title={
        update.state === 'ready' && update.notes
          ? update.notes
          : 'Restart the app and install the update'
      }
      className="flex h-6 items-center gap-1.5 rounded-md bg-accent/10 px-2 text-[11.5px] font-medium text-accent ring-1 ring-accent/25 ring-inset hover:bg-accent/15 disabled:cursor-default"
    >
      {installing ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <RotateCw className="size-3.5" />
      )}
      {installing ? 'Installing…' : `Restart to update to v${update.version}`}
    </button>
  )
}
