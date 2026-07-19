# Future: nectar for users who aren't on the operator's tailnet

*2026-07-20 · design memo, nothing built. The v0.2 exposure design (V0.2 §5, D21)
assumes every publisher and the relay share one tailnet. This memo works out what a
future looks like when they don't — external teams using nectar without joining the
operator's tailnet — and how much of it is worth building, when.*

## 1. What the tailnet is quietly doing today

Three load-bearing assumptions, all "the tailnet handles it":

1. **Relay control** — `nectar expose` runs `tailscale ssh <relay> nectar-relay …`.
   That needs tailnet membership *and* effectively-root on the relay. An outside user
   has neither and must never have either.
2. **The data path** — the relay reverse-proxies `<sub>.nctr.site` to the publisher's
   `https://<host>.ts.net:8444`. That URL is only reachable *from inside the tailnet*.
   An off-tailnet publisher has no such address; the relay cannot reach them at all.
3. **Refs & resolution** — `nectar://<host>/<env>` resolves via `tailscale ssh <host>
   nectar …`, and cross-machine testpack fetch pulls from the publisher's tailnet-only
   `:8440` pack server (SPEC §4, D4). Both are tailnet round-trips.

The v0.2 relay is genuinely *better* than a tunnel **for the operator** precisely
because the tailnet already solved connectivity (D21). Take the tailnet away and every
one of these has to be re-solved — and the honest shape of the answer is: the thing D21
deliberately avoided (a tunnel) comes back as the primary mechanism for outside users.

## 2. The core inversion: pull → dial-out

On the tailnet, the relay **pulls** from the publisher (it can reach the mesh URL).
Off-tailnet, the publisher is behind NAT with no inbound path, so the publisher must
**dial out** to nctr.site and hold a persistent tunnel; public traffic to
`<sub>.nctr.site` then flows *down* that tunnel to the publisher's local dev server.

```
tailnet publisher (today):    relay  ──pull──►  publisher.ts.net:8444
cloud tenant (future):        edge   ◄─dial──   nectar-agent → 127.0.0.1:<port>
                              edge   ──push──►  down the held tunnel
```

This is exactly the tunnel model the research panel ranked *below* the relay for the
operator (frp/sish/cloudflared). It was the wrong tool when connectivity was free; it
is the *right* tool when it isn't. So nctr.site-as-a-service is, at its core: **run our
own tunnel ingress + a control API + accounts.** Nothing exotic — but a real service.

## 3. Registration & auth without ssh

Replace "ssh to the relay as root" with an **authenticated HTTPS control API** on
nctr.site:

- `nectar login` — device-code or OAuth flow against `auth.nctr.site`; mints a
  per-user/per-machine **account token**, stored in the OS keychain (or
  `~/.nectar/credentials.json`, 0600). This is the credential the operator's tailnet
  model didn't need at all.
- `nectar expose --to cloud` — `POST https://api.nctr.site/v1/routes` with the bearer
  token: `{ sub, tunnel_id, gate, expires_at }`. The control plane authorizes (is this
  token allowed this subdomain? under quota?) and wires the edge. No ssh, no root, works
  from any network.
- `unexpose` → `DELETE /v1/routes/<id>`; gc-on-expiry → the same, plus a server-side TTL
  sweep (the relay's `prune`, now a control-plane cron).

The `exposures` machine-config abstraction already supports this cleanly — it becomes a
new **kind: `nctr-cloud`** beside `relay`:

```jsonc
"exposures": {
  "site":  { "kind": "relay",      "host": "trmd-vps01", "domain": "nctr.site" },  // operator, tailnet
  "cloud": { "kind": "nctr-cloud", "api": "https://api.nctr.site" }               // anyone, off-tailnet
}
```

Same `nectar expose` UX; the kind decides control-plane-API vs tailscale-ssh. The
operator keeps using `relay` (free, private, faster); tenants use `nctr-cloud`.

## 4. The data path & the testpack problem

- **web** — the `nectar-agent` (a small bundled binary, or `nectar expose --agent`
  foregrounded) holds the tunnel from `127.0.0.1:<upstream_port>` to the edge. Options
  in rough order of build cost: embed an existing client (**frp/sish** — we run the
  server; cloudflared — Cloudflare runs it, we lose control and gate story), or a
  purpose-built WebSocket/QUIC agent. Start by running **sish** (one server binary,
  plain-ssh clients) — the panel already vetted it as the non-tailnet fallback.
- **desktop / ios testpacks** — harder. Cross-machine fetch today pulls from the
  publisher's tailnet `:8440`. Off-tailnet there's no inbound path to that server, so
  the pack must be **pushed to nctr.site object storage** at publish time and served
  from the edge. This is the **`drop` mechanism (V0.2 §4) generalized** to authenticated
  per-tenant uploads — a real reason to build drops-with-a-cloud-target first, since it's
  the same primitive. The sha256 verify story (F8) is unchanged; only the origin moves.
- **cli / backend** — cli shell would need an authenticated relayed PTY (much later);
  backend has no surface, so it's evidence-only regardless — unaffected.

## 5. Multi-tenancy: what "accounts" actually drags in

The operator model has exactly one tenant (the operator) and stores routes as files
with no database (D5/D21). Real multi-tenancy needs, at minimum:

- **A datastore** — accounts, tokens, tunnels, routes, usage. The file-per-route
  simplicity ends here; this is Postgres/SQLite-on-the-edge territory.
- **Namespacing** — flat `<sub>.nctr.site` invites collisions and lets one tenant guess
  another's URLs. Prefer `<sub>.<account>.nctr.site` (needs a **second-level wildcard
  cert** — `*.*.nctr.site` isn't covered by one DNS-01 wildcard; either per-account
  certs via on-demand TLS, or a wildcard-of-wildcards which Let's Encrypt won't issue →
  on-demand per-account). This is a concrete, non-obvious cost.
