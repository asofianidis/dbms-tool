// One portable schema definition rendered to Postgres, MySQL, SQL Server and SQLite DDL.
// Column types: pk (bigint identity), int, bigint, smallint, bool, money, "dec P S", real, "str N",
// "char N", text, json, ts, date, ip, tags (Postgres text[]), "enum NAME". A trailing "?" means nullable.
// Column order here is the CSV column order.

export const ENUMS = {
  order_status: ["pending", "paid", "processing", "shipped", "delivered", "cancelled", "return_requested", "returned", "refunded", "partially_refunded", "lost_in_transit", "payment_failed"],
  customer_tier: ["standard", "silver", "gold", "platinum"],
  ticket_priority: ["low", "normal", "high", "urgent"],
};

export const TABLES = {
  countries: { pk: ["code"], cols: { code: "char 2", name: "str 60", currency: "char 3", usd_rate: "dec 12 6", vat_rate: "dec 5 4", language: "str 5", region: "str 8" } },
  warehouses: { pk: ["id"], cols: { id: "int", code: "str 10", name: "str 80", city: "str 60", country_code: "char 2", lat: "dec 9 6", lng: "dec 9 6", capacity_pallets: "int", opened_on: "date", features: "json" },
    fk: { country_code: "countries" }, unique: [["code"]] },
  categories: { pk: ["id"], cols: { id: "int", parent_id: "int?", name: "str 60", slug: "str 120", path: "str 200", depth: "smallint" },
    fk: { parent_id: "categories" }, unique: [["slug"]] },
  brands: { pk: ["id"], cols: { id: "int", name: "str 60", country_code: "char 2", founded_year: "smallint", is_private_label: "bool" }, fk: { country_code: "countries" } },
  support_agents: { pk: ["id"], cols: { id: "int", name: "str 80", team: "str 30", email: "str 120", hired_on: "date", is_active: "bool" } },
  customers: { pk: ["id"], cols: {
      id: "pk", email: "str 160", first_name: "str 60", last_name: "str 60", display_name: "str 80?", status: "str 24", tier: "enum customer_tier",
      country_code: "char 2", locale: "str 10", schema_version: "smallint", legacy_phone: "str 20?", mobile_phone: "str 24?", email_verified: "bool",
      mfa_enabled: "bool", marketing_email: "bool", marketing_sms: "bool", preferences: "json", referred_by: "bigint?", date_of_birth: "date?",
      created_at: "ts", last_login_at: "ts?", deleted_at: "ts?" },
    fk: { country_code: "countries", referred_by: "customers" }, unique: [["email"]], idx: [["country_code", "tier"], ["created_at"], ["last_name", "first_name"]] },
  customer_addresses: { pk: ["id"], cols: {
      id: "pk", customer_id: "bigint", label: "str 20", line1: "str 120", line2: "str 60?", city: "str 60", region: "str 20", postal_code: "str 12",
      country_code: "char 2", lat: "dec 9 6", lng: "dec 9 6", is_default: "bool", created_at: "ts" },
    fk: { customer_id: "customers", country_code: "countries" }, idx: [["customer_id"], ["country_code", "city"]] },
  customer_tags: { pk: ["customer_id", "tag"], cols: { customer_id: "bigint", tag: "str 30", added_at: "ts" }, fk: { customer_id: "customers" }, idx: [["tag"]] },
  products: { pk: ["id"], cols: {
      id: "pk", sku: "str 20", name: "str 160", slug: "str 200", brand_id: "int", category_id: "int", status: "str 20", price: "money", cost: "money",
      compare_at_price: "money?", weight_kg: "dec 8 2", attributes: "json", tags: "tags", rating_avg: "dec 3 2?", rating_count: "int",
      supplier_name: "str 120", supplier_country: "char 2", lead_time_days: "smallint", is_hazmat: "bool", description: "text", created_at: "ts", updated_at: "ts" },
    fk: { brand_id: "brands", category_id: "categories" }, unique: [["sku"]], idx: [["category_id", "price"], ["brand_id"], ["status"]] },
  product_variants: { pk: ["id"], cols: { id: "pk", product_id: "bigint", sku: "str 40", color: "str 20", size: "str 6", price_delta: "money", barcode: "str 20" },
    fk: { product_id: "products" }, unique: [["sku"]], idx: [["product_id"]] },
  inventory: { pk: ["product_id", "warehouse_id"], cols: {
      product_id: "bigint", warehouse_id: "int", on_hand: "int", reserved: "int", incoming: "int", reorder_point: "int", bin: "str 16",
      unit_cost_usd: "money", last_counted_at: "ts", updated_at: "ts" },
    fk: { product_id: "products", warehouse_id: "warehouses" }, idx: [["warehouse_id", "on_hand"]] },
  orders: { pk: ["id"], cols: {
      id: "pk", order_number: "str 20", customer_id: "bigint", status: "enum order_status", channel: "str 16?", currency: "char 3",
      subtotal: "money", discount: "money", shipping_fee: "money", tax: "money", total: "money", total_usd: "money", coupon_code: "str 20?",
      item_count: "int", warehouse_id: "int", shipping_method: "str 16", ship_city: "str 60", ship_region: "str 20", ship_postal_code: "str 12",
      ship_country: "char 2", is_b2b: "bool", po_number: "str 20?", gift_message: "str 500?", flags: "json?", attribution: "json?",
      schema_version: "smallint", created_at: "ts", updated_at: "ts" },
    fk: { customer_id: "customers", warehouse_id: "warehouses", ship_country: "countries" },
    unique: [["order_number"]], idx: [["customer_id", "created_at"], ["status", "created_at"], ["created_at"]] },
  order_items: { pk: ["id"], cols: {
      id: "pk", order_id: "bigint", line_no: "smallint", product_id: "bigint", sku: "str 20", product_name: "str 160", qty: "int",
      unit_price: "money", discount: "money", line_total: "money", variant_size: "str 6?", variant_color: "str 20?", gift_wrap: "bool" },
    fk: { order_id: "orders", product_id: "products" }, idx: [["order_id"], ["product_id"]] },
  order_status_history: { pk: ["id"], cols: { id: "pk", order_id: "bigint", status: "enum order_status", changed_by: "str 20", changed_at: "ts" },
    fk: { order_id: "orders" }, idx: [["order_id", "changed_at"]] },
  payments: { pk: ["id"], cols: {
      id: "pk", order_id: "bigint", attempt: "smallint", method: "str 20", provider: "str 20", status: "str 16", amount: "money", currency: "char 3",
      card_brand: "str 16?", card_last4: "char 4?", decline_code: "str 30?", risk_score: "dec 5 2?", transaction_id: "str 40", created_at: "ts" },
    fk: { order_id: "orders" }, unique: [["transaction_id"]], idx: [["order_id"], ["status", "created_at"]] },
  refunds: { pk: ["id"], cols: { id: "pk", order_id: "bigint", payment_id: "bigint?", amount: "money", reason: "str 30", created_at: "ts" },
    fk: { order_id: "orders", payment_id: "payments" }, idx: [["order_id"]] },
  shipments: { pk: ["id"], cols: {
      id: "pk", order_id: "bigint", carrier: "str 30", tracking_number: "str 30", status: "str 16", shipped_at: "ts", delivered_at: "ts?",
      weight_kg: "dec 8 2", cost_usd: "money" },
    fk: { order_id: "orders" }, idx: [["order_id"], ["tracking_number"]] },
  reviews: { pk: ["id"], cols: {
      id: "pk", product_id: "bigint", customer_id: "bigint", rating: "smallint", title: "str 80", body: "text", verified_purchase: "bool",
      helpful_votes: "int", language: "str 5", status: "str 24", image_count: "smallint", seller_response: "str 500?", seller_responded_at: "ts?", created_at: "ts" },
    fk: { product_id: "products", customer_id: "customers" }, idx: [["product_id", "created_at"], ["customer_id"]] },
  events: { pk: ["id"], cols: {
      id: "pk", ts: "ts", type: "str 24", customer_id: "bigint?", anonymous_id: "char 16", session_id: "str 12", page_path: "str 200",
      referrer: "str 200?", device_type: "str 10", os: "str 16", browser: "str 20", app_version: "str 12?", country_code: "char 2", city: "str 60",
      lat: "dec 9 6", lng: "dec 9 6", ip: "ip", duration_ms: "int?", props: "json?", utm: "json?", is_bot: "bool" },
    fk: { customer_id: "customers", country_code: "countries" }, idx: [["ts"], ["customer_id", "ts"], ["type", "ts"], ["session_id"]] },
  tickets: { pk: ["id"], cols: {
      id: "pk", ticket_number: "int", customer_id: "bigint", order_id: "bigint?", subject: "str 200", category: "str 30", priority: "enum ticket_priority",
      status: "str 20", channel: "str 12", assignee_id: "int?", message_count: "int", sla_due_at: "ts", first_response_at: "ts?", sla_breached: "bool",
      csat_score: "smallint?", tags: "tags", context: "json?", created_at: "ts", updated_at: "ts", resolved_at: "ts?" },
    fk: { customer_id: "customers", order_id: "orders", assignee_id: "support_agents" },
    unique: [["ticket_number"]], idx: [["customer_id"], ["order_id"], ["status", "priority"], ["assignee_id", "created_at"]] },
  ticket_messages: { pk: ["id"], cols: {
      id: "pk", ticket_id: "bigint", seq: "smallint", author_type: "str 10", agent_id: "int?", body: "text", is_internal: "bool",
      attachment_count: "smallint", created_at: "ts" },
    fk: { ticket_id: "tickets", agent_id: "support_agents" }, idx: [["ticket_id", "seq"]] },
  hosts: { pk: ["id"], cols: { id: "int", hostname: "str 60", service: "str 30", region: "str 20", az: "str 20", instance_type: "str 20", env: "str 10" }, unique: [["hostname"]] },
  metrics: { pk: ["host_id", "ts"], cols: {
      host_id: "int", ts: "ts", cpu_pct: "dec 5 2", mem_pct: "dec 5 2", rps: "int", latency_p50_ms: "dec 9 2", latency_p95_ms: "dec 9 2",
      latency_p99_ms: "dec 9 2", errors_5xx: "int", gc_pause_ms: "dec 9 2" },
    fk: { host_id: "hosts" } },
};
// Leave a few hot filter columns unindexed on purpose for slow-query testing:
// orders.total_usd, orders.ship_city, orders.coupon_code, reviews.rating, events.props, events.country_code.

