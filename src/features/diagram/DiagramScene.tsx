import { memo } from 'react'
import { Eye, KeyRound, Link2, Table2 } from 'lucide-react'
import {
  FONTS,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  ROW_LAYOUT,
  ROW_PAD,
  fitText,
  markerCircle,
  markerPath,
  routeEdge,
  visibleColumns,
  type ColumnMode,
  type DiagramEdge,
  type DiagramTable,
  type Measure,
  type NodeBox,
  type Point,
  type Rect
} from '@/lib/diagram'
import type { ThemeColors } from '@/lib/themes'

export interface SceneProps {
  tables: DiagramTable[]
  edges: DiagramEdge[]
  boxes: Map<string, NodeBox>
  positions: Record<string, Point>
  mode: ColumnMode
  showTypes: boolean
  showSchema: (table: DiagramTable) => boolean
  measure: Measure
  palette: ThemeColors
  /** Table whose relationships are emphasised (hovered or selected) */
  focus?: string | null
  selected?: string | null
  /** Search matches; other tables fade */
  matches?: Set<string> | null
  onNodePointerDown?: (key: string, e: React.PointerEvent) => void
  onNodeDoubleClick?: (key: string) => void
  onNodeContextMenu?: (key: string, e: React.MouseEvent) => void
  onNodeHover?: (key: string | null) => void
}

export function rectOf(
  key: string,
  boxes: Map<string, NodeBox>,
  positions: Record<string, Point>
): Rect | null {
  const box = boxes.get(key)
  const at = positions[key]
  return box && at ? { ...at, width: box.width, height: box.height } : null
}

/** Y of a column row's centre, or of the header when the column isn't shown. */
function rowY(
  table: DiagramTable,
  column: string | undefined,
  mode: ColumnMode,
  top: number
): number {
  const index = visibleColumns(table, mode).findIndex((c) => c.name === column)
  return index < 0
    ? top + HEADER_HEIGHT / 2
    : top + HEADER_HEIGHT + ROW_PAD + index * ROW_HEIGHT + ROW_HEIGHT / 2
}

/** The diagram as plain SVG elements, drawn in diagram coordinates. */
export const DiagramScene = memo(function DiagramScene(props: SceneProps): React.JSX.Element {
  const { tables, edges, boxes, positions, mode, palette: p, focus, matches } = props
  const byKey = new Map(tables.map((t) => [t.key, t]))
  const faded = (key: string): boolean => !!matches && !matches.has(key)

  return (
    <g>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {edges.map((e) => {
          const from = rectOf(e.from, boxes, positions)
          const to = rectOf(e.to, boxes, positions)
          const child = byKey.get(e.from)
          const parent = byKey.get(e.to)
          if (!from || !to || !child || !parent) return null
          const route = routeEdge(
            from,
            rowY(child, e.fromColumns[0], mode, from.y),
            to,
            rowY(parent, e.toColumns[0], mode, to.y),
            e.from === e.to
          )
          const lit = !!focus && (e.from === focus || e.to === focus)
          const dim = (!!focus && !lit) || faded(e.from) || faded(e.to)
          const color = lit ? p.accent : p.muted
          const zeroAtParent = markerCircle(route.end, e.optional)
          return (
            <g key={e.id} opacity={dim ? 0.18 : 1} stroke={color} strokeWidth={lit ? 1.8 : 1.2}>
              <title>{`${e.name}: ${e.from} (${e.fromColumns.join(', ')}) → ${e.to} (${e.toColumns.join(', ')})`}</title>
              <path d={route.path} />
              <path d={markerPath(route.start, e.unique ? 'one' : 'many', false)} />
              <path d={markerPath(route.end, 'one', e.optional)} />
              {zeroAtParent && (
                <circle cx={zeroAtParent.x} cy={zeroAtParent.y} r={3.5} fill={p.canvas} />
              )}
            </g>
          )
        })}
      </g>
      {tables.map((t) => {
        const at = positions[t.key]
        const box = boxes.get(t.key)
        if (!at || !box) return null
        return (
          <TableNode
            key={t.key}
            table={t}
            at={at}
            box={box}
            props={props}
            dim={faded(t.key) || (!!focus && focus !== t.key && !isNeighbour(edges, focus, t.key))}
          />
        )
      })}
    </g>
  )
})

function isNeighbour(edges: DiagramEdge[], a: string, b: string): boolean {
  return edges.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))
}

