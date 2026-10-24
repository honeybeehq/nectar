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

## D22 — Static sites publish as web envs served by Nectar's own server

**Chose:** a directory of HTML (or one `.html` file) publishes through `nectar publish` as
an ordinary `web` env. Nectar copies the files into `work/<name>/` and the env's serve
command is Nectar's bundled static server, so the env gets the usual `preview_url`,
`packet_fields`, ports, TTL, gc and exposure. Detection only applies where the recipe path
does not, and `--mode static` forces it. (SPEC §6.1.1.)
**Alternatives:** (a) D18's `nectar drop`, which stores content-addressed copies in the
pack store and serves them from the :8440 pack server; (b) a new `static` env mode;
(c) `npx serve`/`python -m http.server` as the serve command.
**Why:** agents building prototypes call `publish` and expect a packet-ready `preview_url`
that stays stable across republishes. They do not call a separate command that returns a
`drop_url` under a shared path prefix. Root-relative asset paths (`/style.css`) break under
`/drops/<id>/`, which is the same reason D3 gives one port per env. A web env also has a
recorded serve process that a supervisor can restart like any other, and an idempotent name
instead of a new hash per content change. This amends D18 for prototypes. `drop` stays the
design for tiny piped artifacts (stdin HTML, reports) where a path-prefixed, pack-store URL
is enough. (b) leaks a new mode into the desk contract for what is still a web preview.
(c) adds a network fetch or an interpreter dependency at serve time. The bundled server is
about 150 lines of `node:http` with no new dependencies.

## D23 — Python and Rails apps publish through file-based fallbacks with a build step

**Chose:** without `nectar.toml` or a `dev` script, `nectar publish` recognises Django,
FastAPI/Starlette, Flask and Rails apps from their files, in a fixed order after
`package.json` and before static HTML. Each fallback produces an ordinary `[web]` recipe
plus an internal `build` step: dependencies go into `<worktree>/.nectar/venv` (uv when on
PATH, else `python3 -m venv` + pip) or `<worktree>/.nectar/bundle`. `--dry-run` prints the
match, the reason, and both commands. A missing runtime is `E_PLATFORM` before any env
exists. (SPEC §5, §6.1.2.)
**Alternatives:** (a) require a `nectar.toml` for every non-Node stack; (b) add `build`/
`install` keys to `nectar.toml`; (c) fold install into the serve command; (d) a new
`E_RUNTIME` error code; (e) buildpacks/nixpacks-style detection.
**Why:** prototypes come in every stack and agents should not have to write a recipe for
the common shapes. Detection that reads a fixed list of files is predictable and the dry
run makes it explainable; anything unusual still has `nectar.toml`, which always wins.
(b) would grow the recipe schema while D8 keeps `nectar.toml` naming the repo's own
commands; the build step stays internal to fallbacks. (c) would rerun installs on every
supervisor restart and hide install failures behind `E_SERVE_TIMEOUT`. (d) adds a contract
code for what `E_PLATFORM` already means: this host cannot run it, route elsewhere.
(e) pulls in a large dependency or a container runtime for a handful of patterns. Serve
commands `exec` the server and carry relative paths so the recorded `serve.cmd` restarts
the same process from the worktree, as nectard expects.

## D24 — `nectard`: a light, optional supervisor for Nectar's own web envs

**Chose:** `nectar daemon run`, installed per user (launchd agent / systemd `--user` unit
via `nectar daemon install`, removed with `nectar daemon uninstall`). It revives crashed web
envs on their recorded ports, restores them after a reboot, re-asserts their `tailscale
serve` mappings and runs gc hourly. It works only from env records. It caps revives (3 in
10 min, then `E_CRASH_LOOP`). Amends D1. (SPEC §4.5.)
**Alternatives:** (a) stay CLI-only and let agents republish; (b) a pollinate schedule
that runs `nectar gc` and a revive verb; (c) hand serves to launchd/systemd one unit per env.
**Why:** previews died with a crashed dev server or a reboot, and gc never ran on the Studio
because nothing scheduled it. Humans click mesh URLs days later, so D1's "crashed + log tail
is honest" left them with dead links. (b) means a minute-scale schedule per machine plus a
pollinate dependency for a core property. (c) writes and deletes a unit per publish and
puts Nectar state in the service manager. One timer, a probe every 30 s and gc hourly keep
it light. Leaving the CLI fully functional without the daemon keeps D1's "nectar can't wedge
itself" property: uninstalling it loses only the revival.

## D25 — Touch on HTTP view: per-env proxies inside nectard

**Chose:** nectard (D24) hosts one `node:http` reverse proxy listener per fronted web env,
on a third per-env loopback port (`serve.proxy_port`, from the upstream range). The Serve
entry points at the proxy and the proxy forwards to the app. A page navigation touches the
env like `open`/`resolve`/`show` do, at most once per env per 5 min, fire-and-forget. Envs
published before this are adopted on nectard's next sweep with the same tailnet URL. Without
nectard nothing changes: the Serve entry points at the app. (SPEC §4.4, §4.5.)
**Alternatives:** (a) one multiplexing listener for all envs; (b) a detached proxy process
per env, spawned and revived like a serve; (c) give the proxy the env's `upstream_port`
and move the app to a private port; (d) listen on `127.0.0.1:<tailnet_port>`.
**Why:** `tailscale serve` gives each env its own HTTPS port and forwards the same `Host`
for all of them, so (a) cannot tell envs apart without rewriting paths or hosts that apps
see. Separate listeners in one process cost nothing when idle, and no new process is
spawned per env. (b) adds a ~40 MB Node process per env and a second thing to supervise.
(c) changes the port recipes were published on and breaks every older record's
liveness. (d) relies on how tailscaled binds Serve ports, which differs between Linux
tun, macOS's App Store build and userspace netstack. A third port is cheap: 12 serving envs
use 24 of the 100 upstream ports. Living inside nectard keeps Kal's conditions. It acts only
on records, adds no timer, and `nectar daemon uninstall` stops it after pointing every
entry back at its app. A proxy that dies with nectard costs one restart interval. gc also
falls back to the direct mapping when it finds a dead proxy in front of a live app, so the
preview never stays down for long. The probe-before-map rule (the proxy must name its env
and current upstream) means a stale or foreign listener is never fronted.

