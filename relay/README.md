# Set up your own `<domain>.site` preview relay

This is the relay behind `nectar expose` and `nectar publish --public` (SPEC §4.7,
DECISIONS D21, D35). Point a wildcard domain at one small VM and you get gated public
preview URLs (`<sub>.<your-domain>`) for any nectar env on your mesh. **Routing, not
tunneling:** the relay joins your tailnet and reverse-proxies to each publisher's existing
tailscale-serve URL. Publishers hold no credentials: `nectar-relayd` on the VM identifies
them by their tailnet node and lets each one manage only routes to its own previews.

Domain-agnostic: it runs for `nctr.site` (our instance) or any domain you own.

## What you need

- A small VM with a **public IPv4**, ports 80/443 free (or already running Caddy), that
  has **joined your tailnet**.
- A domain whose DNS you control on **Cloudflare** (for the DNS-01 wildcard cert).

## One-time setup

```sh
# on the VM, as root, from this relay/ dir of a built checkout (pnpm install && pnpm build):
./install.sh <your-domain>            # Caddy with cloudflare-dns and the routes dir

# 1. DNS: add   *.<your-domain>  A  <this-VM-public-IP>   (DNS-only / gray-cloud)
# 2. Token: a Cloudflare API token (My Profile → API Tokens → "Edit zone DNS",
#           scoped to <your-domain>):
printf 'CLOUDFLARE_API_TOKEN=%s\n' "<token>" > /etc/caddy/nctr.env && chmod 600 /etc/caddy/nctr.env

./install.sh <your-domain> --with-cert  # append the *.<domain> block; the wildcard cert issues on first use
./install-relayd.sh <your-domain>       # nectar-relayd, its units, /etc/nectar-relayd.json and nectar-relay
```

Both scripts are idempotent. `install-relayd.sh` needs Node 20 or later on the VM. It
creates the `nectar-relayd` system user, copies relayd from `dist/` to
`/opt/nectar-relayd`, writes `/etc/nectar-relayd.json` only if it is missing, installs
`nectar-relayd.service` (unprivileged, `ProtectSystem=strict`, writes only the routes
dir and its state dir) and a path unit that reloads Caddy when relayd touches
`/var/lib/nectar-relayd/reload.stamp`. `--root <dir>` renders all of it into a scratch
tree instead, without users or systemctl. The wildcard cert covers every `<sub>.<domain>`
with one certificate (DNS-01), so churning previews never hit Let's Encrypt per-name
limits.

Then add each publishing node to the allowlist (relayd re-reads it on every request):

```jsonc
// /etc/nectar-relayd.json
"allow":   [{ "node_id": "n3iDbEYTfA21CNTRL", "name": "trmd-metal-2" }],   // tailscale status --json → .Peer[].ID
"ungated": []                                                             // nodes that may publish --gate none
```

The tailnet ACL should let only those nodes reach the relay on tcp:8450, and let the relay
reach them only on 8443–8542.

## Point nectar at it

On each publishing machine, add the target to `~/.nectar/nectar.json`:

```jsonc
"exposures": {
  "site": { "kind": "relay", "host": "<your-vm>", "domain": "<your-domain>",
            "control": "relayd", "gate": "password", "default": true }
}
```

Then:

```sh
nectar publish --public                       # publish and expose; url + share details
nectar expose <env>                           # expose a serving env (again: updates it in place)
nectar expose <env> --rotate                  # new password
nectar expose <env> --gate none --public      # ungated, only for nodes on "ungated"
nectar unexpose <env>
```

`url` in the result has no secret in it. The password is in `password`, `credentials` and
`share_note`, which the result lists under `secret`. nectard's hourly gc moves each route's
expiry with its env and marks the exposure revoked when the relay removed it.

`control: "tailscale-ssh"` (or `"ssh"`) keeps the old path: nectar runs
`nectar-relay add|rm|health` on the VM as root over SSH. It needs an SSH rule to the VM
and exists only for relays set up before relayd; relayd still owns the routes it adds.

## Operating the relay

On the VM, as root:

```sh
nectar-relay ls [--json]                      # every route, owner node, expiry; kill flags
nectar-relay rm <sub>                         # remove one route; its owner sees it revoked
nectar-relay disable-all [--node <name|id>]   # remove routes and refuse new ones (all, or one node)
nectar-relay enable-all  [--node <name|id>]   # lift that flag
nectar-relay prune                            # remove expired routes now (cron runs it hourly)
nectar-relay health [--json]                  # caddy, relayd, routes, control address
journalctl -u nectar-relayd                   # one JSON line per request; never passwords
```

## Files

- `install.sh` — Caddy with the cloudflare-dns module and the `*.<domain>` block.
- `install-relayd.sh` — relayd, its units, its config and the `nectar-relay` admin shim.
- `Caddyfile.template` — the `*.__DOMAIN__` wildcard site block; it imports
  `/etc/caddy/nctr-routes/*.caddy`, one file per route, which only relayd writes.
- `../src/relayd.ts`, `../src/relayd-cli.ts` — the service and its CLI.

## Notes & limits

- One relay fronts one domain. relayd imports route files written by the old
  `nectar-relay` on first start (owner `admin`), so a running relay keeps its routes.
- The relay reaches publishers over the tailnet, so publishers must be tailnet members.
  A team without a shared tailnet needs the tunnel model instead — see
  [../docs/FUTURE-nctr-cloud.md](../docs/FUTURE-nctr-cloud.md).
- The gate is Caddy basic-auth (user `reviewer`); the route drops `Authorization` before
  proxying, so the dev server never sees the password. Apps that send their own
  `Authorization` header need slice 2's link token. iOS streams are interactive — exposing
  one needs `--expose-interactive`.
