import { describe, expect, it } from 'vitest'
import type { Cell, ResultSet } from '../api'
import {
  createPublicationSql,
  createSubscriptionSql,
  dropPublicationSql,
  maskConninfo,
  parsePublicationDetails,
  parsePublications,
  parseSubscriptionDetails,
  parseSubscriptions,
  publicationDetailsSql,
  refreshSubscriptionSql,
  setSubscriptionEnabledSql,
  subscriptionDetailsSql,
  SUBSCRIPTIONS_SQL,
  type Publication,
  type Subscription
} from '../pg-logical'

const set = (rows: Cell[][]): ResultSet => ({
  columns: (rows[0] ?? []).map((_, i) => ({ name: `c${i}`, typeName: 'text' })),
  rows,
  rowCount: rows.length,
  truncated: false
})

const pub = (over: Partial<Publication> = {}): Publication => ({
  name: 'orders_pub',
  owner: 'postgres',
  allTables: false,
  operations: ['insert', 'update', 'delete', 'truncate'],
  viaRoot: false,
  tableCount: 2,
  comment: null,
  ...over
})

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  name: 'orders_sub',
  owner: 'postgres',
  enabled: true,
  publications: ['orders_pub'],
  conninfo: 'host=pub dbname=app user=repl password=********',
  slotName: 'orders_sub',
  synchronousCommit: 'off',
  comment: null,
  ...over
})

describe('publications', () => {
  it('parses the listing', () => {
    expect(
      parsePublications([
        ['all_pub', 'postgres', 't', 't', 't', 'f', 'f', 'f', '2', null],
        ['orders_pub', 'postgres', false, true, true, true, true, true, '1', 'Orders']
      ])
    ).toEqual([
      pub({ name: 'all_pub', allTables: true, operations: ['insert', 'update'], tableCount: 2 }),
      pub({ viaRoot: true, tableCount: 1, comment: 'Orders' })
    ])
  })

  it('reads column lists and row filters only on PG 15+', () => {
    expect(publicationDetailsSql('p', 150000)).toContain('pg_publication_namespace')
    expect(publicationDetailsSql('p', 150000)).toContain('t.rowfilter')
    expect(publicationDetailsSql('p', 140000)).not.toContain('prattrs')
    expect(publicationDetailsSql('p', 140000)).not.toContain('pg_publication_namespace')
    expect(publicationDetailsSql("o'p", 170000)).toContain("pubname = 'o''p'")
  })

  it('scripts CREATE with tables, column lists, row filters and schemas', () => {
    const details = parsePublicationDetails(pub({ operations: ['insert', 'update'] }), [
      set([
        ['public', 'customers', null, null],
        ['public', 'orders', 'id, customer, total', '(total > (50)::numeric)']
      ]),
      set([
        ['public', 'customers', null, null],
        ['public', 'orders', 'id, customer, total', '(total > (50)::numeric)']
      ]),
      set([['Sales']])
    ])
    expect(details.tables[1].columns).toEqual(['id', 'customer', 'total'])
    expect(details.tables[0].columns).toBeNull()
    expect(createPublicationSql(details)).toBe(
      `CREATE PUBLICATION orders_pub FOR TABLE public.customers, public.orders (id, customer, total) WHERE ((total > (50)::numeric)), TABLES IN SCHEMA "Sales" WITH (publish = 'insert, update');`
    )
  })

  it('scripts FOR ALL TABLES, an empty publication and a comment', () => {
    const empty = { members: [], schemas: [], tables: [] }
    expect(
      createPublicationSql({ ...empty, publication: pub({ allTables: true, viaRoot: true }) })
    ).toBe(
      `CREATE PUBLICATION orders_pub FOR ALL TABLES WITH (publish = 'insert, update, delete, truncate', publish_via_partition_root = true);`
    )
    expect(createPublicationSql({ ...empty, publication: pub({ comment: "it's" }) })).toBe(
      `CREATE PUBLICATION orders_pub WITH (publish = 'insert, update, delete, truncate');\nCOMMENT ON PUBLICATION orders_pub IS 'it''s';`
    )
    expect(dropPublicationSql('Pub')).toBe('DROP PUBLICATION "Pub";')
  })
})

