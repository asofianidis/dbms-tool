import { describe, expect, it } from 'vitest'
import { EXAMPLE_NAME, exampleDashboard, exampleWidgets } from '../dashboard-example'
import { parseShell } from '../mongo-shell'

describe('example dashboard', () => {
  it('starts locked and uses every widget kind', () => {
    const example = exampleDashboard('postgres')
    expect(example).toMatchObject({ name: EXAMPLE_NAME, locked: true })
    expect(new Set(example.widgets.map((w) => w.kind))).toEqual(
      new Set(['stat', 'bar', 'line', 'table'])
    )
  })

  it('gives each widget a fresh id', () => {
    const ids = [...exampleWidgets('mysql'), ...exampleWidgets('mysql')].map((w) => w.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('parses as read-only aggregates fed by $documents in the shell', () => {
    for (const w of exampleWidgets('mongo')) {
      const ops = parseShell(w.query, 'test')
      expect(ops).toHaveLength(1)
      const op = ops[0]
      if (op.kind !== 'request' || op.request.op !== 'aggregate') throw new Error(w.title)
      expect(op.request.collection).toBe('')
      expect(Object.keys(op.request.pipeline[0] as object)).toEqual(['$documents'])
    }
  })

  it('names the columns each chart plots', () => {
    for (const w of exampleWidgets('postgres')) {
      if (w.kind === 'table') continue
      for (const column of [w.x, ...w.y].filter(Boolean)) expect(w.query).toContain(`${column}`)
    }
  })
})
