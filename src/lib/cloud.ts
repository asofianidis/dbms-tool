import type { CloudProvider, CloudRef, ConnectionConfig, Engine } from './api'
import { newConnection } from './engines'

/*
 * Cloud databases on AWS, Google Cloud and Azure, driven through each provider's
 * own CLI (aws, gcloud, az) so existing sign-ins, SSO and MFA just work. This
 * module is pure: it builds CLI arguments and parses their JSON output. Running
 * them lives in features/cloud/actions.ts.
 */

export interface ProviderInfo {
  id: CloudProvider
  label: string
  /** Executable name, shown in messages */
  cli: string
  /** What a "context" is: profile, project or subscription */
  contextLabel: string
  installUrl: string
  pricingUrl: string
  /** Arguments that start an interactive (browser) sign-in */
  signIn: (context: string) => string[]
  signInHint: string
  /** AWS lists databases one region at a time; the others list every region at once */
  regionScoped: boolean
}

export const PROVIDERS: Record<CloudProvider, ProviderInfo> = {
  aws: {
    id: 'aws',
    label: 'AWS',
    cli: 'aws',
    contextLabel: 'Profile',
    installUrl: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
    pricingUrl: 'https://aws.amazon.com/rds/pricing/',
    signIn: (context) => ['sso', 'login', ...(context ? ['--profile', context] : [])],
    signInHint:
      'Run "aws configure" for access keys, or "aws configure sso" once and then sign in here.',
    regionScoped: true
  },
  gcp: {
    id: 'gcp',
    label: 'Google Cloud',
    cli: 'gcloud',
    contextLabel: 'Project',
    installUrl: 'https://cloud.google.com/sdk/docs/install',
    pricingUrl: 'https://cloud.google.com/sql/pricing',
    signIn: () => ['auth', 'login', '--brief'],
    signInHint: 'Sign in opens your browser, the same as "gcloud auth login".',
    regionScoped: false
  },
  azure: {
    id: 'azure',
    label: 'Azure',
    cli: 'az',
    contextLabel: 'Subscription',
    installUrl: 'https://learn.microsoft.com/cli/azure/install-azure-cli',
    pricingUrl: 'https://azure.microsoft.com/pricing/details/azure-sql-database/',
    signIn: () => ['login', '--output', 'none', '--only-show-errors'],
    signInHint: 'Sign in opens your browser, the same as "az login".',
    regionScoped: false
  }
}

export const PROVIDER_ORDER: CloudProvider[] = ['aws', 'gcp', 'azure']