describe('subscriptions', () => {
  it('falls back to a query without subconninfo', () => {
    expect(SUBSCRIPTIONS_SQL[0]).toContain('s.subconninfo')
    expect(SUBSCRIPTIONS_SQL[1]).not.toContain('subconninfo')
    expect(SUBSCRIPTIONS_SQL[1]).toContain('current_database()')
  })

  it('parses the listing and masks the password', () => {
    const [s] = parseSubscriptions([
      [
        'orders_sub',
        'postgres',
        't',
        'orders_pub,more',
        'host=localhost dbname=pub_db user=postgres password=Dbms_test_pw1',
        'orders_sub',
        'off',
        null
      ]
    ])
    expect(s.publications).toEqual(['orders_pub', 'more'])
    expect(s.conninfo).toBe('host=localhost dbname=pub_db user=postgres password=********')
    expect(parseSubscriptions([['s', null, 'f', '', null, null, 'off', null]])[0]).toMatchObject({
      enabled: false,
      publications: [],
      conninfo: null
    })
  })

  it('masks every form of password', () => {
    expect(maskConninfo("host=a password='se cr\\'et' user=b")).toBe(
      'host=a password=******** user=b'
    )
    expect(maskConninfo('host=a PASSWORD = hunter2')).toBe('host=a PASSWORD = ********')
    expect(maskConninfo('postgresql://repl:hunter2@db.example:5432/app')).toBe(
      'postgresql://repl:********@db.example:5432/app'
    )
    expect(maskConninfo('postgres://db/app?user=a&password=hunter2&sslmode=require')).toBe(
      'postgres://db/app?user=a&password=********&sslmode=require'
    )
    expect(maskConninfo('host=a user=b')).toBe('host=a user=b')
    // A user without a password in a URI
    expect(maskConninfo('postgres://repl@db/app')).toBe('postgres://repl@db/app')
  })

  it('scripts CREATE with the masked password called out', () => {
    expect(createSubscriptionSql(sub())).toBe(
      `-- The password is masked; replace ******** before running
CREATE SUBSCRIPTION orders_sub
  CONNECTION 'host=pub dbname=app user=repl password=********'
  PUBLICATION orders_pub;`
    )
    expect(
      createSubscriptionSql(
        sub({ enabled: false, slotName: 'other', synchronousCommit: 'on', conninfo: null })
      )
    ).toBe(
      `-- The connection string is readable only by superusers; fill it in
CREATE SUBSCRIPTION orders_sub
  CONNECTION 'host=… dbname=… user=… password=…'
  PUBLICATION orders_pub
  WITH (slot_name = 'other', enabled = false, synchronous_commit = 'on');`
    )
    expect(createSubscriptionSql(sub({ slotName: null, conninfo: 'host=a' }))).toContain(
      'WITH (slot_name = NONE, create_slot = false)'
    )
  })

  it('builds ALTER SUBSCRIPTION statements', () => {
    expect(setSubscriptionEnabledSql('Sub', true)).toBe('ALTER SUBSCRIPTION "Sub" ENABLE')
    expect(setSubscriptionEnabledSql('sub', false)).toBe('ALTER SUBSCRIPTION sub DISABLE')
    expect(refreshSubscriptionSql('sub')).toBe('ALTER SUBSCRIPTION sub REFRESH PUBLICATION')
  })

  it('gates worker type and error counts by version', () => {
    expect(subscriptionDetailsSql('s', 170000)).toContain('w.worker_type')
    expect(subscriptionDetailsSql('s', 160000)).not.toContain('worker_type')
    expect(subscriptionDetailsSql('s', 150000)).toContain('pg_stat_subscription_stats')
    expect(subscriptionDetailsSql('s', 140000)).not.toContain('pg_stat_subscription_stats')
  })

  it('parses details', () => {
    const d = parseSubscriptionDetails([
      set([['apply', '111', null, '0/38BA6F0', '0/38BA6F0', '27.4', '0.0001']]),
      set([['customers', 'r', '0/386C000']]),
      set([['0', '2']])
    ])
    expect(d.workers[0]).toMatchObject({ type: 'apply', pid: '111', lastMessage: 27.4 })
    expect(d.tables).toEqual([{ table: 'customers', state: 'r', lsn: '0/386C000' }])
    expect(d).toMatchObject({ applyErrors: 0, syncErrors: 2 })
    expect(parseSubscriptionDetails([set([]), set([]), set([[null, null]])]).applyErrors).toBeNull()
  })
})
