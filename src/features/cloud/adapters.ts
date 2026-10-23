import { api, type CloudProvider, type CloudRef } from '@/lib/api'
import {
  anyInstanceAvailable,
  clusterInstancesCommand,
  contextsCommand,
  credentialsCommand,
  defaultContextCommand,
  defaultRegionCommand,
  describeCommand,
  identityCommand,
  isMajorCloud,
  listCommands,
  parseContexts,
  parseCredentials,
  parseDescribe,
  parseIdentity,
  parseList,
  type CloudContext,
  type CloudDatabase,
  type Credentials,
  type MajorCloud
} from '@/lib/cloud'
import {
  RAILWAY_PROJECTS_QUERY,
  cloudflareContexts,
  cloudflareDatabases,
  cloudflareIdentity,
  cloudflareListPath,
  flyContexts,
  flyDatabaseNames,
  flyDatabases,
  flyIdentity,
  flyListPath,
  flyPassword,
  flyPasswordPath,
  flyUsers,
  railwayContexts,
  railwayCredentials,
  railwayDatabases,
  railwayVariablesQuery,
  renderContexts,
  renderCredentials,
  renderDatabase,
  renderDatabases,
  renderIdentity,
  renderListPath
} from '@/lib/cloud-platforms'
import { errorMessage } from '@/lib/toast'

/*
 * One adapter per provider: who's signed in, which accounts there are, what
 * databases they hold, and the credentials to connect. The three big clouds
 * share an implementation over their CLIs; the rest have their own.
 */

export function runCli(
  provider: CloudProvider,
  args: string[],
  options?: { secret?: string; timeoutSecs?: number; workdir?: string }
): Promise<string> {
  return api.cloudCli(provider, args, options)
}

