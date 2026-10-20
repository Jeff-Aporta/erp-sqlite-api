import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dbDir = Deno.env.get("DB_DIR") ?? join(here, "..", "data");
mkdirSync(dbDir, { recursive: true });
const file = join(dbDir, "demo.sqlite");
if (existsSync(file)) { console.log("ya existe:", file); Deno.exit(0); }

const db = new DatabaseSync(file);
db.exec(`
CREATE TABLE clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  nit TEXT,
  email TEXT,
  creado_en TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  precio REAL NOT NULL,
  stock INTEGER DEFAULT 0
);
CREATE VIEW v_clientes_activos AS SELECT id, nombre FROM clientes;
CREATE INDEX idx_clientes_nit ON clientes(nit);
`);
db.prepare("INSERT INTO clientes (nombre, nit, email) VALUES (?,?,?)").run("Empresa Demo S.A.", "900123456-1", "demo@empresa.com");
db.prepare("INSERT INTO clientes (nombre, nit, email) VALUES (?,?,?)").run("Comercial Prueba", "800987654-2", "prueba@comercial.com");
db.prepare("INSERT INTO productos (nombre, precio, stock) VALUES (?,?,?)").run("Producto A", 15000, 10);
db.prepare("INSERT INTO productos (nombre, precio, stock) VALUES (?,?,?)").run("Producto B", 25000, 5);
db.close();
console.log("creado:", file);

