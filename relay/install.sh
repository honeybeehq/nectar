#!/usr/bin/env bash
# Set up your own <domain>.site preview relay. Idempotent — safe to re-run. Run as root
# on the relay host (needs: a public IP, ports 80/443 free-or-Caddy, tailscale joined).
#
#   ./install.sh <domain>                 # install binary(if needed)+script+routes+cron+conf
#   ./install.sh <domain> --with-cert     # also append the *.<domain> wildcard block (needs the token)
#
# Two things you provide once (the installer prints these too):
#   1. DNS:  *.<domain>  A  <this-host's-public-IP>   (DNS-only / gray-cloud)
#   2. Token: a Cloudflare API token (Zone→DNS→Edit, scoped to <domain>) at
#             /etc/caddy/nctr.env as:  CLOUDFLARE_API_TOKEN=...   before --with-cert.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
CADDYFILE=/etc/caddy/Caddyfile
ROUTES=/etc/caddy/nctr-routes
CONF=/etc/nectar-relay.conf

DOMAIN="${1:-}"
WITH_CERT="${2:-}"
[[ $EUID -eq 0 ]] || { echo "run as root on the relay host" >&2; exit 1; }
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || { echo "usage: ./install.sh <domain> [--with-cert]   (e.g. ./install.sh nctr.site)" >&2; exit 1; }

echo "== caddy with cloudflare-dns module =="
if ! /usr/local/bin/caddy list-modules 2>/dev/null | grep -q dns.providers.cloudflare; then
  curl -fsSL -o /tmp/caddy-cf "https://caddyserver.com/api/download?os=linux&arch=$(dpkg --print-architecture)&p=github.com/caddy-dns/cloudflare"
  install -m0755 /tmp/caddy-cf /usr/local/bin/caddy && rm -f /tmp/caddy-cf
fi
mkdir -p /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/override.conf <<EOF
[Service]
ExecStart=
ExecStart=/usr/local/bin/caddy run --environ --config $CADDYFILE
ExecReload=
ExecReload=/usr/local/bin/caddy reload --config $CADDYFILE --force
EnvironmentFile=-/etc/caddy/nctr.env
EOF

echo "== nectar-relay command + routes dir + conf ($DOMAIN) =="
install -m0755 "$here/nectar-relay" /usr/local/bin/nectar-relay
mkdir -p "$ROUTES"
printf 'NECTAR_RELAY_DOMAIN=%s\n' "$DOMAIN" > "$CONF"   # bare `nectar-relay ls` knows its domain

echo "== hourly prune (belt-and-braces TTL teardown) =="
cat > /etc/cron.d/nctr-relay-prune <<EOF
# drop expired preview routes even if the publisher never called unexpose
17 * * * * root /usr/local/bin/nectar-relay prune >/dev/null 2>&1
EOF

if [[ "$WITH_CERT" == "--with-cert" ]]; then
  echo "== *.$DOMAIN wildcard site block =="
  [[ -s /etc/caddy/nctr.env ]] || { echo "  /etc/caddy/nctr.env missing CLOUDFLARE_API_TOKEN" >&2; exit 1; }
  if ! grep -qF "*.$DOMAIN {" "$CADDYFILE"; then
    printf '\n' >> "$CADDYFILE"
    sed "s/__DOMAIN__/$DOMAIN/g" "$here/Caddyfile.template" >> "$CADDYFILE"
  fi
fi

systemctl daemon-reload
/usr/local/bin/caddy validate --config "$CADDYFILE" >/dev/null
systemctl restart caddy   # restart (not reload) so a freshly-written nctr.env is picked up
sleep 2
systemctl is-active caddy
echo "relay ready for *.$DOMAIN. health: $(/usr/local/bin/nectar-relay health)"
if [[ "$WITH_CERT" != "--with-cert" ]]; then
  echo
  echo "next: point DNS  *.$DOMAIN A <this-host-public-ip>  (DNS-only), then:"
  echo "  printf 'CLOUDFLARE_API_TOKEN=%s\\n' <token> > /etc/caddy/nctr.env && chmod 600 /etc/caddy/nctr.env"
  echo "  ./install.sh $DOMAIN --with-cert"
fi