## D26 — An env belongs to its source; a live web republish stages before it stops

**Chose:** an env record keeps the source it was published from. Publishing a different
repo (or static path) into the same name is `E_USAGE`, as static-vs-git already was, and
`--name` now works for every source so the second one can sit beside the first. A git
worktree sharing the repo's `--git-common-dir` is the same source, because Nectar's own
worktree can check out its commits. A republish of a serving web env checks out, installs
and builds in a second worktree slot (`work/<name>` ↔ `work/<name>.alt`) and stops the old
serve only after that succeeds; the old slot is then removed. (SPEC §3, §6.1.)
**Alternatives:** (a) keep the old serve running but reset the worktree in place and
restore it on failure; (b) stage in `work/<name>.next` and `git worktree move` it over the
old one; (c) blue/green: run both serves and swap ports; (d) let a different repo take
the name over.
**Why:** two repos with the same `package.json`/`pyproject` name are common, and the
takeover killed the first preview and then failed with `E_CHECKOUT`. (d) is that bug.
(a) is not correct: `git clean` removes the build output the old serve depends on,
dev servers hot-reload the new files, and installs change dependencies under the running
process; restoring would need a second build. (b) moves directories whose venvs,
node_modules shims and framework caches can embed absolute paths. Alternating slots keeps
every path the serve sees the path it was built at. The cost is a cold dependency install
on a live republish, because the new slot starts without the other slot's caches. (c)
needs two ports per env and a reviewer-visible URL swap, which open question 6 already
deferred. Only web envs stage: dev, desktop and iOS republish in place, and stopped or
crashed envs have nothing to keep serving.

**Amendment · 2026-10-14 (cross-Cell republish and detached HEAD):** each Honeybee Cell is
its own clone at its own path, usually with a detached HEAD, so D26 refused to republish
`<app>--<branch>--web` from a second Cell or after a Cell move, and publish without
`--branch` failed with `E_CHECKOUT`. **Chose:** (1) with a detached HEAD and no `--branch`,
the branch slot is a local branch whose tip is HEAD, else a remote-tracking branch whose
tip is HEAD, else a local branch containing HEAD, else a remote-tracking branch containing
HEAD (ties by name), else `detached-<8-hex sha>`. Only local refs are read; nothing is
fetched. The checkout is HEAD's commit, not the tip of the chosen branch. The plan, the
result and the record carry `branch_source` (`flag`, `head`, `contains`, `detached`).
(2) A git source also matches the recorded one when both have the same normalized
`remote.origin.url` (host and path for URLs, credentials, port and `.git` dropped; real
path for local remotes) and share a root commit, and either the branch is the recorded one
or the recorded `repo` no longer exists. Records keep `origin` and `roots` from the publish,
so an evicted Cell can still be matched. Nectar's old slot belongs to the old clone, so a
republish from another clone checks out a fresh slot and trashes the old one.
**Alternatives:** (a) read a branch name Honeybee records for the Cell; (b) match on origin
URL alone; (c) treat any source as replaceable once the recorded path is gone; (d) clone
into nectard's work dir so slots never belong to a Cell repo. **Why:** Honeybee exposes no
branch to a Cell: `HIVE_*` carries bee ids and the space name, and the Cell's `cell.json`
has the origin and sha but no branch, so (a) has nothing to read. The origin URL is plain
repo config that any repo can set, so (b) and (c) let an unrelated repo take an env by
naming the same origin. Requiring a shared root commit stops an unrelated repo that
only names the origin. `runGit` ignores replace refs and grafts
(`GIT_NO_REPLACE_OBJECTS=1`, `GIT_GRAFT_FILE=/dev/null`), so those can't fake a root.
The guard is against accidental collisions, not a deliberate actor running as the same
user: a repo that merges the origin's history in (`--allow-unrelated-histories`) shares
its root and passes. That actor could also `nectar rm --force` the env, so no history
check is a security boundary here. `git config --get` and `rev-list` run through the
hardened `runGit` and execute nothing from the repo's config. (d) remains the D29
follow-up. Limits: a shallow clone's root is its shallow boundary, so it never matches
another clone. A record from before this amendment has no `origin`, so once its `repo`
is gone it still needs `nectar rm <env> --force`. When
another clone takes an env over, Nectar removes its old slot through the old clone if
that clone still exists, so no stale worktree entry is left behind.

