import { api, type MongoRequest, type ResultSet } from '@/lib/api'
import { writeStatement } from '@/lib/dashboards'
import { ENGINES } from '@/lib/engines'
import { parseShell } from '@/lib/mongo-shell'
import { connect, getConnection } from '@/lib/workspace'
import { documentsToGrid } from '../mongo/DocumentsView'

/** Charts can't use more than this, and refreshes stay cheap. */
const ROW_LIMIT = 5000

const READ_OPS: MongoRequest['op'][] = ['find', 'aggregate', 'count', 'distinct']

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
  const request = requests[requests.length - 1]
  if (!request) throw new Error('Write a find(), aggregate(), countDocuments() or distinct() query')
  for (const r of requests) {
    const writes =
      !READ_OPS.includes(r.op) ||
      (r.op === 'aggregate' &&
        r.pipeline.some(
          (stage) => stage && typeof stage === 'object' && ('$out' in stage || '$merge' in stage)
        ))
    if (writes)
      throw new Error('Dashboard widgets only run reads: find, aggregate, count or distinct')
  }
  const output = await api.mongo(connectionId, session, request, { maxRows: ROW_LIMIT })
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

/** Runs a widget's query and returns its last result set. Throws on errors and on writes. */
export async function runWidgetQuery(
  connectionId: string,
  session: string,
  database: string,
  query: string
): Promise<WidgetResult> {
  const connection = getConnection(connectionId)
  if (!connection) throw new Error('This dashboard’s connection no longer exists')
  if (!query.trim()) throw new Error('This widget has no query yet')
  if (!(await connect(connectionId))) throw new Error('Not connected')
  if (connection.engine === 'mongo') return runMongo(connectionId, session, database, query)

  const dialect = ENGINES[connection.engine].dialect ?? 'postgres'
  const write = writeStatement(query, dialect)
  if (write)
    throw new Error(`Dashboard widgets only run read-only queries, and this one contains ${write}`)
  const out = await api.execute(connectionId, session, database, query, { maxRows: ROW_LIMIT })
  if (out.error) throw new Error(out.error.message)
  const set = [...out.results].reverse().find((r) => r.columns.length)
  if (!set) throw new Error('The query didn’t return any rows')
  return { set, elapsedMs: out.elapsedMs }
}
