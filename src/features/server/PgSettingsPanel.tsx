import { Fragment, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileWarning,
  RefreshCw,
  Search,
  SlidersHorizontal
} from 'lucide-react'
import { api, type ConnectionConfig, type ResultSet } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  applyNote,
  canAlterSystem,
  categories,
  contextInfo,
  docsUrl,
  filterSettings,
  formatSettingValue,
  isChanged,
  parseProbe,
  parseScopedValues,
  parseSettings,
  PG_DB_ROLE_SETTINGS_SQL,
  PG_FILE_ERRORS_SQL,
  PG_HBA_RULES_SQL,
  PG_SETTINGS_PROBE_SQL,
  pgSettingsSql,
  scopedLabel,
  scopedSettable,
  settingChangeSql,
  sourceLabel,
  validateSettingValue,
  type PgSetting,
  type PgSettingsProbe,
  type ScopedValue,
  type SettingChange,
  type SettingScope,
  type SettingsFilter
} from '@/lib/pg-settings'
import { confirmProductionWrite } from '@/lib/production'
import { queries } from '@/lib/queries'
import { toast, toastError } from '@/lib/toast'
import { ResultGrid } from '@/components/grid/ResultGrid'
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Modal,
  Segmented,
  Select
} from '@/components/ui'
import { SectionHeading } from './PerformancePanels'
import { useSqlPanel } from './useSqlPanel'

const FILTERS: { value: SettingsFilter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'Every setting' },
  { value: 'changed', label: 'Changed', title: 'Settings that differ from the built-in default' },
  {
    value: 'pending',
    label: 'Pending restart',
    title: 'Changed in the configuration files but only applied after a server restart'
  }
]

const ROLES_SQL = `SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1`

