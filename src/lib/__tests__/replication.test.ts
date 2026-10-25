import { describe, expect, it } from 'vitest'
import type { ResultSet } from '../api'
import {
  channelHealth,
  connectedReplicas,
  formatLag,
  mysqlVersion,
  normalizeColumn,
  parseBinlogStatus,
  parseDumpThreads,
  parseReplicaHosts,
  parseReplicaStatus,
  parseReplicationVars,
  replicaActionSql,
  replicationPrivilegeHint,
  replicationQueries
} from '../replication'
import {
  MARIADB_ALL_REPLICAS,
  MARIADB_REPLICA_HOSTS,
  MYSQL_BINARY_LOG_STATUS,
  MYSQL_REPLICA,
  MYSQL_REPLICA_ERROR,
  MYSQL_REPLICAS
} from './replication-fixtures'

const info = (product: string, version: string) => ({ product, version })
const MARIADB = info('MariaDB 11.8.3', '11.8.3-MariaDB-ubu2404 mariadb.org binary distribution')
const MARIADB_104 = info('MariaDB 10.4.34', '10.4.34-MariaDB-log')
const MARIADB_1052 = info('MariaDB 10.5.1', '10.5.1-MariaDB')
const MYSQL = info('MySQL 8.4.6', '8.4.6 MySQL Community Server - GPL')
const MYSQL_80 = info('MySQL 8.0.21', '8.0.21 MySQL Community Server - GPL')
const MYSQL_57 = info('MySQL 5.7.44', '5.7.44-log MySQL Community Server (GPL)')

function set(captured: { columns: string[]; rows: (string | null)[][] }): ResultSet {
  return {
    columns: captured.columns.map((name) => ({ name, typeName: 'VARCHAR' })),
    rows: captured.rows,
    rowCount: captured.rows.length,
    truncated: false
  }
}

describe('replication statements', () => {
  it('uses the REPLICA spellings where the server has them', () => {
    expect(replicationQueries(MARIADB)).toMatchObject({
      replicas: 'SHOW ALL REPLICAS STATUS',
      binlog: 'SHOW BINLOG STATUS',
      hosts: 'SHOW REPLICA HOSTS'
    })
    expect(replicationQueries(MARIADB).variables).toMatch(
      /@@gtid_slave_pos[\s\S]*@@gtid_binlog_pos/
    )
    expect(replicationQueries(MYSQL)).toMatchObject({
      replicas: 'SHOW REPLICA STATUS',
      binlog: 'SHOW BINARY LOG STATUS',
      hosts: 'SHOW REPLICAS'
    })
    expect(replicationQueries(MYSQL).variables).toMatch(/@@gtid_executed/)
  })

  it('falls back to the SLAVE / MASTER spellings on older servers', () => {
    expect(replicationQueries(MARIADB_104)).toMatchObject({
      replicas: 'SHOW ALL SLAVES STATUS',
      binlog: 'SHOW MASTER STATUS',
      hosts: 'SHOW SLAVE HOSTS'
    })
    // SHOW ALL REPLICAS came in 10.5.1, SHOW BINLOG STATUS in 10.5.2
    expect(replicationQueries(MARIADB_1052)).toMatchObject({
      replicas: 'SHOW ALL REPLICAS STATUS',
      binlog: 'SHOW MASTER STATUS'
    })
    expect(replicationQueries(MYSQL_80)).toMatchObject({
      replicas: 'SHOW SLAVE STATUS',
      binlog: 'SHOW MASTER STATUS',
      hosts: 'SHOW SLAVE HOSTS'
    })
    expect(replicationQueries(info('MySQL 8.0.36', '8.0.36'))).toMatchObject({
      replicas: 'SHOW REPLICA STATUS',
      binlog: 'SHOW MASTER STATUS'
    })
  })

  it('reads the MySQL version, not MariaDB', () => {
    expect(mysqlVersion(MYSQL_57)).toEqual([5, 7, 44])
    expect(mysqlVersion(MARIADB)).toBeNull()
  })

  it('names the connection or channel to start and stop', () => {
    expect(replicaActionSql(MARIADB, 'stop', 'crm')).toBe("STOP REPLICA 'crm'")
    expect(replicaActionSql(MARIADB, 'start', '', 'sql')).toBe('START REPLICA SQL_THREAD')
    expect(replicaActionSql(MARIADB, 'stop', null)).toBe('STOP ALL REPLICAS')
    expect(replicaActionSql(MARIADB_104, 'start', "o'brien", 'io')).toBe(
      "START SLAVE 'o''brien' IO_THREAD"
    )
    expect(replicaActionSql(MARIADB_104, 'start', null)).toBe('START ALL SLAVES')
    expect(replicaActionSql(MYSQL, 'stop', 'main', 'sql')).toBe(
      "STOP REPLICA SQL_THREAD FOR CHANNEL 'main'"
    )
    expect(replicaActionSql(MYSQL, 'start', null)).toBe('START REPLICA')
    expect(replicaActionSql(MYSQL_57, 'start', '')).toBe("START SLAVE FOR CHANNEL ''")
  })
})

