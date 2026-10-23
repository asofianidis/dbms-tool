import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  CheckCircle2,
  Copy,
  Download,
  LogIn,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  UserPlus,
  X,
  XCircle
} from 'lucide-react'
import type { CloudProvider, ConnectionConfig } from '@/lib/api'
import {
  PROVIDERS,
  PROVIDER_ORDER,
  REGIONS,
  findSaved,
  regionLabel,
  type CloudDatabase
} from '@/lib/cloud'
import { cn } from '@/lib/cn'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { confirm, connectionsStore } from '@/lib/workspace'
import {
  Badge,
  Button,
  EmptyState,
  EngineMark,
  ErrorText,
  Eyebrow,
  Input,
  Segmented,
  Select,
  Spinner,
  Toolbar,
  ToolbarDivider
} from '@/components/ui'
import {
  cloudPrefsStore,
  cloudQueries,
  connectToCloudDatabase,
  dismissJob,
  jobsStore,
  forgetToken,
  refreshCloud,
  removeTokenAccount,
  saveToken,
  selectAccount,
  signIn,
  useAccounts,
  type ProvisionJob
} from './actions'
import { AccountDialog } from './AccountDialog'
import { DeleteDialog } from './DeleteDialog'
import { ProvisionDialog } from './ProvisionDialog'

