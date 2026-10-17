/**
 * Sincronización con el VPS por ssh/scp (OpenSSH, autenticación por llave).
 *
 *   deno task sync:vps          gate (check + test) → push del código a $VPS_DIR/api (+ restart y rollback)
 *   deno task sync:db:pull      pull de db/*.sqlite (remoto gana: es la fuente viva)
 *   deno task sync:db:push      push de db/*.sqlite (exige --yes)
 *
 * Flags: --dry-run (solo muestra el plan), --yes (confirma db:push).
 * Env:   VPS_HOST (root@166.1.85.205), VPS_DIR (/opt/erp-sqlite), VPS_SSH_KEY (opcional).
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, "..");
const DB_DIR = Deno.env.get("DB_DIR") ?? join(SERVER, "data", "db");
const HOST = Deno.env.get("VPS_HOST") ?? "root@166.1.85.205";
const RDIR = Deno.env.get("VPS_DIR") ?? "/opt/erp-sqlite";
const KEY = Deno.env.get("VPS_SSH_KEY");
const SERVICE = "erp-sqlite-api";
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ...(KEY ? ["-i", KEY] : [])];
// Lo que no viaja con el código: dependencias se reinstalan, tests y datos locales no aplican.
const CODE_EXCLUDES = [".git", "node_modules", "tests", "data", "*.sqlite*", ".env", "*.ps1"];

const [mode, ...flags] = Deno.args;
const DRY = flags.includes("--dry-run");
const YES = flags.includes("--yes");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

type Manifest = Record<string, { sha256: string; mtime: number; size: number }>;

async function run(cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean } = {}) {
  const r = await new Deno.Command(cmd, {
    args, cwd: opts.cwd, stdout: "piped", stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(r.stdout);
  const err = new TextDecoder().decode(r.stderr);
  if (!r.success) throw new Error(`${cmd} ${args.join(" ")}\n${err || out}`);
  if (!opts.quiet && err.trim()) console.error(err.trim());
  return out;
}

/** Comillas simples POSIX para incrustar valores en el comando remoto. */
const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const ssh = (script: string) => run("ssh", [...SSH_OPTS, HOST, script]);
const scp = (from: string, to: string) => run("scp", [...SSH_OPTS, "-q", from, to]);

async function ensureRemote() {
  try {
    await ssh("true");
  } catch (e) {
    throw new Error(`el VPS no responde (${HOST}); no se tocó nada.\n${(e as Error).message}`);
  }
}

