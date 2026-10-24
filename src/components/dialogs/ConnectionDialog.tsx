import { useMemo, useState } from 'react'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Cloud,
  FilePlus2,
  FolderOpen,
  Info,
  Loader2,
  XCircle
} from 'lucide-react'
import { api, type ConnectionConfig, type Engine, type ServerInfo } from '@/lib/api'
import { PROVIDERS, isMajorCloud, providerForHost, type MajorCloud } from '@/lib/cloud'
import { cn } from '@/lib/cn'
import {
  CONNECTION_COLORS,
  ENGINE_ORDER,
  ENGINES,
  newConnection,
  parseConnectionString
} from '@/lib/engines'
import { errorMessage, toast, toastError } from '@/lib/toast'
import {
  closeConnectionDialog,
  connect,
  connectionDialogStore,
  connectionsStore,
  loadConnections,
  disconnect,
  openCloud,
  statusOf
} from '@/lib/workspace'
import { Button, EngineMark, Field, Input, Modal, Segmented, Select, Textarea, Toggle } from '../ui'
import { SshFields } from './SshFields'

export function ConnectionDialogHost(): React.JSX.Element | null {
  const state = connectionDialogStore.use()
  if (!state.open) return null
  return (
    <ConnectionDialog
      key={state.editing?.id ?? 'new'}
      editing={state.editing}
      duplicate={state.duplicate}
      prefill={state.prefill}
    />
  )
}

type TestState =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; info: ServerInfo }
  | { state: 'error'; error: string }

