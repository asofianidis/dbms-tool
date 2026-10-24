// Production-shaped Mongo dataset generator, run inside mongosh by seed-mongo.sh.
// Every document i of a collection is derived from its own seeded PRNG, so any worker can
// recompute another collection's document (e.g. an order's customer) without a lookup and
// cross-collection references stay consistent across parallel workers.
//
// env: COLL (users|products|orders|reviews|events|tickets|inventory|metrics|warehouses), START, END
//      SCALE (default 1) multiplies the collection sizes, METRIC_DAYS (default 17) of per-minute metrics.
// The app's "Seed sample database" also runs this file, with shims for process, db, print and ObjectId.

const COLL = process.env.COLL;
const START = Number(process.env.START || 0);
const END = Number(process.env.END || 0);
const SCALE = Number(process.env.SCALE || 1);
const METRIC_DAYS = Number(process.env.METRIC_DAYS || 17);

const N = {
  users: 1_000_000,
  products: 100_000,
  orders: 5_000_000,
  reviews: 2_000_000,
  events: 10_000_000,
  tickets: 500_000,
  hosts: 200,
};
for (const k of Object.keys(N)) N[k] = Math.max(k === "hosts" ? 10 : 100, Math.round(N[k] * SCALE));
N.warehouses = 12;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 22, 23, 59);
const T_ORDERS = Date.UTC(2023, 0, 1);
const T_SIGNUP = Date.UTC(2021, 0, 1);
const T_CATALOG = Date.UTC(2020, 5, 1);
const V2_CUTOVER = Date.UTC(2024, 3, 1); // orders/users schema migration date
const TAG = { users: 1, products: 2, orders: 3, reviews: 4, events: 5, tickets: 6, inventory: 7, warehouses: 8, metrics: 9 };

