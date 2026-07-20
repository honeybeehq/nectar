# External exposure targets: provider mechanics and the shortest credible path

_Research date: 2026-07-19. Scope: provider mechanics, with Cloudflare deepest. The
provider conclusions below are based on current first-party documentation, not a live
Cloudflare or Vercel account test. Anything that still needs a live-account spike is called
out explicitly._

## Recommendation in one sentence

Build **a remotely managed Cloudflare named tunnel per exposure**, protected by one
pre-created wildcard Cloudflare Access application, as the first real target. It is not the
absolute fewest lines possible—Quick Tunnels are—but it is the smallest option that is
stable, named, gated, teardown-able, supports arbitrary live HTTP applications, and requires
no server operations.

Do not build a nectar.site control plane yet. Put a suitable domain in Cloudflare now and
run the first target under it; that gives the desired `<env>.nectar.site` experience without
prematurely creating a hosted service. Add a control plane only when distributing a
Cloudflare account token and resolving cross-machine name/lease ownership become real
problems.

## Constraints inherited from Nectar

The existing design makes several choices load-bearing:

- `publish` remains tailnet-only. Exposure is an explicit, per-env escalation and failure
  never damages `urls.local` or `urls.mesh`.
- A gate is the default. `none` is valid only with the second acknowledgement `--public`.
- Exposure is machine infrastructure, so configuration belongs in
  `~/.nectar/nectar.json`, not a hostile branch's `nectar.toml`.
- Provider credentials and gate secrets must not enter the env record, envelope, evidence,
  or logs. Hem refs may enter machine config; values may only enter a scrubbed child/API
  request at runtime.
- `unexpose` and `gc` are idempotent. Teardown metadata must survive partial failures so a
  later `gc` can finish the job.
- The thing being exposed is untrusted dev code. It may contain sourcemaps, debug routes,
  weak app auth, and interactive simulator controls. An edge gate is not optional hygiene.
- Tailscale Funnel remains forbidden.

One common record extension is enough for every adapter:

```ts
interface ExposureRecord {
  target: string;
  kind: "cloudflare-tunnel" | "cloudflare-quick" | "ssh-tunnel" |
        "frp-tunnel" | "vercel-deploy";
  gate: "access" | "password" | "none" | "vercel-auth";
  url: string;
  status: "starting" | "serving" | "teardown_pending" | "failed";
  created_at: string;
  expires_at: string;       // never later than the owning env
  pid?: number;
  pgid?: number;
  local_proxy_port?: number;
  provider?: Record<string, string>; // IDs only, never tokens/passwords
  cleanup_errors?: string[];
}
```

Store `exposures[target]` on the env record. The public URL can be copied to
`urls.public`/`packet_fields.public_url`, but the credential cannot. A target should have at
most one active exposure for an env. Republish should keep it only when its local upstream
is still correct; otherwise do an atomic replace and retire the old exposure.

## Ease ranking

This ranks total implementation and operation, not just the shortest demo command.

| Rank | Target/path | New credentials on publisher | Build estimate | Ongoing ops | Important qualification |
| --- | --- | --- | ---: | --- | --- |
| 1 | Cloudflare Quick Tunnel + Nectar password proxy | none (gate password still needed) | 0.5–1 day | almost none | Random URL, no SLA, 200 in-flight requests, **no SSE**; experimental only |
| 2 | Vercel CLI preview, for an already-linked Vercel app | one Vercel token | 1–2 days | very low | Re-deploys rather than exposes; only Vercel-shaped apps; auth/sharing semantics differ |
| 3 | **Cloudflare remote named tunnel per env** | one scoped Cloudflare API token | **2–4 days** | low | Recommended first general target |
| 4 | Existing owned VM using frp + Caddy | one frp token | 2–3 days, plus 0.5–1 day server bootstrap | medium-low | Cleanest owned-server steady state, but installs two daemons |
| 5 | exe.dev/owned VM using OpenSSH `-R` + Caddy helper | an existing SSH identity | 3–4 days, plus 0.5–1 day bootstrap | medium | Fewest new packages; remote route/lease cleanup is the awkward part |
| 6 | Cloudflare Pages direct upload for drops only | one Pages token | 1–2 days | low | Good static publisher, not a live env target; latest-branch deletion semantics are awkward |
| 7 | nectar.site as shared Cloudflare config, no service | same token as rank 3 | 1–2 additional days | low-medium | Delivers the brand now, but shares a powerful token and has no central lease owner |
| 8 | Generalized managed nectar.site control plane | one Nectar publisher credential | 10–20 days for a credible v1 | medium-high | Build only after actual multi-machine/team pressure |

Ranks 1 and 2 are narrower than rank 3. That is why rank 3 should ship first even though a
demo of ranks 1 or 2 is faster.

## A. Cloudflare

### Which Cloudflare product fits

| Mechanism | Live env | Stable custom hostname | Gate | Teardown | Verdict |
| --- | --- | --- | --- | --- | --- |
| Quick Tunnel | yes | no; random `trycloudflare.com` | Nectar password only | kill process | Useful zero-credential escape hatch, not the default |
| Remotely managed named Tunnel | yes | yes | Access or Nectar password | DNS + process + tunnel APIs | **Best fit** |
| Locally managed named Tunnel | yes | yes | Access or Nectar password | DNS + process + tunnel APIs/files | More local credential-file handling; no advantage here |
| Pages | static output only | Pages URL/branch alias | project-level Access | deployment API, with caveats | Good possible `drop` adapter, wrong for live previews |
| Worker | could proxy, with a route table | yes | Access or Worker auth | script/route/data cleanup | Adds a control/data plane and request limits; save for nectar.site |

