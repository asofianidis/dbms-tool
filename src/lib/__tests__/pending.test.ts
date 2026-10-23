import { describe, expect, it } from 'vitest'
import {
  addInsert,
  deleteRow,
  editInsert,
  editRow,
  removeChange,
  removeColumn,
  rowKeyOf,
  setValue,
  toRowEdits,
  type PendingChange
} from '../pending'

const pk = ['id']
const row1 = { id: '1', name: 'a', note: null }
const row2 = { id: '2', name: 'b', note: 'x' }

describe('pending changes', () => {
  it('collects edits to one row into a single update', () => {
    let changes: PendingChange[] = []
    changes = editRow(changes, pk, row1, 'name', 'A')
    changes = editRow(changes, pk, row1, 'note', 'n')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      kind: 'update',
      rowKey: rowKeyOf(pk, row1),
      values: { name: 'A', note: 'n' }
    })
  })

  it('drops an update once every column is back to its loaded value', () => {
    let changes = editRow([], pk, row1, 'name', 'A')
    changes = editRow(changes, pk, row1, 'name', 'a')
    expect(changes).toEqual([])
  })

  it('replaces an update with a delete and ignores later edits to the row', () => {
    let changes = editRow([], pk, row2, 'name', 'B')
    changes = deleteRow(changes, pk, row2)
    changes = editRow(changes, pk, row2, 'name', 'C')
    expect(changes.map((c) => c.kind)).toEqual(['delete'])
  })

  it('leaves NULL insert columns out so defaults apply', () => {
    let changes = addInsert([])
    const id = changes[0].id
    changes = editInsert(changes, id, 'name', 'new')
    changes = editInsert(changes, id, 'note', 'x')
    changes = editInsert(changes, id, 'note', null)
    expect(changes[0].values).toEqual({ name: 'new' })
  })

  it('removes single columns and whole changes', () => {
    let changes = editRow([], pk, row1, 'name', 'A')
    changes = editRow(changes, pk, row1, 'note', 'n')
    changes = deleteRow(changes, pk, row2)
    const update = changes[0].id
    changes = removeColumn(changes, update, 'name')
    expect(changes[0].values).toEqual({ note: 'n' })
    changes = removeColumn(changes, update, 'note')
    expect(changes.map((c) => c.kind)).toEqual(['delete'])
    changes = removeChange(changes, changes[0].id)
    expect(changes).toEqual([])
  })

  it('edits a pending value in place, even back to the loaded value', () => {
    let changes = editRow([], pk, row1, 'name', 'A')
    changes = setValue(changes, changes[0].id, 'name', 'a')
    expect(changes[0].values).toEqual({ name: 'a' })
  })

  it('orders row edits deletes, updates, then inserts', () => {
    let changes = addInsert([])
    changes = editRow(changes, pk, row1, 'name', 'A')
    changes = deleteRow(changes, pk, row2)
    expect(toRowEdits(changes).map((e) => e.kind)).toEqual(['delete', 'update', 'insert'])
    expect(toRowEdits(changes)[1]).toEqual({
      kind: 'update',
      original: row1,
      values: { name: 'A' }
    })
  })
})
