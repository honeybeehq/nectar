# nctr.site relay

The public-preview relay for `nectar expose` (SPEC §2 amendment, DECISIONS D21). One
public-IP VM that has joined the tailnet reverse-proxies `<sub>.nctr.site` to a
publisher's existing tailscale-serve URL. **Routing, not tunneling** — publishing
machines run no daemon and hold no credentials; they drive the relay over Tailscale SSH.

## Files

- `nectar-relay` — the VM-side control command (`add`/`rm`/`prune`/`ls`/`health`). One
  route file per exposed env under `/etc/caddy/nctr-routes/`, imported by the wildcard
  Caddy site block. Routes embed their own expiry; hourly `prune` (cron) removes them
  even if the publisher never calls `unexpose` — a dead machine cannot leak a URL.
- `Caddyfile.nctr` — the `*.nctr.site` wildcard site block. One DNS-01 wildcard cert
  (so churning previews never hit Let's Encrypt per-name rate limits).
- `install.sh` — idempotent bootstrap.

## Host requirements

Public IPv4, tailnet member, ports 80/443 free-or-Caddy. Current host: `relay-1`
(`203.0.113.10`), which also serves `hooks.example.com` — the relay coexists.

## One-time bootstrap

```sh
# on the relay VM, as root, from this dir:
./install.sh                     # custom Caddy (cloudflare-dns), nectar-relay, routes, prune cron

# create a Cloudflare API token: My Profile → API Tokens → "Edit zone DNS",
# scoped to the nctr.site zone. Then:
printf 'CLOUDFLARE_API_TOKEN=%s\n' "<token>" > /etc/caddy/nctr.env && chmod 600 /etc/caddy/nctr.env
./install.sh --with-cert         # append the wildcard block + reload; the cert issues on first use
```

DNS: `*.nctr.site A <relay-ip>`, **DNS-only (gray-cloud)** — proxying would break the
DNS-01 wildcard and websocket streams. (Cloudflare Access in front is a later flip.)

Tailnet ACL: grant the relay host access to publishers' ports 8440–8542 (the §9.1 rule
gains one member).

## What nectar drives (per expose/unexpose)

```sh
tailscale ssh <relay> nectar-relay add  <sub> <upstream-https-url> <expires-epoch> \
                                        [--password-hash <bcrypt> | --public]
tailscale ssh <relay> nectar-relay rm   <sub>
```

`<sub>` is `<app>-<branch-slug>-<eid>` (`--public` adds an unguessable suffix). Gate
default is a password (basic-auth in the route block); `--gate none` needs `--public`.

## Status (2026-07-19)

Built and validated on `relay-1`: custom Caddy v2.11.4 with the cloudflare-dns
module installed via systemd drop-in (old apt binary backed up at
`/root/caddy-2.6.2.bak`, `hooks.example.com` unaffected); `nectar-relay` installed and
smoke-tested (add/ls/prune/rm); the assembled Caddyfile parses. **Pending:** the
Cloudflare token at `/etc/caddy/nctr.env`, then `install.sh --with-cert`; the tailnet
ACL rule; and the `nectar expose`/`unexpose` CLI verbs (nectar-side, not yet built).
