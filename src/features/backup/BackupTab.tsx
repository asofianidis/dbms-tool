import { useEffect } from 'react'
import { connect, connectionsStore, statusStore, type TabOf } from '@/lib/workspace'
import { EmptyState, Spinner } from '@/components/ui'
import { MssqlBackupWizard, MssqlRestoreWizard } from './MssqlWizard'
import { ToolBackupWizard, ToolRestoreWizard } from './ToolWizard'

/** Backup and restore wizards, one tab per database and direction. */
export function BackupTab({ tab }: { tab: TabOf<'backup'> }): React.JSX.Element {
  const connection = connectionsStore.use().find((c) => c.id === tab.connectionId)
  const status = statusStore.use()[tab.connectionId]
  useEffect(() => {
    if (connection && status?.state !== 'connected') void connect(connection.id)
  }, [connection, status?.state])
  if (!connection) return <EmptyState title="This connection no longer exists" />
  if (status?.state !== 'connected')
    return <EmptyState title="Connecting…" icon={<Spinner className="size-5" />} />
  const info = status.info
  if (connection.engine === 'babelfish' || info.babelfishVersion) {
    return (
      <EmptyState title="Babelfish doesn’t support BACKUP and RESTORE">
        Back up the underlying Aurora PostgreSQL cluster with snapshots, or add a PostgreSQL
        connection to its PostgreSQL endpoint and use pg_dump there.
      </EmptyState>
    )
  }
  const props = { tabId: tab.id, connection, database: tab.database }
  if (connection.engine === 'mssql') {
    return tab.mode === 'backup' ? (
      <MssqlBackupWizard {...props} />
    ) : (
      <MssqlRestoreWizard {...props} />
    )
  }
  if (
    connection.engine !== 'postgres' &&
    connection.engine !== 'mysql' &&
    connection.engine !== 'mongo'
  ) {
    return <EmptyState title="Backups aren’t available for this kind of connection" />
  }
  return tab.mode === 'backup' ? (
    <ToolBackupWizard {...props} serverVersion={info.version} />
  ) : (
    <ToolRestoreWizard {...props} serverVersion={info.version} />
  )
}
