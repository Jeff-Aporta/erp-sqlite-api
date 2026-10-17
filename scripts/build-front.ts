/** Copia el contrato tipado a dist/cdn/front.ts (artefacto para vendor del front). */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src", "contract", "front.ts");
const outDir = join(here, "..", "dist", "cdn");
const out = join(outDir, "front.ts");
await mkdir(outDir, { recursive: true });
await copyFile(src, out);
const bytes = (await Deno.readFile(out)).length;
console.log("front.ts ->", out, "(" + bytes + " bytes)");
