import { useMemo, useState } from 'react'
import {
  ArrowUpCircle,
  Copy,
  FolderInput,
  PackagePlus,
  Puzzle,
  RefreshCw,
  Trash2
} from 'lucide-react'
import { api, type ConnectionConfig, type ResultSet } from '@/lib/api'
import {
  canUninstallPlugin,
  createExtensionSql,
  dropExtensionSql,
  extensionHint,
  extensionsSql,
  installPluginSql,
  installSonameSql,
  isInstalledPlugin,
  moveExtensionSql,
  parsePgExtensions,
  parsePlugins,
  pgUpdateAvailable,
  uninstallPluginSql,
  updateExtensionSql,
  type ExtensionFlavor,
  type PgExtension,
  type Plugin
} from '@/lib/extensions'
import { confirmProductionWrite } from '@/lib/production'
import { toast, toastError } from '@/lib/toast'
import { confirm } from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'
import { ResultGrid } from '@/components/grid/ResultGrid'
import { Badge, Button, EmptyState, ErrorText, Input, Segmented, Select } from '@/components/ui'
import { SectionHeading } from './PerformancePanels'
import { useSqlPanel } from './useSqlPanel'

type Show = 'installed' | 'available' | 'all'

/** The inline form above the grid: installing, moving a PostgreSQL extension, or a plugin by name */
type Form =
  | { kind: 'create'; ext: PgExtension; schema: string; version: string; cascade: boolean }
  | { kind: 'move'; ext: PgExtension; schema: string }
  | { kind: 'plugin'; name: string; library: string }

const copy = (text: string): void =>
  void navigator.clipboard.writeText(text).then(() => toast('Copied to the clipboard'), toastError)

/**
 * PostgreSQL extensions of one database, or MySQL / MariaDB plugins, with install, update and
 * removal. Every change is shown and confirmed before it runs.
 */