**Amendment · 2026-10-14 (a session slot for a detached HEAD):** a Cell whose HEAD is past
every branch, which is every Cell once its agent commits, got a new `detached-<sha>` env
and URL for each commit. **Chose:** with no `--branch`, no checked-out branch and no
branch containing HEAD, the slot is `cell-<session>` when the publisher is a Honeybee
session: `HIVE_BEE` (the session name), else `HIVE_BEE_ID`, slugified and cut to 40
characters. Through nectard it is the request's caller, never nectard's own environment.
`branch_source` is `session`. Without a session it stays `detached-<8-hex sha>`.
**Alternatives:** (a) leave it to agents to pass `--branch`; (b) use the Cell path or
space name; (c) put the session slot ahead of the branch rules. **Why:** (a) is easy to
forget, and the URL in a packet goes dead as soon as the agent commits again. The session
name is what an agent and its reviewer know, and it survives a Cell move, where (b) does
not. (c) would split two Cells of one branch that should share `main`. The slot is only
a name: republishing onto it runs the same source checks, so a different repo whose
session lands on the same slot is refused as before, and two sessions get two slots.
A fresh Cell still publishes as `main` (`contains`) until its first commit, then moves
to its session slot once.

## D27 — `doctor --fix` removes only what it can prove is Nectar's

**Chose:** classify every Serve entry in Nectar's tailnet range as owned, orphan, foreign or
ambiguous, and let `gc` and `doctor --fix` remove only orphans: loopback proxies to a Nectar
upstream port where nothing listens and the owning env's process is gone. Process groups are
signalled only when a member carries the env's `NECTAR_ENV`. `doctor --fix` installs nectard
through `nectar daemon install`, and leaves a unit bound to another `NECTAR_HOME` alone.
Every repair is an action with before/after, and `--dry-run` lists them. (SPEC §10.5.)
**Alternatives:** (a) the old rule: any entry in the tailnet range whose loopback target is
dead; (b) a Nectar-side registry of every Serve entry it ever created; (c) report only and
never repair.
**Why:** the Studio had orphaned entries and dead records to clean up, alongside Portless and
other services that also use `tailscale serve` and loopback ports. (a) would remove someone
else's entry that happens to sit in the range and point at a dead port of theirs, and gc
killed process groups by recorded pgid alone, which a recycled pgid turns into killing a
stranger. (b) duplicates what env records already hold, and drifts. (c) leaves the rollout to
hand-written shell. Anything doctor cannot prove stays put and is reported with a hint.

## D28 — `doctor --no-daemon` for machines that get cleanup without nectard

**Chose:** `nectar doctor --no-daemon` skips `install-nectard` / `reinstall-nectard` and
reports the `nectard` check as `info`, which does not count against `healthy`. `--save`
stores `daemon: "disabled"` in `nectar.json` so later doctor runs behave the same, and
`nectar daemon install` clears it. An installed unit is reported, never removed. (SPEC §7,
§10.5.)
**Alternatives:** (a) a separate cleanup command; (b) always persist the flag; (c) downgrade
the check to `warn`.
**Why:** the Studio gets gc and orphan cleanup but no supervisor. (a) duplicates doctor's
plan and its `--dry-run`. (b) makes a one-off run change the machine. (c) keeps nagging on a
machine where no daemon is the intended state.


## D29 — Publishing from sandboxed Cells: a local control socket on nectard

**Chose:** nectard (D24) serves a small HTTP/1.1 API on a Unix socket,
`~/.config/nectar/nectard.sock` (`NECTAR_SOCKET` overrides it). nectard creates the
directory itself with mode 0700 and refuses one that is not owned by the user or is
writable by group or others. The socket is 0600. It takes over a stale socket only when
nothing answers on it, and it never steals a live one. The API is `GET /v1/hello` plus
`POST /v1/{publish,ls,show,resolve,touch,stop,rm}`. Each request carries `nectar_home`,
the caller (`cell`, `hive_bee`, `hive_session`) and arguments checked against a
per-operation allowlist of names and types. Replies are the CLI's own `--json` envelope.
The CLI picks the route on each call. `--direct` means local. A nectard that answers
for the same `NECTAR_HOME` and supports the operation is used. Otherwise a writable
`NECTAR_HOME` means local. Otherwise `ls`, `show` and `resolve` give a read-only view
(no touch, `touched: false` with the reason), so a Cell can still read its preview URL.
Anything else is `E_DAEMON` with `hint: "nectar daemon install"`. Publish through nectard takes a host path. nectard
resolves it with realpath and accepts it only inside the user's home or the caller's
Cell. The Cell is self-reported, so it counts only as a directory the user owns below
the Cells root (`~/.hive/v2/cells` by default). It refuses a scope that lies inside or
contains `NECTAR_HOME`, the socket directory, `~/.ssh`, `~/.gnupg`, `~/.aws` or
`~/Library/Keychains`. A host shell whose home is writable falls back to an in-process
publish when nectard refuses a path, so publishing `/srv/app` from the host still works.
Then it copies or
checks out the source into `~/.nectar/work` exactly as a local publish would. Records
get `publisher.via: "nectard"` and the caller's `cell` and bee ids. (SPEC §4.5, §7, §9.)
Queen ruled on the transport, the stamp, the path rule and the error (2026-10-14).

**Alternatives:** (a) a loopback HTTP port with a per-user secret file under
`~/.config/nectar/`; (b) a socket under `$XDG_RUNTIME_DIR` or `/tmp`; (c) ask Honeybee
to bind `~/.nectar` read-write into every Cell; (d) a raw JSON-lines protocol on the
socket instead of HTTP.