// ---------- randomness ----------
function hash32(a, b) {
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
function normal(r) {
  return Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}
// Heavy-head index: small indices are drawn far more often (whales, best-sellers).
const zipf = (r, n, k) => Math.min(n - 1, Math.floor(n * Math.pow(r(), k)));
function sample(r, arr, k) {
  const out = new Set();
  while (out.size < Math.min(k, arr.length)) out.add(pick(r, arr));
  return [...out];
}
function hex(n, len) { return n.toString(16).padStart(len, "0"); }
function oid(ms, tag, i) { return ObjectId(hex(Math.floor(ms / 1000), 8) + hex(tag, 2) + hex(i, 14)); }
function token(r, len, alphabet) {
  alphabet = alphabet || "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let k = 0; k < len; k++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

// ---------- time shaping ----------
const MONTH_W = [0.85, 0.8, 0.9, 0.9, 0.95, 0.95, 0.9, 0.95, 1.0, 1.05, 1.35, 1.6];
const DOW_W = [1.15, 0.95, 0.9, 0.95, 1.0, 1.1, 1.2];
const HOUR_W = [0.3, 0.2, 0.15, 0.12, 0.12, 0.15, 0.25, 0.4, 0.6, 0.75, 0.85, 0.9, 0.95, 0.95, 0.95, 1.0, 1.0, 1.0, 1.05, 1.1, 1.1, 0.95, 0.7, 0.5];
// Growth trend + seasonality + Black Friday/Cyber Monday spikes, by rejection sampling.
function seasonal(r, from, to) {
  for (let tries = 0; tries < 200; tries++) {
    const t = from + r() * (to - from);
    const d = new Date(t);
    const m = d.getUTCMonth(), day = d.getUTCDate();
    let w = (0.35 + 0.65 * (t - T_ORDERS) / (NOW - T_ORDERS)) * MONTH_W[m] * DOW_W[d.getUTCDay()] * HOUR_W[d.getUTCHours()];
    if ((m === 10 && day >= 24) || (m === 11 && day <= 2)) w *= 3.2;
    if (m === 11 && day >= 26) w *= 0.6;
    if (r() * 6.5 < w) return t;
  }
  return from + r() * (to - from);
}

// ---------- reference data ----------
const FIRST = ["James","Mary","Robert","Patricia","John","Jennifer","Michael","Linda","David","Elizabeth","William","Barbara","Richard","Susan","Joseph","Jessica","Thomas","Sarah","Carlos","Karen","Daniel","Lisa","Matthew","Nancy","Anthony","Sofia","Mark","Ana","Paul","Emily","Kevin","Olivia","Wei","Mei","Hiroshi","Yuki","Arjun","Priya","Rahul","Ananya","Lukas","Emma","Mateo","Lucia","Noah","Mia","Liam","Chloe","Oliver","Amelia","Mohammed","Fatima","Omar","Aisha","Ivan","Olga","Pierre","Camille","Giulia","Marco","Lars","Ingrid","Kwame","Ama","Diego","Valentina","Jin","Seo-yeon","Thanh","Linh"];
const LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson","White","Harris","Clark","Lewis","Walker","Hall","Young","King","Wright","Scott","Nguyen","Kim","Chen","Wang","Li","Zhang","Patel","Shah","Singh","Kumar","Müller","Schmidt","Schneider","Fischer","Rossi","Russo","Bianchi","Dubois","Moreau","Laurent","Silva","Santos","Oliveira","Sato","Suzuki","Takahashi","Tanaka","Ivanov","Petrov","Kowalski","Nowak","Jensen","Hansen","O'Brien","Murphy","Okafor","Mensah"];
const COUNTRIES = [
  // code, weight, currency, fxToUsd, taxRate, cities [name, region, lat, lng]
  ["US", 38, "USD", 1, 0.0725, [["New York","NY",40.71,-74.0],["Los Angeles","CA",34.05,-118.24],["Chicago","IL",41.88,-87.63],["Houston","TX",29.76,-95.37],["Phoenix","AZ",33.45,-112.07],["Seattle","WA",47.61,-122.33],["Miami","FL",25.76,-80.19],["Denver","CO",39.74,-104.99],["Boston","MA",42.36,-71.06],["Atlanta","GA",33.75,-84.39],["Austin","TX",30.27,-97.74],["Portland","OR",45.52,-122.68]]],
  ["GB", 9, "GBP", 1.27, 0.2, [["London","ENG",51.51,-0.13],["Manchester","ENG",53.48,-2.24],["Birmingham","ENG",52.49,-1.89],["Edinburgh","SCT",55.95,-3.19],["Glasgow","SCT",55.86,-4.25]]],
  ["DE", 8, "EUR", 1.08, 0.19, [["Berlin","BE",52.52,13.4],["Munich","BY",48.14,11.58],["Hamburg","HH",53.55,9.99],["Cologne","NW",50.94,6.96],["Frankfurt","HE",50.11,8.68]]],
  ["FR", 6, "EUR", 1.08, 0.2, [["Paris","IDF",48.86,2.35],["Lyon","ARA",45.76,4.84],["Marseille","PAC",43.3,5.37],["Toulouse","OCC",43.6,1.44]]],
  ["CA", 6, "CAD", 0.73, 0.13, [["Toronto","ON",43.65,-79.38],["Vancouver","BC",49.28,-123.12],["Montreal","QC",45.5,-73.57],["Calgary","AB",51.05,-114.07]]],
  ["AU", 4, "AUD", 0.66, 0.1, [["Sydney","NSW",-33.87,151.21],["Melbourne","VIC",-37.81,144.96],["Brisbane","QLD",-27.47,153.03],["Perth","WA",-31.95,115.86]]],
  ["JP", 5, "JPY", 0.0067, 0.1, [["Tokyo","13",35.68,139.69],["Osaka","27",34.69,135.5],["Yokohama","14",35.44,139.64],["Sapporo","01",43.06,141.35]]],
  ["BR", 5, "BRL", 0.2, 0.17, [["São Paulo","SP",-23.55,-46.63],["Rio de Janeiro","RJ",-22.91,-43.17],["Brasília","DF",-15.79,-47.88],["Salvador","BA",-12.97,-38.5]]],
  ["IN", 7, "INR", 0.012, 0.18, [["Mumbai","MH",19.08,72.88],["Delhi","DL",28.61,77.21],["Bengaluru","KA",12.97,77.59],["Hyderabad","TG",17.39,78.49],["Chennai","TN",13.08,80.27]]],
  ["ES", 3, "EUR", 1.08, 0.21, [["Madrid","MD",40.42,-3.7],["Barcelona","CT",41.39,2.17],["Valencia","VC",39.47,-0.38]]],
  ["IT", 3, "EUR", 1.08, 0.22, [["Rome","LAZ",41.9,12.5],["Milan","LOM",45.46,9.19],["Naples","CAM",40.85,14.27]]],
  ["NL", 2, "EUR", 1.08, 0.21, [["Amsterdam","NH",52.37,4.9],["Rotterdam","ZH",51.92,4.48]]],
  ["MX", 3, "MXN", 0.055, 0.16, [["Mexico City","CMX",19.43,-99.13],["Guadalajara","JAL",20.67,-103.35],["Monterrey","NLE",25.69,-100.32]]],
  ["SE", 1, "SEK", 0.095, 0.25, [["Stockholm","AB",59.33,18.07],["Gothenburg","O",57.71,11.97]]],
];
const LANG = { US: "en", GB: "en", DE: "de", FR: "fr", CA: "en", AU: "en", JP: "ja", BR: "pt", IN: "en", ES: "es", IT: "it", NL: "nl", MX: "es", SE: "sv" };
const COUNTRY_W = COUNTRIES.map((c, idx) => [idx, c[1]]);
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
const BRANDS = ["Acme","Northwind","Contoso","Globex","Initech","Umbrella","Stark","Wayne","Hooli","Vandelay","Soylent","Tyrell","Cyberdyne","Wonka","Aperture","Monarch","Pied Piper","Gringotts","Oceanic","Blue Sun","Zenith","Lumen","Kestrel","Halcyon","Nimbus","Orbital","Pinecrest","Ridgeway","Solace","Verdant"];
const ADJ = ["Ultra","Pro","Classic","Essential","Premium","Eco","Smart","Compact","Deluxe","Lite","Max","Signature","Everyday","Travel","Studio","Heritage","Urban","Fusion","Air","Core"];
const COLORS = ["Black","White","Navy","Grey","Red","Blue","Green","Beige","Pink","Olive","Burgundy","Silver","Gold","Charcoal"];
const SIZES = ["XS","S","M","L","XL","XXL"];
const MATERIALS = ["Cotton","Polyester","Wool","Linen","Leather","Denim","Bamboo","Steel","Oak","Walnut","Ceramic","Glass","Aluminum","Recycled Plastic"];
const WORDS = "the a quality product arrived quickly works well great value price would recommend again bought this for my daughter son wife husband office kitchen after using it daily for weeks the material feels solid packaging was damaged but item fine customer service helpful replacement shipped size runs small large color matches picture exactly not as described battery life impressive sound clear fit perfect comfortable cheap flimsy broke after month returned refund easy setup instructions confusing five stars love it disappointed expected better overall happy with purchase".split(" ");
const POS = ["Love it","Excellent","Great value","Highly recommend","Exceeded expectations","Perfect","Works great","Best purchase this year"];
const NEG = ["Disappointed","Broke quickly","Not as described","Waste of money","Poor quality","Returned it","Meh","Would not buy again"];
const MID = ["It's okay","Decent","Does the job","Average","Mixed feelings","Good but pricey"];

const WAREHOUSES = [
  ["WH-NJ1", "Newark", "US", 40.73, -74.17], ["WH-CA1", "Ontario", "US", 34.06, -117.65], ["WH-TX1", "Dallas", "US", 32.78, -96.8],
  ["WH-IL1", "Joliet", "US", 41.53, -88.08], ["WH-GA1", "Atlanta", "US", 33.64, -84.43], ["WH-UK1", "Milton Keynes", "GB", 52.04, -0.76],
  ["WH-DE1", "Leipzig", "DE", 51.34, 12.37], ["WH-FR1", "Lyon", "FR", 45.76, 4.84], ["WH-CA2", "Mississauga", "CA", 43.59, -79.64],
  ["WH-JP1", "Chiba", "JP", 35.61, 140.12], ["WH-BR1", "Campinas", "BR", -22.91, -47.06], ["WH-IN1", "Bhiwandi", "IN", 19.3, 73.06],
];
const WH_FOR_COUNTRY = { US: [0, 1, 2, 3, 4], GB: [5], DE: [6], FR: [7], ES: [7], IT: [6, 7], NL: [6], SE: [6], CA: [8, 0], JP: [9], BR: [10], IN: [11], MX: [2], AU: [1] };
const CARRIERS = { US: ["UPS", "FedEx", "USPS", "Amazon Logistics"], GB: ["Royal Mail", "DPD", "Evri"], DE: ["DHL", "Hermes", "DPD"], FR: ["La Poste", "Chronopost", "DPD"], JP: ["Yamato", "Sagawa", "Japan Post"], BR: ["Correios", "Jadlog"], IN: ["Delhivery", "Blue Dart", "India Post"] };

// ---------- core (recomputable) entities ----------
function userCore(i) {
  const r = rngFor(TAG.users, i);
  const ci = weighted(r, COUNTRY_W);
  const c = COUNTRIES[ci];
  const city = pick(r, c[5]);
  const first = pick(r, FIRST), last = pick(r, LAST);
  const signupAt = Math.floor(T_SIGNUP + (NOW - T_SIGNUP) * Math.pow(r(), 0.75));
  return { r, i, _id: oid(signupAt, TAG.users, i), first, last, country: c, city, signupAt };
}
function productCore(i) {
  const r = rngFor(TAG.products, i);
  const l1 = weighted(r, CAT_W);
  const cat = CATEGORIES[l1];
  const l2 = pick(r, Object.keys(cat.sub));
  const l3 = pick(r, cat.sub[l2]);
  const brand = BRANDS[Math.floor(Math.pow(r(), 1.6) * BRANDS.length)];
  const name = `${brand} ${pick(r, ADJ)} ${l3.replace(/s$/, "")} ${token(r, 1, "ABCDEFGHKLMNPRSTVXZ")}${int(r, 1, 9)}${chance(r, 0.3) ? "00" : ""}`;
  const price = round2(Math.max(0.99, cat.median * Math.exp(cat.sigma * normal(r))) ) - (chance(r, 0.6) ? 0.01 : 0);
  const createdAt = Math.floor(T_CATALOG + (NOW - 30 * DAY - T_CATALOG) * r());
  return { r, i, _id: oid(createdAt, TAG.products, i), sku: `${cat.code}-${hex(i, 6).toUpperCase()}`, name, l1, l2, l3, brand, price: round2(Math.max(0.99, price)), createdAt };
}
function orderHead(i) {
  const r = rngFor(TAG.orders, i);
  const custIdx = zipf(r, N.users, 2.5);
  const u = userCore(custIdx);
  let createdAt = Math.floor(seasonal(r, T_ORDERS, NOW));
  if (createdAt < u.signupAt) createdAt = Math.floor(u.signupAt + r() * Math.min(45 * DAY, NOW - u.signupAt));
  return { r, i, _id: oid(createdAt, TAG.orders, i), u, createdAt };
}
function orderNumber(i) { return "ORD-" + String(10_000_000 + i); }

function address(r, u, label) {
  const [cityName, region, lat, lng] = u.city;
  return {
    label,
    line1: `${int(r, 1, 9999)} ${pick(r, STREETS)}`,
    line2: chance(r, 0.18) ? `Apt ${int(r, 1, 450)}` : null,
    city: cityName,
    region,
    postalCode: String(int(r, 10000, 99999)),
    country: u.country[0],
    location: { type: "Point", coordinates: [round2(lng + normal(r) * 0.08), round2(lat + normal(r) * 0.08)] },
  };
}

// ---------- full documents ----------
function userDoc(i) {
  const u = userCore(i);
  const r = u.r;
  const c = u.country;
  const v2 = u.signupAt >= V2_CUTOVER;
  const local = `${u.first}.${u.last}`.toLowerCase().normalize("NFD").replace(/[^a-z.]/g, "");
  const doc = {
    _id: u._id,
    email: `${local}${i}@${weighted(r, DOMAINS)}`,
    name: { first: u.first, last: u.last, display: chance(r, 0.15) ? `${u.first[0]}${u.last}`.toLowerCase() + int(r, 1, 99) : `${u.first} ${u.last}` },
    schemaVersion: v2 ? 2 : 1,
    status: weighted(r, [["active", 88], ["inactive", 7], ["suspended", 1], ["pending_verification", 4]]),
    tier: weighted(r, [["standard", 70], ["silver", 18], ["gold", 9], ["platinum", 3]]),
    country: c[0],
    locale: weighted(r, [["en-US", 45], [`${LANG[c[0]] || "en"}-${c[0]}`, 55]]),
    createdAt: new Date(u.signupAt),
    lastLoginAt: chance(r, 0.93) ? new Date(u.signupAt + r() * (NOW - u.signupAt)) : null,
    emailVerified: chance(r, 0.86),
    marketing: { email: chance(r, 0.55), sms: chance(r, 0.18), push: chance(r, 0.4) },
    preferences: { currency: c[2], theme: weighted(r, [["system", 60], ["light", 25], ["dark", 15]]), newsletterFrequency: pick(r, ["weekly", "monthly", "never"]) },
    tags: sample(r, ["vip", "wholesale", "influencer", "fraud_watch", "beta_tester", "employee", "student", "price_sensitive", "early_adopter"], weighted(r, [[0, 70], [1, 22], [2, 6], [3, 2]])),
  };
  if (chance(r, 0.7)) doc.dateOfBirth = new Date(Date.UTC(int(r, 1950, 2007), int(r, 0, 11), int(r, 1, 28)));
  if (chance(r, 0.1)) doc.referredBy = userCore(int(r, 0, N.users - 1))._id;
  if (chance(r, 0.02)) doc.deletedAt = new Date(u.signupAt + r() * (NOW - u.signupAt));
  if (v2) {
    // v2 schema: multiple addresses and typed phones
    const n = weighted(r, [[1, 70], [2, 22], [3, 8]]);
    doc.addresses = [];
    for (let k = 0; k < n; k++) doc.addresses.push({ ...address(r, u, k === 0 ? "home" : pick(r, ["work", "parents", "vacation"])), isDefault: k === 0 });
    doc.phones = [{ type: "mobile", number: `+${int(r, 1, 99)} ${int(r, 100, 999)} ${int(r, 1000000, 9999999)}`, verified: chance(r, 0.7) }];
    if (chance(r, 0.15)) doc.phones.push({ type: "home", number: `+${int(r, 1, 99)} ${int(r, 100, 999)} ${int(r, 1000000, 9999999)}`, verified: false });
    doc.auth = { providers: sample(r, ["password", "google", "apple", "facebook"], weighted(r, [[1, 75], [2, 25]])), mfaEnabled: chance(r, 0.23) };
  } else {
    // legacy v1 schema: one embedded address, phone as a plain string
    doc.address = address(r, u, "home");
    doc.phone = chance(r, 0.8) ? `${int(r, 100, 999)}-${int(r, 100, 999)}-${int(r, 1000, 9999)}` : "";
    doc.passwordHash = "$2b$10$" + token(r, 53, "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
  }
  return doc;
}

function productDoc(i) {
  const p = productCore(i);
  const r = p.r;
  const attrs = {};
  if (p.l1 === "Electronics") Object.assign(attrs, { color: pick(r, COLORS), warrantyMonths: pick(r, [12, 24, 36]), wireless: chance(r, 0.5), storageGB: p.l2 === "Phones" || p.l3 === "Laptops" ? pick(r, [64, 128, 256, 512, 1024]) : undefined, screenInches: p.l3 === "Monitors" ? pick(r, [24, 27, 32, 34]) : undefined });
  else if (p.l1 === "Apparel") Object.assign(attrs, { material: pick(r, MATERIALS.slice(0, 7)), fit: pick(r, ["slim", "regular", "relaxed"]), gender: p.l2 });
  else if (p.l1 === "Home") Object.assign(attrs, { material: pick(r, MATERIALS), dimensionsCm: { w: int(r, 10, 200), h: int(r, 5, 200), d: int(r, 5, 120) }, assemblyRequired: chance(r, 0.4) });
  else if (p.l1 === "Books") Object.assign(attrs, { author: `${pick(r, FIRST)} ${pick(r, LAST)}`, pages: int(r, 80, 1100), format: pick(r, ["Hardcover", "Paperback", "Kindle", "Audiobook"]), isbn13: "978" + int(r, 1000000000, 9999999999), language: weighted(r, [["en", 80], ["es", 6], ["de", 5], ["fr", 5], ["ja", 4]]) });
  else if (p.l1 === "Grocery") Object.assign(attrs, { weightG: int(r, 50, 5000), organic: chance(r, 0.3), shelfLifeDays: int(r, 7, 720), allergens: sample(r, ["nuts", "gluten", "dairy", "soy", "eggs"], int(r, 0, 2)) });
  else if (p.l1 === "Beauty") Object.assign(attrs, { volumeMl: pick(r, [15, 30, 50, 100, 250, 500]), skinType: pick(r, ["all", "dry", "oily", "sensitive"]), crueltyFree: chance(r, 0.6) });
  else if (p.l1 === "Sports") Object.assign(attrs, { color: pick(r, COLORS), weightKg: round2(0.1 + r() * 25), material: pick(r, MATERIALS) });
  else Object.assign(attrs, { ageRange: pick(r, ["0-2", "3-5", "6-8", "8-12", "12+"]), pieces: chance(r, 0.5) ? int(r, 10, 3000) : undefined, batteriesRequired: chance(r, 0.2) });
  for (const k of Object.keys(attrs)) if (attrs[k] === undefined) delete attrs[k];

  const variants = [];
  if (p.l1 === "Apparel" || (p.l1 === "Sports" && chance(r, 0.4))) {
    for (const color of sample(r, COLORS, int(r, 1, 4)))
      for (const size of SIZES.slice(int(r, 0, 1), int(r, 4, 6)))
        variants.push({ sku: `${p.sku}-${color.slice(0, 3).toUpperCase()}-${size}`, color, size, priceDelta: size === "XXL" ? 2 : 0, barcode: String(int(r, 100000000, 999999999)) + int(r, 1000, 9999) });
  }
  const ratingCount = Math.floor(Math.pow(r(), 3) * 9000 * (p.i < 2000 ? 5 : 1));
  const doc = {
    _id: p._id,
    sku: p.sku,
    name: p.name,
    slug: p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + p.i,
    brand: p.brand,
    category: { l1: p.l1, l2: p.l2, l3: p.l3, path: `${p.l1}/${p.l2}/${p.l3}` },
    price: p.price,
    cost: round2(p.price * (0.25 + r() * 0.45)),
    currency: "USD",
    status: weighted(r, [["active", 90], ["discontinued", 6], ["draft", 2], ["out_of_stock", 2]]),
    attributes: attrs,
    tags: sample(r, ["bestseller", "new", "sale", "limited", "eco", "gift_idea", "clearance", "exclusive", "bundle"], weighted(r, [[0, 40], [1, 35], [2, 18], [3, 7]])),
    rating: ratingCount ? { avg: round2(Math.min(5, Math.max(1, 4.1 + normal(r) * 0.55))), count: ratingCount } : null,
    images: Array.from({ length: int(r, 1, 8) }, (_, k) => ({ url: `https://cdn.example.com/p/${p.sku}/${k}.jpg`, width: 1200, height: 1200, alt: k === 0 ? p.name : null })),
    supplier: { name: `${pick(r, BRANDS)} ${pick(r, ["Manufacturing", "Trading Co", "Industries", "Supply", "Group"])}`, country: weighted(r, [["CN", 45], ["US", 15], ["VN", 10], ["DE", 7], ["IN", 8], ["MX", 5], ["TW", 5], ["IT", 5]]), leadTimeDays: int(r, 3, 90) },
    shipping: { weightKg: round2(0.05 + Math.pow(r(), 2) * 30), oversized: chance(r, 0.04), hazmat: chance(r, 0.01) },
    description: Array.from({ length: int(r, 15, 90) }, () => pick(r, WORDS)).join(" "),
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.createdAt + r() * (NOW - p.createdAt)),
  };
  if (variants.length) doc.variants = variants;
  if (chance(r, 0.15)) doc.compareAtPrice = round2(p.price * (1.1 + r() * 0.6));
  if (chance(r, 0.05)) doc.priceHistory = Array.from({ length: int(r, 2, 12) }, (_, k) => ({ at: new Date(p.createdAt + k * 30 * DAY), price: round2(p.price * (0.8 + r() * 0.4)) }));
  return doc;
}

function orderDoc(i) {
  const h = orderHead(i);
  const r = h.r, u = h.u, c = u.country;
  const t = h.createdAt;
  const v2 = t >= V2_CUTOVER;
  const fx = c[3];
  const age = NOW - t;

  // items: price in USD catalog, converted to the shopper's currency
  const nItems = weighted(r, [[1, 40], [2, 25], [3, 13], [4, 8], [5, 5], [6, 3], [7, 2], [8, 1.5], [10, 1], [12, 0.8], [25, 0.15], [60, 0.05]]);
  const b2b = nItems >= 25;
  const items = [];
  let subtotal = 0;
  const seen = new Set();
  for (let k = 0; k < nItems; k++) {
    const pIdx = zipf(r, N.products, 1.8);
    if (seen.has(pIdx)) continue;
    seen.add(pIdx);
    const p = productCore(pIdx);
    const qty = b2b ? int(r, 2, 24) : weighted(r, [[1, 80], [2, 13], [3, 4], [4, 2], [10, 1]]);
    const yearDrift = 1 + 0.04 * ((t - T_ORDERS) / (365 * DAY));
    const unitPrice = round2((p.price * yearDrift) / fx);
    const discount = chance(r, 0.12) ? round2(unitPrice * qty * pick(r, [0.05, 0.1, 0.15, 0.2, 0.3, 0.5])) : 0;
    const line = { productId: p._id, sku: p.sku, name: p.name, category: p.l1, qty, unitPrice, discount, lineTotal: round2(unitPrice * qty - discount) };
    if (p.l1 === "Apparel") line.variant = { size: pick(r, SIZES), color: pick(r, COLORS) };
    if (chance(r, 0.03)) line.giftWrap = true;
    items.push(line);
    subtotal += line.lineTotal;
  }
  subtotal = round2(subtotal);
  const coupon = chance(r, 0.11) ? weighted(r, [["WELCOME10", 30], ["SPRING15", 8], ["BFCM25", 12], ["FREESHIP", 20], ["VIP20", 5], ["SORRY10", 4], ["APP5", 10], [token(r, 8), 11]]) : null;
  const couponPct = coupon && coupon !== "FREESHIP" ? Math.min(30, Number((/^[A-Z]+(\d{1,2})$/.exec(coupon) || [0, 10])[1])) : 0;
  const orderDiscount = round2(subtotal * couponPct / 100);
  const shippingFee = coupon === "FREESHIP" || subtotal * fx > 50 ? 0 : round2(pick(r, [4.99, 6.99, 9.99, 14.99]) / fx);
  const tax = round2((subtotal - orderDiscount) * c[4]);
  const total = round2(subtotal - orderDiscount + shippingFee + tax);

  // lifecycle
  let status;
  if (age < 2 * DAY) status = weighted(r, [["pending", 30], ["paid", 40], ["processing", 25], ["payment_failed", 5]]);
  else if (age < 7 * DAY) status = weighted(r, [["processing", 15], ["shipped", 60], ["delivered", 20], ["cancelled", 5]]);
  else status = weighted(r, [["delivered", 83], ["cancelled", 6], ["returned", 4.5], ["refunded", 2.5], ["partially_refunded", 1.5], ["shipped", 1], ["lost_in_transit", 0.5], ["payment_failed", 1]]);
  const history = [{ status: "pending", at: new Date(t), by: "system" }];
  let cursor = t;
  const step = (s, minH, maxH, by) => { cursor += (minH + r() * (maxH - minH)) * 3_600_000; if (cursor > NOW) cursor = NOW; history.push({ status: s, at: new Date(cursor), by: by || "system" }); };
  const flow = {
    pending: [], payment_failed: [["payment_failed", 0, 0.1]], paid: [["paid", 0, 0.2]],
    processing: [["paid", 0, 0.2], ["processing", 1, 20]],
    shipped: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48]],
    delivered: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48], ["delivered", 20, 160]],
    cancelled: [["paid", 0, 0.2], ["cancelled", 0.5, 30, "customer"]],
    lost_in_transit: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48], ["lost_in_transit", 200, 400, "carrier"]],
    returned: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48], ["delivered", 20, 160], ["return_requested", 24, 500, "customer"], ["returned", 48, 300, "warehouse"]],
    refunded: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48], ["delivered", 20, 160], ["refunded", 24, 700, "support"]],
    partially_refunded: [["paid", 0, 0.2], ["processing", 1, 20], ["shipped", 4, 48], ["delivered", 20, 160], ["partially_refunded", 24, 700, "support"]],
  }[status];
  for (const s of flow) step(s[0], s[1], s[2], s[3]);

  const shipped = history.some((x) => x.status === "shipped");
  const delivered = history.find((x) => x.status === "delivered");
  const whChoices = WH_FOR_COUNTRY[c[0]] || [0];
  const carrier = pick(r, CARRIERS[c[0]] || ["DHL", "FedEx", "UPS"]);
  const payMethod = weighted(r, [["card", 68], ["paypal", 14], ["apple_pay", 8], ["google_pay", 4], ["klarna", 3], ["gift_card", 2], ["bank_transfer", b2b ? 40 : 1]]);
  const payment = { provider: payMethod === "card" ? weighted(r, [["stripe", 70], ["adyen", 30]]) : payMethod, status: status === "payment_failed" ? "failed" : status === "pending" ? "authorized" : status.includes("refund") ? "refunded" : "captured", amount: total, transactionId: "txn_" + token(r, 20, "abcdefghijklmnopqrstuvwxyz0123456789") };
  if (payMethod === "card") payment.card = { brand: weighted(r, [["visa", 52], ["mastercard", 30], ["amex", 12], ["discover", 3], ["jcb", c[0] === "JP" ? 30 : 1]]), last4: String(int(r, 1000, 9999)), expMonth: int(r, 1, 12), expYear: int(r, 2026, 2031), threeDSecure: chance(r, 0.6) };
  if (chance(r, 0.015)) payment.riskScore = round2(60 + r() * 40);
  else if (chance(r, 0.6)) payment.riskScore = round2(Math.pow(r(), 3) * 60);
  if (v2) payment.method = payMethod; else payment.type = payMethod; // field renamed in v2

  const shipAddr = address(r, u, "shipping");
  const doc = {
    _id: h._id,
    orderNumber: orderNumber(i),
    schemaVersion: v2 ? 2 : 1,
    customerId: u._id,
    customer: { name: `${u.first} ${u.last}`, country: c[0] },
    status,
    statusHistory: history,
    items,
    itemCount: items.reduce((s, x) => s + x.qty, 0),
    currency: c[2],
    totals: { subtotal, discount: orderDiscount, shipping: shippingFee, tax, total, totalUsd: round2(total * fx) },
    payment,
    shipping: {
      address: shipAddr,
      method: weighted(r, [["standard", 70], ["express", 20], ["next_day", 7], ["pickup", 3]]),
      carrier: shipped ? carrier : null,
      trackingNumber: shipped ? token(r, 18, "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ") : null,
      deliveredAt: delivered ? delivered.at : null,
    },
    fulfillment: { warehouseId: WAREHOUSES[pick(r, whChoices)][0], splitShipment: items.length > 3 && chance(r, 0.2) },
    createdAt: new Date(t),
    updatedAt: history[history.length - 1].at,
  };
  if (v2) {
    doc.channel = weighted(r, [["web", 52], ["ios", 23], ["android", 18], ["marketplace", 5], ["pos", 2]]);
    doc.device = doc.channel === "web" ? weighted(r, [["desktop", 55], ["mobile", 40], ["tablet", 5]]) : doc.channel === "pos" ? "terminal" : "mobile";
  }
  if (coupon) doc.coupon = coupon;
  if (b2b) { doc.b2b = { poNumber: "PO-" + int(r, 100000, 999999), netTerms: pick(r, [15, 30, 60]), company: `${pick(r, BRANDS)} ${pick(r, ["LLC", "GmbH", "Ltd", "Inc", "SA"])}` }; }
  if (chance(r, 0.02)) doc.giftMessage = Array.from({ length: int(r, 3, 15) }, () => pick(r, WORDS)).join(" ");
  if (chance(r, 0.04)) doc.flags = sample(r, ["fraud_review", "address_mismatch", "high_value", "first_order", "manual_hold", "vip"], int(r, 1, 2));
  if (status === "partially_refunded" || status === "refunded") doc.refund = { amount: status === "refunded" ? total : round2(total * (0.1 + r() * 0.5)), reason: pick(r, ["damaged", "late_delivery", "wrong_item", "not_as_described", "goodwill"]), at: history[history.length - 1].at };
  if (status === "cancelled") doc.cancellation = { reason: weighted(r, [["customer_changed_mind", 50], ["found_cheaper", 15], ["out_of_stock", 15], ["fraud_suspected", 5], ["shipping_too_slow", 15]]) };
  if (chance(r, 0.3) && v2) doc.attribution = { source: pick(r, ["google", "facebook", "instagram", "tiktok", "email", "affiliate", "direct"]), medium: pick(r, ["cpc", "organic", "social", "email", "referral"]), campaign: chance(r, 0.6) ? pick(r, ["bfcm_2024", "summer_sale", "back_to_school", "retargeting_q3", "brand_awareness", "bfcm_2025", "spring_launch"]) : null };
  return doc;
}

