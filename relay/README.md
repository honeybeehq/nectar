# Set up your own `<domain>.site` preview relay

This is the relay behind `nectar expose` (SPEC §2 amendment, DECISIONS D21). Point a
wildcard domain at one small VM and you get gated public preview URLs
(`<sub>.<your-domain>`) for any nectar env on your mesh. **Routing, not tunneling:** the
relay joins your tailnet and reverse-proxies to each publisher's existing tailscale-serve
URL, so publishing machines run no daemon and hold no credentials — they drive the relay
over Tailscale SSH.

Domain-agnostic: it runs for `nctr.site` (our instance) or any domain you own.

## What you need

- A small VM with a **public IPv4**, ports 80/443 free (or already running Caddy), that
  has **joined your tailnet**.
- A domain whose DNS you control on **Cloudflare** (for the DNS-01 wildcard cert).

## One-time setup

```sh
# on the VM, as root, from this relay/ dir:
./install.sh <your-domain>            # installs Caddy+cloudflare-dns, nectar-relay, prune cron, conf

# 1. DNS: add   *.<your-domain>  A  <this-VM-public-IP>   (DNS-only / gray-cloud)
# 2. Token: a Cloudflare API token (My Profile → API Tokens → "Edit zone DNS",
#           scoped to <your-domain>):
printf 'CLOUDFLARE_API_TOKEN=%s\n' "<token>" > /etc/caddy/nctr.env && chmod 600 /etc/caddy/nctr.env

./install.sh <your-domain> --with-cert  # append the *.<domain> block; the wildcard cert issues on first use
```

`install.sh` is idempotent and prints these next-steps itself. The wildcard cert covers
every ephemeral `<sub>.<domain>` with one certificate (DNS-01), so churning previews never
hit Let's Encrypt per-name rate limits.

## Point nectar at it

On each publishing machine, add the target to `~/.nectar/nectar.json`:

```jsonc
"exposures": {
  "site": { "kind": "relay", "host": "<your-vm>", "domain": "<your-domain>",
            "gate": "password", "control": "tailscale-ssh" }
}
```

`control` is `tailscale-ssh` (keyless — needs a tailnet ACL ssh rule to the VM) or `ssh`
(a system ssh key you've already set up). Then:

```sh
nectar expose <env> --to site                 # gated → returns url + password
nectar expose <env> --to site --gate none --public   # ungated, unguessable URL
nectar unexpose <env>
```

## Files

- `nectar-relay` — the VM-side control command (`add`/`rm`/`prune`/`ls`/`health`). One
  route file per exposed env under `/etc/caddy/nctr-routes/`, imported by the wildcard
  block. Routes embed their own expiry; the hourly `prune` cron removes them even if a
  publisher never calls `unexpose` — a dead machine cannot leak a URL. Reads its domain
  from `/etc/nectar-relay.conf` (or nectar's `--domain`).
- `Caddyfile.template` — the `*.__DOMAIN__` wildcard site block; `install.sh` substitutes
  the domain.
- `install.sh` — the idempotent bootstrap above.

## Notes & limits

- One relay VM currently fronts one domain (fixed internal paths). Multiple domains per
  box is a future change.
- The relay reaches publishers over the tailnet, so publishers must be tailnet members
  (add the relay to the tailnet ACL for ports 8440–8542). A team without a shared tailnet
  needs the tunnel model instead — see [../docs/FUTURE-nctr-cloud.md](../docs/FUTURE-nctr-cloud.md).
- The gate is Caddy basic-auth in the route block; `--gate none` requires `--public`.
  iOS streams are interactive — exposing one needs `nectar expose --expose-interactive`.