**Why:** Cells cannot write `~/.nectar`. On Linux `/` and `$HOME` are read-only and only
`~/.config`, `~/.cache` and a few tool directories are bound read-write. On macOS a
Seatbelt profile allows writes only to an allowlist. Previews must outlive the Cell, so
the server has to run outside it anyway, and nectard already does. A Unix socket is
reachable only by processes that can open the file. With a 0600 socket in a 0700
directory that means the same user on the same host, and the tailnet never sees it.
(a) puts a bearer secret in a file every Cell can read and opens a TCP port that every
local user and every local process can try. It is strictly weaker for the same work.
`~/.config` is the same directory inside a Linux Cell (a read-write bind of the real
one), so the path works there. The macOS probe (mini04, macOS 26.4, findings
p2-cell-publish) read Honeybee's Cell profile and found `allowAllUnixSockets: true` and
`needsNetworkRestriction: false` (`(allow network*)`). Reads are denied only under
`~/Library/Keychains`. A Cell process connected to sockets the user owns outside the
Cell, and `~/.config/nectar/nectard.sock` failed with `ENOENT`, not `EPERM`. (b) private
`/tmp` per Cell rules out `/tmp`. `$XDG_RUNTIME_DIR` does not exist on macOS and is not
guaranteed inside Linux Cells. Socket paths deep in a Cell also hit the 104-byte
`sun_path` limit on macOS. `~/.config/nectar/nectard.sock` is about 40 bytes. (c) Queen ruled that the
Cell sandbox stays as it is. HTTP (d) costs nothing in Node, and it is what the later
tailnet listener needs, so one handler serves both. The `nectar_home` check stops a CLI
that points at another home from acting through the wrong daemon, and the route stays
local when the home is writable and no matching daemon answers. That is why the
existing tests and machines without nectard behave exactly as before.

**What this does not protect against:** a recipe's build and serve commands run as the
user under nectard, outside the Cell's sandbox. That was already true of revival (D24).
A local `nectar publish` from inside a Cell now cannot run at all, so routing through
nectard is the only way an agent can publish a recipe. The commands it runs are the ones
a local publish of that source would run, and nothing else: the API has no command,
environment or recipe field, only Nectar's own options. Static sites run no recipe code.
Queen's rule is that a Cell's git config must not run anything on the host. So every git
call Nectar makes ignores global and system config (a Linux Cell can write
`~/.config/git/config`). It refuses every transport and lazy fetch, sends hooks to
`/dev/null`, turns off fsmonitor, auto-gc and submodule recursion, and neutralizes
every filter driver and config hook in the repo's config. The overrides go through
`GIT_CONFIG_COUNT`, because a `-c filter.a=b.smudge=` argument is split at the first
`=`. Partial clones are refused, and reading the repo's config fails closed. Static
sources are copied without running git in them, except a read-only `rev-parse`/`branch`
for the branch name. Cloning instead of `git worktree add`
would avoid reading the source's config at all. But it changes how D26 matches sources
and alternates slots, so it is a follow-up and not part of this slice.
Running a Cell's serves under the same sandbox profile is the hardening step if Cells
ever hold less-trusted code (SPEC §9.3).

