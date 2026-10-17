// tests/security.e2e.test.ts — arranca el server (env.json aislado) y prueba login + penalización reales
import { assertEquals } from "jsr:@std/assert@1";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dirname!);
const PORT = 8199;
const BASE = "http://127.0.0.1:" + PORT;
const USR = "jagudeloe";
const PASS = "udtccsso";

async function waitUp(server: Deno.ChildProcess, tries = 80) {
  let exited = false;
  server.status.then(() => (exited = true));
  for (let i = 0; i < tries; i++) {
    if (exited) throw new Error("el server terminó antes de responder (ver stderr)");
    try {
      const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      await r.body?.cancel();
      return;
    } catch { /* aún no */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server no arrancó");
}

async function login(password: string) {
  const r = await fetch(BASE + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: USR, password }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

Deno.test("e2e seguridad: login y penalización", async (t) => {
  const tmp = await Deno.makeTempDir();
  // env.json + secrets.json aislados: el server arranca solo con env.json (ley 9).
  await Deno.writeTextFile(join(tmp, "env.json"), JSON.stringify({
    app: "erp-sqlite-api",
    port: PORT,
    host: "127.0.0.1",
    db: { root: tmp, sistema: "admin.sqlite" },
    identity: { adminUser: USR, expiresIn: 3600 },
    secrets: { jwtSecret: "$secret:test.jwtSecret", adminPassword: "$secret:test.adminPassword" },
    exposeErrors: true,
  }));
  await Deno.writeTextFile(join(tmp, "secrets.json"), JSON.stringify({
    test: { jwtSecret: "test-secret-para-e2e-1234567890123456789012", adminPassword: PASS },
  }));

  const server = new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-check", "--allow-net", "--allow-env", "--allow-read", `--allow-write=${tmp}`, "src/main.ts"],
    cwd: ROOT,
    env: { ...Deno.env.toObject(), ENV_JSON: join(tmp, "env.json") },
    stdout: "null",
    stderr: "inherit",
  }).spawn();

  try {
    await waitUp(server);

    await t.step("login correcto devuelve token", async () => {
      const { status, body } = await login(PASS);
      assertEquals(status, 200);
      if (!body.token) throw new Error("sin token");
    });

    await t.step("5 fallos bloquean con 429", async () => {
      for (let i = 0; i < 5; i++) await login("mala");
      const { status } = await login("mala");
      assertEquals(status, 429);
    });

    await t.step("clave correcta estando bloqueado sigue en 429", async () => {
      const { status } = await login(PASS);
      assertEquals(status, 429);
    });

    await t.step("endpoint protegido sin token da 401", async () => {
      const r = await fetch(BASE + "/api/catalogos");
      await r.body?.cancel();
      assertEquals(r.status, 401);
    });
  } finally {
    try { server.kill("SIGKILL"); } catch { /* noop */ }
    await server.status;
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});
