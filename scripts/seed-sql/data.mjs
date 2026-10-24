// Row generators for the relational seed dataset (same business as scripts/seed-mongo.js, normalized).
// Every entity i is built from its own seeded PRNG, so a worker can recompute another table's row
// (e.g. an order's customer) without a lookup and foreign keys stay consistent across parallel workers.
// Child-table ids are derived from the parent id (order_id * 64 + line), so they are unique but sparse.

const BASE = {
  customers: 1_000_000,
  products: 100_000,
  orders: 5_000_000,
  reviews: 2_000_000,
  events: 10_000_000,
  tickets: 500_000,
  hosts: 200,
};
export const N = { ...BASE };
// Days of per-minute metrics each host gets, ending at NOW.
let metricDays = 17;
export function configure(scale, days = 17) {
  for (const k of Object.keys(N)) N[k] = Math.max(k === "hosts" ? 10 : 100, Math.round(BASE[k] * scale));
  metricDays = days;
}

const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 9, 22, 23, 59);
const T_ORDERS = Date.UTC(2023, 0, 1);
const T_SIGNUP = Date.UTC(2021, 0, 1);
const T_CATALOG = Date.UTC(2020, 5, 1);
const V2_CUTOVER = Date.UTC(2024, 3, 1); // checkout rewrite: channel/device tracked, legacy phone dropped
const TAG = { customers: 1, products: 2, orders: 3, reviews: 4, events: 5, tickets: 6, inventory: 7, metrics: 9 };

// Postgres text[] value; other dialects store it as a JSON array.
export class PgArray { constructor(items) { this.items = items; } }

