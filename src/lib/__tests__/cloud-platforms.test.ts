import { describe, expect, it } from 'vitest'
import {
  applyCredentials,
  connectionFor,
  newProvisionDraft,
  stepsScript,
  validateProvision,
  withEngine,
  type ProvisionDraft
} from '../cloud'
import {
  cloudflareContexts,
  cloudflareDatabases,
  findNewRailwayService,
  flyContexts,
  flyDatabaseNames,
  flyDatabases,
  flyIdentity,
  flyPassword,
  flyUsers,
  planDelete,
  planProvision,
  railwayContexts,
  railwayCredentials,
  railwayDatabases,
  railwayEngine,
  railwayVariablesQuery,
  renderContexts,
  renderCredentials,
  renderDatabases,
  urlCredentials
} from '../cloud-platforms'

const railwayProjects = JSON.stringify({
  data: {
    projects: {
      edges: [
        {
          node: {
            id: 'p1',
            name: 'shop',
            environments: {
              edges: [
                { node: { id: 'e-prod', name: 'production' } },
                { node: { id: 'e-stage', name: 'staging' } }
              ]
            },
            services: {
              edges: [
                {
                  node: {
                    id: 's-pg',
                    name: 'Postgres',
                    icon: 'https://devicons.railway.com/i/postgresql.svg',
                    serviceInstances: {
                      edges: [
                        {
                          node: {
                            environmentId: 'e-prod',
                            source: { image: 'ghcr.io/railwayapp-templates/postgres-ssl:17' }
                          }
                        },
                        {
                          node: {
                            environmentId: 'e-stage',
                            source: { image: 'ghcr.io/railwayapp-templates/postgres-ssl:17' }
                          }
                        }
                      ]
                    }
                  }
                },
                {
                  node: {
                    id: 's-web',
                    name: 'web',
                    icon: '',
                    serviceInstances: {
                      edges: [{ node: { environmentId: 'e-prod', source: { image: null } } }]
                    }
                  }
                },
                {
                  node: {
                    id: 's-mongo',
                    name: 'MongoDB',
                    icon: '',
                    serviceInstances: {
                      edges: [{ node: { environmentId: 'e-prod', source: { image: 'mongo:8' } } }]
                    }
                  }
                }
              ]
            }
          }
        },
        { node: { id: 'p2', name: 'blog', environments: { edges: [] }, services: { edges: [] } } }
      ]
    }
  }
})