describe('replica status', () => {
  it('normalizes MASTER/SLAVE and SOURCE/REPLICA column names alike', () => {
    expect(normalizeColumn('Seconds_Behind_Master')).toBe('seconds_behind_source')
    expect(normalizeColumn('Seconds_Behind_Source')).toBe('seconds_behind_source')
    expect(normalizeColumn('Slave_IO_Running')).toBe(normalizeColumn('Replica_IO_Running'))
    expect(normalizeColumn('Relay_Master_Log_File')).toBe('relay_source_log_file')
  })

  it('reads every MariaDB connection from SHOW ALL REPLICAS STATUS', () => {
    const [main, crm] = parseReplicaStatus(set(MARIADB_ALL_REPLICAS))
    expect(main).toMatchObject({
      name: '',
      sourceHost: 'repl-mdb-primary',
      sourcePort: '3306',
      sourceUser: 'repl',
      io: 'running',
      sql: 'running',
      ioState: 'Waiting for master to send event',
      sqlState: 'Slave has read all relay log; waiting for more updates',
      lagSeconds: 0,
      sourceLogFile: 'mysql-bin.000002',
      relayLogFile: 'relay-bin.000002',
      relaySourceLogFile: 'mysql-bin.000002',
      ioError: null,
      sqlError: null,
      usingGtid: 'Slave_Pos',
      gtidIoPos: '0-1-7',
      retrievedGtidSet: null
    })
    expect(channelHealth(main)).toBe('ok')
    expect(crm).toMatchObject({
      name: 'crm',
      sourceHost: 'repl-mdb-primary2',
      io: 'running',
      sql: 'stopped',
      lagSeconds: null,
      ioError: null,
      usingGtid: 'Slave_Pos'
    })
    expect(crm.sqlError).toEqual({
      number: 1396,
      message: expect.stringMatching(/^Error 'Operation CREATE USER failed/),
      at: null
    })
    expect(channelHealth(crm)).toBe('error')
  })

  it('reads a MySQL channel with its GTID sets and error timestamp', () => {
    const [main] = parseReplicaStatus(set(MYSQL_REPLICA))
    expect(main).toMatchObject({
      name: 'main',
      sourceHost: 'repl-my-primary',
      io: 'running',
      sql: 'running',
      lagSeconds: 0,
      sourceServerId: '1',
      usingGtid: 'Auto_Position',
      gtidIoPos: null,
      retrievedGtidSet: '2b7a8a19-d070-11f1-a253-0242ac120004:1-10',
      // The set wraps after the comma in the server's output
      executedGtidSet:
        '2b7a8a19-d070-11f1-a253-0242ac120004:1-10,2c232cc6-d070-11f1-a338-0242ac120005:1-5'
    })
    const [failed] = parseReplicaStatus(set(MYSQL_REPLICA_ERROR))
    expect(failed.sql).toBe('stopped')
    expect(failed.lagSeconds).toBeNull()
    expect(failed.sqlError).toMatchObject({ number: 1062, at: '2026-10-25 12:36:04' })
    expect(failed.ioError).toBeNull()
  })

  it('flags stopped, connecting and lagging channels', () => {
    const [base] = parseReplicaStatus(set(MYSQL_REPLICA))
    expect(channelHealth({ ...base, io: 'connecting' })).toBe('warning')
    expect(channelHealth({ ...base, lagSeconds: 59 })).toBe('ok')
    expect(channelHealth({ ...base, lagSeconds: 120 })).toBe('warning')
    // A deliberate delay isn't lag
    expect(channelHealth({ ...base, lagSeconds: 120, delaySeconds: 100 })).toBe('ok')
    expect(formatLag(null)).toBe('—')
    expect(formatLag(42)).toBe('42 s')
    expect(formatLag(185)).toBe('3 min 5 s')
    expect(formatLag(7800)).toBe('2 h 10 min')
  })

  it('reads nothing from a server that is not a replica', () => {
    expect(parseReplicaStatus(set({ columns: MYSQL_REPLICA.columns, rows: [] }))).toEqual([])
    expect(parseReplicaStatus(null)).toEqual([])
  })
})

describe('primary status', () => {
  it('reads the binary log position and registered replicas', () => {
    expect(parseBinlogStatus(set(MYSQL_BINARY_LOG_STATUS))).toEqual({
      file: 'mysql-bin.000003',
      position: '2222',
      executedGtidSet: '2b7a8a19-d070-11f1-a253-0242ac120004:1-13'
    })
    expect(parseBinlogStatus(set({ columns: ['File', 'Position'], rows: [] }))).toBeNull()
    expect(parseReplicaHosts(set(MARIADB_REPLICA_HOSTS))).toEqual([
      { serverId: '2', host: '172.18.0.3', port: '3306', sourceId: '1', uuid: null }
    ])
    expect(parseReplicaHosts(set(MYSQL_REPLICAS))).toEqual([
      {
        serverId: '2',
        host: null,
        port: '3306',
        sourceId: '1',
        uuid: '2c232cc6-d070-11f1-a338-0242ac120005'
      }
    ])
  })

  it('reads server variables and dump threads', () => {
    const vars = parseReplicationVars(
      set({
        columns: [
          'server_id',
          'log_bin',
          'binlog_format',
          'read_only',
          'gtid_slave_pos',
          'gtid_current_pos',
          'gtid_binlog_pos'
        ],
        rows: [['1', '1', 'ROW', '0', '', '0-1-5', '0-1-5']]
      })
    )
    expect(vars).toMatchObject({
      serverId: '1',
      logBin: true,
      binlogFormat: 'ROW',
      readOnly: false,
      gtidSlavePos: null,
      gtidBinlogPos: '0-1-5'
    })
    expect(
      parseDumpThreads(
        set({
          columns: ['id', 'user', 'host', 'seconds', 'state'],
          rows: [['9', 'repl', '172.18.0.5:57340', '45', 'Source has sent all binlog to replica']]
        })
      )
    ).toEqual([
      {
        id: '9',
        user: 'repl',
        host: '172.18.0.5:57340',
        seconds: 45,
        state: 'Source has sent all binlog to replica'
      }
    ])
  })
})

describe('connected replicas', () => {
  const dump = (id: string, host: string) => ({
    id,
    user: 'repl',
    host,
    seconds: 45,
    state: 'Source has sent all binlog to replica; waiting for more updates'
  })

  it('pairs registered replicas with their dump threads by address', () => {
    const hosts = parseReplicaHosts(set(MARIADB_REPLICA_HOSTS))
    expect(
      connectedReplicas(hosts, [dump('7', '172.18.0.9:4100'), dump('5', '172.18.0.3:37834')])
    ).toEqual([
      expect.objectContaining({ host: '172.18.0.3:3306', serverId: '2', thread: '5 (repl)' }),
      expect.objectContaining({ host: '172.18.0.9:4100', serverId: null, thread: '7 (repl)' })
    ])
  })

  it('pairs a lone replica without report_host with the lone dump thread', () => {
    const hosts = parseReplicaHosts(set(MYSQL_REPLICAS))
    expect(connectedReplicas(hosts, [dump('9', '172.18.0.5:57340')])).toEqual([
      {
        host: '172.18.0.5:3306',
        serverId: '2',
        thread: '9 (repl)',
        seconds: 45,
        state: 'Source has sent all binlog to replica; waiting for more updates'
      }
    ])
    expect(connectedReplicas([], [])).toEqual([])
  })
})

describe('privilege hints', () => {
  it('names the privilege the server asked for', () => {
    expect(
      replicationPrivilegeHint(
        'Access denied; you need (at least one of) the SUPER, REPLICATION CLIENT privilege(s) for this operation',
        false
      )
    ).toMatch(
      /needs the SUPER, REPLICATION CLIENT privilege\. .*GRANT REPLICATION CLIENT ON \*\.\*/
    )
    expect(
      replicationPrivilegeHint(
        'Access denied; you need (at least one of) the SLAVE MONITOR privilege(s) for this operation',
        true
      )
    ).toMatch(/GRANT SLAVE MONITOR ON/)
    expect(replicationPrivilegeHint('Access denied for user', true)).toMatch(/SLAVE MONITOR/)
    expect(replicationPrivilegeHint('Lost connection to server', true)).toBeNull()
  })
})
