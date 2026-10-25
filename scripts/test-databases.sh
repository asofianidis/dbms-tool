#!/usr/bin/env bash
# Starts throwaway database servers for the live integration tests:
#   ./scripts/test-databases.sh up   [engine...]   start containers
#   ./scripts/test-databases.sh info [engine...]   print connection details for each server
#   ./scripts/test-databases.sh env  [engine...]   print the DBMS_TEST_* variables
#   ./scripts/test-databases.sh down [engine...]   remove containers
#
# With no engines every server is used. Engines: pg mysql mariadb mssql babelfish mongo redis
# Example: ./scripts/test-databases.sh up pg redis
set -euo pipefail

PASSWORD='Dbms_test_pw1'
ENGINES=(pg mysql mariadb mssql babelfish mongo redis)

usage() {
  echo "usage: $0 [up|info|env|down] [engine...]" >&2
  echo "engines: ${ENGINES[*]}" >&2
  exit 1
}

start_engine() {
  case "$1" in
    pg) docker run -d --name dbms-pg -e POSTGRES_PASSWORD="$PASSWORD" -p 55432:5432 postgres:17-alpine ;;
    mysql) docker run -d --name dbms-mysql -e MYSQL_ROOT_PASSWORD="$PASSWORD" -p 53306:3306 mysql:8.4 ;;
    mariadb) docker run -d --name dbms-mariadb -e MARIADB_ROOT_PASSWORD="$PASSWORD" -p 53307:3306 mariadb:11.8 ;;
    mssql) docker run -d --name dbms-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="$PASSWORD" -p 51433:1433 mcr.microsoft.com/mssql/server:2022-latest ;;
    babelfish) docker run -d --name dbms-babelfish -p 51434:1433 jonathanpotts/babelfishpg ;;
    mongo) docker run -d --name dbms-mongo -p 57017:27017 mongo:8 ;;
    redis) docker run -d --name dbms-redis -p 56379:6379 redis/redis-stack-server:latest ;;
  esac
}

info_row() {
  case "$1" in
    pg)        echo "  PostgreSQL 17     55432  postgres        $PASSWORD   postgres" ;;
    mysql)     echo "  MySQL 8.4         53306  root            $PASSWORD   -" ;;
    mariadb)   echo "  MariaDB 11.8      53307  root            $PASSWORD   -" ;;
    mssql)     echo "  SQL Server 2022   51433  sa              $PASSWORD   master" ;;
    babelfish) echo "  Babelfish (TDS)   51434  babelfish_user  12345678        master" ;;
    mongo)     echo "  MongoDB 8         57017  (no auth)       -               -" ;;
    redis)     echo "  Redis Stack       56379  (no auth)       -               -" ;;
  esac
}

connection_string() {
  case "$1" in
    pg) echo "  postgresql://postgres:$PASSWORD@localhost:55432/postgres" ;;
    mysql) echo "  mysql://root:$PASSWORD@localhost:53306" ;;
    mariadb) echo "  mysql://root:$PASSWORD@localhost:53307" ;;
    mssql) echo "  sqlserver://localhost:51433;user=sa;password=$PASSWORD;database=master;trustServerCertificate=true" ;;
    babelfish) echo "  sqlserver://localhost:51434;user=babelfish_user;password=12345678;database=master;encrypt=false" ;;
    mongo) echo "  mongodb://localhost:57017" ;;
    redis) echo "  redis://localhost:56379" ;;
  esac
}

env_var() {
  case "$1" in
    pg) echo "export DBMS_TEST_PG=localhost:55432:postgres:$PASSWORD" ;;
    mysql) echo "export DBMS_TEST_MYSQL=localhost:53306:root:$PASSWORD" ;;
    mariadb) echo "export DBMS_TEST_MARIADB=localhost:53307:root:$PASSWORD" ;;
    mssql) echo "export DBMS_TEST_MSSQL=localhost:51433:sa:$PASSWORD" ;;
    babelfish) echo "export DBMS_TEST_BABELFISH=localhost:51434:babelfish_user:12345678" ;;
    mongo) echo "export DBMS_TEST_MONGO=mongodb://localhost:57017" ;;
    redis) echo "export DBMS_TEST_REDIS=redis://localhost:56379" ;;
  esac
}

print_info() {
  echo "Test database connections (host: localhost)"
  echo
  echo "  Engine            Port   User            Password        Database"
  for engine in "${SELECTED[@]}"; do info_row "$engine"; done
  echo
  echo "Connection strings:"
  for engine in "${SELECTED[@]}"; do connection_string "$engine"; done
}

COMMAND="${1:-up}"
shift || true

if [ $# -eq 0 ]; then
  SELECTED=("${ENGINES[@]}")
else
  SELECTED=()
  for engine in "$@"; do
    [[ " ${ENGINES[*]} " == *" $engine "* ]] || { echo "unknown engine: $engine" >&2; usage; }
    SELECTED+=("$engine")
  done
fi

case "$COMMAND" in
  up)
    for engine in "${SELECTED[@]}"; do start_engine "$engine"; done
    echo
    print_info
    ;;
  info)
    print_info
    ;;
  env)
    for engine in "${SELECTED[@]}"; do env_var "$engine"; done
    ;;
  down)
    docker rm -f "${SELECTED[@]/#/dbms-}"
    ;;
  *)
    usage
    ;;
esac
