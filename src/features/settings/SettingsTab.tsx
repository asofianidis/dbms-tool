import { useState } from 'react'
import { Check, ExternalLink, RefreshCw } from 'lucide-react'
import { getVersion } from '@tauri-apps/api/app'
import { cn } from '@/lib/cn'
import { timeAgo } from '@/lib/format'
import { historyStore } from '@/lib/history'
import { checkForUpdates, installUpdate, openReleasePage, updateStore } from '@/lib/updater'
import { ACCENTS, applyAccent, settingsStore, type Settings } from '@/lib/settings'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/workspace'
import { Button, Input, Select, Switch } from '@/components/ui'

function Row({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-8 border-b border-line py-4 last:border-0">
      <div className="min-w-0">
        <p className="text-bright">{title}</p>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
        {title}
      </h2>
      <div className="rounded-lg border border-line bg-panel/70 px-4">{children}</div>
    </section>
  )
}

export function SettingsTab(): React.JSX.Element {
  const settings = settingsStore.use()
  const history = historyStore.use()
  const update = updateStore.use()
  const [version, setVersion] = useState('')
  const [customAccent, setCustomAccent] = useState(settings.accent)
  if (!version)
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion('dev'))

  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void =>
    settingsStore.set((s) => ({ ...s, [key]: value }))
  const setAccent = (accent: string): void => {
    set('accent', accent)
    setCustomAccent(accent)
    applyAccent(accent)
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <h1 className="mb-8 text-xl font-semibold tracking-tight text-bright">Settings</h1>

        <Section title="Appearance">
          <Row title="Accent colour" description="Used for focus, selection and primary actions">
            <div className="flex items-center gap-1.5">
              {ACCENTS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  title={a.label}
                  onClick={() => setAccent(a.value)}
                  className="flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-panel transition hover:scale-110"
                  style={{ background: a.value }}
                >
                  {settings.accent === a.value && (
                    <Check className="size-3.5 text-black/70" strokeWidth={3} />
                  )}
                </button>
              ))}
              <Input
                value={customAccent}
                onChange={(e) => {
                  setCustomAccent(e.target.value)
                  if (/^#[0-9a-f]{6}$/i.test(e.target.value)) setAccent(e.target.value)
                }}
                mono
                className="ml-1 w-24"
              />
            </div>
          </Row>
        </Section>

        <Section title="Editor">
          <Row title="Font size">
            <Select
              value={String(settings.editorFontSize)}
              onChange={(e) => set('editorFontSize', Number(e.target.value))}
              className="w-28"
            >
              {[11, 12, 13, 14, 15, 16, 18].map((n) => (
                <option key={n} value={n}>
                  {n}px
                </option>
              ))}
            </Select>
          </Row>
          <Row title="Word wrap" description="Wrap long lines in query editors">
            <Switch checked={settings.wordWrap} onChange={(v) => set('wordWrap', v)} />
          </Row>
        </Section>

        <Section title="Results">
          <Row
            title="Row limit per result"
            description="Rows beyond this are counted but not loaded, which keeps huge queries responsive"
          >
            <Select
              value={String(settings.maxRows)}
              onChange={(e) => set('maxRows', Number(e.target.value))}
              className="w-32"
            >
              {[1000, 5000, 10000, 50000, 100000, 500000].map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </Select>
          </Row>
          <Row title="Page size" description="Rows per page when browsing tables and collections">
            <Select
              value={String(settings.pageSize)}
              onChange={(e) => set('pageSize', Number(e.target.value))}
              className="w-32"
            >
              {[20, 50, 100, 200, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Row>
        </Section>

        <Section title="Safety">
          <Row
            title="Confirm destructive statements"
            description="Ask before DELETE/UPDATE without WHERE, DROP, TRUNCATE, deleteMany({}) and grid saves"
          >
            <Switch
              checked={settings.confirmDangerous}
              onChange={(v) => set('confirmDangerous', v)}
            />
          </Row>
        </Section>

        <Section title="Explorer">
          <Row
            title="Show system objects"
            description="Inline system databases and schemas (pg_catalog, master, admin…)"
          >
            <Switch
              checked={settings.showSystemObjects}
              onChange={(v) => set('showSystemObjects', v)}
            />
          </Row>
        </Section>

        <Section title="Updates">
          <Row
            title={`Version ${version}`}
            description={
              update.state === 'checking'
                ? 'Checking for updates…'
                : update.state === 'current'
                  ? `Up to date · checked ${timeAgo(update.checkedAt)}`
                  : update.state === 'downloading'
                    ? `Downloading v${update.version}${update.progress != null ? ` · ${update.progress}%` : ''}`
                    : update.state === 'ready'
                      ? `v${update.version} is ready to install`
                      : update.state === 'installing'
                        ? `Installing v${update.version}…`
                        : update.state === 'error'
                          ? `Update failed: ${update.error}`
                          : 'Updates are signed and verified before they install'
            }
          >
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => openReleasePage()}>
                <ExternalLink className="size-3.5" /> Releases
              </Button>
              {update.state === 'ready' ? (
                <Button size="sm" variant="primary" onClick={() => void installUpdate()}>
                  Restart to update
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={
                    update.state === 'checking' ||
                    update.state === 'downloading' ||
                    update.state === 'installing'
                  }
                  onClick={() => void checkForUpdates(true)}
                >
                  <RefreshCw
                    className={cn('size-3.5', update.state === 'checking' && 'animate-spin')}
                  />{' '}
                  Check now
                </Button>
              )}
            </div>
          </Row>
          <Row
            title="Check for updates automatically"
            description="Looks for new releases at startup and every few hours, and downloads them in the background"
          >
            <Switch checked={settings.autoUpdate} onChange={(v) => set('autoUpdate', v)} />
          </Row>
        </Section>

        <Section title="Data">
          <Row
            title="Query history"
            description={`${history.length.toLocaleString()} entries stored on this machine`}
          >
            <Button
              size="sm"
              variant="danger"
              disabled={!history.length}
              onClick={async () => {
                if (
                  await confirm({
                    title: 'Clear query history?',
                    message: 'Every saved query in the history panel is removed.',
                    confirmLabel: 'Clear',
                    danger: true
                  })
                ) {
                  historyStore.set([])
                  toast('History cleared')
                }
              }}
            >
              Clear
            </Button>
          </Row>
        </Section>

        <p className={cn('text-center text-[11.5px] text-faint')}>
          dbms-tool {version} · MIT licensed · connections are stored locally, passwords in the OS
          credential manager
        </p>
      </div>
    </div>
  )
}
