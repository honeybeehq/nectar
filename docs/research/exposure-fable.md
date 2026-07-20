# External exposure targets — research report (fable)

*2026-07-19 · brief: easiest possible external exposure for `nectar expose <env> --to <target>`
(V0.2 §5, D19). Emphasis: architect a managed `nectar.site`. Read: README, V0.2 §4–5,
DECISIONS D19, SPEC §9/§10. Status: research, read-only; nothing here is built.*

## 0. TL;DR

**The tailnet changes the problem.** Every nectar publishing machine is already reachable
at `https://<host>.ts.net:8443–8542` inside the mesh. So the easiest public exposure is
not a tunnel at all: put **one small VM with a public IP on the tailnet** (`nectar.site`
relay), give it wildcard DNS + one wildcard cert, and have it **reverse-proxy
`<env>.nectar.site` to the publisher's existing mesh URL**. Publishing machines need
**zero new daemons and zero new credentials** (control plane is Tailscale SSH). This one
build *is* target (b), *is* the generic-VM contract (c), and covers ~90 % of what
Cloudflare (a) would give us, at roughly half the integration code.

Ranking by ease (details in §7): **nectar.site relay > sish-on-a-VM > cloudflared named
tunnels > vercel-deploy**, with cloudflared *quick tunnels* as a 1-day stopgap that fails
the gate/TTL requirements. **Recommendation: build the nectar.site relay first** (§8).

## 1. Constraints from the existing design

- D19: exposure is an explicit per-env escalation; targets live in **machine config**
  (`exposures`), never repo recipes; gated by default (`--gate none` needs `--public`);
  `tailscale funnel` forbidden; gc tears down at TTL; failures are `E_EXPOSE` and never
  touch the tailnet surface; password gating is **one nectar-side fronting proxy**.
- SPEC §9: envs serve tailnet-only on 8443–8542 (+ :8440 packs/evidence/drops); the
  tailnet has a shared external node, so ACLs already restrict those ports to operator
  devices — any relay node must be added to that allow-rule.
- SPEC §10: gc is the teardown engine (hourly, per-env locks); doctor is the health
  surface. Exposure must slot into both.
- Secrets ride hem refs (`project/<p>/<name>`), resolved at command time, never stored.

## 2. The load-bearing insight: routing, not tunneling

Tunnels (cloudflared, frp, ssh -R, sish) exist to traverse NAT from machines that have no
stable inbound path. **Our machines already have one — the tailnet.** A relay that is
itself a tailnet node can open an ordinary outbound-from-its-perspective HTTPS connection
to `https://builder-1.tailnet.ts.net:8444` and serve the response publicly. That
deletes the entire per-publisher half of every tunnel design:

