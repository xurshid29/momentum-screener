#!/usr/bin/env bash
# One-shot TLS bootstrap. Adapted from the canonical certbot+nginx-companion
# pattern (https://github.com/wmnnd/nginx-certbot).
#
# Steps:
#   1. Create a self-signed dummy cert so nginx can start at all (otherwise
#      the ssl_certificate directive references a non-existent file).
#   2. Bring up nginx + certbot.
#   3. Replace the dummy with a real Let's Encrypt cert via webroot challenge.
#   4. Reload nginx so it picks up the real cert.
#
# Run from /opt/pnldash on the droplet, AFTER:
#   - DNS A record for pnldash.uz (and www.pnldash.uz if you want it) points
#     to this droplet.
#   - .env exists with prod values.
#
# Idempotent: re-running with existing real certs will skip cert issuance.

set -euo pipefail

DOMAINS=(pnldash.uz www.pnldash.uz)
EMAIL="${LETSENCRYPT_EMAIL:-xurshid29@gmail.com}"
RSA_KEY_SIZE=4096
STAGING="${LETSENCRYPT_STAGING:-0}"   # set to 1 to use staging endpoint while debugging

COMPOSE="docker compose -f docker-compose.prod.yml"

PRIMARY="${DOMAINS[0]}"

echo "### Checking DNS for ${DOMAINS[*]}…"
for d in "${DOMAINS[@]}"; do
  resolved=$(getent hosts "$d" | awk '{ print $1 }' | head -1 || true)
  if [[ -z "$resolved" ]]; then
    echo "  [warn] $d does not resolve. ACME HTTP-01 will fail."
  else
    echo "  $d -> $resolved"
  fi
done

# ─── 1. seed dummy cert ────────────────────────────────────────────────
echo "### Seeding dummy cert for ${PRIMARY}…"
$COMPOSE run --rm --entrypoint "/bin/sh" certbot -c "
  mkdir -p /etc/letsencrypt/live/${PRIMARY}
  openssl req -x509 -nodes -newkey rsa:${RSA_KEY_SIZE} -days 1 \
    -keyout /etc/letsencrypt/live/${PRIMARY}/privkey.pem \
    -out    /etc/letsencrypt/live/${PRIMARY}/fullchain.pem \
    -subj   '/CN=localhost'
"

# ─── 2. bring up nginx so the ACME challenge endpoint is reachable ─────
echo "### Starting nginx…"
$COMPOSE up -d nginx

# ─── 3. delete dummy + request real cert ───────────────────────────────
echo "### Removing dummy and requesting Let's Encrypt cert…"
$COMPOSE run --rm --entrypoint "/bin/sh" certbot -c "
  rm -rf /etc/letsencrypt/live/${PRIMARY} \
         /etc/letsencrypt/archive/${PRIMARY} \
         /etc/letsencrypt/renewal/${PRIMARY}.conf
"

domain_args=()
for d in "${DOMAINS[@]}"; do
  domain_args+=(-d "$d")
done

staging_arg=""
if [[ "$STAGING" != "0" ]]; then
  staging_arg="--staging"
fi

$COMPOSE run --rm --entrypoint "certbot" certbot \
  certonly --webroot -w /var/www/certbot \
  $staging_arg \
  "${domain_args[@]}" \
  --email "$EMAIL" \
  --rsa-key-size $RSA_KEY_SIZE \
  --agree-tos \
  --non-interactive \
  --force-renewal

# ─── 4. reload nginx with the real cert ────────────────────────────────
echo "### Reloading nginx…"
$COMPOSE exec nginx nginx -s reload

echo "### Done. https://${PRIMARY}/ should now serve a valid cert."
