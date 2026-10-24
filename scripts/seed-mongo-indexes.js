// Indexes for the seed-mongo.js dataset, run inside mongosh by seed-mongo.sh (and by the app's
// "Seed sample database", which records these calls with a stand-in for db).
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
