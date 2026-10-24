import type { ConnectionConfig, Engine } from './api'

export type Dialect = 'postgres' | 'mysql' | 'tsql' | 'sqlite'

export interface EngineInfo {
  id: Engine
  label: string
  /** Two-letter mark used in the tree, tabs and status bar */
  mark: string
  description: string
  defaultPort: number
  defaultUser: string
  defaultDatabase: string
  dialect: Dialect | null
  /** Tailwind classes for the engine mark */
  tone: string
  /** Whether databases contain schemas the user browses (pgAdmin / SSMS style) */
  hasSchemas: boolean
  /** Designers and management features the engine supports */
  features?: Partial<EngineFeatures>
}

export interface EngineFeatures {
  /** Table, schema and trigger designers */
  designers: boolean
  /** Users, roles and grants */
  permissions: boolean
  /** Stored procedures and functions */
  routines: boolean
  /** Creating, editing, dropping, backing up and restoring databases */
  databases: boolean
}

/** Whether `engine` supports `feature` (everything does unless it says otherwise). */
export function supports(engine: Engine, feature: keyof EngineFeatures): boolean {
  return ENGINES[engine].features?.[feature] ?? true
}

export const ENGINES: Record<Engine, EngineInfo> = {
  postgres: {
    id: 'postgres',
    label: 'PostgreSQL',
    mark: 'PG',
    description: 'PostgreSQL 11+, including Aurora, Supabase, Neon and other compatible servers',
    defaultPort: 5432,
    defaultUser: 'postgres',
    defaultDatabase: 'postgres',
    dialect: 'postgres',
    tone: 'bg-pg/15 text-pg',
    hasSchemas: true
  },
  mysql: {
    id: 'mysql',
    label: 'MySQL',
    mark: 'MY',
    description: 'MySQL 5.7+ and MariaDB',
    defaultPort: 3306,
    defaultUser: 'root',
    defaultDatabase: '',
    dialect: 'mysql',
    tone: 'bg-mysql/15 text-mysql',
    hasSchemas: false
  },
  mssql: {
    id: 'mssql',
    label: 'SQL Server',
    mark: 'MS',
    description: 'SQL Server 2012+, Azure SQL. Use host\\INSTANCE for named instances',
    defaultPort: 1433,
    defaultUser: 'sa',
    defaultDatabase: '',
    dialect: 'tsql',
    tone: 'bg-mssql/15 text-mssql',
    hasSchemas: true
  },
  babelfish: {
    id: 'babelfish',
    label: 'Babelfish',
    mark: 'BF',
    description: 'Babelfish for Aurora PostgreSQL over its T-SQL (TDS) endpoint',
    defaultPort: 1433,
    defaultUser: 'babelfish_user',
    defaultDatabase: '',
    dialect: 'tsql',
    tone: 'bg-babelfish/15 text-babelfish',
    hasSchemas: true
  },
  mongo: {
    id: 'mongo',
    label: 'MongoDB',
    mark: 'MG',
    description: 'MongoDB 4.2+, Atlas and DocumentDB. Paste a connection string or use host/port',
    defaultPort: 27017,
    defaultUser: '',
    defaultDatabase: '',
    dialect: null,
    tone: 'bg-mongo/15 text-mongo',
    hasSchemas: false
  },
  sqlite: {
    id: 'sqlite',
    label: 'SQLite',
    mark: 'SQ',
    description: 'A local SQLite database file, or Cloudflare D1 over its HTTP API',
    defaultPort: 0,
    defaultUser: '',
    defaultDatabase: '',
    dialect: 'sqlite',
    tone: 'bg-sqlite/15 text-sqlite',
    hasSchemas: false,
    features: { designers: false, permissions: false, routines: false, databases: false }
  },
  redis: {
    id: 'redis',
    label: 'Redis',
    mark: 'RD',
    description:
      'Redis 5+, Valkey, KeyDB, Dragonfly and managed services like Upstash and ElastiCache',
    defaultPort: 6379,
    defaultUser: '',
    defaultDatabase: '0',
    dialect: null,
    tone: 'bg-redis/15 text-redis',
    hasSchemas: false,
    features: { designers: false, permissions: false, routines: false, databases: false }
  }
}

export const ENGINE_ORDER: Engine[] = [
  'postgres',
  'mysql',
  'mssql',
  'babelfish',
  'mongo',
  'redis',
  'sqlite'
]

/** Engines whose data isn't SQL or documents: no query editor, designers, compare, import or dashboards. */
export function isKeyValue(engine: Engine): boolean {
  return engine === 'redis'
}

export const CONNECTION_COLORS = [
  { value: '', label: 'None' },
  { value: '#ff6e61', label: 'Red' },
  { value: '#f2b84b', label: 'Amber' },
  { value: '#c4f042', label: 'Lime' },
  { value: '#4fd99b', label: 'Green' },
  { value: '#5fe0c8', label: 'Teal' },
  { value: '#85a9ff', label: 'Blue' },
  { value: '#d49bff', label: 'Violet' }
]

export function newConnection(engine: Engine): ConnectionConfig {
  const info = ENGINES[engine]
  return {
    id: '',
    name: '',
    engine,
    // A SQLite connection's "host" is the database file
    host: engine === 'sqlite' ? '' : 'localhost',
    port: info.defaultPort,
    user: info.defaultUser,
    database: info.defaultDatabase,
    auth: 'password',
    ssl: 'prefer',
    // Local SQL Server and Babelfish (Aurora) certificates are rarely in the OS trust store
    trustServerCertificate: engine === 'mssql' || engine === 'babelfish',
    uri: '',
    authSource: '',
    savePassword: true,
    readOnly: false,
    production: false,
    color: '',
    group: ''
  }
}