export function callApi(
  provider: CloudProvider,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  return api.cloudApi(provider, method, path, body)
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

export interface ProviderAdapter {
  /** Null when nobody is signed in (or no token is saved) */
  identity(context: string): Promise<string | null>
  contexts(): Promise<{ contexts: CloudContext[]; defaultContext: string | null }>
  defaultRegion(context: string): Promise<string | null>
  list(context: string, region: string): Promise<ListResult>
  /** One database again, for provisioning progress */
  describe(ref: CloudRef): Promise<CloudDatabase | null>
  /** What connecting needs beyond the listing: endpoint, user, password */
  credentials(db: CloudDatabase): Promise<Credentials>
}

const noDefault = async (): Promise<null> => null

function majorCloud(provider: MajorCloud): ProviderAdapter {
  return {
    identity: async (context) =>
      parseIdentity(provider, await runCli(provider, identityCommand(provider, context))),
    contexts: async () => ({
      contexts: parseContexts(provider, await runCli(provider, contextsCommand(provider))),
      defaultContext: await tryCli(provider, defaultContextCommand(provider))
    }),
    defaultRegion: (context) => tryCli(provider, defaultRegionCommand(provider, context)),
    list: async (context, region) => {
      const commands = listCommands(provider, context, region)
      const results = await Promise.allSettled(
        commands.map(async (c) => parseList(c.key, await runCli(provider, c.args), context, region))
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
    describe: async (ref) => {
      const db = parseDescribe(ref, await runCli(provider, describeCommand(ref).args))
      // Aurora clusters are usable once a member instance is, not just the cluster
      if (db?.ready && provider === 'aws' && ref.kind === 'cluster') {
        const instances = await runCli(provider, clusterInstancesCommand(ref))
        if (!anyInstanceAvailable(instances))
          return { ...db, ready: false, status: 'instance creating' }
      }
      return db
    },
    credentials: async (db) => {
      const args = credentialsCommand(db)
      return args ? parseCredentials(db, await runCli(provider, args)) : {}
    }
  }
}

const railway: ProviderAdapter = {
  identity: async () => {
    const out = await runCli('railway', ['whoami', '--json'])
    try {
      const me = JSON.parse(out) as { email?: string; name?: string }
      return me.email || me.name || null
    } catch {
      return out.trim() || null
    }
  },
  contexts: async () => ({
    contexts: railwayContexts(await runCli('railway', ['api', RAILWAY_PROJECTS_QUERY])),
    defaultContext: null
  }),
  defaultRegion: noDefault,
  list: async (context) => ({
    databases: railwayDatabases(await runCli('railway', ['api', RAILWAY_PROJECTS_QUERY]), context),
    errors: []
  }),
  describe: async (ref) => {
    const listing = railwayDatabases(
      await runCli('railway', ['api', RAILWAY_PROJECTS_QUERY]),
      ref.context
    )
    const db = listing.find((d) => d.ref.resource === ref.resource && d.ref.region === ref.region)
    if (!db) return null
    // Ready once the TCP proxy has a public address
    const credentials = await railway.credentials(db)
    const reachable = !!(credentials.host || credentials.uri)
    return {
      ...db,
      host: credentials.host ?? '',
      port: credentials.port ?? 0,
      ready: reachable,
      status: reachable ? 'deployed' : 'deploying'
    }
  },
  credentials: async (db) =>
    railwayCredentials(db.engine, await runCli('railway', ['api', railwayVariablesQuery(db.ref)]))
}

/** Token providers have nobody signed in until a token is saved. */
async function withToken<T>(provider: CloudProvider, run: () => Promise<T>): Promise<T | null> {
  return (await api.cloudTokenStatus(provider)) ? run() : null
}

const render: ProviderAdapter = {
  identity: async () =>
    (await withToken('render', async () =>
      renderIdentity(await callApi('render', 'GET', '/owners?limit=100'))
    )) ?? null,
  contexts: async () => ({
    contexts: renderContexts(await callApi('render', 'GET', '/owners?limit=100')),
    defaultContext: null
  }),
  defaultRegion: noDefault,
  list: async (context) => ({
    databases: renderDatabases(await callApi('render', 'GET', renderListPath(context))),
    errors: []
  }),
  describe: async (ref) =>
    renderDatabase(
      (await callApi('render', 'GET', `/postgres/${encodeURIComponent(ref.resource)}`)) as Record<
        string,
        unknown
      >
    ),
  credentials: async (db) =>
    renderCredentials(
      await callApi(
        'render',
        'GET',
        `/postgres/${encodeURIComponent(db.ref.resource)}/connection-info`
      )
    )
}

/**
 * Fly.io prints no passwords; the Machines API hands out a user's password.
 * Clusters come with a default user and database, which we look up rather
 * than assume, falling back to the usual names.
 */
async function flyCredentials(db: CloudDatabase): Promise<Credentials> {
  const id = db.ref.resource
  const users = flyUsers((await tryCli('fly', ['mpg', 'users', 'list', id, '--json'])) ?? '')
  let username = users[0] ?? 'fly-user'
  let password: string | undefined
  for (const candidate of users.length ? users : ['fly-user']) {
    try {
      password = flyPassword(await callApi('fly', 'GET', flyPasswordPath(db.ref, candidate)))
    } catch {
      // Reserved or missing user: try the next one
    }
    if (password) {
      username = candidate
      break
    }
  }
  const databases = flyDatabaseNames(
    (await tryCli('fly', ['mpg', 'databases', 'list', id, '--json'])) ?? ''
  )
  // The tunnel replaces host and port when connecting
  return { host: '127.0.0.1', port: 5432, username, password, database: databases[0] ?? 'fly-db' }
}

const fly: ProviderAdapter = {
  identity: async () => flyIdentity(await runCli('fly', ['auth', 'whoami'])),
  contexts: async () => ({
    contexts: flyContexts(await runCli('fly', ['orgs', 'list', '--json'])),
    defaultContext: 'personal'
  }),
  defaultRegion: noDefault,
  list: async (context) => ({
    databases: flyDatabases(await callApi('fly', 'GET', flyListPath(context)), context),
    errors: []
  }),
  describe: async (ref) =>
    flyDatabases(
      await callApi('fly', 'GET', `/postgres/${encodeURIComponent(ref.resource)}`),
      ref.context
    )[0] ?? null,
  credentials: flyCredentials
}

const cloudflare: ProviderAdapter = {
  identity: async () =>
    (await withToken('cloudflare', async () =>
      cloudflareIdentity(await callApi('cloudflare', 'GET', '/accounts'))
    )) ?? null,
  contexts: async () => {
    const contexts = cloudflareContexts(await callApi('cloudflare', 'GET', '/accounts'))
    return { contexts, defaultContext: contexts[0]?.id ?? null }
  },
  defaultRegion: noDefault,
  list: async (context) => {
    // D1 is per account; without a choice, use the first account the token sees
    const account = context || (await cloudflare.contexts()).defaultContext
    if (!account) return { databases: [], errors: [] }
    return {
      databases: cloudflareDatabases(
        await callApi('cloudflare', 'GET', cloudflareListPath(account)),
        account
      ),
      errors: []
    }
  },
  describe: async (ref) =>
    cloudflareDatabases(
      await callApi(
        'cloudflare',
        'GET',
        `/accounts/${encodeURIComponent(ref.context)}/d1/database/${encodeURIComponent(ref.resource)}`
      ),
      ref.context
    )[0] ?? null,
  // The D1 driver authenticates with the saved token itself
  credentials: async () => ({})
}

export function adapterFor(provider: CloudProvider): ProviderAdapter {
  if (isMajorCloud(provider)) return majorCloud(provider)
  return { railway, render, fly, cloudflare }[provider]
}
