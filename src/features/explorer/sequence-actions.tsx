import { FileCode2, FilePlus2, ListTree, ScrollText } from 'lucide-react'
import { api, type DbObject } from '@/lib/api'
import {
  parseSequenceState,
  sequenceScript,
  sequenceStateSql,
  sequenceTemplate,
  type SequenceScript,
  type SequenceState
} from '@/lib/mariadb-sequences'
import type { TableRef } from '@/lib/sql'
import { toastError } from '@/lib/toast'
import { newQueryTab, openTable } from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'

/** Reads a MariaDB sequence's current state on the metadata session. */
export async function loadSequenceState(
  connectionId: string,
  database: string,
  ref: TableRef
): Promise<SequenceState | null> {
  const out = await api.execute(connectionId, '__meta', database, sequenceStateSql(ref))
  if (out.error) throw new Error(out.error.message)
  return parseSequenceState(out)
}

/** Opens a query tab with a script for the sequence, filled in from its state where it needs it. */
export async function scriptSequence(
  connectionId: string,
  database: string,
  ref: TableRef,
  kind: SequenceScript
): Promise<void> {
  try {
    const state = kind === 'nextval' ? null : await loadSequenceState(connectionId, database, ref)
    newQueryTab(connectionId, database, sequenceScript(kind, ref, state))
  } catch (e) {
    toastError(e)
  }
}

/** Opens a query tab with a template for a new MariaDB sequence. */
export function newSequence(connectionId: string, database: string): void {
  newQueryTab(connectionId, database, sequenceTemplate())
}

/** Context menu items for a MariaDB sequence; `script` runs the shared CREATE / DROP scripting. */
export function mariaDbSequenceItems(
  connectionId: string,
  database: string,
  obj: DbObject,
  ref: TableRef,
  script: (kind: 'definition' | 'drop') => void
): MenuItem[] {
  const run = (kind: SequenceScript) => () => void scriptSequence(connectionId, database, ref, kind)
  return [
    {
      label: 'Details',
      icon: <ListTree />,
      onSelect: () => openTable(connectionId, database, obj.schema, obj.name, obj.kind, 'structure')
    },
    {
      label: 'DDL',
      icon: <ScrollText />,
      onSelect: () =>
        openTable(connectionId, database, obj.schema, obj.name, obj.kind, 'definition')
    },
    'separator',
    { label: 'New query: NEXTVAL', icon: <FilePlus2 />, onSelect: run('nextval') },
    {
      label: 'Script as',
      icon: <FileCode2 />,
      submenu: [
        { label: 'CREATE', onSelect: () => script('definition') },
        { label: 'DROP', onSelect: () => script('drop') },
        'separator',
        { label: 'NEXTVAL', onSelect: run('nextval') },
        { label: 'SETVAL', onSelect: run('setval') },
        { label: 'ALTER', onSelect: run('alter') },
        { label: 'ALTER … RESTART', onSelect: run('restart') }
      ]
    }
  ]
}
