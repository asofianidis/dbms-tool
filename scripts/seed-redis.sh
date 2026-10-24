#!/usr/bin/env bash
# Load the e-commerce seed dataset into a Redis container, shaped the way an app keeps data in
# Redis (see scripts/seed-redis/commands.mjs). The target database is FLUSHED first.
#   ./scripts/seed-redis.sh [container] [database] [scale]
#     scale 0.001 ≈ 175k commands, 0.01 ≈ 1.7M (default), 0.1 ≈ 17M and several GB of memory
set -euo pipefail
export MSYS_NO_PATHCONV=1

CONTAINER="${1:-dbms-redis}"
DB="${2:-0}"
SCALE="${3:-0.01}"
# pwd -W gives a native path on Git Bash, where MSYS_NO_PATHCONV would otherwise hand node "/f/..."
HERE="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"

echo "Seeding database $DB in $CONTAINER at scale $SCALE (the database is flushed first)..."
started=$SECONDS
node --no-warnings "$HERE/seed-redis/generate.mjs" --scale "$SCALE" --db "$DB" --flush \
  | docker exec -i "$CONTAINER" redis-cli --pipe
echo "[$((SECONDS - started))s] done: $(docker exec "$CONTAINER" redis-cli -n "$DB" DBSIZE) keys in database $DB"