// ---------- randomness ----------
export function hash32(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x7f4a7c15) | 0, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
function rngFor(tag, i) {
  let s = hash32(tag, i) || 1;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const chance = (r, p) => r() < p;
const round2 = (x) => Math.round(x * 100) / 100;
function weighted(r, pairs) {
  let total = 0;
  for (const p of pairs) total += p[1];
  let x = r() * total;
  for (const p of pairs) if ((x -= p[1]) < 0) return p[0];
  return pairs[pairs.length - 1][0];
}
function normal(r) { return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); }
// Heavy-head index: small indices are drawn far more often (whales, best-sellers).
const zipf = (r, n, k) => Math.min(n - 1, Math.floor(n * Math.pow(r(), k)));
function sample(r, arr, k) {
  const out = new Set();
  while (out.size < Math.min(k, arr.length)) out.add(pick(r, arr));
  return [...out];
}
function token(r, len, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789") {
  let s = "";
  for (let k = 0; k < len; k++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}
const words = (r, a, b) => Array.from({ length: int(r, a, b) }, () => pick(r, WORDS)).join(" ");
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---------- time shaping ----------
const MONTH_W = [0.85, 0.8, 0.9, 0.9, 0.95, 0.95, 0.9, 0.95, 1.0, 1.05, 1.35, 1.6];
const DOW_W = [1.15, 0.95, 0.9, 0.95, 1.0, 1.1, 1.2];
const HOUR_W = [0.3, 0.2, 0.15, 0.12, 0.12, 0.15, 0.25, 0.4, 0.6, 0.75, 0.85, 0.9, 0.95, 0.95, 0.95, 1.0, 1.0, 1.0, 1.05, 1.1, 1.1, 0.95, 0.7, 0.5];
// Growth trend + seasonality + Black Friday/Cyber Monday spikes, by rejection sampling.
function seasonal(r, from, to) {
  for (let tries = 0; tries < 200; tries++) {
    const t = from + r() * (to - from);
    const d = new Date(t);
    const m = d.getUTCMonth(), dd = d.getUTCDate();
    let w = (0.35 + 0.65 * (t - T_ORDERS) / (NOW - T_ORDERS)) * MONTH_W[m] * DOW_W[d.getUTCDay()] * HOUR_W[d.getUTCHours()];
    if ((m === 10 && dd >= 24) || (m === 11 && dd <= 2)) w *= 3.2;
    if (m === 11 && dd >= 26) w *= 0.6;
    if (r() * 6.5 < w) return Math.floor(t);
  }
  return Math.floor(from + r() * (to - from));
}

// ---------- reference data ----------
const FIRST = ["James","Mary","Robert","Patricia","John","Jennifer","Michael","Linda","David","Elizabeth","William","Barbara","Richard","Susan","Joseph","Jessica","Thomas","Sarah","Carlos","Karen","Daniel","Lisa","Matthew","Nancy","Anthony","Sofia","Mark","Ana","Paul","Emily","Kevin","Olivia","Wei","Mei","Hiroshi","Yuki","Arjun","Priya","Rahul","Ananya","Lukas","Emma","Mateo","Lucia","Noah","Mia","Liam","Chloe","Oliver","Amelia","Mohammed","Fatima","Omar","Aisha","Ivan","Olga","Pierre","Camille","Giulia","Marco","Lars","Ingrid","Kwame","Ama","Diego","Valentina","Jin","Seo-yeon","Thanh","Linh"];
const LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson","White","Harris","Clark","Lewis","Walker","Hall","Young","King","Wright","Scott","Nguyen","Kim","Chen","Wang","Li","Zhang","Patel","Shah","Singh","Kumar","Müller","Schmidt","Schneider","Fischer","Rossi","Russo","Bianchi","Dubois","Moreau","Laurent","Silva","Santos","Oliveira","Sato","Suzuki","Takahashi","Tanaka","Ivanov","Petrov","Kowalski","Nowak","Jensen","Hansen","O'Brien","Murphy","Okafor","Mensah"];
// code, name, weight, currency, usd rate, vat, language, region, cities [name, region, lat, lng]
const COUNTRIES = [
  ["US", "United States", 38, "USD", 1, 0.0725, "en", "NA", [["New York","NY",40.71,-74.0],["Los Angeles","CA",34.05,-118.24],["Chicago","IL",41.88,-87.63],["Houston","TX",29.76,-95.37],["Phoenix","AZ",33.45,-112.07],["Seattle","WA",47.61,-122.33],["Miami","FL",25.76,-80.19],["Denver","CO",39.74,-104.99],["Boston","MA",42.36,-71.06],["Atlanta","GA",33.75,-84.39],["Austin","TX",30.27,-97.74],["Portland","OR",45.52,-122.68]]],
  ["GB", "United Kingdom", 9, "GBP", 1.27, 0.2, "en", "EU", [["London","ENG",51.51,-0.13],["Manchester","ENG",53.48,-2.24],["Birmingham","ENG",52.49,-1.89],["Edinburgh","SCT",55.95,-3.19],["Glasgow","SCT",55.86,-4.25]]],
  ["DE", "Germany", 8, "EUR", 1.08, 0.19, "de", "EU", [["Berlin","BE",52.52,13.4],["Munich","BY",48.14,11.58],["Hamburg","HH",53.55,9.99],["Cologne","NW",50.94,6.96],["Frankfurt","HE",50.11,8.68]]],
  ["FR", "France", 6, "EUR", 1.08, 0.2, "fr", "EU", [["Paris","IDF",48.86,2.35],["Lyon","ARA",45.76,4.84],["Marseille","PAC",43.3,5.37],["Toulouse","OCC",43.6,1.44]]],
  ["CA", "Canada", 6, "CAD", 0.73, 0.13, "en", "NA", [["Toronto","ON",43.65,-79.38],["Vancouver","BC",49.28,-123.12],["Montreal","QC",45.5,-73.57],["Calgary","AB",51.05,-114.07]]],
  ["AU", "Australia", 4, "AUD", 0.66, 0.1, "en", "APAC", [["Sydney","NSW",-33.87,151.21],["Melbourne","VIC",-37.81,144.96],["Brisbane","QLD",-27.47,153.03],["Perth","WA",-31.95,115.86]]],
  ["JP", "Japan", 5, "JPY", 0.0067, 0.1, "ja", "APAC", [["Tokyo","13",35.68,139.69],["Osaka","27",34.69,135.5],["Yokohama","14",35.44,139.64],["Sapporo","01",43.06,141.35]]],
  ["BR", "Brazil", 5, "BRL", 0.2, 0.17, "pt", "LATAM", [["São Paulo","SP",-23.55,-46.63],["Rio de Janeiro","RJ",-22.91,-43.17],["Brasília","DF",-15.79,-47.88],["Salvador","BA",-12.97,-38.5]]],
  ["IN", "India", 7, "INR", 0.012, 0.18, "en", "APAC", [["Mumbai","MH",19.08,72.88],["Delhi","DL",28.61,77.21],["Bengaluru","KA",12.97,77.59],["Hyderabad","TG",17.39,78.49],["Chennai","TN",13.08,80.27]]],
  ["ES", "Spain", 3, "EUR", 1.08, 0.21, "es", "EU", [["Madrid","MD",40.42,-3.7],["Barcelona","CT",41.39,2.17],["Valencia","VC",39.47,-0.38]]],
  ["IT", "Italy", 3, "EUR", 1.08, 0.22, "it", "EU", [["Rome","LAZ",41.9,12.5],["Milan","LOM",45.46,9.19],["Naples","CAM",40.85,14.27]]],
  ["NL", "Netherlands", 2, "EUR", 1.08, 0.21, "nl", "EU", [["Amsterdam","NH",52.37,4.9],["Rotterdam","ZH",51.92,4.48]]],
  ["MX", "Mexico", 3, "MXN", 0.055, 0.16, "es", "LATAM", [["Mexico City","CMX",19.43,-99.13],["Guadalajara","JAL",20.67,-103.35],["Monterrey","NLE",25.69,-100.32]]],
  ["SE", "Sweden", 1, "SEK", 0.095, 0.25, "sv", "EU", [["Stockholm","AB",59.33,18.07],["Gothenburg","O",57.71,11.97]]],
];
const COUNTRY_W = COUNTRIES.map((c, idx) => [idx, c[2]]);
const STREETS = ["Main St","Oak Ave","Maple Dr","Cedar Ln","Park Rd","Elm St","High St","Station Rd","Church Ln","Market St","River Rd","Hill St","King St","Queen St","Victoria Rd","Sunset Blvd","Lake View Dr","Mill Ln"];
const DOMAINS = [["gmail.com", 45], ["yahoo.com", 10], ["outlook.com", 12], ["hotmail.com", 7], ["icloud.com", 9], ["proton.me", 2], ["gmx.de", 2], ["yandex.ru", 1], ["qq.com", 2], ["company.io", 3], ["aol.com", 1]];

const CATEGORIES = {
  Electronics: { w: 18, code: "ELC", median: 110, sigma: 0.9, sub: { Phones: ["Smartphones","Cases","Chargers"], Computers: ["Laptops","Monitors","Keyboards","Mice"], Audio: ["Headphones","Speakers","Earbuds"], "Smart Home": ["Cameras","Thermostats","Lights"], Gaming: ["Consoles","Controllers","Headsets"] } },
  Apparel: { w: 22, code: "APP", median: 38, sigma: 0.7, sub: { Men: ["T-Shirts","Jeans","Jackets","Shoes"], Women: ["Dresses","Tops","Leggings","Shoes"], Kids: ["Shirts","Pajamas","Sneakers"], Accessories: ["Hats","Belts","Bags","Watches"] } },
  Home: { w: 15, code: "HOM", median: 55, sigma: 0.9, sub: { Kitchen: ["Cookware","Knives","Appliances","Storage"], Furniture: ["Chairs","Desks","Shelves","Sofas"], Bedding: ["Sheets","Pillows","Duvets"], Decor: ["Lamps","Rugs","Wall Art"] } },
  Books: { w: 10, code: "BOK", median: 16, sigma: 0.45, sub: { Fiction: ["Thriller","Fantasy","Romance","Literary"], "Non-Fiction": ["Biography","History","Science","Business"], Kids: ["Picture Books","Young Adult"] } },
  Grocery: { w: 12, code: "GRO", median: 8, sigma: 0.6, sub: { Pantry: ["Pasta","Snacks","Spices","Oils"], Beverages: ["Coffee","Tea","Juice"], Organic: ["Produce","Dairy Alternatives"] } },
  Beauty: { w: 8, code: "BEA", median: 22, sigma: 0.6, sub: { Skincare: ["Moisturizers","Serums","Cleansers"], Makeup: ["Lipstick","Foundation","Mascara"], Hair: ["Shampoo","Conditioner","Styling"] } },
  Sports: { w: 8, code: "SPT", median: 45, sigma: 0.9, sub: { Fitness: ["Weights","Yoga Mats","Resistance Bands"], Outdoor: ["Tents","Backpacks","Hiking Boots"], Cycling: ["Helmets","Lights","Bikes"] } },
  Toys: { w: 7, code: "TOY", median: 25, sigma: 0.7, sub: { "Building Sets": ["Bricks","Magnetic Tiles"], Games: ["Board Games","Puzzles","Card Games"], Outdoor: ["Scooters","Water Toys"] } },
};
const CAT_NAMES = Object.keys(CATEGORIES);
const CAT_W = CAT_NAMES.map((c) => [c, CATEGORIES[c].w]);
// Category tree rows (id, parent_id, name, path, depth) and a leaf lookup by "l1/l2/l3".
const CATEGORY_ROWS = [];
const LEAF_ID = {};
for (const l1 of CAT_NAMES) {
  const id1 = CATEGORY_ROWS.length + 1;
  CATEGORY_ROWS.push({ id: id1, parent_id: null, name: l1, path: l1, depth: 1 });
  for (const [l2, leaves] of Object.entries(CATEGORIES[l1].sub)) {
    const id2 = CATEGORY_ROWS.length + 1;
    CATEGORY_ROWS.push({ id: id2, parent_id: id1, name: l2, path: `${l1}/${l2}`, depth: 2 });
    for (const l3 of leaves) {
      const id3 = CATEGORY_ROWS.length + 1;
      CATEGORY_ROWS.push({ id: id3, parent_id: id2, name: l3, path: `${l1}/${l2}/${l3}`, depth: 3 });
      LEAF_ID[`${l1}/${l2}/${l3}`] = id3;
    }
  }
}
const BRANDS = ["Acme","Northwind","Contoso","Globex","Initech","Umbrella","Stark","Wayne","Hooli","Vandelay","Soylent","Tyrell","Cyberdyne","Wonka","Aperture","Monarch","Pied Piper","Gringotts","Oceanic","Blue Sun","Zenith","Lumen","Kestrel","Halcyon","Nimbus","Orbital","Pinecrest","Ridgeway","Solace","Verdant"];
const ADJ = ["Ultra","Pro","Classic","Essential","Premium","Eco","Smart","Compact","Deluxe","Lite","Max","Signature","Everyday","Travel","Studio","Heritage","Urban","Fusion","Air","Core"];
const COLORS = ["Black","White","Navy","Grey","Red","Blue","Green","Beige","Pink","Olive","Burgundy","Silver","Gold","Charcoal"];
const SIZES = ["XS","S","M","L","XL","XXL"];
const MATERIALS = ["Cotton","Polyester","Wool","Linen","Leather","Denim","Bamboo","Steel","Oak","Walnut","Ceramic","Glass","Aluminum","Recycled Plastic"];
const WORDS = "the a quality product arrived quickly works well great value price would recommend again bought this for my daughter son wife husband office kitchen after using it daily for weeks the material feels solid packaging was damaged but item fine customer service helpful replacement shipped size runs small large color matches picture exactly not as described battery life impressive sound clear fit perfect comfortable cheap flimsy broke after month returned refund easy setup instructions confusing five stars love it disappointed expected better overall happy with purchase".split(" ");
const POS = ["Love it","Excellent","Great value","Highly recommend","Exceeded expectations","Perfect","Works great","Best purchase this year"];
const NEG = ["Disappointed","Broke quickly","Not as described","Waste of money","Poor quality","Returned it","Meh","Would not buy again"];
const MID = ["It's okay","Decent","Does the job","Average","Mixed feelings","Good but pricey"];

// code, city, country, lat, lng
const WAREHOUSES = [
  ["WH-NJ1", "Newark", "US", 40.73, -74.17], ["WH-CA1", "Ontario", "US", 34.06, -117.65], ["WH-TX1", "Dallas", "US", 32.78, -96.8],
  ["WH-IL1", "Joliet", "US", 41.53, -88.08], ["WH-GA1", "Atlanta", "US", 33.64, -84.43], ["WH-UK1", "Milton Keynes", "GB", 52.04, -0.76],
  ["WH-DE1", "Leipzig", "DE", 51.34, 12.37], ["WH-FR1", "Lyon", "FR", 45.76, 4.84], ["WH-CA2", "Mississauga", "CA", 43.59, -79.64],
  ["WH-JP1", "Chiba", "JP", 35.61, 140.12], ["WH-BR1", "Campinas", "BR", -22.91, -47.06], ["WH-IN1", "Bhiwandi", "IN", 19.3, 73.06],
];
const WH_FOR_COUNTRY = { US: [0, 1, 2, 3, 4], GB: [5], DE: [6], FR: [7], ES: [7], IT: [6, 7], NL: [6], SE: [6], CA: [8, 0], JP: [9], BR: [10], IN: [11], MX: [2], AU: [1] };
const CARRIERS = { US: ["UPS", "FedEx", "USPS", "Amazon Logistics"], GB: ["Royal Mail", "DPD", "Evri"], DE: ["DHL", "Hermes", "DPD"], FR: ["La Poste", "Chronopost", "DPD"], JP: ["Yamato", "Sagawa", "Japan Post"], BR: ["Correios", "Jadlog"], IN: ["Delhivery", "Blue Dart", "India Post"] };
const AGENTS = Array.from({ length: 60 }, (_, k) => ({ id: k + 1, name: `${FIRST[(k * 7) % FIRST.length]} ${LAST[(k * 11) % LAST.length]}`, team: ["Tier 1", "Tier 1", "Tier 2", "Billing", "Logistics", "Escalations"][k % 6] }));

// ---------- recomputable cores ----------
function customerCore(i) {
  const r = rngFor(TAG.customers, i);
  const c = COUNTRIES[weighted(r, COUNTRY_W)];
  const city = pick(r, c[8]);
  const first = pick(r, FIRST), last = pick(r, LAST);
  const signupAt = Math.floor(T_SIGNUP + (NOW - T_SIGNUP) * Math.pow(r(), 0.75));
  return { r, i, id: i + 1, first, last, country: c, city, signupAt };
}
function productCore(i) {
  const r = rngFor(TAG.products, i);
  const l1 = weighted(r, CAT_W);
  const cat = CATEGORIES[l1];
  const l2 = pick(r, Object.keys(cat.sub));
  const l3 = pick(r, cat.sub[l2]);
  const brandIdx = Math.floor(Math.pow(r(), 1.6) * BRANDS.length);
  const name = `${BRANDS[brandIdx]} ${pick(r, ADJ)} ${l3.replace(/s$/, "")} ${token(r, 1, "ABCDEFGHKLMNPRSTVXZ")}${int(r, 1, 9)}${chance(r, 0.3) ? "00" : ""}`;
  const raw = Math.max(0.99, cat.median * Math.exp(cat.sigma * normal(r))) - (chance(r, 0.6) ? 0.01 : 0);
  const createdAt = Math.floor(T_CATALOG + (NOW - 30 * DAY - T_CATALOG) * r());
  return { r, i, id: i + 1, sku: `${cat.code}-${(i).toString(16).toUpperCase().padStart(6, "0")}`, name, l1, l2, l3, brandIdx, price: round2(Math.max(0.99, raw)), createdAt };
}
function orderHead(i) {
  const r = rngFor(TAG.orders, i);
  const u = customerCore(zipf(r, N.customers, 2.5));
  let createdAt = seasonal(r, T_ORDERS, NOW);
  if (createdAt < u.signupAt) createdAt = Math.floor(u.signupAt + r() * Math.min(45 * DAY, NOW - u.signupAt));
  return { r, i, id: i + 1, u, createdAt };
}
const orderNumber = (i) => "ORD-" + String(10_000_000 + i);
const phone = (r) => `+${int(r, 1, 99)} ${int(r, 100, 999)} ${int(r, 1000000, 9999999)}`;

// ---------- generators: emit(table, row) ----------
export function genReference(emit) {
  for (const c of COUNTRIES) emit("countries", { code: c[0], name: c[1], currency: c[3], usd_rate: c[4], vat_rate: c[5], language: c[6], region: c[7] });
  WAREHOUSES.forEach(([code, city, country, lat, lng], k) => emit("warehouses", {
    id: k + 1, code, name: `${city} Fulfillment Center`, city, country_code: country, lat, lng,
    capacity_pallets: 10_000 + k * 3_500, opened_on: day(Date.UTC(2015 + (k % 8), k % 12, 1)),
    features: ["cold_storage", "hazmat", "oversized", "same_day"].filter((_, j) => (k + j) % 3 !== 0),
  }));
  for (const c of CATEGORY_ROWS) emit("categories", { ...c, slug: c.path.toLowerCase().replace(/[^a-z0-9]+/g, "-") });
  BRANDS.forEach((name, k) => emit("brands", { id: k + 1, name, country_code: COUNTRIES[k % COUNTRIES.length][0], founded_year: 1950 + ((k * 37) % 70), is_private_label: k < 3 }));
  for (const a of AGENTS) emit("support_agents", { id: a.id, name: a.name, team: a.team, email: a.name.toLowerCase().replace(/[^a-z]+/g, ".") + "@support.acme.example", hired_on: day(Date.UTC(2018 + (a.id % 8), a.id % 12, 1 + (a.id % 27))), is_active: a.id % 13 !== 0 });
}

export function genCustomer(i, emit) {
  const u = customerCore(i);
  const r = u.r, c = u.country;
  const v2 = u.signupAt >= V2_CUTOVER;
  const local = `${u.first}.${u.last}`.toLowerCase().normalize("NFD").replace(/[^a-z.]/g, "");
  emit("customers", {
    id: u.id,
    email: `${local}${i}@${weighted(r, DOMAINS)}`,
    first_name: u.first,
    last_name: u.last,
    display_name: chance(r, 0.15) ? `${u.first[0]}${u.last}`.toLowerCase() + int(r, 1, 99) : null,
    status: weighted(r, [["active", 88], ["inactive", 7], ["suspended", 1], ["pending_verification", 4]]),
    tier: weighted(r, [["standard", 70], ["silver", 18], ["gold", 9], ["platinum", 3]]),
    country_code: c[0],
    locale: weighted(r, [["en-US", 45], [`${c[6]}-${c[0]}`, 55]]),
    schema_version: v2 ? 2 : 1,
    legacy_phone: v2 ? null : chance(r, 0.8) ? `${int(r, 100, 999)}-${int(r, 100, 999)}-${int(r, 1000, 9999)}` : "",
    mobile_phone: v2 ? phone(r) : null,
    email_verified: chance(r, 0.86),
    mfa_enabled: v2 && chance(r, 0.23),
    marketing_email: chance(r, 0.55),
    marketing_sms: chance(r, 0.18),
    preferences: { currency: c[3], theme: weighted(r, [["system", 60], ["light", 25], ["dark", 15]]), newsletter: pick(r, ["weekly", "monthly", "never"]), ...(chance(r, 0.1) ? { sizes: { shirt: pick(r, SIZES), shoe: int(r, 36, 46) } } : {}) },
    referred_by: chance(r, 0.1) ? int(r, 1, N.customers) : null,
    date_of_birth: chance(r, 0.7) ? day(Date.UTC(int(r, 1950, 2007), int(r, 0, 11), int(r, 1, 28))) : null,
    created_at: new Date(u.signupAt),
    last_login_at: chance(r, 0.93) ? new Date(u.signupAt + r() * (NOW - u.signupAt)) : null,
    deleted_at: chance(r, 0.02) ? new Date(u.signupAt + r() * (NOW - u.signupAt)) : null,
  });
  const nAddr = v2 ? weighted(r, [[1, 70], [2, 22], [3, 8]]) : 1;
  for (let k = 0; k < nAddr; k++) {
    const [cityName, region, lat, lng] = k === 0 ? u.city : pick(r, c[8]);
    emit("customer_addresses", {
      id: u.id * 4 + k, customer_id: u.id, label: k === 0 ? "home" : pick(r, ["work", "parents", "vacation"]),
      line1: `${int(r, 1, 9999)} ${pick(r, STREETS)}`, line2: chance(r, 0.18) ? `Apt ${int(r, 1, 450)}` : null,
      city: cityName, region, postal_code: String(int(r, 10000, 99999)), country_code: c[0],
      lat: round2(lat + normal(r) * 0.08), lng: round2(lng + normal(r) * 0.08), is_default: k === 0, created_at: new Date(u.signupAt + k * r() * 200 * DAY),
    });
  }
  for (const tag of sample(r, ["vip", "wholesale", "influencer", "fraud_watch", "beta_tester", "employee", "student", "price_sensitive", "early_adopter"], weighted(r, [[0, 70], [1, 22], [2, 6], [3, 2]])))
    emit("customer_tags", { customer_id: u.id, tag, added_at: new Date(u.signupAt + r() * (NOW - u.signupAt)) });
}

export function genProduct(i, emit) {
  const p = productCore(i);
  const r = p.r;
  let attrs;
  if (p.l1 === "Electronics") attrs = { color: pick(r, COLORS), warrantyMonths: pick(r, [12, 24, 36]), wireless: chance(r, 0.5), ...(p.l3 === "Laptops" || p.l2 === "Phones" ? { storageGB: pick(r, [64, 128, 256, 512, 1024]) } : {}) };
  else if (p.l1 === "Apparel") attrs = { material: pick(r, MATERIALS.slice(0, 7)), fit: pick(r, ["slim", "regular", "relaxed"]) };
  else if (p.l1 === "Home") attrs = { material: pick(r, MATERIALS), dimensionsCm: { w: int(r, 10, 200), h: int(r, 5, 200), d: int(r, 5, 120) }, assemblyRequired: chance(r, 0.4) };
  else if (p.l1 === "Books") attrs = { author: `${pick(r, FIRST)} ${pick(r, LAST)}`, pages: int(r, 80, 1100), format: pick(r, ["Hardcover", "Paperback", "Kindle", "Audiobook"]), isbn13: "978" + int(r, 1000000000, 9999999999) };
  else if (p.l1 === "Grocery") attrs = { weightG: int(r, 50, 5000), organic: chance(r, 0.3), allergens: sample(r, ["nuts", "gluten", "dairy", "soy", "eggs"], int(r, 0, 2)) };
  else if (p.l1 === "Beauty") attrs = { volumeMl: pick(r, [15, 30, 50, 100, 250, 500]), skinType: pick(r, ["all", "dry", "oily", "sensitive"]), crueltyFree: chance(r, 0.6) };
  else if (p.l1 === "Sports") attrs = { color: pick(r, COLORS), material: pick(r, MATERIALS) };
  else attrs = { ageRange: pick(r, ["0-2", "3-5", "6-8", "8-12", "12+"]), batteriesRequired: chance(r, 0.2) };
  const ratingCount = Math.floor(Math.pow(r(), 3) * 9000 * (p.i < 2000 ? 5 : 1));
  emit("products", {
    id: p.id, sku: p.sku, name: p.name,
    slug: p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + p.id,
    brand_id: p.brandIdx + 1,
    category_id: LEAF_ID[`${p.l1}/${p.l2}/${p.l3}`],
    status: weighted(r, [["active", 90], ["discontinued", 6], ["draft", 2], ["out_of_stock", 2]]),
    price: p.price,
    cost: round2(p.price * (0.25 + r() * 0.45)),
    compare_at_price: chance(r, 0.15) ? round2(p.price * (1.1 + r() * 0.6)) : null,
    weight_kg: round2(0.05 + Math.pow(r(), 2) * 30),
    attributes: attrs,
    tags: new PgArray(sample(r, ["bestseller", "new", "sale", "limited", "eco", "gift_idea", "clearance", "exclusive", "bundle"], weighted(r, [[0, 40], [1, 35], [2, 18], [3, 7]]))),
    rating_avg: ratingCount ? round2(Math.min(5, Math.max(1, 4.1 + normal(r) * 0.55))) : null,
    rating_count: ratingCount,
    supplier_name: `${pick(r, BRANDS)} ${pick(r, ["Manufacturing", "Trading Co", "Industries", "Supply", "Group"])}`,
    supplier_country: weighted(r, [["CN", 45], ["US", 15], ["VN", 10], ["DE", 7], ["IN", 8], ["MX", 5], ["TW", 5], ["IT", 5]]),
    lead_time_days: int(r, 3, 90),
    is_hazmat: chance(r, 0.01),
    description: words(r, 15, 90),
    created_at: new Date(p.createdAt),
    updated_at: new Date(p.createdAt + r() * (NOW - p.createdAt)),
  });
  if (p.l1 === "Apparel" || (p.l1 === "Sports" && chance(r, 0.4))) {
    let k = 0;
    for (const color of sample(r, COLORS, int(r, 1, 4)))
      for (const size of SIZES.slice(int(r, 0, 1), int(r, 4, 6)))
        emit("product_variants", { id: p.id * 64 + k++, product_id: p.id, sku: `${p.sku}-${color.toUpperCase()}-${size}`, color, size, price_delta: size === "XXL" ? 2 : 0, barcode: String(int(r, 100000000, 999999999)) + int(r, 1000, 9999) });
  }
  // stock per warehouse
  const ri = rngFor(TAG.inventory, i);
  const popular = i < N.products * 0.05;
  for (const w of sample(ri, WAREHOUSES.map((_, k) => k), weighted(ri, [[1, 10], [2, 15], [3, 20], [4, 20], [6, 15], [8, 10], [12, 10]]))) {
    const onHand = chance(ri, 0.07) ? 0 : Math.floor(Math.exp(2 + ri() * (popular ? 6 : 4)));
    emit("inventory", {
      product_id: p.id, warehouse_id: w + 1, on_hand: onHand, reserved: Math.min(onHand, Math.floor(ri() * onHand * 0.3)),
      incoming: chance(ri, 0.2) ? int(ri, 10, 2000) : 0, reorder_point: int(ri, 5, popular ? 500 : 60),
      bin: `${token(ri, 1, "ABCDEFGH")}${int(ri, 1, 40)}-${int(ri, 1, 12)}-${int(ri, 1, 6)}`,
      unit_cost_usd: round2(p.price * (0.25 + ri() * 0.4)), last_counted_at: new Date(NOW - ri() * 120 * DAY), updated_at: new Date(NOW - Math.pow(ri(), 3) * 60 * DAY),
    });
  }
}

const FLOWS = {
  pending: [], payment_failed: [["payment_failed", 0, 0.1]], paid: [["paid", 0, 0.2]],
  processing: [["paid", 0, 0.2], ["processing", 1, 20]],
  shipped: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48]],
  delivered: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48], ["delivered", 20, 160]],
  cancelled: [["paid", 0, 0.2], ["cancelled", 0.5, 30, "customer"]],
  lost_in_transit: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48], ["lost_in_transit", 200, 400, "carrier"]],
  returned: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48], ["delivered", 20, 160], ["return_requested", 24, 500, "customer"], ["returned", 48, 300, "warehouse"]],
  refunded: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48], ["delivered", 20, 160], ["refunded", 24, 700, "support"]],
  partially_refunded: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48], ["delivered", 20, 160], ["partially_refunded", 24, 700, "support"]],
};

