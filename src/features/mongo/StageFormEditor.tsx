import type { ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import {
  ACCUMULATORS,
  MATCH_OPS,
  type GroupOutput,
  type MatchCondition,
  type MatchOp,
  type StageForm
} from '@/lib/aggregation'
import { cn } from '@/lib/cn'
import { Button, Input, Segmented, Select, Switch } from '@/components/ui'

type FormOf<K extends StageForm['kind']> = Extract<StageForm, { kind: K }>

/** Datalist ids for the field pickers of one stage. */
export interface FieldLists {
  /** Field paths: `status`, `address.city` */
  fields: string
  /** Field references for expressions: `$status` */
  refs: string
  collections: string
}

function Row({
  children,
  onRemove
}: {
  children: ReactNode
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      {children}
      <Button size="icon-sm" variant="ghost" title="Remove" onClick={onRemove}>
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <Button size="xs" variant="ghost" onClick={onClick} className="self-start">
      <Plus className="size-3" /> {label}
    </Button>
  )
}

function Label({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="w-24 shrink-0 text-[11px] text-muted">{children}</span>
}

function TextBox({
  value,
  onChange,
  list,
  placeholder,
  className,
  type
}: {
  value: string
  onChange: (value: string) => void
  list?: string
  placeholder?: string
  className?: string
  type?: string
}): React.JSX.Element {
  return (
    <Input
      mono
      type={type}
      list={list}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cn('h-7', className)}
    />
  )
}

const replace = <T,>(list: T[], i: number, patch: Partial<T>): T[] =>
  list.map((item, j) => (j === i ? { ...item, ...patch } : item))
const without = <T,>(list: T[], i: number): T[] => list.filter((_, j) => j !== i)

function MatchForm({
  form,
  lists,
  onChange
}: {
  form: FormOf<'match'>
  lists: FieldLists
  onChange: (form: StageForm) => void
}): React.JSX.Element {
  const set = (conditions: MatchCondition[]): void => onChange({ ...form, conditions })
  return (
    <>
      <div className="flex items-center gap-2 text-[11px] text-muted">
        Documents matching
        <Segmented
          size="sm"
          value={form.combine}
          onChange={(combine) => onChange({ ...form, combine })}
          options={[
            { value: 'and', label: 'all' },
            { value: 'or', label: 'any' }
          ]}
        />
        of these conditions
      </div>
      {form.conditions.map((c, i) => (
        <Row key={i} onRemove={() => set(without(form.conditions, i))}>
          <TextBox
            value={c.field}
            onChange={(field) => set(replace(form.conditions, i, { field }))}
            list={lists.fields}
            placeholder="field"
            className="w-44"
          />
          <Select
            value={c.op}
            onChange={(e) => {
              const op = e.target.value as MatchOp
              set(
                replace(form.conditions, i, { op, ...(op === 'exists' ? { value: 'true' } : {}) })
              )
            }}
            className="w-32"
            selectClassName="h-7 text-xs"
          >
            {MATCH_OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {c.op === 'exists' ? (
            <Select
              value={c.value.trim() === 'false' ? 'false' : 'true'}
              onChange={(e) => set(replace(form.conditions, i, { value: e.target.value }))}
              className="flex-1"
              selectClassName="h-7 text-xs"
            >
              <option value="true">yes</option>
              <option value="false">no</option>
            </Select>
          ) : (
            <TextBox
              value={c.value}
              onChange={(value) => set(replace(form.conditions, i, { value }))}
              placeholder={
                c.op === 'in' || c.op === 'nin'
                  ? 'a, b, 3'
                  : c.op === 'regex'
                    ? '^pattern'
                    : "value, 42, ObjectId('…')"
              }
            />
          )}
          {c.op === 'regex' && (
            <label
              className="flex items-center gap-1 text-[11px] text-muted"
              title="Case-insensitive"
            >
              <Switch
                checked={(c.options ?? '').includes('i')}
                onChange={(on) =>
                  set(
                    replace(form.conditions, i, {
                      options: on ? `${c.options ?? ''}i` : (c.options ?? '').replace(/i/g, '')
                    })
                  )
                }
                label="Ignore case"
              />
              Aa
            </label>
          )}
        </Row>
      ))}
      <AddButton
        label="Condition"
        onClick={() => set([...form.conditions, { field: '', op: 'eq', value: '' }])}
      />
    </>
  )
}

function GroupForm({
  form,
  lists,
  onChange
}: {
  form: FormOf<'group'>
  lists: FieldLists
  onChange: (form: StageForm) => void
}): React.JSX.Element {
  const setOutputs = (outputs: GroupOutput[]): void => onChange({ ...form, outputs })
  return (
    <>
      <div className="text-[11px] font-medium text-muted">Group by</div>
      {form.keys.map((k, i) => (
        <Row key={i} onRemove={() => onChange({ ...form, keys: without(form.keys, i) })}>
          <TextBox
            value={k.field}
            onChange={(field) => onChange({ ...form, keys: replace(form.keys, i, { field }) })}
            list={lists.fields}
            placeholder="field"
            className="w-48"
          />
          <span className="text-[11px] text-faint">as</span>
          <TextBox
            value={k.alias}
            onChange={(alias) => onChange({ ...form, keys: replace(form.keys, i, { alias }) })}
            placeholder={form.keys.length > 1 ? k.field.replace(/\./g, '_') : '_id'}
          />
        </Row>
      ))}
      {!form.keys.length && (
        <p className="text-[11px] text-faint">Everything in one group (_id: null)</p>
      )}
      <AddButton
        label="Group key"
        onClick={() => onChange({ ...form, keys: [...form.keys, { alias: '', field: '' }] })}
      />
      <div className="pt-1 text-[11px] font-medium text-muted">Output fields</div>
      {form.outputs.map((o, i) => (
        <Row key={i} onRemove={() => setOutputs(without(form.outputs, i))}>
          <TextBox
            value={o.name}
            onChange={(name) => setOutputs(replace(form.outputs, i, { name }))}
            placeholder="name"
            className="w-36"
          />
          <span className="text-[11px] text-faint">=</span>
          <Select
            value={o.op}
            onChange={(e) =>
              setOutputs(replace(form.outputs, i, { op: e.target.value as GroupOutput['op'] }))
            }
            className="w-32"
            selectClassName="h-7 font-mono text-xs"
          >
            {ACCUMULATORS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
          {o.op !== '$count' && (
            <TextBox
              value={o.expr}
              onChange={(expr) => setOutputs(replace(form.outputs, i, { expr }))}
              list={lists.refs}
              placeholder={o.op === '$sum' ? "1 or '$field'" : '$field'}
            />
          )}
        </Row>
      ))}
      <AddButton
        label="Output field"
        onClick={() => setOutputs([...form.outputs, { name: '', op: '$sum', expr: '' }])}
      />
    </>
  )
}

/** Form body for one aggregation stage. */
export function StageFormEditor({
  form,
  lists,
  onChange
}: {
  form: StageForm
  lists: FieldLists
  onChange: (form: StageForm) => void
}): React.JSX.Element {
  let body: ReactNode
  switch (form.kind) {
    case 'match':
      body = <MatchForm form={form} lists={lists} onChange={onChange} />
      break
    case 'group':
      body = <GroupForm form={form} lists={lists} onChange={onChange} />
      break
    case 'project':
      body = (
        <>
          {form.fields.map((f, i) => (
            <Row key={i} onRemove={() => onChange({ ...form, fields: without(form.fields, i) })}>
              <TextBox
                value={f.field}
                onChange={(field) =>
                  onChange({ ...form, fields: replace(form.fields, i, { field }) })
                }
                list={lists.fields}
                placeholder="field"
                className="w-44"
              />
              <Segmented
                size="sm"
                value={f.kind}
                onChange={(kind) =>
                  onChange({ ...form, fields: replace(form.fields, i, { kind }) })
                }
                options={[
                  { value: 'include', label: 'Include' },
                  { value: 'exclude', label: 'Exclude' },
                  { value: 'expr', label: 'Compute' }
                ]}
              />
              {f.kind === 'expr' && (
                <TextBox
                  value={f.expr}
                  onChange={(expr) =>
                    onChange({ ...form, fields: replace(form.fields, i, { expr }) })
                  }
                  list={lists.refs}
                  placeholder="'$other' or { $toUpper: '$name' }"
                />
              )}
            </Row>
          ))}
          <AddButton
            label="Field"
            onClick={() =>
              onChange({
                ...form,
                fields: [...form.fields, { field: '', kind: 'include', expr: '' }]
              })
            }
          />
        </>
      )
      break
    case 'addFields':
      body = (
        <>
          {form.fields.map((f, i) => (
            <Row key={i} onRemove={() => onChange({ ...form, fields: without(form.fields, i) })}>
              <TextBox
                value={f.field}
                onChange={(field) =>
                  onChange({ ...form, fields: replace(form.fields, i, { field }) })
                }
                list={lists.fields}
                placeholder="new field"
                className="w-44"
              />
              <span className="text-[11px] text-faint">=</span>
              <TextBox
                value={f.expr}
                onChange={(expr) =>
                  onChange({ ...form, fields: replace(form.fields, i, { expr }) })
                }
                list={lists.refs}
                placeholder="{ $multiply: ['$price', '$qty'] }"
              />
            </Row>
          ))}
          <AddButton
            label="Field"
            onClick={() => onChange({ ...form, fields: [...form.fields, { field: '', expr: '' }] })}
          />
        </>
      )
      break
    case 'unset':
      body = (
        <>
          {form.fields.map((f, i) => (
            <Row key={i} onRemove={() => onChange({ ...form, fields: without(form.fields, i) })}>
              <TextBox
                value={f}
                onChange={(v) =>
                  onChange({ ...form, fields: form.fields.map((x, j) => (j === i ? v : x)) })
                }
                list={lists.fields}
                placeholder="field"
              />
            </Row>
          ))}
          <AddButton
            label="Field"
            onClick={() => onChange({ ...form, fields: [...form.fields, ''] })}
          />
        </>
      )
      break
    case 'sort':
      body = (
        <>
          {form.keys.map((k, i) => (
            <Row key={i} onRemove={() => onChange({ ...form, keys: without(form.keys, i) })}>
              <TextBox
                value={k.field}
                onChange={(field) => onChange({ ...form, keys: replace(form.keys, i, { field }) })}
                list={lists.fields}
                placeholder="field"
              />
              <Segmented
                size="sm"
                value={String(k.dir) as '1' | '-1'}
                onChange={(d) =>
                  onChange({ ...form, keys: replace(form.keys, i, { dir: Number(d) as 1 | -1 }) })
                }
                options={[
                  { value: '1', label: 'Ascending' },
                  { value: '-1', label: 'Descending' }
                ]}
              />
            </Row>
          ))}
          <AddButton
            label="Sort key"
            onClick={() => onChange({ ...form, keys: [...form.keys, { field: '', dir: 1 }] })}
          />
        </>
      )
      break
    case 'number':
      body = (
        <div className="flex items-center gap-2">
          <Label>Documents</Label>
          <TextBox
            type="number"
            value={form.value}
            onChange={(value) => onChange({ ...form, value })}
            className="w-32"
          />
        </div>
      )
      break
    case 'sample':
      body = (
        <div className="flex items-center gap-2">
          <Label>Sample size</Label>
          <TextBox
            type="number"
            value={form.size}
            onChange={(size) => onChange({ ...form, size })}
            className="w-32"
          />
        </div>
      )
      break
    case 'name':
      body = (
        <div className="flex items-center gap-2">
          <Label>Name</Label>
          <TextBox
            value={form.value}
            onChange={(value) => onChange({ ...form, value })}
            list={lists.collections}
          />
        </div>
      )
      break
    case 'field':
      body = (
        <div className="flex items-center gap-2">
          <Label>Field</Label>
          <TextBox
            value={form.field}
            onChange={(field) => onChange({ ...form, field })}
            list={lists.fields}
          />
        </div>
      )
      break
    case 'unwind':
      body = (
        <>
          <div className="flex items-center gap-2">
            <Label>Array field</Label>
            <TextBox
              value={form.path}
              onChange={(path) => onChange({ ...form, path })}
              list={lists.fields}
            />
          </div>
          <div className="flex items-center gap-2">
            <Label>Index field</Label>
            <TextBox
              value={form.includeArrayIndex}
              onChange={(includeArrayIndex) => onChange({ ...form, includeArrayIndex })}
              placeholder="optional"
            />
          </div>
          <label className="flex items-center gap-2 text-[11px] text-muted">
            <Switch
              checked={form.preserveNullAndEmptyArrays}
              onChange={(preserveNullAndEmptyArrays) =>
                onChange({ ...form, preserveNullAndEmptyArrays })
              }
            />
            Keep documents where the array is missing or empty
          </label>
        </>
      )
      break
    case 'lookup':
      body = (
        <>
          {(
            [
              ['from', 'From collection', lists.collections],
              ['localField', 'Local field', lists.fields],
              ['foreignField', 'Foreign field', undefined],
              ['as', 'Output array', undefined]
            ] as const
          ).map(([key, label, list]) => (
            <div key={key} className="flex items-center gap-2">
              <Label>{label}</Label>
              <TextBox
                value={form[key]}
                onChange={(v) => onChange({ ...form, [key]: v })}
                list={list}
              />
            </div>
          ))}
        </>
      )
      break
  }
  return <div className="flex flex-col gap-1.5 p-2">{body}</div>
}