export const REGIONS: Record<CloudProvider, { id: string; label: string }[]> = {
  aws: [
    { id: 'us-east-1', label: 'US East (N. Virginia)' },
    { id: 'us-east-2', label: 'US East (Ohio)' },
    { id: 'us-west-1', label: 'US West (N. California)' },
    { id: 'us-west-2', label: 'US West (Oregon)' },
    { id: 'ca-central-1', label: 'Canada (Central)' },
    { id: 'sa-east-1', label: 'South America (São Paulo)' },
    { id: 'eu-west-1', label: 'Europe (Ireland)' },
    { id: 'eu-west-2', label: 'Europe (London)' },
    { id: 'eu-west-3', label: 'Europe (Paris)' },
    { id: 'eu-central-1', label: 'Europe (Frankfurt)' },
    { id: 'eu-north-1', label: 'Europe (Stockholm)' },
    { id: 'ap-south-1', label: 'Asia Pacific (Mumbai)' },
    { id: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
    { id: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
    { id: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
    { id: 'ap-northeast-2', label: 'Asia Pacific (Seoul)' }
  ],
  gcp: [
    { id: 'us-central1', label: 'Iowa (us-central1)' },
    { id: 'us-east1', label: 'South Carolina (us-east1)' },
    { id: 'us-east4', label: 'N. Virginia (us-east4)' },
    { id: 'us-west1', label: 'Oregon (us-west1)' },
    { id: 'northamerica-northeast1', label: 'Montréal (northamerica-northeast1)' },
    { id: 'southamerica-east1', label: 'São Paulo (southamerica-east1)' },
    { id: 'europe-west1', label: 'Belgium (europe-west1)' },
    { id: 'europe-west2', label: 'London (europe-west2)' },
    { id: 'europe-west3', label: 'Frankfurt (europe-west3)' },
    { id: 'europe-north1', label: 'Finland (europe-north1)' },
    { id: 'asia-south1', label: 'Mumbai (asia-south1)' },
    { id: 'asia-southeast1', label: 'Singapore (asia-southeast1)' },
    { id: 'asia-northeast1', label: 'Tokyo (asia-northeast1)' },
    { id: 'australia-southeast1', label: 'Sydney (australia-southeast1)' }
  ],
  azure: [
    { id: 'eastus', label: 'East US' },
    { id: 'eastus2', label: 'East US 2' },
    { id: 'centralus', label: 'Central US' },
    { id: 'westus2', label: 'West US 2' },
    { id: 'westus3', label: 'West US 3' },
    { id: 'canadacentral', label: 'Canada Central' },
    { id: 'brazilsouth', label: 'Brazil South' },
    { id: 'northeurope', label: 'North Europe' },
    { id: 'westeurope', label: 'West Europe' },
    { id: 'uksouth', label: 'UK South' },
    { id: 'germanywestcentral', label: 'Germany West Central' },
    { id: 'swedencentral', label: 'Sweden Central' },
    { id: 'centralindia', label: 'Central India' },
    { id: 'southeastasia', label: 'Southeast Asia' },
    { id: 'japaneast', label: 'Japan East' },
    { id: 'australiaeast', label: 'Australia East' }
  ]
}

export function regionLabel(provider: CloudProvider, region: string): string {
  return REGIONS[provider].find((r) => r.id === region)?.label ?? region
}

/** Global flags that pick the account, region and JSON output. */
export function scopeArgs(provider: CloudProvider, context: string, region?: string): string[] {
  switch (provider) {
    case 'aws':
      return [
        ...(context ? ['--profile', context] : []),
        ...(region ? ['--region', region] : []),
        '--output',
        'json'
      ]
    case 'gcp':
      return [...(context ? ['--project', context] : []), '--format=json', '--quiet']
    case 'azure':
      return [
        ...(context ? ['--subscription', context] : []),
        '--output',
        'json',
        '--only-show-errors'
      ]
  }
}

/* ---------- Accounts ---------- */

export interface CloudContext {
  id: string
  label: string
  isDefault: boolean
}

/** Command listing profiles / projects / subscriptions. */
export function contextsCommand(provider: CloudProvider): string[] {
  switch (provider) {
    case 'aws':
      return ['configure', 'list-profiles']
    case 'gcp':
      return ['projects', 'list', '--format=json', '--quiet']
    case 'azure':
      return ['account', 'list', '--output', 'json', '--only-show-errors']
  }
}

export function parseContexts(provider: CloudProvider, stdout: string): CloudContext[] {
  if (provider === 'aws') {
    // Plain text, one profile per line
    return stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((id) => ({ id, label: id, isDefault: id === 'default' }))
  }
  const rows = parseJson<Record<string, unknown>[]>(stdout) ?? []
  if (provider === 'gcp') {
    return rows
      .map((p) => ({
        id: str(p.projectId),
        label:
          str(p.name) && str(p.name) !== str(p.projectId)
            ? `${p.name} (${p.projectId})`
            : str(p.projectId),
        isDefault: false
      }))
      .filter((p) => p.id)
      .sort((a, b) => a.label.localeCompare(b.label))
  }
  return rows
    .filter((s) => !s.state || s.state === 'Enabled')
    .map((s) => ({
      id: str(s.id),
      label: str(s.name) || str(s.id),
      isDefault: s.isDefault === true
    }))
}

/** Who the CLI is signed in as; the command fails (or lists nobody) when signed out. */
export function identityCommand(provider: CloudProvider, context: string): string[] {
  switch (provider) {
    case 'aws':
      return ['sts', 'get-caller-identity', ...scopeArgs('aws', context)]
    case 'gcp':
      return ['auth', 'list', '--format=json', '--quiet']
    case 'azure':
      return ['account', 'show', ...scopeArgs('azure', context)]
  }
}

/** The signed-in identity, or null when nobody is signed in. */
export function parseIdentity(provider: CloudProvider, stdout: string): string | null {
  const json = parseJson<Record<string, unknown> | Record<string, unknown>[]>(stdout)
  if (!json) return null
  if (provider === 'aws' && !Array.isArray(json)) {
    const arn = str(json.Arn)
    // arn:aws:sts::123456789012:assumed-role/Role/user → 123456789012 · Role/user
    const match = arn.match(/^arn:aws[^:]*:(?:sts|iam)::(\d+):(?:assumed-role|user|role)\/(.+)$/)
    return match ? `${match[2]} · ${match[1]}` : arn || str(json.Account) || null
  }
  if (provider === 'gcp' && Array.isArray(json)) {
    return str(json.find((a) => a.status === 'ACTIVE')?.account) || null
  }
  if (provider === 'azure' && !Array.isArray(json)) {
    const user = json.user as Record<string, unknown> | undefined
    return str(user?.name) || str(json.name) || null
  }
  return null
}

/** The CLI's default region / project, as `aws configure get region` etc. print it. */
export function defaultContextCommand(provider: CloudProvider): string[] | null {
  return provider === 'gcp' ? ['config', 'get-value', 'project'] : null
}

export function defaultRegionCommand(provider: CloudProvider, context: string): string[] | null {
  return provider === 'aws'
    ? ['configure', 'get', 'region', ...(context ? ['--profile', context] : [])]
    : null
}

/* ---------- Discovered databases ---------- */

export interface CloudDatabase {
  ref: CloudRef
  name: string
  engine: Engine
  /** e.g. "Aurora PostgreSQL 16.4" */
  product: string
  status: string
  ready: boolean
  host: string
  port: number
  user: string
  database: string
  /** Instance class / tier and storage */
  size: string
  /** null when the provider doesn't say */
  publicAccess: boolean | null
  /** AWS Secrets Manager secret holding the master password */
  secretArn?: string
  /** Accepts passwordless sign-in: AWS IAM, Google Cloud IAM or Microsoft Entra ID */
  iamAuth: boolean
  deletionProtection: boolean
  /** Instances in an AWS cluster, which go before the cluster can be deleted */
  members?: string[]
  /** Why connecting from here may not work */
  note?: string
}

export interface ListCommand {
  /** Which parser handles the output */
  key:
    | 'aws-instances'
    | 'aws-clusters'
    | 'gcp-instances'
    | 'azure-postgres'
    | 'azure-mysql'
    | 'azure-sql'
    | 'azure-cosmos'
  label: string
  args: string[]
}

export function listCommands(
  provider: CloudProvider,
  context: string,
  region: string
): ListCommand[] {
  const scope = scopeArgs(provider, context, region)
  switch (provider) {
    case 'aws':
      return [
        {
          key: 'aws-instances',
          label: 'RDS instances',
          args: ['rds', 'describe-db-instances', ...scope]
        },
        {
          key: 'aws-clusters',
          label: 'Aurora and DocumentDB clusters',
          args: ['rds', 'describe-db-clusters', ...scope]
        }
      ]
    case 'gcp':
      return [
        {
          key: 'gcp-instances',
          label: 'Cloud SQL instances',
          args: ['sql', 'instances', 'list', ...scope]
        }
      ]
    case 'azure':
      return [
        {
          key: 'azure-postgres',
          label: 'PostgreSQL flexible servers',
          args: ['postgres', 'flexible-server', 'list', ...scope]
        },
        {
          key: 'azure-mysql',
          label: 'MySQL flexible servers',
          args: ['mysql', 'flexible-server', 'list', ...scope]
        },
        { key: 'azure-sql', label: 'Azure SQL servers', args: ['sql', 'server', 'list', ...scope] },
        {
          key: 'azure-cosmos',
          label: 'Cosmos DB accounts',
          args: ['cosmosdb', 'list', ...scope]
        }
      ]
  }
}

type Json = Record<string, unknown>

export function parseList(
  key: ListCommand['key'],
  stdout: string,
  context: string,
  region: string
): CloudDatabase[] {
  const json = parseJson<unknown>(stdout)
  switch (key) {
    case 'aws-instances':
      return (
        asRows((json as Json | null)?.DBInstances)
          // Cluster members are listed through their cluster's endpoint
          .filter((i) => !i.DBClusterIdentifier)
          .map((i) => awsInstance(i, context, region))
          .filter(isDefined)
      )
    case 'aws-clusters':
      return asRows((json as Json | null)?.DBClusters)
        .map((c) => awsCluster(c, context, region))
        .filter(isDefined)
    case 'gcp-instances':
      return asRows(json)
        .map((i) => gcpInstance(i, context))
        .filter(isDefined)
    case 'azure-postgres':
      return asRows(json).map((s) => azureServer(s, 'postgres', context))
    case 'azure-mysql':
      return asRows(json).map((s) => azureServer(s, 'mysql', context))
    case 'azure-sql':
      return asRows(json).map((s) => azureServer(s, 'sql', context))
    case 'azure-cosmos':
      return asRows(json)
        .map((a) => azureCosmos(a, context))
        .filter(isDefined)
  }
}

const AWS_ENGINES: Record<string, string> = {
  postgres: 'PostgreSQL',
  'aurora-postgresql': 'Aurora PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  'aurora-mysql': 'Aurora MySQL',
  aurora: 'Aurora MySQL',
  'sqlserver-ex': 'SQL Server Express',
  'sqlserver-web': 'SQL Server Web',
  'sqlserver-se': 'SQL Server Standard',
  'sqlserver-ee': 'SQL Server Enterprise',
  docdb: 'DocumentDB'
}

function awsEngine(engine: string): Engine | null {
  if (engine.includes('postgres')) return 'postgres'
  if (engine.includes('mysql') || engine === 'mariadb' || engine === 'aurora') return 'mysql'
  if (engine.startsWith('sqlserver')) return 'mssql'
  if (engine === 'docdb') return 'mongo'
  return null
}

function awsInstance(i: Json, context: string, region: string): CloudDatabase | null {
  const engineName = str(i.Engine)
  const engine = awsEngine(engineName)
  if (!engine) return null
  const endpoint = (i.Endpoint ?? {}) as Json
  const status = str(i.DBInstanceStatus)
  const isPublic = typeof i.PubliclyAccessible === 'boolean' ? i.PubliclyAccessible : null
  return {
    ref: {
      provider: 'aws',
      context,
      region,
      resource: str(i.DBInstanceIdentifier),
      kind: 'instance'
    },
    name: str(i.DBInstanceIdentifier),
    engine,
    product: `${AWS_ENGINES[engineName] ?? engineName} ${str(i.EngineVersion)}`.trim(),
    status,
    ready: status === 'available' && !!endpoint.Address,
    host: str(endpoint.Address),
    port: num(endpoint.Port),
    user: str(i.MasterUsername),
    database: str(i.DBName),
    size: [str(i.DBInstanceClass), i.AllocatedStorage ? `${num(i.AllocatedStorage)} GiB` : '']
      .filter(Boolean)
      .join(' · '),
    publicAccess: isPublic,
    secretArn: str((i.MasterUserSecret as Json | undefined)?.SecretArn) || undefined,
    iamAuth: i.IAMDatabaseAuthenticationEnabled === true,
    deletionProtection: i.DeletionProtection === true,
    note:
      isPublic === false ? 'Not publicly accessible: reachable only from inside its VPC' : undefined
  }
}

function awsCluster(c: Json, context: string, region: string): CloudDatabase | null {
  const engineName = str(c.Engine)
  const baseEngine = awsEngine(engineName)
  if (!baseEngine) return null
  // Babelfish has no flag of its own: the cluster parameter group turns it on,
  // and the groups dbms-tool creates (like most) say so in their name
  const babelfish = baseEngine === 'postgres' && /babelfish/i.test(str(c.DBClusterParameterGroup))
  const engine: Engine = babelfish ? 'babelfish' : baseEngine
  const status = str(c.Status)
  const scaling = c.ServerlessV2ScalingConfiguration as Json | undefined
  const members = asRows(c.DBClusterMembers)
  const size = scaling
    ? `Serverless v2 · ${num(scaling.MinCapacity)}–${num(scaling.MaxCapacity)} ACU`
    : `${members.length} instance${members.length === 1 ? '' : 's'}`
  return {
    ref: {
      provider: 'aws',
      context,
      region,
      resource: str(c.DBClusterIdentifier),
      kind: 'cluster'
    },
    name: str(c.DBClusterIdentifier),
    engine,
    product:
      `${babelfish ? 'Aurora Babelfish' : (AWS_ENGINES[engineName] ?? engineName)} ${str(c.EngineVersion)}`.trim(),
    status,
    ready: status === 'available' && !!c.Endpoint,
    host: str(c.Endpoint),
    // Babelfish speaks T-SQL on its TDS port; the cluster's port is PostgreSQL's
    port: babelfish ? ENGINE_PORTS.babelfish : num(c.Port),
    user: str(c.MasterUsername),
    database: babelfish ? '' : str(c.DatabaseName),
    size,
    publicAccess: typeof c.PubliclyAccessible === 'boolean' ? c.PubliclyAccessible : null,
    secretArn: str((c.MasterUserSecret as Json | undefined)?.SecretArn) || undefined,
    iamAuth: c.IAMDatabaseAuthenticationEnabled === true,
    deletionProtection: c.DeletionProtection === true,
    members: members.map((m) => str(m.DBInstanceIdentifier)).filter(Boolean),
    note:
      engine === 'mongo'
        ? 'DocumentDB is only reachable from inside its VPC (VPN or SSH tunnel)'
        : undefined
  }
}

/** Cloud SQL `databaseVersion` such as POSTGRES_16, MYSQL_8_0, SQLSERVER_2022_EXPRESS. */
export function gcpVersion(databaseVersion: string): { engine: Engine; product: string } | null {
  const [family, ...rest] = databaseVersion.split('_')
  if (family === 'POSTGRES') return { engine: 'postgres', product: `PostgreSQL ${rest.join('.')}` }
  if (family === 'MYSQL') return { engine: 'mysql', product: `MySQL ${rest.join('.')}` }
  if (family === 'SQLSERVER') {
    const [year, ...edition] = rest
    const name = edition.map((e) => e[0] + e.slice(1).toLowerCase()).join(' ')
    return { engine: 'mssql', product: `SQL Server ${year} ${name}`.trim() }
  }
  return null
}

/** Cloud SQL creates a built-in admin with a fixed name. */
export const GCP_ADMIN_USER: Partial<Record<Engine, string>> = {
  postgres: 'postgres',
  mysql: 'root',
  mssql: 'sqlserver'
}

function gcpInstance(i: Json, context: string): CloudDatabase | null {
  const version = gcpVersion(str(i.databaseVersion))
  if (!version) return null
  const settings = (i.settings ?? {}) as Json
  const ipConfig = (settings.ipConfiguration ?? {}) as Json
  const ips = asRows(i.ipAddresses)
  const publicIp = str(ips.find((a) => a.type === 'PRIMARY')?.ipAddress)
  const privateIp = str(ips.find((a) => a.type === 'PRIVATE')?.ipAddress)
  const stopped = settings.activationPolicy === 'NEVER'
  const state = str(i.state)
  const authorized = asRows(ipConfig.authorizedNetworks)
  const iamFlag = asRows(settings.databaseFlags).some(
    (f) => /^cloudsql[._]iam_authentication$/.test(str(f.name)) && str(f.value) === 'on'
  )
  return {
    ref: {
      provider: 'gcp',
      // Listing without --project still reports which project each instance is in
      context: str(i.project) || context,
      region: str(i.region),
      resource: str(i.name),
      kind: 'instance'
    },
    name: str(i.name),
    engine: version.engine,
    product: version.product,
    status: stopped ? 'stopped' : state.toLowerCase().replace(/_/g, ' '),
    ready: state === 'RUNNABLE' && !stopped && !!(publicIp || privateIp),
    host: publicIp || privateIp,
    port: ENGINE_PORTS[version.engine],
    user: GCP_ADMIN_USER[version.engine] ?? '',
    database: '',
    size: [str(settings.tier), settings.dataDiskSizeGb ? `${num(settings.dataDiskSizeGb)} GB` : '']
      .filter(Boolean)
      .join(' · '),
    publicAccess: publicIp ? true : privateIp ? false : null,
    iamAuth: iamFlag,
    deletionProtection: settings.deletionProtectionEnabled === true,
    note:
      !publicIp && privateIp
        ? 'Private IP only: reachable from its VPC or through the Cloud SQL Auth Proxy'
        : publicIp && !authorized.length
          ? 'No authorized networks: add your IP in the console, or use the Cloud SQL Auth Proxy'
          : undefined
  }
}

const AZURE_KINDS = {
  postgres: { engine: 'postgres', product: 'Azure PostgreSQL', database: 'postgres' },
  mysql: { engine: 'mysql', product: 'Azure MySQL', database: '' },
  sql: { engine: 'mssql', product: 'Azure SQL', database: '' }
} as const

function azureServer(s: Json, kind: keyof typeof AZURE_KINDS, context: string): CloudDatabase {
  const info = AZURE_KINDS[kind]
  const sku = (s.sku ?? {}) as Json
  const storage = (s.storage ?? {}) as Json
  const network = (s.network ?? {}) as Json
  const access = str(network.publicNetworkAccess ?? s.publicNetworkAccess)
  const state = str(s.state) || 'Ready'
  const id = str(s.id)
  const version = kind === 'sql' ? '' : str(s.version)
  const authConfig = (s.authConfig ?? {}) as Json
  const administrators = (s.administrators ?? {}) as Json
  return {
    ref: {
      provider: 'azure',
      context: subscriptionOf(id) ?? context,
      region: str(s.location),
      resource: str(s.name),
      kind,
      resourceGroup: str(s.resourceGroup) || resourceGroupOf(id)
    },
    name: str(s.name),
    engine: info.engine,
    product: `${info.product} ${version}`.trim(),
    status: state.toLowerCase(),
    ready: /^ready$/i.test(state) && !!s.fullyQualifiedDomainName,
    host: str(s.fullyQualifiedDomainName),
    port: ENGINE_PORTS[info.engine],
    user: str(s.administratorLogin),
    database: info.database,
    size: [str(sku.name), storage.storageSizeGb ? `${num(storage.storageSizeGb)} GiB` : '']
      .filter(Boolean)
      .join(' · '),
    publicAccess: access ? /enabled/i.test(access) : null,
    // PostgreSQL reports Entra sign-in directly; Azure SQL has it once an Entra admin is set
    iamAuth:
      kind === 'sql'
        ? !!administrators.login
        : /enabled/i.test(str(authConfig.activeDirectoryAuth ?? authConfig.microsoftEntraAuth)),
    deletionProtection: false,
    note: /disabled/i.test(access)
      ? 'Public network access is disabled: reachable only through its private endpoint'
      : undefined
  }
}

/** Cosmos DB accounts with the MongoDB API (other APIs aren't something we can open). */
function azureCosmos(a: Json, context: string): CloudDatabase | null {
  if (a.kind !== 'MongoDB') return null
  const id = str(a.id)
  const name = str(a.name)
  const state = str(a.provisioningState)
  const api = (a.apiProperties ?? {}) as Json
  const access = str(a.publicNetworkAccess)
  const serverless = asRows(a.capabilities).some((c) => c.name === 'EnableServerless')
  return {
    ref: {
      provider: 'azure',
      context: subscriptionOf(id) ?? context,
      region: str(a.location),
      resource: name,
      kind: 'cosmos',
      resourceGroup: str(a.resourceGroup) || resourceGroupOf(id)
    },
    name,
    engine: 'mongo',
    product: `Cosmos DB for MongoDB ${str(api.serverVersion)}`.trim(),
    status: state === 'Succeeded' ? 'ready' : state.toLowerCase(),
    ready: state === 'Succeeded',
    host: `${name}.mongo.cosmos.azure.com`,
    port: COSMOS_PORT,
    user: name,
    database: '',
    size:
      a.enableFreeTier === true
        ? 'Free tier'
        : serverless
          ? 'Serverless'
          : 'Provisioned throughput',
    publicAccess: access ? /enabled/i.test(access) : null,
    iamAuth: false,
    deletionProtection: false,
    note: /disabled/i.test(access)
      ? 'Public network access is disabled: reachable only through its private endpoint'
      : undefined
  }
}

const COSMOS_PORT = 10255

function subscriptionOf(id: string): string | undefined {
  return id.match(/^\/subscriptions\/([^/]+)/i)?.[1]
}

function resourceGroupOf(id: string): string {
  return id.match(/\/resourceGroups\/([^/]+)/i)?.[1] ?? ''
}

const ENGINE_PORTS: Record<Engine, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
  babelfish: 1433,
  mongo: 27017
}

/** Command that looks up one database again (for refreshes and provisioning progress). */
export function describeCommand(ref: CloudRef): { key: ListCommand['key']; args: string[] } {
  const scope = scopeArgs(ref.provider, ref.context, ref.region)
  switch (ref.provider) {
    case 'aws':
      return ref.kind === 'cluster'
        ? {
            key: 'aws-clusters',
            args: ['rds', 'describe-db-clusters', '--db-cluster-identifier', ref.resource, ...scope]
          }
        : {
            key: 'aws-instances',
            args: [
              'rds',
              'describe-db-instances',
              '--db-instance-identifier',
              ref.resource,
              ...scope
            ]
          }
    case 'gcp':
      return {
        key: 'gcp-instances',
        args: ['sql', 'instances', 'describe', ref.resource, ...scope]
      }
    case 'azure': {
      const target = ['--resource-group', ref.resourceGroup ?? '', '--name', ref.resource, ...scope]
      if (ref.kind === 'sql')
        return { key: 'azure-sql', args: ['sql', 'server', 'show', ...target] }
      if (ref.kind === 'cosmos')
        return { key: 'azure-cosmos', args: ['cosmosdb', 'show', ...target] }
      return {
        key: ref.kind === 'mysql' ? 'azure-mysql' : 'azure-postgres',
        args: [ref.kind === 'mysql' ? 'mysql' : 'postgres', 'flexible-server', 'show', ...target]
      }
    }
  }
}

/** Parses `describeCommand` output, which is a single object rather than a list. */
export function parseDescribe(ref: CloudRef, stdout: string): CloudDatabase | null {
  const { key } = describeCommand(ref)
  const json = parseJson<unknown>(stdout)
  // The AWS describe calls already return lists; the others return the bare object
  const wrapped = key.startsWith('aws') || Array.isArray(json) ? stdout : JSON.stringify([json])
  return (
    parseList(key, wrapped, ref.context, ref.region).find((d) => d.name === ref.resource) ?? null
  )
}

/** AWS Aurora clusters are usable once a member instance is, not just the cluster. */
export function clusterInstancesCommand(ref: CloudRef): string[] {
  return [
    'rds',
    'describe-db-instances',
    '--filters',
    `Name=db-cluster-id,Values=${ref.resource}`,
    ...scopeArgs('aws', ref.context, ref.region)
  ]
}

export function anyInstanceAvailable(stdout: string): boolean {
  const json = parseJson<Json>(stdout)
  return asRows(json?.DBInstances).some((i) => i.DBInstanceStatus === 'available')
}

export interface Credentials {
  username?: string
  password?: string
  /** A connection string to use instead of host and port (Cosmos DB) */
  uri?: string
}

/**
 * Fetches credentials the provider keeps for you: the master password AWS
 * manages in Secrets Manager, or a Cosmos DB account's connection string.
 */
export function credentialsCommand(db: CloudDatabase): string[] | null {
  if (db.ref.provider === 'aws' && db.secretArn) {
    return [
      'secretsmanager',
      'get-secret-value',
      '--secret-id',
      db.secretArn,
      ...scopeArgs('aws', db.ref.context, db.ref.region)
    ]
  }
  if (db.ref.provider === 'azure' && db.ref.kind === 'cosmos') {
    return [
      'cosmosdb',
      'keys',
      'list',
      '--type',
      'connection-strings',
      '--resource-group',
      db.ref.resourceGroup ?? '',
      '--name',
      db.ref.resource,
      ...scopeArgs('azure', db.ref.context)
    ]
  }
  return null
}

export function parseCredentials(db: CloudDatabase, stdout: string): Credentials {
  const json = parseJson<Json>(stdout)
  if (db.ref.kind === 'cosmos') {
    const strings = asRows(json?.connectionStrings)
    const primary = strings.find((s) => /primary mongodb/i.test(str(s.description))) ?? strings[0]
    return splitMongoPassword(str(primary?.connectionString))
  }
  const inner = parseJson<Json>(str(json?.SecretString))
  return {
    username: str(inner?.username) || undefined,
    password: str(inner?.password) || undefined
  }
}

/** Moves the password out of a mongodb:// URI so it can go to the credential store. */
export function splitMongoPassword(uri: string): Credentials {
  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/)([^:@/]+):([^@/]*)@(.*)$/)
  if (!match) return uri ? { uri } : {}
  return {
    uri: `${match[1]}${match[2]}@${match[4]}`,
    username: decodeURIComponent(match[2]),
    password: decodeURIComponent(match[3])
  }
}

