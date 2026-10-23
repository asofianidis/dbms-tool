import type { CloudRef, Engine } from './api'
import {
  cidr,
  deletePlan as majorDeletePlan,
  engineOption,
  isMajorCloud,
  provisionPlan as majorProvisionPlan,
  splitMongoPassword,
  type CloudContext,
  type CloudDatabase,
  type Credentials,
  type DeleteOptions,
  type PlanStep,
  type ProvisionDraft,
  type ProvisionPlan
} from './cloud'
import { formatBytes } from './format'

/*
 * Railway, Render, Fly.io and Cloudflare D1. Railway and Fly.io run through
 * their CLIs (Railway's GraphQL API via `railway api`, so nothing needs a linked
 * folder); Render and Cloudflare go through their REST APIs; Fly.io's REST API
 * fills in what flyctl doesn't print, such as passwords. Pure, like cloud.ts.
 */

type Json = Record<string, unknown>

/* ---------- Railway ---------- */

export const RAILWAY_PROJECTS_QUERY =
  'query { projects { edges { node { id name ' +
  'environments { edges { node { id name } } } ' +
  'services { edges { node { id name icon ' +
  'serviceInstances { edges { node { environmentId source { image } } } } } } } } } } }'

interface RailwayProject {
  id: string
  name: string
  environments: { id: string; name: string }[]
  services: {
    id: string
    name: string
    icon: string
    instances: { environmentId: string; image: string }[]
  }[]
}

/** GraphQL lists arrive as `{ edges: [{ node }] }`; plain arrays are accepted too. */
function nodes(value: unknown): Json[] {
  if (Array.isArray(value)) return asRows(value)
  const edges = asRows((value as Json | null)?.edges)
  return edges.map((e) => e.node).filter((n): n is Json => !!n && typeof n === 'object')
}

/** `railway api` prints the GraphQL response; errors can arrive with HTTP 200. */
function graphqlData(stdout: string): Json {
  const json = parseJson<Json>(stdout)
  const errors = asRows(json?.errors)
  if (errors.length) throw new Error(str(errors[0].message) || 'Railway API error')
  return ((json?.data ?? json) as Json | null) ?? {}
}

export function railwayProjects(stdout: string): RailwayProject[] {
  return nodes(graphqlData(stdout).projects).map((p) => ({
    id: str(p.id),
    name: str(p.name),
    environments: nodes(p.environments).map((e) => ({ id: str(e.id), name: str(e.name) })),
    services: nodes(p.services).map((s) => ({
      id: str(s.id),
      name: str(s.name),
      icon: str(s.icon),
      instances: nodes(s.serviceInstances).map((i) => ({
        environmentId: str(i.environmentId),
        image: str((i.source as Json | undefined)?.image)
      }))
    }))
  }))
}