**Later: `nectar publish --host <node>` (phase 2, not built).** The same handler gets a
second listener on the node's tailnet address, port 8441 (outside the 8443–8542 preview
range). It never binds a public interface, and the ACL limits who can reach it to pool
hosts and operator devices. For each request it asks the local tailscaled
`WhoIs(remote addr)` (LocalAPI `/localapi/v0/whois`) and gets the caller's stable node ID
and login. It accepts only callers on an allowlist in machine config
(`control.allow: [{node_id}]` or the operator's login), keyed by stable node ID, not by
name, as relayd does (design/public-and-cloud.md). A caller's host path means nothing on
another node, so remote publish swaps `args.path` for a source the target can fetch
itself. `{git: {url, commit}}` comes first: the target fetches the commit into its own
work dir, from a remote it can reach or from a bundle the CLI streams in the request
body under a size cap. An archive upload of a static directory is the second option.
The path rule, `nectar_home` and Cell stamp apply only on the Unix socket. Remote
records get `publisher.node` from WhoIs, not from the request. `rm`, `stop` and `touch`
over the tailnet act only on envs whose `publisher.node` is the caller, unless the
caller is the operator. Before it is built, these need settling. A git URL must be limited to `https:` and
`ssh:` (no `file:`, `ext::`, local paths or option-like values), or a caller could
publish any repository on the target. An allowlisted node gets code execution on the
target as the user, because recipes run. So list node IDs, not a login, which can own
shared or tagged devices. An archive upload needs zip-slip, symlink and size defences,
and its own body cap instead of 64 KiB. A failed WhoIs refuses the request. Remote
`ls`/`show` reveal Cell paths and bee ids, so decide whether peers may see them or
redact them. The Unix socket stays the local route, so a Cell on the target
node keeps working when the tailnet listener is off. The client side is the same
`callDaemon` with an `http://<node>:8441` base URL. WireGuard already encrypts the hop.
Putting `tailscale serve` in front would hide the peer address that WhoIs needs.

**Amendment · 2026-10-14: `publish --host` built (p2-remote-host).** What was built
differs from the plan above in three places. (1) **An archive, not a git URL.** The
caller ships a gzip tar: `git archive` of the branch's commit for a repo, the files a
static publish copies for a static site. The target never fetches, so there is no URL
scheme to restrict, and a commit that exists only in a Cell publishes without a push.
The target unpacks into `inbox/<key>/<dir>` (key = hash of the caller's stable node ID and the repo's root
commits, or a static site's path, so any checkout of a repo on that node republishes the
same env) and, for git, makes one commit there with the hardened git (`init`,
`add`, `commit`). That is the only git it runs on received content, and the publish then
takes the normal local path. Archive defences: 256 MiB compressed, 1 GiB and 100 000
entries unpacked; no absolute paths, `..`, `.git`, hard links, devices, FIFOs or
duplicates; no write through a symlink; symlinks must be relative and must resolve inside
the tree after unpacking; files are created `O_EXCL | O_NOFOLLOW`, 0644 or 0755. The tar
is parsed in Node, so no archive name reaches a shell or a tar binary. (2) **The default
allowlist is the node owner's own untagged nodes**, matched by WhoIs user ID, not a list
of node IDs, so the fleet works without writing every node ID into every node.
`remote.allow` replaces it with explicit `{node_id}` or `{login}` entries; a login never
matches a tagged node, and an empty or malformed list or an unreadable `nectar.json`
refuses everyone. (3) **Remote views are allowlisted, not denylisted**: `show` returns a
reduced record (no `repo`, `worktree`, `serve`, Cell or bee ids, login, node ID, install
hash, evidence, deps beyond `{kind}`, log tails), `ls` drops the bee, error details are cut
to `hint`, `refused` and `node_id`, and in peer-facing text `NECTAR_HOME` reads
`$NECTAR_HOME` and every other absolute path `<path>`. (4) **The node never serves
itself over the tailnet.** The checker showed that a connection from the node's own
Tailscale IP is WhoIs'd as the node, so any local user or host-network container would
get the owner's rights and bypass the 0600 socket. A peer address in the node's own
Tailscale IPs, or a WhoIs node equal to the node itself, is `E_FORBIDDEN`. A non-owner's
`show`/`resolve` of another node's env does not extend its lifetime. Requests must arrive
within 10 minutes and at most 32 connections are open.
As planned: the listener is off unless `remote.listen` (`nectar daemon install --remote`),
binds only the node's Tailscale IPv4 on 8441, never a wildcard, and WhoIs runs on the raw
peer through the shared LocalAPI client (src/localapi.ts, D32, so the macOS app's
sameuserproof port works under launchd; there is no CLI fallback) before the body is read; a failed WhoIs is `E_FORBIDDEN`. `publisher.node`,
`node_name` and `login` come from WhoIs. A non-owner may `touch`, `stop` and `rm` only
its own envs. A ref passed to the listener is refused, so nothing is relayed onward. The
client finds the node's address in tailscaled's status and needs no MagicDNS, which
Cells may not have; resolve/show/ls/touch/stop/rm of another node's ref use the listener
and fall back to `tailscale ssh` only when `remote.ssh_fallback` is set. New codes:
`E_REMOTE` (nothing answers on the node's listener; hint `nectar daemon install --remote`)
and `E_FORBIDDEN`. **Not built:** a `{git: {url}}` source, per-node rate limits, and
inbox cleanup for envs gc only cools (rm and gc reap remove the inbox with the last env
that uses it). (SPEC §4.2, §4.5, §7, §9.1, §9.3.)

## D30 — `[deps]` v1: generated Compose per env, torn down by label

**Chose:** build D16's `kind` sugar first, for `postgres:<tag>` and `sqlite`. Nectar writes
one Compose file per env (project `nectar-<env>`, a named volume, a healthcheck, a Nectar
loopback port) and runs `docker compose up -d --wait`. Every container, volume and network
is labelled `dev.nectar.env=<env>` and `dev.nectar.home=<NECTAR_HOME>`. Stop and teardown
list by those labels and act only on the IDs they listed. A Compose project that already
holds anything without this home's label is refused, not adopted. The password is generated per env
and kept in a 0600 file beside the compose file. A missing Docker, or one the user cannot
reach, is `E_PLATFORM` before any work. A scenario `seed` runs when deps are created and on
`--fresh`. (SPEC §5.1.)
**Alternatives:** (a) `[deps].compose` or provision/teardown first, as D16's build order
says; (b) `docker compose down -v` for teardown; (c) password in the env record; (d) a
shared Postgres with a database per env.
**Why:** (a) the phase-3 goal is "a database-reliant preview works smoothly". Postgres
covers most of those apps, and with the generated file Nectar controls the labels, port
and health, so isolation and teardown are provable. A repo's own compose file would need
the same guarantees retrofitted, so it waits for its own slice. (b) `down` acts on the
Compose project label, which anything can carry, and metal-1 runs CI and other services
beside Nectar. Two Nectar labels plus the `nectar-` volume prefix are the only proof of
ownership. (c) records are shown and copied into envelopes, and D17 keeps them
secret-free. (d) is the planned macOS fallback, not the default: it shares one failure
domain and makes `--fresh` a drop/create dance (D16).
**Amended by D33 (2026-10-14):** (d) is now built as the fallback for hosts without a usable
Docker, chosen per dep by `provider` or auto-detection; the Docker path above is unchanged
and stays the default where Docker answers.

## D31 — doctor follow-ups from the Studio cleanup: one-pass repair, 443 as a warning, no dead mesh URLs

**Chose:** (1) after gc transitions and after `release-env`, classify the Serve table again
and remove entries that only now prove to be orphans, in the same run and by the same rule
(D27), so a second `doctor --fix` returns no actions. (2) `serve-443` is a warning with the
entry's targets and a hint, never a failure. (3) gc expire/cold, `release-env`,
an orphan cleanup for an expired/stopped/cold owner and `stop` set `urls.mesh` to `null`
once the env's own entry is gone; the `serve` block and its ports stay, so a republish (or a
nectard revive) restores the same URL. (4) gc cools an env once: a `cold` env is not
transitioned to cold again on every pass, which made every `--fix` report `gc-cold` and `gc`.
(SPEC §10.2, §10.5.)
**Alternatives:** (a) classify once and let the next run clean up; (b) predict freed entries
in the plan; (c) keep 443 a failure and add an allowlist; (d) keep the mesh URL and rely on
`status` to say it is dead.
**Why:** on the Studio, `--fix` released helidex and offshore, which freed upstream 4102, and
the entry :8445 pointing at it was only removed by a second run. (a) is that bug. (b) cannot be
proven before the process actually stops, so the plan stays honest and the run reports what
it did. 443 there belongs to portless's own Serve entry by design, and no Nectar feature binds
443 through Serve, so a failure kept doctor unhealthy forever over something Nectar must not
touch; (c) adds config for a check that has no failure case. (d) hands consumers a URL that
answers nothing, or answers for whoever takes the port next.

## D32 — Talk to tailscaled through the LocalAPI, keep the CLI as the fallback

**Chose:** status, the serve config and WhoIs use tailscaled's LocalAPI over its Unix
socket, or over the macOS app's loopback port with the `sameuserproof` token. Endpoints are
found the way Tailscale's own CLI finds them. Serve changes are an ETag read-modify-write
that touches only Nectar's one `<host>:N` entry, with the same semantics as `tailscale serve
--bg --https=N` and `--https=N off`. The CLI stays as the fallback when no endpoint answers.
Which API answered is in the log line, doctor and `mesh_error`. (SPEC §4.5.)
**Alternatives:** (a) keep the CLI and fix its environment further; (b) LocalAPI only;
(c) let the LocalAPI fail over to the CLI on any error.
**Why:** on mini03, the app-bundle CLI started from nectard's LaunchAgent tries to start the
GUI ("Tailscale.CLIError error 3"). It prints no status JSON, and `serve status --json` exits 0
with empty output, so every Mac's nectard hands out no mesh URL. (a) cannot fix an app binary
that decides it is the GUI. (b) breaks hosts where only the CLI works. (c) would turn a
deliberate refusal (403 for a non-operator, `BackendState` Stopped) into a second, slower
refusal with a less precise message. Reading the token from `lsof` rather than from the group
container avoids macOS's prompt for other apps' data, which a LaunchAgent cannot answer.

**Amendment · 2026-10-14 (mini02):** every discovery step has its own 3 s bound and the
whole discovery 10 s; a step that runs out is skipped and recorded, never awaited again
while its call is still pending. nectard (a service) tries the standalone app's
`/Library/Tailscale/ipnport` first, then lsof, and never lists the App Store group
container. Every other process keeps Tailscale's lsof first, then macsys, and lists the
container only when nothing else was found, in a child `ls` that is SIGKILLed and let go at
its bound. The result is cached per process with a 30 s → 5 min re-discovery backoff; a
401 from a reused discovery's endpoint (a stale proof) discovers again at once. **Why:** on mini02
nectard logged `status_timeout` 20 s after every start and never listened, while doctor from
ssh found the LocalAPI. lsof found no proof there, and the group-container `readdir` that
followed had no timeout: from a LaunchAgent, macOS can hold that read on a privacy prompt
nobody can answer, so the status read never settled and macsys, which works on mini03–07,
was never reached (a never-returning `readdir` reproduces exactly that). The listing is
Nectar's own addition: Tailscale's CLI never reads the container, so under launchd it can
only prompt or fail. macsys goes first there because it is two reads of fixed paths
without a child process and answers on every standalone-app Mac; on an App Store Mac it is
one quick ENOENT before lsof. CLI processes are not reliably told apart from nectard's
context (an agent started under a launchd-run daemon inherits the same privacy context),
so for them the listing moves behind macsys, where a standalone-app Mac never reaches it.
It runs in a child process because a `readdir` that is blocked in the kernel holds one of
Node's file-system threads, and Node waits for that thread on exit, even through
`process.exit`. The command would print its result and then hang, and nectard would hang
on SIGTERM. A child can be killed and unref'd, so the parent stays free to exit.

## D33 — `[deps]` postgres without Docker: one Nectar-owned local cluster per major, a role and database per env

**Chose:** a `provider` per postgres dep, `"docker"` or `"local"`, auto-detected when absent:
Docker when its probe succeeds, else local Postgres 13+ binaries found on the host (PATH,
Homebrew, Postgres.app, Debian/RHEL layouts, or `NECTAR_PG_BIN`), else `E_PLATFORM` naming
both. A dep keeps the provider and major it was created with until `--fresh`. The local
provider runs one cluster per major under `<NECTAR_HOME>/pg/<major>`, `initdb`'ed by Nectar
with its own superuser and generated password (0600), loopback-only TCP on a Nectar port, no
Unix socket and `scram-sha-256` for `127.0.0.1` as the only `pg_hba` rule. Each env and dep
gets a role and a database named `nectar_<env>_<dep>_<hash8>`, owned by that role, closed to
`PUBLIC`. A pinned major that has no local binaries uses the newest local major with a
warning. The cluster keeps running while any env record has a database in it and is stopped
once the last one is removed (`rm`, gc cold, reap). (SPEC §5.1.)
**Alternatives:** (a) install Postgres for the user (Homebrew, apt); (b) adopt a Postgres the
user already runs (Postgres.app's default server, a distro service) and create databases in
it; (c) one cluster per env from local binaries; (d) refuse a major mismatch, or a `strict`
key; (e) stop the cluster when no env is running, or never stop it; (f) the exact
`nectar_<env>` name the brief sketched.
**Why:** (a) the standing order is that Nectar installs nothing, and a package manager is the
user's choice. (b) Nectar would need that server's superuser and would be creating and
dropping things in a database it does not own; on metal-1 and the netcups other users'
clusters run beside it. Its own cluster under its own home is provably Nectar's, so teardown
cannot reach anything else. (c) is a process, a port and ~40 MB per env, which is what Docker
gives and what Mac minis without Docker should not pay; one cluster per major is enough
because envs are separated by role, ownership and revoked `PUBLIC` rights, and `--fresh` is
`DROP DATABASE … WITH (FORCE)`. (d) a review preview wants a database that works; Postgres
majors are compatible for what apps do, the warning names the mismatch, and a repo that must
have the exact version says `provider = "docker"`, which already pins the image, so a second
switch would only duplicate it. (e) "no env running" would stop the cluster on every gc
expire and race the next publish for no real saving: an idle Postgres costs tens of MB and
no CPU, and expired envs keep their data (gc expire leaves it, as with Docker). Stopping only
when no record has a database in it means it never runs for nothing, and the decision takes
the same per-major lock as start and create. (f) env names may contain `-`, dep names `-`
and `_`, and one env may have several postgres deps; `nectar_<env>` alone collides for two
deps, and plain character mapping collides (`x--a` + `web_db` vs `x--a-web` + `db`). The
hash keeps names unique and inside 63 bytes while the readable prefix still says whose it is.

## D34 — A per-node publishing pool for web and static previews, chosen by the publisher

**Chose:** a `pool` in the publishing node's `nectar.json` (`hosts`, `default_for` of `web`
and `static`, `prefer` of `first-healthy` or `least-loaded`). A publish without `--host` and
without `--local` is classified locally; web and static go to a pool host picked from each
host's listener hello, which now reports version, nectard, mesh rights, the `[deps]`
postgres provider, env counts and load. Skipped: hosts that do not answer, report nectard
down or `mesh: denied`, and, for `[deps] postgres`, report no provider (Docker first, then
local). Placement is sticky through `placements.json` on the publisher while the host is still in
the pool, and an env that already exists locally stays local, as does a static page in a
repo with uncommitted changes (a pool host would serve the commit, a local publish the
edit). Desktop, iOS and dev never leave the publishing node.
No usable host: publish locally and say why. `placed_on` and `placement_reason` are in the
result and the dry-run plan. `nectar pool ls|add|rm|check` manage and probe it. Also fixed:
`publish --host` of anything inside a repo ships `git archive` of the commit plus the
path inside it, and the target runs local detection on that commit; before, a repo with
an `index.html` and no recipe shipped its working tree as a static site. (SPEC §4.5, §4.6, §7.)
**Alternatives:** (a) a central scheduler (Queen or a coordinator nectard) that owns the
pool; (b) fail the publish when no pool host is usable; (c) treat a mesh-denied host as
usable and hand out its loopback URL; (d) stickiness by asking every pool host whether it
has the env (resolve) instead of a local record; (e) keep shipping a repo's working tree
for static repos and document it; (f) classify on the target only (ship first, decide there).
**Why:** (a) every node already has the listener, WhoIs and the allowlist; a scheduler is
another service to run and secure, and the pool is a per-node preference (the Studio
offloads, a mini need not). (b) a preview that lands on the Studio when the satellites are
down beats no preview; the reason says what happened, and `pool check` shows it. (c) a
placed preview is only for people on other machines, and a loopback URL on a satellite
reaches nobody. (d) the env name a host would use is known only after detection, a probe
of every host costs a round trip each, and the publisher already knows where it sent
things; the record is keyed by root commits so other Cells of the same repo stick too,
and a host that stops answering is re-placed rather than waited for. (e) `--host` is
documented as shipping the committed tree, and an uncommitted edit served on another
machine is a review of something nobody committed. Ignored build output still ships as
files, since that is the point of publishing `dist/`. (f) desktop/iOS/dev must stay local
before anything is shipped, and the dry run must show the placement, so the publisher
needs the classification anyway; the target still runs its own detection on the commit.

**Amendment (2026-10-14, the own host and in-repo static sites).** `pool add` refuses this
node itself, matched by tailscaled's host and MagicDNS names, short or full, and the
machine host name. `pool rm` matches names the same way. `ls` and `check` show a listed
own host as `excluded`, and placement no longer considers it: before, a healthy own entry
first in pool order kept the publish here instead of going to the next host. A static site inside a repo now
ships only its own path from the commit (`git --literal-pathspecs archive <commit> --
<path>`). The publisher refuses, naming the link, any symlink in what it ships that is
absolute or leads outside it. A recipe publish still ships the whole tree under the same
check, and the target's archive rules are unchanged.
**Alternatives:** (a) store the own host but mark it excluded; (b) let the target relax its
symlink rule for links outside the published path; (c) drop out-of-tree symlinks from the
archive silently.
**Why:** (a) a pool entry that never takes a publish shows the user something that isn't
so, so the publisher refuses it at the door, and an existing entry is shown as excluded
until it is removed. (b) the target's rules are the security boundary and stay as they
are. (c) dropping a link silently would publish a page that breaks on the target with
nothing to explain it. A static site never needed the rest of its repo. A link inside it
that leaves it would dangle on the target, so naming the link up front is the honest
answer.

**Amendment (2026-10-14, placement never fails on what it would ship).** With a pool and
no `--host`, a publish whose archive the publisher refuses before sending (a leaking or
absolute symlink, an uncommitted page, anything else that shipping step refuses) stays on
this node: `placed_on` is this host and `placement_reason` is `not shipped to <host>: <the
refusal>`, naming the links. Static and recipe publishes alike, and `--dry-run` shows the
same. An explicit `--host` still refuses with `E_USAGE`.
**Alternatives:** (a) refuse the placed publish too, as the previous amendment did;
(b) skip the refused links and ship the rest.
**Why:** (a) the user did not ask for another node, and a local publish of the same tree
works (a local static publish skips symlinks with a warning), so placement would turn a
working publish into a failure; this matches the uncommitted-page rule. (b) see (c)
above: a page that breaks on the target with nothing to explain it.

## D35 — Public previews through `nectar-relayd`, the single owner of relay state

**Chose:** a small Node service, `nectar-relayd`, on the relay host (src/relayd.ts,
installed by relay/install-relayd.sh as a hardened system service). Publishers call its
control port, the relay's Tailscale IPv4 on 8450, instead of running `nectar-relay` as
root over Tailscale SSH. relayd identifies each caller with tailscaled WhoIs on the raw
peer (the LocalAPI client of D32) and fails closed: no answer in 5 s, an error, no stable
node ID or MagicDNS name, a caller on the relay itself, an unreadable allowlist or a node
not on it is 403. It enforces the rules of design/public-and-cloud.md §1 itself: a
stable-node-ID allowlist; an upstream on the caller's own MagicDNS name and a port in
8443–8542; owner-checked PATCH, DELETE and rotate; names it mints (`<sanitized
app-branch>-<8 hex>`, reserved words refused); ungated routes only for nodes on a
separate list, empty by default; 30-day caps (7 ungated); relay-wide and per-node kill
flags that remove routes and refuse new ones until lifted. It keeps state in one JSON
file, renders Caddy's file-per-route import (D21) from it, and reloads Caddy by touching a
stamp a systemd path unit watches, so relayd runs unprivileged. `nectar-relay` on the box
becomes its admin client over a 0600 Unix socket and keeps `add`, so the Studio's
Tailscale SSH path works until it moves. Clients: `control: "relayd"` targets,
`nectar publish --public`, `expose --rotate`, expose/unexpose through nectard, a tokenless
`url` with the secret fields named in `secret`, and gc's hourly sync, which PATCHes
expiry, never recreates a route and marks it revoked on 404 or a tombstone. Slice 1
keeps the basic-auth password gate; the verify listener (loopback 8451) exists for slice
2's link token. (SPEC §4.7, §7, §9.1.)
**Alternatives:** (a) keep root over Tailscale SSH and give every pool host an SSH rule;
(b) a per-host API key file; (c) tags on pool hosts for identity; (d) let the caller pick
the subdomain, as `nectar-relay add` did; (e) run relayd as root and call
`systemctl reload caddy`; (f) a database instead of a state file.
**Why:** (a) makes every pool host root on the public box, and it already fails from
metal-1. (b) hands out secrets that Cells could read; WhoIs needs none. (c) tagging strips
a node's user identity and breaks the user-based grants hive relies on; the ACL uses host
aliases instead (Project design/relayd-acl-diff.md). (d) lets one host take over or
squat another's URL and pick phishing names. (e) puts a tailnet-facing process at root;
the path unit keeps the privilege in systemd. (f) one operator's few hundred routes fit
in a file written atomically, like the route files themselves.

## D36 — Shared static previews use random path prefixes

**Decision (2026-10-24):** New static previews share one read-only server per Nectar
state home and one tailnet Serve entry. Their URL is
`https://<machine>:<shared-port>/s/<env>/<128-bit-random-token>/`. The token survives
republish. The singleton owns its PID and ports in `shared-static.json`; env records
carry only `static_route`, their files, URLs and the existing TTL. Its loopback port
comes from the OS outside configured env ranges; the shared tailnet port is allocated
outside those ranges, scanning from 10240. Port 443 remains untouched. A machine-wide
startup lock and a private health identity prevent duplicate servers in concurrent
publishes. Nectard restores a dead singleton on its existing port, or moves only the
loopback port if occupied while preserving the canonical tailnet URL. Three failed
health probes precede hung-server recovery; a command-line identity check prevents
signalling a recycled PID. Matching tailnet entries need no configuration write.

**Alternatives:** Per-preview ports exhaust a finite range and retain a listener per
preview. Per-preview ts.net subdomains have no wildcard DNS/certificate support. A
shared path works with relative assets and does not require new tailnet infrastructure.
Apps must build with a relative asset base or configure their mount prefix; origin-root
asset references and origin-root SPA history routers require that configuration. The
prefix is unguessable but is not a separate browser origin or an authentication system.

**Compatibility:** Existing static records with `serve` keep their old process, ports
and URLs on republish and restart until retired by the existing lifecycle. This avoids
breaking proof links. New static publishes (including static-server recipes) do not
allocate per-preview ports/processes or enter memory admission. Stop affects only the
record. Each request reads and validates that record's token, status and expiry, returns
410 with an explicit message after expiry, and leaves cleanup to GC's expire/cold/reap.
Shared static routes do not enter the dynamic proxy hub. Public relay origin validation
currently accepts only origin URLs in the old port range; shared paths require a relay
contract update before public exposure can support them.
