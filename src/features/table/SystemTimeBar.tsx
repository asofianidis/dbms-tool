import { useEffect, useState } from 'react'
import { Eraser, History, Lock } from 'lucide-react'
import type { TableRef } from '@/lib/sql'
import {
  nowTimestamp,
  purgeHistoryScript,
  systemTimeProblem,
  type SystemTime
} from '@/lib/versioning'
import { newQueryTab } from '@/lib/workspace'
import { Badge, Button, Segmented } from '@/components/ui'

type Kind = SystemTime['kind']

const KINDS: { value: Kind; label: string; title: string }[] = [
  { value: 'current', label: 'Current', title: 'The rows as they are now' },
  { value: 'asOf', label: 'As of', title: 'The rows as they were at a point in time' },
  {
    value: 'between',
    label: 'Between',
    title: 'Every row version current at some point in a range'
  },
  { value: 'all', label: 'All history', title: 'Every version of every row' }
]

const timeInput =
  'h-6 w-44 rounded-md border border-line-strong bg-canvas px-2 font-mono text-[11.5px] text-bright placeholder:text-faint focus:border-accent/50 focus:outline-none'

/**
 * The "System time" bar of a MariaDB system-versioned table: which rows the
 * grid reads (`FOR SYSTEM_TIME`), whether it shows the row start / end
 * columns, and a script to purge old history.
 */
export function SystemTimeBar({
  connectionId,
  database,
  tableRef,
  value,
  onChange,
  periods,
  onPeriodsChange
}: {
  connectionId: string
  database: string
  tableRef: TableRef
  value: SystemTime
  onChange: (value: SystemTime) => void
  periods: boolean
  onPeriodsChange: (periods: boolean) => void
}): React.JSX.Element {
  const [kind, setKind] = useState<Kind>(value.kind)
  const [at, setAt] = useState(() => (value.kind === 'asOf' ? value.at : nowTimestamp()))
  const [from, setFrom] = useState(() => (value.kind === 'between' ? value.from : ''))
  const [to, setTo] = useState(() => (value.kind === 'between' ? value.to : nowTimestamp()))
  // Follow changes made elsewhere, such as "Show history" on a row
  useEffect(() => setKind(value.kind), [value])

  const draft: SystemTime =
    kind === 'asOf'
      ? { kind, at }
      : kind === 'between'
        ? { kind, from, to }
        : kind === 'all'
          ? { kind }
          : { kind: 'current' }
  const problem = systemTimeProblem(draft)
  const pending = JSON.stringify(draft) !== JSON.stringify(value)

  const pick = (next: Kind): void => {
    setKind(next)
    // Nothing to fill in: apply right away
    if (next === 'current' || next === 'all') onChange({ kind: next })
  }
  const apply = (): void => {
    if (!problem) onChange(draft)
  }
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') apply()
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 text-[11.5px] text-muted">
      <History className="size-3.5 shrink-0 text-syn-type" />
      <span title="This table is system-versioned: MariaDB keeps every old version of its rows">
        System time
      </span>
      <Segmented size="sm" value={kind} options={KINDS} onChange={pick} />
      {kind === 'asOf' && (
        <input
          value={at}
          onChange={(e) => setAt(e.target.value)}
          onKeyDown={onKey}
          placeholder="YYYY-MM-DD hh:mm:ss"
          spellCheck={false}
          className={timeInput}
          title="In the session's time zone"
        />
      )}
      {kind === 'between' && (
        <>
          <input
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            onKeyDown={onKey}
            placeholder="from YYYY-MM-DD hh:mm:ss"
            spellCheck={false}
            className={timeInput}
          />
          <span>and</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={onKey}
            placeholder="to YYYY-MM-DD hh:mm:ss"
            spellCheck={false}
            className={timeInput}
          />
        </>
      )}
      {(kind === 'asOf' || kind === 'between') && (
        <Button
          size="xs"
          variant={pending ? 'primary' : 'ghost'}
          disabled={!!problem || !pending}
          title={problem ?? undefined}
          onClick={apply}
        >
          Apply
        </Button>
      )}
      {problem && pending && <span className="text-faint">{problem}</span>}
      <label
        className="ml-1 flex items-center gap-1.5"
        title="Show when each row version started and ended"
      >
        <input
          type="checkbox"
          className="size-3.5 accent-accent"
          checked={periods}
          onChange={(e) => onPeriodsChange(e.target.checked)}
        />
        Row start / end
      </label>
      <div className="flex-1" />
      {value.kind !== 'current' && (
        <Badge tone="info" title="Old row versions can't be edited">
          <Lock className="size-3" /> history · read-only
        </Badge>
      )}
      <Button
        size="xs"
        variant="ghost"
        title="Open a script that deletes old row versions"
        onClick={() =>
          newQueryTab(
            connectionId,
            database,
            purgeHistoryScript(tableRef, value.kind === 'asOf' ? value.at : nowTimestamp()),
            { title: `purge history ${tableRef.name}` }
          )
        }
      >
        <Eraser className="size-3.5" /> Purge history…
      </Button>
    </div>
  )
}