function reviewDoc(i) {
  const r = rngFor(TAG.reviews, i);
  const p = productCore(zipf(r, N.products, 1.6));
  const u = userCore(zipf(r, N.users, 1.4));
  const rating = weighted(r, [[1, 8], [2, 5], [3, 9], [4, 21], [5, 57]]);
  const from = Math.max(p.createdAt, u.signupAt, T_ORDERS);
  const t = Math.floor(seasonal(r, from, NOW));
  const doc = {
    _id: oid(t, TAG.reviews, i),
    productId: p._id,
    sku: p.sku,
    userId: u._id,
    authorName: `${u.first} ${u.last[0]}.`,
    rating,
    title: pick(r, rating >= 4 ? POS : rating <= 2 ? NEG : MID),
    body: Array.from({ length: Math.floor(5 + Math.pow(r(), 2) * 160) }, () => pick(r, WORDS)).join(" "),
    verifiedPurchase: chance(r, 0.78),
    helpfulVotes: Math.floor(Math.pow(r(), 6) * 2500),
    language: weighted(r, [["en", 78], ["es", 6], ["de", 5], ["fr", 4], ["pt", 3], ["ja", 2], ["it", 2]]),
    status: weighted(r, [["published", 92], ["pending_moderation", 4], ["rejected", 3], ["flagged", 1]]),
    createdAt: new Date(t),
  };
  if (chance(r, 0.1)) doc.images = Array.from({ length: int(r, 1, 5) }, (_, k) => `https://cdn.example.com/r/${i}/${k}.jpg`);
  if (rating <= 3 && chance(r, 0.15)) doc.sellerResponse = { body: "We're sorry to hear that. Please contact support so we can make it right.", at: new Date(Math.min(NOW, t + r() * 10 * DAY)) };
  if (chance(r, 0.25)) doc.aspects = Object.fromEntries(sample(r, ["quality", "value", "shipping", "fit", "durability", "ease_of_use"], int(r, 1, 3)).map((a) => [a, int(r, 1, 5)]));
  return doc;
}

