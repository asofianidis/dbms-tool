import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '../api'
import {
  connectionFor,
  credentialsCommand,
  deletePlan,
  findSaved,
  iamUserFor,
  parseCredentials,
  providerForHost,
  splitMongoPassword,
  stepsScript,
  gcpVersion,
  generatePassword,
  newProvisionDraft,
  parseContexts,
  parseDescribe,
  parseIdentity,
  parseList,
  planScript,
  provisionedConnection,
  validateProvision,
  withEngine,
  type ProvisionDraft
} from '../cloud'
import { planProvision } from '../cloud-platforms'
import { newConnection } from '../engines'

const awsInstances = JSON.stringify({
  DBInstances: [
    {
      DBInstanceIdentifier: 'app-dev',
      Engine: 'postgres',
      EngineVersion: '16.4',
      DBInstanceStatus: 'available',
      Endpoint: { Address: 'app-dev.abc.us-east-1.rds.amazonaws.com', Port: 5432 },
      MasterUsername: 'postgres',
      DBName: 'app',
      DBInstanceClass: 'db.t4g.micro',
      AllocatedStorage: 20,
      PubliclyAccessible: true,
      MasterUserSecret: { SecretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:rds!db-1' }
    },
    {
      DBInstanceIdentifier: 'reports',
      Engine: 'sqlserver-ex',
      EngineVersion: '16.00.4085.2.v1',
      DBInstanceStatus: 'creating',
      MasterUsername: 'admin',
      DBInstanceClass: 'db.t3.small',
      AllocatedStorage: 20,
      PubliclyAccessible: false
    },
    // Aurora members are listed through their cluster
    {
      DBInstanceIdentifier: 'aurora-1',
      Engine: 'aurora-postgresql',
      DBClusterIdentifier: 'aurora'
    },
    // Engines we can't open are skipped
    { DBInstanceIdentifier: 'graph', Engine: 'oracle-ee', DBInstanceStatus: 'available' }
  ]
})

const awsClusters = JSON.stringify({
  DBClusters: [
    {
      DBClusterIdentifier: 'aurora',
      Engine: 'aurora-postgresql',
      EngineVersion: '16.4',
      Status: 'available',
      Endpoint: 'aurora.cluster-abc.eu-west-1.rds.amazonaws.com',
      Port: 5432,
      MasterUsername: 'postgres',
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 2 },
      DBClusterMembers: [{ DBInstanceIdentifier: 'aurora-1' }]
    },
    {
      DBClusterIdentifier: 'docs',
      Engine: 'docdb',
      EngineVersion: '5.0.0',
      Status: 'available',
      Endpoint: 'docs.cluster-abc.eu-west-1.docdb.amazonaws.com',
      Port: 27017,
      MasterUsername: 'root',
      DBClusterMembers: []
    },
    { DBClusterIdentifier: 'neptune', Engine: 'neptune', Status: 'available' }
  ]
})

const gcpInstances = JSON.stringify([
  {
    name: 'pg-main',
    project: 'acme-prod',
    databaseVersion: 'POSTGRES_16',
    state: 'RUNNABLE',
    region: 'us-central1',
    ipAddresses: [
      { type: 'PRIMARY', ipAddress: '34.1.2.3' },
      { type: 'OUTGOING', ipAddress: '34.9.9.9' }
    ],
    settings: {
      tier: 'db-f1-micro',
      dataDiskSizeGb: '10',
      ipConfiguration: { authorizedNetworks: [{ value: '1.2.3.4/32' }] }
    }
  },
  {
    name: 'mssql-private',
    project: 'acme-prod',
    databaseVersion: 'SQLSERVER_2022_EXPRESS',
    state: 'RUNNABLE',
    region: 'europe-west1',
    ipAddresses: [{ type: 'PRIVATE', ipAddress: '10.0.0.5' }],
    settings: { tier: 'db-custom-1-3840', activationPolicy: 'ALWAYS' }
  },
  {
    name: 'stopped',
    databaseVersion: 'MYSQL_8_0',
    state: 'RUNNABLE',
    region: 'us-east1',
    ipAddresses: [{ type: 'PRIMARY', ipAddress: '34.5.5.5' }],
    settings: { tier: 'db-g1-small', activationPolicy: 'NEVER' }
  }
])

const azurePostgres = JSON.stringify([
  {
    id: '/subscriptions/sub-1/resourceGroups/rg-data/providers/Microsoft.DBforPostgreSQL/flexibleServers/pgflex',
    name: 'pgflex',
    fullyQualifiedDomainName: 'pgflex.postgres.database.azure.com',
    state: 'Ready',
    location: 'East US',
    version: '16',
    administratorLogin: 'dbadmin',
    sku: { name: 'Standard_B1ms', tier: 'Burstable' },
    storage: { storageSizeGb: 32 },
    network: { publicNetworkAccess: 'Enabled' }
  }
])

