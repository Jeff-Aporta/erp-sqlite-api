// @vendor-pin 2026-10-17T16:10:00Z
/**
 * Contrato de cliente del admin SQLite (repo erp-sqlite/api).
 * El front lo vendoriza en src/vendor/erp-sqlite/front.ts con `deno task vendor:api` (max 90 dias).
 * No contiene UI ni logica de componentes: solo tipos + fetch.
 */

export type SqlValue = string | number | null | boolean;
export type FilterOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "like" | "not like" | "in" | "is null" | "is not null";

export interface Filter { column: string; op: FilterOp; value?: SqlValue | SqlValue[]; }
export interface OrderBy { column: string; dir?: "asc" | "desc"; }
export interface RowsQuery {
  table: string;
  filters?: Filter[];
  order?: OrderBy[];
  limit?: number;
  offset?: number;
}

export interface ObjectInfo { type: "table" | "view" | "index" | "trigger"; name: string; tableName: string; sql: string | null; }
export interface ObjectsResult { tables: ObjectInfo[]; views: ObjectInfo[]; indexes: ObjectInfo[]; triggers: ObjectInfo[]; }
export interface ColumnInfo { name: string; type: string; notNull: boolean; default: SqlValue; pk: boolean; }
export interface RowsResult { table: string; total: number; limit: number; offset: number; rows: Record<string, SqlValue>[]; }
export interface StatsResult {
  file: string; sizeBytes: number; encoding: string | null; journalMode: string | null;
  foreignKeys: number | null; pageCount: number | null; pageSize: number | null;
  tables: number; views: number;
}
export interface QueryResult { keyword: string; rowCount: number; rows: Record<string, SqlValue>[]; }
export interface IntegrityResult { ok: boolean; result: Record<string, SqlValue>[]; }
export interface VacuumResult { ok: boolean; before: number; after: number; }
export interface LoginResult { token: string; tipo: "Bearer"; expira: string; usuario: { iusuario: string; nombre: string }; }
export interface SessionInfo {
  jti: string; emitido: string; expira: string; ultimoAcceso: string | null;
  ip: string | null; userAgent: string | null; dispositivo: string | null;
  so: string | null; navegador: string | null; actual: boolean;
}

export interface ClientOptions {
  /** Base del API, p. ej. "https://host/api". */
  baseUrl: string;
  /** Token Bearer (DER identity). DER solo autentica por header: sin token, solo `login` responde. */
  token?: string;
  /** fetch inyectable para tests. */
  fetch?: typeof fetch;
}

function qs(q: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? "?" + s : "";
}

export function createClient(opts: ClientOptions) {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  let token = opts.token;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = "Bearer " + token;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await f(base + path, {
      method, headers, credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    // Un error de proxy (502 HTML de nginx, 404 estático) no es JSON: se reporta por su status.
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {
      if (res.ok) throw new ApiError(res.status, "respuesta_no_json");
    }
    if (!res.ok) throw new ApiError(res.status, data?.error ?? "http_" + res.status, data?.detail);
    return data as T;
  }

  const db = (name: string) => "/db-admin/" + encodeURIComponent(name);

  return {
    /** Cambia el token de las siguientes llamadas (null = anonimo). */
    setToken: (t: string | null) => { token = t ?? undefined; },

    // ---- auth (DER identity) ----
    login: (usuario: string, password: string) =>
      call<LoginResult>("POST", "/login", { usuario, password }),
    logout: () => call<void>("DELETE", "/logout"),
    /** Revoca todas las sesiones del usuario (incluida la actual). */
    logoutAll: () => call<{ revocadas: number }>("DELETE", "/logout/all"),
    /** Sesiones vigentes con auditoria de IP/dispositivo; `actual` marca la de este token. */
    sessions: () => call<SessionInfo[]>("GET", "/sessions"),
    /** Cambia la contrasena (exige la actual) y revoca las demas sesiones. */
    changePassword: (actual: string, nueva: string) =>
      call<{ revocadas: number }>("PUT", "/password", { actual, nueva }),

    // ---- catalogo ----
    databases: () => call<{ databases: string[] }>("GET", "/db-admin/databases"),

    // ---- objetos ----
    objects: (database: string) => call<ObjectsResult>("GET", db(database) + "/objects"),
    columns: (database: string, table: string) =>
      call<ColumnInfo[]>("GET", db(database) + "/columns/" + encodeURIComponent(table)),

    // ---- filas ----
    rows: (database: string, query: RowsQuery) =>
      call<RowsResult>("POST", db(database) + "/rows", query),

    // ---- mantenimiento ----
    stats: (database: string) => call<StatsResult>("GET", db(database) + "/stats"),
    query: (database: string, sql: string, allowWrite = false) =>
      call<QueryResult>("POST", db(database) + "/query", { sql, allowWrite }),
    vacuum: (database: string) => call<VacuumResult>("POST", db(database) + "/vacuum", { allowWrite: true }),
    integrity: (database: string) => call<IntegrityResult>("POST", db(database) + "/integrity"),
  };
}

export type Client = ReturnType<typeof createClient>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code + " (" + status + ")");
    this.name = "ApiError";
  }
}