const EVENT_TYPES = [["page_view", 42], ["product_view", 22], ["search", 9], ["add_to_cart", 7], ["remove_from_cart", 1.5], ["checkout_start", 2.5], ["purchase", 1.2], ["login", 4], ["signup", 0.6], ["wishlist_add", 2], ["video_play", 2], ["error", 1.5], ["click", 4.7]];
const PAGES = ["/", "/search", "/cart", "/checkout", "/account", "/account/orders", "/deals", "/c/electronics", "/c/apparel", "/c/home", "/c/books", "/help", "/blog/holiday-gift-guide", "/stores"];
const BROWSERS = [["Chrome", 62], ["Safari", 22], ["Edge", 6], ["Firefox", 5], ["Samsung Internet", 4], ["Opera", 1]];
const SEARCHES = ["wireless earbuds", "running shoes", "coffee", "laptop stand", "yoga mat", "gift for dad", "usb c cable", "winter jacket", "lego", "air fryer", "phone case", "desk chair", "protein", "sunscreen", "headphones noise cancelling", "kindle", "monitor 27", "backpack"];

function eventDoc(i) {
  const r = rngFor(TAG.events, i);
  const t = Math.floor(seasonal(r, NOW - 180 * DAY, NOW));
  const anon = chance(r, 0.42);
  const u = anon ? null : userCore(zipf(r, N.users, 1.8));
  const ci = u ? -1 : weighted(r, COUNTRY_W);
  const country = u ? u.country : COUNTRIES[ci];
  const city = u ? u.city : pick(r, country[5]);
  const type = weighted(r, EVENT_TYPES);
  const viewed = productCore(zipf(r, N.products, 1.5));
  const deviceType = weighted(r, [["mobile", 58], ["desktop", 36], ["tablet", 6]]);
  const os = deviceType === "desktop" ? weighted(r, [["Windows", 65], ["macOS", 28], ["Linux", 4], ["ChromeOS", 3]]) : weighted(r, [["iOS", 52], ["Android", 48]]);
  const doc = {
    _id: oid(t, TAG.events, i),
    ts: new Date(t),
    type,
    userId: u ? u._id : null,
    anonymousId: token(r, 16, "abcdef0123456789"),
    sessionId: "s_" + hex(hash32(i >> 4, 77), 8),
    page: { path: type === "product_view" ? `/p/${viewed.sku.toLowerCase()}` : pick(r, PAGES), referrer: chance(r, 0.4) ? pick(r, ["https://www.google.com/", "https://www.facebook.com/", "https://t.co/", "https://www.bing.com/", "android-app://com.google.android.gm", null]) : null },
    device: { type: deviceType, os, browser: weighted(r, BROWSERS), appVersion: chance(r, 0.3) ? `5.${int(r, 0, 14)}.${int(r, 0, 9)}` : null, screen: deviceType === "desktop" ? pick(r, ["1920x1080", "2560x1440", "1440x900", "3840x2160"]) : pick(r, ["390x844", "412x915", "430x932", "360x800", "820x1180"]) },
    geo: { country: country[0], city: city[0], region: city[1], loc: { type: "Point", coordinates: [round2(city[3] + normal(r) * 0.15), round2(city[2] + normal(r) * 0.15)] } },
    durationMs: type === "page_view" ? Math.floor(Math.exp(8 + normal(r) * 1.3)) : null,
  };
  const props = {};
  if (type === "product_view" || type === "add_to_cart" || type === "remove_from_cart" || type === "wishlist_add") {
    const p = type === "product_view" ? viewed : productCore(zipf(r, N.products, 1.5));
    Object.assign(props, { productId: p._id, sku: p.sku, price: p.price, category: p.l1 });
    if (type !== "product_view") props.qty = weighted(r, [[1, 85], [2, 10], [3, 5]]);
  } else if (type === "search") {
    Object.assign(props, { query: pick(r, SEARCHES) + (chance(r, 0.2) ? " " + pick(r, COLORS).toLowerCase() : ""), resultsCount: chance(r, 0.06) ? 0 : int(r, 1, 2400), filters: chance(r, 0.3) ? { category: pick(r, CAT_NAMES), maxPrice: pick(r, [25, 50, 100, 250]) } : null });
  } else if (type === "purchase") {
    const o = orderHead(int(r, 0, N.orders - 1));
    Object.assign(props, { orderNumber: orderNumber(o.i), revenueUsd: round2(Math.exp(4 + normal(r) * 0.9)) });
  } else if (type === "error") {
    Object.assign(props, { code: weighted(r, [["HTTP_500", 30], ["HTTP_502", 10], ["HTTP_404", 35], ["TIMEOUT", 15], ["PAYMENT_DECLINED", 10]]), message: pick(r, ["Something went wrong", "Gateway timeout", "Not found", "Card declined"]), stack: chance(r, 0.3) ? "TypeError: Cannot read properties of undefined (reading 'price')\n    at CartItem (cart.tsx:42:17)" : undefined });
  } else if (type === "video_play") {
    Object.assign(props, { videoId: "v" + int(r, 1, 900), percentWatched: int(r, 1, 100) });
  } else if (type === "click") {
    Object.assign(props, { element: pick(r, ["hero_banner", "nav_deals", "footer_help", "recommendation_card", "size_guide", "chat_widget"]), position: int(r, 1, 12) });
  } else if (type === "login" || type === "signup") {
    Object.assign(props, { method: weighted(r, [["password", 55], ["google", 25], ["apple", 15], ["magic_link", 5]]), success: chance(r, 0.93) });
  }
  for (const k of Object.keys(props)) if (props[k] === undefined) delete props[k];
  if (Object.keys(props).length) doc.props = props;
  if (chance(r, 0.28)) doc.utm = { source: pick(r, ["google", "facebook", "instagram", "newsletter", "tiktok", "affiliate"]), medium: pick(r, ["cpc", "social", "email", "display"]), campaign: pick(r, ["bfcm_2025", "fall_drop", "retargeting_q3", "brand", "evergreen"]) };
  if (chance(r, 0.15)) doc.experiments = Object.fromEntries(sample(r, ["new_checkout", "reco_v3", "free_ship_banner", "dark_pdp", "search_rerank"], int(r, 1, 3)).map((e) => [e, pick(r, ["control", "variant_a", "variant_b"])]));
  if (chance(r, 0.002)) doc.bot = { suspected: true, reason: pick(r, ["ua_pattern", "rate", "headless"]) };
  return doc;
}