export function railwayContexts(stdout: string): CloudContext[] {
  return railwayProjects(stdout)
    .map((p) => ({
      id: p.id,
      label: p.name,
      isDefault: false,
      children: p.environments.map((e) => ({ id: e.id, label: e.name }))
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** Database services are recognised by their image (or, failing that, icon and name). */
export function railwayEngine(image: string, icon: string, name: string): Engine | null {
  const text = `${image} ${icon}`.toLowerCase()
  const fallback = name.toLowerCase()
  if (/postgres|postgis|timescale|pgvector/.test(text)) return 'postgres'
  if (/mysql|mariadb/.test(text)) return 'mysql'
  if (/mongo/.test(text)) return 'mongo'
  if (image) return null
  if (/postgres/.test(fallback)) return 'postgres'
  if (/mysql|mariadb/.test(fallback)) return 'mysql'
  if (/mongo/.test(fallback)) return 'mongo'
  return null
}

const RAILWAY_PRODUCTS: Partial<Record<Engine, string>> = {
  postgres: 'Railway PostgreSQL',
  mysql: 'Railway MySQL',
  mongo: 'Railway MongoDB'
}

/** Database services in every project, or just the project `context` names. */
export function railwayDatabases(stdout: string, context: string): CloudDatabase[] {
  return railwayProjects(stdout)
    .filter((p) => !context || p.id === context)
    .flatMap((project) =>
      project.services.flatMap((service) =>
        service.instances.flatMap((instance): CloudDatabase[] => {
          const engine = railwayEngine(instance.image, service.icon, service.name)
          if (!engine) return []
          const environment =
            project.environments.find((e) => e.id === instance.environmentId)?.name ?? ''
          return [
            {
              ref: {
                provider: 'railway',
                context: project.id,
                region: instance.environmentId,
                resource: service.id,
                kind: engine
              },
              name: service.name,
              engine,
              product: RAILWAY_PRODUCTS[engine] ?? 'Railway',
              status: 'deployed',
              ready: true,
              host: '',
              port: 0,
              user: '',
              database: '',
              size: instance.image.split('/').pop() ?? '',
              publicAccess: null,
              iamAuth: false,
              deletionProtection: false,
              location: environment ? `${project.name} / ${environment}` : project.name,
              endpointOnConnect: true
            }
          ]
        })
      )
    )
}

export function railwayVariablesQuery(ref: CloudRef): string {
  // JSON string literals are valid GraphQL string literals
  return (
    `query { variables(projectId: ${JSON.stringify(ref.context)}, ` +
    `environmentId: ${JSON.stringify(ref.region)}, serviceId: ${JSON.stringify(ref.resource)}) }`
  )
}

/** Splits a postgres:// or mysql:// URL into connection fields. */
export function urlCredentials(url: string): Credentials {
  if (/^mongodb(\+srv)?:\/\//i.test(url)) return splitMongoPassword(url)
  try {
    const parsed = new URL(url.replace(/^[a-z][a-z0-9+.-]*:/i, 'http:'))
    return {
      host: decodeURIComponent(parsed.hostname),
      port: parsed.port ? Number(parsed.port) : undefined,
      username: decodeURIComponent(parsed.username) || undefined,
      password: decodeURIComponent(parsed.password) || undefined,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || undefined
    }
  } catch {
    return {}
  }
}

/**
 * Credentials from a Railway database's variables: its public URL, or the TCP
 * proxy plus the template's user variables. Internal URLs (railway.internal)
 * don't resolve outside Railway.
 */
export function railwayCredentials(engine: Engine, stdout: string): Credentials {
  const vars = (graphqlData(stdout).variables ?? {}) as Record<string, unknown>
  const v = (key: string): string => str(vars[key])
  const url =
    engine === 'postgres'
      ? v('DATABASE_PUBLIC_URL')
      : engine === 'mysql'
        ? v('MYSQL_PUBLIC_URL')
        : v('MONGO_PUBLIC_URL')
  if (url) return urlCredentials(url)
  const host = v('RAILWAY_TCP_PROXY_DOMAIN')
  if (!host) return {}
  const prefix = engine === 'postgres' ? 'PG' : engine === 'mysql' ? 'MYSQL' : 'MONGO'
  return {
    host,
    port: Number(v('RAILWAY_TCP_PROXY_PORT')) || undefined,
    username: v(`${prefix}USER`) || v('MONGOINITDB_ROOT_USERNAME') || undefined,
    password: v(`${prefix}PASSWORD`) || v('MONGOINITDB_ROOT_PASSWORD') || undefined,
    database: v(`${prefix}DATABASE`) || undefined
  }
}

/** A folder key for running `railway link` / `railway add` in. */
function railwayWorkdir(draft: ProvisionDraft): string {
  const slug = (draft.context || `new-${draft.name}`).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60)
  return `railway-${slug}`
}

/** The service `railway add` created: the database service that wasn't there before. */
export function findNewRailwayService(
  stdout: string,
  existing: string[],
  want: { projectId: string; projectName: string; environmentId: string; engine: Engine }
): Record<string, string> {
  const project = railwayProjects(stdout).find((p) =>
    want.projectId ? p.id === want.projectId : p.name === want.projectName
  )
  if (!project) throw new Error("Couldn't find the project on Railway; check the dashboard")
  const environment =
    project.environments.find((e) => e.id === want.environmentId) ??
    project.environments.find((e) => e.name === 'production') ??
    project.environments[0]
  const service = project.services.find(
    (s) =>
      !existing.includes(s.id) &&
      s.instances.some((i) => railwayEngine(i.image, s.icon, s.name) === want.engine)
  )
  if (!service || !environment)
    throw new Error("Couldn't find the new database service; check the Railway dashboard")
  return { projectId: project.id, environmentId: environment.id, serviceId: service.id }
}

function railwayPlan(d: ProvisionDraft): ProvisionPlan {
  const option = engineOption('railway', d.engine)
  const fresh = !d.context
  const name = d.name.trim()
  const workdir = railwayWorkdir(d)
  const steps: PlanStep[] = [
    {
      title: 'Look up existing services',
      args: () => ['api', RAILWAY_PROJECTS_QUERY],
      capture: (out) => ({
        existing: railwayProjects(out)
          .flatMap((p) => p.services.map((s) => s.id))
          .join(',')
      })
    },
    fresh
      ? { title: `Create project ${name}`, args: () => ['init', '--name', name], workdir }
      : {
          title: 'Link the project',
          args: () => ['link', '--project', d.context, '--environment', d.region],
          workdir
        },
    {
      title: `Add ${option.label}`,
      args: () => ['add', '--database', d.engine],
      workdir,
      timeoutSecs: 5 * 60
    },
    {
      title: 'Find the new service',
      args: () => ['api', RAILWAY_PROJECTS_QUERY],
      capture: (out, ctx) =>
        findNewRailwayService(out, (ctx.existing ?? '').split(','), {
          projectId: d.context,
          projectName: name,
          environmentId: d.region,
          engine: option.engine
        })
    }
  ]
  const ref: CloudRef = {
    provider: 'railway',
    context: d.context,
    region: d.region,
    resource: '',
    kind: d.engine
  }
  return {
    ref,
    steps,
    afterReady: [],
    resolveRef: (ctx) => ({
      ...ref,
      context: ctx.projectId,
      region: ctx.environmentId,
      resource: ctx.serviceId
    })
  }
}

function railwayDelete(db: CloudDatabase): PlanStep[] {
  return [
    {
      title: `Delete service ${db.name}`,
      args: () => ['api', `mutation { serviceDelete(id: ${JSON.stringify(db.ref.resource)}) }`]
    }
  ]
}

/* ---------- Render ---------- */

export function renderContexts(json: unknown): CloudContext[] {
  return asRows(json)
    .map((row) => (row.owner ?? row) as Json)
    .map((o) => ({
      id: str(o.id),
      label: str(o.name) || str(o.email) || str(o.id),
      isDefault: false
    }))
    .filter((o) => o.id)
}

export function renderIdentity(json: unknown): string | null {
  const owner = asRows(json).map((row) => (row.owner ?? row) as Json)[0]
  return owner ? str(owner.email) || str(owner.name) || null : null
}

export function renderListPath(context: string): string {
  return `/postgres?limit=100${context ? `&ownerId=${encodeURIComponent(context)}` : ''}`
}

export function renderDatabase(p: Json): CloudDatabase {
  const owner = (p.owner ?? {}) as Json
  const allowList = asRows(p.ipAllowList)
  const suspended = p.suspended === 'suspended'
  const status = suspended ? 'suspended' : str(p.status).replace(/_/g, ' ')
  return {
    ref: {
      provider: 'render',
      context: str(owner.id),
      region: str(p.region),
      resource: str(p.id),
      kind: 'postgres'
    },
    name: str(p.name),
    engine: 'postgres',
    product: `Render PostgreSQL ${str(p.version)}`.trim(),
    status,
    ready: p.status === 'available' && !suspended,
    host: '',
    port: 5432,
    user: str(p.databaseUser),
    database: str(p.databaseName),
    size: [str(p.plan), p.diskSizeGB ? `${num(p.diskSizeGB)} GB` : ''].filter(Boolean).join(' · '),
    publicAccess: allowList.length > 0,
    iamAuth: false,
    deletionProtection: false,
    note: allowList.length
      ? undefined
      : 'Its access control list blocks every IP; add yours under Networking in the Render dashboard',
    endpointOnConnect: true
  }
}

/** `GET /postgres` wraps each database with a pagination cursor. */
export function renderDatabases(json: unknown): CloudDatabase[] {
  return asRows(json)
    .map((row) => (row.postgres ?? row) as Json)
    .map(renderDatabase)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function renderCredentials(json: unknown): Credentials {
  const info = (json ?? {}) as Json
  const credentials = urlCredentials(str(info.externalConnectionString))
  return { ...credentials, password: credentials.password ?? (str(info.password) || undefined) }
}

function renderPlan(d: ProvisionDraft): ProvisionPlan {
  const name = d.name.trim()
  const allowList =
    d.access === 'private'
      ? []
      : [{ cidrBlock: cidr(d), description: d.access === 'anywhere' ? 'Anywhere' : 'dbms-tool' }]
  const ref: CloudRef = {
    provider: 'render',
    context: d.context,
    region: d.region,
    resource: '',
    kind: 'postgres'
  }
  return {
    ref,
    steps: [
      {
        title: `Create the database ${name}`,
        args: () => [],
        api: () => ({
          method: 'POST',
          path: '/postgres',
          body: {
            name,
            ownerId: d.context,
            plan: d.size,
            region: d.region,
            version: d.version,
            ...(d.database ? { databaseName: d.database } : {}),
            ipAllowList: allowList
          }
        }),
        capture: (out) => ({ id: str(parseJson<Json>(out)?.id) })
      }
    ],
    afterReady: [],
    resolveRef: (ctx) => ({ ...ref, resource: ctx.id })
  }
}

function renderDelete(db: CloudDatabase): PlanStep[] {
  return [
    {
      title: `Delete ${db.name}`,
      args: () => [],
      api: () => ({ method: 'DELETE', path: `/postgres/${encodeURIComponent(db.ref.resource)}` })
    }
  ]
}

/* ---------- Fly.io ---------- */

/** `fly orgs list --json`: a slug → name map, or a list of orgs, depending on version. */
export function flyContexts(stdout: string): CloudContext[] {
  const json = parseJson<unknown>(stdout)
  const orgs = Array.isArray(json)
    ? asRows(json).map((o) => ({ slug: str(o.slug ?? o.Slug), name: str(o.name ?? o.Name) }))
    : Object.entries((json as Json | null) ?? {}).map(([slug, value]) => ({
        slug,
        name: typeof value === 'string' ? value : str((value as Json | null)?.name)
      }))
  return orgs
    .filter((o) => o.slug)
    .map((o) => ({
      id: o.slug,
      label: o.name && o.name !== o.slug ? `${o.name} (${o.slug})` : o.slug,
      isDefault: o.slug === 'personal'
    }))
}

/** `fly auth whoami` prints the signed-in email. */
export function flyIdentity(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.find((l) => l.includes('@')) ?? lines[0] ?? null
}

export function flyListPath(context: string): string {
  return `/postgres?org_slug=${encodeURIComponent(context || 'personal')}`
}

export function flyDatabase(c: Json, context: string): CloudDatabase {
  const org = (c.organization ?? {}) as Json
  const direct = (((c.endpoints as Json | undefined)?.primary as Json | undefined)?.direct ??
    {}) as Json
  const status = str(c.status)
  return {
    ref: {
      provider: 'fly',
      context: str(org.slug) || context || 'personal',
      region: str(c.region),
      resource: str(c.id),
      kind: 'mpg'
    },
    name: str(c.name),
    engine: 'postgres',
    product: `Fly Managed Postgres ${str(c.pg_major_version)}`.trim(),
    status,
    ready: status === 'ready',
    host: str(direct.host),
    port: num(direct.port) || 5432,
    user: '',
    database: '',
    size: [str(c.plan), c.disk_size_gb ? `${num(c.disk_size_gb)} GB` : '']
      .filter(Boolean)
      .join(' · '),
    publicAccess: false,
    iamAuth: false,
    deletionProtection: false,
    note: 'On Fly.io’s private network: connections go through a local fly mpg proxy tunnel',
    endpointOnConnect: true
  }
}

/** Both the list (`{ data: [...] }`) and get (`{ data: {...} }`) responses. */
export function flyDatabases(json: unknown, context: string): CloudDatabase[] {
  const data = (json as Json | null)?.data ?? json
  const rows = Array.isArray(data)
    ? asRows(data)
    : data && typeof data === 'object'
      ? [data as Json]
      : []
  return rows
    .filter((c) => c.status !== 'deleted')
    .map((c) => flyDatabase(c, context))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** User names from `fly mpg users list --json`, schema admins first. */
export function flyUsers(stdout: string): string[] {
  const json = parseJson<unknown>(stdout)
  const data = (json as Json | null)?.data ?? json
  const rows = Array.isArray(data) ? data : []
  const users = rows.map((u) =>
    typeof u === 'string'
      ? { name: u, role: '' }
      : { name: str((u as Json).name ?? (u as Json).username), role: str((u as Json).role) }
  )
  const rank = (role: string): number =>
    role === 'schema_admin' ? 0 : role === 'writer' ? 1 : role ? 2 : 1
  return users
    .filter((u) => u.name)
    .sort((a, b) => rank(a.role) - rank(b.role))
    .map((u) => u.name)
}

/** Database names from `fly mpg databases list --json`, skipping the built-in ones. */
export function flyDatabaseNames(stdout: string): string[] {
  const json = parseJson<unknown>(stdout)
  const data = (json as Json | null)?.data ?? json
  const rows = Array.isArray(data) ? data : []
  return rows
    .map((d) => (typeof d === 'string' ? d : str((d as Json).name)))
    .filter((n) => n && !['postgres', 'template0', 'template1'].includes(n))
}

export function flyPasswordPath(ref: CloudRef, user: string): string {
  return `/postgres/${encodeURIComponent(ref.resource)}/users/${encodeURIComponent(user)}/credentials`
}

export function flyPassword(json: unknown): string | undefined {
  const data = ((json as Json | null)?.data ?? json) as Json | null
  return str(data?.password) || undefined
}

function flyPlan(d: ProvisionDraft): ProvisionPlan {
  const name = d.name.trim()
  const ref: CloudRef = {
    provider: 'fly',
    context: d.context || 'personal',
    region: d.region,
    resource: '',
    kind: 'mpg'
  }
  return {
    ref,
    steps: [
      {
        title: 'Create the cluster (takes several minutes)',
        args: () => [
          'mpg',
          'create',
          '--name',
          name,
          '--region',
          d.region,
          '--plan',
          d.size,
          '--pg-major-version',
          d.version,
          '--volume-size',
          String(d.storageGb),
          ...(d.context ? ['--org', d.context] : [])
        ],
        timeoutSecs: 45 * 60
      },
      {
        title: 'Find the new cluster',
        args: () => [],
        api: () => ({ method: 'GET', path: flyListPath(d.context) }),
        capture: (out) => {
          const cluster = flyDatabases(parseJson(out), d.context).find((c) => c.name === name)
          if (!cluster) throw new Error("Couldn't find the new cluster; check the Fly.io dashboard")
          return { id: cluster.ref.resource }
        }
      }
    ],
    afterReady: [],
    resolveRef: (ctx) => ({ ...ref, resource: ctx.id })
  }
}

function flyDelete(db: CloudDatabase): PlanStep[] {
  return [
    {
      title: `Destroy cluster ${db.name}`,
      args: () => ['mpg', 'destroy', db.ref.resource, '--yes'],
      timeoutSecs: 10 * 60
    }
  ]
}

/* ---------- Cloudflare D1 ---------- */

/** Cloudflare wraps every response as `{ success, errors, result }`. */
function cfResult(json: unknown): unknown {
  return (json as Json | null)?.result ?? json
}

export function cloudflareContexts(json: unknown): CloudContext[] {
  return asRows(cfResult(json))
    .map((a) => ({ id: str(a.id), label: str(a.name) || str(a.id), isDefault: false }))
    .filter((a) => a.id)
}

export function cloudflareIdentity(json: unknown): string | null {
  return cloudflareContexts(json)[0]?.label ?? null
}

export function cloudflareListPath(account: string): string {
  return `/accounts/${encodeURIComponent(account)}/d1/database?per_page=1000`
}

export function cloudflareDatabase(d: Json, account: string): CloudDatabase {
  const jurisdiction = str(d.jurisdiction)
  return {
    ref: {
      provider: 'cloudflare',
      context: account,
      region: jurisdiction,
      resource: str(d.uuid),
      kind: 'd1'
    },
    name: str(d.name),
    engine: 'sqlite',
    product: 'Cloudflare D1',
    status: 'ready',
    ready: true,
    host: '',
    port: 0,
    user: '',
    database: str(d.name),
    size: typeof d.file_size === 'number' ? formatBytes(d.file_size) : '',
    publicAccess: null,
    iamAuth: false,
    deletionProtection: false,
    location: jurisdiction ? `${jurisdiction.toUpperCase()} jurisdiction` : undefined,
    endpointOnConnect: true
  }
}

/** Both the list (array) and get (object) responses. */
export function cloudflareDatabases(json: unknown, account: string): CloudDatabase[] {
  const result = cfResult(json)
  const rows = Array.isArray(result) ? asRows(result) : result ? [result as Json] : []
  return rows
    .map((d) => cloudflareDatabase(d, account))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function cloudflarePlan(d: ProvisionDraft): ProvisionPlan {
  const name = d.name.trim()
  const ref: CloudRef = {
    provider: 'cloudflare',
    context: d.context,
    region: '',
    resource: '',
    kind: 'd1'
  }
  return {
    ref,
    steps: [
      {
        title: `Create D1 database ${name}`,
        args: () => [],
        api: () => ({
          method: 'POST',
          path: `/accounts/${encodeURIComponent(d.context)}/d1/database`,
          body: { name, ...(d.region ? { primary_location_hint: d.region } : {}) }
        }),
        capture: (out) => ({ id: str((cfResult(parseJson(out)) as Json | null)?.uuid) })
      }
    ],
    afterReady: [],
    resolveRef: (ctx) => ({ ...ref, resource: ctx.id })
  }
}

function cloudflareDelete(db: CloudDatabase): PlanStep[] {
  const { context, resource } = db.ref
  return [
    {
      title: `Delete D1 database ${db.name}`,
      args: () => [],
      api: () => ({
        method: 'DELETE',
        path: `/accounts/${encodeURIComponent(context)}/d1/database/${encodeURIComponent(resource)}`
      })
    }
  ]
}

/* ---------- Every provider ---------- */

/** The provisioning plan for any provider. */
export function planProvision(draft: ProvisionDraft): ProvisionPlan {
  const provider = draft.provider
  if (isMajorCloud(provider)) return majorProvisionPlan({ ...draft, provider })
  switch (provider) {
    case 'railway':
      return railwayPlan(draft)
    case 'render':
      return renderPlan(draft)
    case 'fly':
      return flyPlan(draft)
    case 'cloudflare':
      return cloudflarePlan(draft)
  }
}

/** The delete steps for any provider. */
export function planDelete(
  db: CloudDatabase,
  options: DeleteOptions,
  now = new Date()
): PlanStep[] {
  const provider = db.ref.provider
  if (isMajorCloud(provider)) return majorDeletePlan(db, options, now)
  switch (provider) {
    case 'railway':
      return railwayDelete(db)
    case 'render':
      return renderDelete(db)
    case 'fly':
      return flyDelete(db)
    case 'cloudflare':
      return cloudflareDelete(db)
  }
}

/* ---------- helpers ---------- */

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function asRows(value: unknown): Json[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as Json[]) : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}
