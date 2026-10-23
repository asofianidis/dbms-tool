import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { openUrl } from '@tauri-apps/plugin-opener'
import { CloudUpload, Copy, Dices, Eye, EyeOff, Globe, Lock, ShieldCheck } from 'lucide-react'
import type { CloudProvider } from '@/lib/api'
import {
  PROVIDERS,
  PROVISION_ENGINES,
  REGIONS,
  engineOption,
  generatePassword,
  isMajorCloud,
  newProvisionDraft,
  planScript,
  scopeArgs,
  validateProvision,
  withEngine,
  type NetworkAccess,
  type ProvisionDraft
} from '@/lib/cloud'
import { planProvision } from '@/lib/cloud-platforms'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { confirm } from '@/lib/workspace'
import {
  Button,
  EngineMark,
  Field,
  Input,
  Modal,
  Segmented,
  Select,
  Spinner,
  Toggle
} from '@/components/ui'
import { cloudPrefsStore, cloudQueries, detectPublicIp, runCli, startProvision } from './actions'

export function ProvisionDialog({
  provider,
  account = '',
  context,
  region,
  onClose
}: {
  provider: CloudProvider
  /** The account picked in the Cloud tab; empty for the CLI's own sign-in */
  account?: string
  context: string
  region: string
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<ProvisionDraft>(() =>
    newProvisionDraft(provider, context, region, account)
  )
  const [showPassword, setShowPassword] = useState(false)
  const [ipState, setIpState] = useState<'idle' | 'detecting' | 'failed'>('idle')
  const info = PROVIDERS[provider]
  const option = engineOption(provider, draft.engine)
  // Google Cloud adds the signed-in account as the instance's IAM user
  const identity = useQuery({
    ...cloudQueries.identity(provider, context, account),
    enabled: provider === 'gcp'
  })
  useEffect(() => {
    if (provider === 'gcp') setDraft((d) => ({ ...d, iamUser: identity.data ?? '' }))
  }, [provider, identity.data])
  const patch = (p: Partial<ProvisionDraft>): void => setDraft((d) => ({ ...d, ...p }))

  // Railway projects, Render workspaces, Fly.io orgs and Cloudflare accounts
  const pickContext = !isMajorCloud(provider)
  const contexts = useQuery({ ...cloudQueries.contexts(provider, account), enabled: pickContext })
  const contextList = contexts.data?.contexts ?? []
  const project = contextList.find((c) => c.id === draft.context)
  useEffect(() => {
    // Render and Cloudflare need an account picked; start with the first
    if ((provider === 'render' || provider === 'cloudflare') && !draft.context && contextList[0])
      setDraft((d) => ({ ...d, context: contextList[0].id }))
    // Opened on a Railway project: start in its production environment
    if (provider === 'railway' && draft.context && !draft.region) {
      const environments = contextList.find((c) => c.id === draft.context)?.children ?? []
      const environment = environments.find((e) => e.label === 'production') ?? environments[0]
      if (environment) setDraft((d) => ({ ...d, region: environment.id }))
    }
  }, [provider, draft.context, draft.region, contextList])
  const pickProject = (id: string): void => {
    const environments = contextList.find((c) => c.id === id)?.children ?? []
    patch({
      context: id,
      region: (environments.find((e) => e.label === 'production') ?? environments[0])?.id ?? ''
    })
  }

  const detectIp = async (): Promise<void> => {
    setIpState('detecting')
    try {
      const ip = await detectPublicIp()
      setDraft((d) => (d.ip ? d : { ...d, ip }))
      setIpState('idle')
    } catch {
      setIpState('failed')
    }
  }

  useEffect(() => {
    if (info.designer.network) void detectIp()
  }, [])

  // Azure needs a resource group; offer the existing ones
  const groups = useQuery({
    queryKey: ['cloud', 'azure', 'groups', context],
    queryFn: async () =>
      (
        JSON.parse(await runCli('azure', ['group', 'list', ...scopeArgs('azure', context)])) as {
          name: string
          location: string
        }[]
      ).sort((a, b) => a.name.localeCompare(b.name)),
    enabled: provider === 'azure'
  })

  const problem = validateProvision(draft)
  const script = useMemo(
    () => (problem ? '' : planScript(planProvision(draft), info.cli)),
    [draft, problem, info.cli]
  )

  const create = async (): Promise<void> => {
    if (problem) return
    const target = draft.context || context
    const where =
      (target
        ? `${info.contextLabel.toLowerCase()} ${contextList.find((c) => c.id === target)?.label ?? target}`
        : 'your default account') + (provider === 'gcp' && account ? ` as ${account}` : '')
    const ok = await confirm({
      title: `Create ${draft.name.trim() || option.label} on ${info.label}?`,
      message: (
        <>
          This creates billable resources in {where}. Charges start as soon as the database exists
          and continue until you delete it in the {info.label} console.
          {draft.access === 'anywhere' && (
            <span className="mt-2 block text-warn">
              The database will accept connections from any IP address.
            </span>
          )}
        </>
      ),
      confirmLabel: 'Create database',
      code: script
    })
    if (!ok) return
    startProvision(draft, option.label)
    cloudPrefsStore.set((p) => ({ ...p, region: { ...p.region, [provider]: draft.region } }))
    toast(
      `Provisioning ${draft.name.trim() || option.label}. Progress shows in the Cloud tab.`,
      'info'
    )
    onClose()
  }

  return (
    <Modal
      width="2xl"
      title={`New ${info.label} database`}
      description={
        pickContext
          ? `Through the ${info.cli}${info.auth === 'cli' ? ' CLI' : ''}`
          : context
            ? `${info.contextLabel}: ${context}`
            : `Uses the ${info.cli} CLI's default ${info.contextLabel.toLowerCase()}`
      }
      icon={
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-info/15 text-info">
          <CloudUpload className="size-4" />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <span className={cn('mr-auto text-xs', problem ? 'text-danger' : 'text-muted')}>
            {problem ?? 'Review the commands, then create.'}
          </span>
          <Button
            variant="secondary"
            disabled={!script}
            onClick={() => {
              void navigator.clipboard.writeText(script)
              toast('Commands copied')
            }}
          >
            <Copy className="size-3.5" /> Copy commands
          </Button>
          <Button variant="primary" disabled={!!problem} onClick={() => void create()}>
            <CloudUpload className="size-3.5" /> Create database
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-6">
        <div className="space-y-5">
          {pickContext && (
            <Section title={info.contextLabel}>
              <div className="grid grid-cols-2 gap-3">
                <Select
                  value={draft.context}
                  onChange={(e) =>
                    provider === 'railway'
                      ? pickProject(e.target.value)
                      : patch({ context: e.target.value })
                  }
                >
                  {provider === 'railway' && <option value="">New project…</option>}
                  {provider === 'fly' && <option value="">Personal</option>}
                  {contexts.isLoading && <option disabled>Loading…</option>}
                  {contextList
                    .filter((c) => !(provider === 'fly' && c.id === 'personal'))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                </Select>
                {provider === 'railway' && project && (
                  <Select value={draft.region} onChange={(e) => patch({ region: e.target.value })}>
                    {project.children?.map((env) => (
                      <option key={env.id} value={env.id}>
                        {env.label}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              {contexts.error ? (
                <p className="mt-1.5 text-[11.5px] text-danger">{String(contexts.error)}</p>
              ) : null}
            </Section>
          )}
          <Section title="Engine">
            <div className="grid grid-cols-3 gap-2">
              {PROVISION_ENGINES[provider].map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setDraft((d) => withEngine(d, e.id))}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border p-2 text-left text-xs transition-colors',
                    draft.engine === e.id
                      ? 'border-accent/60 bg-accent/5 text-bright'
                      : 'border-line-strong bg-raised/60 text-fg hover:bg-hover'
                  )}
                >
                  <EngineMark engine={e.engine} />
                  <span className="min-w-0 leading-tight">{e.label}</span>
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {option.versions.length > 1 && (
                <Field label="Version">
                  <Select
                    value={draft.version}
                    onChange={(e) => patch({ version: e.target.value })}
                  >
                    {option.versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {info.designer.region && (
                <Field label={provider === 'cloudflare' ? 'Location' : 'Region'}>
                  <Select value={draft.region} onChange={(e) => patch({ region: e.target.value })}>
                    {REGIONS[provider].map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            {draft.engine === 'babelfish' && (
              <p className="mt-2 text-[11.5px] leading-snug text-muted">
                An Aurora PostgreSQL cluster with a parameter group that turns on Babelfish. Connect
                with T-SQL on port 1433; PostgreSQL stays available on 5432.
              </p>
            )}
          </Section>

          <Section title="Instance">
            <div className="grid grid-cols-2 gap-3">
              {/* Railway names the service itself; only a new project needs a name */}
              {!(provider === 'railway' && draft.context) && (
                <Field
                  label={
                    provider === 'azure'
                      ? 'Server name'
                      : provider === 'railway'
                        ? 'Project name'
                        : 'Name'
                  }
                  hint={provider === 'azure' ? 'Becomes part of the host name' : undefined}
                >
                  <Input
                    value={draft.name}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="e.g. app-dev"
                    autoFocus
                  />
                </Field>
              )}
              {option.storage && (
                <Field label="Storage (GB)">
                  <Input
                    value={draft.storageGb ? String(draft.storageGb) : ''}
                    onChange={(e) =>
                      patch({ storageGb: Number(e.target.value.replace(/\D/g, '')) || 0 })
                    }
                    inputMode="numeric"
                    placeholder={String(option.storage.min)}
                  />
                </Field>
              )}
            </div>
            {option.sizes.length > 1 && (
              <div className="mt-3 space-y-1.5">
                <span className="text-xs font-medium text-muted">Size</span>
                <div className="grid grid-cols-2 gap-2">
                  {option.sizes.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => patch({ size: s.id })}
                      className={cn(
                        'rounded-lg border px-2.5 py-2 text-left transition-colors',
                        draft.size === s.id
                          ? 'border-accent/60 bg-accent/5'
                          : 'border-line-strong bg-raised/60 hover:bg-hover'
                      )}
                    >
                      <span className="block font-mono text-[11.5px] text-bright">{s.label}</span>
                      <span className="block text-[11px] text-muted">{s.detail}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {provider === 'azure' && (
              <div className="mt-3 grid grid-cols-[auto_1fr] items-end gap-3">
                <Field label="Resource group">
                  <Segmented
                    value={draft.newResourceGroup ? 'new' : 'existing'}
                    onChange={(v) =>
                      patch({
                        newResourceGroup: v === 'new',
                        resourceGroup: v === 'new' ? 'dbms-tool' : (groups.data?.[0]?.name ?? '')
                      })
                    }
                    options={[
                      { value: 'new', label: 'New' },
                      { value: 'existing', label: 'Existing' }
                    ]}
                  />
                </Field>
                {draft.newResourceGroup ? (
                  <Input
                    value={draft.resourceGroup}
                    onChange={(e) => patch({ resourceGroup: e.target.value })}
                    placeholder="dbms-tool"
                  />
                ) : (
                  <Select
                    value={draft.resourceGroup}
                    onChange={(e) => patch({ resourceGroup: e.target.value })}
                  >
                    {groups.isLoading && <option>Loading…</option>}
                    {groups.data?.map((g) => (
                      <option key={g.name} value={g.name}>
                        {g.name} ({g.location})
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            )}
          </Section>

          <Section title="Credentials">
            {option.noCredentials ? (
              <p className="text-[11.5px] leading-snug text-muted">
                {option.id === 'cosmos'
                  ? 'Cosmos DB generates access keys for the account. The saved connection uses its primary connection string, with the key kept in the OS credential manager.'
                  : option.engine === 'sqlite'
                    ? 'D1 has no users or passwords; the connection signs in with your Cloudflare API token.'
                    : `${info.label} generates the user and password. The saved connection gets them once the database is ready, with the password kept in the OS credential manager.`}
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Admin user"
                  hint={option.fixedUser ? `${info.label} names this user for you` : undefined}
                >
                  <Input
                    value={draft.user}
                    disabled={option.fixedUser}
                    onChange={(e) => patch({ user: e.target.value })}
                  />
                </Field>
                <Field
                  label="Password"
                  hint="Saved to the OS credential manager with the connection"
                >
                  <div className="flex gap-1">
                    <Input
                      mono
                      type={showPassword ? 'text' : 'password'}
                      value={draft.password}
                      onChange={(e) => patch({ password: e.target.value })}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      title={showPassword ? 'Hide' : 'Show'}
                      onClick={() => setShowPassword((s) => !s)}
                    >
                      {showPassword ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      title="Generate a new password"
                      onClick={() => {
                        patch({ password: generatePassword() })
                        setShowPassword(true)
                      }}
                    >
                      <Dices className="size-3.5" />
                    </Button>
                  </div>
                </Field>
              </div>
            )}
            {option.initialDatabase && (
              <Field
                className="mt-3"
                label={
                  option.initialDatabase === 'required' ? 'Database' : 'Initial database (optional)'
                }
              >
                <Input
                  value={draft.database}
                  onChange={(e) => patch({ database: e.target.value })}
                  placeholder="appdb"
                />
              </Field>
            )}
          </Section>

          {info.designer.network && (
            <Section title="Network access">
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ['ip', ShieldCheck, 'This machine', 'Only your IP address'],
                    ['anywhere', Globe, 'Anywhere', 'Any IP; password only'],
                    [
                      'private',
                      Lock,
                      'Private',
                      provider === 'gcp' ? 'Auth Proxy only' : 'Inside the cloud network'
                    ]
                  ] as const
                ).map(([value, Icon, label, detail]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => patch({ access: value as NetworkAccess })}
                    className={cn(
                      'rounded-lg border px-2.5 py-2 text-left transition-colors',
                      draft.access === value
                        ? 'border-accent/60 bg-accent/5'
                        : 'border-line-strong bg-raised/60 hover:bg-hover'
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-xs text-bright">
                      <Icon className="size-3.5" /> {label}
                    </span>
                    <span className="block text-[11px] text-muted">{detail}</span>
                  </button>
                ))}
              </div>
              {draft.access === 'ip' && (
                <Field
                  className="mt-3"
                  label="Allowed IP address"
                  hint={
                    ipState === 'failed'
                      ? "Couldn't detect your public IP; enter it (or a CIDR range) yourself"
                      : 'Detected automatically; a CIDR range such as 203.0.113.0/24 also works'
                  }
                >
                  <div className="flex gap-2">
                    <Input
                      mono
                      value={draft.ip}
                      onChange={(e) => patch({ ip: e.target.value })}
                      placeholder="203.0.113.7"
                    />
                    <Button
                      variant="secondary"
                      disabled={ipState === 'detecting'}
                      onClick={() => {
                        patch({ ip: '' })
                        void detectIp()
                      }}
                    >
                      {ipState === 'detecting' && <Spinner className="text-current" />} Detect
                    </Button>
                  </div>
                </Field>
              )}
              {draft.access === 'private' && (
                <p className="mt-2 text-[11.5px] leading-snug text-muted">
                  {provider === 'gcp'
                    ? 'The instance gets no authorized networks; connect through the Cloud SQL Auth Proxy.'
                    : "You won't be able to connect from this machine without a VPN, bastion or tunnel."}
                </p>
              )}
            </Section>
          )}

          <Section title="Options">
            <div className="grid grid-cols-2 gap-3">
              {info.designer.backups && (
                <Toggle
                  checked={draft.backups}
                  onChange={(backups) => patch({ backups })}
                  label="Automated backups"
                  description={provider === 'aws' ? 'Kept for 7 days' : 'Daily'}
                />
              )}
              {info.designer.deletionProtection && (
                <Toggle
                  checked={draft.deletionProtection}
                  onChange={(deletionProtection) => patch({ deletionProtection })}
                  label="Deletion protection"
                  description="Block accidental deletes"
                />
              )}
              {option.iam && (
                <Toggle
                  checked={draft.iamAuth}
                  onChange={(iamAuth) => patch({ iamAuth })}
                  label="IAM database authentication"
                  description={
                    provider === 'gcp'
                      ? draft.iamUser
                        ? `Adds ${draft.iamUser} as an IAM user`
                        : 'Sign in to gcloud to add your account'
                      : 'Allow sign-in with AWS IAM tokens'
                  }
                />
              )}
              <Toggle
                checked={draft.saveConnection}
                onChange={(saveConnection) => patch({ saveConnection })}
                label="Save a connection"
                description="Added once the database is ready"
              />
            </div>
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="rounded-lg border border-line bg-raised/40 p-3 text-xs">
            <p className="font-medium text-bright">
              {option.label} {option.versions.find((v) => v.id === draft.version)?.label}
            </p>
            <p className="mt-0.5 text-muted">
              {option.sizes.find((s) => s.id === draft.size)?.detail}
              {option.storage ? ` · ${draft.storageGb} GB storage` : ''}
            </p>
            <p className="mt-2 leading-snug text-faint">
              Billing starts when the database is created.{' '}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => void openUrl(info.pricingUrl)}
              >
                {info.label} pricing
              </button>
            </p>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <p className="mb-1.5 text-[11px] font-medium text-muted">
              {info.auth === 'token' ? `Requests (${info.cli})` : `Commands (${info.cli} CLI)`}
            </p>
            <pre className="min-h-64 flex-1 overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg select-text">
              {script || '# Fill in the form to see the commands'}
            </pre>
            {!option.noCredentials && (
              <p className="mt-1.5 text-[11px] leading-snug text-faint">
                The password goes to the CLI in a temporary file that is deleted afterwards, never
                on the command line.
              </p>
            )}
          </div>
        </div>
      </div>
    </Modal>
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
    <section>
      <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-faint uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}