const AGENTS = Array.from({ length: 60 }, (_, k) => ({ id: "agt_" + String(k + 1).padStart(3, "0"), name: `${FIRST[(k * 7) % FIRST.length]} ${LAST[(k * 11) % LAST.length]}`, team: ["Tier 1", "Tier 1", "Tier 2", "Billing", "Logistics", "Escalations"][k % 6] }));
const TICKET_CATS = [["where_is_my_order", 28], ["return_request", 18], ["refund_status", 12], ["damaged_item", 9], ["payment_issue", 8], ["account_access", 7], ["product_question", 8], ["bug_report", 4], ["cancel_order", 5], ["complaint", 1]];

function ticketDoc(i) {
  const r = rngFor(TAG.tickets, i);
  const category = weighted(r, TICKET_CATS);
  const orderRelated = ["where_is_my_order", "return_request", "refund_status", "damaged_item", "cancel_order"].includes(category) || chance(r, 0.2);
  let u, t, order = null;
  if (orderRelated) {
    order = orderHead(int(r, 0, N.orders - 1));
    u = order.u;
    t = Math.min(NOW, order.createdAt + Math.exp(1 + r() * 3.5) * 3_600_000 * 24 / 10);
  } else {
    u = userCore(zipf(r, N.users, 1.5));
    t = Math.floor(seasonal(r, Math.max(u.signupAt, T_ORDERS), NOW));
  }
  t = Math.floor(t);
  const priority = weighted(r, [["low", 30], ["normal", 50], ["high", 15], ["urgent", 5]]);
  const age = NOW - t;
  const status = age < 1 * DAY ? weighted(r, [["new", 50], ["open", 40], ["pending_customer", 10]]) : age < 7 * DAY ? weighted(r, [["open", 30], ["pending_customer", 25], ["solved", 40], ["escalated", 5]]) : weighted(r, [["closed", 82], ["solved", 12], ["pending_customer", 3], ["escalated", 1], ["open", 2]]);
  const agent = status === "new" ? null : pick(r, AGENTS);
  const nMsg = status === "new" ? 1 : Math.min(60, 1 + Math.floor(Math.exp(r() * 3.3)));
  const messages = [];
  let mt = t;
  for (let k = 0; k < nMsg; k++) {
    const fromCustomer = k % 2 === 0 || chance(r, 0.15);
    messages.push({
      id: k + 1,
      from: fromCustomer ? "customer" : "agent",
      authorId: fromCustomer ? u._id : agent && agent.id,
      body: Array.from({ length: int(r, 6, fromCustomer ? 120 : 70) }, () => pick(r, WORDS)).join(" "),
      at: new Date(mt),
      internal: !fromCustomer && chance(r, 0.1),
      attachments: chance(r, 0.08) ? [{ name: pick(r, ["photo.jpg", "receipt.pdf", "screenshot.png"]), sizeBytes: int(r, 20_000, 8_000_000) }] : undefined,
    });
    mt = Math.min(NOW, mt + Math.exp(r() * 4) * 3_600_000 / 3);
  }
  for (const m of messages) if (m.attachments === undefined) delete m.attachments;
  const firstAgent = messages.find((m) => m.from === "agent");
  const slaHours = { urgent: 1, high: 4, normal: 24, low: 72 }[priority];
  const doc = {
    _id: oid(t, TAG.tickets, i),
    ticketNumber: 500_000 + i,
    subject: `${category.replace(/_/g, " ")}${order ? " - " + orderNumber(order.i) : ""}`,
    category,
    priority,
    status,
    channel: weighted(r, [["email", 45], ["chat", 35], ["phone", 12], ["social", 5], ["web_form", 3]]),
    customerId: u._id,
    orderId: order ? order._id : null,
    assignee: agent,
    messages,
    messageCount: messages.length,
    sla: { firstResponseDueAt: new Date(t + slaHours * 3_600_000), firstResponseAt: firstAgent ? firstAgent.at : null, breached: firstAgent ? firstAgent.at.getTime() > t + slaHours * 3_600_000 : age > slaHours * 3_600_000 },
    tags: sample(r, ["repeat_contact", "vip", "angry", "macro_used", "social_escalation", "legal", "chargeback", "follow_up"], weighted(r, [[0, 55], [1, 30], [2, 15]])),
    createdAt: new Date(t),
    updatedAt: messages[messages.length - 1].at,
  };
  if (status === "solved" || status === "closed") {
    doc.resolvedAt = messages[messages.length - 1].at;
    if (chance(r, 0.35)) doc.csat = { score: weighted(r, [[1, 10], [2, 7], [3, 13], [4, 25], [5, 45]]), comment: chance(r, 0.3) ? pick(r, POS.concat(NEG)) : null };
  }
  // polymorphic context per category
  if (category === "refund_status" || category === "return_request") doc.context = { refundAmountUsd: round2(Math.exp(3.5 + normal(r))), reason: pick(r, ["damaged", "wrong_size", "late", "not_as_described", "changed_mind"]), rmaNumber: "RMA" + int(r, 100000, 999999) };
  else if (category === "bug_report") doc.context = { platform: pick(r, ["ios", "android", "web"]), appVersion: `5.${int(r, 0, 14)}.${int(r, 0, 9)}`, steps: ["open app", "go to cart", "tap checkout"], severity: pick(r, ["minor", "major", "blocker"]) };
  else if (category === "where_is_my_order" || category === "damaged_item") doc.context = { carrier: pick(r, ["UPS", "FedEx", "DHL", "USPS", "Royal Mail"]), lastScan: pick(r, ["in_transit", "out_for_delivery", "exception", "delivered"]), daysLate: int(r, 0, 14) };
  else if (category === "payment_issue") doc.context = { declineCode: pick(r, ["insufficient_funds", "do_not_honor", "expired_card", "fraudulent", "3ds_failed"]), attempts: int(r, 1, 6) };
  return doc;
}

