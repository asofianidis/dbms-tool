import { queryOptions } from '@tanstack/react-query'
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
import { adapterFor, callApi, runCli, type ListResult } from './adapters'

export { runCli, type ListResult }

/** Which account and region the cloud tab shows, per provider. */
export const cloudPrefsStore = createPersistentStore<{
  provider: CloudProvider
  context: Partial<Record<CloudProvider, string>>
  region: Partial<Record<CloudProvider, string>>
}>('dbms.cloud.v1', { provider: 'aws', context: {}, region: {} })

export const cloudQueries = {
  tools: () =>
    queryOptions({ queryKey: ['cloud', 'tools'], queryFn: api.cloudTools, staleTime: 60_000 }),
  identity: (provider: CloudProvider, context: string) =>
    queryOptions({
      queryKey: ['cloud', provider, 'identity', context],
      queryFn: () => adapterFor(provider).identity(context)
    }),
  contexts: (provider: CloudProvider) =>
    queryOptions({
      queryKey: ['cloud', provider, 'contexts'],
      queryFn: () => adapterFor(provider).contexts()
    }),
  defaultRegion: (provider: CloudProvider, context: string) =>
    queryOptions({
      queryKey: ['cloud', provider, 'region', context],
      queryFn: () => adapterFor(provider).defaultRegion(context)
    }),
  databases: (provider: CloudProvider, context: string, region: string) =>
    queryOptions({
      queryKey: ['cloud', provider, 'databases', context, region],
      queryFn: (): Promise<ListResult> => adapterFor(provider).list(context, region),
      staleTime: 60_000
    })
}

export function refreshCloud(provider?: CloudProvider): void {
  void queryClient.invalidateQueries({ queryKey: provider ? ['cloud', provider] : ['cloud'] })
}

/** Opens the browser sign-in for the provider's CLI and waits for it to finish. */
export async function signIn(provider: CloudProvider, context: string): Promise<void> {
  const args = PROVIDERS[provider].signIn?.(context)
  if (!args) return
  await runCli(provider, args, { timeoutSecs: 10 * 60 })
  refreshCloud(provider)
}

/** Saves an API token (Render, Cloudflare) after checking it works. */
export async function saveToken(provider: CloudProvider, token: string): Promise<void> {
  await api.cloudTokenSet(provider, token)
  try {
    if (!(await adapterFor(provider).identity(''))) throw new Error('The token has no access')
  } catch (e) {
    await api.cloudTokenDelete(provider)
    throw e
  }
  refreshCloud(provider)
}

export async function forgetToken(provider: CloudProvider): Promise<void> {
  await api.cloudTokenDelete(provider)
  queryClient.removeQueries({ queryKey: ['cloud', provider] })
  refreshCloud(provider)
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
      .fetchQuery(cloudQueries.identity(db.ref.provider, db.ref.context))
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
    return await adapterFor(db.ref.provider).credentials(db)
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
      out = JSON.stringify(await callApi(provider, request.method, request.path, request.body))
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
        workdir: step.workdir
      })
    }
    if (step.capture) Object.assign(ctx, step.capture(out, ctx))
  }
}

async function waitUntilReady(job: string, ref: CloudRef): Promise<CloudDatabase> {
  const adapter = adapterFor(ref.provider)
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
      await runSteps(id, draft.provider, plan.steps, ctx)
      refreshCloud(draft.provider)
      const ref = plan.resolveRef ? plan.resolveRef(ctx) : plan.ref
      const db = await waitUntilReady(id, ref)
      if (plan.afterReady.length) await runSteps(id, draft.provider, plan.afterReady, ctx)
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
      await runSteps(id, provider, steps, {})
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
