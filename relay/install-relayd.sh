#!/usr/bin/env bash
# Install nectar-relayd on the relay host (DECISIONS D35). Idempotent. Run after install.sh.
#
#   ./install-relayd.sh <domain> [--dist <nectar dist dir>]                  # as root on the relay
#   ./install-relayd.sh <domain> --root <scratch dir> [--dist <dir>]        # render everything into a scratch tree; no users, no systemctl
#
# It installs the relayd files to /opt/nectar-relayd, a system user nectar-relayd, the
# systemd units, /etc/nectar-relayd.json (only if absent), and turns /usr/local/bin/nectar-relay
# into the admin client of relayd. It never touches the Caddyfile, DNS or the tailnet policy.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

DOMAIN=""
ROOT=""
DIST="$here/../dist"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="${2:?--root needs a directory}"; shift 2;;
    --dist) DIST="${2:?--dist needs a directory}"; shift 2;;
    -*) echo "unknown flag $1" >&2; exit 2;;
    *) DOMAIN="$1"; shift;;
  esac
done
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] \
  || { echo "usage: ./install-relayd.sh <domain> [--dist <dir>] [--root <scratch dir>]" >&2; exit 2; }
if [[ -n "$ROOT" ]]; then
  [[ "$ROOT" = /* ]] || { echo "--root must be an absolute path" >&2; exit 2; }
  ROOT="$(realpath -m -- "$ROOT")"
  [[ "$ROOT" != "/" ]] || { echo "--root / is a real install; drop --root" >&2; exit 2; }
else
  [[ $EUID -eq 0 ]] || { echo "run as root on the relay host, or pass --root <scratch dir>" >&2; exit 1; }
fi

FILES=(relayd-cli.js relayd.js localapi.js commands.js errors.js)
for file in "${FILES[@]}"; do
  [[ -f "$DIST/$file" ]] || { echo "$DIST/$file is missing; run pnpm build first" >&2; exit 1; }
done

NODE="${NECTAR_RELAYD_NODE:-$(command -v node || true)}"
[[ -n "$NODE" && -x "$NODE" ]] || { echo "node (>= 20) is not installed on this host" >&2; exit 1; }
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[[ "$major" -ge 20 ]] || { echo "node $major is too old; relayd needs node >= 20" >&2; exit 1; }

OPT="$ROOT/opt/nectar-relayd"
ETC="$ROOT/etc"
UNITS="$ROOT/etc/systemd/system"
ROUTES="$ROOT/etc/caddy/nctr-routes"
STATE="$ROOT/var/lib/nectar-relayd"
BIN="$ROOT/usr/local/bin"
CONFIG="$ETC/nectar-relayd.json"
mkdir -p "$OPT" "$UNITS" "$ROUTES" "$BIN" "$ETC/cron.d"

echo "== relayd files -> $OPT =="
for file in "${FILES[@]}"; do install -m0644 "$DIST/$file" "$OPT/$file"; done
printf '{"type":"module","private":true}\n' > "$OPT/package.json"

if [[ -z "$ROOT" ]]; then
  echo "== system user nectar-relayd =="
  id nectar-relayd >/dev/null 2>&1 || useradd --system --home-dir /var/lib/nectar-relayd --no-create-home --shell /usr/sbin/nologin nectar-relayd
  getent group caddy >/dev/null || { echo "no caddy group; run install.sh first" >&2; exit 1; }
  chown nectar-relayd:caddy "$ROUTES"
  chmod 2750 "$ROUTES"
  find "$ROUTES" -maxdepth 1 -name '*.caddy' -exec chown nectar-relayd:caddy {} + -exec chmod 0640 {} +
else
  chmod 2750 "$ROUTES"
fi

if [[ -e "$CONFIG" ]]; then
  echo "== $CONFIG exists; left as it is =="
else
  echo "== $CONFIG (empty allowlist: relayd refuses every node until you add node IDs) =="
  cat > "$CONFIG" <<EOF
{
  "domain": "$DOMAIN",
  "allow": [],
  "ungated": [],
  "state_dir": "/var/lib/nectar-relayd",
  "routes_dir": "/etc/caddy/nctr-routes",
  "admin_socket": "/run/nectar-relayd/admin.sock",
  "control": { "port": 8450 },
  "verify": { "port": 8451 },
  "reload": { "stamp": "/var/lib/nectar-relayd/reload.stamp" },
  "hash": ["/usr/local/bin/caddy", "hash-password"],
  "max_routes_per_node": 50,
  "max_routes": 200
}
EOF
  chmod 0644 "$CONFIG"
fi

echo "== systemd units =="
cat > "$UNITS/nectar-relayd.service" <<EOF
[Unit]
Description=nectar-relayd: public preview routes for *.$DOMAIN (D35)
After=network-online.target tailscaled.service caddy.service
Wants=network-online.target

[Service]
User=nectar-relayd
Group=nectar-relayd
SupplementaryGroups=caddy
UMask=0027
ExecStart=$NODE /opt/nectar-relayd/relayd-cli.js serve --config /etc/nectar-relayd.json
Restart=on-failure
RestartSec=5
RuntimeDirectory=nectar-relayd
RuntimeDirectoryMode=0700
StateDirectory=nectar-relayd
StateDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/etc/caddy/nctr-routes
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
EOF
cat > "$UNITS/nectar-relayd-caddy-reload.path" <<EOF
[Unit]
Description=Reload Caddy when nectar-relayd changes a route

[Path]
PathChanged=/var/lib/nectar-relayd/reload.stamp
Unit=nectar-relayd-caddy-reload.service

[Install]
WantedBy=multi-user.target
EOF
cat > "$UNITS/nectar-relayd-caddy-reload.service" <<EOF
[Unit]
Description=Reload Caddy for nectar-relayd routes

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl reload caddy
EOF

echo "== nectar-relay -> admin client of relayd =="
cat > "$BIN/nectar-relay" <<EOF
#!/bin/sh
exec $NODE /opt/nectar-relayd/relayd-cli.js admin --config /etc/nectar-relayd.json "\$@"
EOF
chmod 0755 "$BIN/nectar-relay"

cat > "$ETC/cron.d/nctr-relay-prune" <<EOF
# relayd prunes hourly by itself; this asks it once more, so a stuck timer cannot keep a URL alive
17 * * * * root /usr/local/bin/nectar-relay prune >/dev/null 2>&1
EOF

if [[ -n "$ROOT" ]]; then
  echo "scratch install rendered under $ROOT (no user, no systemctl)"
  exit 0
fi

systemctl daemon-reload
systemctl enable --now nectar-relayd-caddy-reload.path
systemctl enable nectar-relayd
systemctl restart nectar-relayd
sleep 2
systemctl is-active nectar-relayd
/usr/local/bin/nectar-relay health || true
echo
echo "next: add each publishing node's stable ID to \"allow\" in $CONFIG (tailscale status --json | jq '.Peer[] | {DNSName, ID}')."
echo "relayd re-reads the allowlist on every request. The tailnet ACL must let those nodes reach this host on tcp:8450."
