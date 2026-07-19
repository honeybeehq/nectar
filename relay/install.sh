#!/usr/bin/env bash
# Bootstrap a nctr.site relay VM. Idempotent — safe to re-run. Run as root on the
# relay host (must already have: a public IP, Caddy on 80/443, and tailscale joined).
#
#   ./install.sh                      # install binary(if needed)+script+routes+cron
#   ./install.sh --with-cert          # also append the wildcard block (needs the token)
#
# The Cloudflare DNS-edit token (Zone→DNS→Edit, scoped to nctr.site) must be present
# at /etc/caddy/nctr.env as:  CLOUDFLARE_API_TOKEN=...   before --with-cert.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
CADDYFILE=/etc/caddy/Caddyfile
ROUTES=/etc/caddy/nctr-routes

[[ $EUID -eq 0 ]] || { echo "run as root on the relay host" >&2; exit 1; }

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

echo "== nectar-relay command + routes dir =="
install -m0755 "$here/nectar-relay" /usr/local/bin/nectar-relay
mkdir -p "$ROUTES"

echo "== hourly prune (belt-and-braces TTL teardown) =="
cat > /etc/cron.d/nctr-relay-prune <<EOF
# nctr.site: drop expired preview routes even if the publisher never called unexpose
17 * * * * root /usr/local/bin/nectar-relay prune >/dev/null 2>&1
EOF

if [[ "${1:-}" == "--with-cert" ]]; then
  echo "== wildcard site block =="
  [[ -s /etc/caddy/nctr.env ]] || { echo "  /etc/caddy/nctr.env missing CLOUDFLARE_API_TOKEN" >&2; exit 1; }
  if ! grep -q '\*\.nctr\.site' "$CADDYFILE"; then
    printf '\n' >> "$CADDYFILE"
    cat "$here/Caddyfile.nctr" >> "$CADDYFILE"
  fi
fi

systemctl daemon-reload
/usr/local/bin/caddy validate --config "$CADDYFILE" >/dev/null
systemctl restart caddy
sleep 2
systemctl is-active caddy
echo "relay ready. health: $(/usr/local/bin/nectar-relay health)"
