# Exposure targets — the easiest possible version of each

*2026-07-19 · author: kimi · emphasis: the self-hosted path (exe.dev / generic VMs).*
*Read against: README, docs/V0.2.md §4–§5, docs/DECISIONS.md D19, docs/SPEC.md §9.*
*Web research same-day; provider behavior I could not verify first-hand is flagged **[unverified]**.*

The question: `nectar expose <env> --to <target>` needs targets. For each candidate — Cloudflare,
exe.dev, generic VMs, and a hypothetical hosted `nectar.site` — what is the *easiest possible*
mechanism (least code, least ops, least credentials), and which should ship first?

## TL;DR

| rank | target | one-liner | effort | ongoing ops |
|---|---|---|---|---|
| 1 | **cloudflare-tunnel** (dedicated zone, token-managed) | no VM, best gate, one API token | ~2 d | ~zero |
| 2 | **ssh-tunnel, sish flavor** (any rooted VM) | one binary server-side, plain ssh client-side, zero per-env VM state | ~2 d + 1 h VM setup | one tiny VM |
| 3 | **exe.dev-native relay** (their proxy + their auth) | least code of all, but bets reviewer URLs on a dev-preview provider | ~1 d | ~zero |
| 4 | ssh-tunnel, caddy route-file flavor | no exotic deps; per-env route files over ssh | ~2.5–3 d | one tiny VM |
| 5 | frp (+ caddy for TLS) | robust, but 3 components for what sish does in 1 | ~3 d | one VM |
| 6 | pangolin | self-hosted "CF Tunnel + Access" bundle; heavy | 3+ d | a real service |
| 7 | boringproxy | perfect fit on paper; **unmaintained since 2023-05** — reject | — | — |
| 8 | rathole / autossh+nginx | strictly more manual than the above — reject | — | — |
| 9 | trycloudflare quick tunnels | zero credentials, but unstable URL + no gate — not a target | — | — |
| — | **nectar.site** | not new code: a domain + one VM running target-2's server role (or CF in front). Build *after* an ssh-tunnel kind exists | +0.5 d ops | $10/yr + $5/mo |

**Recommendation: ship `cloudflare-tunnel` first** (unchanged from D19), with two corrections from
research: use a **dedicated preview zone** (free Universal SSL only covers first-level wildcards —
`<env>.preview.example.com` is a second-level name and needs paid ACM otherwise), and manage the tunnel
**remotely by token** so per-env work is one API call. **Ship the sish-flavored `ssh-tunnel`
immediately second** — it is one code path that subsumes exe.dev-as-VM, any generic VM, and later
`nectar.site` with zero additional mechanism. If "no third party in the traffic path" is a hard
principle, invert the two: sish first, cloudflare second. Full reasoning in §8.

---

## 0. Shared design notes (applies to every target)

- **The upstream is already there.** Every web env already has a loopback upstream port
  (4100–4199) and usually a `tailscale serve` entry (8443–8542). Every exposure target is just a
  relay from a public hostname to one of those two. No target should change how envs run.
- **Nectar shells out; it does not link.** The established pattern is `runCommand(binary, args,
  {timeoutMs})` (src/tailscale.ts) plus detached processes with PIDs in the env record, lazily
  health-checked, reaped by gc (D1). Every target below is built from exactly those two
  primitives: short ssh/API calls, and at most one detached process per exposed env.
- **DNS label limit.** Env names are `<app>--<branch-slug>--<mode>` and can exceed the 63-char DNS
  label limit. Every target needs the same mapping: `hostname_label = env` if ≤63 chars and
  `[a-z0-9-]`-clean, else `<truncated>-<6-char-hash>`. One helper, all targets.
- **Credentials via hem, refs in config.** Machine config stores *refs*
  (`project/nectar/cf-api-token`, `project/nectar/expose-vm-key`); nectar resolves with `hem get`
  at expose/doctor time, keeps values out of records/logs (SPEC §9.2). Pending approval →
  `E_EXPOSE` carrying the approval instructions, same stance as F10.
- **Env record addition** (all targets):

  ```jsonc
  "exposure": {
    "target": "vm",                        // key into machine config "exposures"
    "public_url": "https://acme--coupons--web.p.example.com",
    "gate": "password",                    // access|password|exe-auth|none
    "exposed_at": "2026-07-19T12:00:00Z",
    "pid": 48213,                          // tunnel process, only for flavors that spawn one
    "detail": { "remote_port": 18107 }     // flavor-specific teardown state
  }
  ```