async function sha256(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Vuelca el WAL al archivo principal para que copiar solo el .sqlite sea consistente. */
function checkpoint(path: string) {
  const db = new DatabaseSync(path);
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { db.close(); }
}

async function localManifest(): Promise<Manifest> {
  const m: Manifest = {};
  for (const name of await readdir(DB_DIR).catch(() => [] as string[])) {
    if (!name.endsWith(".sqlite")) continue; // excluye -wal / -shm
    const p = join(DB_DIR, name);
    const s = await stat(p);
    m[name] = { sha256: await sha256(p), mtime: Math.floor(s.mtimeMs / 1000), size: s.size };
  }
  return m;
}

/**
 * Manifest remoto. Con sqlite3 disponible, cada base se vuelca primero a un snapshot
 * consistente (.backup) en $RDIR/.sync/ y el hash es el del snapshot; sin sqlite3 se
 * usa el archivo crudo y se rechaza si tiene WAL pendiente.
 */
async function remoteManifest(): Promise<{ manifest: Manifest; snapshots: boolean }> {
  const out = await ssh(`set -e
D=${sh(RDIR + "/db")}; S=${sh(RDIR + "/.sync")}
rm -rf "$S"; mkdir -p "$S"
command -v sqlite3 >/dev/null && echo SNAP=1 || echo SNAP=0
for f in "$D"/*.sqlite; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  if command -v sqlite3 >/dev/null; then
    sqlite3 "$f" ".backup '$S/$n'"; src="$S/$n"
  else
    [ -s "$f-wal" ] && { echo "WAL=$n"; continue; }
    src="$f"
  fi
  echo "F=$n $(sha256sum "$src" | cut -d' ' -f1) $(stat -c '%Y %s' "$f")"
done`);
  const manifest: Manifest = {};
  let snapshots = false;
  for (const line of out.split("\n")) {
    if (line === "SNAP=1") snapshots = true;
    else if (line.startsWith("WAL=")) {
      throw new Error(`${line.slice(4)} tiene WAL pendiente y el VPS no tiene sqlite3 para un snapshot consistente`);
    } else if (line.startsWith("F=")) {
      const [name, hash, mtime, size] = line.slice(2).split(" ");
      manifest[name] = { sha256: hash, mtime: Number(mtime), size: Number(size) };
    }
  }
  return { manifest, snapshots };
}

async function gate() {
  for (const task of ["check", "test"]) {
    console.log(`gate: deno task ${task}`);
    const r = await new Deno.Command(Deno.execPath(), { args: ["task", task], cwd: SERVER }).output();
    if (!r.success) throw new Error(`gate rojo en "${task}": no se sube nada`);
  }
}

async function pushCode() {
  await gate();
  await ensureRemote();
  const tgz = join(await Deno.makeTempDir(), "api.tgz");
  await run("tar", [...CODE_EXCLUDES.flatMap((x) => ["--exclude", x]), "-czf", tgz, "-C", SERVER, "."]);
  console.log(`código empaquetado (${(await stat(tgz)).size} bytes) → ${HOST}:${RDIR}/api`);
  if (DRY) return console.log("--dry-run: no se sube");

  const b = `${RDIR}/.backup/${stamp()}`;
  await scp(tgz, `${HOST}:${RDIR}/.api.tgz`);
  // Extrae a api.new y solo entonces intercambia; si el servicio no levanta, vuelve a la versión previa.
  // Config y datos viven fuera del código (/etc/erp-sqlite/api.env, $RDIR/state, $RDIR/db).
  await ssh(`set -e
cd ${sh(RDIR)}
rm -rf api.new && mkdir api.new
tar -xzf .api.tgz -C api.new && rm .api.tgz
(cd api.new && DENO_DIR=${sh(RDIR + "/.deno")} deno install --quiet && DENO_DIR=${sh(RDIR + "/.deno")} deno cache --quiet src/main.ts)
chown -R erp-sqlite:erp-sqlite ${sh(RDIR + "/.deno")} 2>/dev/null || true
had=0; [ -d api ] && { mkdir -p ${sh(b)}; mv api ${sh(b + "/api")}; had=1; }
mv api.new api
systemctl list-unit-files ${SERVICE}.service >/dev/null 2>&1 || { echo "sin servicio ${SERVICE}: código copiado, no reiniciado"; exit 0; }
systemctl restart ${SERVICE}
PORT=$(sed -n "s/^PORT=//p" /etc/erp-sqlite/api.env)
for i in $(seq 1 20); do
  curl -s -o /dev/null "http://127.0.0.1:\${PORT:-8091}/api/permisos" && { echo "ok: ${SERVICE} responde; backup ${b}/api"; exit 0; }
  sleep 1
done
echo "✗ ${SERVICE} no responde: rollback"
if [ $had = 1 ]; then rm -rf api && mv ${sh(b + "/api")} api && systemctl restart ${SERVICE}; fi
exit 1`).then(console.log);
  await rm(dirname(tgz), { recursive: true, force: true });
}

async function pullDb() {
  await ensureRemote();
  const { manifest: remote, snapshots } = await remoteManifest();
  const local = await localManifest();
  const changed = Object.keys(remote).filter((n) => local[n]?.sha256 !== remote[n].sha256);
  const onlyLocal = Object.keys(local).filter((n) => !remote[n]);
  console.log(`remoto: ${Object.keys(remote).length} bases, ${changed.length} distintas`);
  for (const n of changed) console.log(`  ↓ ${n} (${local[n] ? "cambia" : "nueva"})`);
  for (const n of onlyLocal) console.log(`  · ${n} solo existe en local (se conserva)`);
  if (DRY || !changed.length) return DRY && console.log("--dry-run: no se descarga");

  const backup = join(DB_DIR, ".backup", stamp());
  const incoming = join(DB_DIR, ".incoming");
  await mkdir(incoming, { recursive: true });
  try {
    // Descarga y verifica todo antes de pisar nada.
    for (const n of changed) {
      const from = `${RDIR}/${snapshots ? ".sync" : "db"}/${n}`;
      await scp(`${HOST}:${from}`, join(incoming, n));
      const got = await sha256(join(incoming, n));
      if (got !== remote[n].sha256) throw new Error(`${n}: sha256 no coincide tras descargar`);
    }
    for (const n of changed) {
      const dst = join(DB_DIR, n);
      if (local[n]) {
        await mkdir(backup, { recursive: true });
        await copyFile(dst, join(backup, n));
      }
      for (const ext of ["-wal", "-shm"]) await rm(dst + ext, { force: true });
      await rename(join(incoming, n), dst);
      const mtime = new Date(remote[n].mtime * 1000);
      await Deno.utime(dst, mtime, mtime);
    }
    if (changed.some((n) => local[n])) console.log(`backup local: ${backup}`);
  } finally {
    await rm(incoming, { recursive: true, force: true });
    await ssh(`rm -rf ${sh(RDIR + "/.sync")}`).catch(() => {});
  }
}

async function pushDb() {
  const names = Object.keys(await localManifest());
  for (const n of names) checkpoint(join(DB_DIR, n));
  const local = await localManifest(); // re-hash tras el checkpoint
  await ensureRemote();
  const { manifest: remote } = await remoteManifest();
  const changed = names.filter((n) => remote[n]?.sha256 !== local[n].sha256);
  console.log(`local: ${names.length} bases, ${changed.length} distintas del VPS`);
  for (const n of changed) {
    const newer = remote[n] && remote[n].mtime > local[n].mtime ? "  ⚠ el remoto es MÁS RECIENTE" : "";
    console.log(`  ↑ ${n} (${remote[n] ? "pisa" : "nueva"})${newer}`);
  }
  await ssh(`rm -rf ${sh(RDIR + "/.sync")}`).catch(() => {});
  if (DRY || !changed.length) return DRY && console.log("--dry-run: no se sube");
  if (!YES) throw new Error("db:push pisa la fuente viva: repite con --yes para confirmar");

  const b = `${RDIR}/db/.backup/${stamp()}`;
  for (const n of changed) {
    const tmp = `${RDIR}/db/.${n}.incoming`;
    await scp(join(DB_DIR, n), `${HOST}:${tmp}`);
    // Verifica el hash en destino, respalda la versión viva y reemplaza con mv (atómico).
    await ssh(`set -e
[ "$(sha256sum ${sh(tmp)} | cut -d' ' -f1)" = ${sh(local[n].sha256)} ] || { rm -f ${sh(tmp)}; echo "sha256 no coincide"; exit 1; }
f=${sh(`${RDIR}/db/${n}`)}
if [ -f "$f" ]; then mkdir -p ${sh(b)}; cp -p "$f" ${sh(`${b}/${n}`)}; fi
rm -f "$f-wal" "$f-shm"
mv ${sh(tmp)} "$f"`);
  }
  console.log(`subidas ${changed.length}; backup remoto: ${b}`);
}

const modes: Record<string, () => Promise<unknown>> = { code: pushCode, "db:pull": pullDb, "db:push": pushDb };
if (!modes[mode]) {
  console.error("uso: sync-vps.ts <code|db:pull|db:push> [--dry-run] [--yes]");
  Deno.exit(2);
}
try {
  await modes[mode]();
} catch (e) {
  console.error("✗", (e as Error).message);
  Deno.exit(1);
}