const azureSql = JSON.stringify([
  {
    id: '/subscriptions/sub-1/resourceGroups/rg-sql/providers/Microsoft.Sql/servers/sqlsrv',
    name: 'sqlsrv',
    fullyQualifiedDomainName: 'sqlsrv.database.windows.net',
    administratorLogin: 'dbadmin',
    location: 'westeurope',
    resourceGroup: 'rg-sql',
    state: 'Ready',
    publicNetworkAccess: 'Disabled'
  }
])

describe('discovery', () => {
  it('parses RDS instances, skipping cluster members and unsupported engines', () => {
    const dbs = parseList('aws-instances', awsInstances, 'work', 'us-east-1')
    expect(dbs.map((d) => d.name)).toEqual(['app-dev', 'reports'])
    const [pg, mssql] = dbs
    expect(pg).toMatchObject({
      engine: 'postgres',
      product: 'PostgreSQL 16.4',
      ready: true,
      host: 'app-dev.abc.us-east-1.rds.amazonaws.com',
      port: 5432,
      user: 'postgres',
      database: 'app',
      size: 'db.t4g.micro · 20 GiB',
      publicAccess: true,
      secretArn: 'arn:aws:secretsmanager:us-east-1:1:secret:rds!db-1',
      ref: {
        provider: 'aws',
        context: 'work',
        region: 'us-east-1',
        resource: 'app-dev',
        kind: 'instance'
      }
    })
    expect(mssql).toMatchObject({
      engine: 'mssql',
      product: 'SQL Server Express 16.00.4085.2.v1',
      ready: false,
      host: ''
    })
    expect(mssql.note).toMatch(/VPC/)
  })

  it('parses Aurora and DocumentDB clusters', () => {
    const [aurora, docs] = parseList('aws-clusters', awsClusters, '', 'eu-west-1')
    expect(aurora).toMatchObject({
      engine: 'postgres',
      product: 'Aurora PostgreSQL 16.4',
      size: 'Serverless v2 · 0.5–2 ACU',
      ready: true,
      ref: { kind: 'cluster', resource: 'aurora' }
    })
    expect(docs).toMatchObject({
      engine: 'mongo',
      product: 'DocumentDB 5.0.0',
      size: '0 instances'
    })
    expect(parseList('aws-clusters', awsClusters, '', 'eu-west-1')).toHaveLength(2)
  })

  it('parses Cloud SQL instances', () => {
    const [pg, mssql, stopped] = parseList('gcp-instances', gcpInstances, '', '')
    expect(pg).toMatchObject({
      engine: 'postgres',
      product: 'PostgreSQL 16',
      host: '34.1.2.3',
      port: 5432,
      user: 'postgres',
      ready: true,
      status: 'runnable',
      size: 'db-f1-micro · 10 GB',
      ref: { provider: 'gcp', context: 'acme-prod', region: 'us-central1' }
    })
    expect(pg.note).toBeUndefined()
    expect(mssql).toMatchObject({
      engine: 'mssql',
      host: '10.0.0.5',
      user: 'sqlserver',
      publicAccess: false
    })
    expect(mssql.note).toMatch(/Private IP/)
    expect(stopped).toMatchObject({ status: 'stopped', ready: false })
  })

  it('names Cloud SQL versions', () => {
    expect(gcpVersion('MYSQL_8_0')).toEqual({ engine: 'mysql', product: 'MySQL 8.0' })
    expect(gcpVersion('SQLSERVER_2019_STANDARD')).toEqual({
      engine: 'mssql',
      product: 'SQL Server 2019 Standard'
    })
    expect(gcpVersion('ORACLE_19')).toBeNull()
  })

  it('parses Azure servers, taking the resource group from the id when needed', () => {
    const [pg] = parseList('azure-postgres', azurePostgres, '', '')
    expect(pg).toMatchObject({
      engine: 'postgres',
      product: 'Azure PostgreSQL 16',
      host: 'pgflex.postgres.database.azure.com',
      database: 'postgres',
      ready: true,
      publicAccess: true,
      ref: { provider: 'azure', context: 'sub-1', kind: 'postgres', resourceGroup: 'rg-data' }
    })
    const [sql] = parseList('azure-sql', azureSql, '', '')
    expect(sql).toMatchObject({
      engine: 'mssql',
      port: 1433,
      publicAccess: false,
      ref: { resourceGroup: 'rg-sql' }
    })
    expect(sql.note).toMatch(/private endpoint/)
  })

  it('parses single-object describe output', () => {
    const ref = {
      provider: 'gcp' as const,
      context: 'acme-prod',
      region: 'us-central1',
      resource: 'pg-main',
      kind: 'instance'
    }
    const one = JSON.stringify(JSON.parse(gcpInstances)[0])
    expect(parseDescribe(ref, one)?.host).toBe('34.1.2.3')
    const azureRef = {
      provider: 'azure' as const,
      context: '',
      region: '',
      resource: 'pgflex',
      kind: 'postgres',
      resourceGroup: 'rg-data'
    }
    expect(parseDescribe(azureRef, JSON.stringify(JSON.parse(azurePostgres)[0]))?.ready).toBe(true)
    const awsRef = {
      provider: 'aws' as const,
      context: '',
      region: 'us-east-1',
      resource: 'app-dev',
      kind: 'instance'
    }
    expect(parseDescribe(awsRef, awsInstances)?.name).toBe('app-dev')
    expect(parseDescribe(awsRef, 'not json')).toBeNull()
  })

  it('parses accounts and identities', () => {
    expect(parseContexts('aws', 'default\r\nwork\n\n')).toEqual([
      { id: 'default', label: 'default', isDefault: true },
      { id: 'work', label: 'work', isDefault: false }
    ])
    expect(
      parseContexts(
        'gcp',
        JSON.stringify([
          { projectId: 'b-proj', name: 'B' },
          { projectId: 'a-proj', name: 'a-proj' }
        ])
      )
    ).toEqual([
      { id: 'a-proj', label: 'a-proj', isDefault: false },
      { id: 'b-proj', label: 'B (b-proj)', isDefault: false }
    ])
    expect(
      parseContexts(
        'azure',
        JSON.stringify([
          { id: 's1', name: 'Dev', isDefault: true, state: 'Enabled' },
          { id: 's2', name: 'Old', isDefault: false, state: 'Disabled' }
        ])
      )
    ).toEqual([{ id: 's1', label: 'Dev', isDefault: true }])
    expect(
      parseIdentity(
        'aws',
        JSON.stringify({
          Arn: 'arn:aws:sts::123456789012:assumed-role/Admin/alex',
          Account: '123456789012'
        })
      )
    ).toBe('Admin/alex · 123456789012')
    expect(
      parseIdentity(
        'gcp',
        JSON.stringify([
          { account: 'a@x.dev', status: '' },
          { account: 'b@x.dev', status: 'ACTIVE' }
        ])
      )
    ).toBe('b@x.dev')
    expect(parseIdentity('gcp', '[]')).toBeNull()
    expect(
      parseIdentity('azure', JSON.stringify({ name: 'Dev', user: { name: 'me@x.dev' } }))
    ).toBe('me@x.dev')
  })

  it('reads Secrets Manager passwords', () => {
    const out = JSON.stringify({
      SecretString: JSON.stringify({ username: 'postgres', password: 'p@ss' })
    })
    const [rds] = parseList('aws-instances', awsInstances, '', 'us-east-1')
    expect(credentialsCommand(rds)).toEqual(
      expect.arrayContaining(['secretsmanager', 'get-secret-value', '--secret-id', rds.secretArn])
    )
    expect(parseCredentials(rds, out)).toEqual({ username: 'postgres', password: 'p@ss' })
    expect(parseCredentials(rds, '{}')).toEqual({})
  })
})

