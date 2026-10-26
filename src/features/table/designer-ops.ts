import { api, type ConnectionConfig } from '@/lib/api'
import {
  ddlScript,
  draftFromTable,
  draftId,
  tableStatements,
  type DdlOptions,
  type TableDraft
} from '@/lib/ddl'
import { ENGINES, type Dialect } from '@/lib/engines'
import { connectedInfo } from '@/lib/mariadb'
import { queries, queryClient } from '@/lib/queries'
import { loadTableExtras } from '@/lib/table-extras'
import {
  supportsVersioning,
  versionedTableStatements,
  versioningQuery,
  type Versioning
} from '@/lib/versioning'
import { statusStore } from '@/lib/workspace'

/** What generating and running a table's DDL depends on for a connection. */
export interface DdlTarget {
  connectionId: string
  database: string
  dialect: Dialect
  mysql: boolean
  options: DdlOptions
}

export function ddlTarget(connection: ConnectionConfig, database: string): DdlTarget | null {
  const dialect = ENGINES[connection.engine].dialect
  if (!dialect) return null
  return {
    connectionId: connection.id,
    database,
    dialect,
    mysql: connection.engine === 'mysql',
    options: {
      babelfish: connection.engine === 'babelfish',
      d1: dialect === 'sqlite' && connection.cloud?.provider === 'cloudflare'
    }
  }
}

/** The schema a draft is qualified by: the database on MySQL, none on SQLite. */
export function draftSchemaFor(
  dialect: Dialect,
  mysql: boolean,
  database: string,
  schema: string | null
): string | null {
  return mysql
    ? database
    : dialect === 'sqlite'
      ? null
      : (schema ?? (dialect === 'tsql' ? 'dbo' : 'public'))
}

export interface LoadedTable {
  draft: TableDraft
  /** MariaDB system versioning as loaded; undefined where the server has none */
  versioning: Versioning | null | undefined
}

/** A designer draft of an existing table, read fresh since ALTERs are computed against it. */
export async function loadTableDraft(
  target: DdlTarget,
  schema: string | null,
  name: string
): Promise<LoadedTable> {
  const { connectionId, database, dialect } = target
  const info = await queryClient.fetchQuery({
    ...queries.table(connectionId, database, schema, name),
    staleTime: 0
  })
  const extras = await loadTableExtras(connectionId, database, dialect, schema, name, info)
  const versionable =
    target.mysql && supportsVersioning(connectedInfo(statusStore.get()[connectionId]))
  const versioning = versionable
    ? await queryClient.fetchQuery({
        ...versioningQuery(connectionId, database, name),
        staleTime: 0
      })
    : undefined
  const draft = draftFromTable(
    dialect,
    draftSchemaFor(dialect, target.mysql, database, schema),
    name,
    info,
    extras
  )
  return { draft, versioning }
}

/** The script that brings the table in line with the draft ('' when nothing changed). */
export function draftScript(
  target: DdlTarget,
  draft: TableDraft,
  versioning: Versioning | null | undefined
): string {
  const statements =
    versioning !== undefined
      ? versionedTableStatements(draft, target.options, versioning, !!versioning?.versioned)
      : tableStatements(target.dialect, draft, target.options)
  return ddlScript(target.dialect, statements, target.options)
}

/** Runs a designer script in a session of its own, rolling back what a failure leaves open. */
export async function runDdl(target: DdlTarget, script: string): Promise<void> {
  const { connectionId, database, dialect } = target
  const session = `designer-${draftId()}`
  try {
    const out = await api.execute(connectionId, session, database, script)
    if (out.error) throw new Error(out.error.message)
  } catch (e) {
    // XACT_ABORT doesn't roll back after a compile error, which leaves the transaction open;
    // SQLite stops at the failing statement inside its BEGIN
    if (dialect === 'tsql' || (dialect === 'sqlite' && !target.options.d1)) {
      await api
        .execute(
          connectionId,
          session,
          database,
          dialect === 'tsql' ? 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;' : 'ROLLBACK;'
        )
        .catch(() => undefined)
    }
    throw e
  } finally {
    void api.closeSession(connectionId, session).catch(() => undefined)
  }
}
