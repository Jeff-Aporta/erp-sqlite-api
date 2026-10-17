/**
 * db-admin: consola generica sobre archivos .sqlite.
 * - Solo lectura por defecto (DatabaseSync readOnly + PRAGMA query_only).
 * - Escritura solo con `allowWrite: true` explicito en el body.
 * - Identificadores siempre escapados; valores siempre parametrizados (?).
 * - Seguridad: JWT de DER identity en todas las rutas (permissions: false).
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import type { ExtraRoute } from "@Jeff-Aporta/DER/src/02 controllers/server/schemas.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** Bases centralizadas en `erp-sqlite/db` (raíz del monorepo; en el VPS, /opt/erp-sqlite/db). */
export let DB_DIR = Deno.env.get("DB_DIR") ?? join(here, "..", "..", "..", "db");

/** La API fija la ruta real de db.root (env.json) antes de servir. */
export function setDbDir(path: string) { DB_DIR = path; }

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.sqlite$/;
const OPS: Record<string, string> = {
  "=": "=", "!=": "!=", "<": "<", "<=": "<=", ">": ">", ">=": ">=",
  like: "LIKE", "not like": "NOT LIKE", in: "IN",
};

/** Escapa un identificador SQL (tabla/columna). */
const q = (id: string) => '"' + id.replaceAll('"', '""') + '"';

function err(status: number, code: string, detail?: unknown): Response {
  return new Response(JSON.stringify({ error: code, detail }), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function resolveDb(raw: string): string {
  const name = basename(decodeURIComponent(raw));
  if (!NAME_RE.test(name)) throw new HttpErr(400, "bad_db_name", name);
  const full = join(DB_DIR, name);
  try { statSync(full); } catch { throw new HttpErr(404, "db_not_found", name); }
  return full;
}

class HttpErr extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) { super(code); }
}

function openDb(path: string, readOnly: boolean): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly });
  } catch {
    db = new DatabaseSync(path);
  }
  if (readOnly) { try { db.exec("PRAGMA query_only = ON"); } catch { /* noop */ } }
  return db;
}