export function connectionLabel(c: ConnectionConfig): string {
  if (c.name) return c.name
  if (c.engine === 'sqlite') {
    return c.host ? (c.host.split(/[\\/]/).pop() ?? c.host) : 'Cloudflare D1'
  }
  if (c.engine === 'mongo' && c.uri) return hostFromUri(c.uri) ?? 'MongoDB'
  if (c.engine === 'redis' && c.uri) return hostFromUri(c.uri) ?? 'Redis'
  return c.host
    ? `${c.host}${c.port && c.port !== ENGINES[c.engine].defaultPort ? `:${c.port}` : ''}`
    : ENGINES[c.engine].label
}

export function connectionSubtitle(c: ConnectionConfig): string {
  if (c.engine === 'sqlite') return c.host || (c.cloud ? `D1 · ${c.cloud.resource}` : '')
  if ((c.engine === 'mongo' || c.engine === 'redis') && c.uri) return redactUri(c.uri)
  const user = c.auth === 'windows' ? 'Windows auth' : c.user
  return [user && `${user}@`, c.host, c.port ? `:${c.port}` : '', c.database && `/${c.database}`]
    .filter(Boolean)
    .join('')
}

function hostFromUri(uri: string): string | null {
  const match = uri.match(/^(?:mongodb(?:\+srv)?|rediss?|valkeys?):\/\/(?:[^@/]*@)?([^/?#]+)/)
  return match?.[1] ?? null
}

export function redactUri(uri: string): string {
  // Redis strings often carry only a password: redis://:secret@host
  return uri.replace(/(\/\/[^:/@]*:)([^@]*)@/, '$1••••@')
}

/**
 * Parses a pasted connection string into connection fields. Understands
 * postgres://, mysql://, mongodb(+srv)://, redis(s):// URIs and SQL Server ADO strings.
 */
export function parseConnectionString(
  text: string
): { engine: Engine; patch: Partial<ConnectionConfig>; password?: string } | null {
  const s = text.trim()
  if (/^mongodb(\+srv)?:\/\//i.test(s)) {
    let password: string | undefined
    try {
      const url = new URL(s.replace(/^mongodb(\+srv)?:/i, 'http:'))
      if (url.password) password = decodeURIComponent(url.password)
    } catch {
      // Multi-host URIs aren't valid URLs; keep the raw string
    }
    return { engine: 'mongo', patch: { uri: s }, password }
  }
  if (/^(rediss?|valkeys?):\/\//i.test(s)) {
    let password: string | undefined
    try {
      const url = new URL(s.replace(/^[a-z]+:/i, 'http:'))
      if (url.password) password = decodeURIComponent(url.password)
    } catch {
      // Keep the raw string; the backend reports what's wrong with it
    }
    return { engine: 'redis', patch: { uri: s }, password }
  }
  const uriMatch = s.match(/^(postgres(?:ql)?|mysql|mariadb|sqlserver|mssql):\/\//i)
  if (uriMatch) {
    const scheme = uriMatch[1].toLowerCase()
    const engine: Engine = scheme.startsWith('postgres')
      ? 'postgres'
      : scheme === 'mysql' || scheme === 'mariadb'
        ? 'mysql'
        : 'mssql'
    try {
      const url = new URL(s.replace(/^[a-z]+:/i, 'http:'))
      const sslmode = url.searchParams.get('sslmode') ?? url.searchParams.get('ssl-mode')
      return {
        engine,
        patch: {
          host: decodeURIComponent(url.hostname),
          port: url.port ? Number(url.port) : ENGINES[engine].defaultPort,
          user: decodeURIComponent(url.username),
          database: decodeURIComponent(url.pathname.replace(/^\//, '')),
          ...(sslmode && {
            ssl: /disable/i.test(sslmode)
              ? 'disable'
              : /require|verify|required/i.test(sslmode)
                ? 'require'
                : 'prefer'
          })
        },
        password: url.password ? decodeURIComponent(url.password) : undefined
      }
    } catch {
      return null
    }
  }
  // ADO.NET style: Server=tcp:host,1433;Database=x;User Id=u;Password=p;
  if (/(^|;)\s*(server|data source|address)\s*=/i.test(s)) {
    const parts = Object.fromEntries(
      s
        .split(';')
        .map((p) => p.split('='))
        .filter((kv) => kv.length >= 2)
        .map(([k, ...v]) => [k.trim().toLowerCase(), v.join('=').trim()])
    )
    const server = (parts['server'] ?? parts['data source'] ?? parts['address'] ?? '').replace(
      /^tcp:/i,
      ''
    )
    const [host, port] = server.split(',')
    const integrated = /^(true|yes|sspi)$/i.test(
      parts['integrated security'] ?? parts['trusted_connection'] ?? ''
    )
    return {
      engine: 'mssql',
      patch: {
        host: host?.trim() ?? '',
        port: port ? Number(port) : 1433,
        user: parts['user id'] ?? parts['uid'] ?? parts['user'] ?? '',
        database: parts['database'] ?? parts['initial catalog'] ?? '',
        auth: integrated ? 'windows' : 'password',
        ...(parts['encrypt'] && {
          ssl: /^(true|yes|mandatory|strict)$/i.test(parts['encrypt']) ? 'require' : 'prefer'
        }),
        ...(parts['trustservercertificate'] && {
          trustServerCertificate: /^(true|yes)$/i.test(parts['trustservercertificate'])
        })
      },
      password: parts['password'] ?? parts['pwd']
    }
  }
  return null
}