describe('Railway', () => {
  it('lists projects with their environments', () => {
    expect(railwayContexts(railwayProjects)).toEqual([
      { id: 'p2', label: 'blog', isDefault: false, children: [] },
      {
        id: 'p1',
        label: 'shop',
        isDefault: false,
        children: [
          { id: 'e-prod', label: 'production' },
          { id: 'e-stage', label: 'staging' }
        ]
      }
    ])
  })

  it('finds database services per environment by image', () => {
    const dbs = railwayDatabases(railwayProjects, '')
    expect(dbs.map((d) => `${d.name}@${d.location}`)).toEqual([
      'Postgres@shop / production',
      'Postgres@shop / staging',
      'MongoDB@shop / production'
    ])
    expect(dbs[0]).toMatchObject({
      engine: 'postgres',
      product: 'Railway PostgreSQL',
      size: 'postgres-ssl:17',
      endpointOnConnect: true,
      ref: {
        provider: 'railway',
        context: 'p1',
        region: 'e-prod',
        resource: 's-pg',
        kind: 'postgres'
      }
    })
    expect(railwayDatabases(railwayProjects, 'p2')).toEqual([])
    expect(railwayEngine('', '', 'my-mysql')).toBe('mysql')
    expect(railwayEngine('nginx:1', '', 'postgres-proxy')).toBeNull()
  })

  it('surfaces GraphQL errors', () => {
    expect(() =>
      railwayDatabases(JSON.stringify({ errors: [{ message: 'Not Authorized' }] }), '')
    ).toThrow('Not Authorized')
  })

  it('reads public connection details from variables', () => {
    const [pg] = railwayDatabases(railwayProjects, '')
    expect(railwayVariablesQuery(pg.ref)).toBe(
      'query { variables(projectId: "p1", environmentId: "e-prod", serviceId: "s-pg") }'
    )
    const vars = (v: Record<string, string>): string => JSON.stringify({ data: { variables: v } })
    expect(
      railwayCredentials(
        'postgres',
        vars({
          DATABASE_PUBLIC_URL: 'postgresql://postgres:p%40ss@trolley.proxy.rlwy.net:41234/railway'
        })
      )
    ).toEqual({
      host: 'trolley.proxy.rlwy.net',
      port: 41234,
      username: 'postgres',
      password: 'p@ss',
      database: 'railway'
    })
    expect(
      railwayCredentials(
        'mysql',
        vars({
          RAILWAY_TCP_PROXY_DOMAIN: 'x.proxy.rlwy.net',
          RAILWAY_TCP_PROXY_PORT: '5000',
          MYSQLUSER: 'root',
          MYSQLPASSWORD: 'pw',
          MYSQLDATABASE: 'railway'
        })
      )
    ).toEqual({
      host: 'x.proxy.rlwy.net',
      port: 5000,
      username: 'root',
      password: 'pw',
      database: 'railway'
    })
    expect(
      railwayCredentials(
        'mongo',
        vars({ MONGO_PUBLIC_URL: 'mongodb://mongo:secret@h.rlwy.net:1234' })
      )
    ).toEqual({ uri: 'mongodb://mongo@h.rlwy.net:1234', username: 'mongo', password: 'secret' })
    // Only internal addresses: nothing usable from outside Railway
    expect(
      railwayCredentials(
        'postgres',
        vars({ DATABASE_URL: 'postgresql://a:b@postgres.railway.internal/x' })
      )
    ).toEqual({})
  })

  it('connects to MongoDB through the TCP proxy without a public URL', () => {
    const mongo = railwayDatabases(railwayProjects, '')[2]
    const config = connectionFor(mongo)
    expect(config.uri).toBe('')
    const credentials = railwayCredentials(
      'mongo',
      JSON.stringify({
        data: {
          variables: {
            RAILWAY_TCP_PROXY_DOMAIN: 'y.proxy.rlwy.net',
            RAILWAY_TCP_PROXY_PORT: '23456',
            MONGO_INITDB_ROOT_USERNAME: 'mongo',
            MONGO_INITDB_ROOT_PASSWORD: 'pw'
          }
        }
      })
    )
    expect(credentials).toMatchObject({ host: 'y.proxy.rlwy.net', port: 23456, username: 'mongo' })
    applyCredentials(config, credentials)
    expect(config).toMatchObject({ uri: '', host: 'y.proxy.rlwy.net', port: 23456, user: 'mongo' })
    // Plain TCP: TLS isn't forced
    expect(config.ssl).toBe('prefer')

    // A URI saved earlier is pointed at the proxy, keeping its options
    const saved = { ...connectionFor(mongo), uri: 'mongodb://old@:27017/?retryWrites=false' }
    applyCredentials(saved, credentials)
    expect(saved.uri).toBe('mongodb://mongo@y.proxy.rlwy.net:23456/?retryWrites=false')
  })

  it('builds Railway MongoDB URIs without forcing TLS', () => {
    const mongo = { ...railwayDatabases(railwayProjects, '')[2], host: 'h.rlwy.net', port: 1234 }
    expect(connectionFor(mongo).uri).toBe('mongodb://h.rlwy.net:1234/?retryWrites=false')
  })

  it('plans adding a database to an existing project', () => {
    const draft = withEngine({ ...newProvisionDraft('railway', 'p1', 'e-prod') }, 'postgres')
    expect(validateProvision(draft)).toBeNull()
    expect(validateProvision({ ...draft, region: '' })).toMatch(/environment/)
    const plan = planProvision(draft)
    expect(plan.steps.map((s) => s.title)).toEqual([
      'Look up existing services',
      'Link the project',
      'Add PostgreSQL',
      'Find the new service'
    ])
    expect(plan.steps[1].args({})).toEqual(['link', '--project', 'p1', '--environment', 'e-prod'])
    expect(plan.steps[1].workdir).toBe('railway-p1')
    expect(plan.steps[2]).toMatchObject({ workdir: 'railway-p1' })
    expect(plan.steps[2].args({})).toEqual(['add', '--database', 'postgres'])

    const ctx = plan.steps[0].capture!(railwayProjects, {})
    expect(ctx.existing).toBe('s-pg,s-web,s-mongo')
    const after = JSON.parse(railwayProjects)
    after.data.projects.edges[0].node.services.edges.push({
      node: {
        id: 's-pg2',
        name: 'Postgres-Ab12',
        icon: '',
        serviceInstances: {
          edges: [
            {
              node: {
                environmentId: 'e-prod',
                source: { image: 'ghcr.io/railwayapp-templates/postgres-ssl:17' }
              }
            }
          ]
        }
      }
    })
    const found = plan.steps[3].capture!(JSON.stringify(after), ctx)
    expect(found).toEqual({ projectId: 'p1', environmentId: 'e-prod', serviceId: 's-pg2' })
    expect(plan.resolveRef!(found)).toEqual({
      provider: 'railway',
      context: 'p1',
      region: 'e-prod',
      resource: 's-pg2',
      kind: 'postgres'
    })
    expect(() =>
      findNewRailwayService(railwayProjects, ['s-pg', 's-web', 's-mongo'], {
        projectId: 'p1',
        projectName: '',
        environmentId: 'e-prod',
        engine: 'postgres'
      })
    ).toThrow(/new database service/)
  })

  it('creates a new project when none is picked', () => {
    const draft = withEngine({ ...newProvisionDraft('railway', '', ''), name: 'My App' }, 'mongo')
    expect(validateProvision({ ...draft, name: '' })).toMatch(/project name/)
    const plan = planProvision(draft)
    expect(plan.steps[1].args({})).toEqual(['init', '--name', 'My App'])
    expect(plan.steps[1].workdir).toBe('railway-new-My-App')
    expect(plan.steps[2].args({})).toEqual(['add', '--database', 'mongo'])
  })

  it('deletes services through the GraphQL API, only in their environment', () => {
    const [, staging] = railwayDatabases(railwayProjects, '')
    const [step] = planDelete(staging, { finalSnapshot: false, disableProtection: false })
    expect(step.title).toBe('Delete service Postgres in staging')
    expect(step.args({})).toEqual([
      'api',
      'mutation { serviceDelete(id: "s-pg", environmentId: "e-stage") }'
    ])
  })
})