/* ---------- Connections ---------- */

/** A new (unsaved) connection for a discovered database. */
export function connectionFor(db: CloudDatabase): ConnectionConfig {
  const base = newConnection(db.engine)
  const config: ConnectionConfig = {
    ...base,
    name: db.name,
    host: db.host,
    port: db.port || base.port,
    user: db.user || base.user,
    database: db.database || base.database,
    ssl: 'require',
    // RDS and Cloud SQL sign with their own CAs, which aren't in the OS trust store
    trustServerCertificate: db.ref.provider !== 'azure',
    group: PROVIDERS[db.ref.provider].label,
    cloud: db.ref
  }
  if (db.ref.kind === 'cosmos') {
    config.uri =
      `mongodb://${encodeURIComponent(db.user)}@${db.host}:${db.port}/` +
      `?ssl=true&replicaSet=globaldb&retrywrites=false&maxIdleTimeMS=120000&appName=@${db.name}@`
    config.host = ''
  } else if (db.engine === 'mongo') {
    const user = db.user ? `${encodeURIComponent(db.user)}@` : ''
    config.uri = `mongodb://${user}${db.host}:${db.port || 27017}/?tls=true&retryWrites=false`
    config.host = ''
  }
  return config
}

/**
 * The database user for passwordless sign-in as `identity` (what the CLI is
 * signed in as), or null when it has to be set up in the database first.
 */
