#!/bin/sh
# install.sh — deja un VPS Ubuntu con el sistema erp-sqlite (API + login DER) igual que todos los demás.
#
#   git clone <repo-api> /opt/erp-sqlite/api
#   ADMIN_PASSWORD='…' sh /opt/erp-sqlite/api/deploy/install.sh
#
# Idempotente: se puede volver a correr. NO pisa /etc/erp-sqlite/api.env si ya existe (el JWT_SECRET
# es también el pepper del hash de contraseñas: cambiarlo invalida todos los usuarios).
# Variables opcionales: ADMIN_USER (admin), PORT (8091), DENO_VERSION (la fijada abajo).
set -eu

DENO_VERSION="${DENO_VERSION:-2.9.7}"
APP=/opt/erp-sqlite
ENV_FILE=/etc/erp-sqlite/api.env
SVC=erp-sqlite-api
USR=erp-sqlite
HERE=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" = 0 ] || { echo "✗ correr como root"; exit 1; }
[ "$(cd "$HERE/.." && pwd)" = "$APP/api" ] || { echo "✗ el repo debe estar clonado en $APP/api"; exit 1; }

echo "· paquetes base"
need=""
for p in curl unzip sqlite3 openssl; do command -v "$p" >/dev/null || need="$need $p"; done
[ -z "$need" ] || { apt-get update -qq && apt-get install -y -qq $need; }

echo "· deno $DENO_VERSION (misma versión en todos los VPS)"
if ! deno --version 2>/dev/null | grep -q "^deno $DENO_VERSION "; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/deno.zip" "https://github.com/denoland/deno/releases/download/v$DENO_VERSION/deno-x86_64-unknown-linux-gnu.zip"
  unzip -oq "$tmp/deno.zip" -d /usr/local/bin && chmod 755 /usr/local/bin/deno && rm -rf "$tmp"
fi

echo "· usuario y carpetas"
id "$USR" >/dev/null 2>&1 || useradd --system --home-dir "$APP" --no-create-home --shell /usr/sbin/nologin "$USR"
mkdir -p "$APP/db" "$APP/state" "$APP/.deno" "$APP/.backup" /etc/erp-sqlite
chown -R "$USR:$USR" "$APP/db" "$APP/state" "$APP/.deno"
chmod 750 "$APP/db" "$APP/state"

echo "· configuración ($ENV_FILE)"
if [ ! -f "$ENV_FILE" ]; then
  [ -n "${ADMIN_PASSWORD:-}" ] || { echo "✗ primera instalación: falta ADMIN_PASSWORD (mín. 8)"; exit 1; }
  umask 077
  cat > "$ENV_FILE" <<EOF
# erp-sqlite api — generado por install.sh el $(date -u +%FT%TZ). NO versionar.
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_PASSWORD=$ADMIN_PASSWORD
PORT=${PORT:-8091}
HOST=127.0.0.1
DB=$APP/state/admin.sqlite
DB_DIR=$APP/db
DENO_DIR=$APP/.deno
EOF
  chmod 600 "$ENV_FILE"
else
  echo "  ya existe: se conserva"
fi

echo "· dependencias (caché del servicio)"
cd "$APP/api"

PORT=$(sed -n "s/^PORT=//p" "$ENV_FILE")
DENO_DIR="$APP/.deno" deno install --quiet
DENO_DIR="$APP/.deno" deno cache --quiet src/main.ts
chown -R "$USR:$USR" "$APP/.deno"

echo "· servicio systemd"
install -m 644 deploy/$SVC.service /etc/systemd/system/$SVC.service
systemctl daemon-reload
systemctl enable --quiet $SVC
systemctl restart $SVC

echo "· nginx (snippet; incluirlo en el server TLS)"
if [ -d /etc/nginx ]; then
  mkdir -p /etc/nginx/snippets
  install -m 644 deploy/nginx-erp-sqlite.conf /etc/nginx/snippets/erp-sqlite.conf
fi

ok=0
for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT:-8091}/api/permisos"; then ok=1; break; fi
  sleep 1
done
[ $ok = 1 ] || { echo "✗ $SVC no responde; ver: journalctl -u $SVC -n 50"; exit 1; }
echo "✓ $SVC en 127.0.0.1:${PORT:-8091}/api"
echo "  falta (una vez): 'include snippets/erp-sqlite.conf;' en el server de nginx, nginx -t && systemctl reload nginx"