function inventoryDocs(i) {
  const p = productCore(i);
  const r = rngFor(TAG.inventory, i);
  const whs = sample(r, WAREHOUSES.map((_, k) => k), weighted(r, [[1, 10], [2, 15], [3, 20], [4, 20], [6, 15], [8, 10], [12, 10]]));
  const popular = i < 5000;
  return whs.map((w) => {
    const onHand = chance(r, 0.07) ? 0 : Math.floor(Math.exp(2 + r() * (popular ? 6 : 4)));
    const doc = {
      _id: oid(p.createdAt, TAG.inventory, i * 16 + w),
      productId: p._id,
      sku: p.sku,
      warehouseId: WAREHOUSES[w][0],
      onHand,
      reserved: Math.min(onHand, Math.floor(r() * onHand * 0.3)),
      incoming: chance(r, 0.2) ? int(r, 10, 2000) : 0,
      reorderPoint: int(r, 5, popular ? 500 : 60),
      bin: `${token(r, 1, "ABCDEFGH")}${int(r, 1, 40)}-${int(r, 1, 12)}-${int(r, 1, 6)}`,
      unitCostUsd: round2(p.price * (0.25 + r() * 0.4)),
      lastCountedAt: new Date(NOW - r() * 120 * DAY),
      updatedAt: new Date(NOW - Math.pow(r(), 3) * 60 * DAY),
    };
    if (chance(r, 0.1)) doc.lots = Array.from({ length: int(r, 1, 4) }, () => ({ lot: "L" + int(r, 10000, 99999), qty: int(r, 1, 300), expiresAt: new Date(NOW + r() * 400 * DAY) }));
    return doc;
  });
}