export function iamUserFor(db: CloudDatabase, identity: string | null | undefined): string | null {
  if (!identity) return null
  if (db.ref.provider === 'gcp') {
    // PostgreSQL users are the email (service accounts without the domain
    // suffix); MySQL truncates at the @
    if (db.engine === 'mysql') return identity.split('@')[0]
    return identity.replace(/\.gserviceaccount\.com$/, '')
  }
  // Entra users sign in with their user principal name
  if (db.ref.provider === 'azure') return identity
  return null
}

/** Whether a connection to `db` can use passwordless sign-in at all. */
export function supportsIam(engine: Engine, provider: CloudProvider): boolean {
  if (engine === 'postgres' || engine === 'mysql') return true
  return engine === 'mssql' && provider === 'azure'
}

export function sameResource(a: CloudRef, b: CloudRef): boolean {
  return (
    a.provider === b.provider &&
    a.resource === b.resource &&
    a.kind === b.kind &&
    (a.region === b.region || !a.region || !b.region) &&
    (a.context === b.context || !a.context || !b.context)
  )
}

/** The saved connection for a discovered database, if there is one. */
export function findSaved(
  connections: ConnectionConfig[],
  db: CloudDatabase
): ConnectionConfig | undefined {
  return (
    connections.find((c) => c.cloud && sameResource(c.cloud, db.ref)) ??
    (db.host
      ? connections.find(
          (c) => c.host.toLowerCase() === db.host.toLowerCase() || c.uri.includes(db.host)
        )
      : undefined)
  )
}

/* ---------- Provisioning ---------- */

export interface SizeOption {
  id: string
  label: string
  detail: string
}

export interface EngineOption {
  /** Provider-specific engine id, e.g. aurora-postgresql or POSTGRES */
  id: string
  label: string
  engine: Engine
  /** `''` means the provider's default version */
  versions: { id: string; label: string }[]
  sizes: SizeOption[]
  defaultUser: string
  /** The provider fixes the admin user name */
  fixedUser?: boolean
  /** null when storage is managed for you */
  storage: { min: number; default: number } | null
  /** Whether an initial database can be created; `required` for Azure SQL */
  initialDatabase: false | 'optional' | 'required'
  /** IAM database authentication can be switched on when provisioning */
  iam?: boolean
  /** Authenticates with keys the provider generates, not an admin user */
  noCredentials?: boolean
}

const DEFAULT_VERSION = { id: '', label: 'Latest (provider default)' }

const AWS_SIZES: SizeOption[] = [
  { id: 'db.t4g.micro', label: 'db.t4g.micro', detail: '2 vCPU (burstable) · 1 GiB' },
  { id: 'db.t4g.small', label: 'db.t4g.small', detail: '2 vCPU (burstable) · 2 GiB' },
  { id: 'db.t4g.medium', label: 'db.t4g.medium', detail: '2 vCPU (burstable) · 4 GiB' },
  { id: 'db.m7g.large', label: 'db.m7g.large', detail: '2 vCPU · 8 GiB' }
]

const AWS_SQLSERVER_SIZES: SizeOption[] = [
  { id: 'db.t3.small', label: 'db.t3.small', detail: '2 vCPU (burstable) · 2 GiB' },
  { id: 'db.t3.medium', label: 'db.t3.medium', detail: '2 vCPU (burstable) · 4 GiB' },
  { id: 'db.m6i.large', label: 'db.m6i.large', detail: '2 vCPU · 8 GiB' }
]

const AURORA_SIZES: SizeOption[] = [
  { id: 'serverless:0.5:2', label: 'Serverless v2', detail: '0.5–2 ACU, scales with load' },
  { id: 'serverless:1:8', label: 'Serverless v2', detail: '1–8 ACU, scales with load' },
  { id: 'db.t4g.medium', label: 'db.t4g.medium', detail: '2 vCPU (burstable) · 4 GiB' },
  { id: 'db.r7g.large', label: 'db.r7g.large', detail: '2 vCPU · 16 GiB' }
]

const GCP_SIZES: SizeOption[] = [
  { id: 'db-f1-micro', label: 'db-f1-micro', detail: 'Shared core · 0.6 GB' },
  { id: 'db-g1-small', label: 'db-g1-small', detail: 'Shared core · 1.7 GB' },
  { id: 'db-custom-1-3840', label: 'db-custom-1-3840', detail: '1 vCPU · 3.75 GB' },
  { id: 'db-custom-2-7680', label: 'db-custom-2-7680', detail: '2 vCPU · 7.5 GB' }
]

const AZURE_FLEX_SIZES: SizeOption[] = [
  { id: 'Burstable:Standard_B1ms', label: 'Standard_B1ms', detail: 'Burstable · 1 vCore · 2 GiB' },
  { id: 'Burstable:Standard_B2s', label: 'Standard_B2s', detail: 'Burstable · 2 vCores · 4 GiB' },
  {
    id: 'GeneralPurpose:Standard_D2ds_v5',
    label: 'Standard_D2ds_v5',
    detail: 'General purpose · 2 vCores · 8 GiB'
  }
]

