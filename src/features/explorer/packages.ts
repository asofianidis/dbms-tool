import { api, type DbObject } from '@/lib/api'
import { connectedInfo, isMariaDb } from '@/lib/mariadb'
import {
  isOracleMode,
  packageScript,
  packageTemplate,
  packagesInDefaultMode,
  withSqlModes,
  type PackageModes
} from '@/lib/mariadb-packages'
import { literal } from '@/lib/sql'
import { getConnection, newQueryTab, statusStore } from '@/lib/workspace'

function serverInfo(connectionId: string) {
  return connectedInfo(statusStore.get()[connectionId])
}

/** Routine types whose sql_mode a kind's DDL depends on. */
const ROUTINE_TYPES: Partial<Record<DbObject['kind'], string[]>> = {
  procedure: ['PROCEDURE'],
  function: ['FUNCTION'],
  package: ['PACKAGE', 'PACKAGE BODY']
}

/**
 * The sql_mode each part of a MariaDB routine or package was stored under, by
 * ROUTINE_TYPE; empty on MySQL, whose routines never use Oracle syntax.
 */
async function storedModes(
  connectionId: string,
  database: string,
  obj: DbObject
): Promise<Record<string, string>> {
  const types = ROUTINE_TYPES[obj.kind]
  if (!types || getConnection(connectionId)?.engine !== 'mysql') return {}
  if (!isMariaDb(serverInfo(connectionId))) return {}
  const out = await api.execute(
    connectionId,
    '__meta',
    database,
    `SELECT ROUTINE_TYPE, SQL_MODE FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = ${literal('mysql', database)} AND ROUTINE_NAME = ${literal('mysql', obj.name)}
  AND ROUTINE_TYPE IN (${types.map((t) => literal('mysql', t)).join(', ')})`
  )
  if (out.error) throw new Error(out.error.message)
  const modes: Record<string, string> = {}
  for (const row of out.results[0]?.rows ?? []) modes[String(row[0])] = String(row[1] ?? '')
  return modes
}

function packageModes(modes: Record<string, string>): PackageModes {
  return { spec: modes['PACKAGE'] ?? null, body: modes['PACKAGE BODY'] ?? null }
}

/**
 * A routine's CREATE script that runs as is: routines stored under
 * sql_mode=ORACLE are wrapped in SET sql_mode … restore.
 */
export async function runnableCreate(
  connectionId: string,
  database: string,
  obj: DbObject,
  definition: string
): Promise<string> {
  const modes = await storedModes(connectionId, database, obj)
  if (obj.kind === 'package') return packageScript(definition, packageModes(modes))
  const mode = modes[obj.kind.toUpperCase()]
  return isOracleMode(mode) ? withSqlModes([{ sql: definition, mode }]) : definition
}

/**
 * The Modify script for a routine (`script`, from modifyScript) or package,
 * wrapped in the stored sql_mode when that's Oracle mode.
 */
export async function runnableModify(
  connectionId: string,
  database: string,
  obj: DbObject,
  definition: string,
  script: string
): Promise<string> {
  const modes = await storedModes(connectionId, database, obj)
  if (obj.kind === 'package') return packageScript(definition, packageModes(modes), true)
  const mode = modes[obj.kind.toUpperCase()]
  return isOracleMode(mode) ? withSqlModes([{ sql: script, mode }]) : script
}

/** Opens a query tab with a template for a new MariaDB package (spec and body). */
export function newPackage(connectionId: string, database: string): void {
  newQueryTab(
    connectionId,
    database,
    packageTemplate(packagesInDefaultMode(serverInfo(connectionId)))
  )
}
