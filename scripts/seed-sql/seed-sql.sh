#!/usr/bin/env bash
# Load a production-shaped relational dataset (~75M rows at scale 1) into a SQL database.
#   ./scripts/seed-sql/seed-sql.sh pg|mysql|mssql|sqlite [options]
#     --scale N        multiply row counts (default 1; 0.01 is a quick smoke test)
#     --jobs N         parallel generator workers / bulk loads (default 8)
#     --db NAME        database to (re)create (default acme_prod); for sqlite, the output file
#     --container NAME docker container (defaults: dbms-demo-pg, dbms-mysql, dbms-mssql)
#     --user U --password P   credentials (defaults: demo/demo, root/Dbms_test_pw1, sa/Dbms_test_pw1)
#     --keep           keep the generated CSV files in scripts/seed-sql/.out
# The target database is DROPPED and recreated.
set -euo pipefail
export MSYS_NO_PATHCONV=1

DIALECT="${1:?usage: seed-sql.sh pg|mysql|mssql|sqlite [--scale N] [--jobs N] [--db NAME] [--container NAME]}"
shift
SCALE=1 JOBS=8 DB=acme_prod CONTAINER="" DBUSER="" PASSWORD="" KEEP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --scale) SCALE=$2; shift 2 ;;
    --jobs) JOBS=$2; shift 2 ;;
    --db) DB=$2; shift 2 ;;
    --container) CONTAINER=$2; shift 2 ;;
    --user) DBUSER=$2; shift 2 ;;
    --password) PASSWORD=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

# pwd -W gives a native path on Git Bash, where MSYS_NO_PATHCONV would otherwise hand node "/f/..."
HERE="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
OUT="$HERE/.out/$DIALECT"
gen() { node --no-warnings "$HERE/generate.mjs" --dialect "$DIALECT" --scale "$SCALE" "$@"; }
started=$SECONDS
elapsed() { echo "[$((SECONDS - started))s] $*"; }

if [ "$DIALECT" = sqlite ]; then
  case "$DB" in *.sqlite|*.db) FILE=$DB ;; *) FILE="$HERE/.out/$DB.sqlite" ;; esac
  mkdir -p "$HERE/.out"
  gen --db "$FILE"
  elapsed "wrote $FILE"
  exit 0
fi

