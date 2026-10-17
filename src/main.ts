import { createRouter, sqliteDatabase, ServerController } from "@Jeff-Aporta/DER/src/02 controllers/server/sqlite/mod.ts";
import { pluginsFromConfig } from "@Jeff-Aporta/DER/src/03 plugins/mod.ts";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CatalogoEntity } from "./domain.ts";
import { DB_DIR, dbAdminRoutes } from "./dbadmin.ts";

/** Config obligatoria: sin defaults inseguros, ningún VPS arranca con credenciales de ejemplo. */
function required(name: string, minLength = 1): string {
  const v = Deno.env.get(name) ?? "";
  if (v.length < minLength) {
    console.error(`✗ falta ${name}${minLength > 1 ? ` (mínimo ${minLength} caracteres)` : ""}; ver .env.example`);
    Deno.exit(1);
  }
  return v;
}

const JWT_SECRET = required("JWT_SECRET", 32);
const ADMIN_USER = required("ADMIN_USER");
const ADMIN_PASSWORD = required("ADMIN_PASSWORD", 8);
const DB = Deno.env.get("DB") ?? join(import.meta.dirname!, "..", "data", "admin.sqlite");
const PORT = Number(Deno.env.get("PORT") ?? 8091);
const HOST = Deno.env.get("HOST") ?? "127.0.0.1";

mkdirSync(dirname(DB), { recursive: true });
mkdirSync(DB_DIR, { recursive: true });
const db = sqliteDatabase(DB);

const ctrls = {
  catalogos: new ServerController(CatalogoEntity, {
    db, table: "catalogos",
    security: { protected: true, permissions: false },
  }),
};

const plugins = pluginsFromConfig({
  identity: {
    secret: JWT_SECRET,
    expiresIn: 28800,
    admin: { usuario: ADMIN_USER, password: ADMIN_PASSWORD },
  },
}, { db });

const router = createRouter(Object.values(ctrls), {
  basePath: "/api",
  plugins,
  exposeErrors: Deno.env.get("EXPOSE_ERRORS") === "1",
  routes: dbAdminRoutes,
});
await router.seed();

console.log(`erp-sqlite api en ${HOST}:${PORT}/api · DB_DIR ${DB_DIR}`);
Deno.serve({ port: PORT, hostname: HOST }, router.fetch);
