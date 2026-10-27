import { api, type ResultSet } from '@/lib/api'
import { parseShell } from '@/lib/mongo-shell'
import { connect, getConnection } from '@/lib/workspace'
import { documentsToGrid } from '../mongo/DocumentsView'

/** Charts can't use more than this, and refreshes stay cheap. */
const ROW_LIMIT = 5000

export interface WidgetResult {
  set: ResultSet
  elapsedMs: number
}

function grid(documents: Record<string, unknown>[], truncated: boolean): ResultSet {
  return { ...documentsToGrid(documents), rowCount: documents.length, truncated }
}

async function runMongo(
  connectionId: string,
  session: string,
  database: string,
  query: string
): Promise<WidgetResult> {
  const requests = parseShell(query, database || 'test').flatMap((op) =>
    op.kind === 'request' ? [op.request] : []
  )
  const [request, ...rest] = requests
  if (!request) throw new Error('Write a find(), aggregate(), countDocuments() or distinct() query')
  if (rest.length) throw new Error(`A widget runs one query, and this one has ${requests.length}`)
  // The backend refuses writes, with the same check as read-only connections
  const output = await api.mongo(connectionId, session, request, {
    maxRows: ROW_LIMIT,
    readOnly: true
  })
  if (output.kind === 'documents')
    return { set: grid(output.documents, output.truncated), elapsedMs: output.elapsedMs }
  const values = Array.isArray(output.value) ? output.value : [output.value]
  return {
    set: grid(
      values.map((value) => ({ value })),
      false
    ),
    elapsedMs: output.elapsedMs
  }
}

/**
 * Runs a widget's query and returns its last result set. Throws on errors and on writes.
 * `assistant` (dashboards the AI assistant designed) also refuses what the
 * assistant may never run, like functions that end sessions or read server files.
 */
export async function runWidgetQuery(
  connectionId: string,
  session: string,
  database: string,
  query: string,
  { assistant = false }: { assistant?: boolean } = {}
): Promise<WidgetResult> {
  const connection = getConnection(connectionId)
  if (!connection) throw new Error('This dashboard’s connection no longer exists')
  if (!query.trim()) throw new Error('This widget has no query yet')
  if (!(await connect(connectionId))) throw new Error('Not connected')
  if (connection.engine === 'mongo') return runMongo(connectionId, session, database, query)

  // Widgets re-run on every refresh, so the backend's read-only check refuses writes
  const out = await api.execute(connectionId, session, database, query, {
    maxRows: ROW_LIMIT,
    readOnly: true,
    assistant
  })
  if (out.error) throw new Error(out.error.message)
  const set = [...out.results].reverse().find((r) => r.columns.length)
  if (!set) throw new Error('The query didn’t return any rows')
  return { set, elapsedMs: out.elapsedMs }
}