export const PROVISION_ENGINES: Record<CloudProvider, EngineOption[]> = {
  aws: [
    {
      id: 'postgres',
      label: 'PostgreSQL',
      engine: 'postgres',
      versions: [
        DEFAULT_VERSION,
        { id: '17', label: '17' },
        { id: '16', label: '16' },
        { id: '15', label: '15' }
      ],
      sizes: AWS_SIZES,
      defaultUser: 'postgres',
      storage: { min: 20, default: 20 },
      initialDatabase: 'optional',
      iam: true
    },
    {
      id: 'mysql',
      label: 'MySQL',
      engine: 'mysql',
      versions: [DEFAULT_VERSION, { id: '8.4', label: '8.4' }, { id: '8.0', label: '8.0' }],
      sizes: AWS_SIZES,
      defaultUser: 'admin',
      storage: { min: 20, default: 20 },
      initialDatabase: 'optional',
      iam: true
    },
    {
      id: 'mariadb',
      label: 'MariaDB',
      engine: 'mysql',
      versions: [DEFAULT_VERSION, { id: '11.4', label: '11.4' }, { id: '10.11', label: '10.11' }],
      sizes: AWS_SIZES,
      defaultUser: 'admin',
      storage: { min: 20, default: 20 },
      initialDatabase: 'optional',
      iam: true
    },
    {
      id: 'sqlserver-ex',
      label: 'SQL Server Express',
      engine: 'mssql',
      versions: [DEFAULT_VERSION],
      sizes: AWS_SQLSERVER_SIZES,
      defaultUser: 'admin',
      storage: { min: 20, default: 20 },
      initialDatabase: false
    },
    {
      id: 'sqlserver-web',
      label: 'SQL Server Web',
      engine: 'mssql',
      versions: [DEFAULT_VERSION],
      sizes: AWS_SQLSERVER_SIZES,
      defaultUser: 'admin',
      storage: { min: 20, default: 20 },
      initialDatabase: false
    },
    {
      id: 'aurora-postgresql',
      label: 'Aurora PostgreSQL',
      engine: 'postgres',
      versions: [DEFAULT_VERSION],
      sizes: AURORA_SIZES,
      defaultUser: 'postgres',
      storage: null,
      initialDatabase: 'optional',
      iam: true
    },
    {
      id: 'babelfish',
      label: 'Aurora Babelfish',
      engine: 'babelfish',
      // Babelfish needs a parameter group for the exact engine family, so the
      // plan looks up the default version rather than offering a choice
      versions: [DEFAULT_VERSION],
      sizes: AURORA_SIZES,
      defaultUser: 'babelfish_user',
      storage: null,
      initialDatabase: false
    },
    {
      id: 'aurora-mysql',
      label: 'Aurora MySQL',
      engine: 'mysql',
      versions: [DEFAULT_VERSION],
      sizes: AURORA_SIZES,
      defaultUser: 'admin',
      storage: null,
      initialDatabase: 'optional',
      iam: true
    }
  ],
  gcp: [
    {
      id: 'POSTGRES',
      label: 'PostgreSQL',
      engine: 'postgres',
      versions: ['17', '16', '15'].map((v) => ({ id: `POSTGRES_${v}`, label: v })),
      sizes: GCP_SIZES,
      defaultUser: 'postgres',
      fixedUser: true,
      storage: { min: 10, default: 10 },
      initialDatabase: 'optional',
      iam: true
    },
    {
      id: 'MYSQL',
      label: 'MySQL',
      engine: 'mysql',
      versions: [
        { id: 'MYSQL_8_4', label: '8.4' },
        { id: 'MYSQL_8_0', label: '8.0' }
      ],
      sizes: GCP_SIZES,
      defaultUser: 'root',
      fixedUser: true,
      storage: { min: 10, default: 10 },
      initialDatabase: 'optional',
      iam: true
    },
    {
      id: 'SQLSERVER',
      label: 'SQL Server',
      engine: 'mssql',
      versions: [
        { id: 'SQLSERVER_2022_EXPRESS', label: '2022 Express' },
        { id: 'SQLSERVER_2022_WEB', label: '2022 Web' },
        { id: 'SQLSERVER_2019_EXPRESS', label: '2019 Express' }
      ],
      // Shared-core tiers aren't offered for SQL Server
      sizes: GCP_SIZES.filter((s) => s.id.startsWith('db-custom')),
      defaultUser: 'sqlserver',
      fixedUser: true,
      storage: { min: 20, default: 20 },
      initialDatabase: 'optional'
    }
  ],
  azure: [
    {
      id: 'postgres',
      label: 'PostgreSQL',
      engine: 'postgres',
      versions: ['16', '17', '15'].map((v) => ({ id: v, label: v })),
      sizes: AZURE_FLEX_SIZES,
      defaultUser: 'dbadmin',
      storage: { min: 32, default: 32 },
      initialDatabase: 'optional'
    },
    {
      id: 'mysql',
      label: 'MySQL',
      engine: 'mysql',
      versions: [{ id: '8.0.21', label: '8.0' }],
      sizes: AZURE_FLEX_SIZES.map((s) =>
        // MySQL's general purpose SKUs are the AMD "ads" series
        s.id.startsWith('GeneralPurpose')
          ? { ...s, id: 'GeneralPurpose:Standard_D2ads_v5', label: 'Standard_D2ads_v5' }
          : s
      ),
      defaultUser: 'dbadmin',
      storage: { min: 20, default: 20 },
      initialDatabase: 'optional'
    },
    {
      id: 'sql',
      label: 'Azure SQL',
      engine: 'mssql',
      versions: [DEFAULT_VERSION],
      sizes: [
        {
          id: 'serverless',
          label: 'Serverless',
          detail: 'General purpose · 1 vCore · pauses when idle'
        },
        { id: 'Basic', label: 'Basic', detail: '5 DTU · 2 GB' },
        { id: 'S0', label: 'Standard S0', detail: '10 DTU · 250 GB' }
      ],
      defaultUser: 'dbadmin',
      storage: null,
      initialDatabase: 'required'
    },
    {
      id: 'cosmos',
      label: 'Cosmos DB (MongoDB)',
      engine: 'mongo',
      versions: ['6.0', '7.0', '5.0', '4.2'].map((v) => ({ id: v, label: v })),
      sizes: [
        { id: 'serverless', label: 'Serverless', detail: 'Pay per request, no minimum' },
        {
          id: 'free',
          label: 'Free tier',
          detail: '1000 RU/s and 25 GB free; one account per subscription'
        },
        {
          id: 'provisioned',
          label: 'Provisioned',
          detail: 'Reserved throughput, from 400 RU/s per database'
        }
      ],
      defaultUser: '',
      noCredentials: true,
      storage: null,
      initialDatabase: 'optional'
    }
  ]
}

export type NetworkAccess = 'ip' | 'anywhere' | 'private'

export interface ProvisionDraft {
  provider: CloudProvider
  context: string
  region: string
  /** Azure only */
  resourceGroup: string
  newResourceGroup: boolean
  engine: string
  version: string
  name: string
  size: string
  storageGb: number
  user: string
  password: string
  database: string
  access: NetworkAccess
  /** IP address (or CIDR) allowed in when `access` is `ip` */
  ip: string
  backups: boolean
  deletionProtection: boolean
  saveConnection: boolean
  /** Turn on IAM database authentication (engines with `iam`) */
  iamAuth: boolean
  /** Google Cloud: the signed-in account, added as an IAM database user */
  iamUser: string
}

export function engineOption(provider: CloudProvider, id: string): EngineOption {
  return PROVISION_ENGINES[provider].find((e) => e.id === id) ?? PROVISION_ENGINES[provider][0]
}

export function newProvisionDraft(
  provider: CloudProvider,
  context: string,
  region: string
): ProvisionDraft {
  const option = PROVISION_ENGINES[provider][0]
  return {
    provider,
    context,
    region: region || REGIONS[provider][0].id,
    resourceGroup: 'dbms-tool',
    newResourceGroup: true,
    engine: option.id,
    version: option.versions[0].id,
    name: '',
    size: option.sizes[0].id,
    storageGb: option.storage?.default ?? 0,
    user: option.defaultUser,
    password: generatePassword(),
    database: option.initialDatabase === 'required' ? 'appdb' : '',
    access: 'ip',
    ip: '',
    backups: true,
    deletionProtection: false,
    saveConnection: true,
    iamAuth: false,
    iamUser: ''
  }
}

/** Switching engine resets the fields that depend on it. */
export function withEngine(draft: ProvisionDraft, engineId: string): ProvisionDraft {
  const option = engineOption(draft.provider, engineId)
  // Keep a user name the user typed, but not the previous engine's default
  const previous = engineOption(draft.provider, draft.engine)
  const customUser = !!draft.user && draft.user !== previous.defaultUser
  return {
    ...draft,
    engine: option.id,
    version: option.versions[0].id,
    size: option.sizes[0].id,
    storageGb: option.storage?.default ?? 0,
    user: option.fixedUser || !customUser ? option.defaultUser : draft.user,
    iamAuth: option.iam ? draft.iamAuth : false,
    database:
      option.initialDatabase === 'required'
        ? draft.database || 'appdb'
        : option.initialDatabase
          ? draft.database
          : ''
  }
}

