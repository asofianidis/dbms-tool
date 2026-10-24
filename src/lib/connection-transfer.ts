import type { ConnectionConfig, Engine, SshAuth, SshConfig, SslMode } from './api'
import { ENGINES, newConnection } from './engines'

/** A connection found in another tool's settings, ready to save. */
export interface ImportCandidate {
  config: ConnectionConfig
  /** Only pgpass files hold passwords; saved to the OS credential store on import */
  password?: string
}

export interface ImportResult {
  candidates: ImportCandidate[]
  /** Entries that couldn't be imported, with the reason */
  skipped: string[]
}

export type ImportFormat = 'pgpass' | 'dbeaver' | 'datagrip' | 'dbms-tool'

export const EXPORT_FORMAT = 'dbms-tool.connections'

/** Drops the password from a `scheme://user:password@host` URI. */
export function stripUriPassword(uri: string): string {
  // Redis URIs often carry only a password: redis://:secret@host
  return uri.replace(/\/\/([^:/@]*):[^@/]*@/, (_, user: string) => (user ? `//${user}@` : '//'))
}

function candidate(engine: Engine, patch: Partial<ConnectionConfig>): ConnectionConfig {
  const config = { ...newConnection(engine), ...patch, id: '' }
  if (!config.port && engine !== 'sqlite') config.port = ENGINES[engine].defaultPort
  return config
}

/* ---------- JDBC URLs (DBeaver, DataGrip) ---------- */

function hostPort(authority: string): { host: string; port?: number } {
  // Several hosts (failover) → the first; [::1]:5432 for IPv6
  const first = authority
    .replace(/^[^@]*@/, '')
    .split(',')[0]
    .trim()
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(first)
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : undefined }
  const [host, port] = first.split(':')
  return { host: host ?? '', port: port ? Number(port) : undefined }
}

function sslFrom(value: string | undefined): SslMode | undefined {
  if (!value) return undefined
  if (/^(disable|false|no|off)$/i.test(value)) return 'disable'
  if (/require|verify|true|yes|strict|mandatory/i.test(value)) return 'require'
  return 'prefer'
}

/** Reads a JDBC URL (or a MongoDB or Redis URI) into connection fields. */
export function parseJdbcUrl(
  url: string
): { engine: Engine; patch: Partial<ConnectionConfig> } | null {
  const s = url.trim().replace(/^jdbc:/i, '')
  if (/^mongodb(\+srv)?:\/\//i.test(s))
    return { engine: 'mongo', patch: { uri: stripUriPassword(s) } }
  if (/^rediss?:\/\//i.test(s)) return { engine: 'redis', patch: { uri: stripUriPassword(s) } }
  const sqlite = /^sqlite:(.*)$/i.exec(s)
  if (sqlite) return { engine: 'sqlite', patch: { host: sqlite[1].replace(/^file:(\/\/)?/i, '') } }

  const generic =
    /^(postgresql|mysql|mariadb|jtds:sqlserver):\/\/([^/?;]*)(?:\/([^?;]*))?(?:[?;](.*))?$/i.exec(s)
  if (generic) {
    const scheme = generic[1].toLowerCase()
    const engine: Engine =
      scheme === 'postgresql' ? 'postgres' : scheme === 'jtds:sqlserver' ? 'mssql' : 'mysql'
    const params = new Map(
      (generic[4] ?? '')
        .split(/[&;]/)
        .map((p) => p.split('='))
        .filter((kv) => kv.length === 2)
        .map(([k, v]) => [k.toLowerCase(), decodeURIComponent(v)])
    )
    const { host, port } = hostPort(generic[2])
    const ssl = sslFrom(params.get('sslmode') ?? params.get('ssl-mode') ?? params.get('ssl'))
    return {
      engine,
      patch: {
        host,
        port: port ?? ENGINES[engine].defaultPort,
        database: decodeURIComponent(generic[3] ?? ''),
        ...(params.get('user') && { user: params.get('user') }),
        ...(ssl && { ssl })
      }
    }
  }

  // jdbc:sqlserver://host[\instance][:port][;key=value…]
  const mssql = /^sqlserver:\/\/([^;]*)(?:;(.*))?$/i.exec(s)
  if (mssql) {
    const props = new Map(
      (mssql[2] ?? '')
        .split(';')
        .map((p) => p.split('='))
        .filter((kv) => kv.length >= 2)
        .map(([k, ...v]) => [k.trim().toLowerCase(), v.join('=').trim()])
    )
    const { host, port } = hostPort(mssql[1])
    const ssl = sslFrom(props.get('encrypt'))
    return {
      engine: 'mssql',
      patch: {
        host: host || props.get('servername') || '',
        port: port ?? (Number(props.get('portnumber')) || 1433),
        database: props.get('databasename') ?? props.get('database') ?? '',
        ...(props.get('user') && { user: props.get('user') }),
        ...(/^true$/i.test(props.get('integratedsecurity') ?? '') && { auth: 'windows' as const }),
        ...(/^true$/i.test(props.get('trustservercertificate') ?? '') && {
          trustServerCertificate: true
        }),
        ...(ssl && { ssl })
      }
    }
  }
  return null
}

/* ---------- pgpass ---------- */

function pgpassFields(line: string): string[] {
  const fields: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) current += line[++i]
    else if (c === ':') {
      fields.push(current)
      current = ''
    } else current += c
  }
  fields.push(current)
  return fields
}

