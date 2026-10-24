import { describe, expect, it } from 'vitest'
import {
  commandScript,
  parsePrivilegeText,
  parseRolesInfo,
  parseUsersInfo,
  roleCommands,
  roleMemberCommands,
  sortPrincipals,
  userCommands,
  validateRole,
  validateUser,
  type MongoRole,
  type MongoUser
} from '../mongo-users'
import { describeMongoDanger, mongoIsWrite } from '../production'

const user: MongoUser = {
  user: 'app',
  db: 'admin',
  roles: [{ role: 'readWrite', db: 'shop' }],
  mechanisms: ['SCRAM-SHA-256']
}

const role: MongoRole = {
  role: 'reporting',
  db: 'shop',
  builtin: false,
  roles: [{ role: 'read', db: 'shop' }],
  privileges: [{ resource: { db: 'shop', collection: 'orders' }, actions: ['find'] }]
}

describe('MongoDB users', () => {
  it('reads usersInfo and rolesInfo replies', () => {
    expect(
      parseUsersInfo({
        users: [
          {
            _id: 'admin.app',
            user: 'app',
            db: 'admin',
            roles: [{ role: 'readWrite', db: 'shop' }],
            mechanisms: ['SCRAM-SHA-256']
          }
        ],
        ok: 1
      })
    ).toEqual([user])
    expect(parseRolesInfo({ roles: [{ ...role, isBuiltin: false, inheritedRoles: [] }] })).toEqual([
      role
    ])
  })

  it('creates a user with its roles, and hides the password when asked', () => {
    const draft = { name: 'app', db: 'admin', password: 'pw', roles: user.roles, original: null }
    expect(userCommands(draft)).toEqual([
      {
        database: 'admin',
        command: { createUser: 'app', pwd: 'pw', roles: [{ role: 'readWrite', db: 'shop' }] }
      }
    ])
    expect(commandScript(userCommands(draft, true))).toContain('"pwd": "********"')
  })

  it('updates only what changed', () => {
    const same = { name: 'app', db: 'admin', password: '', roles: user.roles, original: user }
    expect(userCommands(same)).toEqual([])
    const roles = [...user.roles, { role: 'read', db: 'logs' }]
    expect(userCommands({ ...same, roles })).toEqual([
      { database: 'admin', command: { updateUser: 'app', roles } }
    ])
    expect(userCommands({ ...same, password: 'new' })).toEqual([
      { database: 'admin', command: { updateUser: 'app', pwd: 'new' } }
    ])
  })

  it('needs a password for new users', () => {
    expect(validateUser({ name: 'a', db: 'admin', password: '', roles: [], original: null })).toBe(
      'Enter a password'
    )
    expect(validateUser({ name: 'a', db: 'admin', password: '', roles: [], original: user })).toBe(
      null
    )
  })
})

describe('MongoDB roles', () => {
  it('creates a role and updates its privileges and inherited roles', () => {
    const privileges = JSON.stringify(role.privileges)
    expect(
      roleCommands({ name: 'reporting', db: 'shop', roles: [], privileges, original: null })
    ).toEqual([
      {
        database: 'shop',
        command: { createRole: 'reporting', privileges: role.privileges, roles: [] }
      }
    ])
    const same = { name: 'reporting', db: 'shop', roles: role.roles, privileges, original: role }
    expect(roleCommands(same)).toEqual([])
    expect(roleCommands({ ...same, roles: [] })).toEqual([
      { database: 'shop', command: { updateRole: 'reporting', roles: [] } }
    ])
  })

  it('validates the privileges JSON', () => {
    expect(parsePrivilegeText('')).toEqual([])
    expect(parsePrivilegeText('{')).toMatch(/valid JSON/)
    expect(parsePrivilegeText('{}')).toMatch(/array/)
    expect(parsePrivilegeText('[{"resource": {"db": ""}, "actions": []}]')).toMatch(/action/)
    expect(
      validateRole({ name: 'r', db: 'shop', roles: [], privileges: '[]', original: null })
    ).toBe(null)
  })

  it('grants the role to new members and revokes it from those removed', () => {
    const other: MongoUser = { ...user, user: 'bi', db: 'shop', roles: [] }
    const ref = { role: 'reporting', db: 'shop' }
    expect(
      roleMemberCommands(ref, [user, other], new Set(['app@admin']), new Set(['bi@shop']))
    ).toEqual([
      { database: 'admin', command: { revokeRolesFromUser: 'app', roles: [ref] } },
      { database: 'shop', command: { grantRolesToUser: 'bi', roles: [ref] } }
    ])
  })

  it('lists users before roles', () => {
    expect(
      sortPrincipals([
        { kind: 'role', name: 'a', db: 'admin' },
        { kind: 'user', name: 'z', db: 'shop' },
        { kind: 'user', name: 'b', db: 'admin' }
      ]).map((p) => p.name)
    ).toEqual(['b', 'z', 'a'])
  })
})

describe('MongoDB user commands and the write guards', () => {
  it('reads users and roles without counting as a write', () => {
    const run = (command: object) => ({ op: 'runCommand' as const, database: 'admin', command })
    expect(mongoIsWrite(run({ usersInfo: { forAllDBs: true } }))).toBe(false)
    expect(mongoIsWrite(run({ rolesInfo: 1 }))).toBe(false)
    expect(mongoIsWrite(run({ createUser: 'a', pwd: 'b', roles: [] }))).toBe(true)
    expect(describeMongoDanger(run({ dropUser: 'app' }))).toMatch(/app@admin/)
    expect(describeMongoDanger(run({ grantRolesToUser: 'app', roles: [] }))).toBe(null)
  })
})