const PASSWORD_SETS = [
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  'abcdefghijkmnopqrstuvwxyz',
  '23456789',
  // Accepted by every provider; AWS rejects / " @ and spaces
  '-_.!*'
]

/** A strong random password every provider accepts. */
export function generatePassword(length = 24): string {
  const all = PASSWORD_SETS.join('')
  const random = (n: number): number => {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    return buf[0] % n
  }
  const chars = PASSWORD_SETS.map((set) => set[random(set.length)])
  while (chars.length < length) chars.push(all[random(all.length)])
  // Fisher–Yates so the guaranteed characters aren't always first
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

const RESERVED_USERS = new Set([
  'admin',
  'administrator',
  'root',
  'sa',
  'guest',
  'public',
  'dbo',
  'postgres',
  'azure_superuser',
  'azure_pg_admin',
  'dbmanager',
  'loginmanager'
])

/** The first problem with the draft, or null when it can be provisioned. */
export function validateProvision(draft: ProvisionDraft): string | null {
  const option = engineOption(draft.provider, draft.engine)
  const name = draft.name.trim()
  if (!name) return 'Enter a name'
  if (draft.provider === 'aws') {
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(name) || /--|-$/.test(name))
      return 'AWS names start with a letter and use letters, digits and single hyphens (max 63)'
  } else if (draft.provider === 'gcp') {
    if (!/^[a-z][a-z0-9-]{0,96}[a-z0-9]$/.test(name))
      return 'Cloud SQL names use lowercase letters, digits and hyphens, starting with a letter'
  } else if (option.id === 'cosmos') {
    if (!/^[a-z0-9][a-z0-9-]{1,42}[a-z0-9]$/.test(name))
      return 'Cosmos DB account names are 3–44 lowercase letters, digits and hyphens'
  } else if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
    return 'Azure server names are 3–63 lowercase letters, digits and hyphens'
  }
  if (!draft.region) return 'Pick a region'
  if (draft.provider === 'azure' && !/^[\w.()-]{1,90}$/.test(draft.resourceGroup.trim()))
    return 'Enter a resource group name'
  if (!draft.size.trim()) return 'Pick a size'
  if (option.storage && !(draft.storageGb >= option.storage.min))
    return `Storage must be at least ${option.storage.min} GB`
  if (!option.fixedUser && !option.noCredentials) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,15}$/.test(draft.user))
      return 'The admin user starts with a letter and uses letters, digits and underscores (max 16)'
    if (
      draft.provider === 'azure' &&
      (RESERVED_USERS.has(draft.user.toLowerCase()) || /^pg_/i.test(draft.user))
    )
      return `Azure doesn't allow "${draft.user}" as the admin user`
    if (draft.provider === 'aws' && /^rdsadmin$/i.test(draft.user))
      return '"rdsadmin" is reserved by AWS'
  }
  const pw = draft.password
  if (option.noCredentials) {
    // Keys are generated by the provider
  } else if (pw.length < 8) {
    return 'The password needs at least 8 characters'
  } else if (draft.provider === 'aws' && (pw.length > 41 || /[/"@\s]/.test(pw))) {
    return 'AWS passwords are 8–41 characters without / " @ or spaces'
  } else if (draft.provider === 'azure') {
    const classes = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length
    if (classes < 3) return 'Azure passwords need three of: upper case, lower case, digits, symbols'
    if (pw.toLowerCase().includes(draft.user.toLowerCase()))
      return "Azure passwords can't contain the user name"
  }
  if (option.initialDatabase === 'required' && !draft.database.trim())
    return 'Enter a database name'
  if (draft.database && !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(draft.database))
    return 'Database names use letters, digits and underscores'
  if (draft.access === 'ip' && !parseIp(draft.ip)) return 'Enter the IP address to allow in'
  if (draft.iamAuth && draft.provider === 'gcp' && !draft.iamUser)
    return 'Sign in to gcloud so your account can be added as an IAM user'
  return null
}

/** `203.0.113.7` or `203.0.113.0/24` → address and prefix. */
function parseIp(text: string): { address: string; prefix: number } | null {
  const match = text.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/)
  if (!match || match[1].split('.').some((o) => Number(o) > 255)) return null
  const prefix = match[2] ? Number(match[2]) : 32
  return prefix <= 32 ? { address: match[1], prefix } : null
}

function cidr(draft: ProvisionDraft): string {
  if (draft.access === 'anywhere') return '0.0.0.0/0'
  const ip = parseIp(draft.ip)
  return ip ? `${ip.address}/${ip.prefix}` : ''
}

/** First and last address, for providers that take ranges instead of CIDRs. */
function ipRange(draft: ProvisionDraft): [string, string] {
  if (draft.access === 'anywhere') return ['0.0.0.0', '255.255.255.255']
  const ip = parseIp(draft.ip)
  if (!ip) return ['', '']
  const n = ip.address.split('.').reduce((acc, o) => acc * 256 + Number(o), 0)
  const mask = ip.prefix === 0 ? 0 : 2 ** 32 - 2 ** (32 - ip.prefix)
  const start = Math.floor(n / 2 ** (32 - ip.prefix)) * 2 ** (32 - ip.prefix)
  const end = start + (2 ** 32 - 1 - mask)
  const dotted = (v: number): string =>
    [24, 16, 8, 0].map((s) => Math.floor(v / 2 ** s) % 256).join('.')
  return [dotted(start), dotted(end)]
}

export interface PlanStep {
  title: string
  /** `ctx` holds values captured from earlier steps; previews pass `<name>` placeholders */
  args: (ctx: Record<string, string>) => string[]
  /** Contents of the temporary file `{secret}` refers to */
  secret?: string
  /** Pulls values out of the step's JSON output for later steps */
  capture?: (stdout: string) => Record<string, string>
  timeoutSecs?: number
}

export interface ProvisionPlan {
  ref: CloudRef
  /** Run in order to create the database */
  steps: PlanStep[]
  /** Run once the database reports ready, e.g. creating the initial database */
  afterReady: PlanStep[]
}

/** Long enough for the CLIs that wait for the server to come up (gcloud, az). */
const CREATE_TIMEOUT = 45 * 60

export function provisionPlan(draft: ProvisionDraft): ProvisionPlan {
  switch (draft.provider) {
    case 'aws':
      return awsPlan(draft)
    case 'gcp':
      return gcpPlan(draft)
    case 'azure':
      return azurePlan(draft)
  }
}