export const COLUMNS = Object.fromEntries(Object.entries(TABLES).map(([t, d]) => [t, Object.keys(d.cols)]));

// Postgres: events is range-partitioned by month, so its key must include ts.
const PG_PARTITIONED = { events: { key: "ts", pk: ["id", "ts"], from: Date.UTC(2026, 3, 1), months: 8 } };

const q = { pg: (n) => `"${n}"`, mysql: (n) => `\`${n}\``, mssql: (n) => `[${n}]`, sqlite: (n) => `"${n}"` };
const enumList = (name) => ENUMS[name].map((v) => `'${v}'`).join(", ");

function columnType(d, col, spec) {
  const [type, a, b] = spec.replace("?", "").split(" ");
  const T = {
    pg: { pk: "bigint GENERATED BY DEFAULT AS IDENTITY", int: "integer", bigint: "bigint", smallint: "smallint", bool: "boolean", money: "numeric(12,2)", dec: `numeric(${a},${b})`, real: "double precision", str: `varchar(${a})`, char: `char(${a})`, text: "text", json: "jsonb", ts: "timestamptz", date: "date", ip: "inet", tags: "text[]", enum: a },
    mysql: { pk: "bigint AUTO_INCREMENT", int: "int", bigint: "bigint", smallint: "smallint", bool: "boolean", money: "decimal(12,2)", dec: `decimal(${a},${b})`, real: "double", str: `varchar(${a})`, char: `char(${a})`, text: "text", json: "json", ts: "datetime(3)", date: "date", ip: "varchar(45)", tags: "json", enum: `enum(${type === "enum" ? enumList(a) : ""})` },
    mssql: { pk: "bigint IDENTITY(1,1)", int: "int", bigint: "bigint", smallint: "smallint", bool: "bit", money: "decimal(12,2)", dec: `decimal(${a},${b})`, real: "float", str: `nvarchar(${a})`, char: `char(${a})`, text: "nvarchar(max)", json: "nvarchar(max)", ts: "datetime2(3)", date: "date", ip: "varchar(45)", tags: "nvarchar(400)", enum: `varchar(24) CHECK (${q.mssql(col)} IN (${type === "enum" ? enumList(a) : ""}))` },
    sqlite: { pk: "INTEGER", int: "INTEGER", bigint: "INTEGER", smallint: "INTEGER", bool: "INTEGER", money: "NUMERIC", dec: "NUMERIC", real: "REAL", str: "TEXT", char: "TEXT", text: "TEXT", json: "TEXT", ts: "TEXT", date: "TEXT", ip: "TEXT", tags: "TEXT", enum: `TEXT CHECK (${q.sqlite(col)} IN (${type === "enum" ? enumList(a) : ""}))` },
  }[d];
  return T[type];
}