export function genOrder(i, emit) {
  const h = orderHead(i);
  const r = h.r, u = h.u, c = u.country, t = h.createdAt, id = h.id;
  const v2 = t >= V2_CUTOVER;
  const fx = c[4];
  const age = NOW - t;

  const nItems = weighted(r, [[1, 40], [2, 25], [3, 13], [4, 8], [5, 5], [6, 3], [7, 2], [8, 1.5], [10, 1], [12, 0.8], [25, 0.15], [60, 0.05]]);
  const b2b = nItems >= 25;
  const items = [];
  const seen = new Set();
  let subtotal = 0;
  for (let k = 0; k < nItems; k++) {
    const pIdx = zipf(r, N.products, 1.8);
    if (seen.has(pIdx)) continue;
    seen.add(pIdx);
    const p = productCore(pIdx);
    const qty = b2b ? int(r, 2, 24) : weighted(r, [[1, 80], [2, 13], [3, 4], [4, 2], [10, 1]]);
    const unitPrice = round2((p.price * (1 + 0.04 * ((t - T_ORDERS) / (365 * DAY)))) / fx);
    const discount = chance(r, 0.12) ? round2(unitPrice * qty * pick(r, [0.05, 0.1, 0.15, 0.2, 0.3, 0.5])) : 0;
    const lineTotal = round2(unitPrice * qty - discount);
    items.push({
      id: id * 64 + items.length, order_id: id, line_no: items.length + 1, product_id: p.id, sku: p.sku, product_name: p.name,
      qty, unit_price: unitPrice, discount, line_total: lineTotal,
      variant_size: p.l1 === "Apparel" ? pick(r, SIZES) : null, variant_color: p.l1 === "Apparel" ? pick(r, COLORS) : null, gift_wrap: chance(r, 0.03),
    });
    subtotal += lineTotal;
  }
  subtotal = round2(subtotal);
  const coupon = chance(r, 0.11) ? weighted(r, [["WELCOME10", 30], ["SPRING15", 8], ["BFCM25", 12], ["FREESHIP", 20], ["VIP20", 5], ["SORRY10", 4], ["APP5", 10], [token(r, 8), 11]]) : null;
  const couponPct = coupon && coupon !== "FREESHIP" ? Math.min(30, Number((/^[A-Z]+(\d{1,2})$/.exec(coupon) || [0, 10])[1])) : 0;
  const orderDiscount = round2(subtotal * couponPct / 100);
  const shippingFee = coupon === "FREESHIP" || subtotal * fx > 50 ? 0 : round2(pick(r, [4.99, 6.99, 9.99, 14.99]) / fx);
  const tax = round2((subtotal - orderDiscount) * c[5]);
  const total = round2(subtotal - orderDiscount + shippingFee + tax);

  let status;
  if (age < 2 * DAY) status = weighted(r, [["pending", 30], ["paid", 40], ["processing", 25], ["payment_failed", 5]]);
  else if (age < 7 * DAY) status = weighted(r, [["processing", 15], ["shipped", 60], ["delivered", 20], ["cancelled", 5]]);
  else status = weighted(r, [["delivered", 83], ["cancelled", 6], ["returned", 4.5], ["refunded", 2.5], ["partially_refunded", 1.5], ["shipped", 1], ["lost_in_transit", 0.5], ["payment_failed", 1]]);
  const history = [{ status: "pending", at: t, by: "system" }];
  let cursor = t;
  for (const [s, minH, maxH, by] of FLOWS[status]) {
    cursor = Math.min(NOW, cursor + (minH + r() * (maxH - minH)) * 3_600_000);
    history.push({ status: s, at: cursor, by: by || "system" });
  }
  const at = (s) => (history.find((x) => x.status === s) || {}).at;
  const [cityName, region] = u.city;
  const wh = pick(r, WH_FOR_COUNTRY[c[0]] || [0]) + 1;

  emit("orders", {
    id, order_number: orderNumber(i), customer_id: u.id, status,
    channel: v2 ? weighted(r, [["web", 52], ["ios", 23], ["android", 18], ["marketplace", 5], ["pos", 2]]) : null,
    currency: c[3], subtotal, discount: orderDiscount, shipping_fee: shippingFee, tax, total, total_usd: round2(total * fx),
    coupon_code: coupon, item_count: items.reduce((s, x) => s + x.qty, 0),
    warehouse_id: wh, shipping_method: weighted(r, [["standard", 70], ["express", 20], ["next_day", 7], ["pickup", 3]]),
    ship_city: cityName, ship_region: region, ship_postal_code: String(int(r, 10000, 99999)), ship_country: c[0],
    is_b2b: b2b, po_number: b2b ? "PO-" + int(r, 100000, 999999) : null,
    gift_message: chance(r, 0.02) ? words(r, 3, 15) : null,
    flags: chance(r, 0.04) ? sample(r, ["fraud_review", "address_mismatch", "high_value", "first_order", "manual_hold", "vip"], int(r, 1, 2)) : null,
    attribution: v2 && chance(r, 0.3) ? { source: pick(r, ["google", "facebook", "instagram", "tiktok", "email", "affiliate", "direct"]), medium: pick(r, ["cpc", "organic", "social", "email", "referral"]), campaign: chance(r, 0.6) ? pick(r, ["bfcm_2024", "summer_sale", "back_to_school", "retargeting_q3", "bfcm_2025", "spring_launch"]) : null } : null,
    schema_version: v2 ? 2 : 1,
    created_at: new Date(t), updated_at: new Date(history[history.length - 1].at),
  });
  for (const it of items) emit("order_items", it);
  history.forEach((x, k) => emit("order_status_history", { id: id * 16 + k, order_id: id, status: x.status, changed_by: x.by, changed_at: new Date(x.at) }));

  // payments: failed attempts, then the captured one
  const method = weighted(r, [["card", 68], ["paypal", 14], ["apple_pay", 8], ["google_pay", 4], ["klarna", 3], ["gift_card", 2], ["bank_transfer", b2b ? 40 : 1]]);
  const card = method === "card";
  const brand = card ? weighted(r, [["visa", 52], ["mastercard", 30], ["amex", 12], ["discover", 3], ["jcb", c[0] === "JP" ? 30 : 1]]) : null;
  const failures = status === "payment_failed" ? int(r, 1, 3) : chance(r, 0.03) ? 1 : 0;
  const attempts = failures + (status === "payment_failed" ? 0 : 1);
  let payId = null;
  for (let k = 0; k < attempts; k++) {
    const failed = k < failures;
    const pid = id * 4 + k;
    if (!failed) payId = pid;
    emit("payments", {
      id: pid, order_id: id, attempt: k + 1, method, provider: card ? weighted(r, [["stripe", 70], ["adyen", 30]]) : method,
      status: failed ? "failed" : status === "pending" ? "authorized" : "captured",
      amount: total, currency: c[3], card_brand: brand, card_last4: card ? String(int(r, 1000, 9999)) : null,
      decline_code: failed ? pick(r, ["insufficient_funds", "do_not_honor", "expired_card", "fraudulent", "3ds_failed"]) : null,
      risk_score: chance(r, 0.6) ? round2(chance(r, 0.025) ? 60 + r() * 40 : Math.pow(r(), 3) * 60) : null,
      transaction_id: "txn_" + pid.toString(36) + token(r, 14, "abcdefghijklmnopqrstuvwxyz0123456789"),
      created_at: new Date(t + k * 90_000),
    });
  }
  if (status === "refunded" || status === "partially_refunded" || status === "returned") {
    const when = history[history.length - 1].at;
    emit("refunds", { id, order_id: id, payment_id: payId, amount: status === "partially_refunded" ? round2(total * (0.1 + r() * 0.5)) : total, reason: pick(r, ["damaged", "late_delivery", "wrong_item", "not_as_described", "goodwill", "return"]), created_at: new Date(when) });
  }
  const shippedAt = at("shipped");
  if (shippedAt) {
    const split = items.length > 3 && chance(r, 0.2) ? 2 : 1;
    const carrier = pick(r, CARRIERS[c[0]] || ["DHL", "FedEx", "UPS"]);
    for (let k = 0; k < split; k++) {
      const deliveredAt = at("delivered");
      emit("shipments", {
        id: id * 4 + k, order_id: id, carrier, tracking_number: token(r, 18, "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"),
        status: status === "lost_in_transit" ? "lost" : deliveredAt ? "delivered" : "in_transit",
        shipped_at: new Date(shippedAt + k * 6 * 3_600_000), delivered_at: deliveredAt ? new Date(deliveredAt + k * 12 * 3_600_000) : null,
        weight_kg: round2(0.2 + r() * 12), cost_usd: round2(3 + r() * 25),
      });
    }
  }
}

