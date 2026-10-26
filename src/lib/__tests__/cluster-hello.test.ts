import { describe, expect, it } from 'vitest'
import { helloMembers } from '../../features/mongo/ClusterPanel'

describe('replica set members from hello alone', () => {
  it("claims nothing about members it can't see", () => {
    const members = helloMembers({
      setName: 'rs0',
      hosts: ['a:27017', 'b:27017', 'c:27017'],
      passives: ['d:27017'],
      arbiters: ['e:27017'],
      primary: 'a:27017',
      me: 'b:27017',
      secondary: true,
      isWritablePrimary: false
    })
    expect(members.map((m) => [m.name, m.state, m.health, m.self])).toEqual([
      ['a:27017', 'PRIMARY', null, false],
      ['b:27017', 'SECONDARY', true, true],
      ['c:27017', 'UNKNOWN', null, false],
      ['d:27017', 'UNKNOWN', null, false],
      ['e:27017', 'ARBITER', null, false]
    ])
  })

  it('takes the connected primary state from hello', () => {
    const members = helloMembers({
      hosts: ['a:27017', 'b:27017'],
      primary: 'a:27017',
      me: 'a:27017',
      isWritablePrimary: true
    })
    expect(members[0]).toMatchObject({ state: 'PRIMARY', health: true, self: true })
    expect(members[1]).toMatchObject({ state: 'UNKNOWN', health: null })
  })
})