function objects(path: string) {
  const db = openDb(path, true);
  try {
    const rows = db.prepare(
      "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master WHERE type IN ('table','view','index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all();
    const out: Record<string, unknown[]> = { tables: [], views: [], indexes: [], triggers: [] };
    for (const r of rows) {
      const key = r.type === "table" ? "tables" : r.type === "view" ? "views" : r.type === "index" ? "indexes" : "triggers";
      out[key].push(r);
    }
    return out;
  } finally { db.close(); }
}

function columns(path: string, table: string) {
  const db = openDb(path, true);
  try {
    const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = ? AND type IN ('table','view')").get(table);
    if (!exists) throw new HttpErr(404, "table_not_found", table);
    return db.prepare(`PRAGMA table_info(${q(table)})`).all().map((c: any) => ({
      name: c.name, type: c.type, notNull: !!c.notnull, default: c.dflt_value, pk: !!c.pk,
    }));
  } finally { db.close(); }
}

function assertColumn(path: string, table: string, column: string) {
  const cols = columns(path, table).map((c: any) => c.name);
  if (!cols.includes(column)) throw new HttpErr(400, "bad_column", { table, column });
}

function buildRows(path: string, body: any) {
  const table = String(body?.table ?? "");
  if (!table) throw new HttpErr(400, "missing_table");
  const db = openDb(path, true);
  try {
    const real = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = ? AND type IN ('table','view')").get(table);
    if (!real) throw new HttpErr(404, "table_not_found", table);

    const where: string[] = [];
    const params: SQLInputValue[] = [];
    for (const f of body?.filters ?? []) {
      const col = String(f?.column ?? "");
      const op = String(f?.op ?? "=").toLowerCase();
      assertColumn(path, table, col);
      if (op === "is null") { where.push(`${q(col)} IS NULL`); continue; }
      if (op === "is not null") { where.push(`${q(col)} IS NOT NULL`); continue; }
      if (op === "in") {
        const list = Array.isArray(f?.value) ? f.value : [];
        if (!list.length) throw new HttpErr(400, "empty_in");
        where.push(`${q(col)} IN (${list.map(() => "?").join(",")})`);
        params.push(...list);
        continue;
      }
      const sqlOp = OPS[op];
      if (!sqlOp) throw new HttpErr(400, "bad_op", op);
      where.push(`${q(col)} ${sqlOp} ?`);
      params.push(f?.value ?? null);
    }

    const order: string[] = [];
    for (const o of body?.order ?? []) {
      const col = String(o?.column ?? "");
      assertColumn(path, table, col);
      const dir = String(o?.dir ?? "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
      order.push(`${q(col)} ${dir}`);
    }

    const limit = Math.min(Math.max(Number(body?.limit ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(body?.offset ?? 0) || 0, 0);
    const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const orderSql = order.length ? ` ORDER BY ${order.join(", ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS c FROM ${q(table)}${whereSql}`).get(...params)?.c ?? 0;
    const rows = db.prepare(`SELECT * FROM ${q(table)}${whereSql}${orderSql} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { table, total, limit, offset, rows };
  } finally { db.close(); }
}

function stats(path: string) {
  const db = openDb(path, true);
  try {
    const one = (sql: string) => { try { return db.prepare(sql).get(); } catch { return null; } };
    return {
      file: basename(path),
      sizeBytes: statSync(path).size,
      encoding: one("PRAGMA encoding")?.encoding ?? null,
      journalMode: one("PRAGMA journal_mode")?.journal_mode ?? null,
      foreignKeys: one("PRAGMA foreign_keys")?.foreign_keys ?? null,
      pageCount: one("PRAGMA page_count")?.page_count ?? null,
      pageSize: one("PRAGMA page_size")?.page_size ?? null,
      tables: db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()?.c ?? 0,
      views: db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'view'").get()?.c ?? 0,
    };
  } finally { db.close(); }
}

/** Quita comentarios iniciales y valida que sea UNA sola sentencia. */
function normalizeSql(input: string): { sql: string; keyword: string } {
  let sql = input.trim();
  for (;;) {
    if (sql.startsWith("--")) { const i = sql.indexOf("\n"); sql = i === -1 ? "" : sql.slice(i + 1).trim(); continue; }
    if (sql.startsWith("/*")) { const i = sql.indexOf("*/"); sql = i === -1 ? "" : sql.slice(i + 2).trim(); continue; }
    break;
  }
  if (!sql) throw new HttpErr(400, "empty_sql");
  let inS = false, inD = false, depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (!inS && !inD) {
      if (ch === ";") { if (sql.slice(i + 1).trim()) throw new HttpErr(400, "multiple_statements"); }
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
  }
  const clean = sql.replace(/;\s*$/, "");
  const m = /^([A-Za-z]+)/.exec(clean);
  return { sql: clean, keyword: (m?.[1] ?? "").toUpperCase() };
}

const READONLY_KW = new Set(["SELECT", "PRAGMA", "EXPLAIN", "WITH"]);

function runQuery(path: string, body: any) {
  const { sql, keyword } = normalizeSql(String(body?.sql ?? ""));
  const allowWrite = body?.allowWrite === true;
  if (!allowWrite && !READONLY_KW.has(keyword)) {
    throw new HttpErr(403, "write_not_allowed", { keyword, hint: "envia allowWrite: true" });
  }
  const db = openDb(path, !allowWrite);
  try {
    const stmt = db.prepare(sql);
    if (READONLY_KW.has(keyword)) {
      const rows = stmt.all();
      return { keyword, rowCount: rows.length, rows };
    }
    const r = stmt.run();
    return { keyword, changes: Number(r.changes ?? 0), lastInsertRowid: String(r.lastInsertRowid ?? "") };
  } finally { db.close(); }
}

function vacuum(path: string, body: any) {
  if (body?.allowWrite !== true) throw new HttpErr(403, "write_not_allowed");
  const before = statSync(path).size;
  const db = openDb(path, false);
  try { db.exec("VACUUM"); } finally { db.close(); }
  return { ok: true, before, after: statSync(path).size };
}

function integrity(path: string) {
  const db = openDb(path, true);
  try {
    const rows = db.prepare("PRAGMA integrity_check").all();
    return { ok: rows.length === 1 && Object.values(rows[0])[0] === "ok", result: rows };
  } finally { db.close(); }
}

function listDatabases() {
  const out: string[] = [];
  try {
    for (const e of Deno.readDirSync(DB_DIR)) if (e.isFile && e.name.endsWith(".sqlite")) out.push(e.name);
  } catch { /* dir vacio */ }
  return out.sort();
}


/** Crea una base .sqlite vacía. */
function createDatabase(body: any) {
  const name = String(body?.name ?? "").trim();
  if (!NAME_RE.test(name)) throw new HttpErr(400, "bad_db_name", name);
  const full = join(DB_DIR, name);
  if (existsSync(full)) throw new HttpErr(409, "db_exists", name);
  const db = new DatabaseSync(full);
  try { db.exec("PRAGMA journal_mode=WAL"); } finally { db.close(); }
  return { ok: true, name };
}

/** Borra una base (exige confirm: true). */
function dropDatabase(raw: string, body: any) {
  if (body?.confirm !== true) throw new HttpErr(400, "confirm_required", "envia confirm: true");
  const path = resolveDb(raw);
  for (const ext of ["", "-wal", "-shm"]) { try { rmSync(path + ext, { force: true }); } catch { /* noop */ } }
  return { ok: true };
}

/** Duplica una base (copia consistente tras checkpoint). */
function duplicateDatabase(raw: string, body: any) {
  const path = resolveDb(raw);
  const newName = String(body?.newName ?? "").trim();
  if (!NAME_RE.test(newName)) throw new HttpErr(400, "bad_db_name", newName);
  const dst = join(DB_DIR, newName);
  if (existsSync(dst)) throw new HttpErr(409, "db_exists", newName);
  const db = openDb(path, false);
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
  copyFileSync(path, dst);
  return { ok: true, name: newName };
}

/** Vacía una tabla (DELETE FROM; exige allowWrite). */
function truncateTable(path: string, table: string, body: any) {
  if (body?.allowWrite !== true) throw new HttpErr(403, "write_not_allowed");
  const db = openDb(path, false);
  try {
    const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = ? AND type = 'table'").get(table);
    if (!exists) throw new HttpErr(404, "table_not_found", table);
    db.exec("DELETE FROM " + q(table));
    return { ok: true, table };
  } finally { db.close(); }
}

/** Exporta una tabla/vista a JSON o CSV (solo lectura). */
function exportTable(path: string, table: string, fmt: string): string {
  const db = openDb(path, true);
  try {
    const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = ? AND type IN ('table','view')").get(table);
    if (!exists) throw new HttpErr(404, "table_not_found", table);
    const rows = db.prepare("SELECT * FROM " + q(table)).all() as Record<string, unknown>[];
    if (fmt === "csv") {
      const cols = rows.length ? Object.keys(rows[0]!) : [];
      const esc = (v: unknown) => v == null ? "" : '"' + String(v).replace(/"/g, '""') + '"';
      return cols.join(",") + "\n" + rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n");
    }
    return JSON.stringify(rows, null, 2);
  } finally { db.close(); }
}

/** Inserta filas (JSON) en una tabla existente, en una transacción. */
function importTable(path: string, table: string, body: any) {
  if (body?.allowWrite !== true) throw new HttpErr(403, "write_not_allowed");
  const rows = Array.isArray(body?.rows) ? body.rows as Record<string, unknown>[] : [];
  if (!rows.length) throw new HttpErr(400, "no_rows");
  const db = openDb(path, false);
  try {
    const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE name = ? AND type = 'table'").get(table);
    if (!exists) throw new HttpErr(404, "table_not_found", table);
    const cols = Object.keys(rows[0]!);
    if (!cols.length) throw new HttpErr(400, "no_columns");
    const stmt = db.prepare("INSERT INTO " + q(table) + " (" + cols.map(q).join(",") + ") VALUES (" + cols.map(() => "?").join(",") + ")");
    let inserted = 0;
    db.exec("BEGIN");
    try {
      for (const r of rows) { stmt.run(...cols.map((c) => (r[c] ?? null) as SQLInputValue)); inserted++; }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    return { ok: true, inserted };
  } finally { db.close(); }
}

/** Envuelve un handler: mapea HttpErr a Response con status. */
const h = (fn: (i: any) => unknown) => (input: any) => {
  try { return fn(input); } catch (e) {
    if (e instanceof HttpErr) return err(e.status, e.code, e.detail);
    return err(500, "internal", String(e));
  }
};

const SEC = { protected: true, permissions: false } as const;

export const dbAdminRoutes: ExtraRoute[] = [
  { method: "GET", path: "db-admin/databases", security: SEC, handler: h(() => ({ databases: listDatabases() })) },
  { method: "POST", path: "db-admin/databases", security: SEC, handler: h(({ body }) => createDatabase(body)) },
  { method: "DELETE", path: "db-admin/{db}", security: SEC, handler: h(({ params, body }) => dropDatabase(params.db, body)) },
  { method: "POST", path: "db-admin/{db}/duplicate", security: SEC, handler: h(({ params, body }) => duplicateDatabase(params.db, body)) },
  { method: "POST", path: "db-admin/{db}/truncate/{table}", security: SEC, handler: h(({ params, body }) => truncateTable(resolveDb(params.db), params.table, body)) },
  { method: "GET", path: "db-admin/{db}/export/{table}", security: SEC, handler: h(({ params, query }) => exportTable(resolveDb(params.db), params.table, String(query?.get?.("format") ?? "json").toLowerCase())) },
  { method: "POST", path: "db-admin/{db}/import/{table}", security: SEC, handler: h(({ params, body }) => importTable(resolveDb(params.db), params.table, body)) },
  { method: "GET", path: "db-admin/{db}/objects", security: SEC, handler: h(({ params }) => objects(resolveDb(params.db))) },
  { method: "GET", path: "db-admin/{db}/columns/{table}", security: SEC, handler: h(({ params }) => columns(resolveDb(params.db), params.table)) },
  { method: "POST", path: "db-admin/{db}/rows", security: SEC, handler: h(({ params, body }) => buildRows(resolveDb(params.db), body)) },
  { method: "GET", path: "db-admin/{db}/stats", security: SEC, handler: h(({ params }) => stats(resolveDb(params.db))) },
  { method: "POST", path: "db-admin/{db}/query", security: SEC, handler: h(({ params, body }) => runQuery(resolveDb(params.db), body)) },
  { method: "POST", path: "db-admin/{db}/vacuum", security: SEC, handler: h(({ params, body }) => vacuum(resolveDb(params.db), body)) },
  { method: "POST", path: "db-admin/{db}/integrity", security: SEC, handler: h(({ params }) => integrity(resolveDb(params.db))) },
];
