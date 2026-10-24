import type { Dialect } from './engines'
import { settingsStore } from './settings'
import { createPersistentStore, createStore } from './store'

/** Query tabs whose session holds a transaction open (or failed and awaiting ROLLBACK). */
export const openTransactionsStore = createStore<Record<string, boolean>>({})

/**
 * Query tabs' chosen commit mode (true = manual: running starts a transaction when none is
 * open). Tabs without an entry follow Settings' default.
 */
export const manualCommitStore = createPersistentStore<Record<string, boolean>>('manual-commit', {})

export function isManualCommit(
  tabId: string,
  chosen = manualCommitStore.get(),
  defaultMode = settingsStore.get().defaultCommitMode
): boolean {
  return chosen[tabId] ?? defaultMode === 'manual'
}

export function setInTransaction(tabId: string, open: boolean): void {
  if (!!openTransactionsStore.get()[tabId] === open) return
  openTransactionsStore.set(({ [tabId]: _, ...rest }) => (open ? { ...rest, [tabId]: true } : rest))
}

export function setManualCommit(tabId: string, on: boolean): void {
  manualCommitStore.set((chosen) => ({ ...chosen, [tabId]: on }))
}

/** Forgets a closed tab. */
export function clearTransactionState(tabId: string): void {
  setInTransaction(tabId, false)
  if (tabId in manualCommitStore.get()) manualCommitStore.set(({ [tabId]: _, ...rest }) => rest)
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
