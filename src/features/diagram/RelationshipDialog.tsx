import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeftRight, ArrowRight, FilePlus2, Link2, Wrench } from 'lucide-react'
import { cn } from '@/lib/cn'
import { foreignKeyActions, validateDraft, type ForeignKeyAction } from '@/lib/ddl'
import type { DiagramTable } from '@/lib/diagram'
import {
  applyRelationship,
  hasLeadingIndex,
  isKeyColumn,
  referencingType,
  suggestColumnName,
  typesDiffer,
  type LinkSpec,
  type RelationshipChange
} from '@/lib/diagram-edit'
import { errorMessage, toast } from '@/lib/toast'
import { newQueryTab, refreshConnection } from '@/lib/workspace'
import { Button, ErrorText, Field, Input, Modal, Select, Spinner } from '@/components/ui'
import { openTableDesigner } from '../table/TableDesigner'
import { draftScript, loadTableDraft, runDdl, type DdlTarget } from '../table/designer-ops'

const NEW = '\u0000new'

/** Confirms a foreign key drawn on the diagram, with its options and the SQL it runs. */
export function RelationshipDialog({
  target,
  link: initialLink,
  byKey,
  label,
  onChanged,
  onClose
}: {
  target: DdlTarget
  link: LinkSpec
  byKey: Map<string, DiagramTable>
  /** How the diagram names a table */
  label: (table: DiagramTable) => string
  /** After the change is applied, here or in the designer */
  onChanged: () => void
  onClose: () => void
}): React.JSX.Element {
  const { dialect } = target
  const [link, setLink] = useState(initialLink)
  const child = byKey.get(link.child)!
  const parent = byKey.get(link.parent)!

  const defaultName = (l: LinkSpec): string =>
    suggestColumnName(
      byKey.get(l.parent)!.name,
      l.parentColumn,
      byKey.get(l.child)!.columns.map((c) => c.name)
    )
  const [column, setColumn] = useState(link.childColumn ?? NEW)
  const [parentColumn, setParentColumn] = useState(link.parentColumn)
  const parentType = parent.columns.find((c) => c.name === parentColumn)?.dataType ?? ''
  const [newName, setNewName] = useState(() => defaultName(link))
  const [newType, setNewType] = useState(() => referencingType(dialect, parentType))
  const [nullable, setNullable] = useState(true)
  const [name, setName] = useState('')
  const [onDelete, setOnDelete] = useState<ForeignKeyAction>('NO ACTION')
  const [onUpdate, setOnUpdate] = useState<ForeignKeyAction>('NO ACTION')
  const isNew = column === NEW
  const childColumn = isNew ? newName.trim() : column
  // MySQL's InnoDB indexes referencing columns itself
  const canIndex = dialect !== 'mysql' && (isNew || !hasLeadingIndex(child, column))
  const [index, setIndex] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const swap = (): void => {
    if (isNew) return
    const next: LinkSpec = {
      child: link.parent,
      childColumn: parentColumn,
      parent: link.child,
      parentColumn: column
    }
    setLink(next)
    setColumn(parentColumn)
    setParentColumn(column)
    setNewName(defaultName(next))
  }

  const loaded = useQuery({
    queryKey: ['conn', target.connectionId, 'diagram-draft', target.database, link.child],
    queryFn: () => loadTableDraft(target, child.schema, child.name),
    staleTime: 0,
    gcTime: 0
  })

  const change: RelationshipChange = {
    column: childColumn,
    newColumn: isNew ? { dataType: newType.trim(), nullable } : null,
    refSchema: parent.schema,
    refTable: parent.name,
    refColumn: parentColumn,
    name,
    onDelete,
    onUpdate,
    index: canIndex && index
  }
  const draft = loaded.data && applyRelationship(dialect, loaded.data.draft, change)
  const problem = draft ? validateDraft(dialect, draft) : null
  const script = draft && !problem ? draftScript(target, draft, loaded.data!.versioning) : ''

  const existingType = child.columns.find((c) => c.name === column)
  const existingNullable = isNew ? nullable : !!existingType?.nullable
  const warnings: string[] = []
  if (!isKeyColumn(parent, parentColumn))
    warnings.push(
      `${parent.name}.${parentColumn} isn't a primary key or unique, so the database will likely refuse to reference it`
    )
  if (!isNew && existingType && typesDiffer(existingType.dataType, parentType))
    warnings.push(`${existingType.dataType} and ${parentType} are different types`)
  if ((onDelete === 'SET NULL' || onUpdate === 'SET NULL') && !existingNullable)
    warnings.push(`SET NULL needs ${childColumn || 'the column'} to allow nulls`)
  if (
    !isNew &&
    child.foreignKeys.some(
      (fk) =>
        fk.columns.length === 1 &&
        fk.columns[0] === column &&
        fk.refTable === parent.name &&
        fk.refColumns[0] === parentColumn
    )
  )
    warnings.push('The same foreign key already exists')
  if (dialect === 'sqlite')
    warnings.push("SQLite can't add a foreign key in place, so the table is rebuilt with its data")

  const designerSeed = (): void => {
    onClose()
    openTableDesigner(target.connectionId, target.database, child.schema, child.name, {
      view: isNew ? 'columns' : 'foreignKeys',
      seed: (d) => applyRelationship(dialect, d, change),
      onApplied: onChanged
    })
  }

  const create = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    try {
      await runDdl(target, script)
      onChanged()
      toast(`Linked ${child.name}.${childColumn} to ${parent.name}.${parentColumn}`)
      refreshConnection(target.connectionId)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  const actions = foreignKeyActions(dialect)
  const status = problem ? (
    <span className="text-danger">{problem}</span>
  ) : warnings.length ? (
    <span className="flex min-w-0 items-center gap-1.5 text-warn" title={warnings.join('\n')}>
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="truncate">{warnings[0]}</span>
    </span>
  ) : null

  return (
    <Modal
      width="lg"
      title="New relationship"
      icon={<Link2 className="mt-0.5 size-4 text-accent" />}
      description={
        <span className="flex flex-wrap items-center gap-1.5 font-mono">
          {label(child)}.{childColumn || '…'}
          <ArrowRight className="size-3.5 text-muted" />
          {label(parent)}.{parentColumn}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <div className="mr-auto min-w-0 text-xs">{status}</div>
          <Button variant="ghost" disabled={!loaded.data} onClick={designerSeed}>
            <Wrench className="size-3.5" /> More options…
          </Button>
          <Button
            variant="secondary"
            disabled={!script}
            onClick={() => {
              newQueryTab(target.connectionId, target.database, script, {
                title: `link ${child.name}`
              })
              onClose()
            }}
          >
            <FilePlus2 className="size-3.5" /> Open in editor
          </Button>
          <Button variant="primary" disabled={!script || running} onClick={() => void create()}>
            {running ? <Spinner className="text-current" /> : <Link2 className="size-3.5" />}
            Create relationship
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
          <Field label={<>Column in {child.name}</>}>
            <Select
              selectClassName="h-7 font-mono text-xs"
              value={column}
              onChange={(e) => setColumn(e.target.value)}
            >
              {child.columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.dataType})
                </option>
              ))}
              <option value={NEW}>+ New column</option>
            </Select>
          </Field>
          <Button
            size="icon"
            variant="ghost"
            className="mb-0.5"
            disabled={isNew}
            title="Swap which side references the other"
            onClick={swap}
          >
            <ArrowLeftRight className="size-4" />
          </Button>
          <Field label={<>References {parent.name}</>}>
            <Select
              selectClassName="h-7 font-mono text-xs"
              value={parentColumn}
              onChange={(e) => {
                setParentColumn(e.target.value)
                const type = parent.columns.find((c) => c.name === e.target.value)?.dataType
                if (type) setNewType(referencingType(dialect, type))
              }}
            >
              {parent.columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.dataType}){isKeyColumn(parent, c.name) ? ' · key' : ''}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {isNew && (
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3 rounded-lg border border-line bg-panel/50 p-3">
            <Field label="New column name">
              <Input
                mono
                className="h-7 text-xs"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </Field>
            <Field label="Type">
              <Input
                mono
                className="h-7 text-xs"
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
              />
            </Field>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                className="size-3.5 accent-accent"
                checked={nullable}
                onChange={(e) => setNullable(e.target.checked)}
              />
              Nullable
            </label>
          </div>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_9rem_9rem] items-end gap-3">
          <Field label="Constraint name">
            <Input
              mono
              className="h-7 text-xs"
              value={name}
              placeholder={`fk_${child.name}_${childColumn}`}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="On delete">
            <Select
              selectClassName="h-7 text-xs"
              value={onDelete}
              onChange={(e) => setOnDelete(e.target.value as ForeignKeyAction)}
            >
              {actions.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
          </Field>
          <Field label="On update">
            <Select
              selectClassName="h-7 text-xs"
              value={onUpdate}
              onChange={(e) => setOnUpdate(e.target.value as ForeignKeyAction)}
            >
              {actions.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </Select>
          </Field>
        </div>
        {canIndex && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              className="size-3.5 accent-accent"
              checked={index}
              onChange={(e) => setIndex(e.target.checked)}
            />
            Index {childColumn || 'the column'} too, for fast joins and deletes on {parent.name}
          </label>
        )}
        {warnings.length > 1 && (
          <ul className="space-y-1 text-xs text-warn">
            {warnings.map((w) => (
              <li key={w} className="flex gap-1.5">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                {w}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
            <ErrorText error={error} />
          </div>
        )}
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted">SQL</div>
          {loaded.isError ? (
            <ErrorText error={loaded.error} />
          ) : !loaded.data ? (
            <div className="flex justify-center py-4">
              <Spinner className="size-4" />
            </div>
          ) : (
            <pre
              className={cn(
                'max-h-48 overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-[11.5px] whitespace-pre-wrap text-fg',
                !script && 'text-faint'
              )}
            >
              {script || problem || 'Nothing to change'}
            </pre>
          )}
        </div>
      </div>
    </Modal>
  )
}