export function genReview(i, emit) {
  const r = rngFor(TAG.reviews, i);
  const p = productCore(zipf(r, N.products, 1.6));
  const u = customerCore(zipf(r, N.customers, 1.4));
  const rating = weighted(r, [[1, 8], [2, 5], [3, 9], [4, 21], [5, 57]]);
  const t = seasonal(r, Math.max(p.createdAt, u.signupAt, T_ORDERS), NOW);
  const responded = rating <= 3 && chance(r, 0.15);
  emit("reviews", {
    id: i + 1, product_id: p.id, customer_id: u.id, rating,
    title: pick(r, rating >= 4 ? POS : rating <= 2 ? NEG : MID),
    body: Array.from({ length: Math.floor(5 + Math.pow(r(), 2) * 160) }, () => pick(r, WORDS)).join(" "),
    verified_purchase: chance(r, 0.78),
    helpful_votes: Math.floor(Math.pow(r(), 6) * 2500),
    language: weighted(r, [["en", 78], ["es", 6], ["de", 5], ["fr", 4], ["pt", 3], ["ja", 2], ["it", 2]]),
    status: weighted(r, [["published", 92], ["pending_moderation", 4], ["rejected", 3], ["flagged", 1]]),
    image_count: chance(r, 0.1) ? int(r, 1, 5) : 0,
    seller_response: responded ? "We're sorry to hear that. Please contact support so we can make it right." : null,
    seller_responded_at: responded ? new Date(Math.min(NOW, t + r() * 10 * DAY)) : null,
    created_at: new Date(t),
  });
}

