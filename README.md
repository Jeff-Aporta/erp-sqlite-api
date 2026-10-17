# erp-sqlite-api

API Deno del administrador SQLite: **login y usuarios con DER identity** (JWT HS384, bloqueo por
fuerza bruta, sesiones auditadas) + **db-admin** genérico sobre las bases centralizadas.

Es un submódulo del monorepo [`erp-sqlite`](https://github.com/Jeff-Aporta/erp-sqlite) (carpeta `api/`).
El front es [`erp-sqlite-front`](https://github.com/Jeff-Aporta/erp-sqlite-front) y consume el SDK
`dist/cdn/front.ts` por CDN. Instalación, nginx y sincronización con el VPS viven en el monorepo.

## Bases: siempre en `erp-sqlite/db`

| Qué | Ruta (default) |
|---|---|
| Bases administradas (`*.sqlite`) | `../db` → `erp-sqlite/db` (VPS: `/opt/erp-sqlite/db`) |
| Usuarios, sesiones, auditoría | `../db/_sistema/admin.sqlite` (db-admin no la ve: solo lista `*.sqlite` del primer nivel) |

`DB_DIR` y `DB` existen para pruebas; en uso normal no se cambian.

## Stack

| Pieza | Fuente |
|---|---|
| Deno 2.9.7 | fijada en `deploy/install.sh` del monorepo |
| DER (`@Jeff-Aporta/DER`) | **CDN** jsDelivr pineado por SHA en `deno.json`; integridad en `deno.lock` |
| SQLite | `node:sqlite` nativo de Deno (sin drivers) |
| zod, kysely | npm, versión exacta |

## Local (dentro del monorepo)

```bash
cp .env.example .env      # completar JWT_SECRET / ADMIN_PASSWORD
deno install
deno task seed            # opcional: ../db/demo.sqlite
deno task start           # http://127.0.0.1:8091/api
```

| Tarea | Qué hace |
|---|---|
| `deno task check` | tipos de `src/` y `scripts/` |
| `deno task test` | e2e de seguridad (login, 5 fallos → 429, bloqueo, 401) con los permisos del servicio |
| `deno task build:front` | publica el SDK en `dist/cdn/front.ts` |

Servicio `erp-sqlite-api` (`deploy/erp-sqlite-api.service`): usuario sin privilegios,
`ProtectSystem=strict`, escritura solo en `/opt/erp-sqlite/db`, escucha en `127.0.0.1`.

## Seguridad

- Sin defaults: sin `JWT_SECRET`/`ADMIN_*` el proceso no arranca.
- `JWT_SECRET` es también el pepper del hash: rotarlo invalida todas las contraseñas.
- DER toma la IP del **primer** salto de `X-Forwarded-For`: nginx debe **sobrescribirlo** con
  `$remote_addr` (lo hace el snippet del monorepo); si se anexa, se puede falsear la IP del bloqueo.
- La autenticación es solo por `Authorization: Bearer` (no cookie).

## API

`/api/login` · `/api/logout` · `/api/logout/all` · `/api/sessions` · `/api/password` · `/api/events`
(DER identity) · `/api/catalogos` (DER) · `/api/db-admin/*` (databases, objects, columns, rows,
stats, query, vacuum, integrity). Contrato tipado en `src/contract/front.ts`.