const renderList = [
  {
    cursor: 'c1',
    postgres: {
      id: 'dpg-abc',
      name: 'orders',
      owner: { id: 'tea-1', name: 'Acme', email: 'ops@acme.dev', type: 'team' },
      region: 'frankfurt',
      plan: 'basic_1gb',
      version: '17',
      status: 'available',
      suspended: 'not_suspended',
      databaseName: 'orders_db',
      databaseUser: 'orders_user',
      diskSizeGB: 15,
      ipAllowList: [{ cidrBlock: '0.0.0.0/0', description: 'everywhere' }]
    }
  },
  {
    cursor: 'c2',
    postgres: {
      id: 'dpg-def',
      name: 'analytics',
      owner: { id: 'tea-1' },
      region: 'oregon',
      plan: 'free',
      version: '16',
      status: 'creating',
      suspended: 'not_suspended',
      ipAllowList: []
    }
  }
]

describe('Render', () => {
  it('lists workspaces and databases', () => {
    expect(
      renderContexts([{ cursor: 'x', owner: { id: 'tea-1', name: 'Acme', email: 'a@b' } }])
    ).toEqual([{ id: 'tea-1', label: 'Acme', isDefault: false }])
    const [analytics, orders] = renderDatabases(renderList)
    expect(orders).toMatchObject({
      name: 'orders',
      product: 'Render PostgreSQL 17',
      status: 'available',
      ready: true,
      user: 'orders_user',
      database: 'orders_db',
      size: 'basic_1gb · 15 GB',
      publicAccess: true,
      ref: { provider: 'render', context: 'tea-1', region: 'frankfurt', resource: 'dpg-abc' }
    })
    expect(orders.note).toBeUndefined()
    expect(analytics).toMatchObject({ ready: false, publicAccess: false })
    expect(analytics.note).toMatch(/blocks every IP/)
  })

  it('reads the external connection string', () => {
    expect(
      renderCredentials({
        password: 'secret',
        externalConnectionString:
          'postgresql://orders_user:secret@dpg-abc-a.frankfurt-postgres.render.com/orders_db',
        internalConnectionString: 'postgresql://orders_user:secret@dpg-abc-a/orders_db'
      })
    ).toEqual({
      host: 'dpg-abc-a.frankfurt-postgres.render.com',
      port: undefined,
      username: 'orders_user',
      password: 'secret',
      database: 'orders_db'
    })
  })

  it('creates databases through the API with an IP allow list', () => {
    const draft: ProvisionDraft = {
      ...newProvisionDraft('render', 'tea-1', 'frankfurt'),
      name: 'orders',
      size: 'basic_1gb',
      ip: '203.0.113.7',
      database: 'orders_db'
    }
    expect(validateProvision(draft)).toBeNull()
    expect(validateProvision({ ...draft, context: '' })).toMatch(/workspace/)
    const plan = planProvision(draft)
    expect(plan.steps[0].api!({})).toEqual({
      method: 'POST',
      path: '/postgres',
      body: {
        name: 'orders',
        ownerId: 'tea-1',
        plan: 'basic_1gb',
        region: 'frankfurt',
        version: '17',
        databaseName: 'orders_db',
        ipAllowList: [{ cidrBlock: '203.0.113.7/32', description: 'dbms-tool' }]
      }
    })
    expect(plan.steps[0].capture!(JSON.stringify({ id: 'dpg-new' }), {})).toEqual({ id: 'dpg-new' })
    expect(plan.resolveRef!({ id: 'dpg-new' })).toMatchObject({
      provider: 'render',
      resource: 'dpg-new'
    })
    expect(stepsScript(plan.steps, 'Render API')).toContain('POST /postgres\n{\n  "name": "orders"')
    const [, orders] = renderDatabases(renderList)
    expect(
      planDelete(orders, { finalSnapshot: false, disableProtection: false })[0].api!({})
    ).toEqual({
      method: 'DELETE',
      path: '/postgres/dpg-abc'
    })
  })
})