| | tunnel model (cf/ssh/frp) | relay-routing model |
| --- | --- | --- |
| on each publishing machine | a daemon + a credential + supervision | **nothing** |
| per-env expose action | DNS route + ingress rule + config reload | one route entry on the relay |
| gate | per-machine fronting proxy or vendor auth | **one** gate on the relay (D19's proxy, built once, centrally) |
| teardown | remove DNS + ingress + maybe kill process | delete one route entry |
| failure domain | N machines × daemon health | one VM |

Caveats: the relay must hold tailnet ACL permission to ports 8440–8542 on publishers
(ops, one rule); a publisher that falls off the tailnet makes its exposed envs 502 (same
truth as F9 — references are machine-bound); and websockets must proxy cleanly (Caddy
does this natively; needed for HMR and serve-sim streams).

## 3. Target (a): Cloudflare

### Best-fit shape: one named tunnel per machine, wildcard Access app

- **Mechanics.** `cloudflared` daemon per publishing machine (launchd on macOS), one
  named tunnel each, remotely-managed (token-only local config; ingress edited via API
  without restarts — current Cloudflare guidance steers to this mode
  ([docs](https://developers.cloudflare.com/tunnel/configuration/),
  [setup](https://developers.cloudflare.com/tunnel/setup/))). Per expose:
  1 API call to add a DNS CNAME `<env>.preview.example.com → <tunnel-uuid>.cfargotunnel.com`
  ([DNS routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/))
  + 1 API call to PUT the tunnel's ingress config with the new hostname→`localhost:<port>`
  rule. Unexpose/gc reverses both.
- **Gate.** Cloudflare Access supports a **wildcard application** (`*.preview.example.com`)
  configured *once* — every exposed env is then behind email-OTP/IdP login with no per-env
  auth work ([Access wildcard](https://blog.cloudflare.com/access-wildcard-subdomain/)).
  Free plan covers 50 users
  ([community](https://community.cloudflare.com/t/50-user-limit-on-free-plan/546057)).
  Password-gate mode would instead use D19's local fronting proxy (extra build).
- **Credentials (hem).** `project/nectar/cf-api-token` (Zone.DNS edit + tunnel config
  perms) used at expose/gc time; per-machine tunnel token
  `project/nectar/cf-tunnel-token-<host>` materialized once at `doctor --fix` install
  time. Token leak = attacker can publish under your domain — rotate via hem.
- **Machine config.** As already sketched in V0.2 §5 (`kind: "cloudflare-tunnel"`,
  `domain`, `gate`), plus `tunnel_id`.
- **TTL/gc.** gc calls the two delete APIs. Needs a per-machine exposure lock: the
  remote-managed config is a single document per tunnel, so concurrent expose/gc on one
  machine is a read-modify-write race.
- **Failure modes.** Daemon down (doctor must watch launchd + `cloudflared tunnel info`);
  config PUT races; API rate limits; cloudflared version churn; Cloudflare sees all
  preview traffic (fine for previews).
- **Effort.** 4–6 days (API client, config locking, DNS+ingress lifecycle, launchd
  install in doctor, tests). **Ops:** a daemon on every publisher, forever.

### The 1-day stopgap: quick tunnels

`cloudflared tunnel --url http://localhost:<port>` with **no account, no token, no DNS**
returns a random `*.trycloudflare.com` URL. Least possible code (~spawn + parse). But:
random URL per run, dies with the process, **no gate** (violates gated-by-default unless
we front it with the local proxy, which is most of the real work anyway), no SLA. Worth
knowing about for emergencies; not the feature.

### Pages/Workers

Only fit static drops (§4 of V0.2): `wrangler pages deploy` of a drop directory is easy,
but it's a *copy*, not the running env — same strategy slot as `vercel-deploy`. Not a
path for live envs.

## 4. Target (b): exe.dev servers

Operator-owned VMs we root, reachable over ssh. Two shapes:

1. **Classic ssh -R:** per exposed env, a reverse tunnel (`ssh -R <port>:localhost:<up>`)
   plus an nginx/caddy vhost on the box. Needs: per-machine ssh keys, `GatewayPorts`/
   sshd config, remote port allocation, tunnel supervision (autossh or a nectar-owned
   respawn loop — one long-lived fragile process per env per machine), vhost templating,
   and still D19's gate proxy somewhere. It works, but it is the *most moving parts per
   env* of any option here. 4–5 days + persistent-process babysitting.
2. **The better move: root access means we can install Tailscale.** Join the box to the
   tailnet and it stops being a tunnel endpoint and becomes the **relay host of §6**.
   (b) then ceases to exist as a separate target — it is where nectar.site runs.

If for some reason a box must stay off the tailnet, the best off-the-shelf ssh-tunnel
server is **sish** (actively maintained; single binary/docker; allocates
`<name>.<domain>` per ssh connection; wildcard DNS + automated wildcard certs via
DNS-01 in its compose bundle — [repo](https://github.com/antoniomika/sish),
[docs](https://docs.ssi.sh/getting-started)). sish authenticates *publishers* by ssh key
but has **no viewer gate**, so D19's fronting proxy is still required on the publisher
side. ~3–4 days all-in. frp is heavier config for the same result
([comparison](https://azdigi.com/en/blog/cong-cu/4-free-and-open-source-alternatives-to-cloudflare-tunnel-worth-considering));
rathole (last release 2023) and boringproxy (development ended 2023) are effectively
unmaintained and have no/limited HTTP vhost story — skip.

## 5. Target (c): generic VMs — the minimal contract

What must "any server you own" provide before nectar can use it as an exposure target?

**Contract (minimal):**
1. ssh with sudo (bootstrap only);
2. ports 80/443 free, public IP;
3. a domain (or delegated subdomain) whose wildcard you can point at it, with a DNS
   provider that has an API (for DNS-01 wildcard certs);
4. *preferably* permission to join the tailnet.

With (4), the contract collapses to: **"runs `nectar relay install`"** — a bootstrap
script that installs Caddy + the route script of §6 and joins the mesh. Every generic VM
becomes a nectar.site-style relay; the machine-config entry is just
`{ "kind": "relay", "host": "<tailnet-name>", "domain": "<wildcard-domain>" }`.
Without (4), fall back to sish as in §4 — acceptable but strictly worse.

The important design consequence: **(c) is not a third implementation.** It is the
installer for §6's relay. One codepath serves exe.dev boxes, rented VMs, and our managed
domain; only the DNS name differs.

## 6. Target (d): the managed `nectar.site` — architecture (emphasis)

### 6.1 What it is

A vercel.app-style preview domain for the team: `https://<env>.nectar.site`, wildcard
DNS + TLS, one auth gate, any number of publishing machines behind it. It is **not** a
SaaS: for a small team it is one relay VM + one wildcard cert + ~200 lines of route
plumbing. "Managed" means we manage it once, centrally, instead of per machine.

### 6.2 Components — what runs where

**On the relay VM (one-time ops, ~half a day):**

- **Tailscale** — joins the mesh; ACL rule grants it (and only it, plus operator
  devices) access to publishers' 8440–8542. Enable Tailscale SSH: the control plane then
  needs no key management at all — publishers `ssh nectar-relay …` with mesh identity,
  ACL-authorized.
- **Caddy** (systemd) — terminates TLS for `*.nectar.site` with **one wildcard cert via
  DNS-01** (caddy-dns/cloudflare module; the only credential on the box is one DNS API
  token). Chosen over nginx because cert automation + graceful `caddy reload` + native
  websocket proxying come free; nginx would add certbot + reload scripting for zero gain.
- **`nectar-relay`** — a small installed command (shell or ~200-line Go), *not* a
  daemon. Subcommands:
  - `add <sub> <upstream-mesh-url> <expires-at> [--password-hash H | --public]` —
    writes `/etc/nectar-relay/routes/<sub>.caddy` (a `@<sub>` host-matcher block:
    optional `basic_auth`, `reverse_proxy <upstream>`) and `caddy reload`.
  - `rm <sub>` — deletes the fragment, reloads.
  - `prune` (cron, hourly) — deletes fragments whose embedded `expires-at` has passed.
  - `ls`, `health` — for doctor.
  Routes-as-files: atomic, debuggable, survives reboot, no database, no control daemon.
- Default vhost: anything unrouted → a branded 404/"preview expired" page; upstream
  unreachable → friendly 502 "publisher offline".

**On publishing machines: nothing new.** `nectar expose` shells
`ssh nectar-relay nectar-relay add …` exactly like `open` already uses the ssh adapter
for remote refs. No daemon, no token, no config beyond the `exposures` entry.

### 6.3 Wildcard DNS + TLS

- Register `nectar.site` (~$2–5 first year, ~$30/yr renewal for .site). DNS on
  Cloudflare **DNS-only** (free, good API): `*.nectar.site A <relay-ip>`.
- One wildcard cert, DNS-01, auto-renewed by Caddy. No per-env issuance latency, no
  Let's Encrypt rate-limit exposure, no on-demand-TLS abuse surface. The DNS token lives
  only on the relay; hem ref `project/nectar/site-dns-token` is its source of truth.

### 6.4 Per-env subdomain allocation

- Subdomain = env name (`acme--coupons-stack--web.nectar.site`). Hyphens (including
  `--`) are legal DNS labels; guard the 63-char label limit by truncating to 54 chars +
  `-` + 8-char hash. Embedded `--` never lands at positions 3–4, but the slugger should
  reject a leading/trailing hyphen anyway.
- Env names are **per-machine**, so two machines can hold the same env name. Route claim
  is first-writer-wins: `add` for a sub already routed to a *different* upstream and not
  expired → exit 2 → nectar surfaces `E_EXPOSE` ("already exposed from <host>").
  Re-expose from the same host updates in place (idempotent republish).
- With a gate, guessable names are fine. For `--public`, append the hash unconditionally
  so public URLs are not enumerable.

### 6.5 The auth gate

This is D19's "password gating implemented once, nectar-side" — implemented once *on the
relay* instead of N machines, which is strictly better (one place, covers every target
that routes through it).

- **v0: Caddy `basic_auth`** per route. `expose --gate password` takes `--password` or
  generates one; nectar bcrypt-hashes locally and passes only the hash to `add`; the
  plaintext appears once in the envelope (`urls.public` + a `gate_password` field, loud
  warning) and is never stored. Phones/browsers handle basic-auth prompts fine; ~zero
  code.
- **v1.1: cookie gate** — a ~100-line `forward_auth` service on the relay (password form
  → signed cookie) for nicer phone/client UX and per-env or shared team passwords.
- **Later, if identity is ever needed:** flip Cloudflare DNS from DNS-only to proxied
  and put a wildcard **Access** app in front of the *same relay* — SSO/OTP for ≤50 users
  free, zero changes on relay or publishers. This is how nectar.site absorbs Cloudflare's
  main residual advantage without ever building the cloudflared integration.
- Policy guard: refuse to expose ios stream URLs (interactive control surfaces, SPEC
  §9.1) unless a distinct `--interactive` acknowledgment is passed. Web envs and drops
  only, by default.

### 6.6 Machine config, CLI, envelope

```jsonc
"exposures": {
  "site": { "kind": "relay", "relay": "nectar-relay-1",
            "domain": "nectar.site", "gate": "password" }
}
```

`nectar expose <env> --to site` → resolves the env's mesh URL, ssh `add`, envelope gains
`urls.public: "https://<sub>.nectar.site"` + `packet_fields.public_url` + warning.
`unexpose` → ssh `rm`. `publish --expose site` chains. `doctor` → ssh `health` (cert
expiry, caddy up, route count) + one end-to-end fetch of a probe route.

### 6.7 TTL / gc — belt and braces

1. **gc (publisher-side):** expiring an env with an exposure runs `rm` — the existing
   teardown path, per D19.
2. **relay-side `prune`:** every route carries `expires-at` (set to the env's TTL at
   expose time; re-expose refreshes). A dead/offline publisher therefore **cannot leak a
   public route** — the relay kills it on schedule even if gc never calls. This
   double-teardown is something the per-machine tunnel designs can't give you without
   extra vendor state.

### 6.8 Failure modes

| failure | behavior |
| --- | --- |
| relay down | `expose` fails `E_EXPOSE` (ssh error); tailnet surface untouched; doctor reports |
| publisher offline / env crashed | relay serves friendly 502; route pruned at TTL regardless |
| gc missed teardown | relay `prune` removes at expires-at (≤1 h drift) |
| cert renewal failure | Caddy retries; `health` reports days-to-expiry; doctor warns <14 d |
| ACL forgot relay | end-to-end doctor probe fails loudly at setup, not at demo time |
| route claim conflict | exit 2 → `E_EXPOSE` with owning host named |
| DNS token leak | scoped token (one zone, DNS-edit only), rotate via hem; blast radius = cert issuance for our own domain |

### 6.9 Cost and ops

- **Money:** $0 marginal if the relay is an existing exe.dev box; else one small VM
  (~$5/mo) + domain (~$30/yr). No per-seat vendor cost.
- **Ops:** unattended-upgrades + Caddy auto-renew ≈ zero routine work. One VM in the
  failure domain — acceptable for previews (the tailnet surface is unaffected by relay
  loss, and re-standing the relay is `nectar relay install` + DNS).
- **Bonus:** the relay's access log is a free, central audit trail of external preview
  access — something D19's per-machine designs never get.

### 6.10 Drops

Two modes, both cheap: (i) *live route* — `<name>.nectar.site` reverse-proxies to the
publisher's `:8440/drops/<dir>/` (path-rewrite in the fragment; no rsync, TTL as above);
(ii) *static copy* — rsync the drop dir to the relay for publisher-independence. Start
with (i); it's the same `add` verb.

### 6.11 Build effort and the honest build-vs-not call

- Relay setup (ops): 0.5–1 day. `nectar-relay` script: 0.5 day. Nectar-side
  expose/unexpose/gc/doctor/envelope + tests: 2–3 days. **Total: 3–4 days to V0.2
  acceptance criterion 7.**
- **Build it.** The counter-case would be "don't self-host, use Cloudflare" — but the
  cloudflared path is *more* code (API client, config races, per-machine daemons,
  launchd), *more* credentials, and its one unique gift (Access SSO) layers onto
  nectar.site later via proxied DNS anyway. The real risk of nectar.site is scope creep
  toward SaaS (accounts, quotas, multi-tenant). Don't: routes-as-files on one VM is the
  whole v1. It generalizes (per-team gate passwords, more relays behind round-robin DNS)
  only if a real need arrives.
- **Subsumption verdict:** nectar.site **fully subsumes (b) and (c)** — it *is* the
  generic-VM contract with a nice domain, and an exe.dev box is its natural host. It
  subsumes the preview-serving 90 % of (a); Cloudflare remains a thin optional layer
  (Access/DDoS) in front of the same relay, not a parallel target. It does **not**
  subsume `vercel-deploy`, which is a deploy-a-copy strategy, not a proxy — keep that
  slot in the `exposures` schema for on-demand later. So the honest framing: nectar.site
  is *both* "just a nicer skin over the generic-VM contract" *and* worth building —
  because the skin (managed domain, one gate, one cert, double-TTL, audit log) is
  exactly the part every other option makes you rebuild per machine.

## 7. Ranking by ease

| rank | target | build | publisher footprint | credentials | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | **nectar.site relay** (§6) | **3–4 d** (incl. relay) | none | 1 DNS token (relay-only), ts-ssh | **build first** |
| 2 | sish on a VM (§4) | 3–4 d | ssh key + 1 live ssh process per env | ssh keys per machine | only if a box can't join the tailnet |
| 3 | cloudflared named tunnels (§3) | 4–6 d | daemon per machine | API token + per-machine tunnel tokens | add later *only if* Access/edge is demanded — and even then, prefer proxied-DNS-in-front-of-relay |
| 4 | vercel-deploy | 1–2 d | vercel CLI | vercel token | on demand, Vercel-shaped apps only |
| — | cf quick tunnel | 0.5–1 d | none | none | stopgap; fails gate + stable-URL + TTL requirements |
| — | frp / rathole / boringproxy | — | — | — | rejected: heavier config (frp) or unmaintained (rathole 2023, boringproxy ended 2023) |

## 8. Recommendation

**First target: the nectar.site relay** (`kind: "relay"`), hosted on an exe.dev box
joined to the tailnet. **This month:** register the domain, one ACL rule, relay
bootstrap, `expose|unexpose --to site` with basic-auth gate + double-TTL teardown —
acceptance criterion 7 in ~4 days, with (b) and (c) delivered for free as the same code.
**End state:** nectar.site is the managed preview domain; `nectar relay install` is the
generic-VM contract; the cookie gate replaces basic-auth when client UX asks; Cloudflare
Access is a config flip in front of the relay if identity ever matters; `vercel-deploy`
stays a schema slot. The `exposures` machine-config abstraction from D19 survives
unchanged — we are choosing the first kind, not foreclosing the others.

## Sources

- Cloudflare Tunnel: [configuration](https://developers.cloudflare.com/tunnel/configuration/) · [setup](https://developers.cloudflare.com/tunnel/setup/) · [DNS routing to tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/) · [routing overview](https://developers.cloudflare.com/tunnel/routing/) · [tunnels FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/) · [2026 field guide](https://dev.to/recca0120/cloudflare-tunnel-in-2026-expose-localhost-without-opening-ports-or-buying-an-ip-32l5)
- Cloudflare Access: [wildcard applications](https://blog.cloudflare.com/access-wildcard-subdomain/) · [50-user free plan](https://community.cloudflare.com/t/50-user-limit-on-free-plan/546057) · [wildcard subdomains + tunnel](https://community.cloudflare.com/t/wildcard-subdomains/501612)
- sish: [repo](https://github.com/antoniomika/sish) · [getting started](https://docs.ssi.sh/getting-started) · [advanced (wildcard certs)](https://docs.ssi.sh/advanced) · [self-hosted ngrok walkthrough](https://instatunnel.substack.com/p/ngrok-vs-sish-the-self-hosted-serveo)
- Landscape: [awesome-tunneling](https://github.com/anderspitman/awesome-tunneling) · [open-source CF-tunnel alternatives](https://azdigi.com/en/blog/cong-cu/4-free-and-open-source-alternatives-to-cloudflare-tunnel-worth-considering) · [rathole status](https://forum.cloudron.io/topic/10231/rathole-nat-traversal-proxy-alternative-to-frp-ngrok-etc)

*Uncertainty note: Cloudflare plan limits (Access 50 free users), remote-managed tunnel
API shapes, and .site renewal pricing reflect mid-2026 search results and community
threads, not first-party verification against our account — re-check at build time.
Everything about the relay design depends only on software we run ourselves.*