- **gc integration (all targets).** Expiry path calls `unexpose(env)` *before* stopping the serve
  process group; unexpose is idempotent and must succeed when the env is already dead
  (`kill -0` fails → still remove the route). Orphan sweep: doctor/gc compare target-side state
  (route files, sish connections, CF ingress list) against env records and prune anything
  unclaimed — the mirror of the existing stale-Serve-entry sweep (F5).
- **The password gate is one component.** D19 designates a nectar-side fronting proxy, uniform
  across tunnel targets. Concretely: a ~150-line loopback HTTP proxy that checks a
  constant-time-compared `Authorization: Basic` (or a `?nectar_pw=` cookie setter so links survive
  pasting), then proxies to the env's upstream. Tunnels always point at the *gate* port, never
  the raw upstream. `gate: none` skips it (and still requires `--public`). Some targets have a
  better built-in gate (CF Access, exe.dev auth, caddy basic_auth); the proxy is the fallback that
  keeps `--gate password` honest everywhere.

---

## a) Cloudflare — tunnels, Access, Pages/Workers

### Easiest mechanism: remotely-managed named tunnel per publishing machine

1. **One-time per team (dashboard, 20 min):** Zero Trust account (free ≤50 users); buy or move a
   **dedicated preview zone** (e.g. `trmdpreview.com`, ~$10/yr) onto Cloudflare free DNS; create an
   **Access application for `*.trmdpreview.com`** with an email-OTP policy (Access applications
   support wildcard hostnames **[verify in dashboard during setup]**, and email OTP works from a
   phone with no client install — this is the only gate that is genuinely pleasant for external
   reviewers).