export function ExtensionsPanel({
  connection,
  flavor,
  databases,
  defaultDatabase
}: {
  connection: ConnectionConfig
  flavor: ExtensionFlavor
  databases: string[]
  defaultDatabase: string
}): React.JSX.Element {
  const pg = flavor === 'postgres'
  const [database, setDatabase] = useState('')
  const db = pg ? database || defaultDatabase : ''
  const panel = useSqlPanel(connection, extensionsSql(flavor), db)
  const [show, setShow] = useState<Show>('installed')
  const [filter, setFilter] = useState('')
  const [form, setForm] = useState<Form | null>(null)
  const readOnly = !!connection.readOnly

  const extensions = useMemo(() => (pg ? parsePgExtensions(panel.set) : []), [pg, panel.set])
  const plugins = useMemo(() => (pg ? [] : parsePlugins(panel.set)), [pg, panel.set])
  const installed = useMemo(
    () => (pg ? extensions.map((e) => !!e.installedVersion) : plugins.map(isInstalledPlugin)),
    [pg, extensions, plugins]
  )

  // Row indexes of the raw set that pass the filters, so menus can find the item behind a row
  const visible = useMemo(() => {
    const rows = panel.set?.rows ?? []
    const needle = filter.trim().toLowerCase()
    return rows
      .map((_, i) => i)
      .filter((i) => {
        const on = installed[i]
        if (show === 'installed' && !on) return false
        if (show === 'available' && on) return false
        if (!needle) return true
        return rows[i]!.some((c) => c !== null && String(c).toLowerCase().includes(needle))
      })
  }, [panel.set, installed, show, filter])
  const shown = useMemo<ResultSet | null>(
    () =>
      panel.set && {
        ...panel.set,
        rows: visible.map((i) => panel.set!.rows[i]!),
        rowCount: visible.length
      },
    [panel.set, visible]
  )
  const installedCount = installed.filter(Boolean).length
  // MySQL lists installed plugins only
  const canBrowse = flavor !== 'mysql'

  const run = async (
    sql: string,
    {
      title,
      message,
      danger,
      done
    }: { title: string; message: string; danger?: boolean; done: string }
  ): Promise<void> => {
    const ok = await confirm({ title, message, code: sql, confirmLabel: 'Run', danger })
    if (!ok) return
    // Plugin statements aren't data writes, so the production guard is asked explicitly
    const allowed = await confirmProductionWrite(connection, {
      action: pg ? `This changes the extensions of ${db}` : 'This changes server-wide plugins',
      dangers: danger ? [title.replace(/\?$/, '')] : [],
      code: sql
    })
    if (!allowed) return
    try {
      const out = await api.execute(connection.id, '__meta', db, sql, { confirmed: true })
      if (out.error) {
        const hint = extensionHint(out.error.message, flavor)
        throw new Error(hint ? `${out.error.message}\n${hint}` : out.error.message)
      }
      toast(done)
      setForm(null)
      panel.reload()
    } catch (e) {
      toastError(e)
    }
  }

  const pgMenu = (ext: PgExtension): MenuItem[] => {
    const create = createExtensionSql({ name: ext.name, schema: ext.schema ?? undefined })
    if (!ext.installedVersion)
      return [
        {
          label: 'Install…',
          icon: <PackagePlus />,
          disabled: readOnly || !ext.defaultVersion,
          onSelect: () =>
            setForm({
              kind: 'create',
              ext,
              schema: '',
              version: '',
              cascade: ext.requires.length > 0
            })
        },
        { label: 'Copy CREATE EXTENSION', icon: <Copy />, onSelect: () => copy(create) }
      ]
    return [
      {
        label: pgUpdateAvailable(ext) ? `Update to ${ext.defaultVersion}` : 'Up to date',
        icon: <ArrowUpCircle />,
        disabled: readOnly || !pgUpdateAvailable(ext),
        onSelect: () =>
          void run(updateExtensionSql(ext.name), {
            title: `Update ${ext.name}?`,
            message: `Updates ${ext.name} from ${ext.installedVersion} to ${ext.defaultVersion} in ${db}. Some updates need the new library loaded first, which can mean a server restart.`,
            done: `${ext.name} updated to ${ext.defaultVersion}`
          })
      },
      {
        label: 'Move to schema…',
        icon: <FolderInput />,
        disabled: readOnly || !ext.relocatable,
        onSelect: () => setForm({ kind: 'move', ext, schema: ext.schema ?? '' })
      },
      { label: 'Copy CREATE EXTENSION', icon: <Copy />, onSelect: () => copy(create) },
      'separator',
      {
        label: 'Drop',
        icon: <Trash2 />,
        danger: true,
        disabled: readOnly,
        onSelect: () =>
          void run(dropExtensionSql(ext.name), {
            title: `Drop extension ${ext.name}?`,
            message: `Removes ${ext.name} and the functions, types and operators it created from ${db}. It fails if anything else uses them.`,
            danger: true,
            done: `${ext.name} dropped`
          })
      },
      {
        label: 'Drop with CASCADE',
        icon: <Trash2 />,
        danger: true,
        disabled: readOnly,
        onSelect: () =>
          void run(dropExtensionSql(ext.name, true), {
            title: `Drop extension ${ext.name} with CASCADE?`,
            message: `Removes ${ext.name} from ${db} along with everything that depends on it, including table columns of its types and indexes using its operators.`,
            danger: true,
            done: `${ext.name} dropped`
          })
      }
    ]
  }

  const pluginMenu = (p: Plugin): MenuItem[] => {
    if (!isInstalledPlugin(p)) {
      const library = p.library
      if (!library) return []
      return [
        {
          label: 'Install',
          icon: <PackagePlus />,
          disabled: readOnly,
          onSelect: () =>
            void run(installPluginSql(p.name, library), {
              title: `Install ${p.name}?`,
              message: `Loads the ${p.type.toLowerCase()} plugin ${p.name} from ${library}. It is recorded in mysql.plugin, so it loads again after a restart.`,
              done: `${p.name} installed`
            })
        },
        {
          label: `Install everything in ${library}`,
          icon: <PackagePlus />,
          disabled: readOnly,
          onSelect: () =>
            void run(installSonameSql(library), {
              title: `Install the plugins in ${library}?`,
              message: `Loads every plugin ${library} contains and records them in mysql.plugin.`,
              done: `Plugins in ${library} installed`
            })
        },
        {
          label: 'Copy INSTALL PLUGIN',
          icon: <Copy />,
          onSelect: () => copy(installPluginSql(p.name, library))
        }
      ]
    }
    return [
      {
        label: p.library ? 'Uninstall' : 'Built into the server',
        icon: <Trash2 />,
        danger: true,
        disabled: readOnly || !canUninstallPlugin(p),
        onSelect: () =>
          void run(uninstallPluginSql(p.name), {
            title: `Uninstall plugin ${p.name}?`,
            message: `Unloads ${p.name} and removes it from mysql.plugin. Tables using a storage engine plugin can't be opened until it's installed again.${
              p.loadOption === 'FORCE' || p.loadOption === 'FORCE_PLUS_PERMANENT'
                ? ` Its load option is ${p.loadOption}, so the server may refuse.`
                : ''
            }`,
            danger: true,
            done: `${p.name} uninstalled`
          })
      }
    ]
  }

  const menu = (row: number): MenuItem[] => {
    const i = visible[row]
    if (i === undefined) return []
    const items = pg
      ? extensions[i]
        ? pgMenu(extensions[i])
        : []
      : plugins[i]
        ? pluginMenu(plugins[i])
        : []
    return items.length ? ['separator', ...items] : []
  }

  const noun = pg ? 'extensions' : 'plugins'
  return (
    <section>
      <SectionHeading icon={<Puzzle className="size-3.5" />} title={pg ? 'Extensions' : 'Plugins'}>
        <Button size="icon-sm" variant="ghost" onClick={panel.reload} title="Refresh">
          <RefreshCw className={panel.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        {panel.set && (
          <Badge tone="neutral" className="normal-case">
            {installedCount} installed
          </Badge>
        )}
        <span className="ml-auto text-[11px] font-normal tracking-normal text-faint normal-case">
          {pg
            ? `pg_available_extensions in ${db || 'the default database'} · right-click to install, update or drop`
            : flavor === 'mariadb'
              ? 'information_schema.ALL_PLUGINS · right-click to install or uninstall'
              : 'information_schema.PLUGINS · right-click to uninstall'}
        </span>
      </SectionHeading>

      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px]">
        {canBrowse && (
          <Segmented
            size="sm"
            value={show}
            onChange={setShow}
            options={[
              { value: 'installed', label: 'Installed' },
              { value: 'available', label: 'Available', title: `${noun} that can be installed` },
              { value: 'all', label: 'All' }
            ]}
          />
        )}
        {pg && databases.length > 1 && (
          <Select
            value={db}
            onChange={(e) => {
              setDatabase(e.target.value)
              setForm(null)
            }}
            className="w-44"
            selectClassName="h-6 text-[11.5px]"
            title="Extensions are installed per database"
          >
            {!databases.includes(db) && <option value={db}>{db}</option>}
            {databases.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        )}
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${noun}…`}
          className="h-6 w-48 text-[11.5px]"
        />
        {!pg && (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={readOnly}
            title={
              readOnly
                ? 'This connection is read-only'
                : 'Install a plugin from a library in plugin_dir'
            }
            onClick={() => setForm({ kind: 'plugin', name: '', library: '' })}
          >
            <PackagePlus className="size-3.5" /> Install plugin…
          </Button>
        )}
      </div>

      {form && (
        <FormBar
          form={form}
          flavor={flavor}
          onChange={setForm}
          onCancel={() => setForm(null)}
          onRun={(sql) => {
            if (form.kind === 'create')
              void run(sql, {
                title: `Install ${form.ext.name}?`,
                message: `Creates the ${form.ext.name} extension in ${db}.${
                  form.ext.superuser && !form.ext.trusted
                    ? ' It is not a trusted extension, so this needs a superuser.'
                    : ''
                }`,
                done: `${form.ext.name} installed`
              })
            else if (form.kind === 'move')
              void run(sql, {
                title: `Move ${form.ext.name}?`,
                message: `Moves the objects of ${form.ext.name} to schema ${form.schema}. Code that names them with the old schema stops finding them.`,
                done: `${form.ext.name} moved to ${form.schema}`
              })
            else
              void run(sql, {
                title: 'Install plugin?',
                message:
                  'Loads the plugin and records it in mysql.plugin so it loads again after a restart.',
                done: 'Plugin installed'
              })
          }}
        />
      )}

      <div className="h-80 overflow-hidden rounded-lg border border-line">
        {panel.error ? (
          <div className="space-y-2 p-4">
            <ErrorText error={panel.error} />
            {extensionHint(panel.error, flavor) && (
              <p className="text-xs text-muted">{extensionHint(panel.error, flavor)}</p>
            )}
          </div>
        ) : shown ? (
          shown.rows.length ? (
            <ResultGrid columns={shown.columns} rows={shown.rows} cellMenuItems={menu} />
          ) : (
            <EmptyState
              title={
                filter.trim()
                  ? `No ${noun} match the filter`
                  : show === 'available'
                    ? `No other ${noun} are available on the server`
                    : `No ${noun} installed`
              }
            />
          )
        ) : (
          <EmptyState title="Loading…" />
        )}
      </div>
    </section>
  )
}

function FormBar({
  form,
  flavor,
  onChange,
  onCancel,
  onRun
}: {
  form: Form
  flavor: ExtensionFlavor
  onChange: (form: Form) => void
  onCancel: () => void
  onRun: (sql: string) => void
}): React.JSX.Element {
  const sql =
    form.kind === 'create'
      ? createExtensionSql({
          name: form.ext.name,
          schema: form.schema,
          version: form.version,
          cascade: form.cascade
        })
      : form.kind === 'move'
        ? moveExtensionSql(form.ext.name, form.schema)
        : form.name.trim()
          ? installPluginSql(form.name, form.library)
          : installSonameSql(form.library)
  const ready =
    form.kind === 'move'
      ? !!form.schema.trim() && form.schema.trim() !== form.ext.schema
      : form.kind === 'plugin'
        ? !!form.library.trim() && (flavor === 'mariadb' || !!form.name.trim())
        : true
  const field = 'h-6 text-[11.5px]'
  return (
    <div className="mb-2 space-y-2 rounded-lg border border-line bg-panel/70 p-3 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-2">
        {form.kind === 'create' && (
          <>
            <span className="font-medium text-bright">{form.ext.name}</span>
            <Input
              value={form.schema}
              onChange={(e) => onChange({ ...form, schema: e.target.value })}
              placeholder="Schema (default)"
              className={`${field} w-40`}
              title="Schema for the extension's objects; empty uses the extension's own or the current schema"
            />
            {form.ext.versions.length > 1 && (
              <Select
                value={form.version}
                onChange={(e) => onChange({ ...form, version: e.target.value })}
                className="w-36"
                selectClassName={field}
              >
                <option value="">Version {form.ext.defaultVersion} (default)</option>
                {form.ext.versions
                  .filter((v) => v !== form.ext.defaultVersion)
                  .map((v) => (
                    <option key={v} value={v}>
                      Version {v}
                    </option>
                  ))}
              </Select>
            )}
            <label
              className="flex items-center gap-1.5"
              title={
                form.ext.requires.length
                  ? `Requires ${form.ext.requires.join(', ')}`
                  : 'It requires no other extensions'
              }
            >
              <input
                type="checkbox"
                checked={form.cascade}
                onChange={(e) => onChange({ ...form, cascade: e.target.checked })}
              />
              Also install required extensions
              {form.ext.requires.length > 0 && ` (${form.ext.requires.join(', ')})`}
            </label>
          </>
        )}
        {form.kind === 'move' && (
          <>
            <span className="font-medium text-bright">{form.ext.name}</span>
            <span>from {form.ext.schema} to</span>
            <Input
              autoFocus
              value={form.schema}
              onChange={(e) => onChange({ ...form, schema: e.target.value })}
              placeholder="Schema"
              className={`${field} w-40`}
            />
          </>
        )}
        {form.kind === 'plugin' && (
          <>
            <Input
              autoFocus
              value={form.name}
              onChange={(e) => onChange({ ...form, name: e.target.value })}
              placeholder={
                flavor === 'mariadb' ? 'Plugin name (empty: all in library)' : 'Plugin name'
              }
              className={`${field} w-56`}
            />
            <Input
              value={form.library}
              onChange={(e) => onChange({ ...form, library: e.target.value })}
              placeholder={
                flavor === 'mariadb' ? 'Library, e.g. ha_rocksdb' : 'Library, e.g. ha_example.so'
              }
              className={`${field} w-56`}
              title="A shared library in the server's plugin_dir"
            />
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-md bg-canvas px-2 py-1 font-mono text-[11.5px] text-fg select-text">
          {sql}
        </code>
        <Button size="xs" variant="ghost" onClick={() => copy(sql)}>
          <Copy className="size-3.5" /> Copy
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={!ready} onClick={() => onRun(sql)}>
          {form.kind === 'move' ? 'Move…' : 'Install…'}
        </Button>
      </div>
    </div>
  )
}
