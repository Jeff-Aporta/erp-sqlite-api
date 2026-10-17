import { createClient } from "../src/contract/front.ts";

const baseUrl = Deno.env.get("API_URL") ?? "http://127.0.0.1:8091/api";
const anon = createClient({ baseUrl });
const login = await anon.login(Deno.env.get("ADMIN_USER") ?? "admin", Deno.env.get("ADMIN_PASSWORD") ?? "");
console.log("login ok, token len", login.token.length);

const api = createClient({ baseUrl, token: login.token });
const dbs = await api.databases();
console.log("databases:", JSON.stringify(dbs));
const objs = await api.objects("demo.sqlite");
console.log("objects:", objs.tables.length, "tablas,", objs.views.length, "vistas,", objs.indexes.length, "indices,", objs.triggers.length, "triggers");
const cols = await api.columns("demo.sqlite", "clientes");
console.log("columns clientes:", cols.map((c) => c.name).join(", "));
const res = await api.rows("demo.sqlite", { table: "productos", order: [{ column: "precio", dir: "desc" }], limit: 2 });
console.log("rows:", res.total, "total |", res.rows.map((r) => r.nombre).join(" > "));
const st = await api.stats("demo.sqlite");
console.log("stats:", st.sizeBytes, "bytes, journal", st.journalMode, ", encoding", st.encoding);
const q = await api.query("demo.sqlite", "SELECT COUNT(*) AS n FROM clientes");
console.log("query:", JSON.stringify(q.rows));
const ic = await api.integrity("demo.sqlite");
console.log("integrity ok:", ic.ok);
try { await api.query("demo.sqlite", "DELETE FROM productos"); }
catch (e) { console.log("write bloqueado:", (e as Error).message); }