/** `hostname:port:database:username:password` lines, as read by libpq. */
export function parsePgpass(text: string): ImportResult {
  const result: ImportResult = { candidates: [], skipped: [] }
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return
    const fields = pgpassFields(line)
    const at = `Line ${index + 1}`
    if (fields.length !== 5) {
      result.skipped.push(`${at}: expected host:port:database:user:password`)
      return
    }
    const [host, port, database, user, password] = fields
    if (host === '*' || user === '*') {
      result.skipped.push(
        `${at}: wildcard ${host === '*' ? 'host' : 'user'} matches no single server`
      )
      return
    }
    const db = database === '*' ? '' : database
    result.candidates.push({
      config: candidate('postgres', {
        name: `${user}@${host}${db ? `/${db}` : ''}`,
        host,
        port: port === '*' ? 5432 : Number(port) || 5432,
        user,
        database: db || 'postgres',
        savePassword: !!password
      }),
      password: password || undefined
    })
  })
  return result
}

/* ---------- DBeaver data-sources.json ---------- */

interface DbeaverHandler {
  enabled?: boolean
  properties?: Record<string, unknown>
  user?: string
}

interface DbeaverConnection {
  provider?: string
  driver?: string
  name?: string
  folder?: string
  'read-only'?: boolean
  configuration?: {
    host?: string
    port?: string | number
    database?: string
    url?: string
    user?: string
    type?: string
    'auth-model'?: string
    'read-only'?: boolean
    handlers?: Record<string, DbeaverHandler>
  }
}

function dbeaverEngine(provider = '', driver = ''): Engine | null {
  const p = provider.toLowerCase()
  const d = driver.toLowerCase()
  if (p.includes('babelfish') || d.includes('babelfish')) return 'babelfish'
  if (p === 'postgresql' || d.startsWith('postgres')) return 'postgres'
  if (p === 'mysql' || p === 'mariadb' || d.startsWith('mysql') || d.startsWith('mariadb'))
    return 'mysql'
  if (p === 'sqlserver' || p === 'mssql' || d.includes('sqlserver') || d.includes('mssql'))
    return 'mssql'
  if (p === 'sqlite' || d.startsWith('sqlite')) return 'sqlite'
  if (p.startsWith('mongo')) return 'mongo'
  if (p.startsWith('redis') || d.startsWith('redis')) return 'redis'
  return null
}

const SSH_AUTH: Record<string, SshAuth> = {
  PASSWORD: 'password',
  PUBLIC_KEY: 'key',
  AGENT: 'agent'
}

