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

## D4 — `preview_url` is always the tailnet URL; refs are machine-bound

**Chose:** the packet's `preview_url` carries `https://<host>.tailca9707.ts.net:<port>`;
canonical refs are `nectar://<host>/<env>`; there is no global registry — envs live and die
on their publishing machine.
**Alternatives:** (a) carry the portless localhost URL and teach the desk to rewrite;
(b) a mesh-wide nectar registry with location-transparent refs (`nectar://kontiki--branch`)
and per-machine resolution.
**Why:** (a) only works when reviewer and publisher share a machine — the actual fleet is a
Mac reviewing work from linux/mini hosts. Tailnet URLs work from every device including the
publisher (tailscaled hairpins), so one string serves all consumers, which is what a
single-string schema field demands. (b) is a distributed system (sync, conflict, partition
behavior) bought before there's ever been a single cross-machine collision; the host in the
ref costs nothing today (packets already know their machine implicitly via the bee) and F9
makes offline hosts a visible, attributable failure instead of a registry mystery. Revisit
if envs ever need to migrate hosts.

## D5 — State is file-per-env JSON, not SQLite

**Chose:** `~/.nectar/envs/<name>.json`, atomic rename writes, per-env lockfiles for gc.
**Alternative:** SQLite (Forum's choice).
**Why:** Forum is a ledger — multi-entity, queried, append-only events. Nectar's state is a
dozen tiny records with single-writer-per-env semantics and no cross-record queries beyond
readdir. Files are `cat`-able during incident debugging, diffable, and concurrent publishes
of different envs can't contend. If events/history are ever needed, that's Forum's job —
nectar deliberately keeps no history beyond evidence files.

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
node — kontikicms/mbtz); scrubbed child env + hem-mediated test secrets; explicit statement
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