/** pg_settings for a PostgreSQL connection: browse, filter, and change server settings. */
export function PgSettingsPanel({
  connection
}: {
  connection: ConnectionConfig
}): React.JSX.Element {
  const probePanel = useSqlPanel(connection, PG_SETTINGS_PROBE_SQL)
  const probe = useMemo(() => parseProbe(probePanel.set), [probePanel.set])
  const settingsPanel = useSqlPanel(connection, probe ? pgSettingsSql(probe.version) : null)
  const scopedPanel = useSqlPanel(connection, PG_DB_ROLE_SETTINGS_SQL)
  // Superuser-only unless granted; a permission error just hides the box
  const filePanel = useSqlPanel(connection, PG_FILE_ERRORS_SQL)
  const settings = useMemo(() => parseSettings(settingsPanel.set), [settingsPanel.set])
  const scoped = useMemo(() => parseScopedValues(scopedPanel.set), [scopedPanel.set])

  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [filter, setFilter] = useState<SettingsFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<PgSetting | null>(null)
  const [hba, setHba] = useState(false)

  const shown = useMemo(
    () => filterSettings(settings, { search, category, filter }),
    [settings, search, category, filter]
  )
  const changedCount = useMemo(() => settings.filter(isChanged).length, [settings])
  const pendingCount = useMemo(() => settings.filter((s) => s.pendingRestart).length, [settings])

  const reload = (): void => {
    probePanel.reload()
    settingsPanel.reload()
    scopedPanel.reload()
    filePanel.reload()
  }
  const error = probePanel.error ?? settingsPanel.error

  return (
    <section>
      <SectionHeading icon={<SlidersHorizontal className="size-3.5" />} title="Settings">
        <Button size="icon-sm" variant="ghost" onClick={reload} title="Refresh">
          <RefreshCw className={settingsPanel.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        {pendingCount > 0 && (
          <Badge
            tone="warning"
            className="normal-case"
            title="Changed in the configuration files; applied after a server restart"
          >
            {pendingCount} pending restart
          </Badge>
        )}
        <span className="ml-auto text-[11px] font-normal tracking-normal text-faint normal-case">
          pg_settings · click a row for details
          {connection.readOnly
            ? ' · read-only connection'
            : probe && !probe.superuser && probe.version < 150000
              ? ' · changing settings needs a superuser'
              : ''}
        </span>
      </SectionHeading>

      {filePanel.set && filePanel.set.rows.length > 0 && <FileProblems panel={filePanel.set} />}

      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px]">
        <div className="relative w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, value, description"
            className="h-6 pl-7 text-[11.5px]"
          />
        </div>
        <Select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="w-56"
          selectClassName="h-6 text-[11.5px]"
        >
          <option value="">All categories</option>
          {categories(settings).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({
            ...f,
            count:
              f.value === 'changed'
                ? changedCount
                : f.value === 'pending'
                  ? pendingCount
                  : settings.length
          }))}
        />
        <span className="ml-auto text-faint">
          {shown.length.toLocaleString()} of {settings.length.toLocaleString()}
        </span>
      </div>

      <div className="h-[32rem] overflow-auto rounded-lg border border-line">
        {error ? (
          <div className="p-4">
            <ErrorText error={error} />
          </div>
        ) : !settingsPanel.set ? (
          <EmptyState title="Loading…" />
        ) : shown.length === 0 ? (
          <EmptyState title="No settings match" />
        ) : (
          <table className="w-full table-fixed border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-panel text-left text-[11px] text-muted">
              <tr className="border-b border-line">
                <th className="w-[24%] px-2 py-1.5 font-medium">Name</th>
                <th className="w-[14%] px-2 py-1.5 font-medium">Value</th>
                <th className="w-[12%] px-2 py-1.5 font-medium">Default</th>
                <th className="w-[14%] px-2 py-1.5 font-medium">Source</th>
                <th className="w-[11%] px-2 py-1.5 font-medium">Applies</th>
                <th className="px-2 py-1.5 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <Fragment key={s.name}>
                  <SettingRow
                    setting={s}
                    open={expanded === s.name}
                    onToggle={() => setExpanded(expanded === s.name ? null : s.name)}
                  />
                  {expanded === s.name && (
                    <SettingDetails
                      setting={s}
                      probe={probe}
                      connection={connection}
                      scoped={scoped.get(s.name.toLowerCase()) ?? []}
                      onChange={() => setEditing(s)}
                    />
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {probe?.superuser && probe.version >= 100000 && (
        <div className="mt-2">
          <Button size="xs" variant="ghost" onClick={() => setHba(!hba)}>
            {hba ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            pg_hba.conf rules
          </Button>
          {hba && <HbaRules connection={connection} />}
        </div>
      )}

      {editing && probe && (
        <ChangeDialog
          connection={connection}
          setting={editing}
          probe={probe}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
    </section>
  )
}

function SettingRow({
  setting: s,
  open,
  onToggle
}: {
  setting: PgSetting
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const context = contextInfo(s.context)
  const value = formatSettingValue(s.setting, s.unit)
  const boot = formatSettingValue(s.bootVal, s.unit)
  const changed = isChanged(s)
  return (
    <tr
      onClick={onToggle}
      className={cn(
        'cursor-default border-b border-line/60 align-top hover:bg-hover/60',
        open && 'bg-hover/40',
        s.pendingRestart && 'bg-warn/[0.06]'
      )}
    >
      <td className="truncate px-2 py-1 font-mono text-[11.5px] text-bright" title={s.category}>
        {s.name}
      </td>
      <td
        className={cn(
          'truncate px-2 py-1 font-mono text-[11.5px] select-text',
          changed ? 'text-accent' : 'text-fg'
        )}
        title={s.unit ? `${s.setting} × ${s.unit}` : s.setting}
      >
        {value === '' ? <span className="text-faint">empty</span> : value}
        {s.pendingRestart && (
          <Badge tone="warning" className="ml-1.5" title="Applied after a server restart">
            restart
          </Badge>
        )}
      </td>
      <td
        className="truncate px-2 py-1 font-mono text-[11.5px] text-muted"
        title={`Built-in default: ${s.bootVal ?? ''}\nReset value: ${s.resetVal ?? ''}`}
      >
        {boot}
      </td>
      <td className="truncate px-2 py-1 text-muted" title={sourceLabel(s)}>
        {s.source === 'configuration file' && s.sourcefile
          ? `${s.sourcefile.split('/').pop()}:${s.sourceline ?? '?'}`
          : s.source}
      </td>
      <td className="truncate px-2 py-1" title={`${s.context}: ${context.description}`}>
        <span
          className={cn(
            context.apply === 'restart'
              ? 'text-warn'
              : context.apply === 'none'
                ? 'text-faint'
                : 'text-muted'
          )}
        >
          {context.label}
        </span>
      </td>
      <td className="truncate px-2 py-1 text-muted" title={s.extraDesc ?? s.shortDesc}>
        {s.shortDesc}
      </td>
    </tr>
  )
}

function SettingDetails({
  setting: s,
  probe,
  connection,
  scoped,
  onChange
}: {
  setting: PgSetting
  probe: PgSettingsProbe | null
  connection: ConnectionConfig
  scoped: ScopedValue[]
  onChange: () => void
}): React.JSX.Element {
  const url = probe ? docsUrl(s, probe.version) : null
  const context = contextInfo(s.context)
  const editable = canAlterSystem(s, probe)
  const allowed =
    s.vartype === 'enum'
      ? s.enumvals.join(', ')
      : s.vartype === 'bool'
        ? 'on, off'
        : s.minVal !== null && s.maxVal !== null
          ? `${s.minVal} – ${s.maxVal}${s.unit ? ` × ${s.unit}` : ''}`
          : null
  const facts: [string, React.ReactNode][] = [
    ['Category', s.category],
    ['Type', s.vartype + (s.unit ? ` (${s.unit})` : '')],
    ['Allowed', allowed],
    ['Raw value', s.setting],
    ['Reset value', s.resetVal !== s.setting ? s.resetVal : null],
    ['Source', sourceLabel(s)],
    ['Context', `${s.context}: ${context.description}`],
    [
      'Overrides',
      scoped.length ? scoped.map((v) => `${scopedLabel(v)}: ${v.value}`).join('; ') : null
    ]
  ]
  return (
    <tr className="border-b border-line bg-panel/70">
      <td colSpan={6} className="px-3 py-2.5 text-[12px]">
        <p className="mb-2 text-fg">
          {s.shortDesc}
          {s.extraDesc && <span className="text-muted"> {s.extraDesc}</span>}
        </p>
        <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-0.5">
          {facts
            .filter(([, v]) => v !== null && v !== '')
            .map(([k, v]) => (
              <Fragment key={k}>
                <dt className="text-muted">{k}</dt>
                <dd className="font-mono text-[11.5px] break-all text-fg select-text">{v}</dd>
              </Fragment>
            ))}
        </dl>
        <div className="mt-2 flex items-center gap-2">
          {s.context !== 'internal' && (
            <Button
              size="xs"
              onClick={onChange}
              disabled={connection.readOnly || !editable}
              title={
                connection.readOnly
                  ? 'This connection is read-only'
                  : !editable
                    ? probe && probe.version >= 150000
                      ? 'Needs a superuser, or GRANT ALTER SYSTEM ON PARAMETER to this role'
                      : 'Needs a superuser'
                    : undefined
              }
            >
              Change…
            </Button>
          )}
          {url && (
            <Button size="xs" variant="ghost" onClick={() => void openUrl(url)} title={url}>
              <ExternalLink className="size-3.5" /> Documentation
            </Button>
          )}
        </div>
      </td>
    </tr>
  )
}

function FileProblems({ panel }: { panel: ResultSet }): React.JSX.Element {
  return (
    <div className="mb-2 rounded-lg border border-warn/30 bg-warn/[0.05] p-3 text-xs">
      <p className="mb-1.5 flex items-center gap-1.5 font-medium text-warn">
        <FileWarning className="size-3.5" /> Configuration file entries not applied
      </p>
      <p className="mb-2 text-muted">
        From pg_file_settings. &ldquo;setting could not be applied&rdquo; usually means the value
        waits for a restart; other errors are lines the server rejected.
      </p>
      <div className="h-32 overflow-hidden rounded-md border border-line">
        <ResultGrid columns={panel.columns} rows={panel.rows} />
      </div>
    </div>
  )
}

function HbaRules({ connection }: { connection: ConnectionConfig }): React.JSX.Element {
  const panel = useSqlPanel(connection, PG_HBA_RULES_SQL)
  return (
    <div className="mt-1 h-64 overflow-hidden rounded-lg border border-line">
      {panel.error ? (
        <div className="p-4">
          <ErrorText error={panel.error} />
        </div>
      ) : panel.set ? (
        <ResultGrid columns={panel.set.columns} rows={panel.set.rows} />
      ) : (
        <EmptyState title="Loading…" />
      )}
    </div>
  )
}

type ScopeKind = SettingScope['kind']

function ChangeDialog({
  connection,
  setting,
  probe,
  onClose,
  onDone
}: {
  connection: ConnectionConfig
  setting: PgSetting
  probe: PgSettingsProbe
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const scopable = scopedSettable(setting)
  const dbs = useQuery({ ...queries.databases(connection.id), enabled: scopable })
  const roles = useSqlPanel(connection, scopable ? ROLES_SQL : null)
  const databases = dbs.data?.filter((d) => d.name !== 'template0').map((d) => d.name) ?? []
  const roleNames = roles.set?.rows.map((r) => String(r[0])) ?? []

  const [kind, setKind] = useState<ScopeKind>('system')
  const [database, setDatabase] = useState('')
  const [role, setRole] = useState('')
  const [action, setAction] = useState<'set' | 'reset'>('set')
  const [value, setValue] = useState(
    setting.unit
      ? formatSettingValue(setting.setting, setting.unit).replace(' ', '')
      : setting.setting
  )
  const restart = contextInfo(setting.context).apply === 'restart'
  const [reload, setReload] = useState(!restart && probe.canReload)
  const [busy, setBusy] = useState(false)

  const db = database || databases[0] || ''
  const r = role || roleNames[0] || ''
  const scope: SettingScope =
    kind === 'database'
      ? { kind, database: db }
      : kind === 'role'
        ? { kind, role: r }
        : kind === 'role-in-database'
          ? { kind, role: r, database: db }
          : { kind: 'system' }
  const change: SettingChange = {
    scope,
    name: setting.name,
    value: action === 'reset' ? null : value,
    reload
  }
  const invalid = action === 'set' ? validateSettingValue(setting, value) : null
  const missing = (kind !== 'system' && kind !== 'role' && !db) || (kind.startsWith('role') && !r)
  const statements = settingChangeSql(change)
  const code = statements.map((s) => `${s};`).join('\n')

  const apply = async (): Promise<void> => {
    // ALTER SYSTEM isn't a data write, so the production guard is asked explicitly
    const ok = await confirmProductionWrite(connection, {
      action: `This changes the server setting ${setting.name}`,
      dangers: [],
      code
    })
    if (!ok) return
    setBusy(true)
    try {
      for (const [i, sql] of statements.entries()) {
        const out = await api.execute(connection.id, '__meta', '', sql, { confirmed: true })
        if (out.error)
          throw new Error(
            i > 0
              ? `${setting.name} was written to postgresql.auto.conf, but the reload failed: ${out.error.message}`
              : out.error.message
          )
      }
      toast(
        kind === 'system' && restart
          ? `${setting.name} changed; restart the server to apply it`
          : `${setting.name} ${action === 'reset' ? 'reset' : 'changed'}`
      )
      onDone()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  const scopes: { value: ScopeKind; label: string }[] = [
    { value: 'system', label: 'Server (ALTER SYSTEM)' },
    ...(scopable
      ? ([
          { value: 'database', label: 'A database' },
          { value: 'role', label: 'A role' },
          { value: 'role-in-database', label: 'A role in a database' }
        ] as const)
      : [])
  ]

  return (
    <Modal
      title={`Change ${setting.name}`}
      description={setting.shortDesc}
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !!invalid || missing}
            onClick={() => void apply()}
          >
            {action === 'reset' ? 'Reset' : 'Apply'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Where">
            <Select value={kind} onChange={(e) => setKind(e.target.value as ScopeKind)}>
              {scopes.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-muted">Change</span>
            <Segmented
              value={action}
              onChange={setAction}
              options={[
                { value: 'set', label: 'Set a value' },
                {
                  value: 'reset',
                  label: 'Reset',
                  title:
                    kind === 'system'
                      ? 'Remove it from postgresql.auto.conf (ALTER SYSTEM RESET)'
                      : 'Remove this override'
                }
              ]}
            />
          </div>
        </div>
        {(kind === 'database' || kind === 'role-in-database' || kind === 'role') && (
          <div className="grid grid-cols-2 gap-3">
            {kind !== 'role' && (
              <Field label="Database">
                <Select value={db} onChange={(e) => setDatabase(e.target.value)}>
                  {databases.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {kind !== 'database' && (
              <Field label="Role">
                <Select value={r} onChange={(e) => setRole(e.target.value)}>
                  {roleNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        )}
        {action === 'set' && (
          <Field
            label="Value"
            hint={
              <>
                {setting.vartype === 'integer' || setting.vartype === 'real'
                  ? `Between ${setting.minVal} and ${setting.maxVal}${setting.unit ? ` × ${setting.unit}; units like 128MB or 5min are accepted` : ''}. `
                  : setting.vartype === 'string'
                    ? 'Free text. '
                    : ''}
                Current: {formatSettingValue(setting.setting, setting.unit) || 'empty'}, default:{' '}
                {formatSettingValue(setting.bootVal, setting.unit) || 'empty'}
              </>
            }
          >
            {setting.vartype === 'enum' || setting.vartype === 'bool' ? (
              <Select value={value} onChange={(e) => setValue(e.target.value)}>
                {!(setting.vartype === 'bool' ? ['on', 'off'] : setting.enumvals).includes(
                  value
                ) && <option value={value}>{value}</option>}
                {(setting.vartype === 'bool' ? ['on', 'off'] : setting.enumvals).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </Select>
            ) : (
              <Input mono value={value} onChange={(e) => setValue(e.target.value)} />
            )}
          </Field>
        )}
        {invalid && <p className="text-xs text-danger">{invalid}</p>}
        {kind === 'system' && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={reload}
              disabled={!probe.canReload}
              onChange={(e) => setReload(e.target.checked)}
            />
            Reload the configuration afterwards (pg_reload_conf())
            {!probe.canReload && ' (needs EXECUTE on pg_reload_conf)'}
          </label>
        )}
        <p className={cn('text-xs', restart && kind === 'system' ? 'text-warn' : 'text-muted')}>
          {applyNote(setting, change)}
          {restart && kind === 'system' && action === 'set' && (
            <> A value the server can&apos;t use at start-up keeps it from starting.</>
          )}
        </p>
        <pre className="overflow-x-auto rounded-md bg-canvas px-3 py-2 font-mono text-[11.5px] text-fg select-text">
          {code}
        </pre>
      </div>
    </Modal>
  )
}