describe('connections', () => {
  it('builds connections with TLS settings per provider', () => {
    const [rds] = parseList('aws-instances', awsInstances, '', 'us-east-1')
    expect(connectionFor(rds)).toMatchObject({
      engine: 'postgres',
      host: rds.host,
      ssl: 'require',
      trustServerCertificate: true,
      database: 'app',
      group: 'AWS',
      cloud: rds.ref
    })
    const [azure] = parseList('azure-postgres', azurePostgres, '', '')
    expect(connectionFor(azure).trustServerCertificate).toBe(false)
  })

  it('builds a URI for DocumentDB', () => {
    const [, docs] = parseList('aws-clusters', awsClusters, '', 'eu-west-1')
    const config = connectionFor(docs)
    expect(config.uri).toBe(
      'mongodb://root@docs.cluster-abc.eu-west-1.docdb.amazonaws.com:27017/?tls=true&retryWrites=false'
    )
    expect(config.host).toBe('')
  })

  it('finds saved connections by cloud resource or host', () => {
    const [rds, other] = parseList('aws-instances', awsInstances, '', 'us-east-1')
    const byRef: ConnectionConfig = {
      ...newConnection('mssql'),
      id: 'a',
      host: '',
      cloud: other.ref
    }
    const byHost: ConnectionConfig = {
      ...newConnection('postgres'),
      id: 'b',
      host: rds.host.toUpperCase()
    }
    expect(findSaved([byRef, byHost], rds)?.id).toBe('b')
    expect(findSaved([byRef, byHost], other)?.id).toBe('a')
    expect(findSaved([byHost], other)).toBeUndefined()
  })
})

const draftFor = (
  provider: ProvisionDraft['provider'],
  patch: Partial<ProvisionDraft> = {}
): ProvisionDraft => ({
  ...newProvisionDraft(provider, 'work', ''),
  name: 'app-dev',
  password: 'Str0ng-Passw0rd',
  ip: '203.0.113.7',
  ...patch
})

