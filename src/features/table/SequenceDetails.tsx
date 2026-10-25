import { useQuery } from '@tanstack/react-query'
import { FilePlus2, Pencil, RefreshCw, RotateCcw } from 'lucide-react'
import type { SequenceScript } from '@/lib/mariadb-sequences'
import type { TableRef } from '@/lib/sql'
import type { TabOf } from '@/lib/workspace'
import { Button, EmptyState, ErrorText, Spinner, Toolbar } from '@/components/ui'
import { loadSequenceState, scriptSequence } from '../explorer/sequence-actions'

/** A MariaDB sequence's state and options, read from its one row. */
export function SequenceDetails({
  tab,
  tableRef
}: {
  tab: TabOf<'table'>
  tableRef: TableRef
}): React.JSX.Element {
  const q = useQuery({
    // Under the table key, so the explorer's Refresh reloads it
    queryKey: ['conn', tab.connectionId, 'table', tab.database, tab.schema, tab.name, 'sequence'],
    queryFn: () => loadSequenceState(tab.connectionId, tab.database, tableRef),
    staleTime: 0
  })
  const script = (kind: SequenceScript) => () =>
    void scriptSequence(tab.connectionId, tab.database, tableRef, kind)
  const s = q.data
  const rows: [string, string][] = s
    ? [
        ['Next value (not cached)', s.nextNotCached],
        ['Start', s.start],
        ['Increment', s.increment],
        ['Minimum', s.minimum],
        ['Maximum', s.maximum],
        ['Cache', s.cache === '0' ? '0 (no cache)' : s.cache],
        ['Cycle', s.cycle ? 'Yes' : 'No'],
        ['Times cycled', s.cycleCount]
      ]
    : []
  return (
    <>
      <Toolbar>
        <Button size="sm" variant="ghost" onClick={script('nextval')}>
          <FilePlus2 className="size-3.5" /> NEXTVAL
        </Button>
        <Button size="sm" variant="ghost" onClick={script('setval')}>
          <FilePlus2 className="size-3.5" /> SETVAL
        </Button>
        <Button size="sm" variant="ghost" onClick={script('alter')}>
          <Pencil className="size-3.5" /> ALTER
        </Button>
        <Button size="sm" variant="ghost" onClick={script('restart')}>
          <RotateCcw className="size-3.5" /> RESTART
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
        <span className="ml-2 text-[11px] text-faint">
          Sessions take values in blocks of the cache size, so the next value can jump ahead.
        </span>
      </Toolbar>
      {q.isPending ? (
        <EmptyState title="Loading…" icon={<Spinner className="size-5" />} />
      ) : q.isError ? (
        <div className="p-4">
          <ErrorText error={q.error} />
        </div>
      ) : !s ? (
        <EmptyState title="The sequence returned no state" />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <table className="text-left text-[12.5px]">
            <tbody className="select-text">
              {rows.map(([label, value]) => (
                <tr key={label} className="border-b border-line/60">
                  <td className="py-1.5 pr-8 text-muted">{label}</td>
                  <td className="py-1.5 font-mono text-bright tabular-nums">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