Cloudflare recommends remotely managed tunnels for most uses. Their configuration lives at
Cloudflare and can be managed by API; Quick and locally managed tunnels are explicitly
alternative/testing workflows. See [Cloudflare's tunnel type guidance](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/).

### The minimal production-shaped integration

Use one ephemeral, remotely managed named tunnel **per exposed env**, not one tunnel per
machine in v1.

That sounds more object-heavy, but it removes three harder pieces:

1. no permanently installed `cloudflared` service;
2. no local hostname-routing daemon shared by envs;
3. no concurrent read-modify-write of one tunnel's ingress array.

Each exposure owns exactly one Cloudflare tunnel, one connector process, and one DNS record.
The tunnel points directly at the env's healthy loopback origin, or at its small Nectar
password proxy. The env lock already serializes the whole lifecycle. At present scale, a
few extra `cloudflared` processes and tunnel objects are a much better trade than shared
mutable infrastructure.

A persistent named tunnel per machine becomes attractive later. Configure one wildcard
ingress to a permanent local gateway, then create only a DNS record per env. However, that
requires a daemon that routes `Host` to live env records. Editing a shared remote ingress
list instead is a race between independent Nectar CLIs. Also, do **not** run one tunnel's
replicas on unrelated publishing machines: Cloudflare states there is no guarantee which
replica receives a request, so traffic can land on a machine that does not own the env.
[Cloudflare's connector/replica definition](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/tunnel-useful-terms/)
is explicit about this routing behavior.

### Machine config

The minimum target shape should be:

```jsonc
{
  "exposures": {
    "cf": {
      "kind": "cloudflare-tunnel",
      "domain": "nectar.site",
      "account_id": "699d98642c564d2e855e9661899b7252",
      "zone_id": "023e105f4ecef8ad9ca31a8372d0c353",
      "api_token_ref": "project/nectar/cloudflare-expose",
      "default_gate": "access",
      "access": {
        "application_id": "<non-secret UUID>",
        "team_name": "trmd",
        "aud_tag": "<non-secret Access audience>"
      },
      "cloudflared_bin": "cloudflared"
    }
  }
}
```

`account_id`, `zone_id`, application ID, team name, and audience are identifiers, not
secrets. Keeping them explicit removes the need for Account Read or Zone Read permissions.
`api_token_ref` is resolved with `hem get project/nectar/cloudflare-expose` at exposure and
teardown time. The raw value is never persisted.

If Hem returns pending approval, `expose` stops before any provider mutation and returns the
human approval instructions; it must not automate `hem approve`. During teardown, an
unavailable token leaves the provider IDs in `teardown_pending` so an approved later `gc`
can retry.

The API token needs only:

- Account / **Cloudflare Tunnel / Edit** (the API currently also calls this Cloudflare
  Tunnel Write or Cloudflare One Connector: cloudflared Write); restricted to the one
  account.
- Zone / **DNS / Edit**; restricted to the dedicated preview zone.

Those are the two scopes in Cloudflare's current
[API tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/).
Do not use the global API key and do not run `cloudflared login`; its `cert.pem` is broader
and makes non-interactive ownership less clear. The runtime token does not need Access
write permission because the Access application is created once, out of band.

Use a dedicated zone if possible. A token that can edit DNS in `nectar.site` is still
powerful, but its blast radius is bounded to disposable previews. Cloudflare's newer
resource-scoped tunnel permissions do not solve initial creation: the env tunnel does not
exist when the API token is minted.

### One-time Access and domain setup

Before any exposure can become routable:

1. Put the zone on Cloudflare and leave Universal SSL enabled.
2. Create one self-hosted Access application whose public destination is
   `*.nectar.site` (or `*.<configured domain>`).
3. Attach an Allow policy for the team. For outside reviewers, use an explicit email
   allowlist/domain plus the one-time PIN login method, rather than `Everyone`.
4. Save its application ID, team name, and audience in machine config.

This is deliberately a dashboard/Terraform bootstrap, not code in `nectar expose`. It
avoids giving every publishing machine `Access: Apps and Policies Write`, and guarantees a
gate exists **before** the first DNS record is created. Cloudflare also recommends creating
the Access application before publishing the tunnel route because otherwise the hostname
is public. See [the self-hosted application guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

If this bootstrap is later automated, use a separate operator token with `Access: Apps and
Policies Write`; do not add that scope to the runtime token. The current API uses
`POST /accounts/{account_id}/access/policies` for a reusable allow policy and
`POST /accounts/{account_id}/access/apps` for the wildcard self-hosted application. The API
recently moved from `self_hosted_domains` to `destinations`, so its exact create payload
should be captured from a live-account spike rather than frozen into Nectar now.

### Hostname and certificate mechanics

Derive a single DNS label, not a nested machine/app/branch hierarchy:

```text
<dns-slug(env.name)>-<eid>.nectar.site
```

Keep it at most 63 characters by truncating the readable prefix before adding `eid`. The
eid suffix prevents normal cross-machine collisions. For an eventual managed service that
promises literally `<env>.nectar.site`, the control plane must atomically reserve that
name; local records cannot provide global ownership.

The single-label rule matters. In a normal full Cloudflare zone, Universal SSL covers the
apex and first-level subdomains, but not deeper names. Thus
`env.preview.example.com` is **not** automatically covered merely because `example.com` is on
Cloudflare; it needs Advanced Certificate Manager/Total TLS, an uploaded certificate, or a
separately delegated child-zone arrangement. `<env>.nectar.site` is covered by the normal
wildcard. See [Universal SSL hostname coverage](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

Create an exact proxied CNAME per env. Do not rely only on a wildcard DNS record: exact
records let different publishing machines/tunnels own different envs, and deleting the
record is the fastest explicit revocation. Creation must fail on a pre-existing name unless
the stored DNS record ID proves Nectar already owns it. Never overwrite an unrelated record.

### Exact `expose` sequence and API calls

Assume these local values after normal env resolution:

```text
ENV=acme--agent-coupons-stack--web
EID=e7f3
HOSTNAME=acme--agent-coupons-stack--web-e7f3.nectar.site
ORIGIN=http://127.0.0.1:4117
TUNNEL_NAME=nectar-builder-1-e7f3
```

Nectar performs the following under the env lock.

1. Resolve the Hem token into a private in-memory value. Check `cloudflared --version` and
   require at least 2025.4.0 if using `--token-file`.
2. Establish the gate **before** making a public route:
   - `access`: use `ORIGIN` directly; the wildcard Access app already exists.
   - `password`: allocate another loopback port and start Nectar's basic-auth reverse proxy
     there; use that URL as `SERVICE`.
   - `none`: reject unless `--public` is present; use `ORIGIN` directly.
3. Create the remotely managed tunnel:

```bash
curl --fail-with-body \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"name":"nectar-builder-1-e7f3","config_src":"cloudflare"}'
```

The response currently contains both `result.id` and `result.token`; record only the ID.
The current request/response is documented in
[Create a tunnel with the API](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/).

4. Configure its one ingress rule plus the mandatory catch-all:

```bash
curl --fail-with-body \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  --request PUT \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data @- <<JSON
{
  "config": {
    "ingress": [
      {
        "hostname": "$HOSTNAME",
        "service": "$SERVICE",
        "originRequest": {}
      },
      { "service": "http_status:404" }
    ]
  }
}
JSON
```

For `gate=access`, harden the connector by having `cloudflared` validate the Access JWT as
well as relying on the edge application:

```json
"originRequest": {
  "access": {
    "required": true,
    "teamName": "trmd",
    "audTag": ["<ACCESS_AUD_TAG>"]
  }
}
```

Cloudflare documents these `originRequest.access` fields in its
[Tunnel configuration API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/).
This validation should get a live WebSocket/SPA smoke before being made mandatory, because
an incorrect audience produces an opaque edge/origin failure.

5. Put the returned tunnel token in a mode-0600 temporary file, start the child in its own
   process group, and unlink the file after the connector is healthy:

```bash
cloudflared tunnel --no-autoupdate run --token-file "$TOKEN_FILE"
```

`--token-file` requires cloudflared 2025.4.0 or later. The fallback is the scrubbed
`TUNNEL_TOKEN` environment variable, not a command-line `--token` value visible in process
arguments. Both forms are documented in
[cloudflared run parameters](https://developers.cloudflare.com/tunnel/advanced/run-parameters/).
The token is scoped to running this tunnel, but anyone holding it can run a connector, so
it remains a secret. It is ephemeral runtime material, not a new Hem entry.

6. Poll `GET /accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID` until status is `healthy`, while
   also checking the process is alive. A healthy tunnel reflects connector-to-Cloudflare
   health, not origin health, so also probe the eventual hostname after step 7.
7. Create DNS **last**, so an un-gated/half-configured origin is never briefly published:

```bash
curl --fail-with-body \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  --request POST \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --header "Content-Type: application/json" \
  --data @- <<JSON
{
  "type": "CNAME",
  "name": "$HOSTNAME",
  "content": "$TUNNEL_ID.cfargotunnel.com",
  "proxied": true,
  "ttl": 1,
  "comment": "nectar host=builder-1 env=$ENV eid=$EID expires=$EXPIRES_AT"
}
JSON
```

The create shape and automatic TTL are documented in the
[Cloudflare DNS record API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/).
Save `result.id` as `dns_record_id`.
8. Probe `https://$HOSTNAME/`: Access should produce its authentication redirect, password
   should produce `401` with `WWW-Authenticate`, and public should reach the env readiness
   path. Only now mark the exposure `serving` and emit the URL.

Every API operation needs a deadline, Cloudflare error-array parsing, and a compensating
cleanup. A failure after tunnel creation records the IDs and `teardown_pending`; it does not
erase the evidence needed by `gc`.

### Gate choices

#### Access: default for humans

Cloudflare Access is an identity-aware reverse proxy. It checks every protected request for
a valid `CF_Authorization` cookie/JWT and can use existing IdPs or one-time email login.
One wildcard app matches exactly one subdomain level, so `*.nectar.site` covers the proposed
URL grammar but not the apex or `foo.bar.nectar.site`. See
[Access wildcard matching](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
and [authorization cookies](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/).

This is the best human gate: individual identity, revocation, and no shared preview
password. It has two UX caveats:

- an Access login cookie on the preview domain is third-party when the preview is embedded
  in an Apiary iframe; Safari/private modes may block it. External previews should open in
  a top-level tab unless an iframe smoke proves the exact browser flow;
- wildcard applications cannot receive preemptive cookies for every possible subdomain,
  so the first visit to each concrete env performs an authentication redirect.

#### Service Auth: automation only

An Access Service Auth policy validates a service token or mTLS without interactive IdP
login. It is appropriate for an external test runner, webhook, or monitoring probe. It is
not a replacement for human access: it gives the reviewer another secret and browsers do
not naturally send `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers. Cloudflare's
[policy documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
requires the Service Auth action for service-token selectors.

Do not implement this in v1. If it becomes necessary, store the service token ID/secret in
separate Hem refs and let the automated consumer resolve them; never append them to a URL.

#### Nectar password proxy: portable fallback

For clients who cannot join the Access identity policy, run the already-planned tiny local
proxy in front of the real origin. It should:

- listen only on `127.0.0.1`/`::1`;
- require HTTP Basic Auth on every request, including WebSocket upgrades;
- compare a memory-hard or HMAC'd verifier in constant time;
- preserve `Host`, upgrade headers, streaming, and response bodies; add correct
  `Forwarded`/`X-Forwarded-Proto: https` metadata;
- emit no credential-bearing logs.

Prefer `--password-ref project/nectar/reviewer-password` or `--password-stdin` over a
literal command-line value. A target may declare `password_ref` as its default. The proxy
needs only a verifier in memory; the raw password and verifier do not belong in the env
record. If the process crashes, the exposure is honestly down rather than silently
restarted without its secret.

Basic Auth is shared-secret auth, browser dialogs are mediocre, iframe behavior is uneven,
and it provides no per-reviewer revocation. Its virtue is uniformity: it works behind
Cloudflare Quick/Named and the VM transports.

### TTL and teardown APIs

`unexpose` and the expiry phase of `gc` use this order:

1. Delete the DNS record first, closing the normal public entry point:

```bash
curl --fail-with-body \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$DNS_RECORD_ID" \
  --request DELETE \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

2. Terminate the `cloudflared` process group and local auth proxy. Wait, then force-kill
   using the same bounded process-group policy as normal serves.
3. Delete the tunnel:

```bash
curl --fail-with-body \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID" \
  --request DELETE \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

The current endpoints are documented by Cloudflare for
[DNS deletion](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/delete/)
and [Tunnel deletion](https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/delete/).
Cloudflare can keep disconnected connector entries visible for several minutes. If tunnel
deletion reports active/stale connections, retry after
`DELETE /accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/connections`, the documented connection
cleanup endpoint, then retry on later `gc`.
4. Clear the exposure only after DNS and tunnel deletion both succeed or return not-found.
   Otherwise retain it as `teardown_pending` with sanitized errors. All deletes are
   idempotent from Nectar's perspective.

The exposure always inherits the env's current expiry. A local `touch` that extends the env
updates the stored exposure expiry too; a future remote lease service also receives a
bounded lease renewal. Exposure must never extend an already-expired env.

Local process death immediately removes the data path, but it does not delete Cloudflare
objects. If the entire publishing machine disappears before local `gc`, DNS remains and
visitors see a Cloudflare tunnel error rather than branch content. For a small team, a
second machine can periodically list `nectar-*` tunnels and DNS comments and reconcile
expired objects. A strict hosted TTL promise requires the central sweeper described under
nectar.site; DNS itself has no lease/auto-expiry primitive here.

### Cloudflare failure modes

| Failure | User-visible result | Required behavior |
| --- | --- | --- |
| Hem approval/token unavailable | no exposure created | `E_EXPOSE`; leave mesh surface alone |
| Tunnel API succeeds, config/DNS fails | unused Cloudflare object | retain ID, compensate, or mark `teardown_pending` |
| Connector cannot egress on port 7844 | tunnel down | Cloudflare uses QUIC/HTTP2 on TCP/UDP 7844; report preflight hint |
| `healthy` tunnel, dead local origin | Cloudflare 502 | probe origin and public readiness separately |
| DNS name collision | create fails | never overwrite a record not proven to be this exposure |
| Wrong Access audience/team | login succeeds but connector rejects | doctor/config error; live-account test `originRequest.access` |
| Access cookie blocked in iframe | redirect loop/login failure | open top-level; document browser exception; do not weaken gate |
| Dev server rejects public `Host` or emits local redirects | 4xx/broken navigation | report app incompatibility; optionally configure safe host rewrite later |
| WebSocket/HMR fails | page renders but live features fail | acceptance test WebSocket upgrade through gate+tunnel |
| Machine dies | Cloudflare 1033/down, stale DNS/tunnel | independent reconciliation for hosted service; local gc on return |
| API deletion is temporarily inconsistent | stale provider object | retry with backoff; IDs remain in record |
| Provider outage/account suspension | public URL down | mesh URL remains canonical and healthy |

Cloudflare states that tunnel status only measures the connector, not the origin, and
documents 1033/502-style failures in its
[tunnel troubleshooting guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/).

### Quick Tunnels: the literal easiest path

Quick Tunnels need only the binary and a loopback service:

```bash
cloudflared tunnel --url http://127.0.0.1:47831
```

Start Nectar's password proxy on `47831` first, capture the generated
`https://<random>.trycloudflare.com` URL from cloudflared output, and supervise the process
under the env record. Use an isolated HOME/config directory so a user's existing
`~/.cloudflared/config.yaml` cannot disable Quick Tunnel mode. Teardown is just process-group
termination. No Cloudflare account, DNS, API token, or cert handling exists.

This should be an explicitly experimental target:

```jsonc
"cf-quick": {
  "kind": "cloudflare-quick",
  "default_gate": "password",
  "cloudflared_bin": "cloudflared"
}
```

Cloudflare says Quick Tunnels are testing/development-only, have no SLA, allow at most 200
concurrent in-flight requests, do not support Server-Sent Events, and conflict with a
present `.cloudflared/config.yaml`. See [Quick Tunnel limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).
No SSE means Nectar's `/ax` stream is definitely incompatible. The random URL also breaks
the stable-reference feel. `--gate access` must be rejected because Nectar does not control
the `trycloudflare.com` zone.

### Pages and Workers

Neither is the right live-env target.

Pages is attractive for static drops: `wrangler pages deploy <dir> --project-name
nectar-drops --branch <slug>` returns an immutable hash URL and a moving branch alias. A
Pages-scoped API token is narrower than the Tunnel+DNS token, and Pages can put preview
deployments behind Access. Deletion is available through
`npx wrangler pages deployment delete <id> --project-name <project> --force` or
`DELETE /accounts/{account}/pages/projects/{project}/deployments/{id}`. However, current
Pages docs say the latest deployment for a branch cannot be deleted, while force is needed
for aliased deployments. That makes a one-branch-per-drop TTL ambiguous without deploying a
tombstone or deleting a whole project. See
[Pages preview/deletion behavior](https://developers.cloudflare.com/pages/configuration/preview-deployments/)
and the [Pages delete API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/delete/).

Therefore: do not make Pages part of the first exposure adapter. A later `drop --to
cf-pages` can be a separate static-publish feature after a live spike proves that aliases
and the latest branch become genuinely unreachable at teardown.

A Worker could authenticate and proxy all `*.nectar.site` requests using a KV/D1 route
table, but it needs a hidden origin hostname per env, WebSocket/stream proxy handling,
central state, and request-limit/cost reasoning. Worker Custom Domains also do not accept
wildcard DNS records, while Worker Routes need proxied DNS and an external origin. See
[Workers Custom Domain restrictions](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
That is a nectar.site control plane, not the easiest Cloudflare target.

### Cloudflare effort and operations

Estimated implementation: **2–4 engineering days**:

- 0.5 day: config/types/Hem resolution and provider HTTP wrapper;
- 1 day: create/configure/DNS/process lifecycle with rollback;
- 0.5–1 day: Access/password/public gate plumbing and record/envelope integration;
- 0.5–1 day: unit/fixture tests, gc idempotency, doctor checks, live smoke.

Ongoing operations are low: maintain the Cloudflare zone/Access policy and update the
`cloudflared` binary. No inbound firewall, VM, certbot, or permanent connector is required.
The residual burdens are provider dependence, API-token rotation, stale-object
reconciliation after machine loss, and validating plan/limit changes. Current docs were
checked; exact account quotas/pricing were not, because they are plan-specific and more
volatile than the mechanics.

## B. exe.dev servers: treat them as rooted VMs

There is no exe.dev-specific integration worth inventing under the stated assumption. Use
the same owned-server adapter as any other VM. The shortest bootstrap with what is already
present is OpenSSH reverse forwarding plus Caddy.

### One-time server setup

- Point `*.p.example.com` at the VM.
- Open public TCP 80/443 to Caddy and SSH only from the desired networks.
- Run Caddy as the TLS terminator/reverse proxy. For a handful of previews it can obtain an
  exact certificate after a route is registered. For sustained volume, provision one
  wildcard certificate with DNS-01; Caddy requires DNS challenge support for wildcard
  certificates.
- Bind Caddy's admin API to a permissioned Unix socket, never the public interface.
- Install a tiny root-owned `nectar-route` helper callable through narrowly scoped sudo. It
  accepts structured `put <id> <hostname> <loopback-port> <expires-at>`, `rm <id>`, and
  `status <id> --json`; it validates suffix/ID/port, makes a single atomic Caddy API change,
  and stores a lease for a server-side timer to reap.
- Allow remote SSH forwarding, but keep `GatewayPorts no`; Caddy reaches only loopback
  listeners. Pin the SSH host key.

Caddy is easier than nginx here because it has automatic HTTPS and a transactional config
API. Its API supports a unique `@id`, appending a route with `POST`, and deleting it via
`DELETE /id/<id>`. Individual requests are ACID, although multi-request sequences still
need serialization. See [Caddy's config API](https://caddyserver.com/docs/api) and
[automatic HTTPS behavior](https://caddyserver.com/docs/quick-starts/reverse-proxy).
Nginx is fine if the VM already has a wildcard certificate and a safe config-fragment
helper; otherwise certificate issuance plus file/reload coordination is more work.

The route the helper adds is conceptually:

```json
{
  "@id": "nectar-e7f3",
  "match": [{ "host": ["acme-e7f3.p.example.com"] }],
  "handle": [{
    "handler": "reverse_proxy",
    "upstreams": [{ "dial": "127.0.0.1:49152" }]
  }],
  "terminal": true
}
```

### Runtime commands

Use one SSH ControlMaster per exposure so OpenSSH itself atomically allocates a free remote
loopback port:

```bash
ssh -M -S "$CONTROL_SOCKET" -fNT \
  -o ControlPersist=no \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  xe-1

ssh -S "$CONTROL_SOCKET" -O forward \
  -R 127.0.0.1:0:127.0.0.1:$LOCAL_GATE_PORT xe-1
# stdout is the allocated remote port

ssh -S "$CONTROL_SOCKET" xe-1 \
  sudo /usr/local/sbin/nectar-route put \
  nectar-e7f3 acme-e7f3.p.example.com "$REMOTE_PORT" "$EXPIRES_AT"
```

OpenSSH documents that remote port `0` requests dynamic server allocation and that, with
`-O forward`, it prints the chosen port to stdout. Remote listeners bind loopback by
default. See [`ssh -R`](https://man.openbsd.org/ssh.1).

Start Nectar's password proxy first and forward it as `$LOCAL_GATE_PORT`; `none` still
requires `--public`. A future server identity gate could be implemented in Caddy, but that
would stop being the common portable password gate.

Machine config:

```jsonc
"xe": {
  "kind": "ssh-tunnel",
  "host": "xe-1",
  "domain": "p.example.com",
  "route_command": "sudo /usr/local/sbin/nectar-route",
  "identity_ref": null,
  "default_gate": "password"
}
```

The easiest credential story is `identity_ref: null`: use the operator's existing SSH
agent/config and pinned `known_hosts`. Never enable agent forwarding. For unattended
machines that cannot use an agent, `identity_ref` may be
`project/nectar/xe-ssh-key`; write the Hem result to a mode-0600 temporary identity file,
start SSH, then unlink it. The live SSH process has already loaded the key. Do not store the
key in `nectar.json` or pass `StrictHostKeyChecking=no`.

### Teardown, failure, and effort

Delete the Caddy route first, then cancel/exit the control connection and stop the local
password proxy:

```bash
ssh -S "$CONTROL_SOCKET" xe-1 \
  sudo /usr/local/sbin/nectar-route rm nectar-e7f3
ssh -S "$CONTROL_SOCKET" -O exit xe-1
```

The reverse listener disappears when SSH dies, so a publishing-machine crash removes the
data path immediately. The public hostname may still return a 502 until the server-side
lease expires; the route helper's independent timer is needed for true TTL cleanup. If the
VM is unreachable during `unexpose`, kill the local tunnel, retain `teardown_pending`, and
retry the route removal later.

Do not add `autossh` initially. Nectar already owns a detached child and honestly reports
post-publish death. `autossh` introduces a second supervisor and can resurrect an exposure
that Nectar believes dead. OpenSSH keepalives are enough to detect failure. If long-lived
reconnect becomes a requirement, use a single deliberate supervisor, not both.

Build effort is **3–4 days** for the adapter/helper/tests, with **0.5–1 day per first server**
for DNS, Caddy, SSH policy, systemd timer, and smoke testing. Ongoing burden is OS/Caddy/SSH
patching, ACME health, disk/logs, abuse traffic, and backup of the small route lease store.
This is materially more ops than Cloudflare even though the data-plane command is simple.

## C. Generic owned servers

### The minimum contract Nectar should demand

Do not make Nectar know apt, yum, systemd, Caddyfile paths, nginx syntax, or root passwords.
Demand this narrow contract from any pre-provisioned owned server:

1. **Ingress:** HTTPS on a configured domain; arbitrary single-label env hosts resolve to
   it; TLS termination is the server operator's responsibility.
2. **Data channel:** the publishing machine can open an outbound authenticated tunnel to a
   loopback-only endpoint on the server.
3. **Route control:** `put`, `rm`, and `status --json` for an opaque route ID, hostname,
   endpoint, and absolute expiry. Calls are idempotent and `put` refuses foreign ownership.
4. **Lease enforcement:** the server removes expired routes without trusting the publishing
   machine to come back.
5. **Safety:** the public proxy preserves HTTP/WebSocket/streaming semantics, has bounded
   logs, and exposes no generic root/config-writing API to Nectar.

SSH plus `nectar-route` is the least-new-software implementation of that contract. The
contract itself is intentionally not “we have root”; root is a bootstrap privilege, not a
runtime API.

### Better steady-state implementation: frp + Caddy

If more than one owned VM will serve previews, frp removes the custom remote route API and
its stale-route problem. Run `frps` and Caddy on the VM once:

```toml
# frps.toml
bindPort = 7000
proxyBindAddr = "127.0.0.1"
vhostHTTPPort = 8080
subDomainHost = "p.example.com"

[auth]
method = "token"
token = "<server secret>"
```

Caddy terminates `*.p.example.com` and proxies, preserving Host, to
`127.0.0.1:8080`; frps dispatches by subdomain to the right client. Nectar starts one
generated `frpc` process per exposure:

```toml
serverAddr = "relay.example.com"
serverPort = 7000

[auth]
method = "token"
token = "<Hem-resolved token>"

[[proxies]]
name = "nectar-e7f3"
type = "http"
localIP = "127.0.0.1"
localPort = 4117
subdomain = "acme-e7f3"
httpUser = "nectar"
httpPassword = "<review password>"
```

frp natively supports `subDomainHost`, HTTP host routing, client-token auth, per-proxy HTTP
Basic Auth, health checks, and hot reload. Its
[official repository documentation](https://github.com/fatedier/frp) covers each. Killing
`frpc` withdraws its route at `frps`; no SSH route mutation or remote lease file remains.
Nectar writes the generated client config to a mode-0600 temporary file, starts `frpc`, then
unlinks it after startup; the shared frp token and review password never enter the env
record or logs.
Machine config becomes only:

```jsonc
"relay": {
  "kind": "frp-tunnel",
  "server_addr": "relay.example.com",
  "server_port": 7000,
  "domain": "p.example.com",
  "token_ref": "project/nectar/frp-token",
  "default_gate": "password"
}
```

This is the cleanest owned-server endpoint after bootstrap. The trade is installing and
patching `frps` on the VM and `frpc` on every publisher, plus placing one shared claim-any-
subdomain token on publishers. Separate client tokens/policies would be needed for a less
trusted multi-tenant service.

Other alternatives:

- **rathole** is small, secure, and requires per-service tokens, but it is TCP-oriented;
  host routing/TLS still need Caddy, and its own HTTP API is currently described as work in
  progress. Hot-reloading paired client/server configs is more coordination than frp for
  ephemeral envs. [rathole repository](https://github.com/rathole-org/rathole)
- **boringproxy** nicely bundles tunneling, a UI, and automatic HTTPS, but its latest GitHub
  release shown during research is v0.10.0 from January 2023. That maintenance signal is too
  weak for a new security boundary even though its feature shape is attractive.
  [boringproxy repository](https://github.com/boringproxy/boringproxy)
- **nginx** is appropriate when already operated with a wildcard cert and config-fragment
  automation. It is not the least-ops greenfield choice because certificate automation and
  safe reload/route mutation are separate concerns.
- **autossh** improves resurrection, not the initial contract; avoid it until restart is an
  explicit requirement.

Recommendation for (b)/(c): implement the SSH adapter only when an owned-server target is
actually needed, using the exact generic helper contract above. If two servers or regular
high churn appear, switch the implementation behind the same target semantics to frp rather
than making the SSH helper more elaborate.

## Vercel preview deployments

Vercel is the least-code deploy target for a repository that is already a Vercel project.
It is not a tunnel: it rebuilds/uploads the worktree into Vercel's runtime. That is both its
strength (no publishing machine must stay online) and its semantic mismatch with Nectar.

### Minimal mechanics and config

```jsonc
"vercel": {
  "kind": "vercel-deploy",
  "token_ref": "project/nectar/vercel-token",
  "team": "trmd",
  "default_gate": "vercel-auth",
  "projects": {
    "acme": {
      "org_id": "team_...",
      "project_id": "prj_..."
    }
  }
}
```

The project map remains machine infrastructure even though it keys by Nectar app name; the
repo still cannot choose a publishing account/target. Set `VERCEL_ORG_ID` and
`VERCEL_PROJECT_ID` in the scrubbed child environment so Vercel skips `.vercel` project
linking, then run:

```bash
vercel deploy \
  --cwd "$WORKTREE" \
  --yes \
  --target preview \
  --scope trmd \
  --meta nectar_env="$ENV" \
  --meta nectar_eid="$EID" \
  --meta nectar_expires_at="$EXPIRES_AT" \
  --token "$VERCEL_TOKEN"
```

Vercel documents that deployment stdout is always the deployment URL and that `--yes`
answers setup prompts from config/defaults. It now supports selecting a project via
`--project` or `VERCEL_PROJECT_ID`, with `VERCEL_ORG_ID` for CI. See
[Vercel deploy](https://vercel.com/docs/cli/deploy) and
[CLI global project options](https://vercel.com/docs/cli/global-options).

The CLI's documented automation authentication is `--token`, which exposes the token in
the local process argument list. Spawn it without shell interpolation, never log argv, and
accept that same-user local processes can inspect it; or use a private isolated Vercel
global config after a live CLI spike. The token comes from Hem and is never recorded.

If a configured custom domain is desired:

```bash
vercel alias set "$DEPLOYMENT_URL" "$HOSTNAME" --scope trmd --token "$VERCEL_TOKEN"
```

The domain must already belong to the Vercel account/project with correct DNS. For the
fewest moving pieces, emit Vercel's generated deployment URL and skip custom aliasing in
v1.

### Gate and teardown

Enable Standard Protection with Vercel Authentication on the project once. Vercel says it
is available on all plans and protects non-production deployment URLs; team members log in
with Vercel. Password Protection is currently Enterprise or a paid Advanced Deployment
Protection add-on for Pro, so it is not a cheap general replacement for Nectar's password
gate. See [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection)
and [Password Protection availability](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/password-protection).

Shareable links work for external collaborators, but they carry a secret query parameter.
Putting one into `urls.public` or a Forum packet would violate Nectar's secret-free packet
rule. Either keep this target team-only, hand the share link through a separate secret
channel, or do not claim it implements the same gate UX as Cloudflare Access.

At unexpose/expiry, remove a custom alias first if one exists, then delete the deployment:

```bash
vercel alias rm "$HOSTNAME" --yes --scope trmd --token "$VERCEL_TOKEN"
vercel remove "$DEPLOYMENT_URL" --yes --scope trmd --token "$VERCEL_TOKEN"
```

The direct provider deletion is
`DELETE https://api.vercel.com/v13/deployments/<deployment-id>` with a Bearer token. See
[Vercel remove](https://vercel.com/docs/cli/remove) and
[deployment deletion](https://vercel.com/docs/deployments/managing-deployments).
Store deployment URL/ID and alias only. A failed delete remains `teardown_pending` and is
retried by `gc`.

### Mismatches and failures

- Only Vercel-compatible web apps work. iOS streams, arbitrary local daemons, Docker deps,
  and a stateful local preview do not.
- The remote build may not equal the already-running Nectar env. It can use different Node
  versions, build settings, caches, regions, and provider env vars.
- Nectar `[secrets]` are resolved locally and intentionally scrubbed. They do not
  automatically exist in the Vercel project; passing them as CLI `--build-env` arguments
  would create another leakage surface. Projects must have separately managed preview
  env vars.
- Deploy/build queues make expose slower; a deployment can succeed but later fail its
  readiness route.
- Alias/domain collisions must fail closed, never move another env's alias.
- Standard Protection and custom-alias behavior should receive a live smoke; provider
  classification of preview versus production domains has changed over time.

Build effort is **1–2 days** for the generic adapter and tests, but each app has onboarding
and drift cost. Ongoing infrastructure ops are near zero; ongoing provider/project config is
not. Implement it only on demand after Cloudflare, not as the general first target.

## D. Managed `nectar.site`

### The easiest version is configuration, not a service

For the current small team, “managed nectar.site” can be exactly the recommended
Cloudflare target with:

- the `nectar.site` zone on Cloudflare;
- Universal SSL for `*.nectar.site`;
- one wildcard Access application;
- per-env named tunnels and exact CNAMEs;
- the scoped Cloudflare API token in `project/nectar/cloudflare-expose` on each publisher.

That already yields `https://<env>-<eid>.nectar.site`, identity gating, multiple publishing
machines, no inbound ports, and TTL teardown. It costs perhaps **1–2 days beyond the
Cloudflare adapter** for domain/Access setup and operational documentation. Call it a
shared target, not a hosted service.

Its limits are honest: every publisher holds an account/zone mutation token; namespace
claims are first-writer-wins; and if the owning machine never returns, only an external
reconciler clears the lease. These are acceptable for a small trusted fleet, not a public
product.

### What a real managed service requires

Build a control plane only when the limits above hurt. Its minimum API is:

```text
POST   /v1/exposures       {env, eid, machine, gate, expires_at}
       -> {exposure_id, hostname, tunnel_id, one-time_tunnel_token}
DELETE /v1/exposures/:id
POST   /v1/exposures/:id/touch {expires_at}
GET    /v1/exposures/:id
```

The service owns the Cloudflare Tunnel+DNS token. Publishers hold only a narrowly scoped
Nectar publisher credential, preferably one per machine in Hem. It atomically reserves a
single-label hostname, creates the named tunnel/config/DNS through the same calls above,
returns a tunnel token once, and stores only a protected credential/verifier. A scheduled
server-side sweep deletes expired DNS/tunnels even if a Mac is stolen or powered off.
Audit records identify machine/env/eid/publisher and never contain branch-process secrets.

Cloudflare Worker + D1/Durable Objects + a Cron Trigger is a plausible small control plane;
an ordinary tiny service with Postgres is equally valid. Do not put the preview byte stream
through the Worker initially. Let Cloudflare Tunnel remain the data plane and use the
service only for leases and provider mutation. That avoids proxying WebSockets/SSE twice,
Worker request/runtime constraints, and another place that can corrupt application
headers.

The small-team wildcard Access app provides one team-wide policy, not per-env external
reviewer isolation. A real service must either create narrower Access applications/policies
per exposure or own an equivalent invitation/session gate. That gate lifecycle is a major
part of the service estimate, not a DNS detail.

A credible generalizable v1 is **10–20 engineering days**, not a weekend wrapper:

- publisher auth/rotation and rate limits;
- atomic global name ownership and idempotency keys;
- gate policy and external-reviewer invitation lifecycle;
- central expiry/reconciliation and machine-loss recovery;
- abuse controls and audit logs;
- provider error retries, quotas, billing alerts, support, status, and data-retention rules;
- a threat model for Internet-exposed untrusted branch code.

Ongoing burden is medium-high because this becomes security-sensitive shared
infrastructure. Even with Cloudflare doing TLS/tunnels/Access, someone owns incidents,
account compromise, stale resources, reviewer access, and spend.

### Can it subsume the other targets?

- It **is** the productized form of the Cloudflare target and can hide Cloudflare
  credentials from publishers.
- It can subsume the public URL/auth/lease surface of owned VMs if those machines run the
  nectar.site connector. The VMs are then merely optional relay/origin hosts.
- It does **not** inherently subsume Vercel. Vercel rebuilds and hosts the app after the
  publishing machine disappears; a live tunnel preserves the local Nectar env and its
  local deps/state. Those are different products.
- It should not eliminate the generic owned-VM adapter. That adapter is the vendor-
  independent fallback if Cloudflare or the nectar.site account is unavailable.

Verdict: **reserve and use the domain now; do not build the hosted control plane now**.
Measure exposed-env count, distinct publishing machines, stale cleanup incidents, external
reviewer invitations, and Cloudflare-token distribution. Those metrics are the trigger for
the service.

## Suggested implementation order and acceptance

1. Implement the shared exposure record, gate validation, and idempotent teardown contract.
2. Implement `cloudflare-tunnel` exactly as the per-env sequence above.
3. Create the wildcard Access app and run a live acceptance smoke from a non-tailnet phone:
   HTML/assets, redirects, cookies, POST/upload, WebSocket, and an SSE fixture; then expiry
   and repeated `gc`.
4. Test Access in a top-level browser and Apiary iframe. Treat top-level-only as acceptable
   documented degradation rather than weakening the gate.
5. Simulate failures after every Cloudflare mutation and prove `gc` converges without
   touching the mesh surface.
6. Add `cf-quick` only if the zero-credential fallback is valuable enough to expose as an
   explicitly unstable target.
7. Add Vercel or an owned-VM adapter only in response to a concrete app/reviewer need.

The first target's definition of done should include: no credential in argv where an
official file/env mechanism exists; no secret in state/envelope/logs; DNS created last and
deleted first; a down publishing machine serves no branch content; a partial delete remains
retryable; and `tailscale funnel status` stays empty throughout.

## Bottom line

The most important simplification is not a particular proxy implementation. It is **one
provider object set per env, with no shared mutable router in v1**. Cloudflare can absorb
DNS, public TLS, identity auth, outbound-only transport, and edge availability while Nectar
only owns a child process and three provider resources. That is the smallest credible
general external target.

Quick Tunnels are the smallest demo. Vercel is the smallest deploy for a compatible app.
frp is the cleanest self-hosted steady state. OpenSSH is the least-new-software VM bridge.
But remotely managed named Cloudflare tunnels are the one first implementation that covers
the actual Nectar surface without prematurely turning Nectar into either a deployment
platform or a hosted control plane.