const EVENT_TYPES = [["page_view", 42], ["product_view", 22], ["search", 9], ["add_to_cart", 7], ["remove_from_cart", 1.5], ["checkout_start", 2.5], ["purchase", 1.2], ["login", 4], ["signup", 0.6], ["wishlist_add", 2], ["video_play", 2], ["error", 1.5], ["click", 4.7]];
const PAGES = ["/", "/search", "/cart", "/checkout", "/account", "/account/orders", "/deals", "/c/electronics", "/c/apparel", "/c/home", "/c/books", "/help", "/blog/holiday-gift-guide", "/stores"];
const BROWSERS = [["Chrome", 62], ["Safari", 22], ["Edge", 6], ["Firefox", 5], ["Samsung Internet", 4], ["Opera", 1]];
const SEARCHES = ["wireless earbuds", "running shoes", "coffee", "laptop stand", "yoga mat", "gift for dad", "usb c cable", "winter jacket", "lego", "air fryer", "phone case", "desk chair", "protein", "sunscreen", "headphones noise cancelling", "kindle", "monitor 27", "backpack"];

export function genEvent(i, emit) {
  const r = rngFor(TAG.events, i);
  const t = seasonal(r, NOW - 180 * DAY, NOW);
  const u = chance(r, 0.42) ? null : customerCore(zipf(r, N.customers, 1.8));
  const country = u ? u.country : COUNTRIES[weighted(r, COUNTRY_W)];
  const city = u ? u.city : pick(r, country[8]);
  const type = weighted(r, EVENT_TYPES);
  const viewed = productCore(zipf(r, N.products, 1.5));
  const deviceType = weighted(r, [["mobile", 58], ["desktop", 36], ["tablet", 6]]);
  const os = deviceType === "desktop" ? weighted(r, [["Windows", 65], ["macOS", 28], ["Linux", 4], ["ChromeOS", 3]]) : weighted(r, [["iOS", 52], ["Android", 48]]);
  const browser = os === "iOS" || os === "macOS" ? weighted(r, [["Safari", 75], ["Chrome", 25]]) : weighted(r, BROWSERS.filter((b) => b[0] !== "Safari"));
  let props = null;
  if (type === "product_view" || type === "add_to_cart" || type === "remove_from_cart" || type === "wishlist_add") {
    const p = type === "product_view" ? viewed : productCore(zipf(r, N.products, 1.5));
    props = { productId: p.id, sku: p.sku, price: p.price, category: p.l1 };
    if (type !== "product_view") props.qty = weighted(r, [[1, 85], [2, 10], [3, 5]]);
  } else if (type === "search") {
    props = { query: pick(r, SEARCHES) + (chance(r, 0.2) ? " " + pick(r, COLORS).toLowerCase() : ""), resultsCount: chance(r, 0.06) ? 0 : int(r, 1, 2400) };
    if (chance(r, 0.3)) props.filters = { category: pick(r, CAT_NAMES), maxPrice: pick(r, [25, 50, 100, 250]) };
  } else if (type === "purchase") {
    props = { orderNumber: orderNumber(int(r, 0, N.orders - 1)), revenueUsd: round2(Math.exp(4 + normal(r) * 0.9)) };
  } else if (type === "error") {
    props = { code: weighted(r, [["HTTP_500", 30], ["HTTP_502", 10], ["HTTP_404", 35], ["TIMEOUT", 15], ["PAYMENT_DECLINED", 10]]), message: pick(r, ["Something went wrong", "Gateway timeout", "Not found", "Card declined"]) };
    if (chance(r, 0.3)) props.stack = "TypeError: Cannot read properties of undefined (reading 'price')\n    at CartItem (cart.tsx:42:17)";
  } else if (type === "video_play") props = { videoId: "v" + int(r, 1, 900), percentWatched: int(r, 1, 100) };
  else if (type === "click") props = { element: pick(r, ["hero_banner", "nav_deals", "footer_help", "recommendation_card", "size_guide", "chat_widget"]), position: int(r, 1, 12) };
  else if (type === "login" || type === "signup") props = { method: weighted(r, [["password", 55], ["google", 25], ["apple", 15], ["magic_link", 5]]), success: chance(r, 0.93) };
  emit("events", {
    id: i + 1, ts: new Date(t), type, customer_id: u ? u.id : null,
    anonymous_id: token(r, 16, "abcdef0123456789"),
    session_id: "s_" + hash32(i >> 4, 77).toString(16).padStart(8, "0"),
    page_path: type === "product_view" ? `/p/${viewed.sku.toLowerCase()}` : pick(r, PAGES),
    referrer: chance(r, 0.35) ? pick(r, ["https://www.google.com/", "https://www.facebook.com/", "https://t.co/", "https://www.bing.com/", "android-app://com.google.android.gm"]) : null,
    device_type: deviceType, os, browser,
    app_version: chance(r, 0.3) ? `5.${int(r, 0, 14)}.${int(r, 0, 9)}` : null,
    country_code: country[0], city: city[0],
    lat: round2(city[2] + normal(r) * 0.15), lng: round2(city[3] + normal(r) * 0.15),
    ip: chance(r, 0.08) ? `2001:db8:${int(r, 0, 65535).toString(16)}::${int(r, 1, 65535).toString(16)}` : `${int(r, 1, 223)}.${int(r, 0, 255)}.${int(r, 0, 255)}.${int(r, 1, 254)}`,
    duration_ms: type === "page_view" ? Math.floor(Math.exp(8 + normal(r) * 1.3)) : null,
    props,
    utm: chance(r, 0.28) ? { source: pick(r, ["google", "facebook", "instagram", "newsletter", "tiktok", "affiliate"]), medium: pick(r, ["cpc", "social", "email", "display"]), campaign: pick(r, ["bfcm_2025", "fall_drop", "retargeting_q3", "brand", "evergreen"]) } : null,
    is_bot: chance(r, 0.002),
  });
}

