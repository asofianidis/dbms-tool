#!/usr/bin/env node
// Generates the relational seed dataset.
//   node generate.mjs --dialect pg|mysql|mssql --out DIR [--scale 1] [--jobs 8]
//       writes headerless CSV chunks to DIR/<table>/<entity>-<start>.csv in that dialect's NULL/array format
//   node generate.mjs --dialect sqlite --db FILE [--scale 1]
//       creates FILE and inserts directly
//   node generate.mjs --dialect D --ddl tables|post
//       prints CREATE TABLE statements, or keys/indexes/foreign keys plus schema/D.extra.sql
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgArray, configure, genReference, plan } from "./data.mjs";
import { COLUMNS, postDdl, sqliteTablesDdl, tablesDdl } from "./schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, k, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[k + 1]]] : acc), []));
const dialect = args.dialect;
const scale = Number(args.scale || 1);
configure(scale);
if (!["pg", "mysql", "mssql", "sqlite"].includes(dialect)) throw new Error("--dialect must be pg, mysql, mssql or sqlite");

// ---------- CSV formatting ----------
// NULL is an unquoted empty field for Postgres/SQL Server and the unquoted word NULL for MySQL
// (LOAD DATA with ESCAPED BY ''); every string is quoted, so '' and 'NULL' strings survive.
const NULL_TOKEN = dialect === "mysql" ? "NULL" : "";
// SQL Server on Linux has no CODEPAGE option for BULK INSERT; UTF-16LE with a BOM is its Unicode input.
const ENCODING = dialect === "mssql" ? "utf16le" : "utf8";
const quote = (s) => '"' + s.replace(/"/g, '""') + '"';
const timestamp = (d) => d.toISOString().replace("T", " ").slice(0, 23);
function csvValue(v) {
  if (v === null || v === undefined) return NULL_TOKEN;
  switch (typeof v) {
    case "number": return Number.isFinite(v) ? String(v) : NULL_TOKEN;
    case "boolean": return v ? "1" : "0";
    case "string": return quote(v);
  }
  if (v instanceof Date) return timestamp(v);
  if (v instanceof PgArray) return quote(dialect === "pg" ? "{" + v.items.map((x) => '"' + x.replace(/["\\]/g, "\\$&") + '"').join(",") + "}" : JSON.stringify(v.items));
  return quote(JSON.stringify(v));
}
function sqliteValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Date) return timestamp(v);
  return JSON.stringify(v instanceof PgArray ? v.items : v);
}

class CsvSink {
  constructor(dir, name) { this.dir = dir; this.name = name; this.files = {}; }
  emit(table, row) {
    let f = this.files[table];
    if (!f) {
      fs.mkdirSync(path.join(this.dir, table), { recursive: true });
      f = this.files[table] = { fd: fs.openSync(path.join(this.dir, table, `${this.name}.csv`), "w"), buf: [], size: 0, rows: 0 };
      if (ENCODING === "utf16le") fs.writeSync(f.fd, Buffer.from([0xff, 0xfe]));
    }
    let line = "";
    for (const c of COLUMNS[table]) line += (line ? "," : "") + csvValue(row[c]);
    f.buf.push(line);
    f.size += line.length;
    f.rows++;
    if (f.size > 4_000_000) this.flush(f);
  }
  flush(f) { if (f.buf.length) { fs.writeSync(f.fd, Buffer.from(f.buf.join("\n") + "\n", ENCODING)); f.buf = []; f.size = 0; } }
  close() {
    for (const f of Object.values(this.files)) { this.flush(f); fs.closeSync(f.fd); }
    return Object.fromEntries(Object.entries(this.files).map(([t, f]) => [t, f.rows]));
  }
}

const allJobs = () => [["reference", 0, 1], ...plan().flatMap(([entity, , count, chunk]) => {
  const out = [];
  for (let s = 0; s < count; s += chunk) out.push([entity, s, Math.min(count, s + chunk)]);
  return out;
})];
function extraSql(d) {
  const file = path.join(HERE, "schema", `${d}.extra.sql`);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
function runJob(entity, start, end, emit) {
  if (entity === "reference") return genReference(emit);
  const gen = plan().find((p) => p[0] === entity)[1];
  for (let i = start; i < end; i++) gen(i, emit);
}

// ---------- modes ----------
if (args.ddl) {
  process.stdout.write(args.ddl === "tables" ? tablesDdl(dialect) : postDdl(dialect) + "\n" + extraSql(dialect));
} else if (args.job) {
  // worker: one chunk to CSV
  const [entity, start, end] = args.job.split(":");
  const sink = new CsvSink(args.out, `${entity}-${start}`);
  const t0 = Date.now();
  runJob(entity, Number(start), Number(end), (t, row) => sink.emit(t, row));
  const rows = sink.close();
  console.log(`${entity} [${start},${end}) ${Object.entries(rows).map(([t, n]) => `${t}=${n}`).join(" ")} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else if (dialect === "sqlite") {
  await generateSqlite();
} else {
  // coordinator: fan chunks out to worker processes
  if (!args.out) throw new Error("--out DIR is required");
  fs.rmSync(args.out, { recursive: true, force: true });
  fs.mkdirSync(args.out, { recursive: true });
  const queue = allJobs();
  const jobs = Number(args.jobs || 8);
  const t0 = Date.now();
  let failed = false;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (queue.length && !failed) {
      const [entity, start, end] = queue.shift();
      const code = await new Promise((resolve) => {
        const p = spawn(process.execPath, [fileURLToPath(import.meta.url), "--dialect", dialect, "--scale", String(scale), "--out", args.out, "--job", `${entity}:${start}:${end}`], { stdio: "inherit" });
        p.on("exit", resolve);
      });
      if (code !== 0) { failed = true; console.error(`job ${entity}:${start}:${end} failed (${code})`); }
    }
  }));
  if (failed) process.exit(1);
  console.log(`generated in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

async function generateSqlite() {
  const { DatabaseSync } = await import("node:sqlite");
  if (!args.db) throw new Error("--db FILE is required");
  for (const ext of ["", "-wal", "-shm", "-journal"]) fs.rmSync(args.db + ext, { force: true });
  const db = new DatabaseSync(args.db);
  db.exec("PRAGMA foreign_keys = OFF; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; PRAGMA cache_size = -512000; PRAGMA temp_store = MEMORY;");
  db.exec(sqliteTablesDdl());
  const stmts = {};
  const insert = (table) => stmts[table] ??= db.prepare(`INSERT INTO ${table} (${COLUMNS[table].join(", ")}) VALUES (${COLUMNS[table].map(() => "?").join(", ")})`);
  let pending = 0;
  const t0 = Date.now();
  db.exec("BEGIN");
  for (const [entity, start, end] of allJobs()) {
    runJob(entity, start, end, (table, row) => {
      insert(table).run(...COLUMNS[table].map((c) => sqliteValue(row[c])));
      if (++pending >= 100_000) { db.exec("COMMIT; BEGIN"); pending = 0; }
    });
    console.log(`${entity} [${start},${end}) ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  db.exec("COMMIT");
  console.log("building indexes...");
  db.exec(postDdl("sqlite") + extraSql("sqlite"));
  db.exec("ANALYZE;");
  const broken = db.prepare("PRAGMA foreign_key_check").all();
  if (broken.length) throw new Error(`foreign key violations: ${JSON.stringify(broken.slice(0, 5))} (${broken.length} total)`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.close();
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
