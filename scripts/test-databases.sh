#!/usr/bin/env bash
# Starts throwaway database servers for the live integration tests:
#   ./scripts/test-databases.sh up      start containers
#   ./scripts/test-databases.sh env     print the DBMS_TEST_* variables
#   ./scripts/test-databases.sh down    remove containers
set -euo pipefail

PASSWORD='Dbms_test_pw1'

case "${1:-up}" in
  up)
    docker run -d --name dbms-pg -e POSTGRES_PASSWORD="$PASSWORD" -p 55432:5432 postgres:17-alpine
    docker run -d --name dbms-mysql -e MYSQL_ROOT_PASSWORD="$PASSWORD" -p 53306:3306 mysql:8.4
    docker run -d --name dbms-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD="$PASSWORD" -p 51433:1433 mcr.microsoft.com/mssql/server:2022-latest
    docker run -d --name dbms-babelfish -p 51434:1433 jonathanpotts/babelfishpg
    docker run -d --name dbms-mongo -p 57017:27017 mongo:8
    docker run -d --name dbms-redis -p 56379:6379 redis/redis-stack-server:latest
    ;;
  env)
    echo "export DBMS_TEST_PG=localhost:55432:postgres:$PASSWORD"
    echo "export DBMS_TEST_MYSQL=localhost:53306:root:$PASSWORD"
    echo "export DBMS_TEST_MSSQL=localhost:51433:sa:$PASSWORD"
    echo "export DBMS_TEST_BABELFISH=localhost:51434:babelfish_user:12345678"
    echo "export DBMS_TEST_MONGO=mongodb://localhost:57017"
    echo "export DBMS_TEST_REDIS=redis://localhost:56379"
    ;;
  down)
    docker rm -f dbms-pg dbms-mysql dbms-mssql dbms-babelfish dbms-mongo dbms-redis
    ;;
esac
