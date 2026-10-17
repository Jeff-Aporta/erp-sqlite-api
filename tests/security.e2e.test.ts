// tests/security.e2e.test.ts — arranca el server y prueba login + penalización reales
import { assertEquals } from "jsr:@std/assert@1";
import { dirname, join } from "node:path";

const ROOT = dirname(import.meta.dirname!);
const PORT = 8199;
const BASE = "http://127.0.0.1:" + PORT;

async function waitUp(server: Deno.ChildProcess, tries = 80) {
  let exited = false;
  server.status.then(() => (exited = true));
  for (let i = 0; i < tries; i++) {
    if (exited) throw new Error("el server terminó antes de responder (ver stderr)");
    try {
      const r = await fetch(BASE + "/api/permisos");
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
    body: JSON.stringify({ usuario: "jagudeloe", password }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Deno.test solo registra: el server debe vivir dentro del test, no a nivel de módulo.
Deno.test("e2e seguridad: login y penalización", async (t) => {
  const tmp = await Deno.makeTempDir();
  const server = new Deno.Command(Deno.execPath(), {
    // Mismos permisos que el servicio systemd (deploy/erp-sqlite-api.service): falla aquí si faltan.
    args: ["run", "--no-check", "--allow-net", "--allow-env", "--allow-read", `--allow-write=${tmp}`, "src/main.ts"],
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      PORT: String(PORT),
      JWT_SECRET: "test-secret-para-e2e-1234567890123456789012",
      ADMIN_USER: "jagudeloe",
      ADMIN_PASSWORD: "udtccsso",
      DB: join(tmp, "admin.sqlite"),
      DB_DIR: join(tmp, "db"),
    },
    stdout: "null",
    stderr: "inherit", // errores del server visibles en la salida del test
  }).spawn();

  try {
    await waitUp(server);

    await t.step("login correcto devuelve token", async () => {
      const { status, body } = await login("udtccsso");
      assertEquals(status, 200);
      if (!body.token) throw new Error("sin token");
    });

    await t.step("5 fallos bloquean con 429", async () => {
      for (let i = 0; i < 5; i++) await login("mala");
      const { status } = await login("mala");
      assertEquals(status, 429);
    });

    await t.step("clave correcta estando bloqueado sigue en 429", async () => {
      const { status } = await login("udtccsso");
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
