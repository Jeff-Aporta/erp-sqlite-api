import { createRouter, sqliteDatabase, ServerController } from "@Jeff-Aporta/DER/src/02 controllers/server/sqlite/mod.ts";
import { pluginsFromConfig } from "@Jeff-Aporta/DER/src/03 plugins/mod.ts";
import { loadEnv } from "@Jeff-Aporta/dsh-dev-vps/env/mod.ts";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CatalogoEntity } from "./domain.ts";
import { dbAdminRoutes, setDbDir } from "./dbadmin.ts";

/** Config de env.json (norma única). Sin secrets.* válidos el server NO arranca. */
const { env } = await loadEnv();

type Emisor = { name: string; jwksUrl: string; issuer?: string };
const identity = (env.identity ?? {}) as { adminUser?: string; expiresIn?: number; trustedIssuers?: Emisor[] };
const dbCfg = env.db as { root: string; sistema?: string };
const JWT_SECRET = String(env.secrets?.jwtSecret ?? "");
const ADMIN_USER = identity.adminUser ?? "admin";
const ADMIN_PASSWORD = String(env.secrets?.adminPassword ?? "");
const DB_DIR = dbCfg.root;
const DB = join(DB_DIR, dbCfg.sistema ?? "_sistema/admin.sqlite");
const PORT = env.port;
const HOST = env.host;
const EXPOSE_ERRORS = env.exposeErrors === true;

if (JWT_SECRET.length < 32) { console.error("✗ env.json: secrets.jwtSecret debe tener ≥32 caracteres"); Deno.exit(1); }
if (ADMIN_PASSWORD.length < 8) { console.error("✗ env.json: secrets.adminPassword debe tener ≥8 caracteres"); Deno.exit(1); }

setDbDir(DB_DIR);
mkdirSync(dirname(DB), { recursive: true });
mkdirSync(DB_DIR, { recursive: true });
const db = sqliteDatabase(DB);

const ctrls = {
  catalogos: new ServerController(CatalogoEntity, {
    db, table: "catalogos",
    security: { protected: true, permissions: false },
  }),
};

const trustedIssuers = identity.trustedIssuers ?? [];
const plugins = pluginsFromConfig({
  identity: {
    secret: JWT_SECRET,
    expiresIn: identity.expiresIn ?? 28800,
    admin: { usuario: ADMIN_USER, password: ADMIN_PASSWORD },
    trustedIssuers,
  },
}, { db });

const router = createRouter(Object.values(ctrls), {
  basePath: "/api",
  plugins,
  exposeErrors: EXPOSE_ERRORS,
  routes: dbAdminRoutes,
});
await router.seed();

console.log(`erp-sqlite api en ${HOST}:${PORT}/api · DB_DIR ${DB_DIR}`);
Deno.serve({ port: PORT, hostname: HOST }, router.fetch);
