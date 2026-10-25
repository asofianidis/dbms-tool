import { AlertTriangle, Download, LoaderCircle, RotateCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { parseChangelog } from '@/lib/changelog'
import { installUpdate, openReleasePage, updateStore } from '@/lib/updater'
import { confirm, runsStore } from '@/lib/workspace'

/** Shows the update's changelog in a card while the pointer or focus is on `children`. */
function WithChangelog({
  version,
  notes,
  children
}: {
  version: string
  notes: string | null
  children: ReactNode
}): React.JSX.Element {
  const sections = notes ? parseChangelog(notes) : []
  if (!sections.length) return <>{children}</>
  return (
    <div className="group relative">
      {children}
      <div
        role="tooltip"
        className="invisible absolute top-full right-0 z-[70] pt-1.5 opacity-0 transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        <div className="max-h-96 w-80 overflow-y-auto rounded-lg border border-line-strong bg-raised p-3 text-left shadow-2xl shadow-(color:--shadow)">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <span className="text-xs font-semibold text-bright">What's new in v{version}</span>
            <button
              type="button"
              onClick={() => openReleasePage(version)}
              className="shrink-0 text-[11px] text-accent hover:underline"
            >
              Release notes
            </button>
          </div>
          {sections.map((section, i) => (
            <div key={i} className="mt-2 first:mt-0">
              {section.heading && (
                <div className="mb-1 text-[10.5px] font-medium tracking-wide text-faint uppercase">
                  {section.heading}
                </div>
              )}
              <ul className="space-y-1 text-[11.5px] leading-snug text-muted">
                {section.items.map((item, j) => (
                  <li key={j} className="flex gap-1.5">
                    <span className="text-faint">•</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Title-bar pill shown only while an update is downloading or ready to install. */
export function UpdateButton(): React.JSX.Element | null {
  const update = updateStore.use()
  if (update.state === 'downloading') {
    return (
      <WithChangelog version={update.version} notes={update.notes}>
        <span
          className="flex h-6 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-muted"
          title={update.notes ? undefined : `Downloading v${update.version}`}
        >
          <Download className="size-3.5" />v{update.version}
          {update.progress != null && <span className="tabular-nums">{update.progress}%</span>}
        </span>
      </WithChangelog>
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
    <WithChangelog version={update.version} notes={update.state === 'ready' ? update.notes : null}>
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
            ? undefined
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
    </WithChangelog>
  )
}