// CREATE TABLE statements. Postgres gets its primary keys after the load (faster COPY);
// the others need them up front (clustered index / rowid).
export function tablesDdl(d) {
  const out = [];
  if (d === "pg") for (const [name, values] of Object.entries(ENUMS)) out.push(`CREATE TYPE ${name} AS ENUM (${values.map((v) => `'${v}'`).join(", ")});`);
  for (const [t, def] of Object.entries(TABLES)) {
    const lines = Object.entries(def.cols).map(([c, spec]) => `  ${q[d](c)} ${columnType(d, c, spec)}${spec.endsWith("?") ? "" : " NOT NULL"}`);
    if (d !== "pg") lines.push(`  PRIMARY KEY (${def.pk.map(q[d]).join(", ")})`);
    let tail = "";
    if (d === "mysql") tail = " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";
    if (d === "pg" && PG_PARTITIONED[t]) tail = ` PARTITION BY RANGE (${PG_PARTITIONED[t].key})`;
    out.push(`CREATE TABLE ${q[d](t)} (\n${lines.join(",\n")}\n)${tail};`);
    if (d === "pg" && PG_PARTITIONED[t]) {
      const p = PG_PARTITIONED[t];
      for (let m = 0; m < p.months; m++) {
        const s = new Date(p.from); s.setUTCMonth(s.getUTCMonth() + m);
        const e = new Date(s); e.setUTCMonth(e.getUTCMonth() + 1);
        out.push(`CREATE TABLE ${t}_${s.toISOString().slice(0, 7).replace("-", "_")} PARTITION OF ${t} FOR VALUES FROM ('${s.toISOString().slice(0, 10)}') TO ('${e.toISOString().slice(0, 10)}');`);
      }
      out.push(`CREATE TABLE ${t}_default PARTITION OF ${t} DEFAULT;`);
    }
  }
  return out.join("\n\n") + "\n";
}

