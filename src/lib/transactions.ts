import type { Dialect } from './engines'
import { createPersistentStore, createStore } from './store'

/** Query tabs whose session holds a transaction open (or failed and awaiting ROLLBACK). */
export const openTransactionsStore = createStore<Record<string, boolean>>({})

/** Query tabs in manual-commit mode: running starts a transaction when none is open. */
export const manualCommitStore = createPersistentStore<Record<string, boolean>>('manual-commit', {})

export function setInTransaction(tabId: string, open: boolean): void {
  if (!!openTransactionsStore.get()[tabId] === open) return
  openTransactionsStore.set(({ [tabId]: _, ...rest }) => (open ? { ...rest, [tabId]: true } : rest))
}

export function setManualCommit(tabId: string, on: boolean): void {
  manualCommitStore.set(({ [tabId]: _, ...rest }) => (on ? { ...rest, [tabId]: true } : rest))
}

/** Forgets a closed tab. */
export function clearTransactionState(tabId: string): void {
  setInTransaction(tabId, false)
  if (manualCommitStore.get()[tabId]) setManualCommit(tabId, false)
}

export function beginSql(dialect: Dialect): string {
  switch (dialect) {
    case 'mysql':
      return 'START TRANSACTION'
    case 'tsql':
      return 'BEGIN TRANSACTION'
    default:
      return 'BEGIN'
  }
}

export function commitSql(dialect: Dialect): string {
  return dialect === 'tsql' ? 'COMMIT TRANSACTION' : 'COMMIT'
}

export function rollbackSql(dialect: Dialect): string {
  return dialect === 'tsql' ? 'ROLLBACK TRANSACTION' : 'ROLLBACK'
}