export function CloudTab(): React.JSX.Element {
  const prefs = cloudPrefsStore.use()
  const provider = prefs.provider
  const info = PROVIDERS[provider]
  const tools = useQuery(cloudQueries.tools())
  // Token providers need no CLI; the others need theirs installed
  const installed =
    info.auth === 'token' || !!tools.data?.find((t) => t.provider === provider)?.path
  // Google accounts gcloud holds, or tokens added for other accounts; Azure's
  // subscriptions already span its accounts and AWS profiles are accounts
  const pickAccount = provider === 'gcp' || info.addAccount?.kind === 'token'
  const accounts = useAccounts(provider, installed && pickAccount)
  const savedAccount = prefs.account?.[provider] ?? ''
  const account =
    provider === 'gcp' || accounts.some((a) => a.id === savedAccount) ? savedAccount : ''
  const tokenAccount = !!account && info.addAccount?.kind === 'token'
  const context = prefs.context[provider] ?? ''
  const identity = useQuery({
    ...cloudQueries.identity(provider, context, account),
    enabled: installed
  })
  const signedIn = !!identity.data
  // Who the first account is, to name it in the account list
  const firstIdentity = useQuery({
    ...cloudQueries.identity(provider, '', ''),
    enabled: installed && pickAccount && (account !== '' || context !== '')
  })
  const contexts = useQuery({
    ...cloudQueries.contexts(provider, account),
    enabled: installed && ((info.auth === 'cli' && !tokenAccount) || signedIn)
  })
  const defaultRegion = useQuery({
    ...cloudQueries.defaultRegion(provider, context, account),
    enabled: installed && info.regionScoped
  })
  const region = info.regionScoped
    ? prefs.region[provider] || defaultRegion.data || REGIONS[provider][0].id
    : ''
  const databases = useQuery({
    ...cloudQueries.databases(provider, context, region, account),
    enabled: installed && signedIn && (!info.regionScoped || !defaultRegion.isLoading)
  })
  const [provisioning, setProvisioning] = useState(false)
  const [addingAccount, setAddingAccount] = useState(false)
  const jobs = jobsStore.use()

  const setPref = (key: 'context' | 'region', value: string): void =>
    cloudPrefsStore.set((p) => ({ ...p, [key]: { ...p[key], [provider]: value } }))

  const firstLabel =
    (account || context ? firstIdentity.data : identity.data) ||
    (info.auth === 'token' ? 'First token' : `${info.cli} sign-in`)
  const removeAccount = async (): Promise<void> => {
    const label = accounts.find((a) => a.id === account)?.label ?? account
    const ok = await confirm({
      title: `Remove ${label}?`,
      message: `Its API token is deleted from the OS credential manager. Saved connections to its databases stop working until you add it again.`,
      confirmLabel: 'Remove account'
    })
    if (ok) await removeTokenAccount(provider, account).catch(toastError)
  }

  const firstAccount = contexts.data?.contexts[0]?.label
  const defaultLabel =
    provider === 'gcp' && contexts.data?.defaultContext
      ? `Default (${contexts.data.defaultContext})`
      : provider === 'azure'
        ? `Default (${contexts.data?.contexts.find((c) => c.isDefault)?.label ?? 'current'})`
        : provider === 'railway'
          ? 'All projects'
          : provider === 'render'
            ? 'All workspaces'
            : provider === 'fly'
              ? 'Personal'
              : provider === 'cloudflare'
                ? (firstAccount ?? 'First account')
                : 'Default'

  return (
    <div className="flex h-full flex-col">
      <Toolbar>
        <Segmented
          size="sm"
          value={provider}
          onChange={(p: CloudProvider) => cloudPrefsStore.set((s) => ({ ...s, provider: p }))}
          options={PROVIDER_ORDER.map((p) => ({ value: p, label: PROVIDERS[p].label }))}
        />
        {installed && pickAccount && (
          <>
            <ToolbarDivider />
            <span className="text-xs text-muted">Account</span>
            <Select
              className="h-7 w-52 text-xs"
              value={account}
              onChange={(e) =>
                e.target.value === ADD_ACCOUNT
                  ? setAddingAccount(true)
                  : selectAccount(provider, e.target.value)
              }
            >
              <option value="">{firstLabel}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
              {/* gcloud lists an account it lost track of; keep it pickable */}
              {account && !accounts.some((a) => a.id === account) && (
                <option value={account}>{account}</option>
              )}
              <option value={ADD_ACCOUNT}>Add account…</option>
            </Select>
            {tokenAccount && (
              <Button
                size="icon"
                variant="ghost"
                className="hover:text-danger"
                title="Remove this account"
                onClick={() => void removeAccount()}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </>
        )}
        {installed && ((info.auth === 'cli' && !tokenAccount) || signedIn) && (
          <>
            <ToolbarDivider />
            <span className="text-xs text-muted">{info.contextLabel}</span>
            <Select
              className="h-7 w-52 text-xs"
              value={context}
              onChange={(e) => setPref('context', e.target.value)}
            >
              <option value="">{defaultLabel}</option>
              {contexts.data?.contexts
                // The empty choice already stands for these
                .filter(
                  (c) =>
                    !(provider === 'aws' && c.id === 'default') &&
                    !(provider === 'fly' && c.id === 'personal') &&
                    !(provider === 'cloudflare' && c.id === contexts.data?.contexts[0]?.id)
                )
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
            </Select>
            {info.regionScoped && (
              <>
                <span className="ml-1 text-xs text-muted">Region</span>
                <Select
                  className="h-7 w-56 text-xs"
                  value={region}
                  onChange={(e) => setPref('region', e.target.value)}
                >
                  {REGIONS[provider].map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label} · {r.id}
                    </option>
                  ))}
                  {!REGIONS[provider].some((r) => r.id === region) && (
                    <option value={region}>{region}</option>
                  )}
                </Select>
              </>
            )}
            <Button
              size="icon"
              variant="ghost"
              title="Refresh"
              onClick={() => refreshCloud(provider)}
            >
              <RefreshCw
                className={cn(
                  'size-3.5',
                  (databases.isFetching || identity.isFetching) && 'animate-spin'
                )}
              />
            </Button>
          </>
        )}
        <div className="flex-1" />
        {identity.data && (
          <span className="truncate text-[11px] text-faint" title={identity.data}>
            {identity.data}
          </span>
        )}
        {provider === 'azure' && signedIn && (
          <Button
            size="sm"
            variant="ghost"
            title="Sign in to another Azure account"
            onClick={() => setAddingAccount(true)}
          >
            <UserPlus className="size-3.5" /> Add account
          </Button>
        )}
        {info.auth === 'token' && signedIn && !account && (
          <Button
            size="sm"
            variant="ghost"
            title={`Remove the saved ${info.label} API token`}
            onClick={() => void forgetToken(provider).catch(toastError)}
          >
            Forget token
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={!installed || !signedIn}
          onClick={() => setProvisioning(true)}
        >
          <Plus className="size-3.5" /> New database
        </Button>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-6 px-6 py-5">
          {jobs.length > 0 && (
            <section>
              <Eyebrow className="mb-2">Provisioning</Eyebrow>
              <div className="space-y-2">
                {jobs.map((job) => (
                  <JobCard key={job.id} job={job} />
                ))}
              </div>
            </section>
          )}

          {tools.isLoading ? (
            <Spinner />
          ) : !installed ? (
            <SetupCard
              tone="info"
              title={`Install the ${info.label} CLI`}
              actions={
                <>
                  <Button variant="primary" onClick={() => void openUrl(info.installUrl)}>
                    <Download className="size-3.5" /> Installation guide
                  </Button>
                  <Button variant="secondary" onClick={() => refreshCloud()}>
                    Check again
                  </Button>
                </>
              }
            >
              dbms-tool talks to {info.label} through the official{' '}
              <span className="font-mono text-bright">{info.cli}</span> command-line tool, so it
              uses the same sign-in, profiles and permissions you already have. Install it, then
              come back here.
            </SetupCard>
          ) : identity.isLoading ? (
            <Spinner />
          ) : !signedIn && (info.auth === 'token' || tokenAccount) ? (
            <TokenCard provider={provider} account={account} error={identity.error} />
          ) : !signedIn ? (
            <SignInCard
              provider={provider}
              context={context}
              account={account}
              error={identity.error}
            />
          ) : (
            <DatabaseList
              provider={provider}
              region={region}
              result={databases.data}
              loading={databases.isLoading}
              error={databases.error}
              onNew={() => setProvisioning(true)}
            />
          )}
        </div>
      </div>

      {provisioning && (
        <ProvisionDialog
          provider={provider}
          account={account}
          context={context}
          region={region || prefs.region[provider] || ''}
          onClose={() => setProvisioning(false)}
        />
      )}
      {addingAccount && (
        <AccountDialog provider={provider} onClose={() => setAddingAccount(false)} />
      )}
    </div>
  )
}

/** The account list's last entry, which opens the add-account dialog. */
const ADD_ACCOUNT = '__add-account__'

function SetupCard({
  tone,
  title,
  children,
  actions
}: {
  tone: 'info' | 'warn'
  title: string
  children: React.ReactNode
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-xl border p-5',
        tone === 'info' ? 'border-info/25 bg-info/5' : 'border-warn/25 bg-warn/5'
      )}
    >
      <h2 className="text-[15px] font-semibold text-bright">{title}</h2>
      <div className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-fg">{children}</div>
      {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

function SignInCard({
  provider,
  context,
  account,
  error
}: {
  provider: CloudProvider
  context: string
  account: string
  error: unknown
}): React.JSX.Element {
  const info = PROVIDERS[provider]
  const [busy, setBusy] = useState(false)
  return (
    <SetupCard
      tone="warn"
      title={`Sign in to ${info.label}`}
      actions={
        <>
          {info.signIn && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await signIn(provider, context, account)
                } catch (e) {
                  toastError(e)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? <Spinner className="text-current" /> : <LogIn className="size-3.5" />}
              {busy ? 'Waiting for the browser…' : 'Sign in'}
            </Button>
          )}
          <Button variant="secondary" onClick={() => refreshCloud(provider)}>
            Check again
          </Button>
        </>
      }
    >
      <p>
        The <span className="font-mono text-bright">{info.cli}</span> CLI isn&apos;t signed in
        {account || context ? (
          <>
            {' '}
            for <span className="font-mono text-bright">{account || context}</span>
          </>
        ) : null}
        . {info.signInHint}
      </p>
      {!!error && (
        <p className="mt-2 font-mono text-[11.5px] break-words whitespace-pre-wrap text-muted select-text">
          {errorMessage(error)}
        </p>
      )}
    </SetupCard>
  )
}

function DatabaseList({
  provider,
  region,
  result,
  loading,
  error,
  onNew
}: {
  provider: CloudProvider
  region: string
  result?: { databases: CloudDatabase[]; errors: { label: string; message: string }[] }
  loading: boolean
  error: unknown
  onNew: () => void
}): React.JSX.Element {
  const connections = connectionsStore.use()
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <Spinner /> Looking for databases…
      </div>
    )
  }
  if (error) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
        <ErrorText error={error} />
      </div>
    )
  }
  const databases = result?.databases ?? []
  const where = region ? ` in ${regionLabel(provider, region)}` : ''
  return (
    <section>
      <Eyebrow className="mb-2">
        Databases{where} · {databases.length}
      </Eyebrow>
      {result?.errors.map((e) => (
        <p key={e.label} className="mb-2 flex gap-2 text-[11.5px] text-warn" title={e.message}>
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            Couldn&apos;t list {e.label}: {e.message}
          </span>
        </p>
      ))}
      {databases.length ? (
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel/80">
          {databases.map((db) => (
            <DatabaseRow
              key={`${db.ref.kind}:${db.ref.region}:${db.name}`}
              db={db}
              saved={findSaved(connections, db)}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-line-strong">
          <EmptyState title={`No databases found${where}`}>
            <span className="block">
              {PROVIDERS[provider].regionScoped ? 'Try another region, or ' : ''}
              provision one with the designer.
            </span>
            <Button variant="primary" size="sm" className="mt-3" onClick={onNew}>
              <Plus className="size-3.5" /> New database
            </Button>
          </EmptyState>
        </div>
      )}
    </section>
  )
}

function statusTone(db: CloudDatabase): 'success' | 'warning' | 'danger' | 'neutral' {
  if (db.ready) return 'success'
  if (/fail|error|incompatible|inaccessible/.test(db.status)) return 'danger'
  if (/stop|suspend|disabled/.test(db.status)) return 'neutral'
  return 'warning'
}

function DatabaseRow({
  db,
  saved
}: {
  db: CloudDatabase
  saved?: ConnectionConfig
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <EngineMark engine={db.engine} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-bright">{db.name}</span>
          <Badge tone={statusTone(db)}>{db.status || 'unknown'}</Badge>
          {saved && (
            <Badge tone="accent" title={`Saved as "${saved.name}"`}>
              saved
            </Badge>
          )}
          {db.iamAuth && (
            <Badge tone="info" title="Accepts passwordless sign-in with your cloud identity">
              IAM
            </Badge>
          )}
          {db.note && (
            <span title={db.note} className="text-warn">
              <TriangleAlert className="size-3.5" />
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted">
          <span className="shrink-0">{db.product}</span>
          {db.size && <span className="shrink-0 text-faint">· {db.size}</span>}
          {(db.location ?? db.ref.region) && (
            <span className="shrink-0 text-faint">· {db.location ?? db.ref.region}</span>
          )}
          {db.ref.resourceGroup && (
            <span className="truncate text-faint">· {db.ref.resourceGroup}</span>
          )}
        </div>
        {db.host && (
          <div className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-faint">
            <span className="truncate select-text">
              {db.host}
              {db.port ? `:${db.port}` : ''}
            </span>
            <button
              type="button"
              title="Copy endpoint"
              className="shrink-0 hover:text-bright"
              onClick={() => {
                void navigator.clipboard.writeText(db.host)
                toast('Endpoint copied')
              }}
            >
              <Copy className="size-3" />
            </button>
          </div>
        )}
      </div>
      <Button
        variant={saved ? 'secondary' : 'primary'}
        size="sm"
        disabled={(!db.host && !db.endpointOnConnect) || busy}
        title={db.host || db.endpointOnConnect ? undefined : 'No endpoint yet'}
        onClick={async () => {
          setBusy(true)
          try {
            await connectToCloudDatabase(db)
          } catch (e) {
            toastError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? <Spinner className="text-current" /> : <Plug className="size-3.5" />}
        {saved ? 'Open' : 'Connect'}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="hover:text-danger"
        title={`Delete ${db.name}…`}
        disabled={/delet/.test(db.status)}
        onClick={() => setDeleting(true)}
      >
        <Trash2 className="size-3.5" />
      </Button>
      {deleting && <DeleteDialog db={db} saved={saved} onClose={() => setDeleting(false)} />}
    </div>
  )
}

function JobCard({ job }: { job: ProvisionJob }): React.JSX.Element {
  const [open, setOpen] = useState(job.state === 'failed')
  const done = job.state === 'ready' || job.state === 'failed'
  return (
    <div
      className={cn(
        'rounded-lg border bg-panel/80',
        job.state === 'failed'
          ? 'border-danger/30'
          : job.state === 'ready'
            ? 'border-ok/30'
            : 'border-line'
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        {job.state === 'ready' ? (
          <CheckCircle2 className="size-4 shrink-0 text-ok" />
        ) : job.state === 'failed' ? (
          <XCircle className="size-4 shrink-0 text-danger" />
        ) : (
          <Spinner />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] text-bright">
            <span className="font-medium">{job.name}</span>
            <span className="text-muted">
              {' '}
              · {job.action === 'delete' ? 'Deleting ' : ''}
              {PROVIDERS[job.provider].label} {job.engineLabel}
            </span>
          </p>
          <p
            className={cn(
              'truncate text-[11.5px]',
              job.state === 'failed' ? 'text-danger' : 'text-muted'
            )}
          >
            {job.state === 'failed' ? job.error : job.activity}
            {!done && <Elapsed since={job.startedAt} />}
          </p>
        </div>
        <Button size="xs" variant="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide log' : 'Log'}
        </Button>
        {done && (
          <Button size="icon-sm" variant="ghost" title="Dismiss" onClick={() => dismissJob(job.id)}>
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      {open && (
        <pre className="max-h-56 overflow-auto border-t border-line bg-canvas px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap select-text">
          {job.log.map((l, i) => (
            <div
              key={i}
              className={cn(
                l.level === 'command' && 'text-faint',
                l.level === 'error' && 'text-danger',
                l.level === 'info' && 'text-fg'
              )}
            >
              {l.level === 'command' ? `$ ${l.text}` : l.text}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

function Elapsed({ since }: { since: number }): React.JSX.Element {
  const [, setTick] = useState(0)
  // Re-render every few seconds while the job runs
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 5000)
    return () => clearInterval(timer)
  }, [])
  const secs = Math.floor((Date.now() - since) / 1000)
  return (
    <span className="text-faint">
      {' '}
      · {Math.floor(secs / 60)}m {String(secs % 60).padStart(2, '0')}s
    </span>
  )
}

/**
 * Render and Cloudflare, or an account added with a token whose token stopped
 * working: paste an API token, kept in the OS credential manager.
 */
function TokenCard({
  provider,
  account,
  error
}: {
  provider: CloudProvider
  account: string
  error: unknown
}): React.JSX.Element {
  const info = PROVIDERS[provider]
  const add = info.addAccount?.kind === 'token' ? info.addAccount : undefined
  const hint = account && add ? add.hint : info.signInHint
  const tokenUrl = account && add ? add.url : info.tokenUrl
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await saveToken(provider, token, account)
      setToken('')
      toast(`Connected to ${info.label}`)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <SetupCard
      tone="info"
      title={
        account
          ? `Replace this ${info.label} account's token`
          : `Connect your ${info.label} account`
      }
      actions={
        <>
          <Button variant="primary" disabled={!token.trim() || busy} onClick={() => void save()}>
            {busy ? <Spinner className="text-current" /> : <LogIn className="size-3.5" />} Save
            token
          </Button>
          {tokenUrl && (
            <Button variant="secondary" onClick={() => void openUrl(tokenUrl)}>
              Create a token
            </Button>
          )}
        </>
      }
    >
      <p>{hint}</p>
      <div className="mt-3 max-w-md">
        <Input
          mono
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && token.trim()) void save()
          }}
          placeholder="API token"
        />
      </div>
      <p className="mt-2 text-[11.5px] text-muted">
        The token is kept in the OS credential manager and only ever sent to {info.label}.
      </p>
      {!!error && (
        <p className="mt-2 font-mono text-[11.5px] break-words whitespace-pre-wrap text-muted select-text">
          {errorMessage(error)}
        </p>
      )}
    </SetupCard>
  )
}