describe('Fly.io', () => {
  it('reads orgs in either shape and the signed-in email', () => {
    expect(flyContexts(JSON.stringify({ personal: 'Alex', acme: 'Acme Inc' }))).toEqual([
      { id: 'personal', label: 'Alex (personal)', isDefault: true },
      { id: 'acme', label: 'Acme Inc (acme)', isDefault: false }
    ])
    expect(flyContexts(JSON.stringify([{ slug: 'acme', name: 'acme' }]))).toEqual([
      { id: 'acme', label: 'acme', isDefault: false }
    ])
    expect(flyIdentity('alex@example.com\n')).toBe('alex@example.com')
  })

  it('lists clusters from the Machines API', () => {
    const list = {
      data: [
        { id: 'zxy', name: 'main-db', region: 'iad', plan: 'basic', status: 'ready' },
        { id: 'old', name: 'gone', region: 'iad', plan: 'basic', status: 'deleted' }
      ]
    }
    const [db] = flyDatabases(list, 'acme')
    expect(flyDatabases(list, 'acme')).toHaveLength(1)
    expect(db).toMatchObject({
      name: 'main-db',
      engine: 'postgres',
      ready: true,
      size: 'basic',
      endpointOnConnect: true,
      ref: { provider: 'fly', context: 'acme', region: 'iad', resource: 'zxy', kind: 'mpg' }
    })
    const [detail] = flyDatabases(
      {
        data: {
          id: 'zxy',
          name: 'main-db',
          region: 'iad',
          plan: 'basic',
          status: 'ready',
          pg_major_version: '17',
          disk_size_gb: 10,
          organization: { slug: 'acme', name: 'Acme' },
          endpoints: { primary: { direct: { host: 'direct.zxy.flympg.net', port: 5432 } } }
        }
      },
      ''
    )
    expect(detail).toMatchObject({
      product: 'Fly Managed Postgres 17',
      host: 'direct.zxy.flympg.net',
      size: 'basic · 10 GB',
      ref: { context: 'acme' }
    })
  })

  it('picks a schema admin and a real database for credentials', () => {
    expect(
      flyUsers(
        JSON.stringify([
          { name: 'reader', role: 'reader' },
          { name: 'fly-user', role: 'schema_admin' }
        ])
      )
    ).toEqual(['fly-user', 'reader'])
    expect(flyUsers('["a","b"]')).toEqual(['a', 'b'])
    expect(flyDatabaseNames(JSON.stringify([{ name: 'postgres' }, { name: 'fly-db' }]))).toEqual([
      'fly-db'
    ])
    expect(flyPassword({ data: { username: 'fly-user', password: 'pw' } })).toBe('pw')
  })

  it('plans create and destroy through flyctl', () => {
    const draft: ProvisionDraft = { ...newProvisionDraft('fly', 'acme', 'iad'), name: 'main-db' }
    expect(validateProvision(draft)).toBeNull()
    expect(validateProvision({ ...draft, name: 'Main DB' })).toMatch(/lowercase/)
    const plan = planProvision(draft)
    expect(plan.steps[0].args({})).toEqual([
      'mpg',
      'create',
      '--name',
      'main-db',
      '--region',
      'iad',
      '--plan',
      'basic',
      '--pg-major-version',
      '16',
      '--volume-size',
      '10',
      '--org',
      'acme'
    ])
    expect(plan.steps[1].api!({})).toEqual({ method: 'GET', path: '/postgres?org_slug=acme' })
    const found = plan.steps[1].capture!(
      JSON.stringify({ data: [{ id: 'zxy', name: 'main-db', status: 'creating' }] }),
      {}
    )
    expect(plan.resolveRef!(found)).toMatchObject({ provider: 'fly', resource: 'zxy', kind: 'mpg' })
    expect(() => plan.steps[1].capture!('{"data":[]}', {})).toThrow(/new cluster/)
    const [db] = flyDatabases({ data: [{ id: 'zxy', name: 'main-db', status: 'ready' }] }, 'acme')
    expect(planDelete(db, { finalSnapshot: false, disableProtection: false })[0].args({})).toEqual([
      'mpg',
      'destroy',
      'zxy',
      '--yes'
    ])
  })
})

