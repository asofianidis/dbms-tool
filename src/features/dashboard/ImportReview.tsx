import { ShieldAlert } from 'lucide-react'
import { updateDashboard, type Dashboard } from '@/lib/dashboards'
import { getConnection } from '@/lib/workspace'
import { Button } from '@/components/ui'
import { removeDashboard } from './actions'

/**
 * Shown instead of an imported dashboard until the user approves its queries.
 * A dashboard file can come from anyone, and on MongoDB its widget queries run
 * as JavaScript with the app's full access, so none of them run before this.
 */
export function ImportReview({ dashboard }: { dashboard: Dashboard }): React.JSX.Element {
  const mongo = getConnection(dashboard.connectionId)?.engine === 'mongo'
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warn" />
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium text-bright">
              Review “{dashboard.name}” before running it
            </h2>
            <p className="text-[13px] text-muted">
              This dashboard was imported from a file. Its widgets run the queries below against
              your connection as soon as they’re approved.
              {mongo &&
                ' On MongoDB they run as JavaScript inside the app, so only approve queries you understand and trust.'}
            </p>
          </div>
        </div>
        {dashboard.widgets.map((w) => (
          <div key={w.id} className="flex flex-col gap-1">
            <div className="text-xs font-medium text-fg">{w.title || 'Untitled widget'}</div>
            <pre className="max-h-64 overflow-auto rounded-md bg-raised p-3 font-mono text-[12px] whitespace-pre-wrap text-fg ring-1 ring-line ring-inset">
              {w.query || '(no query)'}
            </pre>
          </div>
        ))}
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => updateDashboard(dashboard.id, { unreviewed: false })}
          >
            Run these queries
          </Button>
          <Button variant="danger" onClick={() => void removeDashboard(dashboard)}>
            Delete dashboard
          </Button>
        </div>
      </div>
    </div>
  )
}
