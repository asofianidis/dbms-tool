import type { ResultSet } from '@/lib/api'
import { chartData, resolveColumns, statValue, type Widget } from '@/lib/dashboards'
import { ResultGrid } from '@/components/grid/ResultGrid'
import { EmptyState } from '@/components/ui'
import { BarChart, LineChart, StatTile } from './charts'

/** Renders a result the way the widget asks; `asTable` shows the rows behind any chart. */
export function WidgetBody({
  widget,
  set,
  asTable
}: {
  widget: Pick<Widget, 'kind' | 'x' | 'y'>
  set: ResultSet
  asTable?: boolean
}): React.JSX.Element {
  if (asTable || widget.kind === 'table')
    return (
      <div className="h-full overflow-hidden rounded-md border border-line">
        <ResultGrid columns={set.columns} rows={set.rows} />
      </div>
    )
  if (!set.rows.length) return <EmptyState title="No rows" className="bg-none" />
  const { x, y } = resolveColumns(set, widget)
  if (widget.kind === 'stat') {
    const stat = statValue(set, y)
    return <StatTile value={stat.value} text={stat.text} caption={stat.column} />
  }
  if (!y.length)
    return (
      <EmptyState title="Nothing to chart" className="bg-none">
        The result has no numeric columns. Edit the widget to pick columns, or show it as a table.
      </EmptyState>
    )
  const data = chartData(set, x, y)
  return widget.kind === 'line' ? <LineChart data={data} /> : <BarChart data={data} />
}
