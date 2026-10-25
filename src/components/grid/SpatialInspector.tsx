import { useMemo, useState } from 'react'
import { ClipboardCopy, WrapText } from 'lucide-react'
import type { Cell, ColumnMeta } from '@/lib/api'
import { geometryLabel, pointCount, toEwkt, toGeoJson, type Geometry } from '@/lib/ewkb'
import { copyText } from '@/lib/export'
import { CodeEditor } from '../editor/CodeEditor'
import { Badge, Button, Modal, Segmented } from '../ui'

type SpatialMode = 'ewkt' | 'geojson'

/** Full view of a PostGIS value: EWKT (editable) and GeoJSON, decoded from the hex EWKB. */
export function SpatialInspector({
  column,
  geometry,
  editable,
  onSave,
  onClose
}: {
  column: ColumnMeta
  geometry: Geometry
  editable: boolean
  onSave: (value: Cell) => void
  onClose: () => void
}): React.JSX.Element {
  const ewkt = useMemo(() => toEwkt(geometry), [geometry])
  const geoJson = useMemo(
    () => JSON.stringify(JSON.parse(toGeoJson(geometry)), null, 2),
    [geometry]
  )
  const [text, setText] = useState(ewkt)
  const [mode, setMode] = useState<SpatialMode>('ewkt')
  const [wrap, setWrap] = useState(true)
  const points = pointCount(geometry)
  const changed = text.trim() !== ewkt
  return (
    <Modal
      width="lg"
      title={column.name}
      description={
        <span className="flex items-center gap-2">
          {column.typeName && <span className="font-mono">{column.typeName}</span>}
          <Badge tone="info">{geometryLabel(geometry)}</Badge>
          {geometry.srid > 0 && <span className="font-mono">SRID {geometry.srid}</span>}
          <span>
            {points.toLocaleString()} point{points === 1 ? '' : 's'}
          </span>
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'ewkt', label: 'EWKT' },
              { value: 'geojson', label: 'GeoJSON' }
            ]}
          />
          <Button size="sm" variant="ghost" onClick={() => setWrap((w) => !w)}>
            <WrapText className="size-3.5" /> {wrap ? 'No wrap' : 'Wrap'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void copyText(ewkt, 'Copied as EWKT')}>
            <ClipboardCopy className="size-3.5" /> Copy EWKT
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copyText(toGeoJson(geometry), 'Copied as GeoJSON')}
          >
            <ClipboardCopy className="size-3.5" /> Copy GeoJSON
          </Button>
          <div className="flex-1" />
          {editable && (
            <>
              <Button size="sm" variant="secondary" onClick={() => (onSave(null), onClose())}>
                Set NULL
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!changed || mode !== 'ewkt'}
                title="Accepts WKT or EWKT; WKT gets the column's SRID"
                onClick={() => {
                  onSave(text.trim())
                  onClose()
                }}
              >
                Apply
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="h-[46vh] overflow-hidden rounded-lg border border-line bg-canvas">
        {mode === 'ewkt' ? (
          <CodeEditor
            key="ewkt"
            value={text}
            onChange={setText}
            language={{ kind: 'text' }}
            readOnly={!editable}
            wordWrap={wrap}
            lineNumbers={false}
            className="h-full"
            fontSize={12.5}
          />
        ) : (
          <CodeEditor
            key="geojson"
            value={geoJson}
            language={{ kind: 'json' }}
            readOnly
            wordWrap={wrap}
            lineNumbers
            className="h-full"
            fontSize={12.5}
          />
        )}
      </div>
    </Modal>
  )
}