function TableNode({
  table,
  at,
  box,
  props,
  dim
}: {
  table: DiagramTable
  at: Point
  box: NodeBox
  props: SceneProps
  dim: boolean
}): React.JSX.Element {
  const { palette: p, mode, showTypes, measure, selected, focus } = props
  const isView = table.kind === 'view' || table.kind === 'materialized_view'
  const fkColumns = new Set(table.foreignKeys.flatMap((f) => f.columns))
  const rows = visibleColumns(table, mode)
  const { width, height } = box
  const schema = props.showSchema(table) && table.schema ? `${table.schema}.` : ''
  const titleMax = width - ROW_LAYOUT.nameX - ROW_LAYOUT.sidePad
  const schemaText = fitText(schema, titleMax * 0.5, FONTS.schema, measure)
  const nameText = fitText(
    table.name,
    titleMax - measure(schemaText, FONTS.schema),
    FONTS.header,
    measure
  )
  const isSelected = selected === table.key
  const outline = isSelected ? p.accent : focus === table.key ? p.muted : p['line-strong']
  const r = 7
  return (
    <g
      transform={`translate(${at.x} ${at.y})`}
      opacity={dim ? 0.35 : 1}
      onPointerDown={props.onNodePointerDown && ((e) => props.onNodePointerDown!(table.key, e))}
      onDoubleClick={props.onNodeDoubleClick && (() => props.onNodeDoubleClick!(table.key))}
      onContextMenu={props.onNodeContextMenu && ((e) => props.onNodeContextMenu!(table.key, e))}
      onPointerEnter={props.onNodeHover && (() => props.onNodeHover!(table.key))}
      onPointerLeave={props.onNodeHover && (() => props.onNodeHover!(null))}
    >
      <rect width={width} height={height} rx={r} fill={p.raised} />
      <path
        d={`M 0 ${HEADER_HEIGHT} V ${r} Q 0 0 ${r} 0 H ${width - r} Q ${width} 0 ${width} ${r} V ${HEADER_HEIGHT} Z`}
        fill={p.panel}
      />
      <rect
        width={width - 2 * r}
        x={r}
        height={2.5}
        fill={isView ? p['syn-type'] : p.accent}
        opacity={0.85}
      />
      {rows.length > 0 && (
        <line x1={0} x2={width} y1={HEADER_HEIGHT} y2={HEADER_HEIGHT} stroke={p.line} />
      )}
      {isView ? (
        <Eye x={10} y={HEADER_HEIGHT / 2 - 7} size={14} color={p['syn-type']} />
      ) : (
        <Table2 x={10} y={HEADER_HEIGHT / 2 - 7} size={14} color={p['syn-prop']} />
      )}
      <text x={ROW_LAYOUT.nameX} y={HEADER_HEIGHT / 2 + 1} dominantBaseline="central">
        {schemaText && (
          <tspan fill={p.muted} style={{ font: FONTS.schema }}>
            {schemaText}
          </tspan>
        )}
        <tspan fill={p.bright} style={{ font: FONTS.header }}>
          {nameText}
        </tspan>
        <title>{(table.schema ? `${table.schema}.` : '') + table.name}</title>
      </text>
      {rows.map((c, i) => {
        const y = HEADER_HEIGHT + ROW_PAD + i * ROW_HEIGHT + ROW_HEIGHT / 2
        const isFk = fkColumns.has(c.name)
        // The type gets whatever the name leaves, but never squeezes the name below 45%
        const available =
          width - ROW_LAYOUT.nameX - ROW_LAYOUT.sidePad - (showTypes ? ROW_LAYOUT.typeGap : 0)
        const typeWidth = showTypes
          ? Math.min(
              measure(c.dataType, FONTS.type),
              Math.max(available * 0.55, available - measure(c.name, FONTS.name))
            )
          : 0
        const nameMax = available - typeWidth
        return (
          <g key={c.name}>
            {c.isPrimaryKey ? (
              <KeyRound x={11} y={y - 6} size={12} color={p['syn-number']} />
            ) : isFk ? (
              <Link2 x={11} y={y - 6} size={12} color={p.info} />
            ) : (
              <circle cx={17} cy={y} r={1.6} fill={c.nullable ? p.faint : p.muted} />
            )}
            <text
              x={ROW_LAYOUT.nameX}
              y={y}
              dominantBaseline="central"
              fill={c.isPrimaryKey ? p.bright : p.fg}
              style={{ font: FONTS.name, fontWeight: c.isPrimaryKey ? 600 : 400 }}
            >
              {fitText(c.name, nameMax, FONTS.name, measure)}
            </text>
            {showTypes && (
              <text
                x={width - ROW_LAYOUT.sidePad}
                y={y}
                dominantBaseline="central"
                textAnchor="end"
                fill={p.muted}
                style={{ font: FONTS.type }}
              >
                {fitText(c.dataType, typeWidth, FONTS.type, measure)}
              </text>
            )}
          </g>
        )
      })}
      <rect
        width={width}
        height={height}
        rx={r}
        fill="none"
        stroke={outline}
        strokeWidth={isSelected ? 1.75 : 1}
        strokeDasharray={isView ? '5 3' : undefined}
      />
    </g>
  )
}