const SERVICES = ["api-gateway", "checkout", "catalog", "search", "payments", "inventory", "auth", "notifications", "recommendations", "orders"];
const REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-northeast-1"];
function metricDocsForHost(h, from, to) {
  const r = rngFor(TAG.metrics, h);
  const service = SERVICES[h % SERVICES.length];
  const region = REGIONS[Math.floor(h / SERVICES.length) % REGIONS.length];
  const meta = { host: `${service}-${region}-${String(h).padStart(3, "0")}`, service, region, az: region + pick(r, ["a", "b", "c"]), instanceType: pick(r, ["m6i.large", "m6i.xlarge", "c6g.2xlarge", "r6i.large"]), env: h % 25 === 0 ? "staging" : "prod" };
  const baseCpu = 15 + r() * 30, baseLat = 20 + r() * 80;
  // a few incidents per host: cpu spike + latency + errors
  const incidents = Array.from({ length: int(r, 1, 4) }, () => { const s = from + r() * (to - from); return [s, s + (10 + r() * 120) * 60_000, 1.5 + r() * 3]; });
  const out = [];
  for (let t = from; t < to; t += 60_000) {
    const d = new Date(t);
    const hour = d.getUTCHours();
    const load = HOUR_W[hour] * DOW_W[d.getUTCDay()];
    let boost = 1;
    for (const inc of incidents) if (t >= inc[0] && t <= inc[1]) boost = inc[2];
    const cpu = Math.min(100, Math.max(0.5, baseCpu * load * boost + normal(r) * 4));
    const rps = Math.max(0, Math.round((200 + 1800 * load) * (meta.env === "staging" ? 0.02 : 1) + normal(r) * 40));
    const p50 = Math.max(1, baseLat * (0.6 + 0.4 * load) * boost + normal(r) * 3);
    out.push({
      ts: d,
      meta,
      cpuPct: round2(cpu),
      memPct: round2(Math.min(99, 40 + 30 * ((t - from) % (3 * DAY)) / (3 * DAY) + normal(r) * 2)), // sawtooth: slow leak, redeploy every 3 days
      rps,
      latencyMs: { p50: round2(p50), p95: round2(p50 * (2 + r())), p99: round2(p50 * (3.5 + r() * 3 * boost)) },
      errors5xx: Math.max(0, Math.round(rps * 0.001 * boost * boost + normal(r))),
      gcPauseMs: chance(r, 0.05) ? round2(Math.exp(2 + r() * 3)) : 0,
    });
  }
  return out;
}