function awsPlan(d: ProvisionDraft): ProvisionPlan {
  const option = engineOption('aws', d.engine)
  const scope = scopeArgs('aws', d.context, d.region)
  const name = d.name.trim()
  const babelfish = d.engine === 'babelfish'
  const aurora = d.engine.startsWith('aurora') || babelfish
  const engine = babelfish ? 'aurora-postgresql' : d.engine
  const isPublic = d.access !== 'private'
  // Babelfish clients use the TDS port; PostgreSQL stays reachable too
  const ports = babelfish
    ? [ENGINE_PORTS.babelfish, ENGINE_PORTS.postgres]
    : [ENGINE_PORTS[option.engine]]
  const parameterGroup = `${name}-babelfish`
  const tags = ['--tags', 'Key=created-by,Value=dbms-tool']
  const secret = JSON.stringify({ MasterUserPassword: d.password })
  const steps: PlanStep[] = []
  // RDS's default security group only admits its own members, so public
  // databases get a group of their own that lets this machine in
  if (isPublic) {
    steps.push(
      {
        title: 'Find the default VPC',
        args: () => ['ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true', ...scope],
        capture: (out) => {
          const vpc = str(asRows(parseJson<Json>(out)?.Vpcs)[0]?.VpcId)
          if (!vpc) throw new Error(`There's no default VPC in ${d.region} to put the database in`)
          return { vpcId: vpc }
        }
      },
      {
        title: 'Create a security group',
        args: (ctx) => [
          'ec2',
          'create-security-group',
          '--group-name',
          `dbms-tool-${name}`,
          '--description',
          `Database access for ${name} (created by dbms-tool)`,
          '--vpc-id',
          ctx.vpcId,
          ...scope
        ],
        capture: (out) => ({ groupId: str(parseJson<Json>(out)?.GroupId) })
      },
      ...ports.map((port): PlanStep => ({
        title: `Allow ${d.access === 'anywhere' ? 'any address' : cidr(d)} on port ${port}`,
        args: (ctx) => [
          'ec2',
          'authorize-security-group-ingress',
          '--group-id',
          ctx.groupId,
          '--protocol',
          'tcp',
          '--port',
          String(port),
          '--cidr',
          cidr(d),
          ...scope
        ]
      }))
    )
  }
  if (babelfish) {
    steps.push(
      {
        title: 'Look up the default Aurora PostgreSQL version',
        args: () => [
          'rds',
          'describe-db-engine-versions',
          '--engine',
          'aurora-postgresql',
          '--default-only',
          ...scope
        ],
        capture: (out) => {
          const version = asRows(parseJson<Json>(out)?.DBEngineVersions)[0]
          if (!version?.DBParameterGroupFamily)
            throw new Error(`Aurora PostgreSQL isn't offered in ${d.region}`)
          return {
            engineVersion: str(version.EngineVersion),
            family: str(version.DBParameterGroupFamily)
          }
        }
      },
      {
        title: 'Create a Babelfish parameter group',
        args: (ctx) => [
          'rds',
          'create-db-cluster-parameter-group',
          '--db-cluster-parameter-group-name',
          parameterGroup,
          '--db-parameter-group-family',
          ctx.family,
          '--description',
          `Babelfish for ${name} (created by dbms-tool)`,
          ...tags,
          ...scope
        ]
      },
      {
        title: 'Turn on Babelfish',
        args: () => [
          'rds',
          'modify-db-cluster-parameter-group',
          '--db-cluster-parameter-group-name',
          parameterGroup,
          '--parameters',
          'ParameterName=rds.babelfish_status,ParameterValue=on,ApplyMethod=pending-reboot',
          ...scope
        ]
      }
    )
  }
  const securityGroup = (ctx: Record<string, string>): string[] =>
    isPublic ? ['--vpc-security-group-ids', ctx.groupId] : []
  const version = d.version ? ['--engine-version', d.version] : []
  const iam = d.iamAuth ? ['--enable-iam-database-authentication'] : []
  const deletion = d.deletionProtection ? ['--deletion-protection'] : ['--no-deletion-protection']
  const publicFlag = isPublic ? '--publicly-accessible' : '--no-publicly-accessible'

  if (aurora) {
    const serverless = d.size.startsWith('serverless:')
    const [, min, max] = d.size.split(':')
    steps.push(
      {
        title: `Create the ${option.label} cluster`,
        args: (ctx) => [
          'rds',
          'create-db-cluster',
          '--db-cluster-identifier',
          name,
          '--engine',
          engine,
          ...(babelfish
            ? [
                '--engine-version',
                ctx.engineVersion,
                '--db-cluster-parameter-group-name',
                parameterGroup
              ]
            : version),
          '--master-username',
          d.user,
          '--cli-input-json',
          'file://{secret}',
          ...(d.database ? ['--database-name', d.database] : []),
          ...iam,
          // Aurora always keeps at least a day of backups
          '--backup-retention-period',
          d.backups ? '7' : '1',
          ...deletion,
          ...securityGroup(ctx),
          ...(serverless
            ? ['--serverless-v2-scaling-configuration', `MinCapacity=${min},MaxCapacity=${max}`]
            : []),
          ...tags,
          ...scope
        ],
        secret
      },
      {
        title: 'Add the writer instance',
        args: () => [
          'rds',
          'create-db-instance',
          '--db-instance-identifier',
          `${name}-1`,
          '--db-cluster-identifier',
          name,
          '--engine',
          engine,
          '--db-instance-class',
          serverless ? 'db.serverless' : d.size,
          publicFlag,
          ...tags,
          ...scope
        ]
      }
    )
  } else {
    const sqlServer = option.engine === 'mssql'
    steps.push({
      title: `Create the ${option.label} instance`,
      args: (ctx) => [
        'rds',
        'create-db-instance',
        '--db-instance-identifier',
        name,
        '--engine',
        d.engine,
        ...version,
        '--db-instance-class',
        d.size,
        '--allocated-storage',
        String(d.storageGb),
        '--storage-type',
        'gp3',
        '--master-username',
        d.user,
        '--cli-input-json',
        'file://{secret}',
        ...(d.database && !sqlServer ? ['--db-name', d.database] : []),
        ...(sqlServer ? ['--license-model', 'license-included'] : []),
        ...iam,
        '--backup-retention-period',
        d.backups ? '7' : '0',
        ...deletion,
        publicFlag,
        ...securityGroup(ctx),
        ...tags,
        ...scope
      ],
      secret
    })
  }
  return {
    ref: {
      provider: 'aws',
      context: d.context,
      region: d.region,
      resource: name,
      kind: aurora ? 'cluster' : 'instance'
    },
    steps,
    afterReady: []
  }
}

/** YAML for gcloud's --flags-file; a JSON string is valid YAML. */
function gcloudFlags(flags: Record<string, string>): string {
  return Object.entries(flags)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
}

function gcpPlan(d: ProvisionDraft): ProvisionPlan {
  const scope = scopeArgs('gcp', d.context)
  const name = d.name.trim()
  // Without a VPC there's no private-only option; "private" means no authorized
  // networks, so only the Cloud SQL Auth Proxy gets in
  const networks = d.access === 'private' ? [] : [`--authorized-networks=${cidr(d)}`]
  const mysql = d.engine === 'MYSQL'
  const iamFlag = d.iamAuth
    ? [
        `--database-flags=${mysql ? 'cloudsql_iam_authentication' : 'cloudsql.iam_authentication'}=on`
      ]
    : []
  const serviceAccount = d.iamUser.endsWith('.gserviceaccount.com')
  const steps: PlanStep[] = [
    {
      title: `Create the Cloud SQL instance (takes several minutes)`,
      args: () => [
        'sql',
        'instances',
        'create',
        name,
        `--database-version=${d.version}`,
        `--region=${d.region}`,
        // Shared-core tiers only exist in the Enterprise edition, which isn't
        // the default for new PostgreSQL versions
        '--edition=enterprise',
        `--tier=${d.size}`,
        `--storage-size=${d.storageGb}GB`,
        '--storage-auto-increase',
        d.backups ? '--backup' : '--no-backup',
        d.deletionProtection ? '--deletion-protection' : '--no-deletion-protection',
        ...networks,
        ...iamFlag,
        '--labels=created-by=dbms-tool',
        '--flags-file={secret}',
        ...scope
      ],
      secret: gcloudFlags({ '--root-password': d.password }),
      timeoutSecs: CREATE_TIMEOUT
    }
  ]
  const afterReady: PlanStep[] = []
  if (d.database) {
    afterReady.push({
      title: `Create database ${d.database}`,
      args: () => ['sql', 'databases', 'create', d.database, `--instance=${name}`, ...scope]
    })
  }
  if (d.iamAuth && d.iamUser) {
    afterReady.push({
      title: `Add ${d.iamUser} as an IAM database user`,
      args: () => [
        'sql',
        'users',
        'create',
        // PostgreSQL names service accounts without the domain suffix
        serviceAccount && !mysql ? d.iamUser.replace(/\.gserviceaccount\.com$/, '') : d.iamUser,
        `--instance=${name}`,
        `--type=${serviceAccount ? 'cloud_iam_service_account' : 'cloud_iam_user'}`,
        ...scope
      ]
    })
  }
  return {
    ref: {
      provider: 'gcp',
      context: d.context,
      region: d.region,
      resource: name,
      kind: 'instance'
    },
    steps,
    afterReady
  }
}

