import { describe, expect, it } from 'vitest'
import {
  allFolders,
  findByName,
  matchesSearch,
  parseTags,
  queryKindOf,
  renameFolder,
  sortQueries,
  splitFolder,
  upsertQuery,
  type SavedQuery
} from '../saved'

function query(patch: Partial<SavedQuery>): SavedQuery {
  return {
    id: 'q1',
    name: 'Users',
    text: 'select * from users',
    kind: 'sql',
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

describe('saved queries', () => {
  it('adds a new query with a fresh id', () => {
    const { list, saved } = upsertQuery([], { name: '  Users ', text: 'select 1', kind: 'sql' }, 5)
    expect(list).toEqual([saved])
    expect(saved).toMatchObject({ name: 'Users', text: 'select 1', createdAt: 5, updatedAt: 5 })
    expect(saved.id).toBeTruthy()
  })

  it('updates text in place and keeps the creation time', () => {
    const existing = query({ lastRunAt: 3 })
    const other = query({ id: 'q2', name: 'Orders' })
    const { list, saved } = upsertQuery(
      [existing, other],
      { id: 'q1', name: 'Users', text: 'select 2', kind: 'sql' },
      9
    )
    expect(list).toHaveLength(2)
    expect(list[0]).toBe(saved)
    expect(saved).toMatchObject({
      id: 'q1',
      text: 'select 2',
      createdAt: 1,
      updatedAt: 9,
      lastRunAt: 3
    })
    expect(list[1]).toBe(other)
  })

  it('matches names case-insensitively within a kind', () => {
    const list = [query({}), query({ id: 'm1', kind: 'mongo', name: 'Orders' })]
    expect(findByName(list, ' users ', 'sql')?.id).toBe('q1')
    expect(findByName(list, 'orders', 'sql')).toBeUndefined()
    expect(findByName(list, 'ORDERS', 'mongo')?.id).toBe('m1')
  })

  it('sorts by name ignoring case', () => {
    const sorted = sortQueries([
      query({ id: 'a', name: 'beta' }),
      query({ id: 'b', name: 'Alpha' }),
      query({ id: 'c', name: 'gamma' })
    ])
    expect(sorted.map((q) => q.name)).toEqual(['Alpha', 'beta', 'gamma'])
  })

  it('groups engines into SQL and MongoDB queries', () => {
    expect(queryKindOf('postgres')).toBe('sql')
    expect(queryKindOf('babelfish')).toBe('sql')
    expect(queryKindOf('mongo')).toBe('mongo')
  })
})

describe('saved query folders and tags', () => {
  it('splits a folder path off the name', () => {
    expect(splitFolder('Reports / Daily/ Active users ')).toEqual({
      folder: 'Reports/Daily',
      name: 'Active users'
    })
    expect(splitFolder('Users')).toEqual({ folder: '', name: 'Users' })
  })

  it('reads tags from commas, spaces and hashes', () => {
    expect(parseTags('Billing, #daily  billing ops')).toEqual(['billing', 'daily', 'ops'])
  })

  it('lists folders with their parents', () => {
    const list = [query({ folder: 'Reports/Daily' }), query({ id: 'q2', folder: 'Ops' })]
    expect(allFolders(list)).toEqual(['Ops', 'Reports', 'Reports/Daily'])
  })

  it('searches by words, #tags and @folders', () => {
    const q = query({ tags: ['billing'], folder: 'Reports/Daily' })
    expect(matchesSearch(q, 'users')).toBe(true)
    expect(matchesSearch(q, '#bill users')).toBe(true)
    expect(matchesSearch(q, '#ops')).toBe(false)
    expect(matchesSearch(q, '@reports')).toBe(true)
    expect(matchesSearch(q, '@report')).toBe(false)
  })

  it('renames a folder and the folders inside it', () => {
    const list = renameFolder(
      [
        query({ folder: 'Reports' }),
        query({ id: 'q2', folder: 'Reports/Daily' }),
        query({ id: 'q3', folder: 'Reporting' })
      ],
      'Reports',
      'Archive'
    )
    expect(list.map((q) => q.folder)).toEqual(['Archive', 'Archive/Daily', 'Reporting'])
    expect(renameFolder([query({ folder: 'A/B' })], 'A', '')[0].folder).toBe('B')
  })

  it('keeps a folder only when one is given', () => {
    const { saved } = upsertQuery([], { name: 'x', text: 'y', kind: 'sql', folder: 'Ops' }, 1)
    expect(saved.folder).toBe('Ops')
    const updated = upsertQuery([saved], { id: saved.id, name: 'x', text: 'z', kind: 'sql' }, 2)
    expect(updated.saved.folder).toBe('Ops')
  })
})