function warehouseDocs() {
  return WAREHOUSES.map(([code, city, country, lat, lng], k) => ({
    _id: code,
    name: `${city} Fulfillment Center`,
    city,
    country,
    location: { type: "Point", coordinates: [lng, lat] },
    capacityPallets: 10_000 + k * 3_500,
    openedAt: new Date(Date.UTC(2015 + (k % 8), k % 12, 1)),
    features: ["cold_storage", "hazmat", "oversized", "same_day"].filter((_, j) => (k + j) % 3 !== 0),
    manager: AGENTS[k * 4].name,
  }));
}

// ---------- writer ----------
const BATCH = 1000;
function run() {
  const coll = db.getCollection(COLL);
  let buf = [];
  let count = 0;
  const flush = () => { if (buf.length) { coll.insertMany(buf, { ordered: false, writeConcern: { w: 1 } }); count += buf.length; buf = []; } };
  const push = (d) => { buf.push(d); if (buf.length >= BATCH) flush(); };
  const gen = { users: userDoc, products: productDoc, orders: orderDoc, reviews: reviewDoc, events: eventDoc, tickets: ticketDoc }[COLL];
  const started = Date.now();
  if (gen) for (let i = START; i < END; i++) push(gen(i));
  else if (COLL === "inventory") for (let i = START; i < END; i++) for (const d of inventoryDocs(i)) push(d);
  else if (COLL === "metrics") { for (let h = START; h < END; h++) for (const d of metricDocsForHost(h, NOW - METRIC_DAYS * DAY, NOW)) push(d); }
  else if (COLL === "warehouses") for (const d of warehouseDocs()) push(d);
  else throw new Error("unknown COLL " + COLL);
  flush();
  print(`${COLL} [${START},${END}) inserted ${count} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
run();