describe('Cloudflare D1', () => {
  it('lists accounts and databases', () => {
    expect(cloudflareContexts({ success: true, result: [{ id: 'acc1', name: 'Acme' }] })).toEqual([
      { id: 'acc1', label: 'Acme', isDefault: false }
    ])
    const [db] = cloudflareDatabases(
      {
        result: [
          {
            uuid: 'u-1',
            name: 'prod-db',
            created_at: '2026-01-01',
            version: 'production',
            jurisdiction: 'eu',
            file_size: 2048
          }
        ]
      },
      'acc1'
    )
    expect(db).toMatchObject({
      name: 'prod-db',
      engine: 'sqlite',
      product: 'Cloudflare D1',
      database: 'prod-db',
      size: '2.0 KB',
      location: 'EU jurisdiction',
      ref: { provider: 'cloudflare', context: 'acc1', resource: 'u-1', kind: 'd1' }
    })
    expect(cloudflareDatabases({ result: { uuid: 'u-1', name: 'x' } }, 'acc1')).toHaveLength(1)
  })

  it('creates and deletes databases through the API', () => {
    const draft: ProvisionDraft = {
      ...newProvisionDraft('cloudflare', 'acc1', ''),
      name: 'prod-db',
      region: 'weur'
    }
    expect(validateProvision(draft)).toBeNull()
    expect(validateProvision({ ...draft, region: '' })).toBeNull()
    expect(validateProvision({ ...draft, context: '' })).toMatch(/account/)
    const plan = planProvision(draft)
    expect(plan.steps[0].api!({})).toEqual({
      method: 'POST',
      path: '/accounts/acc1/d1/database',
      body: { name: 'prod-db', primary_location_hint: 'weur' }
    })
    expect(plan.steps[0].capture!(JSON.stringify({ result: { uuid: 'u-9' } }), {})).toEqual({
      id: 'u-9'
    })
    const [db] = cloudflareDatabases({ result: [{ uuid: 'u-1', name: 'prod-db' }] }, 'acc1')
    expect(planDelete(db, { finalSnapshot: false, disableProtection: false })[0].api!({})).toEqual({
      method: 'DELETE',
      path: '/accounts/acc1/d1/database/u-1'
    })
  })
})

describe('urlCredentials', () => {
  it('handles mysql URLs and garbage', () => {
    expect(urlCredentials('mysql://root:pw@h:3306/db')).toEqual({
      host: 'h',
      port: 3306,
      username: 'root',
      password: 'pw',
      database: 'db'
    })
    expect(urlCredentials('not a url')).toEqual({})
  })
})
