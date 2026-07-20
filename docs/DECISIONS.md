# Nectar — decisions

*Every contested choice, the alternatives, and why. 2026-07-18. Numbered for citation from
SPEC.md; nothing here is locked harder than one good counter-argument.*

## D1 — CLI-only now; daemon deferred

**Chose:** single `nectar` CLI; serve processes detached with PIDs in env records; liveness
checked lazily; periodic work is `nectar gc` on an external schedule.
**Alternatives:** (a) daemon-first (`nectard` supervising serves, launchd/systemd, socket
API); (b) lean on portless's existing proxy daemon as the supervisor.
**Why:** (a) doubles v0 surface (install, socket protocol, upgrade dance) to buy
restart-on-crash and prompt reaping — both tolerable losses at current scale, and `crashed`
+ log tail is *more* honest for review purposes than silent restarts of a broken build.
(b) makes portless load-bearing, contradicting D3's degradable-nicety stance, and portless
supervises only web serves — desktop/cli/backend still need nectar-owned lifecycle. The CLI
surface is daemon-shaped (stop/touch/gc are verbs a daemon can implement behind unchanged
commands), so the upgrade path is clean.

**v0 amendment · 2026-07-19:** runtime creation is transactional even without a daemon.
After ports are allocated, any publish failure independently attempts process-group
termination and Tailscale Serve removal, then clears `serve`/URLs so the crashed record no
longer claims ports. The record remains by design, with structured failure metadata and a
log tail; deleting it would contradict the inspectable-failure state model.

## D2 — Nectar owns its checkouts; borrowing is explicit