// Primary keys (Postgres), unique constraints, secondary indexes, foreign keys and identity reseeding.
export function postDdl(d) {
  const out = [];
  const name = (prefix, t, cols) => `${prefix}_${t}_${cols.join("_")}`.slice(0, 63);
  for (const [t, def] of Object.entries(TABLES)) {
    if (d === "pg") out.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${(PG_PARTITIONED[t] ? PG_PARTITIONED[t].pk : def.pk).join(", ")});`);
    for (const cols of def.unique || []) out.push(`CREATE UNIQUE INDEX ${name("ux", t, cols)} ON ${q[d](t)} (${cols.map(q[d]).join(", ")});`);
    for (const cols of def.idx || []) out.push(`CREATE INDEX ${name("ix", t, cols)} ON ${q[d](t)} (${cols.map(q[d]).join(", ")});`);
  }
  if (d !== "sqlite") {
    // SQLite cannot add foreign keys after the fact; they are declared in sqlite.tables via fkInline.
    for (const [t, def] of Object.entries(TABLES))
      for (const [col, ref] of Object.entries(def.fk || {}))
        out.push(`ALTER TABLE ${q[d](t)} ADD CONSTRAINT ${name("fk", t, [col])} FOREIGN KEY (${q[d](col)}) REFERENCES ${q[d](ref)} (${q[d](TABLES[ref].pk[0])});`);
  }
  if (d === "pg") {
    for (const [t, def] of Object.entries(TABLES))
      for (const [c, spec] of Object.entries(def.cols))
        if (spec === "pk") out.push(`SELECT setval(pg_get_serial_sequence('${t}', '${c}'), (SELECT coalesce(max(${c}), 0) + 1 FROM ${t}), false);`);
  }
  if (d === "mssql") {
    for (const [t, def] of Object.entries(TABLES))
      if (Object.values(def.cols).includes("pk")) out.push(`DBCC CHECKIDENT ('${t}', RESEED) WITH NO_INFOMSGS;`);
  }
  return out.join("\n") + "\n";
}

// SQLite declares foreign keys inline; append them to the CREATE TABLE output.
export function sqliteTablesDdl() {
  return tablesDdl("sqlite").replace(/CREATE TABLE "(\w+)" \(\n([\s\S]*?)\n\);/g, (all, t, body) => {
    const fks = Object.entries(TABLES[t].fk || {}).map(([col, ref]) => `  FOREIGN KEY ("${col}") REFERENCES "${ref}" ("${TABLES[ref].pk[0]}")`);
    return `CREATE TABLE "${t}" (\n${[body, ...fks].join(",\n")}\n);`;
  });
}