function dbeaverSsh(handler: DbeaverHandler | undefined): SshConfig | undefined {
  if (!handler?.enabled) return undefined
  const props = handler.properties ?? {}
  const text = (key: string): string =>
    typeof props[key] === 'string' ? (props[key] as string) : ''
  return {
    enabled: true,
    host: text('host'),
    port: Number(props.port) || 0,
    user: text('user') || handler.user || '',
    auth: SSH_AUTH[text('authType')] ?? 'agent',
    keyFile: text('keyPath'),
    jumpHost: ''
  }
}

/** DBeaver's `.dbeaver/data-sources.json`. Credentials live in an encrypted file and aren't read. */
export function parseDbeaver(text: string): ImportResult {
  const data = JSON.parse(text) as {
    connections?: Record<string, DbeaverConnection>
    'connection-types'?: Record<string, { 'confirm-execute'?: boolean }>
  }
  const types = data['connection-types'] ?? {}
  const result: ImportResult = { candidates: [], skipped: [] }
  for (const [id, c] of Object.entries(data.connections ?? {})) {
    const cfg = c.configuration ?? {}
    const fromUrl = cfg.url ? parseJdbcUrl(cfg.url) : null
    const engine = dbeaverEngine(c.provider, c.driver) ?? fromUrl?.engine ?? null
    const label = c.name || id
    if (!engine) {
      result.skipped.push(`${label}: ${c.provider ?? 'this driver'} isn't supported`)
      continue
    }
    const patch: Partial<ConnectionConfig> = { ...(fromUrl?.engine === engine && fromUrl.patch) }
    if (engine === 'sqlite') {
      if (cfg.database) patch.host = cfg.database
    } else {
      if (cfg.host) patch.host = cfg.host
      if (cfg.port) patch.port = Number(cfg.port)
      if (cfg.database) patch.database = cfg.database
    }
    if (cfg.user) patch.user = cfg.user
    if (/ntlm|kerberos|windows/i.test(cfg['auth-model'] ?? '')) patch.auth = 'windows'
    const handlers = cfg.handlers ?? {}
    const ssl = Object.entries(handlers).find(([k, h]) => /ssl/i.test(k) && h.enabled)?.[1]
    if (ssl) {
      const mode = ssl.properties?.sslMode ?? ssl.properties?.['ssl.mode']
      patch.ssl = sslFrom(typeof mode === 'string' ? mode : undefined) ?? 'require'
    }
    const ssh = dbeaverSsh(handlers['ssh_tunnel'])
    const type = cfg.type ?? ''
    result.candidates.push({
      config: candidate(engine, {
        ...patch,
        name: c.name ?? '',
        group: c.folder ?? '',
        readOnly: !!(c['read-only'] ?? cfg['read-only']),
        production: type === 'prod' || !!types[type]?.['confirm-execute'],
        ...(ssh && { ssh })
      })
    })
  }
  return result
}

/* ---------- DataGrip / IntelliJ dataSources.xml ---------- */

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
}

function datagripEngine(driver: string): Engine | null {
  const d = driver.toLowerCase()
  if (d.startsWith('postgres')) return 'postgres'
  if (d.startsWith('mysql') || d.startsWith('mariadb')) return 'mysql'
  if (d.startsWith('sqlserver') || d.startsWith('azure')) return 'mssql'
  if (d.startsWith('sqlite')) return 'sqlite'
  if (d.startsWith('mongo')) return 'mongo'
  if (d.startsWith('redis')) return 'redis'
  return null
}

/**
 * DataGrip's `dataSources.xml`, optionally with `dataSources.local.xml` (which holds the user
 * names). Entries are matched across files by their uuid. Passwords stay in the IDE's keychain.
 */
