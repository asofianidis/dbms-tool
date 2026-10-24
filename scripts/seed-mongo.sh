#!/usr/bin/env bash
# Load a production-shaped dataset (~25M docs) into a Mongo container using parallel mongosh workers.
#   ./scripts/seed-mongo.sh [container] [database] [parallelism]
#   INDEX_ONLY=1 ./scripts/seed-mongo.sh ...   rebuild indexes on an already-loaded database
set -euo pipefail
export MSYS_NO_PATHCONV=1

CONTAINER="${1:-youthful_khorana}"
DB="${2:-acme_prod}"
PAR="${3:-10}"
# pwd -W gives a native path on Git Bash, where MSYS_NO_PATHCONV would otherwise hand docker "/f/..."
HERE="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
URI="mongodb://localhost:27017/$DB"

if [ -z "${INDEX_ONLY:-}" ]; then
docker cp "$HERE/seed-mongo.js" "$CONTAINER:/tmp/seed-mongo.js"

echo "Dropping $DB and creating collections..."
docker exec "$CONTAINER" mongosh --quiet "$URI" --eval '
  db.dropDatabase();
  db.createCollection("metrics", { timeseries: { timeField: "ts", metaField: "meta", granularity: "minutes" } });
'

# coll total chunk
jobs() {
  local coll=$1 total=$2 chunk=$3 s
  for ((s = 0; s < total; s += chunk)); do
    echo "$coll $s $((s + chunk < total ? s + chunk : total))"
  done
}
{
  jobs events 10000000 500000
  jobs orders 5000000 250000
  jobs reviews 2000000 250000
  jobs users 1000000 125000
  jobs tickets 500000 125000
  jobs metrics 200 20
  jobs inventory 100000 25000
  jobs products 100000 25000
  jobs warehouses 1 1
} | xargs -P "$PAR" -L 1 sh -c \
  'docker exec -e COLL=$0 -e START=$1 -e END=$2 '"$CONTAINER"' mongosh --quiet '"$URI"' /tmp/seed-mongo.js'

fi

echo "Building indexes..."
docker exec "$CONTAINER" mongosh --quiet "$URI" --eval '
  db.users.createIndexes([{ country: 1, tier: 1 }, { createdAt: -1 }]);
  db.users.createIndex({ email: 1 }, { unique: true, name: "email_unique" });
  db.products.createIndex({ sku: 1 }, { unique: true });
  db.products.createIndexes([{ "category.l1": 1, price: -1 }, { brand: 1 }, { tags: 1 }]);
  db.orders.createIndex({ orderNumber: 1 }, { unique: true });
  db.orders.createIndexes([{ customerId: 1, createdAt: -1 }, { status: 1, createdAt: -1 }, { createdAt: -1 }, { "items.productId": 1 }]);
  db.reviews.createIndexes([{ productId: 1, createdAt: -1 }, { userId: 1 }]);
  db.reviews.createIndex({ title: "text", body: "text" }, { name: "review_text", language_override: "textLanguage" });
  db.events.createIndexes([{ ts: -1 }, { userId: 1, ts: -1 }, { type: 1, ts: -1 }]);
  db.events.createIndex({ "geo.loc": "2dsphere" });
  db.tickets.createIndexes([{ customerId: 1 }, { orderId: 1 }, { status: 1, priority: 1 }, { "assignee.id": 1, createdAt: -1 }]);
  db.inventory.createIndex({ productId: 1, warehouseId: 1 }, { unique: true });
  db.inventory.createIndex({ warehouseId: 1, onHand: 1 });
  db.warehouses.createIndex({ location: "2dsphere" });
  // left unindexed on purpose: orders.totals.totalUsd, orders.shipping.address.city, events.props.*, reviews.rating
  db.getCollectionNames().sort().forEach((c) => {
    const s = db.runCommand({ collStats: c });
    print(c.padEnd(12), String(s.count).padStart(10), "docs", (s.size / 1e9).toFixed(2).padStart(7), "GB data", (s.storageSize / 1e9).toFixed(2).padStart(6), "GB disk");
  });
'