describe('provisioning', () => {
  it('validates drafts per provider', () => {
    expect(validateProvision(draftFor('aws'))).toBeNull()
    expect(validateProvision(draftFor('aws', { name: '9lives' }))).toMatch(/start with a letter/)
    expect(validateProvision(draftFor('aws', { name: 'a--b' }))).toMatch(/single hyphens/)
    expect(validateProvision(draftFor('aws', { password: 'has/slash1' }))).toMatch(/without/)
    expect(validateProvision(draftFor('gcp', { name: 'App' }))).toMatch(/lowercase/)
    expect(validateProvision(draftFor('azure', { password: 'alllowercase1' }))).toMatch(/three of/)
    expect(validateProvision(draftFor('azure', { user: 'admin' }))).toMatch(/doesn't allow/)
    expect(validateProvision(draftFor('aws', { ip: '300.1.1.1' }))).toMatch(/IP address/)
    expect(validateProvision(draftFor('aws', { ip: '', access: 'anywhere' }))).toBeNull()
    expect(validateProvision(draftFor('aws', { storageGb: 5 }))).toMatch(/at least 20/)
    expect(validateProvision(withEngine(draftFor('azure'), 'sql'))).toBeNull()
    expect(validateProvision({ ...withEngine(draftFor('azure'), 'sql'), database: '' })).toMatch(
      /database name/
    )
  })

  it('generates passwords every provider accepts', () => {
    for (let i = 0; i < 50; i++) {
      const password = generatePassword()
      for (const provider of ['aws', 'gcp', 'azure'] as const) {
        expect(validateProvision(draftFor(provider, { password }))).toBeNull()
      }
    }
  })

  it('switching engine resets dependent fields', () => {
    const d = withEngine(draftFor('gcp', { size: 'db-f1-micro' }), 'SQLSERVER')
    expect(d).toMatchObject({
      version: 'SQLSERVER_2022_EXPRESS',
      size: 'db-custom-1-3840',
      user: 'sqlserver',
      storageGb: 20
    })
    expect(withEngine(draftFor('aws', { database: 'app' }), 'sqlserver-ex').database).toBe('')
  })

  it('plans a public RDS instance with its own security group', () => {
    const plan = planProvision(draftFor('aws', { region: 'eu-west-1', database: 'app' }))
    expect(plan.steps.map((s) => s.title)).toEqual([
      'Find the default VPC',
      'Create a security group',
      'Allow 203.0.113.7/32 on port 5432',
      'Create the PostgreSQL instance'
    ])
    expect(plan.steps[0].capture!(JSON.stringify({ Vpcs: [{ VpcId: 'vpc-1' }] }), {})).toEqual({
      vpcId: 'vpc-1'
    })
    expect(() => plan.steps[0].capture!(JSON.stringify({ Vpcs: [] }), {})).toThrow(/default VPC/)
    const create = plan.steps[3]
    const args = create.args({ groupId: 'sg-9' })
    expect(args).toEqual(
      expect.arrayContaining([
        '--vpc-security-group-ids',
        'sg-9',
        '--publicly-accessible',
        '--db-name',
        'app',
        '--profile',
        'work',
        '--region',
        'eu-west-1'
      ])
    )
    expect(args).toContain('file://{secret}')
    expect(args.join(' ')).not.toContain('Str0ng')
    expect(JSON.parse(create.secret!)).toEqual({ MasterUserPassword: 'Str0ng-Passw0rd' })
    expect(plan.ref).toMatchObject({
      provider: 'aws',
      resource: 'app-dev',
      kind: 'instance',
      region: 'eu-west-1'
    })
  })

  it('plans private and SQL Server RDS instances', () => {
    const plan = planProvision(
      withEngine(draftFor('aws', { access: 'private', database: 'x' }), 'sqlserver-ex')
    )
    expect(plan.steps).toHaveLength(1)
    const args = plan.steps[0].args({})
    expect(args).toEqual(
      expect.arrayContaining(['--no-publicly-accessible', '--license-model', 'license-included'])
    )
    expect(args).not.toContain('--db-name')
    expect(args).not.toContain('--vpc-security-group-ids')
  })

  it('plans an Aurora Serverless v2 cluster and its writer', () => {
    const plan = planProvision(
      withEngine(draftFor('aws', { access: 'private' }), 'aurora-postgresql')
    )
    expect(plan.ref.kind).toBe('cluster')
    const [cluster, writer] = plan.steps.map((s) => s.args({}))
    expect(cluster).toEqual(
      expect.arrayContaining([
        'create-db-cluster',
        '--serverless-v2-scaling-configuration',
        'MinCapacity=0.5,MaxCapacity=2'
      ])
    )
    expect(writer).toEqual(
      expect.arrayContaining([
        '--db-cluster-identifier',
        'app-dev',
        '--db-instance-class',
        'db.serverless',
        '--db-instance-identifier',
        'app-dev-1'
      ])
    )
  })

  it('plans a Cloud SQL instance with the password in a flags file', () => {
    const plan = planProvision(draftFor('gcp', { region: 'us-central1', database: 'app' }))
    const [create] = plan.steps
    expect(create.args({})).toEqual(
      expect.arrayContaining([
        'create',
        'app-dev',
        '--database-version=POSTGRES_17',
        '--tier=db-f1-micro',
        '--edition=enterprise',
        '--authorized-networks=203.0.113.7/32',
        '--flags-file={secret}',
        '--project',
        'work'
      ])
    )
    expect(create.secret).toBe('--root-password: "Str0ng-Passw0rd"')
    expect(plan.afterReady[0].args({})).toEqual(
      expect.arrayContaining(['databases', 'create', 'app', '--instance=app-dev'])
    )
    expect(
      planProvision(draftFor('gcp', { access: 'private' }))
        .steps[0].args({})
        .join(' ')
    ).not.toContain('authorized-networks')
  })

  it('plans Azure flexible servers and SQL databases', () => {
    const pg = planProvision(
      draftFor('azure', { region: 'westeurope', user: 'dbadmin', database: 'app' })
    )
    expect(pg.steps.map((s) => s.title)[0]).toBe('Create resource group dbms-tool')
    const create = pg.steps[1].args({})
    expect(create).toEqual(
      expect.arrayContaining([
        'postgres',
        'flexible-server',
        'create',
        '--tier',
        'Burstable',
        '--sku-name',
        'Standard_B1ms',
        '--admin-password',
        '@{secret}',
        '--public-access',
        '203.0.113.7',
        '--subscription',
        'work'
      ])
    )
    expect(pg.steps[1].secret).toBe('Str0ng-Passw0rd')
    expect(pg.afterReady).toHaveLength(1)
    expect(pg.ref).toMatchObject({ kind: 'postgres', resourceGroup: 'dbms-tool' })

    const sql = planProvision(
      withEngine(draftFor('azure', { newResourceGroup: false, ip: '203.0.113.0/24' }), 'sql')
    )
    expect(sql.steps.map((s) => s.title)).toEqual([
      'Create the Azure SQL server',
      'Allow 203.0.113.0/24 through the firewall',
      'Create database appdb'
    ])
    expect(sql.steps[1].args({})).toEqual(
      expect.arrayContaining([
        '--start-ip-address',
        '203.0.113.0',
        '--end-ip-address',
        '203.0.113.255'
      ])
    )
    expect(sql.steps[2].args({})).toEqual(expect.arrayContaining(['--compute-model', 'Serverless']))
  })

  it('renders a script without the password', () => {
    const script = planScript(planProvision(draftFor('aws')), 'aws')
    expect(script).toContain('# Create a security group')
    expect(script).toContain('--vpc-id <vpcId>')
    expect(script).toContain('file://password-file')
    expect(script).toContain("--description 'Database access for app-dev (created by dbms-tool)'")
    expect(script).not.toContain('Str0ng')
    expect(planScript(planProvision(draftFor('gcp', { database: 'app' })), 'gcloud')).toContain(
      '# …once the server is ready'
    )
  })

  it('saves provisioned connections with the chosen user and database', () => {
    const draft = draftFor('aws', { user: 'appadmin', database: 'app' })
    const [db] = parseList('aws-instances', awsInstances, '', 'us-east-1')
    expect(provisionedConnection(draft, db)).toMatchObject({
      name: 'app-dev',
      user: 'appadmin',
      database: 'app',
      savePassword: true,
      cloud: db.ref
    })
  })
})

describe('passwordless sign-in', () => {
  it('reads whether each provider accepts IAM sign-in', () => {
    const iamInstance = JSON.stringify({
      DBInstances: [
        {
          DBInstanceIdentifier: 'iam-db',
          Engine: 'postgres',
          DBInstanceStatus: 'available',
          Endpoint: { Address: 'iam-db.x.us-east-1.rds.amazonaws.com', Port: 5432 },
          IAMDatabaseAuthenticationEnabled: true,
          DeletionProtection: true
        }
      ]
    })
    expect(parseList('aws-instances', iamInstance, '', 'us-east-1')[0]).toMatchObject({
      iamAuth: true,
      deletionProtection: true
    })
    expect(parseList('aws-instances', awsInstances, '', 'us-east-1')[0].iamAuth).toBe(false)

    const gcp = JSON.parse(gcpInstances)
    gcp[0].settings.databaseFlags = [{ name: 'cloudsql.iam_authentication', value: 'on' }]
    gcp[0].settings.deletionProtectionEnabled = true
    expect(parseList('gcp-instances', JSON.stringify(gcp), '', '')[0]).toMatchObject({
      iamAuth: true,
      deletionProtection: true
    })

    const pg = JSON.parse(azurePostgres)
    pg[0].authConfig = { activeDirectoryAuth: 'Enabled', passwordAuth: 'Enabled' }
    expect(parseList('azure-postgres', JSON.stringify(pg), '', '')[0].iamAuth).toBe(true)
    const sql = JSON.parse(azureSql)
    expect(parseList('azure-sql', azureSql, '', '')[0].iamAuth).toBe(false)
    sql[0].administrators = { login: 'dba@contoso.com', azureAdOnlyAuthentication: false }
    expect(parseList('azure-sql', JSON.stringify(sql), '', '')[0].iamAuth).toBe(true)
  })

  it('picks the database user for the signed-in identity', () => {
    const [pg, , mysql] = parseList('gcp-instances', gcpInstances, '', '')
    expect(iamUserFor(pg, 'me@acme.dev')).toBe('me@acme.dev')
    expect(iamUserFor(pg, 'svc@proj.iam.gserviceaccount.com')).toBe('svc@proj.iam')
    expect(iamUserFor(mysql, 'me@acme.dev')).toBe('me')
    const [azure] = parseList('azure-postgres', azurePostgres, '', '')
    expect(iamUserFor(azure, 'me@contoso.com')).toBe('me@contoso.com')
    // AWS users are mapped inside the database, so there's no guess to make
    const [rds] = parseList('aws-instances', awsInstances, '', 'us-east-1')
    expect(iamUserFor(rds, 'Admin/alex · 123')).toBeNull()
    expect(iamUserFor(pg, null)).toBeNull()
  })

  it('guesses the provider from managed host names', () => {
    expect(providerForHost('db.abc.eu-west-1.rds.amazonaws.com')).toBe('aws')
    expect(providerForHost('pg.postgres.database.azure.com')).toBe('azure')
    expect(providerForHost('srv.database.windows.net')).toBe('azure')
    expect(providerForHost('34.1.2.3')).toBeNull()
  })

  it('turns on IAM authentication when provisioning', () => {
    const aws = planProvision(draftFor('aws', { iamAuth: true, access: 'private' }))
    expect(aws.steps[0].args({})).toContain('--enable-iam-database-authentication')
    expect(planProvision(draftFor('aws', { access: 'private' })).steps[0].args({})).not.toContain(
      '--enable-iam-database-authentication'
    )

    const gcpPg = planProvision(draftFor('gcp', { iamAuth: true, iamUser: 'me@acme.dev' }))
    expect(gcpPg.steps[0].args({})).toContain('--database-flags=cloudsql.iam_authentication=on')
    expect(gcpPg.afterReady[0].args({})).toEqual(
      expect.arrayContaining(['users', 'create', 'me@acme.dev', '--type=cloud_iam_user'])
    )
    const gcpMy = planProvision(
      withEngine(
        draftFor('gcp', { iamAuth: true, iamUser: 'svc@p.iam.gserviceaccount.com' }),
        'MYSQL'
      )
    )
    expect(gcpMy.steps[0].args({})).toContain('--database-flags=cloudsql_iam_authentication=on')
    expect(gcpMy.afterReady[0].args({})).toEqual(
      expect.arrayContaining(['svc@p.iam.gserviceaccount.com', '--type=cloud_iam_service_account'])
    )
    expect(validateProvision(draftFor('gcp', { iamAuth: true, iamUser: '' }))).toMatch(/gcloud/)
    // Engines without IAM support drop the setting
    expect(withEngine(draftFor('aws', { iamAuth: true }), 'sqlserver-ex').iamAuth).toBe(false)
  })
})

describe('Babelfish', () => {
  it('recognises Babelfish clusters by their parameter group', () => {
    const clusters = JSON.parse(awsClusters)
    clusters.DBClusters[0].DBClusterParameterGroup = 'app-babelfish'
    const [bf] = parseList('aws-clusters', JSON.stringify(clusters), '', 'eu-west-1')
    expect(bf).toMatchObject({
      engine: 'babelfish',
      product: 'Aurora Babelfish 16.4',
      port: 1433,
      database: '',
      members: ['aurora-1']
    })
    expect(connectionFor(bf)).toMatchObject({
      engine: 'babelfish',
      port: 1433,
      trustServerCertificate: true
    })
  })

  it('plans a Babelfish cluster with its parameter group and both ports', () => {
    const plan = planProvision(withEngine(draftFor('aws'), 'babelfish'))
    expect(plan.steps.map((s) => s.title)).toEqual([
      'Find the default VPC',
      'Create a security group',
      'Allow 203.0.113.7/32 on port 1433',
      'Allow 203.0.113.7/32 on port 5432',
      'Look up the default Aurora PostgreSQL version',
      'Create a Babelfish parameter group',
      'Turn on Babelfish',
      'Create the Aurora Babelfish cluster',
      'Add the writer instance'
    ])
    const lookup = plan.steps[4]
    expect(
      lookup.capture!(
        JSON.stringify({
          DBEngineVersions: [
            { EngineVersion: '16.4', DBParameterGroupFamily: 'aurora-postgresql16' }
          ]
        }),
        {}
      )
    ).toEqual({ engineVersion: '16.4', family: 'aurora-postgresql16' })
    expect(() => lookup.capture!('{"DBEngineVersions":[]}', {})).toThrow(/isn't offered/)
    expect(plan.steps[5].args({ family: 'aurora-postgresql16' })).toEqual(
      expect.arrayContaining(['--db-parameter-group-family', 'aurora-postgresql16'])
    )
    expect(plan.steps[6].args({})).toContain(
      'ParameterName=rds.babelfish_status,ParameterValue=on,ApplyMethod=pending-reboot'
    )
    const cluster = plan.steps[7].args({ engineVersion: '16.4', groupId: 'sg-1' })
    expect(cluster).toEqual(
      expect.arrayContaining([
        '--engine',
        'aurora-postgresql',
        '--engine-version',
        '16.4',
        '--db-cluster-parameter-group-name',
        'app-dev-babelfish',
        '--master-username',
        'babelfish_user'
      ])
    )
    expect(plan.steps[8].args({})).toEqual(
      expect.arrayContaining(['--engine', 'aurora-postgresql'])
    )
    expect(plan.ref.kind).toBe('cluster')
  })
})

const cosmosAccounts = JSON.stringify([
  {
    id: '/subscriptions/sub-1/resourceGroups/rg-docs/providers/Microsoft.DocumentDB/databaseAccounts/docs-acct',
    name: 'docs-acct',
    kind: 'MongoDB',
    location: 'West Europe',
    provisioningState: 'Succeeded',
    apiProperties: { serverVersion: '6.0' },
    capabilities: [{ name: 'EnableMongo' }, { name: 'EnableServerless' }],
    publicNetworkAccess: 'Enabled'
  },
  { name: 'sql-acct', kind: 'GlobalDocumentDB', provisioningState: 'Succeeded' }
])

describe('Cosmos DB', () => {
  it('lists MongoDB accounts only', () => {
    const accounts = parseList('azure-cosmos', cosmosAccounts, '', '')
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({
      name: 'docs-acct',
      engine: 'mongo',
      product: 'Cosmos DB for MongoDB 6.0',
      host: 'docs-acct.mongo.cosmos.azure.com',
      port: 10255,
      status: 'ready',
      ready: true,
      size: 'Serverless',
      ref: { kind: 'cosmos', resourceGroup: 'rg-docs', context: 'sub-1' }
    })
    const ref = accounts[0].ref
    expect(parseDescribe(ref, JSON.stringify(JSON.parse(cosmosAccounts)[0]))?.name).toBe(
      'docs-acct'
    )
  })

  it('reads the primary connection string and keeps the key out of the URI', () => {
    const [account] = parseList('azure-cosmos', cosmosAccounts, '', '')
    expect(credentialsCommand(account)).toEqual(
      expect.arrayContaining([
        'cosmosdb',
        'keys',
        'list',
        '--type',
        'connection-strings',
        '--name',
        'docs-acct'
      ])
    )
    const out = JSON.stringify({
      connectionStrings: [
        {
          description: 'Primary MongoDB Connection String',
          connectionString:
            'mongodb://docs-acct:abc%2Bkey%3D%3D@docs-acct.mongo.cosmos.azure.com:10255/?ssl=true&replicaSet=globaldb'
        },
        { description: 'Secondary MongoDB Connection String', connectionString: 'mongodb://x:y@z/' }
      ]
    })
    expect(parseCredentials(account, out)).toEqual({
      uri: 'mongodb://docs-acct@docs-acct.mongo.cosmos.azure.com:10255/?ssl=true&replicaSet=globaldb',
      username: 'docs-acct',
      password: 'abc+key=='
    })
    expect(splitMongoPassword('mongodb://host/')).toEqual({ uri: 'mongodb://host/' })
    expect(connectionFor(account).uri).toMatch(
      /^mongodb:\/\/docs-acct@docs-acct\.mongo\.cosmos\.azure\.com:10255\/\?ssl=true&replicaSet=globaldb/
    )
  })

  it('provisions a Cosmos DB account without an admin password', () => {
    const draft = withEngine(
      draftFor('azure', { password: '', user: '', database: 'app' }),
      'cosmos'
    )
    expect(validateProvision(draft)).toBeNull()
    expect(validateProvision({ ...draft, name: 'x'.repeat(45) })).toMatch(/3–44/)
    const plan = planProvision(draft)
    const create = plan.steps[1]
    expect(create.secret).toBeUndefined()
    expect(create.args({})).toEqual(
      expect.arrayContaining([
        'cosmosdb',
        'create',
        '--kind',
        'MongoDB',
        '--server-version',
        '6.0',
        '--capabilities',
        'EnableServerless',
        '--ip-range-filter',
        '203.0.113.7/32'
      ])
    )
    expect(planProvision({ ...draft, access: 'private', size: 'free' }).steps[1].args({})).toEqual(
      expect.arrayContaining(['--public-network-access', 'Disabled', '--enable-free-tier', 'true'])
    )
    expect(plan.afterReady[0].args({})).toEqual(
      expect.arrayContaining([
        'mongodb',
        'database',
        'create',
        '--account-name',
        'app-dev',
        '--name',
        'app'
      ])
    )
    expect(plan.ref.kind).toBe('cosmos')

    const [account] = parseList('azure-cosmos', cosmosAccounts, '', '')
    const saved = provisionedConnection({ ...draft, name: 'docs-acct' }, account, {
      uri: 'mongodb://docs-acct@docs-acct.mongo.cosmos.azure.com:10255/?ssl=true',
      password: 'k'
    })
    expect(saved).toMatchObject({
      engine: 'mongo',
      user: 'docs-acct',
      uri: 'mongodb://docs-acct@docs-acct.mongo.cosmos.azure.com:10255/?ssl=true',
      database: 'app'
    })
  })
})

describe('deleting', () => {
  const now = new Date('2026-10-22T23:45:10Z')

  it('deletes RDS instances with or without a final snapshot', () => {
    const [rds] = parseList('aws-instances', awsInstances, 'work', 'us-east-1')
    const [step] = deletePlan(rds, { finalSnapshot: true, disableProtection: false }, now)
    expect(step.args({})).toEqual(
      expect.arrayContaining([
        'rds',
        'delete-db-instance',
        '--db-instance-identifier',
        'app-dev',
        '--final-db-snapshot-identifier',
        'app-dev-final-202610222345',
        '--profile',
        'work'
      ])
    )
    const plain = deletePlan(rds, { finalSnapshot: false, disableProtection: true }, now)
    expect(plain.map((s) => s.title)).toEqual([
      'Turn off deletion protection',
      'Delete instance app-dev'
    ])
    expect(plain[0].args({})).toEqual(
      expect.arrayContaining(['modify-db-instance', '--no-deletion-protection'])
    )
    expect(plain[1].args({})).toContain('--skip-final-snapshot')
  })

  it('deletes cluster members before the cluster, using the DocumentDB API for docdb', () => {
    const [aurora, docs] = parseList('aws-clusters', awsClusters, '', 'eu-west-1')
    const steps = deletePlan(aurora, { finalSnapshot: false, disableProtection: true }, now)
    expect(steps.map((s) => s.title)).toEqual([
      'Turn off deletion protection',
      'Delete instance aurora-1',
      'Delete cluster aurora'
    ])
    expect(steps[0].args({})).toEqual(expect.arrayContaining(['rds', 'modify-db-cluster']))
    expect(steps[2].args({})).toEqual(
      expect.arrayContaining(['delete-db-cluster', '--skip-final-snapshot'])
    )
    const docSteps = deletePlan(docs, { finalSnapshot: false, disableProtection: false }, now)
    expect(docSteps).toHaveLength(1)
    expect(docSteps[0].args({})[0]).toBe('docdb')
  })

  it('deletes Cloud SQL instances and Azure resources', () => {
    const [pg] = parseList('gcp-instances', gcpInstances, '', '')
    const gcp = deletePlan(pg, { finalSnapshot: false, disableProtection: true })
    expect(gcp[0].args({})).toEqual(
      expect.arrayContaining(['instances', 'patch', 'pg-main', '--no-deletion-protection'])
    )
    expect(gcp[1].args({})).toEqual(
      expect.arrayContaining(['sql', 'instances', 'delete', 'pg-main', '--quiet'])
    )

    const [flex] = parseList('azure-postgres', azurePostgres, '', '')
    expect(
      deletePlan(flex, { finalSnapshot: false, disableProtection: false })[0].args({})
    ).toEqual(
      expect.arrayContaining([
        'postgres',
        'flexible-server',
        'delete',
        '--resource-group',
        'rg-data',
        '--yes'
      ])
    )
    const [sql] = parseList('azure-sql', azureSql, '', '')
    expect(
      deletePlan(sql, { finalSnapshot: false, disableProtection: false })[0].args({}).slice(0, 3)
    ).toEqual(['sql', 'server', 'delete'])
    const [account] = parseList('azure-cosmos', cosmosAccounts, '', '')
    const cosmos = deletePlan(account, { finalSnapshot: false, disableProtection: false })
    expect(cosmos[0].title).toBe('Delete account docs-acct')
    expect(stepsScript(cosmos, 'az')).toContain(
      'az cosmosdb delete --resource-group rg-docs --name docs-acct --yes'
    )
  })
})