# ---------- per-engine client and bulk-load commands ----------
case "$DIALECT" in
  pg)
    CONTAINER=${CONTAINER:-dbms-demo-pg} DBUSER=${DBUSER:-demo} PASSWORD=${PASSWORD:-demo}
    sql() { docker exec -i -e PGPASSWORD="$PASSWORD" "$CONTAINER" psql -q -v ON_ERROR_STOP=1 -U "$DBUSER" "$@"; }
    reset_db() { sql -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"; }
    run_file() { sql -d "$DB" > /dev/null; }
    load_csv() { sql -d "$DB" -c "COPY $1 FROM STDIN WITH (FORMAT csv)" < "$2"; }
    post_prelude="SET maintenance_work_mem = '1GB'; SET max_parallel_maintenance_workers = 4;"
    finish() { sql -d "$DB" -c "VACUUM ANALYZE"; }
    ;;
  mysql)
    CONTAINER=${CONTAINER:-dbms-mysql} DBUSER=${DBUSER:-root} PASSWORD=${PASSWORD:-Dbms_test_pw1}
    sql() { docker exec -i -e MYSQL_PWD="$PASSWORD" "$CONTAINER" mysql --local-infile=1 -u "$DBUSER" "$@"; }
    reset_db() { sql -e "SET GLOBAL local_infile = 1; DROP DATABASE IF EXISTS \`$DB\`; CREATE DATABASE \`$DB\` CHARACTER SET utf8mb4"; }
    run_file() { sql "$DB"; }
    load_csv() {
      sql "$DB" -e "SET foreign_key_checks = 0, unique_checks = 0; LOAD DATA LOCAL INFILE '/dev/stdin' INTO TABLE \`$1\` CHARACTER SET utf8mb4 FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '\"' ESCAPED BY '' LINES TERMINATED BY '\n'" < "$2"
    }
    # foreign keys are added without re-validating the (generated, consistent) rows
    post_prelude="SET foreign_key_checks = 0;"
    finish() { sql "$DB" -e "$(gen --ddl tables | sed -n 's/^CREATE TABLE `\(.*\)` (/ANALYZE TABLE `\1`;/p')" > /dev/null; }
    ;;
  mssql)
    CONTAINER=${CONTAINER:-dbms-mssql} DBUSER=${DBUSER:-sa} PASSWORD=${PASSWORD:-Dbms_test_pw1}
    sql() { docker exec -i "$CONTAINER" /opt/mssql-tools18/bin/sqlcmd -C -b -S localhost -U "$DBUSER" -P "$PASSWORD" "$@"; }
    reset_db() {
      sql -Q "IF DB_ID('$DB') IS NOT NULL BEGIN ALTER DATABASE [$DB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$DB]; END; CREATE DATABASE [$DB]; ALTER DATABASE [$DB] SET RECOVERY SIMPLE;"
    }
    # sqlcmd reports errors on stdout, so keep its output only when it fails
    quiet() { local out; out=$("$@" 2>&1) || { echo "$out" >&2; return 1; }; }
    run_file() { quiet sql -d "$DB"; }
    # BULK INSERT reads server-side files, so the CSVs are copied into the container first
    stage() { docker exec "$CONTAINER" rm -rf /tmp/seed; docker exec "$CONTAINER" mkdir -p /tmp/seed; tar -C "$OUT" -cf - . | docker exec -i "$CONTAINER" tar -C /tmp/seed -xf -; }
    load_csv() {
      # the generator writes these files as UTF-16LE with a BOM (no CODEPAGE support on Linux)
      quiet sql -d "$DB" -Q "SET NOCOUNT ON; BULK INSERT [$1] FROM '/tmp/seed/$1/$(basename "$2")' WITH (FORMAT = 'CSV', DATAFILETYPE = 'widechar', FIELDQUOTE = '\"', FIELDTERMINATOR = ',', ROWTERMINATOR = '\n', KEEPNULLS, KEEPIDENTITY, TABLOCK, BATCHSIZE = 250000)"
    }
    post_prelude="SET NOCOUNT ON;"
    finish() { docker exec "$CONTAINER" rm -rf /tmp/seed; quiet sql -d "$DB" -Q "EXEC sp_updatestats"; }
    ;;
  *) echo "dialect must be pg, mysql, mssql or sqlite" >&2; exit 2 ;;
esac

docker inspect "$CONTAINER" > /dev/null || { echo "container $CONTAINER not found (see scripts/test-databases.sh)" >&2; exit 1; }

elapsed "generating CSVs (scale $SCALE, $JOBS workers) into $OUT"
gen --out "$OUT" --jobs "$JOBS"

elapsed "recreating database $DB in $CONTAINER"
reset_db
gen --ddl tables | run_file
[ "$DIALECT" = mssql ] && stage

elapsed "bulk loading"
export -f load_csv sql $(declare -F quiet > /dev/null && echo quiet)
export DB CONTAINER DBUSER PASSWORD
# largest files first so the parallel tail is short
find "$OUT" -name '*.csv' -printf '%s %p\n' | sort -rn | cut -d' ' -f2- | \
  xargs -P "$JOBS" -I{} bash -c 'f="$1"; t=$(basename "$(dirname "$f")"); load_csv "$t" "$f" || { echo "load failed: $f" >&2; exit 255; }' _ {}

elapsed "building keys, indexes, foreign keys and views"
{ echo "$post_prelude"; gen --ddl post; } | run_file
finish
[ -z "$KEEP" ] && rm -rf "$OUT"
elapsed "done"