2. **One-time per publishing machine (`nectar doctor --fix`):** API-create a named tunnel
   `nectar-<host>` with `config_src: cloudflare` (remotely-managed), read its token, store the
   token via hem (`project/nectar/cf-tunnel-<host>`), `cloudflared service install <token>`
   (launchd on macOS, systemd on linux — auto-restart, survives reboots), and create one DNS
   record: wildcard CNAME `*` → `<tunnel-id>.cfargotunnel.com` (proxied). Confirmed pattern in
   [Cloudflare's own Terraform guide](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/deployment-guides/ansible/)
   (`cloudflare_zero_trust_tunnel_cloudflared` + `_config` + DNS record).
3. **Per expose:** `GET /accounts/{acct}/cfd_tunnel/{tunnel}/configurations`, insert
   `{hostname: "<env-label>.trmdpreview.com", service: "http://127.0.0.1:<gate-port>"}` before the
   catch-all `http_status:404`, `PUT` back. One read-modify-write under the existing per-env
   lockfile discipline. No process spawned, no DNS call (wildcard already routes).
4. **Per unexpose / gc:** same PUT minus the entry. Unmatched hostnames fall through to
   cloudflared's 404 — the URL dies cleanly.

**The cert gotcha that changes the config shape.** Free Universal SSL covers `example.com` and
`*.example.com` **only** — second-level wildcards like `*.preview.example.com` require Advanced
Certificate Manager ($10/mo). The v0.2 example domain (`preview.example.com`) hits this wall the
moment envs are `<env>.preview.example.com`. Cheapest fixes, in order: **(i) dedicated zone** with
first-level env names (`<env>.trmdpreview.com`) — free, and doubles as the future `nectar.site`
zone (§d); (ii) ACM at $10/mo; (iii) flatten names into the first level of the main zone
(`pv-<env>.example.com` under a `*.example.com` wildcard CNAME — works but the wildcard swallows every
unclaimed subdomain of your real domain; sloppy). Take (i).

**Credentials.** Exactly one API token (Account: Cloudflare Tunnel:Edit; Zone: DNS:Edit on the
preview zone) at `project/nectar/cf-api-token`, plus per-machine tunnel tokens that `doctor --fix`
mints and files under `project/nectar/cf-tunnel-<host>`. Access needs no credential — it *is* the
credential. For `nectar taste`/Playwright against a gated URL: a CF **service token**
(`CF-Access-Client-Id/Secret` headers) at `project/nectar/cf-access-service-token`.

**Machine config:**

```jsonc
"cf": {
  "kind": "cloudflare-tunnel",
  "zone": "trmdpreview.com",
  "account_id": "…", "zone_id": "…",
  "tunnel_id": "…",                       // per machine, named nectar-<host>
  "api_token_ref": "project/nectar/cf-api-token",
  "gate": "access"                        // access|password|none
}
```

**TTL/gc teardown.** PUT-minus-entry at expiry (idempotent); dead-publisher case leaves a route to
a dead service (cloudflared 404/502) until doctor's orphan sweep prunes it — same honesty model as
F5. **Failure modes:** API token revoked/insufficient scope → `E_EXPOSE` at expose time; tunnel
service down → everything 1033s, doctor checks `cloudflared` service state; read-modify-write race
between two exposes on one machine → per-target lockfile (already the gc pattern); Access app
deleted → public 403, doctor warns. Tailnet surface untouched throughout (D19 rule).
**Effort ~2 days** (API client, ingress merge, doctor setup + health, tests against a mocked API).
**Ops: ~zero** — no VM, no certs, no ports, CF owns uptime of the edge.

### Rejected Cloudflare shapes

- **Locally-managed tunnels** (config file on the machine): ingress changes need a cloudflared
  restart, dropping every exposed env on that machine. Remote-managed is strictly better for
  per-env routes.
- **Quick tunnels** (`cloudflared tunnel --url …`, `*.trycloudflare.com`): zero credentials, one
  command — the ease floor — but the URL is random per run (breaks stable `packet_fields.public_url`
  across republish), cannot be gated with Access, and is best-effort service. Fine for a demo hack;
  not a target.
- **Workers/Pages as env transport:** Workers-to-tunnel proxying adds a billed component for
  nothing the tunnel doesn't already do. **Pages is the right answer for `nectar drop --to cf`**
  though: `wrangler pages deploy <dir> --project-name nectar-drops` gives
  `<hash>.nectar-drops.pages.dev` static URLs with one API token; keep it on the drops roadmap,
  not the expose path.
- **vercel-deploy** (in the v0.2 target list): a different strategy (deploy the worktree, don't
  proxy the env), only for Vercel-shaped apps. Defer per the V0.2 sequencing; nothing in this
  report changes that.

---

## b) exe.dev — operator-owned VMs over ssh

### What exe.dev actually is (research, 2026-07-19)

exe.dev is a VM subscription from the sketch.dev team — dev preview launched
[2025-12](https://blog.exe.dev/meet-exe.dev), [Series A 2026-04](https://blog.exe.dev/series-a).
Facts that matter here:

- Real KVM VMs (Ubuntu default), root, persistent disks, sub-second start; subscription buys a
  shared CPU/RAM pool and you slice it into many VMs ("want 20 idle VMs… go for it").
- Account front door is ssh: `ssh exe.dev new`, `ssh exe.dev ls --json`. REST tokens are
  *signed with your ssh key* — no separate OAuth dance ([docs](https://blog.exe.dev/apis-for-the-restless)).
- **Each VM gets one public HTTPS hostname** `<vm>.exe.xyz` behind exe.dev's proxy, TLS terminated
  by them, with `ssh exe.dev share set-public <vm>` and `ssh exe.dev share port <vm> <port>`
  controls ([skill doc built from their docs](https://github.com/openclaw/skills/blob/main/skills/bjesuiter/exe-dev/SKILL.md)).
- **A built-in auth proxy ("Login with exe")** sits in front unless the VM is set public:
  `https://<vm>.exe.xyz/__exe.dev/login`, cookie-based, with bearer tokens scoped to a single VM
  for scripts ([login-with-exe](https://exe.dev/docs/login-with-exe)). That is a real, working
  gate with zero code from us.
- VMs sit in NAT space (10.42/16, gateway-proxied ssh per this
  [fingerprint writeup](https://github.com/diggerhq/sandbox-fingerprinting/blob/main/exe-fingerprint-findings.md)) —
  i.e. **no dedicated public IP**, so the VM cannot terminate TLS for our own wildcard domain
  unless exe.dev's proxy supports custom/wildcard domains **[unverified; custom domains are
  mentioned in their docs, wildcards unlikely]**.

### Easiest mechanism: the exe.dev-native relay (target kind `exe-dev`)

One shared relay VM — or, cleaner, **one tiny relay VM per exposed env** (idle VMs are the pricing
unit's whole point, and per-env VMs make teardown a deletion):

```bash
# expose (all shelled by nectar; no daemon anywhere)
ssh exe.dev new --name pv-<envlabel> --json          # → vm name/hostname
ssh exe.dev share set-public pv-<envlabel>           # or keep private → exe.dev auth proxy IS the gate
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -R 8080:127.0.0.1:<gate-port> <vm-ssh-target>    # detached; PID → env record
ssh exe.dev share port pv-<envlabel> 8080            # their proxy → VM:8080 → tunnel → publisher
# public URL: https://pv-<envlabel>.exe.xyz
# unexpose/gc: kill the ssh pgid; ssh exe.dev rm pv-<envlabel>   (or stop at cold)
```

TLS, DNS, certs, uptime of the edge: all exe.dev's. Gate options: `exe-auth` (their proxy,
account/bearer-based — bearer tokens give `taste` a scriptable path through the gate) or
`set-public` + the nectar password proxy. **Credentials: none new** — the operator's existing
exe.dev ssh key; nothing to store if nectar just shells `ssh exe.dev …`.

**Machine config:** `{ "xe": { "kind": "exe-dev", "vm_prefix": "pv", "gate": "exe-auth" } }` — the
smallest config of any target.

**Failure modes:** exe.dev outage/dev-preview churn (URLs are exe.xyz — fine for internal, iffy
for clients); VM-name collisions across machines (prefix with publisher shortname); `-R` port
already bound on a *shared* relay VM (per-env VMs make this impossible — another reason for
per-env VMs); account ssh key absent on a publishing machine → `E_EXPOSE` with a one-line fix hint.
**Effort ~1 day** — it is the least code of any target by a wide margin. **Ops ~zero** while the
provider lives.

**Honest caveat:** this binds reviewer-facing URLs to a service that is seven months past its
public dev preview. The mechanism is disposable (the `ssh-tunnel` kind below subsumes it), so the
risk is acceptable — but I would not make it the *only* target, and I would not hand
`*.exe.xyz` links to clients.

### The other exe.dev shape: treat it as "a VM we root"

If the goal is `*.<domain-we-own>` on exe.dev hardware, exe.dev stops being special and becomes
§c — with the **material constraint** that its VMs have no dedicated public IP, so wildcard TLS on
our own domain only works if their proxy gains wildcard custom domains **[unverified]**. Until
then: use exe.dev VMs for the native shape above, and use any $5 VPS with a real IP for §c.

---

## c) Generic VMs — the minimal contract and the simplest robust setup

The generalization of (b): "any server you own" fronts `*.p.<domain>` and relays to per-env
upstreams on publishing machines.

### The minimal contract nectar should demand

Five lines. If a server meets them, nectar's `ssh-tunnel` kind works, full stop:

1. **Reachable sshd**, key auth as a dedicated unprivileged user (`nectar-expose`), remote
   forwarding permitted (`AllowTcpForwarding remote` is enough).
2. **One public TCP 443** (and 80 for ACME HTTP-01, or nothing extra if DNS-01) on a dedicated IP.
3. **Wildcard DNS** `*.p.<domain>` → that IP (operator's one-time job; nectar can't and shouldn't).
4. **A TLS-terminating vhost router** that maps `<label>.p.<domain>` → `127.0.0.1:<forwarded-port>`
   (or → the publisher's tailnet serve entry) — installed by the one-time setup script below.
5. **Nothing else.** No docker, no database, no control plane, no agent that phones anywhere.

Everything per-env must be doable by: (i) spawning/killing one local process on the publisher,
and/or (ii) one ssh command writing/removing one file on the VM. That is the whole runtime
contract — it matches nectar's process-and-file worldview (D1, D5) and keeps gc/doctor honest.

### Reverse-tunnel bake-off (why the winner is what it is)

| option | per-env VM state | extra binaries | TLS | maintenance (checked 2026-07-19) | verdict |
|---|---|---|---|---|---|
| **sish** | **none** — the `-R` request names the subdomain | one binary on VM, `ssh` on publisher | certmagic on-demand, or wildcard cert dir | active (last commit 2026-06; pico.sh-sponsored) | **winner: least machinery** |
| **plain `ssh -R` + caddy** | one route file per env | caddy on VM | wildcard via DNS-01 | both bedrock | **winner: least exotic deps** |
| autossh | same as ssh -R | +1 wrapper | — | mature | keepalive only; nectar's PID/gc model makes it redundant (see below) |
| frp (frps+frpc) | none (frpc declares `subdomain`) | frps + per-env frpc + caddy/nginx for TLS | frps needs caddy in front or plugin cert juggling | very active (v0.70.0, 2026-07-11) | robust, but 3 components for sish's 1 |
| rathole | per-env port map (TCP-only, no vhost) | rathole ×2 + nginx/caddy | external | active | strictly more manual than ssh -R; reject |
| boringproxy | API-created domain | server + client | built-in LE | **last commit 2023-05** — effectively dead | reject despite ideal fit |
| pangolin (+gerbil, +traefik, +newt) | dashboard-created resource | 4 services, postgres | built-in LE | very active (YC-backed) | the only self-hosted *identity* gate; heavy; defer |

Two honorable rejections with reasoning: **autossh** exists to restart dead tunnels, but nectar
already owns a lifecycle philosophy — detached PID, lazy liveness, `crashed` is more honest than
silent restarts (D1), gc/doctor repair. A dead tunnel is detected exactly like a dead serve (F3)
and repaired by re-expose. Keep plain `ssh -N -T -o ExitOnForwardFailure=yes -o
ServerAliveInterval=30 -o ServerAliveCountMax=3`; offer autossh later only if flapping proves
noisy. **rathole/frp at TCP level** re-create the port-registry problem ssh already solves.

### nginx vs caddy, and the TLS answer

**Caddy, not nginx.** Decisive practicalities: the admin API on `127.0.0.1:2019` lets the
unprivileged `nectar-expose` user reload config (`caddy reload --config …`) **with no sudoers
line**; `basic_auth` is built in (per-env gate with zero nectar code); it's one static binary.
nginx+certbot needs root hooks, `/etc` writes, and `systemctl reload` privileges for the same
outcome. 

**Wildcard cert via DNS-01, not on-demand TLS.** Caddy's on-demand TLS is tempting (no DNS API
needed) but wrong here: every internet scanner that hits a random `*.p.<domain>` name triggers an
issuance attempt — you'll burn the Let's Encrypt failed-validation rate limit and, without an
`ask` endpoint, issue certs for arbitrary names; with an `ask` endpoint you've just built a
control plane to avoid one DNS token. DNS-01 wildcard is one cert, renewed twice a year-ish, no
per-name traffic sensitivity: put the preview zone on Cloudflare **free DNS** (not proxied — gray
cloud), build caddy once with the `dns.providers.cloudflare` module (`xcaddy`), drop the token in
`/etc/caddy/dns-env` at setup. If the zone is elsewhere, any lego/acme.sh-supported provider works;
the setup script abstracts "renew hook drops `fullchain.pem`+`privkey.pem` in `/etc/sish/ssl` or
caddy's tls line".

### The three flavors (all valid; pick per VM)

**F1 — tailnet-gateway (fewest moving parts of anything in this report).** The relay VM joins the
tailnet (tagged, ACL'd to reach only 8440–8542 on nectar-tagged hosts). Envs are *already* on the
tailnet via `tailscale serve` with real LE certs for `<host>.ts.net`. So exposure is pure VM-side
routing:

```bash
# expose: one ssh command, no process anywhere
ssh nectar-expose@vm 'cat > /etc/caddy/envs/<env>.caddy' <<'EOF'
@<env> host <env>.p.example.com
handle @<env> {
	basic_auth { reviewer <bcrypt-hash> }        # only when gate=password
	reverse_proxy https://<host>.tailnet.ts.net:8444 {
		transport http { tls_server_name <host>.tailnet.ts.net }
	}
}
EOF
ssh nectar-expose@vm 'caddy reload --config /etc/caddy/Caddyfile'
# unexpose: rm the file + reload. gc orphan sweep: ls /etc/caddy/envs vs records.
```

Zero publisher processes, zero ports, zero tunnel processes; dead publisher = dead env anyway
(F9). Costs: VM on the tailnet (widen the D9 ACL rule to a *tagged* relay, not "operator
devices"), tailscale-serve must be healthy (F2-degraded envs can't use F1 — fall through to F2
flavor below), and the gate must live in caddy (basic_auth) or in front (§d's CF-fronted nectar.site),
since the nectar-side proxy isn't in this path. **[Verify tailscale serve's upstream TLS behavior
against a second tailnet node during the build spike — expected fine, unverified here.]**

**F2 — ssh -R + caddy route files (VM stays off the tailnet).** Publisher pushes a reverse forward;
caddy maps host → forwarded port. Remote port comes from a per-target range (18100–18199, mirroring
the 100-port tailnet range): `port = range_start + (fnv32(env) % 100)`, `ExitOnForwardFailure`
detects collision, walk forward and retry — no registry needed at our scale.

```bash
# expose
ssh -N -T -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -R 127.0.0.1:18107:127.0.0.1:<gate-port> nectar-expose@vm &    # PID → env record
ssh nectar-expose@vm 'cat > /etc/caddy/envs/<env>.caddy' <<'EOF'  # reverse_proxy 127.0.0.1:18107
ssh nectar-expose@vm 'caddy reload --config /etc/caddy/Caddyfile'
# unexpose: kill -TERM -<pgid>; rm route file; reload. Both idempotent; order irrelevant.
```

**F3 — ssh -R + sish (zero per-env VM state; the sish box is the whole server).** sish is an sshd
that turns remote-forward requests into vhost routes: the `-R` target *names the subdomain*, TLS
and routing are automatic, and **killing the ssh process removes the route instantly** — teardown
is one `kill`, with nothing left behind to orphan.

```bash
# expose: ONE process. unexpose: ONE kill. That is the entire mechanism.
ssh -N -T -o ExitOnForwardFailure=yes -p 2222 \
    -R <envlabel>:443:127.0.0.1:<gate-port> sish@vm &               # PID → env record
# gate=password → the nectar-side password proxy on <gate-port> (sish has no auth itself)
```

sish specifics: run it on :2222 (keep real sshd on 22) with `--domain p.example.com`,
`--https-address :443`, `--https-certificate-directory /etc/sish/ssl` (wildcard cert from the
DNS-01 step above — avoids per-subdomain on-demand issuance and its LE rate limits),
`--authentication-keys-directory /etc/sish/pubkeys` (one throwaway keypair per publishing machine,
generated by `doctor --fix`, pubkey shipped in setup), `--bind-random-subdomains=false`,
`--force-requested-subdomains=true`. Repo is active ([antoniomika/sish](https://github.com/antoniomika/sish),
last commit 2026-06). Risk: single-author project; mitigated by F2 being a drop-in replacement
behind the same target kind.

**Flavor choice:** F1 when the VM may join the tailnet (least machinery); F3 when it may not and
you accept sish; F2 when you want bedrock-only dependencies. All three are the same nectar target
kind (`ssh-tunnel`) with a `flavor` key — the CLI, config, record, gc and gate vocabulary never
change.

### The one-time VM setup script (the whole ops story)

`scripts/` material for the report — run once per VM as root. F2/F1 flavor shown; the sish
variant swaps step 3 for a ~15-line systemd unit.

```bash
#!/usr/bin/env bash
# nectar-expose-vm setup — once per VM. Debian/Ubuntu. Usage:
#   setup.sh p.example.com /path/to/publisher-keys/*.pub
set -euo pipefail
DOMAIN="$1"; shift

apt-get update && apt-get install -y caddy curl
id nectar-expose &>/dev/null || useradd -m -s /usr/sbin/nologin nectar-expose

# 1. publisher keys (one per machine, minted by `nectar doctor --fix`)
install -d -m 700 -o nectar-expose -g nectar-expose /home/nectar-expose/.ssh
for k in "$@"; do cat "$k" >> /home/nectar-expose/.ssh/authorized_keys; done
chmod 600 /home/nectar-expose/.ssh/authorized_keys
chown nectar-expose:nectar-expose /home/nectar-expose/.ssh/authorized_keys

# 2. sshd: forwarding on, everything else off for this user
cat >/etc/ssh/sshd_config.d/60-nectar-expose.conf <<'EOF'
Match User nectar-expose
    AllowTcpForwarding remote
    PermitTTY no
    X11Forwarding no
    PasswordAuthentication no
EOF
systemctl reload ssh

# 3. wildcard cert via DNS-01 (preview zone on Cloudflare free DNS, gray cloud):
#    one-time: xcaddy build --with github.com/caddy-dns/cloudflare  → /usr/bin/caddy
install -d -m 750 -o root -g caddy /etc/caddy/envs
cat >/etc/caddy/dns-env <<'EOF'
CLOUDFLARE_API_TOKEN=paste-at-setup   # from: hem get project/nectar/cf-dns-token
EOF
chmod 640 /etc/caddy/dns-env; chown root:caddy /etc/caddy/dns-env

# 4. router
cat >/etc/caddy/Caddyfile <<EOF
*.${DOMAIN} {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
	}
	import /etc/caddy/envs/*.caddy
	handle { respond 404 }
}
EOF
systemctl enable --now caddy

# 5. reload rights WITHOUT sudo: caddy's admin API is 127.0.0.1:2019;
#    `caddy reload` as any local user talks to it. Nothing to do — that's the point of caddy.
echo "done. test: ssh nectar-expose@$(hostname) 'caddy reload --config /etc/caddy/Caddyfile'"
```

The sish variant of step 3–4: drop the wildcard cert into `/etc/sish/ssl/` via the same DNS-01
mechanism (lego one-shot + renew timer), then:

```ini
# /etc/systemd/system/sish.service
[Unit]
Description=sish nectar exposure router
After=network-online.target
[Service]
ExecStart=/usr/local/bin/sish \
  --ssh-address=:2222 --https-address=:443 --http-address=:80 \
  --domain=p.example.com --https=true \
  --https-certificate-directory=/etc/sish/ssl \
  --authentication-keys-directory=/etc/sish/pubkeys \
  --bind-random-subdomains=false --force-requested-subdomains=true \
  --cleanup-unauthed=true
Restart=always
RestartSec=2
User=sish
AmbientCapabilities=CAP_NET_BIND_SERVICE
[Install]
WantedBy=multi-user.target
```

Publisher side needs **no systemd at all** — tunnel processes are nectar children with PIDs in
env records, exactly like serves (D1); gc reaps them; doctor reports them.

### What nectar shells, per verb (complete list — this is the whole build)

| verb | F1 (tailnet-gw) | F2 (ssh-R + caddy) | F3 (sish) |
|---|---|---|---|
| expose | 2 ssh cmds (write route, reload) | spawn `ssh -R`; 2 ssh cmds | spawn `ssh -R` |
| unexpose / gc-expire | 1 ssh cmd (rm+reload) | kill pgid; 1 ssh cmd | kill pgid |
| doctor | ssh reachable; caddy ok; routes ↔ records; tailnet ACL reminder | + remote ports free; dead-pid sweep | + sish :2222 reachable; cert expiry >14 d |
| drop --to vm | `rsync -a packs/.drops/<id>/ vm:/var/www/drops/<id>/` + reload-once static route | same | same (one static route in Caddyfile) |

### Failure modes (target-level; all leave the tailnet surface untouched)

VM down/unreachable → `E_EXPOSE` at expose; already-exposed envs 502 until VM returns (route
files persist, tunnels reconnect via nectar re-expose on next resolve — doctor surfaces
"tunnel dead" per record). Cert renewal failure → caddy/sish keep serving the old cert until
expiry; doctor warns at <14 days (DNS-01 token rot is the classic cause). Remote-port exhaustion
(100 concurrent on one VM) → `E_PORTS`-style error, raise range. Publisher dies mid-exposure →
F1: route 502s, orphan sweep prunes; F2/F3: forward dies with the machine, sish route vanishes
instantly, caddy route 502s until swept. Route file edited by hand → records win; sweep rewrites.

**Effort:** F2 ≈ 2.5–3 days (route templates, port allocator, ssh runner with retries, doctor,
tests); F3 ≈ 2 days (no route management at all — the savings are real); F1 adds ~0.5 day to F2
(the tailscale upstream variant). **Ops burden:** one $5 VM, `unattended-upgrades`, and a cert
renewal you never think about unless the DNS token rots. Call it an hour a year.

---

## d) A managed nectar.site — should we build it?

Reframe: **nectar.site is not a fourth mechanism. It is the second target (§c) given a nice
domain and one canonical VM.** `<env>.nectar.site` = wildcard DNS (one-time) + the setup script
above on one VM + every publishing machine carrying a `"site": { "kind": "ssh-tunnel", "host":
"relay.nectar.site", "domain": "nectar.site", … }` entry. Many publishing machines are free: each
brings its own ssh keypair and its own forwards; the VM is a dumb rendezvous.

**The CF-fronted variant makes it better and cheaper to run.** Put the `nectar.site` zone on
Cloudflare free, orange-cloud the wildcard A record, and point it at the relay VM:

- TLS moves to CF's edge (no cert machinery on the VM at all — caddy/sish can serve plain :80 to
  CF-only source IPs);
- **the gate becomes Cloudflare Access** (email OTP, ≤50 users free) — the best gate from §a,
  protecting the self-hosted path with zero nectar code;
- VM firewall = allow 80/443 from CF IP ranges only; ssh from the tailnet only. The VM becomes
  nearly disposable.

That variant literally merges (a) and (c): CF owns edge+gate, our VM owns routing, publishers own
envs. (And CF Access in front of a wildcard hostname is the standard pattern — the same wildcard
caveat as §a applies: first-level `*.nectar.site` is covered free, which a dedicated zone
guarantees.)

**Should we build it? Yes — but as an ops task after the ssh-tunnel kind ships, not as a product.**
Cost: $10/yr domain + ~$5/mo VM + the setup script. Payoff: one uniform
`packet_fields.public_url` shape for the whole fleet regardless of publisher; a canonical place
for client-facing links (exe.xyz never ships to a client; `*.trmdpreview.com`/`*.nectar.site`
can); drops get `drops.nectar.site/<id>` via rsync for free. **Does it subsume (a)–(c)?** (b) yes —
you stop needing exe.dev boxes for exposure; (c) yes — it *is* (c), operated once by us instead of
per-operator; (a) no — cloudflare-tunnel remains the zero-VM option and the stronger standalone
gate; keep both. Team-size scaling: fine to dozens of publishers (a relay VM forwards bytes; 100
envs ≈ nothing for a $5 box), and when it isn't, "shard by second VM" is the same setup script
again. Failure blast radius: one VM down = all public previews 502 while tailnet previews are
untouched — acceptable for ephemeral review links, and the honest posture (F9-style) is already
the desk's UX.

---

## 8. Ranking and the one first target

Ease = least code + least ops + least credentials, weighted by robustness of what you get:

1. **cloudflare-tunnel** — no VM, best-in-class gate (Access OTP works from a phone with zero
   install), one API token, per-env work is one API call. Only real cost: the second-level
   wildcard gotcha (solved by a dedicated zone) and traffic transiting CF.
2. **ssh-tunnel (sish flavor)** — one binary server-side, one process client-side, instant
   teardown, zero third party; unlocks (b)-as-generic-VM and (d) for free.
3. **exe.dev-native** — least raw code and zero new credentials, but dev-preview provider risk on
   reviewer-facing URLs; a splendid third target precisely because it's cheap.
4. **ssh-tunnel (caddy flavors)** — bedrock deps, slightly more per-env machinery than sish.
5. frp / 6. pangolin / 7. boringproxy / 8. rathole+nginx / 9. trycloudflare — see tables above.

**Recommendation: build `cloudflare-tunnel` first, exactly as D19 sequenced it — with the
dedicated-zone correction and remote-managed (token) tunnels — then build `ssh-tunnel` with the
sish flavor immediately after.** Reasoning: (i) measured strictly on ease, CF wins on ops (none)
and credentials (one token), and its gate is the only one that's pleasant for the exact user
`expose` exists for — someone off the tailnet, often on a phone; (ii) research found no blocker,
only the cert gotcha, which a $10/yr zone fixes and which doubles as the nectar.site foundation;
(iii) the ssh-tunnel kind is the strategic center (one code path subsumes exe.dev-as-VM, generic
VMs, and nectar.site), so it must exist regardless — but it carries a VM to babysit, so it should
be second, not first; (iv) if the team's ruling principle is "no third party terminates our
preview traffic" (a defensible reading of why funnel stays forbidden), invert the order — sish
first costs roughly one extra day and cedes the Access-grade gate to caddy basic_auth / the
nectar password proxy.

### Open uncertainties to close during the build spike

- Access wildcard applications (`*.zone`) — documented, verify in dashboard at setup.
- `tailscale serve` upstream TLS from a *second* tailnet node as caddy's backend (F1) — expected
  fine, untested.
- exe.dev custom-domain/wildcard support and share-port semantics — docs are thin; treat
  exe.dev-native as one-hostname-per-VM until proven otherwise.
- Cloudflare API token minimum permission set for remote-managed tunnel config edits — start with
  Account Tunnel:Edit + Zone DNS:Edit, narrow later.
- Whether CF orange-clouding a wildcard A record on the free plan behaves identically to named
  records for (d)'s fronted variant — believed yes on current docs; verify at setup.
