# Future: productizing nectar — three tiers

*2026-07-20 · product/architecture memo, nothing built. Companion to
[FUTURE-nctr-cloud.md](FUTURE-nctr-cloud.md), which works out the off-tailnet mechanics.
This memo frames the offering: what we run, what others self-host, and what we sell.*

The relay we built for our own tailnet (D21) turns out to be the middle rung of a ladder.
Three tiers, one CLI, one `exposures` config abstraction:

| tier | who runs it | data path | reach | cost model |
| --- | --- | --- | --- | --- |
| **1 · operator** (built) | us | relay pulls the publisher's tailnet mesh URL | our tailnet only | free (a VM + a domain) |
| **2 · BYO-domain** (DIY, OSS) | the user | same relay, their VM + their `<domain>.site` | their tailnet / their team | free (they pay VM + domain) |
| **3 · hosted** (SaaS) | us, on Cloudflare | tenant dials out via a managed tunnel | anyone, off any tailnet | paid, usage-metered |

Same `nectar expose --to <target>`; the target's `kind` picks the tier. Nothing about the
CLI changes across tiers — that's the whole point of having built it behind `exposures`.

## Tier 2 — "set up your own `<domain>.site`" (nearly already done)

This is the strongest near-term move because it costs almost nothing to create: **the
relay is already ~90% domain-agnostic.** `nectar-relay` reads `NECTAR_RELAY_DOMAIN`
(defaults to our domain) and `NECTAR_RELAY_ROUTES`; only `Caddyfile.nctr`'s literal
`*.<domain>` block and `install.sh` carry hardcoded names. Making it BYO is:

- Templatize the wildcard domain in the Caddy block + installer (one variable).
- `nectar relay install <domain>` — one command a user runs on any public-IP VM they
  own: installs Caddy-with-cloudflare-dns, `nectar-relay`, the prune cron, and prints the
  two things they must do (a `*.<domain> A <ip>` record + a scoped DNS token).
- Ship `relay/` as an open-source, self-contained subtree (or its own repo).

**Why do it:** it's a credibility + funnel play. Someone runs their own
`preview.theircompany.com`, hits the ops reality (a VM to babysit, a tailnet or tunnel to
wire, DNS to manage), and a chunk of them convert to Tier 3 to make that disappear. OSS
the DIY tier, sell the "we run it" tier. The DIY user is Tier 1 with a different domain —
`exposures.kind` stays `relay`; only `host`/`domain` differ.

**The catch for non-tailnet DIY users:** if the DIY user's publishers aren't on a tailnet
the relay can reach, they hit the FUTURE-nctr-cloud §2 problem (relay can't pull) and need
a tunnel — which is exactly Tier 3's mechanism. So DIY is cleanest for a team that already
runs a tailnet; a solo/off-tailnet DIY user is really a self-hosted Tier 3.

## Tier 3 — hosted, Cloudflare-native (the scalable one)

Your instinct is right, and it generalizes: **don't just use R2 — go Cloudflare-native
end to end.** For the operator tier we deliberately avoided cloudflared (the tailnet made
a tunnel unnecessary — D21). For a *multi-tenant hosted* product the calculus flips: we
want someone else to run global TLS, DDoS/abuse defense, edge POPs, and storage scaling.
That someone is Cloudflare. Map each nectar concern to a CF primitive:

| nectar concern | Cloudflare primitive | why |
| --- | --- | --- |
| public edge + TLS for `*.<domain>` | Cloudflare proxy + (SaaS custom hostnames for BYO-domain) | global TLS/POPs/DDoS, no ingress VMs of ours |
| **data path** to the publisher's local server | **Cloudflare Tunnel** (managed `cloudflared`, named tunnels via API) | replaces tailnet reachability; CF's core competency; publisher dials out, no inbound |
| **testpacks / drops / evidence origin** | **R2** (S3-compatible, zero egress) | the off-tailnet pack-fetch answer (FUTURE-nctr-cloud §4); publisher PUTs, Workers/Access serve; sha256 verify unchanged |
| routing + auth + gate + control API | **Workers** | route-by-Host, mint/verify tokens, password/Access gate, `POST /routes` — all at the edge |
| accounts / routes / quotas / usage | **D1** (accounts, billing) + **KV** (hot route→tunnel map, edge-cached) | serverless state; KV read-path is edge-fast |
| gated previews (SSO) | **Cloudflare Access** | enterprise gate for free; our own token/basic-auth Worker for lighter cases |
| abuse / content liability | **WAF + rate limiting + bot mgmt** | the big non-code burden (FUTURE-nctr-cloud §5) partly offloaded to CF, but takedowns are still ours |

The shape: a tenant runs `nectar-agent` (a thin wrapper over a named Cloudflare Tunnel);
`nectar expose --to cloud` calls our Worker control API (bearer token from `nectar login`),
which allocates `<sub>.<domain>`, wires the tunnel route, and sets the gate. Web traffic
rides the tunnel; desktop/iOS testpacks are pushed to R2 and served from the edge. No
ingress VM of ours is ever in the path — that is the scalability story, and it's why the
"cheap" in "cheap cloud solution" is achievable: our marginal cost per preview is a bit of
Workers CPU, KV reads, and R2 storage (egress-free), not a fleet of relay boxes.

**The tradeoffs, honestly:**
- **Vendor lock-in to Cloudflare.** Acceptable — the whole value is offloading edge/scale
  ops. A generic-tunnel (sish/frp) fallback keeps a bolt-hole but shouldn't be the default.
- **cloudflared as the tenant agent** is the thing the operator tier avoided; for tenants
  with no shared tailnet it's the *right* tool, and it's managed, not our code.
- **Abuse/liability doesn't go away** — WAF helps, but a public `*.<domain>` anyone can
  publish to still needs takedown tooling and a policy. This stays the real gate on
  "should we sell it," not the engineering.

## Sequencing

1. **Tier 2 first (days).** Parameterize the relay's domain + ship `nectar relay install
   <domain>`; open-source `relay/`. Near-zero cost, immediate credibility, feeds Tier 3.
2. **Validate Tier 3 demand cheaply** before the CF build — FUTURE-nctr-cloud §7's
   sish-on-a-VM + tiny control API is still the right *bootstrap* to prove people will pay,
   with R2 for pack storage from day one (the one CF piece worth adopting immediately).
3. **Go CF-native for scale** once demand is real: Workers + Tunnel + R2 + D1/KV + Access.
   This *supersedes* the sish bootstrap's ingress, not R2 — R2 was right all along.
4. **Gate on policy, not code.** Don't open public signups until abuse/takedown tooling and
   a content policy exist. That's the launch blocker, not the architecture.

## One-line summary

Three tiers off one CLI: run-it-ourselves (built), self-host-your-own-domain (nearly free
— the relay is already domain-agnostic; OSS it as the funnel), and a hosted tier that goes
all-in on Cloudflare — Tunnel for the data path, R2 for pack/drop storage, Workers+D1/KV
for control, Access+WAF for gate and abuse — so our per-preview cost is edge CPU and
egress-free storage, not relay fleets. The architecture is the easy part; the content-abuse
policy is the real launch gate.
