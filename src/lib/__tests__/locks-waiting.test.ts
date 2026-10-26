import { describe, expect, it } from 'vitest'
import type { Cell } from '../api'
import { waitingLocks } from '../../features/server/PerformancePanels'

const set = (column: string, values: Cell[]) => ({
  columns: [
    { name: 'pid', typeName: 'int4' },
    { name: column, typeName: 'text' }
  ],
  rows: values.map((v, i): Cell[] => [String(i), v])
})

describe('waiting lock count', () => {
  it('counts ungranted PostgreSQL locks, as booleans or text', () => {
    expect(waitingLocks(set('granted', [true, true, false, true]))).toBe(1)
    expect(waitingLocks(set('granted', ['t', 'f', 'false', 'true']))).toBe(2)
  })

  it('reads MySQL and SQL Server lock statuses', () => {
    expect(waitingLocks(set('status', ['GRANTED', 'WAITING', 'GRANTED']))).toBe(1)
    expect(waitingLocks(set('status', ['GRANT', 'WAIT', 'CONVERT', 'WAIT']))).toBe(2)
  })

  it('counts MongoDB operations waiting for a lock', () => {
    expect(waitingLocks(set('waitingForLock', [false, true, null, 'true']))).toBe(2)
  })

  it('is zero without a lock list or a status column', () => {
    expect(waitingLocks(null)).toBe(0)
    expect(waitingLocks(set('mode', ['false', 'WAIT']))).toBe(0)
  })
})