function azurePlan(d: ProvisionDraft): ProvisionPlan {
  const scope = scopeArgs('azure', d.context)
  const name = d.name.trim()
  const group = d.resourceGroup.trim()
  const option = engineOption('azure', d.engine)
  const rg = ['--resource-group', group]
  const tags = ['--tags', 'created-by=dbms-tool']
  const steps: PlanStep[] = []
  if (d.newResourceGroup) {
    steps.push({
      title: `Create resource group ${group}`,
      args: () => ['group', 'create', '--name', group, '--location', d.region, ...tags, ...scope]
    })
  }
  const [start, end] = ipRange(d)
  const afterReady: PlanStep[] = []

  if (d.engine === 'sql') {
    steps.push({
      title: 'Create the Azure SQL server',
      args: () => [
        'sql',
        'server',
        'create',
        ...rg,
        '--name',
        name,
        '--location',
        d.region,
        '--admin-user',
        d.user,
        '--admin-password',
        '@{secret}',
        ...scope
      ],
      secret: d.password,
      timeoutSecs: CREATE_TIMEOUT
    })
    if (d.access !== 'private') {
      steps.push({
        title: `Allow ${d.access === 'anywhere' ? 'any address' : cidr(d)} through the firewall`,
        args: () => [
          'sql',
          'server',
          'firewall-rule',
          'create',
          ...rg,
          '--server',
          name,
          '--name',
          'dbms-tool',
          '--start-ip-address',
          start,
          '--end-ip-address',
          end,
          ...scope
        ]
      })
    }
    const sizeArgs =
      d.size === 'serverless'
        ? [
            '--edition',
            'GeneralPurpose',
            '--family',
            'Gen5',
            '--capacity',
            '1',
            '--compute-model',
            'Serverless',
            '--auto-pause-delay',
            '60'
          ]
        : ['--service-objective', d.size]
    steps.push({
      title: `Create database ${d.database}`,
      args: () => [
        'sql',
        'db',
        'create',
        ...rg,
        '--server',
        name,
        '--name',
        d.database,
        ...sizeArgs,
        '--backup-storage-redundancy',
        'Local',
        ...tags,
        ...scope
      ],
      timeoutSecs: CREATE_TIMEOUT
    })
  } else if (d.engine === 'cosmos') {
    const sizeArgs =
      d.size === 'serverless'
        ? ['--capabilities', 'EnableServerless']
        : d.size === 'free'
          ? ['--enable-free-tier', 'true']
          : []
    const network =
      d.access === 'private'
        ? ['--public-network-access', 'Disabled']
        : d.access === 'ip'
          ? ['--ip-range-filter', cidr(d)]
          : []
    steps.push({
      title: 'Create the Cosmos DB account (takes several minutes)',
      args: () => [
        'cosmosdb',
        'create',
        ...rg,
        '--name',
        name,
        '--kind',
        'MongoDB',
        '--server-version',
        d.version,
        '--locations',
        `regionName=${d.region}`,
        'failoverPriority=0',
        'isZoneRedundant=False',
        '--default-consistency-level',
        'Session',
        ...sizeArgs,
        ...network,
        ...tags,
        ...scope
      ],
      timeoutSecs: CREATE_TIMEOUT
    })
    if (d.database) {
      afterReady.push({
        title: `Create database ${d.database}`,
        args: () => [
          'cosmosdb',
          'mongodb',
          'database',
          'create',
          ...rg,
          '--account-name',
          name,
          '--name',
          d.database,
          ...scope
        ]
      })
    }
  } else {
    const family = d.engine === 'mysql' ? 'mysql' : 'postgres'
    const [tier, sku] = d.size.includes(':') ? d.size.split(':') : ['', d.size]
    steps.push({
      title: `Create the ${option.label} flexible server (takes several minutes)`,
      args: () => [
        family,
        'flexible-server',
        'create',
        ...rg,
        '--name',
        name,
        '--location',
        d.region,
        '--version',
        d.version,
        ...(tier ? ['--tier', tier] : []),
        '--sku-name',
        sku,
        '--storage-size',
        String(d.storageGb),
        '--admin-user',
        d.user,
        '--admin-password',
        '@{secret}',
        '--public-access',
        d.access === 'private' ? 'None' : start === end ? start : `${start}-${end}`,
        ...tags,
        '--yes',
        ...scope
      ],
      secret: d.password,
      timeoutSecs: CREATE_TIMEOUT
    })
    if (d.database) {
      afterReady.push({
        title: `Create database ${d.database}`,
        args: () => [
          family,
          'flexible-server',
          'db',
          'create',
          ...rg,
          '--server-name',
          name,
          '--database-name',
          d.database,
          ...scope
        ]
      })
    }
  }
  return {
    ref: {
      provider: 'azure',
      context: d.context,
      region: d.region,
      resource: name,
      kind: d.engine === 'sql' ? 'sql' : d.engine,
      resourceGroup: group
    },
    steps,
    afterReady
  }
}

/** Placeholder context for previews: `ctx.vpcId` renders as `<vpcId>`. */
const PREVIEW_CTX = new Proxy({} as Record<string, string>, {
  get: (_, key) => `<${String(key)}>`
})

/** The plan as a shell script, with the secret file shown by name. */
export function planScript(plan: ProvisionPlan, cli: string): string {
  return stepsScript([...plan.steps, ...plan.afterReady], cli, plan.steps.length)
}

/** Steps as a shell script; `waitAt` marks where the script waits for the server. */
export function stepsScript(steps: PlanStep[], cli: string, waitAt = -1): string {
  return steps
    .map((step, i) => {
      const args = step
        .args(PREVIEW_CTX)
        .map((a) => a.replace('{secret}', 'password-file'))
        .map(shellQuote)
      const waits = i === waitAt && i > 0 ? '# …once the server is ready\n' : ''
      return `${waits}# ${step.title}\n${cli} ${args.join(' ')}`
    })
    .join('\n\n')
}

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./<>-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Display form of a CLI invocation, for progress logs. */
export function commandLine(cli: string, args: string[]): string {
  return [cli, ...args.map(shellQuote)].join(' ')
}

/** The connection to save once a provisioned database is ready. */
export function provisionedConnection(
  draft: ProvisionDraft,
  db: CloudDatabase,
  credentials: Credentials = {}
): ConnectionConfig {
  const base = connectionFor(db)
  const option = engineOption(draft.provider, draft.engine)
  return {
    ...base,
    name: draft.name.trim(),
    user: option.fixedUser || option.noCredentials ? base.user : draft.user,
    database: draft.database || base.database,
    ...(credentials.uri ? { uri: credentials.uri } : {}),
    savePassword: true
  }
}

/* ---------- Deleting ---------- */

export interface DeleteOptions {
  /** AWS: keep a final snapshot to restore from */
  finalSnapshot: boolean
  /** Turn deletion protection off first */
  disableProtection: boolean
}

/** Only AWS takes a final snapshot as part of the delete call. */
export function canSnapshot(db: CloudDatabase): boolean {
  return db.ref.provider === 'aws'
}

/** Leftovers dbms-tool can't remove until the database is gone. */
export function deleteLeftovers(db: CloudDatabase): string | null {
  if (db.ref.provider !== 'aws') return null
  return db.engine === 'babelfish'
    ? 'A security group and the Babelfish parameter group created with it stay behind; delete them in the AWS console once the cluster is gone.'
    : 'A security group created for it by dbms-tool stays behind; delete it in the AWS console once the database is gone.'
}

const DELETE_TIMEOUT = 30 * 60

export function deletePlan(
  db: CloudDatabase,
  options: DeleteOptions,
  now = new Date()
): PlanStep[] {
  const { ref } = db
  const name = ref.resource
  const scope = scopeArgs(ref.provider, ref.context, ref.region)
  switch (ref.provider) {
    case 'aws': {
      // DocumentDB clusters have their own API with the same shape
      const service = db.engine === 'mongo' ? 'docdb' : 'rds'
      const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '')
      const snapshot = options.finalSnapshot
        ? ['--final-db-snapshot-identifier', `${name}-final-${stamp}`]
        : ['--skip-final-snapshot']
      if (ref.kind === 'cluster') {
        return [
          ...(options.disableProtection
            ? [
                {
                  title: 'Turn off deletion protection',
                  args: () => [
                    service,
                    'modify-db-cluster',
                    '--db-cluster-identifier',
                    name,
                    '--no-deletion-protection',
                    '--apply-immediately',
                    ...scope
                  ]
                }
              ]
            : []),
          // A cluster can't be deleted while it still has instances
          ...(db.members ?? []).map((member): PlanStep => ({
            title: `Delete instance ${member}`,
            args: () => [
              service,
              'delete-db-instance',
              '--db-instance-identifier',
              member,
              ...scope
            ]
          })),
          {
            title: `Delete cluster ${name}`,
            args: () => [
              service,
              'delete-db-cluster',
              '--db-cluster-identifier',
              name,
              ...snapshot,
              ...scope
            ]
          }
        ]
      }
      return [
        ...(options.disableProtection
          ? [
              {
                title: 'Turn off deletion protection',
                args: () => [
                  'rds',
                  'modify-db-instance',
                  '--db-instance-identifier',
                  name,
                  '--no-deletion-protection',
                  '--apply-immediately',
                  ...scope
                ]
              }
            ]
          : []),
        {
          title: `Delete instance ${name}`,
          args: () => [
            'rds',
            'delete-db-instance',
            '--db-instance-identifier',
            name,
            ...snapshot,
            ...scope
          ]
        }
      ]
    }
    case 'gcp':
      return [
        ...(options.disableProtection
          ? [
              {
                title: 'Turn off deletion protection',
                args: () => [
                  'sql',
                  'instances',
                  'patch',
                  name,
                  '--no-deletion-protection',
                  ...scope
                ],
                timeoutSecs: DELETE_TIMEOUT
              }
            ]
          : []),
        {
          title: `Delete instance ${name}`,
          args: () => ['sql', 'instances', 'delete', name, ...scope],
          timeoutSecs: DELETE_TIMEOUT
        }
      ]
    case 'azure': {
      const target = [
        '--resource-group',
        ref.resourceGroup ?? '',
        '--name',
        name,
        '--yes',
        ...scope
      ]
      const command =
        ref.kind === 'sql'
          ? ['sql', 'server', 'delete']
          : ref.kind === 'cosmos'
            ? ['cosmosdb', 'delete']
            : [ref.kind === 'mysql' ? 'mysql' : 'postgres', 'flexible-server', 'delete']
      return [
        {
          title: `Delete ${ref.kind === 'cosmos' ? 'account' : 'server'} ${name}`,
          args: () => [...command, ...target],
          timeoutSecs: DELETE_TIMEOUT
        }
      ]
    }
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

function isDefined<T>(value: T | null | undefined): value is T {
  return value != null
}

/** Guesses the provider from a managed database's host name. */
export function providerForHost(host: string): CloudProvider | null {
  const h = host.toLowerCase()
  if (h.endsWith('.amazonaws.com')) return 'aws'
  if (/\.(database\.azure\.com|database\.windows\.net|cosmos\.azure\.com)$/.test(h)) return 'azure'
  return null
}