export function parseDataGrip(texts: string[]): ImportResult {
  const sources = new Map<string, { attrs: Record<string, string>; body: string }>()
  for (const text of texts) {
    for (const m of text.matchAll(/<data-source\b([^>]*?)(?:\/>|>([\s\S]*?)<\/data-source>)/g)) {
      const attrs: Record<string, string> = {}
      for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeXml(a[2])
      const key = attrs.uuid ?? attrs.name ?? String(sources.size)
      const seen = sources.get(key)
      sources.set(key, {
        attrs: { ...seen?.attrs, ...attrs },
        body: (seen?.body ?? '') + (m[2] ?? '')
      })
    }
  }
  const result: ImportResult = { candidates: [], skipped: [] }
  for (const { attrs, body } of sources.values()) {
    const tag = (name: string): string => {
      const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)
      return m ? unescapeXml(m[1].trim()) : ''
    }
    const label = attrs.name || 'Unnamed data source'
    const url = tag('jdbc-url')
    const parsed = url ? parseJdbcUrl(url) : null
    const engine = parsed?.engine ?? datagripEngine(tag('driver-ref'))
    if (!url) {
      result.skipped.push(`${label}: no JDBC URL (pick dataSources.xml as well as the .local file)`)
      continue
    }
    if (!engine || !parsed) {
      result.skipped.push(`${label}: ${tag('driver-ref') || 'this driver'} isn't supported`)
      continue
    }
    const user = tag('user-name')
    result.candidates.push({
      config: candidate(engine, {
        ...parsed.patch,
        ...(user && { user }),
        name: attrs.name ?? '',
        group: attrs.group ?? attrs.folder ?? '',
        readOnly: attrs['read-only'] === 'true'
      })
    })
  }
  return result
}

/* ---------- dbms-tool's own export ---------- */

/**
 * Serializes connections for sharing. Passwords and SSH secrets live in the OS credential
 * store and never appear here; a password embedded in a MongoDB URI is removed too.
 */
export function exportConnections(list: ConnectionConfig[], now = new Date()): string {
  const connections = list.map(({ id: _id, lastUsed: _used, ...c }) => ({
    ...c,
    uri: stripUriPassword(c.uri)
  }))
  return JSON.stringify(
    { format: EXPORT_FORMAT, version: 1, exportedAt: now.toISOString(), connections },
    null,
    2
  )
}

export function parseExport(text: string): ImportResult {
  const data = JSON.parse(text) as { format?: string; connections?: Partial<ConnectionConfig>[] }
  if (data.format !== EXPORT_FORMAT) throw new Error('Not a dbms-tool connections export')
  const result: ImportResult = { candidates: [], skipped: [] }
  for (const c of data.connections ?? []) {
    if (!c.engine || !(c.engine in ENGINES)) {
      result.skipped.push(`${c.name || 'Unnamed'}: unknown engine ${c.engine ?? ''}`)
      continue
    }
    const { lastUsed: _used, ...rest } = c
    result.candidates.push({
      config: candidate(c.engine, { ...rest, uri: stripUriPassword(c.uri ?? '') })
    })
  }
  return result
}

/* ---------- Detection and de-duplication ---------- */

export function detectFormat(text: string): ImportFormat {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{')) {
    return trimmed.includes(`"${EXPORT_FORMAT}"`) ? 'dbms-tool' : 'dbeaver'
  }
  if (trimmed.startsWith('<') || text.includes('<data-source')) return 'datagrip'
  return 'pgpass'
}

/** Parses files picked together; DataGrip's two XML files are read as one set. */
export function parseImportFiles(texts: string[]): ImportResult & { formats: ImportFormat[] } {
  const formats = texts.map(detectFormat)
  const results: ImportResult[] = []
  const xml = texts.filter((_, i) => formats[i] === 'datagrip')
  if (xml.length) results.push(parseDataGrip(xml))
  texts.forEach((text, i) => {
    if (formats[i] === 'pgpass') results.push(parsePgpass(text))
    else if (formats[i] === 'dbeaver') results.push(parseDbeaver(text))
    else if (formats[i] === 'dbms-tool') results.push(parseExport(text))
  })
  return {
    formats: [...new Set(formats)],
    candidates: results.flatMap((r) => r.candidates),
    skipped: results.flatMap((r) => r.skipped)
  }
}

/** Identifies the server and login a connection points at, for spotting duplicates. */
export function connectionKey(c: ConnectionConfig): string {
  return [
    c.engine,
    stripUriPassword(c.uri).toLowerCase(),
    c.host.toLowerCase(),
    c.port || ENGINES[c.engine].defaultPort,
    c.user.toLowerCase(),
    c.database.toLowerCase()
  ].join('|')
}
