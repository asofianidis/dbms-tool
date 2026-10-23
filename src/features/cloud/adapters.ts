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
  parseGcpAccounts,
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
 * One adapter per provider and account: who's signed in, which contexts there
 * are, what databases they hold, and the credentials to connect. The three big
 * clouds share an implementation over their CLIs; the rest have their own.
 * `account` is empty for the CLI's own sign-in (or the first saved token).
 */

export interface CliOptions {
  secret?: string
  timeoutSecs?: number
  workdir?: string
  account?: string
}

export function runCli(
  provider: CloudProvider,
  args: string[],
  options?: CliOptions
): Promise<string> {
  return api.cloudCli(provider, args, options)
}

export function callApi(
  provider: CloudProvider,
  method: string,
  path: string,
  body?: unknown,
  account?: string
): Promise<unknown> {
  return api.cloudApi(provider, method, path, body, account)
}

/** Runs a CLI command and returns null instead of failing (for optional lookups). */
async function tryCli(
  provider: CloudProvider,
  args: string[] | null,
  account: string
): Promise<string | null> {
  if (!args) return null
  return runCli(provider, args, { account }).then(
    (out) => out.trim() || null,
    () => null
  )
}

/** The Google accounts gcloud holds, for the account picker. */
export async function gcpAccounts(): Promise<CloudContext[]> {
  return parseGcpAccounts(await runCli('gcp', ['auth', 'list', '--format=json', '--quiet']))
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

function majorCloud(provider: MajorCloud, account: string): ProviderAdapter {
  const cli = (args: string[]): Promise<string> => runCli(provider, args, { account })
  return {
    identity: async (context) => {
      const out = await cli(identityCommand(provider, context))
      // gcloud lists every account it holds; a picked one is signed in if it's there
      if (provider === 'gcp' && account)
        return parseGcpAccounts(out).some((a) => a.id === account) ? account : null
      return parseIdentity(provider, out)
    },
    contexts: async () => ({
      contexts: parseContexts(provider, await cli(contextsCommand(provider))),
      defaultContext: await tryCli(provider, defaultContextCommand(provider), account)
    }),
    defaultRegion: (context) => tryCli(provider, defaultRegionCommand(provider, context), account),
    list: async (context, region) => {
      const commands = listCommands(provider, context, region)
      const results = await Promise.allSettled(
        commands.map(async (c) => parseList(c.key, await cli(c.args), context, region))
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
      const db = parseDescribe(ref, await cli(describeCommand(ref).args))
      // Aurora clusters are usable once a member instance is, not just the cluster
      if (db?.ready && provider === 'aws' && ref.kind === 'cluster') {
        const instances = await cli(clusterInstancesCommand(ref))
        if (!anyInstanceAvailable(instances))
          return { ...db, ready: false, status: 'instance creating' }
      }
      return db
    },
    credentials: async (db) => {
      const args = credentialsCommand(db)
      return args ? parseCredentials(db, await cli(args)) : {}
    }
  }
}

/**
 * Who a CLI is signed in as. A token added for another account may not be
 * allowed to say (organization tokens can't run whoami), so it counts as
 * signed in when it can list what it has access to.
 */
async function cliIdentity(
  account: string,
  whoami: () => Promise<string | null>,
  probe: () => Promise<unknown>
): Promise<string | null> {
  try {
    return await whoami()
  } catch (e) {
    if (!account) throw e
    await probe()
    return 'API token'
  }
}

function railway(account: string): ProviderAdapter {
  const cli = (args: string[]): Promise<string> => runCli('railway', args, { account })
  const projects = (): Promise<string> => cli(['api', RAILWAY_PROJECTS_QUERY])
  const adapter: ProviderAdapter = {
    identity: () =>
      cliIdentity(
        account,
        async () => {
          const out = await cli(['whoami', '--json'])
          try {
            const me = JSON.parse(out) as { email?: string; name?: string }
            return me.email || me.name || null
          } catch {
            return out.trim() || null
          }
        },
        projects
      ),
    contexts: async () => ({
      contexts: railwayContexts(await projects()),
      defaultContext: null
    }),
    defaultRegion: noDefault,
    list: async (context) => ({
      databases: railwayDatabases(await projects(), context),
      errors: []
    }),
    describe: async (ref) => {
      const listing = railwayDatabases(await projects(), ref.context)
      const db = listing.find((d) => d.ref.resource === ref.resource && d.ref.region === ref.region)
      if (!db) return null
      // Ready once the TCP proxy has a public address
      const credentials = await adapter.credentials(db)
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
      railwayCredentials(db.engine, await cli(['api', railwayVariablesQuery(db.ref)]))
  }
  return adapter
}

/** Token providers have nobody signed in until a token is saved. */
async function withToken<T>(
  provider: CloudProvider,
  account: string,
  run: () => Promise<T>
): Promise<T | null> {
  return (await api.cloudTokenStatus(provider, account)) ? run() : null
}

function render(account: string): ProviderAdapter {
  const get = (path: string): Promise<unknown> => callApi('render', 'GET', path, undefined, account)
  return {
    identity: async () =>
      (await withToken('render', account, async () =>
        renderIdentity(await get('/owners?limit=100'))
      )) ?? null,
    contexts: async () => ({
      contexts: renderContexts(await get('/owners?limit=100')),
      defaultContext: null
    }),
    defaultRegion: noDefault,
    list: async (context) => ({
      databases: renderDatabases(await get(renderListPath(context))),
      errors: []
    }),
    describe: async (ref) =>
      renderDatabase(
        (await get(`/postgres/${encodeURIComponent(ref.resource)}`)) as Record<string, unknown>
      ),
    credentials: async (db) =>
      renderCredentials(
        await get(`/postgres/${encodeURIComponent(db.ref.resource)}/connection-info`)
      )
  }
}

/**
 * Fly.io prints no passwords; the Machines API hands out a user's password.
 * Clusters come with a default user and database, which we look up rather
 * than assume, falling back to the usual names.
 */
async function flyCredentials(db: CloudDatabase, account: string): Promise<Credentials> {
  const id = db.ref.resource
  const users = flyUsers(
    (await tryCli('fly', ['mpg', 'users', 'list', id, '--json'], account)) ?? ''
  )
  let username = users[0] ?? 'fly-user'
  let password: string | undefined
  for (const candidate of users.length ? users : ['fly-user']) {
    try {
      password = flyPassword(
        await callApi('fly', 'GET', flyPasswordPath(db.ref, candidate), undefined, account)
      )
    } catch {
      // Reserved or missing user: try the next one
    }
    if (password) {
      username = candidate
      break
    }
  }
  const databases = flyDatabaseNames(
    (await tryCli('fly', ['mpg', 'databases', 'list', id, '--json'], account)) ?? ''
  )
  // The tunnel replaces host and port when connecting
  return { host: '127.0.0.1', port: 5432, username, password, database: databases[0] ?? 'fly-db' }
}

function fly(account: string): ProviderAdapter {
  const cli = (args: string[]): Promise<string> => runCli('fly', args, { account })
  const get = (path: string): Promise<unknown> => callApi('fly', 'GET', path, undefined, account)
  const orgs = async (): Promise<CloudContext[]> =>
    flyContexts(await cli(['orgs', 'list', '--json']))
  return {
    identity: () =>
      cliIdentity(account, async () => flyIdentity(await cli(['auth', 'whoami'])), orgs),
    contexts: async () => ({ contexts: await orgs(), defaultContext: 'personal' }),
    defaultRegion: noDefault,
    list: async (context) => ({
      databases: flyDatabases(await get(flyListPath(context)), context),
      errors: []
    }),
    describe: async (ref) =>
      flyDatabases(await get(`/postgres/${encodeURIComponent(ref.resource)}`), ref.context)[0] ??
      null,
    credentials: (db) => flyCredentials(db, account)
  }
}

function cloudflare(account: string): ProviderAdapter {
  const get = (path: string): Promise<unknown> =>
    callApi('cloudflare', 'GET', path, undefined, account)
  const adapter: ProviderAdapter = {
    identity: async () =>
      (await withToken('cloudflare', account, async () =>
        cloudflareIdentity(await get('/accounts'))
      )) ?? null,
    contexts: async () => {
      const contexts = cloudflareContexts(await get('/accounts'))
      return { contexts, defaultContext: contexts[0]?.id ?? null }
    },
    defaultRegion: noDefault,
    list: async (context) => {
      // D1 is per account; without a choice, use the first account the token sees
      const id = context || (await adapter.contexts()).defaultContext
      if (!id) return { databases: [], errors: [] }
      return { databases: cloudflareDatabases(await get(cloudflareListPath(id)), id), errors: [] }
    },
    describe: async (ref) =>
      cloudflareDatabases(
        await get(
          `/accounts/${encodeURIComponent(ref.context)}/d1/database/${encodeURIComponent(ref.resource)}`
        ),
        ref.context
      )[0] ?? null,
    // The D1 driver authenticates with the saved token itself
    credentials: async () => ({})
  }
  return adapter
}

/** Records the account on what an adapter finds, so later calls use it too. */
function withAccount(db: CloudDatabase, account: string): CloudDatabase {
  return account ? { ...db, ref: { ...db.ref, account } } : db
}

export function adapterFor(provider: CloudProvider, account = ''): ProviderAdapter {
  const adapter = isMajorCloud(provider)
    ? majorCloud(provider, account)
    : { railway, render, fly, cloudflare }[provider](account)
  return {
    ...adapter,
    list: async (context, region) => {
      const result = await adapter.list(context, region)
      return { ...result, databases: result.databases.map((db) => withAccount(db, account)) }
    },
    describe: async (ref) => {
      const db = await adapter.describe(ref)
      return db && withAccount(db, account)
    }
  }
}

/** The adapter for the account a database was found in. */
export function adapterForRef(ref: CloudRef): ProviderAdapter {
  return adapterFor(ref.provider, ref.account ?? '')
}