const TICKET_CATS = [["where_is_my_order", 28], ["return_request", 18], ["refund_status", 12], ["damaged_item", 9], ["payment_issue", 8], ["account_access", 7], ["product_question", 8], ["bug_report", 4], ["cancel_order", 5], ["complaint", 1]];
const ORDER_CATS = new Set(["where_is_my_order", "return_request", "refund_status", "damaged_item", "cancel_order"]);

export function genTicket(i, emit) {
  const r = rngFor(TAG.tickets, i);
  const category = weighted(r, TICKET_CATS);
  let u, t, order = null;
  if (ORDER_CATS.has(category) || chance(r, 0.2)) {
    order = orderHead(int(r, 0, N.orders - 1));
    u = order.u;
    t = Math.floor(Math.min(NOW, order.createdAt + Math.exp(1 + r() * 3.5) * 2.4 * 3_600_000));
  } else {
    u = customerCore(zipf(r, N.customers, 1.5));
    t = seasonal(r, Math.max(u.signupAt, T_ORDERS), NOW);
  }
  const id = i + 1;
  const priority = weighted(r, [["low", 30], ["normal", 50], ["high", 15], ["urgent", 5]]);
  const age = NOW - t;
  const status = age < DAY ? weighted(r, [["new", 50], ["open", 40], ["pending_customer", 10]])
    : age < 7 * DAY ? weighted(r, [["open", 30], ["pending_customer", 25], ["solved", 40], ["escalated", 5]])
    : weighted(r, [["closed", 82], ["solved", 12], ["pending_customer", 3], ["escalated", 1], ["open", 2]]);
  const agent = status === "new" ? null : pick(r, AGENTS);
  const nMsg = status === "new" ? 1 : Math.min(60, 1 + Math.floor(Math.exp(r() * 3.3)));
  let mt = t, firstResponse = null;
  for (let k = 0; k < nMsg; k++) {
    const fromCustomer = k % 2 === 0 || chance(r, 0.15);
    if (!fromCustomer && firstResponse === null) firstResponse = mt;
    emit("ticket_messages", {
      id: id * 64 + k, ticket_id: id, seq: k + 1, author_type: fromCustomer ? "customer" : "agent",
      agent_id: fromCustomer ? null : agent.id, body: words(r, 6, fromCustomer ? 120 : 70),
      is_internal: !fromCustomer && chance(r, 0.1), attachment_count: chance(r, 0.08) ? int(r, 1, 3) : 0, created_at: new Date(mt),
    });
    if (k < nMsg - 1) mt = Math.floor(Math.min(NOW, mt + Math.exp(r() * 4) * 1_200_000));
  }
  const slaMs = { urgent: 1, high: 4, normal: 24, low: 72 }[priority] * 3_600_000;
  const resolved = status === "solved" || status === "closed";
  let context = null;
  if (category === "refund_status" || category === "return_request") context = { refundAmountUsd: round2(Math.exp(3.5 + normal(r))), reason: pick(r, ["damaged", "wrong_size", "late", "not_as_described", "changed_mind"]), rmaNumber: "RMA" + int(r, 100000, 999999) };
  else if (category === "bug_report") context = { platform: pick(r, ["ios", "android", "web"]), appVersion: `5.${int(r, 0, 14)}.${int(r, 0, 9)}`, severity: pick(r, ["minor", "major", "blocker"]) };
  else if (category === "where_is_my_order" || category === "damaged_item") context = { lastScan: pick(r, ["in_transit", "out_for_delivery", "exception", "delivered"]), daysLate: int(r, 0, 14) };
  else if (category === "payment_issue") context = { declineCode: pick(r, ["insufficient_funds", "do_not_honor", "expired_card", "fraudulent", "3ds_failed"]), attempts: int(r, 1, 6) };
  emit("tickets", {
    id, ticket_number: 500_000 + i, customer_id: u.id, order_id: order ? order.id : null,
    subject: `${category.replace(/_/g, " ")}${order ? " - " + orderNumber(order.i) : ""}`,
    category, priority, status,
    channel: weighted(r, [["email", 45], ["chat", 35], ["phone", 12], ["social", 5], ["web_form", 3]]),
    assignee_id: agent ? agent.id : null,
    message_count: nMsg,
    sla_due_at: new Date(t + slaMs),
    first_response_at: firstResponse === null ? null : new Date(firstResponse),
    sla_breached: firstResponse === null ? age > slaMs : firstResponse > t + slaMs,
    csat_score: resolved && chance(r, 0.35) ? weighted(r, [[1, 10], [2, 7], [3, 13], [4, 25], [5, 45]]) : null,
    tags: new PgArray(sample(r, ["repeat_contact", "vip", "angry", "macro_used", "social_escalation", "legal", "chargeback", "follow_up"], weighted(r, [[0, 55], [1, 30], [2, 15]]))),
    context,
    created_at: new Date(t), updated_at: new Date(mt), resolved_at: resolved ? new Date(mt) : null,
  });
}

