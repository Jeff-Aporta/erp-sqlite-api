# erp-sqlite · api

API Deno del administrador SQLite: **login y usuarios con DER identity** (JWT HS384, bloqueo por
fuerza bruta, sesiones auditadas) + **db-admin** genérico sobre una carpeta de `*.sqlite`.
Mismo sistema en todos los VPS: se clona, se corre `deploy/install.sh` y queda igual.

El front vive en el repo hermano [`front`](../front) y consume el SDK `dist/cdn/front.ts`.

## Stack

| Pieza | Fuente |
|---|---|
| Deno 2.9.7 | fijada en `deploy/install.sh` |
| DER (`@Jeff-Aporta/DER`) | **CDN** jsDelivr pineado por SHA en `deno.json`; integridad en `deno.lock` |
| SQLite | `node:sqlite` nativo de Deno (sin drivers) |
| zod, kysely | npm, versión exacta |

Sin vendor ni rutas locales: el import map resuelve igual en Windows y en Linux.

## Local

```bash
cp .env.example .env      # y completar JWT_SECRET / ADMIN_PASSWORD
deno install
deno task seed            # opcional: data/db/demo.sqlite
deno task start           # http://127.0.0.1:8091/api
```

| Tarea | Qué hace |
|---|---|
| `deno task check` | tipos de `src/` y `scripts/` |
| `deno task test` | e2e de seguridad (login, 5 fallos → 429, bloqueo, 401) con los permisos del servicio |
| `deno task build:front` | publica el SDK en `dist/cdn/front.ts` (el front lo vendoriza) |
| `deno task sync:vps` | gate (check + test) → sube el código, reinicia y hace rollback si no levanta |
| `deno task sync:db:pull` | baja `*.sqlite` del VPS (remoto gana; backup local antes de pisar) |
| `deno task sync:db:push -- --yes` | sube `*.sqlite` (explícito; backup remoto antes de pisar) |

`sync:*` usan `ssh`/`scp` con llave (`VPS_HOST`, `VPS_DIR`, `VPS_SSH_KEY`); `--dry-run` muestra el plan.

## VPS nuevo

```bash
git clone <este repo> /opt/erp-sqlite/api
ADMIN_PASSWORD='…' sh /opt/erp-sqlite/api/deploy/install.sh
# una vez: `include snippets/erp-sqlite.conf;` en el server TLS de nginx → nginx -t && systemctl reload nginx
```

| Ruta en el VPS | Contenido |
|---|---|
| `/opt/erp-sqlite/api` | este repo (código) |
| `/opt/erp-sqlite/front` | repo `front` (estático, lo sirve nginx) |
| `/opt/erp-sqlite/db` | bases administradas (`DB_DIR`) |
| `/opt/erp-sqlite/state` | `admin.sqlite`: usuarios, sesiones, intentos, auditoría (`DB`) |
| `/etc/erp-sqlite/api.env` | secretos (chmod 600, fuera del repo) |

Servicio `erp-sqlite-api` (systemd): usuario sin privilegios, `ProtectSystem=strict`, escritura solo
en `db/` y `state/`, escucha en `127.0.0.1`. nginx publica `/api/` y el front en el mismo origen.

## Seguridad

- Sin defaults: sin `JWT_SECRET`/`ADMIN_*` el proceso no arranca.
- `JWT_SECRET` es también el pepper del hash: rotarlo invalida todas las contraseñas.
- DER toma la IP del **primer** salto de `X-Forwarded-For`: nginx debe **sobrescribirlo** con
  `$remote_addr` (ya lo hace `deploy/nginx-erp-sqlite.conf`); si se anexa, se puede falsear la IP
  del bloqueo por intentos.
- La autenticación es solo por `Authorization: Bearer` (no cookie).

## API

`/api/login` · `/api/logout` · `/api/logout/all` · `/api/sessions` · `/api/password` · `/api/events`
(DER identity) · `/api/catalogos` (DER) · `/api/db-admin/*` (databases, objects, columns, rows,
stats, query, vacuum, integrity). Contrato tipado en `src/contract/front.ts`.
