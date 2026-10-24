import { useState } from 'react'
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Sun
} from 'lucide-react'
import { getVersion } from '@tauri-apps/api/app'
import { cn } from '@/lib/cn'
import { timeZones } from '@/lib/datetime'
import { timeAgo } from '@/lib/format'
import { historyStore } from '@/lib/history'
import { checkForUpdates, installUpdate, openReleasePage, updateStore } from '@/lib/updater'
import { ACCENTS, settingsStore, type Settings } from '@/lib/settings'
import {
  allThemes,
  currentTheme,
  customThemesStore,
  newThemeId,
  parseTheme,
  type Theme
} from '@/lib/themes'
import { toast } from '@/lib/toast'
import { confirm, promptText } from '@/lib/workspace'
import { Badge, Button, Input, Segmented, Select, Switch } from '@/components/ui'
import { ThemeEditor } from './ThemeEditor'

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
  const [zones] = useState(timeZones)
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const history = historyStore.use()
  const update = updateStore.use()
  const [version, setVersion] = useState('')
  const [customAccent, setCustomAccent] = useState(settings.accent)
  const customThemes = customThemesStore.use()
  const [editing, setEditing] = useState<{ theme: Theme; isNew: boolean } | null>(null)
  const themes = allThemes()
  const active = currentTheme()
  if (!version)
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion('dev'))

  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void =>
    settingsStore.set((s) => ({ ...s, [key]: value }))
  const setAccent = (accent: string): void => {
    set('accent', accent)
    setCustomAccent(accent)
  }
  const selectTheme = (theme: Theme): void =>
    settingsStore.set((s) => ({
      ...s,
      themeMode: theme.base,
      ...(theme.base === 'dark' ? { darkTheme: theme.id } : { lightTheme: theme.id })
    }))
  const duplicate = (theme: Theme): void =>
    setEditing({
      theme: { ...theme, id: newThemeId(), name: `${theme.name} copy`, builtin: undefined },
      isNew: true
    })
  const importTheme = async (): Promise<void> => {
    const text = await promptText({
      title: 'Import theme',
      label: 'Paste theme JSON (from "Copy JSON" in the theme editor)',
      confirmLabel: 'Import'
    })
    if (!text) return
    try {
      setEditing({ theme: parseTheme(text), isNew: true })
    } catch (e) {
      toast(`Not a valid theme: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-2xl px-8 py-10">
        <h1 className="mb-8 text-xl font-semibold tracking-tight text-bright">Settings</h1>

        <Section title="Appearance">
          <Row title="Mode" description="Light, dark, or follow the operating system">
            <Segmented
              value={settings.themeMode}
              onChange={(themeMode) => set('themeMode', themeMode)}
              options={[
                {
                  value: 'dark',
                  label: (
                    <span className="flex items-center gap-1.5">
                      <Moon className="size-3.5" /> Dark
                    </span>
                  )
                },
                {
                  value: 'light',
                  label: (
                    <span className="flex items-center gap-1.5">
                      <Sun className="size-3.5" /> Light
                    </span>
                  )
                },
                { value: 'system', label: 'System' }
              ]}
            />
          </Row>
          <Row title="Dark theme">
            <Select
              value={settings.darkTheme}
              onChange={(e) => set('darkTheme', e.target.value)}
              className="w-44"
            >
              {themes
                .filter((t) => t.base === 'dark')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          </Row>
          <Row title="Light theme">
            <Select
              value={settings.lightTheme}
              onChange={(e) => set('lightTheme', e.target.value)}
              className="w-44"
            >
              {themes
                .filter((t) => t.base === 'light')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          </Row>
          <Row title="Accent colour" description="Overrides the theme's accent everywhere">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                title="Use the theme's accent"
                onClick={() => setAccent('')}
                className="flex h-6 items-center gap-1 rounded-full border border-line-strong px-2 text-[11px] text-muted hover:text-bright"
              >
                {!settings.accent && <Check className="size-3 text-accent" strokeWidth={3} />}
                Theme
              </button>
              {ACCENTS.map((a) => (
                <button
                  key={a.value}
                  type="button"
                  title={a.label}
                  onClick={() => setAccent(a.value)}
                  className="flex size-6 items-center justify-center rounded-full ring-1 ring-line-strong transition hover:scale-110"
                  style={{ background: a.value }}
                >
                  {settings.accent === a.value && (
                    <Check
                      className="size-3.5 text-black/70 mix-blend-difference"
                      strokeWidth={3}
                    />
                  )}
                </button>
              ))}
              <Input
                value={customAccent}
                placeholder="#hex"
                onChange={(e) => {
                  setCustomAccent(e.target.value)
                  if (/^#[0-9a-f]{6}$/i.test(e.target.value)) setAccent(e.target.value)
                  if (!e.target.value) setAccent('')
                }}
                mono
                className="ml-1 w-24"
              />
            </div>
          </Row>
        </Section>

        <section className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[11px] font-semibold tracking-wider text-muted uppercase">
              Themes
            </h2>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => void importTheme()}>
                <Download className="size-3.5" /> Import
              </Button>
              <Button size="sm" variant="secondary" onClick={() => duplicate(active)}>
                <Plus className="size-3.5" /> New theme
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {themes.map((t) => {
              const selected = t.id === active.id
              return (
                <div
                  key={t.id}
                  className={cn(
                    'group overflow-hidden rounded-lg border transition-colors',
                    selected ? 'border-accent/60' : 'border-line hover:border-line-strong'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectTheme(t)}
                    className="block w-full text-left"
                  >
                    {/* Miniature of the workbench in the theme's colours */}
                    <div className="flex h-16" style={{ background: t.colors.canvas }}>
                      <div
                        className="w-8 space-y-1 p-1.5"
                        style={{
                          background: t.colors.panel,
                          borderRight: `1px solid ${t.colors.line}`
                        }}
                      >
                        {[0, 1, 2].map((i) => (
                          <div
                            key={i}
                            className="h-1 rounded-full"
                            style={{ background: i === 0 ? t.colors.accent : t.colors.faint }}
                          />
                        ))}
                      </div>
                      <div className="flex-1 space-y-1.5 p-2 font-mono text-[9px] leading-none">
                        <div>
                          <span style={{ color: t.colors['syn-keyword'] }}>SELECT</span>{' '}
                          <span style={{ color: t.colors.fg }}>name</span>{' '}
                          <span style={{ color: t.colors['syn-keyword'] }}>FROM</span>{' '}
                          <span style={{ color: t.colors['syn-type'] }}>users</span>
                        </div>
                        <div>
                          <span style={{ color: t.colors['syn-keyword'] }}>WHERE</span>{' '}
                          <span style={{ color: t.colors.fg }}>id</span>{' '}
                          <span style={{ color: t.colors['syn-operator'] }}>=</span>{' '}
                          <span style={{ color: t.colors['syn-number'] }}>42</span>{' '}
                          <span style={{ color: t.colors['syn-string'] }}>&apos;ok&apos;</span>
                        </div>
                        <div
                          className="h-3 w-12 rounded-sm"
                          style={{ background: t.colors.accent }}
                        />
                      </div>
                    </div>
                  </button>
                  <div className="flex items-center gap-2 border-t border-line bg-panel px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-bright">
                      {t.name}
                    </span>
                    {selected && <Badge tone="accent">active</Badge>}
                    <Badge>{t.base}</Badge>
                    <div className="flex opacity-0 group-hover:opacity-100">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Duplicate"
                        onClick={() => duplicate(t)}
                      >
                        <Copy className="size-3.5" />
                      </Button>
                      {!t.builtin && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          title="Edit"
                          onClick={() => setEditing({ theme: t, isNew: false })}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          {!customThemes.length && (
            <p className="mt-2 text-[11.5px] text-faint">
              Built-in themes can't be changed; duplicate one to make your own.
            </p>
          )}
          {editing && (
            <ThemeEditor
              theme={editing.theme}
              isNew={editing.isNew}
              onClose={() => setEditing(null)}
            />
          )}
        </section>

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
          <Row
            title="Time zone for timestamps"
            description="Timestamps that carry an offset are shown in this zone; copies and exports keep the server's text"
          >
            <Select
              value={settings.timeZone}
              onChange={(e) => set('timeZone', e.target.value)}
              className="w-56"
            >
              <option value="">As the server sends them</option>
              <option value="local">This computer ({localZone})</option>
              <option value="UTC">UTC</option>
              {zones
                .filter((z) => z !== 'UTC')
                .map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
            </Select>
          </Row>
          {settings.timeZone && (
            <>
              <Row
                title="Timestamp format"
                description="ISO keeps the server's precision; the local format follows your system"
              >
                <Segmented
                  value={settings.dateFormat}
                  onChange={(v) => set('dateFormat', v)}
                  options={[
                    { value: 'iso', label: '2024-05-01 13:45:00' },
                    { value: 'locale', label: 'Local format' }
                  ]}
                />
              </Row>
              <Row
                title="Timestamps without a zone are UTC"
                description="Convert timestamp / datetime values that carry no offset too, reading them as UTC"
              >
                <Switch checked={settings.assumeUtc} onChange={(v) => set('assumeUtc', v)} />
              </Row>
            </>
          )}
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