function ConnectionDialog({
  editing,
  duplicate,
  prefill
}: {
  editing?: ConnectionConfig
  duplicate?: boolean
  prefill?: { config: ConnectionConfig; password?: string }
}): React.JSX.Element {
  const isNew = !editing || duplicate
  const [config, setConfig] = useState<ConnectionConfig | null>(() =>
    editing
      ? {
          ...editing,
          ...(duplicate ? { id: '', name: `${editing.name || editing.host} copy` } : {})
        }
      : (prefill?.config ?? null)
  )
  const [password, setPassword] = useState(prefill?.password ?? '')
  const [sshSecret, setSshSecret] = useState('')
  const [paste, setPaste] = useState('')
  const [test, setTest] = useState<TestState>({ state: 'idle' })
  const [saving, setSaving] = useState(false)
  // MongoDB and Redis connect with either a connection string or host and port
  const [uriMode, setUriMode] = useState<'uri' | 'fields'>(
    editing && !editing.uri ? 'fields' : 'uri'
  )
  const groups = useMemo(
    () =>
      [
        ...new Set(
          connectionsStore
            .get()
            .map((c) => c.group)
            .filter(Boolean)
        )
      ].sort(),
    []
  )

  const patch = (p: Partial<ConnectionConfig>): void => {
    setConfig((c) => (c ? { ...c, ...p } : c))
    setTest({ state: 'idle' })
  }

  const pickEngine = (engine: Engine): void => {
    setConfig(newConnection(engine))
    // Most Redis servers are local or reached by host; Atlas hands out strings
    setUriMode(engine === 'redis' ? 'fields' : 'uri')
  }

  const applyPaste = (text: string): boolean => {
    const parsed = parseConnectionString(text)
    if (!parsed) return false
    setConfig((c) => ({
      ...(c && c.engine === parsed.engine ? c : newConnection(parsed.engine)),
      ...parsed.patch
    }))
    if (parsed.password) setPassword(parsed.password)
    if (parsed.engine === 'mongo' || parsed.engine === 'redis') setUriMode('uri')
    setPaste('')
    setTest({ state: 'idle' })
    return true
  }

  if (!config) {
    return (
      <Modal
        title="New connection"
        description="Pick a database engine, or paste a connection string."
        onClose={closeConnectionDialog}
        width="lg"
      >
        <div className="grid grid-cols-2 gap-2.5">
          {ENGINE_ORDER.map((engine) => {
            const info = ENGINES[engine]
            return (
              <button
                key={engine}
                type="button"
                onClick={() => pickEngine(engine)}
                className={cn(
                  'flex items-start gap-3 rounded-lg border border-line-strong bg-raised/60 p-3 text-left transition-colors hover:border-accent/50 hover:bg-hover',
                  // An odd engine out spans the last row
                  ENGINE_ORDER.length % 2 === 1 &&
                    engine === ENGINE_ORDER[ENGINE_ORDER.length - 1] &&
                    'col-span-2'
                )}
              >
                <EngineMark engine={engine} size="lg" />
                <span className="min-w-0">
                  <span className="block font-medium text-bright">{info.label}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted">
                    {info.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => {
            closeConnectionDialog()
            openCloud()
          }}
          className="mt-2.5 flex w-full items-center gap-3 rounded-lg border border-line-strong bg-raised/60 p-3 text-left transition-colors hover:border-accent/50 hover:bg-hover"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-info/15 text-info">
            <Cloud className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-bright">Cloud databases</span>
            <span className="mt-0.5 block text-xs leading-snug text-muted">
              Find databases in AWS, Google Cloud or Azure, or provision a new one
            </span>
          </span>
          <ChevronRight className="size-4 text-faint" />
        </button>
        <div className="mt-4">
          <Field
            label="Or paste a connection string"
            hint="postgres://…, mysql://…, mongodb+srv://…, redis://… or an ADO.NET string like Server=…;Database=…"
          >
            <div className="flex gap-2">
              <Input
                mono
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !applyPaste(paste))
                    toast('Unrecognised connection string', 'error')
                }}
                placeholder="mongodb+srv://user:pass@cluster0.example.net/app"
              />
              <Button
                variant="secondary"
                onClick={async () => {
                  const text = paste || (await navigator.clipboard.readText().catch(() => ''))
                  if (!applyPaste(text)) toast('Unrecognised connection string', 'error')
                }}
              >
                <ClipboardPaste className="size-3.5" /> {paste ? 'Use' : 'Paste'}
              </Button>
            </div>
          </Field>
        </div>
      </Modal>
    )
  }

  const info = ENGINES[config.engine]
  const tds = config.engine === 'mssql' || config.engine === 'babelfish'
  const hasUriForm = config.engine === 'mongo' || config.engine === 'redis'
  const usesUri = hasUriForm && uriMode === 'uri'
  const hasSavedPassword = !!editing?.savePassword && !duplicate
  const needsUser = !(tds && config.auth === 'windows')
  const sqlite = config.engine === 'sqlite'
  // A SQLite connection is either a local file (host) or a D1 database (cloud ref)
  const d1 = sqlite && config.cloud?.provider === 'cloudflare'
  const SQLITE_FILES = [
    { name: 'SQLite databases', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
    { name: 'All files', extensions: ['*'] }
  ]
  const useFile = (path: string): void =>
    patch({ host: path, name: config.name || (path.split(/[\\/]/).pop() ?? '') })
  const browseSqlite = async (): Promise<void> => {
    const path = await openDialog({ multiple: false, filters: SQLITE_FILES })
    if (typeof path === 'string') useFile(path)
  }
  const newSqliteFile = async (): Promise<void> => {
    const path = await saveDialog({ defaultPath: 'database.db', filters: SQLITE_FILES })
    if (!path) return
    try {
      // SQLite treats an empty file as an empty database
      await api.writeText(path, '')
      useFile(path)
    } catch (e) {
      toastError(e)
    }
  }
  const cloudAuth = config.auth === 'cloud'
  // Babelfish's TDS endpoint has no IAM sign-in
  const iamCapable =
    config.engine === 'postgres' || config.engine === 'mysql' || config.engine === 'mssql'
  const guessed = config.cloud?.provider ?? providerForHost(config.host)
  const cloudProvider: MajorCloud = guessed && isMajorCloud(guessed) ? guessed : 'aws'
  const setCloud = (patchCloud: Partial<NonNullable<ConnectionConfig['cloud']>>): void =>
    patch({
      cloud: {
        provider: cloudProvider,
        context: '',
        region: '',
        resource: '',
        kind: '',
        ...config.cloud,
        ...patchCloud
      }
    })

  const effective = (): ConnectionConfig => ({
    ...config,
    uri: usesUri ? config.uri : ''
  })

  const runTest = async (): Promise<void> => {
    setTest({ state: 'testing' })
    try {
      const info = await api.connectionTest(effective(), password || null, sshSecret)
      setTest({ state: 'ok', info })
    } catch (e) {
      setTest({ state: 'error', error: errorMessage(e) })
    }
  }

  const save = async (andConnect: boolean): Promise<void> => {
    setSaving(true)
    try {
      const saved = await api.connectionSave(effective(), password || null, sshSecret)
      await loadConnections()
      closeConnectionDialog()
      toast(isNew ? `Added ${saved.name || saved.host}` : `Saved ${saved.name || saved.host}`)
      // Reconnect so edited settings take effect
      if (!isNew && statusOf(saved.id).state === 'connected') await disconnect(saved.id)
      if (andConnect) await connect(saved.id)
    } catch (e) {
      toastError(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      width="lg"
      icon={<EngineMark engine={config.engine} size="lg" />}
      title={isNew ? `New ${info.label} connection` : `Edit ${editing?.name || editing?.host}`}
      description={info.description}
      onClose={closeConnectionDialog}
      footer={
        <>
          {isNew && !editing && (
            <Button variant="ghost" size="sm" onClick={() => setConfig(null)} className="mr-auto">
              <ChevronLeft className="size-3.5" /> Engines
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => void runTest()}
            disabled={test.state === 'testing'}
          >
            {test.state === 'testing' && <Loader2 className="size-3.5 animate-spin" />}
            Test
          </Button>
          <Button variant="secondary" onClick={() => void save(false)} disabled={saving}>
            Save
          </Button>
          <Button variant="primary" onClick={() => void save(true)} disabled={saving}>
            Save &amp; connect
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save(true)
        }}
      >
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <Field label="Name">
            <Input
              value={config.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder={`e.g. ${config.engine === 'mongo' ? 'Atlas prod' : config.engine === 'redis' ? 'Session cache' : 'Local dev'}`}
            />
          </Field>
          <Field label="Colour">
            <div className="flex h-8 items-center gap-1">
              {CONNECTION_COLORS.map((c) => (
                <button
                  key={c.value || 'none'}
                  type="button"
                  title={c.label}
                  onClick={() => patch({ color: c.value })}
                  className={cn(
                    'size-5 rounded-full ring-offset-2 ring-offset-panel transition',
                    config.color === c.value ? 'ring-2 ring-bright' : 'hover:scale-110',
                    !c.value && 'border border-dashed border-faint'
                  )}
                  style={c.value ? { background: c.value } : undefined}
                />
              ))}
            </div>
          </Field>
        </div>

        {config.engine === 'babelfish' && (
          <div className="flex gap-2.5 rounded-lg border border-babelfish/25 bg-babelfish/5 p-3 text-xs leading-relaxed text-fg">
            <Info className="mt-0.5 size-3.5 shrink-0 text-babelfish" />
            <span>
              Connect to the cluster&apos;s <b className="text-bright">T-SQL endpoint</b> (TDS, port
              1433 by default). Use T-SQL database names, not the underlying PostgreSQL{' '}
              <span className="font-mono">babelfish_db</span>. Aurora requires TLS; keep{' '}
              <i>Trust server certificate</i> on unless the RDS CA is installed on this machine.
            </span>
          </div>
        )}

        {hasUriForm && (
          <Segmented
            value={uriMode}
            onChange={(m) => {
              setUriMode(m)
              setTest({ state: 'idle' })
            }}
            options={[
              { value: 'uri', label: 'Connection string' },
              { value: 'fields', label: 'Host & port' }
            ]}
          />
        )}

        {sqlite ? (
          <div className="space-y-3">
            <Segmented
              value={d1 ? 'd1' : 'file'}
              onChange={(source) =>
                patch(
                  source === 'd1'
                    ? {
                        host: '',
                        cloud: {
                          provider: 'cloudflare',
                          context: '',
                          region: '',
                          resource: '',
                          kind: 'd1'
                        }
                      }
                    : { cloud: null }
                )
              }
              options={[
                { value: 'file', label: 'Database file' },
                { value: 'd1', label: 'Cloudflare D1' }
              ]}
            />
            {d1 ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Account ID">
                    <Input
                      mono
                      value={config.cloud?.context ?? ''}
                      onChange={(e) => setCloud({ context: e.target.value.trim() })}
                      placeholder="From the Cloudflare dashboard URL"
                    />
                  </Field>
                  <Field label="Database ID">
                    <Input
                      mono
                      value={config.cloud?.resource ?? ''}
                      onChange={(e) => setCloud({ resource: e.target.value.trim() })}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    />
                  </Field>
                </div>
                <Field
                  label="API token (optional)"
                  hint="Needs the D1 Read or D1 Edit permission. Leave it empty to use the token saved in the Cloud databases tab."
                >
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                      setTest({ state: 'idle' })
                    }}
                    placeholder={hasSavedPassword ? '•••••••• (saved)' : 'Cloud databases token'}
                  />
                </Field>
              </>
            ) : (
              <Field
                label="Database file"
                hint="A .db, .sqlite or .sqlite3 file. New file creates an empty database."
              >
                <div className="flex gap-2">
                  <Input
                    mono
                    value={config.host}
                    onChange={(e) => patch({ host: e.target.value })}
                    placeholder="/path/to/app.db"
                  />
                  <Button variant="secondary" onClick={() => void browseSqlite()}>
                    <FolderOpen className="size-3.5" /> Browse
                  </Button>
                  <Button variant="secondary" onClick={() => void newSqliteFile()}>
                    <FilePlus2 className="size-3.5" /> New file
                  </Button>
                </div>
              </Field>
            )}
          </div>
        ) : usesUri ? (
          <Field
            label="Connection string"
            hint="Credentials in the string are stored with the connection. Leave the password out to be asked each time, or type it below."
          >
            <Textarea
              mono
              rows={3}
              value={config.uri}
              onChange={(e) => patch({ uri: e.target.value })}
              placeholder={
                config.engine === 'redis'
                  ? 'rediss://default@example.upstash.io:6379/0'
                  : 'mongodb+srv://user@cluster0.example.net/?retryWrites=true&w=majority'
              }
            />
          </Field>
        ) : (
          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <Field
              label="Host"
              hint={
                tds ? 'Use host\\INSTANCE for a named instance (leave the port empty).' : undefined
              }
            >
              <Input
                value={config.host}
                onChange={(e) => patch({ host: e.target.value })}
                placeholder="localhost"
              />
            </Field>
            <Field label="Port">
              <Input
                value={config.port ? String(config.port) : ''}
                onChange={(e) => patch({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })}
                placeholder={String(info.defaultPort)}
                inputMode="numeric"
              />
            </Field>
          </div>
        )}

        {(tds || iamCapable) && (
          <Field label="Authentication">
            <Segmented
              value={config.auth}
              onChange={(auth) => {
                patch({ auth })
                if (auth === 'cloud' && !config.cloud) setCloud({})
              }}
              options={[
                { value: 'password', label: tds ? 'SQL login' : 'Password' },
                ...(tds ? [{ value: 'windows' as const, label: 'Windows' }] : []),
                ...(iamCapable ? [{ value: 'cloud' as const, label: 'Cloud IAM' }] : [])
              ]}
            />
          </Field>
        )}

        {cloudAuth && (
          <div className="space-y-3 rounded-lg border border-info/25 bg-info/5 p-3">
            <div className="grid grid-cols-[auto_1fr] items-end gap-3">
              <Field label="Provider">
                <Segmented
                  value={cloudProvider}
                  onChange={(provider) =>
                    setCloud({
                      provider,
                      context: provider === config.cloud?.provider ? config.cloud.context : ''
                    })
                  }
                  options={IAM_PROVIDERS.map((p) => ({ value: p, label: PROVIDERS[p].label }))}
                />
              </Field>
              <Field label={`${PROVIDERS[cloudProvider].contextLabel} (optional)`}>
                <Input
                  value={config.cloud?.context ?? ''}
                  onChange={(e) => setCloud({ context: e.target.value })}
                  placeholder={`The ${PROVIDERS[cloudProvider].cli} CLI's default`}
                />
              </Field>
            </div>
            <p className="text-xs leading-relaxed text-fg">{IAM_HINTS[cloudProvider]}</p>
            {config.engine === 'mssql' && cloudProvider !== 'azure' && (
              <p className="text-xs text-danger">
                SQL Server only supports passwordless sign-in on Azure (Microsoft Entra ID).
              </p>
            )}
          </div>
        )}

        {!sqlite && (
          <div className="grid grid-cols-2 gap-3">
            {(needsUser || config.auth === 'windows') && !usesUri && (
              <Field
                label={
                  config.auth === 'windows'
                    ? 'Domain user (optional)'
                    : config.engine === 'redis'
                      ? 'ACL user (optional)'
                      : 'User'
                }
              >
                <Input
                  value={config.user}
                  onChange={(e) => patch({ user: e.target.value })}
                  placeholder={
                    config.auth === 'windows'
                      ? 'Current Windows user'
                      : config.engine === 'redis'
                        ? 'default'
                        : info.defaultUser
                  }
                />
              </Field>
            )}
            {(needsUser || config.user) && !cloudAuth && (
              <Field label="Password">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    setTest({ state: 'idle' })
                  }}
                  placeholder={
                    hasSavedPassword
                      ? '•••••••• (saved)'
                      : usesUri
                        ? 'If not in the string'
                        : config.engine === 'redis'
                          ? 'Leave empty when AUTH is off'
                          : ''
                  }
                />
              </Field>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {config.engine !== 'mongo' && !sqlite && (
            <Field
              label="Database"
              hint={
                config.engine === 'postgres'
                  ? 'Defaults to postgres'
                  : config.engine === 'redis'
                    ? 'Database number to open; 0 when empty'
                    : 'Optional; the server default is used when empty'
              }
            >
              <Input
                value={config.database}
                onChange={(e) => patch({ database: e.target.value })}
                placeholder={info.defaultDatabase || (config.engine === 'redis' ? '0' : 'default')}
              />
            </Field>
          )}
          {config.engine === 'mongo' && !usesUri && (
            <Field label="Auth database">
              <Input
                value={config.authSource}
                onChange={(e) => patch({ authSource: e.target.value })}
                placeholder="admin"
              />
            </Field>
          )}
          {!sqlite && (
            <Field
              label={tds ? 'Encryption' : 'SSL / TLS'}
              hint={
                cloudAuth ? 'Always on: the access token must not travel in clear text' : undefined
              }
            >
              <Select
                value={cloudAuth ? 'require' : config.ssl}
                disabled={cloudAuth}
                onChange={(e) => patch({ ssl: e.target.value as ConnectionConfig['ssl'] })}
              >
                <option value="disable">{tds ? 'Off' : 'Disable'}</option>
                <option value="prefer">
                  {tds
                    ? 'Login only (default)'
                    : usesUri
                      ? 'As in the connection string'
                      : hasUriForm
                        ? 'Off'
                        : 'Prefer'}
                </option>
                <option value="require">{tds ? 'Mandatory' : 'Require'}</option>
              </Select>
            </Field>
          )}
        </div>

        {!sqlite && config.cloud?.provider !== 'fly' && (
          <SshFields
            ssh={config.ssh}
            onChange={(ssh) => patch({ ssh })}
            secret={sshSecret}
            onSecret={(s) => {
              setSshSecret(s)
              setTest({ state: 'idle' })
            }}
            hasSavedSecret={!duplicate && !!editing?.ssh && editing.ssh.auth !== 'agent'}
            uriMode={usesUri}
          />
        )}

        <div className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-lg border border-line bg-raised/40 p-3">
          <Toggle
            checked={config.savePassword && !cloudAuth && (!sqlite || d1)}
            onChange={(savePassword) => patch({ savePassword })}
            label={d1 ? 'Save token' : 'Save password'}
            description={
              cloudAuth
                ? 'Not needed: a token is fetched each time'
                : sqlite && !d1
                  ? 'SQLite files have no password'
                  : 'Stored in the OS credential manager'
            }
            disabled={cloudAuth || (sqlite && !d1)}
          />
          {!sqlite && (
            <Toggle
              checked={config.trustServerCertificate}
              onChange={(trustServerCertificate) => patch({ trustServerCertificate })}
              label="Trust server certificate"
              description="Accept self-signed TLS certificates"
            />
          )}
          <Toggle
            checked={config.readOnly}
            onChange={(readOnly) => patch({ readOnly })}
            label="Read-only"
            description="Block writes from editors and grids"
          />
          <Toggle
            checked={!!config.production}
            onChange={(production) =>
              // A production connection without a colour gets red, so it stands out in tabs
              patch(production && !config.color ? { production, color: '#ff6e61' } : { production })
            }
            label="Production"
            description="Confirm every write; type the name for destructive ones"
          />
          <Field label="Group">
            <Input
              value={config.group}
              onChange={(e) => patch({ group: e.target.value })}
              placeholder="e.g. Work"
              list="connection-groups"
            />
            <datalist id="connection-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
        </div>

        {test.state === 'ok' && (
          <div className="flex items-start gap-2.5 rounded-lg border border-ok/25 bg-ok/5 p-3 text-xs">
            <CheckCircle2 className="mt-px size-4 shrink-0 text-ok" />
            <div className="min-w-0">
              <p className="font-medium text-bright">Connected to {test.info.product}</p>
              <p className="mt-0.5 truncate text-muted" title={test.info.version}>
                {test.info.version.split('\n')[0]}
              </p>
              {test.info.babelfishVersion && config.engine !== 'babelfish' && (
                <p className="mt-1 text-babelfish">
                  This server is Babelfish {test.info.babelfishVersion}.{' '}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => patch({ engine: 'babelfish' })}
                  >
                    Switch to the Babelfish engine
                  </button>
                </p>
              )}
            </div>
          </div>
        )}
        {test.state === 'error' && (
          <div className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/5 p-3 text-xs">
            <XCircle className="mt-px size-4 shrink-0 text-danger" />
            <p className="min-w-0 break-words whitespace-pre-wrap text-fg select-text">
              {test.error}
            </p>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

/** The clouds that offer passwordless database sign-in. */
const IAM_PROVIDERS: MajorCloud[] = ['aws', 'gcp', 'azure']

const IAM_HINTS: Record<MajorCloud, string> = {
  aws: 'Signs in with a 15-minute token from "aws rds generate-db-auth-token". The user must be a database user granted rds_iam (PostgreSQL) or created with AWSAuthenticationPlugin (MySQL), and the instance needs IAM authentication turned on.',
  gcp: 'Signs in with a token from "gcloud sql generate-login-token". The user is your Google account added to the instance as an IAM user (for MySQL, the part before the @), with the cloudsql.iam_authentication flag on.',
  azure:
    'Signs in with a Microsoft Entra token from "az account get-access-token". The user is your Entra user principal name (e.g. you@contoso.com), set up as an Entra admin or database user.'
}