- **Quotas & isolation** — routes per account, bandwidth, concurrent tunnels, max TTL;
  a tenant may only route to *their own* tunnels; gate-by-default enforced server-side
  (a tenant can't accidentally expose ungated).
- **Abuse & content liability** — this is the big new one. The operator model routes
  only the operator's own traffic. A public `*.nctr.site` that anyone can publish to is
  an open door to phishing/malware/illegal-content hosting under *our* domain and IP.
  That means abuse reporting, takedown tooling, rate limits, maybe KYC-lite. This burden
  dwarfs the technical build and is the real reason "should we build it" is a *business*
  question, not an engineering one.
- **What it does NOT drag in:** nctr.site never executes tenant code — the publisher
  runs their own branch on their own machine, exactly as today (§9.3). The edge only
  moves bytes. So there's no new sandboxing problem; the trust boundary is unchanged.
  That's the one thing that stays easy.

## 6. Component inventory (if built) and what it costs to run

| component | role | build | ops |
| --- | --- | --- | --- |
| edge/ingress | TLS for `*.nctr.site` (+per-account), accept tunnels, route by sub | med | uptime-critical, abuse target |
| control API | auth, route CRUD, quotas, TTL sweep | med | standard web service |
| datastore | accounts/tokens/tunnels/routes/usage | low | backups |
| `nectar-agent` | bundled dial-out tunnel client | med (or low if we wrap sish) | shipped in the CLI |
| object storage | testpack/drop origin for off-tailnet fetch | low | egress cost |
| accounts/billing/abuse | signup, tokens, takedowns | **high (mostly non-code)** | ongoing human load |

This is a product, not a feature. Realistic first-credible-version: **weeks, not days**
(the panel's codex estimate of 10–20 engineer-days for the control plane alone still
holds), plus indefinite ops/abuse/support.

## 7. Recommendation

1. **Keep the tailnet relay as the operator's permanent path.** It is strictly better
   for us — free, private, faster, no accounts, no datastore, no abuse surface. Nothing
   about a cloud offering should degrade it. The `exposures` kinds coexist.
2. **Don't build the multi-tenant cloud until there's a real external user pulling for
   it.** It converts nctr.site from "a domain + a VM" into a SaaS with a datastore,
   uptime obligations, and content-liability exposure. That's a deliberate business
   decision, not a natural next commit.
3. **When/if pursued, the cheapest honest MVP** is: `nctr-cloud` exposure kind → run
   **sish** on a bigger nctr.site box (tunnels for web) + a tiny control API with
   account tokens + flat namespacing with an unguessable suffix (defer per-account
   wildcards) + push testpacks to object storage via the generalized `drop`. That reuses
   the most existing surface (`exposures` config, `expose`/`unexpose` verbs, the drop
   primitive, the gate) and defers the expensive parts (per-account certs, billing,
   abuse tooling) until they're forced.
4. **Two things to do now, cheaply, that keep the door open:** (a) the `exposures`
   config already models multiple kinds — keep new exposure work behind that seam so
   `nctr-cloud` slots in without a rewrite; (b) build **`drop` with a cloud-storage
   target** as part of v0.2 anyway (V0.2 §4/§5), because it's the same push-to-origin
   primitive the tenant testpack path needs, and it's useful to the operator immediately.

## 8. One-line summary

Off-tailnet nectar re-introduces the tunnel the operator's tailnet let us skip, behind
an authenticated control API and real accounts; it's a genuine SaaS whose hardest parts
are abuse-moderation and per-account TLS, not the routing — so keep the tailnet relay as
the house path, model it as a coexisting `nctr-cloud` kind, and build only when a real
outside user asks.