const SERVICES = ["api-gateway", "checkout", "catalog", "search", "payments", "inventory", "auth", "notifications", "recommendations", "orders"];
const REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-northeast-1"];
export function genHost(h, emit) {
  const r = rngFor(TAG.metrics, h);
  const service = SERVICES[h % SERVICES.length];
  const region = REGIONS[Math.floor(h / SERVICES.length) % REGIONS.length];
  const env = h % 25 === 0 ? "staging" : "prod";
  emit("hosts", { id: h + 1, hostname: `${service}-${region}-${String(h).padStart(3, "0")}`, service, region, az: region + pick(r, ["a", "b", "c"]), instance_type: pick(r, ["m6i.large", "m6i.xlarge", "c6g.2xlarge", "r6i.large"]), env });
  const from = NOW - metricDays * DAY, to = NOW;
  const baseCpu = 15 + r() * 30, baseLat = 20 + r() * 80;
  // a few incidents per host: cpu spike + latency + errors
  const incidents = Array.from({ length: int(r, 1, 4) }, () => { const s = from + r() * (to - from); return [s, s + (10 + r() * 120) * 60_000, 1.5 + r() * 3]; });
  for (let t = from; t < to; t += 60_000) {
    const d = new Date(t);
    const load = HOUR_W[d.getUTCHours()] * DOW_W[d.getUTCDay()];
    let boost = 1;
    for (const inc of incidents) if (t >= inc[0] && t <= inc[1]) boost = inc[2];
    const rps = Math.max(0, Math.round((200 + 1800 * load) * (env === "staging" ? 0.02 : 1) + normal(r) * 40));
    const p50 = Math.max(1, baseLat * (0.6 + 0.4 * load) * boost + normal(r) * 3);
    emit("metrics", {
      host_id: h + 1, ts: d,
      cpu_pct: round2(Math.min(100, Math.max(0.5, baseCpu * load * boost + normal(r) * 4))),
      mem_pct: round2(Math.min(99, 40 + 30 * ((t - from) % (3 * DAY)) / (3 * DAY) + normal(r) * 2)), // slow leak, redeploy every 3 days
      rps, latency_p50_ms: round2(p50), latency_p95_ms: round2(p50 * (2 + r())), latency_p99_ms: round2(p50 * (3.5 + r() * 3 * boost)),
      errors_5xx: Math.max(0, Math.round(rps * 0.001 * boost * boost + normal(r))),
      gc_pause_ms: chance(r, 0.05) ? round2(Math.exp(2 + r() * 3)) : 0,
    });
  }
}

// Work units: entity -> [generator, count, chunk size]. Each chunk runs in its own worker.
export function plan() {
  return [
    ["events", genEvent, N.events, 500_000],
    ["orders", genOrder, N.orders, 250_000],
    ["reviews", genReview, N.reviews, 250_000],
    ["customers", genCustomer, N.customers, 125_000],
    ["tickets", genTicket, N.tickets, 50_000],
    ["hosts", genHost, N.hosts, 20],
    ["products", genProduct, N.products, 25_000],
  ];
}
