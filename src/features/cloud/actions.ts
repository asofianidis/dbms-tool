import { queryOptions, useQuery } from '@tanstack/react-query'
import { api, type CloudProvider, type CloudRef } from '@/lib/api'
import {
  PROVIDERS,
  applyCredentials,
  commandLine,
  connectionFor,
  findSaved,
  iamUserFor,
  isMajorCloud,
  provisionedConnection,
  type CloudContext,
  type CloudDatabase,
  type Credentials,
  type DeleteOptions,
  type PlanStep,
  type ProvisionDraft
} from '@/lib/cloud'
import { planDelete, planProvision } from '@/lib/cloud-platforms'
import { queryClient } from '@/lib/queries'
import { createPersistentStore, createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import {
  connect,
  connectionsStore,
  disconnect,
  loadConnections,
  newQueryTab,
  openPrefilledConnection
} from '@/lib/workspace'
import {
  adapterFor,
  adapterForRef,
  callApi,
  gcpAccounts,
  runCli,
  type ListResult
} from './adapters'

export { runCli, type ListResult }

/** Which account, context and region the cloud tab shows, per provider. */
export const cloudPrefsStore = createPersistentStore<{
  provider: CloudProvider
  /** Empty for the CLI's own sign-in (or the first saved token) */
  account: Partial<Record<CloudProvider, string>>
  context: Partial<Record<CloudProvider, string>>
  region: Partial<Record<CloudProvider, string>>
}>('dbms.cloud.v1', { provider: 'aws', account: {}, context: {}, region: {} })

/**
 * Accounts added with an API token, after the first one. The tokens themselves
 * are in the OS credential manager under each account's ID.
 */
export const tokenAccountsStore = createPersistentStore<
  Partial<Record<CloudProvider, { id: string; label: string }[]>>
>('dbms.cloud.accounts.v1', {})

export const cloudQueries = {
  tools: () =>
    queryOptions({ queryKey: ['cloud', 'tools'], queryFn: api.cloudTools, staleTime: 60_000 }),
  identity: (provider: CloudProvider, context: string, account = '') =>
    queryOptions({
      queryKey: ['cloud', provider, account, 'identity', context],
      queryFn: () => adapterFor(provider, account).identity(context)
    }),
  contexts: (provider: CloudProvider, account = '') =>
    queryOptions({
      queryKey: ['cloud', provider, account, 'contexts'],
      queryFn: () => adapterFor(provider, account).contexts()
    }),
  defaultRegion: (provider: CloudProvider, context: string, account = '') =>
    queryOptions({
      queryKey: ['cloud', provider, account, 'region', context],
      queryFn: () => adapterFor(provider, account).defaultRegion(context)
    }),
  databases: (provider: CloudProvider, context: string, region: string, account = '') =>
    queryOptions({
      queryKey: ['cloud', provider, account, 'databases', context, region],
      queryFn: (): Promise<ListResult> => adapterFor(provider, account).list(context, region),
      staleTime: 60_000
    }),
  /** Google accounts gcloud holds */
  gcpAccounts: () => queryOptions({ queryKey: ['cloud', 'gcp', 'accounts'], queryFn: gcpAccounts })
}

export function refreshCloud(provider?: CloudProvider): void {
  void queryClient.invalidateQueries({ queryKey: provider ? ['cloud', provider] : ['cloud'] })
}

/** Opens the browser sign-in for the provider's CLI and waits for it to finish. */
export async function signIn(
  provider: CloudProvider,
  context: string,
  account = ''
): Promise<void> {
  // A Google account gcloud holds but whose sign-in expired: sign in as it again
  const args =
    provider === 'gcp' && account
      ? ['auth', 'login', account, '--brief', '--no-activate']
      : PROVIDERS[provider].signIn?.(context)
  if (!args) return
  await runCli(provider, args, { timeoutSecs: 10 * 60 })
  refreshCloud(provider)
}

/** Saves an account's API token after checking it works. */
export async function saveToken(
  provider: CloudProvider,
  token: string,
  account = ''
): Promise<void> {
  await api.cloudTokenSet(provider, token, account)
  try {
    if (!(await adapterFor(provider, account).identity('')))
      throw new Error('The token has no access')
  } catch (e) {
    await api.cloudTokenDelete(provider, account)
    throw e
  }
  refreshCloud(provider)
}

export async function forgetToken(provider: CloudProvider): Promise<void> {
  await api.cloudTokenDelete(provider)
  queryClient.removeQueries({ queryKey: ['cloud', provider] })
  refreshCloud(provider)
}

export function selectAccount(provider: CloudProvider, account: string): void {
  // Profiles, projects and orgs belong to an account, so start over with its default
  cloudPrefsStore.set((p) => ({
    ...p,
    account: { ...p.account, [provider]: account },
    context: { ...p.context, [provider]: '' }
  }))
}

/**
 * The accounts to pick from besides the CLI's own sign-in (or first token):
 * the other Google accounts gcloud holds, or the tokens added for the others.
 */
export function useAccounts(provider: CloudProvider, enabled: boolean): CloudContext[] {
  const added = tokenAccountsStore.use()[provider]
  const google = useQuery({ ...cloudQueries.gcpAccounts(), enabled: enabled && provider === 'gcp' })
  if (provider === 'gcp') return (google.data ?? []).filter((a) => !a.isDefault)
  return (added ?? []).map((a) => ({ ...a, isDefault: false }))
}

/**
 * Adds an account by browser sign-in (Google, Azure) and returns the Google
 * account that was added, if there's a new one.
 */
export async function addBrowserAccount(provider: CloudProvider): Promise<string | null> {
  const add = PROVIDERS[provider].addAccount
  if (add?.kind !== 'browser') return null
  const before = provider === 'gcp' ? await gcpAccounts() : []
  await runCli(provider, add.args, { timeoutSecs: 10 * 60 })
  refreshCloud(provider)
  if (provider !== 'gcp') return null
  const added = (await gcpAccounts()).find((a) => !before.some((b) => b.id === a.id))
  return added?.id ?? null
}

/** Adds another account by its API token, checks it works, and returns its ID. */
export async function addTokenAccount(
  provider: CloudProvider,
  token: string,
  label: string
): Promise<string> {
  const id = crypto.randomUUID().slice(0, 8)
  await api.cloudTokenSet(provider, token, id)
  let identity: string | null
  try {
    identity = await adapterFor(provider, id).identity('')
    if (!identity) throw new Error('The token has no access')
  } catch (e) {
    await api.cloudTokenDelete(provider, id)
    throw e
  }
  tokenAccountsStore.set((s) => ({
    ...s,
    [provider]: [...(s[provider] ?? []), { id, label: label.trim() || identity }]
  }))
  return id
}

/** Forgets an account added with a token, and its token. */
export async function removeTokenAccount(provider: CloudProvider, id: string): Promise<void> {
  await api.cloudTokenDelete(provider, id)
  tokenAccountsStore.set((s) => ({
    ...s,
    [provider]: (s[provider] ?? []).filter((a) => a.id !== id)
  }))
  if (cloudPrefsStore.get().account[provider] === id) selectAccount(provider, '')
  queryClient.removeQueries({ queryKey: ['cloud', provider, id] })
}

/**
 * Connects to a discovered database: straight away when it's already saved,
 * otherwise through the connection dialog with everything filled in, including
 * passwords the provider keeps (Secrets Manager, Render, Railway, Fly.io).
 */
export async function connectToCloudDatabase(db: CloudDatabase): Promise<void> {
  const saved = findSaved(connectionsStore.get(), db)
  if (saved) {
    if (await connect(saved.id)) newQueryTab(saved.id)
    return
  }
  const config = connectionFor(db)
  const credentials = await fetchCredentials(db)
  applyCredentials(config, credentials)
  // Databases set up for IAM sign-in connect as whoever the CLI is signed in as
  if (db.iamAuth && !credentials.password && isMajorCloud(db.ref.provider)) {
    const identity = await queryClient
      .fetchQuery(cloudQueries.identity(db.ref.provider, db.ref.context, db.ref.account))
      .catch(() => null)
    const user = iamUserFor(db, identity)
    if (user) {
      config.auth = 'cloud'
      config.user = user
    }
  }
  openPrefilledConnection(config, credentials.password)
}

/** Credentials the provider keeps; empty (with a note) when they can't be fetched. */
async function fetchCredentials(db: CloudDatabase): Promise<Credentials> {
  try {
    return await adapterForRef(db.ref).credentials(db)
  } catch (e) {
    toast(`Couldn't fetch the credentials for ${db.name}: ${errorMessage(e)}`, 'info')
    return {}
  }
}

/* ---------- Provisioning ---------- */

export interface ProvisionJob {
  id: string
  provider: CloudProvider
  name: string
  engineLabel: string
  action: 'create' | 'delete'
  state: 'running' | 'waiting' | 'ready' | 'failed'
  /** What's happening now, e.g. the step title */
  activity: string
  log: { text: string; level: 'command' | 'info' | 'error' }[]
  error?: string
  startedAt: number
  connectionId?: string
}

export const jobsStore = createStore<ProvisionJob[]>([])

function updateJob(
  id: string,
  patch: Partial<ProvisionJob> | ((job: ProvisionJob) => Partial<ProvisionJob>)
): void {
  jobsStore.set((jobs) =>
    jobs.map((j) =>
      j.id === id ? { ...j, ...(typeof patch === 'function' ? patch(j) : patch) } : j
    )
  )
}

function logJob(
  id: string,
  text: string,
  level: ProvisionJob['log'][number]['level'] = 'info'
): void {
  updateJob(id, (j) => ({ log: [...j.log, { text, level }] }))
}

export function dismissJob(id: string): void {
  jobsStore.set((jobs) => jobs.filter((j) => j.id !== id))
}

const POLL_MS = 20_000
const MAX_WAIT_MS = 75 * 60_000

/** Runs CLI and REST steps in order, passing captured values along in `ctx`. */
async function runSteps(
  job: string,
  provider: CloudProvider,
  account: string,
  steps: PlanStep[],
  ctx: Record<string, string>
): Promise<void> {
  for (const step of steps) {
    updateJob(job, { activity: step.title })
    logJob(job, step.title)
    let out: string
    if (step.api) {
      const request = step.api(ctx)
      logJob(job, `${request.method} ${request.path}`, 'command')
      out = JSON.stringify(
        await callApi(provider, request.method, request.path, request.body, account)
      )
    } else {
      const args = step.args(ctx)
      logJob(
        job,
        commandLine(
          PROVIDERS[provider].cli,
          args.map((a) => a.replace('{secret}', 'password-file'))
        ),
        'command'
      )
      out = await runCli(provider, args, {
        secret: step.secret,
        timeoutSecs: step.timeoutSecs,
        workdir: step.workdir,
        account
      })
    }
    if (step.capture) Object.assign(ctx, step.capture(out, ctx))
  }
}

async function waitUntilReady(job: string, ref: CloudRef): Promise<CloudDatabase> {
  const adapter = adapterForRef(ref)
  const started = Date.now()
  updateJob(job, { state: 'waiting', activity: 'Waiting for the database to come up' })
  logJob(job, 'Waiting for the database to report ready…')
  let lastStatus = ''
  for (;;) {
    try {
      const db = await adapter.describe(ref)
      if (db && db.status !== lastStatus) {
        lastStatus = db.status
        logJob(job, `Status: ${db.status}`)
        updateJob(job, { activity: `Status: ${db.status}` })
      }
      if (db?.ready) return db
    } catch (e) {
      // Right after creation some APIs briefly report the resource as missing
      if (Date.now() - started > 5 * 60_000) throw e
    }
    if (Date.now() - started > MAX_WAIT_MS) {
      throw new Error('Gave up waiting for the database; check its status in the cloud console')
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** Creates the database in the background, then saves (and returns) its connection. */
export function startProvision(draft: ProvisionDraft, engineLabel: string): string {
  const plan = planProvision(draft)
  const id = crypto.randomUUID().slice(0, 8)
  const name = draft.name.trim() || engineLabel
  jobsStore.set((jobs) => [
    {
      id,
      provider: draft.provider,
      name,
      engineLabel,
      action: 'create',
      state: 'running',
      activity: 'Starting',
      log: [],
      startedAt: Date.now()
    },
    ...jobs
  ])
  void (async () => {
    try {
      const ctx: Record<string, string> = {}
      await runSteps(id, draft.provider, draft.account, plan.steps, ctx)
      refreshCloud(draft.provider)
      const ref = plan.resolveRef ? plan.resolveRef(ctx) : plan.ref
      const db = await waitUntilReady(id, { ...ref, account: draft.account || undefined })
      if (plan.afterReady.length)
        await runSteps(id, draft.provider, draft.account, plan.afterReady, ctx)
      let connectionId: string | undefined
      if (draft.saveConnection) {
        // Providers that generate credentials (Cosmos DB, Render, Railway, Fly.io) hand them over now
        const credentials = await fetchCredentials(db)
        const saved = await api.connectionSave(
          provisionedConnection(draft, db, credentials),
          credentials.password ?? (engineHasPassword(draft) ? draft.password : null)
        )
        await loadConnections()
        connectionId = saved.id
        logJob(id, `Saved connection "${saved.name}"`)
      }
      updateJob(id, { state: 'ready', activity: 'Ready', connectionId })
      refreshCloud(draft.provider)
      toast(`${name} is ready${connectionId ? ' and saved as a connection' : ''}`)
    } catch (e) {
      const message = errorMessage(e)
      logJob(id, message, 'error')
      updateJob(id, { state: 'failed', activity: 'Failed', error: message })
      refreshCloud(draft.provider)
      toast(`Provisioning ${name} failed: ${message}`, 'error')
    }
  })()
  return id
}

/** Whether the draft's password is the database's (rather than one the provider generates). */
function engineHasPassword(draft: ProvisionDraft): boolean {
  return PROVIDERS[draft.provider].auth === 'cli' && isMajorCloud(draft.provider)
}

/** Deletes a cloud database in the background, and its saved connection if given. */
export function startDeletion(
  db: CloudDatabase,
  options: DeleteOptions,
  connectionId?: string
): string {
  const steps = planDelete(db, options)
  const provider = db.ref.provider
  const id = crypto.randomUUID().slice(0, 8)
  jobsStore.set((jobs) => [
    {
      id,
      provider,
      name: db.name,
      engineLabel: db.product,
      action: 'delete',
      state: 'running',
      activity: 'Starting',
      log: [],
      startedAt: Date.now()
    },
    ...jobs
  ])
  void (async () => {
    try {
      await runSteps(id, provider, db.ref.account ?? '', steps, {})
      if (connectionId) {
        await disconnect(connectionId)
        await api.connectionDelete(connectionId)
        await loadConnections()
        logJob(id, 'Removed the saved connection')
      }
      // AWS returns as soon as deletion starts; the others wait for it
      const activity =
        provider === 'aws' ? 'Deletion started; AWS finishes in a few minutes' : 'Deleted'
      logJob(id, activity)
      updateJob(id, { state: 'ready', activity })
      refreshCloud(provider)
      toast(provider === 'aws' ? `Deleting ${db.name}` : `Deleted ${db.name}`)
    } catch (e) {
      const message = errorMessage(e)
      logJob(id, message, 'error')
      updateJob(id, { state: 'failed', activity: 'Failed', error: message })
      refreshCloud(provider)
      toast(`Deleting ${db.name} failed: ${message}`, 'error')
    }
  })()
  return id
}

/** This machine's public IP, for firewall rules. */
export async function detectPublicIp(): Promise<string> {
  const res = await fetch('https://api.ipify.org?format=json')
  if (!res.ok) throw new Error(`IP lookup failed (${res.status})`)
  const body = (await res.json()) as { ip?: string }
  if (!body.ip) throw new Error('IP lookup returned no address')
  return body.ip
}
