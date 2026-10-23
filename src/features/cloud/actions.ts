import { queryOptions } from '@tanstack/react-query'
import { api, type CloudProvider } from '@/lib/api'
import {
  PROVIDERS,
  anyInstanceAvailable,
  clusterInstancesCommand,
  commandLine,
  defaultContextCommand,
  defaultRegionCommand,
  describeCommand,
  findSaved,
  identityCommand,
  listCommands,
  parseContexts,
  parseDescribe,
  parseIdentity,
  parseList,
  parseSecret,
  provisionPlan,
  provisionedConnection,
  secretCommand,
  connectionFor,
  contextsCommand,
  type CloudDatabase,
  type PlanStep,
  type ProvisionDraft,
  type ProvisionPlan
} from '@/lib/cloud'
import { queryClient } from '@/lib/queries'
import { createPersistentStore, createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import {
  connect,
  connectionsStore,
  loadConnections,
  newQueryTab,
  openPrefilledConnection
} from '@/lib/workspace'

/** Which account and region the cloud tab shows, per provider. */
export const cloudPrefsStore = createPersistentStore<{
  provider: CloudProvider
  context: Partial<Record<CloudProvider, string>>
  region: Partial<Record<CloudProvider, string>>
}>('dbms.cloud.v1', { provider: 'aws', context: {}, region: {} })

export function runCli(
  provider: CloudProvider,
  args: string[],
  options?: { secret?: string; timeoutSecs?: number }
): Promise<string> {
  return api.cloudCli(provider, args, options)
}

/** Runs a CLI command and returns null instead of failing (for optional lookups). */
async function tryCli(provider: CloudProvider, args: string[] | null): Promise<string | null> {
  if (!args) return null
  return runCli(provider, args).then(
    (out) => out.trim() || null,
    () => null
  )
}

export interface ListResult {
  databases: CloudDatabase[]
  /** Listings that failed, e.g. a missing permission, while others worked */
  errors: { label: string; message: string }[]
}

export const cloudQueries = {
  tools: () =>
    queryOptions({ queryKey: ['cloud', 'tools'], queryFn: api.cloudTools, staleTime: 60_000 }),
  identity: (provider: CloudProvider, context: string) =>
    queryOptions({
      queryKey: ['cloud', provider, 'identity', context],
      queryFn: async () =>
        parseIdentity(provider, await runCli(provider, identityCommand(provider, context)))
    }),
  contexts: (provider: CloudProvider) =>
    queryOptions({
      queryKey: ['cloud', provider, 'contexts'],
      queryFn: async () => ({
        contexts: parseContexts(provider, await runCli(provider, contextsCommand(provider))),
        defaultContext: await tryCli(provider, defaultContextCommand(provider))
      })
    }),
  defaultRegion: (provider: CloudProvider, context: string) =>
    queryOptions({
      queryKey: ['cloud', provider, 'region', context],
      queryFn: () => tryCli(provider, defaultRegionCommand(provider, context))
    }),
  databases: (provider: CloudProvider, context: string, region: string) =>
    queryOptions({
      queryKey: ['cloud', provider, 'databases', context, region],
      queryFn: async (): Promise<ListResult> => {
        const commands = listCommands(provider, context, region)
        const results = await Promise.allSettled(
          commands.map(async (c) =>
            parseList(c.key, await runCli(provider, c.args), context, region)
          )
        )
        const errors = results.flatMap((r, i) =>
          r.status === 'rejected'
            ? [{ label: commands[i].label, message: errorMessage(r.reason) }]
            : []
        )
        // When every listing fails it's the account, not one service
        if (errors.length === commands.length) throw new Error(errors[0].message)
        const databases = results
          .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
          .sort((a, b) => a.name.localeCompare(b.name))
        return { databases, errors }
      },
      staleTime: 60_000
    })
}

export function refreshCloud(provider?: CloudProvider): void {
  void queryClient.invalidateQueries({ queryKey: provider ? ['cloud', provider] : ['cloud'] })
}

/** Opens the browser sign-in for the provider's CLI and waits for it to finish. */
export async function signIn(provider: CloudProvider, context: string): Promise<void> {
  await runCli(provider, PROVIDERS[provider].signIn(context), { timeoutSecs: 10 * 60 })
  refreshCloud(provider)
}

/**
 * Connects to a discovered database: straight away when it's already saved,
 * otherwise through the connection dialog with everything filled in (including
 * the password, when AWS manages it in Secrets Manager).
 */
export async function connectToCloudDatabase(db: CloudDatabase): Promise<void> {
  const saved = findSaved(connectionsStore.get(), db)
  if (saved) {
    if (await connect(saved.id)) newQueryTab(saved.id)
    return
  }
  const config = connectionFor(db)
  let password: string | undefined
  const secretArgs = secretCommand(db)
  if (secretArgs) {
    try {
      const secret = parseSecret(await runCli(db.ref.provider, secretArgs))
      password = secret.password
      if (secret.username) config.user = secret.username
    } catch (e) {
      toast(`Couldn't read the password from Secrets Manager: ${errorMessage(e)}`, 'info')
    }
  }
  openPrefilledConnection(config, password)
}

/* ---------- Provisioning ---------- */

export interface ProvisionJob {
  id: string
  provider: CloudProvider
  name: string
  engineLabel: string
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

async function runSteps(
  job: string,
  provider: CloudProvider,
  steps: PlanStep[],
  ctx: Record<string, string>
): Promise<void> {
  for (const step of steps) {
    updateJob(job, { activity: step.title })
    const args = step.args(ctx)
    logJob(job, step.title)
    logJob(
      job,
      commandLine(
        PROVIDERS[provider].cli,
        args.map((a) => a.replace('{secret}', 'password-file'))
      ),
      'command'
    )
    const out = await runCli(provider, args, { secret: step.secret, timeoutSecs: step.timeoutSecs })
    if (step.capture) Object.assign(ctx, step.capture(out))
  }
}

async function waitUntilReady(job: string, plan: ProvisionPlan): Promise<CloudDatabase> {
  const { ref } = plan
  const describe = describeCommand(ref)
  const started = Date.now()
  updateJob(job, { state: 'waiting', activity: 'Waiting for the database to come up' })
  logJob(job, 'Waiting for the database to report ready…')
  let lastStatus = ''
  for (;;) {
    try {
      const db = parseDescribe(ref, await runCli(ref.provider, describe.args))
      const membersReady =
        ref.provider !== 'aws' || ref.kind !== 'cluster'
          ? true
          : anyInstanceAvailable(await runCli(ref.provider, clusterInstancesCommand(ref)))
      if (db && db.status !== lastStatus) {
        lastStatus = db.status
        logJob(job, `Status: ${db.status}`)
        updateJob(job, { activity: `Status: ${db.status}` })
      }
      if (db?.ready && membersReady) return db
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
  const plan = provisionPlan(draft)
  const id = crypto.randomUUID().slice(0, 8)
  jobsStore.set((jobs) => [
    {
      id,
      provider: draft.provider,
      name: draft.name.trim(),
      engineLabel,
      state: 'running',
      activity: 'Starting',
      log: [],
      startedAt: Date.now()
    },
    ...jobs
  ])
  void (async () => {
    try {
      await runSteps(id, draft.provider, plan.steps, {})
      refreshCloud(draft.provider)
      const db = await waitUntilReady(id, plan)
      if (plan.afterReady.length) await runSteps(id, draft.provider, plan.afterReady, {})
      let connectionId: string | undefined
      if (draft.saveConnection) {
        const saved = await api.connectionSave(provisionedConnection(draft, db), draft.password)
        await loadConnections()
        connectionId = saved.id
        logJob(id, `Saved connection "${saved.name}"`)
      }
      updateJob(id, { state: 'ready', activity: 'Ready', connectionId })
      refreshCloud(draft.provider)
      toast(`${draft.name} is ready${connectionId ? ' and saved as a connection' : ''}`)
    } catch (e) {
      const message = errorMessage(e)
      logJob(id, message, 'error')
      updateJob(id, { state: 'failed', activity: 'Failed', error: message })
      refreshCloud(draft.provider)
      toast(`Provisioning ${draft.name} failed: ${message}`, 'error')
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