**Chose:** publish clones/worktrees the branch into `~/.nectar/work/<name>`; the agent's
own worktree is used only via explicit `--worktree` and is then never reset or deleted.
**Alternative:** serve from the agent's worktree by default (zero copy, instant).
**Why:** the agent moves on — rebases, force-pushes, starts the next task, or its worktree
gets merged-and-removed by the coordinator — while the review env must keep serving what was
published. Ownership also makes F6 trivial (`reset --hard` is always legal on nectar's own
copy) and GC safe (never deleting someone else's work). Cost: disk + one install per env;
mitigated by local git object sharing and lockfile-hash install caching.

## D3 — Mesh routing: one tailnet port per env; portless is a local nicety

**Chose:** each web env gets its own `tailscale serve --bg --https=<8443-8542>` entry;
portless provides only the same-machine pretty URL and is fully degradable (F1).
**Alternatives:** (a) one nectar reverse proxy on a single tailnet port, path-routing
(`/env/<name>/…`); (b) subdomain routing on ts.net names; (c) make portless itself
tailnet-aware and route everything.
**Why:** (b) is impossible — MagicDNS has no per-machine wildcard subdomains. (a) breaks
real apps: SPAs with absolute asset paths, websockets, redirects to `/` — path-prefix
proxying is a permanent tax on every repo to save port numbers, which aren't scarce on a
private mesh. (c) couples the review substrate to a dev-convenience tool and requires
portless changes before nectar works at all. Port-per-env is dumb, debuggable
(`curl host:8444`), and each entry is independently removable at GC. The 443 rule (portless
proxy owns local 443 ⇒ tailscale serve must always bind ≥8440) is encoded in the allocator
and `doctor`.

**v0 amendment · 2026-07-18:** the sandboxed macOS Tailscale client cannot serve a directory
target. For the pack store only, `doctor --fix` starts a read-only loopback static server
and makes tailnet `:8440` proxy to it. The process binds `127.0.0.1` only; Tailscale remains
the sole mesh exposure and Funnel remains forbidden.

**v0 amendment · 2026-07-19:** readiness probes both `127.0.0.1` and `::1`, then Tailscale
Serve targets the origin that actually answered. The rejected alternative was an
IPv4-only recipe contract: several current dev servers choose IPv6 loopback by default,
and treating a healthy process as timed out is needless fragility when probing two local
addresses is cheap. Exposure is configured only after readiness; failure cleanup still
issues an idempotent Serve-off for the allocated port.

## D4 — `preview_url` is always the tailnet URL; refs are machine-bound

**Chose:** the packet's `preview_url` carries `https://<host>.tailnet.ts.net:<port>`;
canonical refs are `nectar://<host>/<env>`; there is no global registry — envs live and die
on their publishing machine.
**Alternatives:** (a) carry the portless localhost URL and teach the desk to rewrite;
(b) a mesh-wide nectar registry with location-transparent refs (`nectar://acme--branch`)
and per-machine resolution.
**Why:** (a) only works when reviewer and publisher share a machine — the actual fleet is a
Mac reviewing work from linux/mini hosts. The mesh URL is the only location-independent
string for a packet. (b) is a distributed system (sync, conflict, partition behavior)
bought before there's ever been a single cross-machine collision; the host in the ref costs
nothing today (packets already know their machine implicitly via the bee) and F9 makes
offline hosts a visible, attributable failure instead of a registry mystery. Revisit if
envs ever need to migrate hosts.

**v0 amendment · 2026-07-19:** live use disproved the same-node hairpin assumption: a
publishing machine calling its own Tailscale Serve URL sends no Tailscale identity and gets
HTTP 403. The packet field remains the mesh URL because the packet can later be opened on
any device. Instead, `resolve --json` exposes `is_self`, based on case-insensitive full and
short Tailscale hostname comparison; consumers prefer `urls.local` only when it is true.
Changing `preview_url` at publish time was rejected because publisher location says nothing
about the eventual reviewer location.

## D5 — State is file-per-env JSON, not SQLite

**Chose:** `~/.nectar/envs/<name>.json`, atomic rename writes, per-env lockfiles for gc.
**Alternative:** SQLite (Forum's choice).
**Why:** Forum is a ledger — multi-entity, queried, append-only events. Nectar's state is a
dozen tiny records with single-writer-per-env semantics and no cross-record queries beyond
readdir. Files are `cat`-able during incident debugging, diffable, and concurrent publishes
of different envs can't contend. If events/history are ever needed, that's Forum's job —
nectar deliberately keeps no history beyond evidence files.

**v0 amendment · 2026-07-18:** `<name>` is mode-qualified as
`<app>--<branch-slug>--<mode>`. The original mode-less file key contradicted the stated
one-record-per-(app, branch, mode) model and collided immediately for desktop webview
publishes. A mode-less base name remains only a `resolve` discovery input returning all
matching mode records.

## D6 — Testpacks: ad-hoc signed, never notarized, immutable, zip+manifest

**Chose:** `*.testpack.zip` containing `testpack.json` + `app/`; ad-hoc codesign; no
notarization; no update mechanism; CLI-fetched with quarantine stripped; sha256-verified.
**Alternatives:** (a) notarize (real Developer ID pipeline); (b) DMG/installer formats;
(c) auto-update channels (Sparkle/Squirrel) so one install follows the branch.
**Why:** (a) adds minutes per publish and an Apple dependency to move a private build
between the operator's own machines — the threat model (tailnet-internal, self-authored
code) gains nothing; sha256 + tailnet transport is the integrity story. (b) installers
imply installation; testpacks are launch-and-discard, and a zip is scriptable everywhere
including a future windows path. (c) update channels are for products; a review build must
be *immutably* the commit the packet references — "the app updated under me mid-review" is
evidence corruption. Republish = new pack, old one LRU-pruned.

**v0 amendment · 2026-07-18:** `testpack.json` contains no SHA-256. Embedding the hash of
the containing zip is self-referential: writing the hash changes the zip. Nectar instead
computes the authoritative whole-zip digest after finalization, stores it in the desktop
env record, emits it from publish/resolve, and verifies fetched bytes against it in `open`.
Content-pinned refs are deferred to v0.1.

## D7 — One ref scheme (`nectar://`) for testpacks and shells; raw URL only for web

**Chose:** `preview_url` = plain https (directly embeddable, zero tooling); `testpack_ref`
and `shell_recipe` = `nectar://<host>/<env>`, consumed via `nectar resolve/open/shell`.
**Alternative:** raw URLs everywhere (`https://…:8440/….zip` in `testpack_ref`; an ssh
command line in `shell_recipe`).
**Why:** web's consumer is a browser/iframe — a URL is the end of the story. Packs and
shells need behavior (verify, cache, launch; provision, record), so the packet should name
the *thing*, not today's transport; refs stay stable while fetch/ssh mechanics evolve
(open questions 1, 3). It also gives `shell_recipe` — a field that would otherwise tempt
arbitrary command strings into packets — a safe, constant shape.

## D8 — `nectar.toml` in-repo owns *how*; Apiary recipes own *who/what kind*

**Chose:** serve/pack/seed/smoke commands live in the repo (`nectar.toml`), versioned with
the code they build; Apiary's per-product review recipe references the mode, never defines
commands.
**Alternative:** Apiary Settings · Review as the single recipe store (as the desk mock's
"test surface" column suggests).
**Why:** the commands are coupled to the branch (a branch that renames `dev` → `start`
must carry its own recipe change or every publish breaks); config-outside-repo drifts
exactly like CI-outside-repo did before pipelines-as-code. It also keeps nectar usable with
no Apiary at all (humans, other tools). The desk's recipe row stays a *pointer*
(`nectar publish · web`), satisfying the design without duplicating truth. Same logic as
"merge policy belongs to agents.md."

## D9 — Security: tailnet ACLs are the whole auth story (for now)

**Chose:** no nectar-level auth in v0/v1; exposure bounded to ports 8440–8542; documented
ops rule to ACL those ports to operator devices (the tailnet already has one non-operator
node — shared-node/mbtz); scrubbed child env + hem-mediated test secrets; explicit statement
that branch code runs at the operator's existing agent trust level, unsandboxed.
**Alternatives:** (a) signed short-lived URLs on every env (nectar proxy in front);
(b) per-env basic auth; (c) run publishes in a jail/VM now.
**Why:** (a)/(b) add a proxy hop and credential plumbing into the desk/iframe for a mesh
whose membership the operator personally controls — do it when there's a second real human,
via one nectar-owned front proxy (the D3 choice keeps that insertable). (c) is the right
long-term answer *for agent execution generally*; nectar alone jailing its children while
the same code ran unjailed in the agent's own test loop two minutes earlier is security
theater. The scrubbed env is kept because it's nearly free and closes the *casual* leak
(inherited operator tokens in a dev server's `/debug/env`).

## D10 — Own repo, global CLI; not a hive or pollinate capability

**Chose:** `trmd/nectar` (this repo), TypeScript, Node ≥ 20, globally linked like
`hive`/`portless`.
**Alternatives:** (a) a hive capability (`hive nectar publish …`); (b) a pollinate action
type; (c) fold into portless (it already names/serves dev servers); (d) fold into forum.
**Why:** (a) forces every non-hive caller (humans, the desk, codex bees without hive on
PATH, future tools) through hive, and hive's abstraction is *sessions*, not machine-local
serving state. (b) pollinate is a trigger substrate; nectar is a stateful service surface —
pollinate *schedules* nectar's gc, which is their entire correct relationship. (c) portless
is a beloved zero-config dev nicety; loading it with worktrees, testpacks, TTLs, and
evidence would ruin it, and nectar must keep working when portless is absent (F1 — which is
real: the spec-authoring machine didn't have portless installed). (d) forum is the ledger
and must stay buildable/testable with no serving substrate at all — strings in, strings
out. Independent repos with string-shaped seams is the standing architecture of this
toolchain (hive/forum/apiary/pollinate/hem) and it has been paying rent.

## D11 — Envelope shape copies Forum's `{ ok, command, result }`

**Chose:** byte-compatible envelope discipline with Forum's CLI (plus `error.code` taxonomy).
**Alternative:** bespoke output, or plain lines + exit codes.
**Why:** every agent prompt in this ecosystem already teaches "parse the ok/command/result
envelope"; making nectar's the same shape means the review-ready ritual is one jq idiom,
and the desk's adapters reuse their envelope parser. Cheapest possible interop decision.

## D12 — Backend smoke failure fails the publish

**Chose:** non-zero `smoke` ⇒ `E_SMOKE_FAILED`, no packet fields, evidence still written.
**Alternative:** publish anyway with failing evidence attached ("let the reviewer decide").
**Why:** a backend packet's *only* surface is its evidence; publishing known-red evidence
manufactures review work that ends in changes-requested every time. Failing fast keeps the
gate at the bee, where iteration is cheap. The reviewer who wants to see a red run can read
the evidence file from the `crashed` env — nothing is hidden, it just isn't review-ready.

## D13 — Name: stay "nectar"

**Chose:** keep the placeholder. **Alternatives:** waggle (best conceptual fit — the dance
that points the hive at the source), taster (most literal), forage (the gathering act).
**Why:** README makes the cases; nectar wins on family resonance (hive/comb/honey/bee) and
the tagline. Rename cost is near-zero until v0 ships a binary; decision expires the day the
CLI is linked on a second machine.

## D14 — iOS: simulator-only, streamed via serve-sim; simpacks reuse the testpack format

*Added 2026-07-18, post-v0, on Tormod's request for iOS testing packages.*

**Chose:** `--mode ios` builds a **simulator** `.app` into a testpack-format **simpack**
(`platform: ios-sim-arm64`, new `bundle_id` manifest field), and — the hero — boots it in a
dedicated per-env simulator on the publishing Mac and streams it interactively to the mesh
with [serve-sim](https://github.com/EvanBacon/serve-sim) (MJPEG/WS video + touch/keyboard
control in a browser). `preview_url` = the stream; `testpack_ref` = the simpack. Degrades
to simpack-only when serve-sim is unavailable. Device builds are out of scope.
**Alternatives:** (a) device builds — ad-hoc provisioning or TestFlight; (b) simpack-only —
reviewer runs it in their own local simulator, no streaming; (c) cloud simulators
(appetize.io-style); (d) build our own streamer on `simctl io` / idb.
**Why:** (a) buys nothing for review — provisioning profiles, signing identities, per-device
UDID registration, and TestFlight review latency, when the streamed simulator already puts
the app under the reviewer's fingers in seconds; device-specific behavior (camera, push,
performance) is the rare case and can be a manual-test note on the packet. (b) demands
Xcode + matching runtimes on every reviewing machine and excludes reviewing from an iPad or
phone — the stream needs only a browser, which also makes the desk's Test tab embed
identical to web. (c) sends branch code outside the tailnet, violating the not-public
non-goal, for a fee. (d) is re-writing serve-sim, which is maintained, arm64-native, and
already speaks gesture/log/camera-injection. Accepted constraint: ios publishes require an
Apple-Silicon Mac host with Xcode — that's what the mini fleet is for; `E_PLATFORM`
elsewhere keeps the failure honest. The simpack deliberately reuses the testpack format
(one manifest, one pack store, one digest story) rather than inventing a second package
kind — `kind: "ios-sim"` + `bundle_id` is the entire delta.

## D15 — Login: app-cooperated magic link, minted at resolve time

**Chose:** recipes declare a `login` command per scenario; nectar runs it on the publishing
host at *resolve/open time* and returns a short-lived authenticated `entry_url`. The app
enables a dev-only token-login route when `NECTAR_ENV` is set (convention + a tiny
middleware package, Apiary-side). Packets carry only the token-free `review_entry_url`.
**Alternatives:** (a) mint at publish time and put the authenticated URL on the packet;
(b) Playwright storage-state injection (record cookies once, inject into the consumer);
(c) nectar-side session forgery (write cookies/JWTs directly).
**Why:** (a) bakes a credential into a document that lives for days and is pasted around —
the packet must stay secret-free (SPEC §9.2); resolve is already the desk's read path, so
freshness is free. (b) only works for consumers that can inject browser state — the desk
webview and taste, but not a plain browser tab on any device, which is half the point of
mesh URLs; it survives as the fallback for uncooperative third-party apps. (c) requires
nectar to know every app's session format — a per-app coupling that rots. The cost of (chosen)
is a one-line route in our own apps, which we control. Login failure degrades to a warning,
never an unresolvable env.

## D16 — Preview deps: provision/teardown commands are the primitive

**Chose:** `[deps.<name>]` with a `provision`/`teardown` command pair as the fundamental
contract (stdout returns injected env vars); `compose = "…"` delegates wholesale to docker
compose under a nectar-owned project name; image `kind` shorthands are sugar added on
demand. Instances are per-env (`nectar-<env>-<dep>`), lifecycle-bound (publish/republish/
stop/rm/gc), volumes deleted only under the `nectar-` prefix guard.
**Alternatives:** (a) docker-only integration (nectar drives the docker API directly);
(b) no deps — repos script their own in `serve`; (c) shared long-lived services per machine
(one postgres, one redis) with per-env databases/namespaces.
**Why:** (a) couples nectar to docker's API and still can't provision the genuinely remote
cases (buckets, third-party sandboxes) — commands cover both containers and everything
else with one contract. (b) is what happens today and it leaks: `serve` scripts that spawn
databases leave them running after gc kills the process group, and nothing ties data
lifetime to env lifetime. (c) saves RAM but shares failure domains and makes `--fresh` and
teardown semantics murky; per-env instances make isolation the default and cost only
containers we already GC. Compose-first keeps nectar's own surface thin: naming, lifecycle,
env wiring, seeding hook, GC.

## D17 — Taste: Playwright optional, evidence as files, DPC by shell-out

**Chose:** `nectar taste` drives Playwright chromium as an *optional* dependency (absent →
`E_TASTE` with install hint); all outputs (screenshots, video, taste.json, diffs) are plain
files in the env's existing evidence store, served over :8440; visual diffing shells out to
DPC (`NECTAR_DPC_BIN`), never a bundled JS pixel-diff.
**Alternatives:** (a) bundle Playwright as a hard dependency; (b) a bespoke CDP driver to
avoid the dependency entirely; (c) structured evidence in the env record instead of files;
(d) pixelmatch/resemble.js for diffs.
**Why:** (a) drags a browser download into every `pnpm link` of a CLI whose core job
doesn't need one. (b) re-implements the hard 20% of Playwright (waiting, network-idle,
video) for zero user benefit. (c) records must stay tiny and secret-free; files over :8440
give the desk rendering for free and GC already prunes evidence. (d) the team already owns
DPC — one diff tool, one score scale, everywhere it's used; external-binary degradation
(skip + warn) matches the portless/tailscale pattern.

## D18 — Drops ride the pack store

**Chose:** `nectar drop` stores content-addressed static directories under
`packs/.drops/…` and serves them through the existing :8440 read-only server (extended
only to serve `index.html` for trailing-slash requests under `/drops/`); TTL + LRU via the
existing gc; no process, no worktree, no new port.
**Alternatives:** (a) drops as a sixth env mode; (b) a separate drops server/port;
(c) skip drops — use gists/pastebins.
**Why:** (a) an env carries checkout/serve/recipe machinery that a static snippet doesn't
have — wrong abstraction, and mode vocabulary leaks into the desk contract. (b) another
port, another serve entry, another doctor check, to serve files a working static server
already serves. (c) sends team content to third parties and off the tailnet by default —
drops exist precisely so agent-written artifacts have a zero-friction home with our
lifecycle and ACLs. Internet-visible drops reuse D19's targets as static copies.

## D19 — Internet exposure: explicit per-env escalation, machine-config targets

**Chose:** amend SPEC §2's "Not public": publishing remains tailnet-only; `nectar expose
<env> --to <target>` is an explicit, per-env, gated-by-default escalation (`--gate none`
additionally requires `--public`). Targets live in machine config (`exposures`: 
cloudflare-tunnel | ssh-tunnel | vercel-deploy), never in repo recipes. Password gating is
one nectar-side fronting proxy shared by tunnel kinds. `tailscale funnel` stays forbidden.
**Alternatives:** (a) keep the non-goal absolute (no internet previews); (b) funnel — it's
one flag; (c) per-repo exposure config in `nectar.toml`; (d) always-public publish mode.
**Why:** (a) real review includes people off the tailnet (clients, phone tests) — the need
exists and will otherwise be met by hand with worse hygiene. (b) funnel binds exposure to
the tailscale identity/cert story, offers no auth gate of our own, and breaks the clean
"funnel==never" doctor invariant that guards the rest of the surface. (c) exposure is
infrastructure (which tunnel, which domain, which credentials) — repos say *what* to serve,
machines say *where it can go*; a hostile branch must not be able to declare itself public.
(d) dev servers stay dev servers (§9.1) — default-gated, loud warnings, TTL teardown.

## D20 — Reviewer-facing UI lives in Apiary; nectar stays headless

**Chose:** the review overlay, element-anchored feedback, and side-by-side compare are
Apiary features consuming nectar's existing interfaces (`packet_fields`, `resolve`,
evidence over :8440, the ax channel). Nectar adds no injected toolbars, no HTML rewriting,
no compare surface. Taste receipts (who-opened-when telemetry) are dropped entirely.
**Alternatives:** (a) nectar injects a review toolbar into web previews (proxy-side HTML
rewriting); (b) a nectar compare page serving two envs in a split iframe; (c) receipts in
the env record surfaced to packets.
**Why:** (a) duplicates the element picker Apiary already has, and proxy HTML injection
breaks CSPs, frameworks, and websockets in exactly the apps we review — the desk owns the
chrome around the preview, nectar owns the preview. (b) is two resolves and a flexbox —
desk-side, optional by ruling. (c) ruled not important; if audit ever matters it arrives
with D9's token layer, where identity is real rather than inferred.

## D21 — Exposure v1: the nctr.site relay — routing, not tunneling

**Chose:** the first (and likely only load-bearing) exposure kind is `relay`: one operator
VM with a dedicated public IP joins the tailnet and reverse-proxies
`<sub>.nctr.site` to publishers' existing tailscale-serve URLs. Caddy with one DNS-01
wildcard cert; routes are expiring files managed by a small `nectar-relay` command over
Tailscale SSH; the D19 gate is basic-auth in the route blocks, built once, centrally.
Host: `relay-1` (already public-IP'd, tailnet-joined, Caddy-running). Cloudflare named
tunnels are deliberately not built. exe.dev VMs cannot host the relay — they have no
dedicated public IP (NAT behind exe.dev's proxy).
**Alternatives:** (a) cloudflared named tunnels first (the codex and kimi panelists' pick);
(b) sish / plain `ssh -R` reverse tunnels to a VM; (c) the exe.dev-native relay
(`*.exe.xyz` + their login proxy, ~zero credentials); (d) a full managed control plane
(database, leases, publisher credentials).
**Why:** every publisher is already reachable inside the mesh, so public exposure is a
routing problem, not a NAT-traversal problem — tunnels re-solve connectivity we already
have. (a) costs a daemon plus a distributed credential on every publishing machine and
4–6 build days versus 3–4 for the relay, which also delivers the generic-VM story and the
nctr.site brand in the same build; Cloudflare's unique gifts (Access SSO, edge) remain
one reversible config flip away — proxy the nctr.site DNS records in front of the relay,
zero nectar code. (b) survives as the deferred fallback kind for a box that cannot join
the tailnet. (c) is ~1 day and credential-free but binds reviewer-facing URLs to a
seven-months-old dev preview — acceptable as an internal-only nicety, never the primary.
(d) is 10–20 days of control plane that routes-as-files makes unnecessary until real
external tenants exist. Panel research: docs/research/exposure-{codex,kimi,fable}.md
(2026-07-19; three models, three emphases; disagreements resolved here — the kimi
panelist's exe.dev NAT finding overruled the fable panelist's hosting suggestion).
