import { describe, expect, it } from 'vitest'
import {
  collectionNameError,
  createCommand,
  emptyCollection,
  readValidation,
  renameCommand,
  schemaFromSample,
  validationCommand
} from '../mongo-collections'

describe('create collection', () => {
  it('creates a plain collection with a validator', () => {
    expect(
      createCommand({
        ...emptyCollection('users'),
        validator: "{ $jsonSchema: { required: ['email'] } }",
        validationAction: 'warn'
      })
    ).toEqual({
      create: 'users',
      validator: { $jsonSchema: { required: ['email'] } },
      validationLevel: 'strict',
      validationAction: 'warn'
    })
  })

  it('creates capped and time series collections', () => {
    expect(
      createCommand({ ...emptyCollection('log'), kind: 'capped', size: '1048576', max: '1000' })
    ).toEqual({ create: 'log', capped: true, size: 1048576, max: 1000 })
    expect(
      createCommand({
        ...emptyCollection('metrics'),
        kind: 'timeseries',
        timeField: 'ts',
        metaField: 'sensor',
        granularity: 'minutes',
        expireAfterSeconds: '86400'
      })
    ).toEqual({
      create: 'metrics',
      timeseries: { timeField: 'ts', metaField: 'sensor', granularity: 'minutes' },
      expireAfterSeconds: 86400
    })
  })

  it('creates views without validation options', () => {
    expect(
      createCommand({
        ...emptyCollection('active_users'),
        kind: 'view',
        viewOn: 'users',
        pipeline: '[{ $match: { active: true } }]',
        validator: '{ a: 1 }'
      })
    ).toEqual({ create: 'active_users', viewOn: 'users', pipeline: [{ $match: { active: true } }] })
  })

  it('explains invalid input', () => {
    expect(() => createCommand({ ...emptyCollection('log'), kind: 'capped' })).toThrow(/Size/)
    expect(() => createCommand({ ...emptyCollection('m'), kind: 'timeseries' })).toThrow(
      /time field/
    )
    expect(() =>
      createCommand({ ...emptyCollection('v'), kind: 'view', viewOn: 'u', pipeline: '{}' })
    ).toThrow(/array/)
    expect(() => createCommand({ ...emptyCollection('u'), validator: '[1]' })).toThrow(/document/)
    expect(collectionNameError('system.x')).toMatch(/reserved/)
    expect(collectionNameError('a$b')).toMatch(/\$/)
    expect(collectionNameError('orders')).toBeNull()
  })
})

describe('validation and rename', () => {
  it('reads rules from listCollections', () => {
    expect(
      readValidation({
        name: 'users',
        options: { validator: { a: 1 }, validationLevel: 'moderate', validationAction: 'warn' }
      })
    ).toEqual({ validator: { a: 1 }, level: 'moderate', action: 'warn' })
    expect(readValidation({ name: 'users', options: {} })).toEqual({
      validator: null,
      level: 'strict',
      action: 'error'
    })
  })

  it('replaces or removes rules with collMod', () => {
    expect(validationCommand('users', '{ a: 1 }', 'strict', 'error')).toEqual({
      collMod: 'users',
      validator: { a: 1 },
      validationLevel: 'strict',
      validationAction: 'error'
    })
    expect(validationCommand('users', '  ', 'off', 'warn').validator).toEqual({})
  })

  it('renames within the database', () => {
    expect(renameCommand('shop', 'orders', 'orders_old')).toEqual({
      renameCollection: 'shop.orders',
      to: 'shop.orders_old',
      dropTarget: false
    })
    expect(() => renameCommand('shop', 'orders', '')).toThrow()
  })
})

describe('schema from sample', () => {
  it('types fields and marks the ones every document has as required', () => {
    const schema = schemaFromSample([
      {
        _id: { $oid: '65a1b2c3d4e5f60718293a4b' },
        name: 'a',
        age: 3,
        tags: ['x'],
        address: { city: 'X' }
      },
      {
        _id: { $oid: '65a1b2c3d4e5f60718293a4c' },
        name: 'b',
        age: 3.5,
        nick: null,
        address: { city: 'Y', zip: '1' }
      }
    ])
    expect(schema).toEqual({
      bsonType: 'object',
      required: ['_id', 'name', 'age', 'address'],
      properties: {
        _id: { bsonType: 'objectId' },
        name: { bsonType: 'string' },
        age: { bsonType: 'number' },
        tags: { bsonType: 'array', items: { bsonType: 'string' } },
        address: {
          bsonType: 'object',
          required: ['city'],
          properties: { city: { bsonType: 'string' }, zip: { bsonType: 'string' } }
        },
        nick: { bsonType: 'null' }
      }
    })
  })
})
