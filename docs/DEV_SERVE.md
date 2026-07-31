# DEV_SERVE — dev envs: crystallized worktrees, launch-on-open

Status: design draft (2026-07-31). Companion to SPEC.md; consumer deltas for Apiary at the end.

## 1. Problem

Reviewing 10–15 parallel desktop tracks today means either launching one dev app per
track by hand, or merging everything to main and promoting one build — cheap to think
about, but review effectively happens post-merge. The web mode doesn't have this
problem because of its division of labor: the agent pays the warm-up before declaring
review-ready, the packet carries a stable ref, and the reviewer has one dumb "open"
action. Desktop's only artifact today is a testpack (minutes to pack, slow to open),
and the naive fix — keep a dev instance running per branch — fails a hard constraint:
**no fleet of background Electron apps on the reviewer's machine.**

The resolution: warmth lives **on disk, not in a process**. The agent registers a hot
worktree (deps installed, native modules built, bundler caches primed — "crystallized").
No process runs. When the reviewer opens the claim, nectar launches the dev instance
from that worktree in seconds, and stops it when the review is done. Steady state on
the review machine: the daily driver, one pinned main bench, at most one transient
review instance.

## 2. Concept: the `dev` mode

A fourth mode alongside `web | desktop | ios`: env name `<app>--<branch>--dev`.

- **desktop env** = a packed artifact. Durable, portable across the mesh, slow.
- **dev env** = a registered hot worktree + launch command. Machine-pinned, near-free
  to hold, seconds to open. No artifact, no port, no URL — the "preview" is a native
  window plus (optionally) a control handle the consumer app exposes.

The two are complementary rungs of one ladder (§8), not alternatives.

## 3. Recipe

```toml
[dev]
run   = "pnpm dev"                       # required; launches the dev instance
kind  = "electron"                       # required; "electron" only in v0
warm  = "pnpm -F @apiary/desktop native:build"   # optional; run at publish to prime caches
ready_timeout = "60s"                    # optional; default 60s (process alive + ready signal, §5)
```

Same execution rules as other recipes: shell strings via `runShell`/`spawnDetached`
(src/commands.ts), scrubbed environment plus `NECTAR_ENV`, `NECTAR_ENV_DIR`, and (for
`run` only) `NECTAR_OPEN_TARGET` (§7). Profile/state isolation is the app's job, keyed
off `NECTAR_ENV_DIR` — nectar stays generic (Apiary: derive `APIARY_USER_DATA` and
`APIARY_HIVE_DIR` from it in a `scripts/nectar-dev.sh` wrapper).

## 4. Registration (`nectar publish --mode dev`)

The agent runs this before marking the packet review-ready — typically right after its
own verification launch, so every cache is already primed:

1. Worktree: `--worktree <path>` borrows the agent's checkout (D2 semantics — never
   reset, never deleted), else `prepareWorktree()` as today. Borrowed is the expected
   default for agent flow.
2. `installDependencies()` (existing `install_hash` fast path).
3. `warm` command, if present.
4. Optional `--verify`: launch `run`, wait for ready, quit. Proves the claim opens.
5. Record written with status **`warm`** (§6). No process left behind.

Registration cost after a normal agent verification cycle: seconds. Republish on new
commits is the same cheap path (reset preserves `node_modules/` and, new, a
configurable cache allowlist — `.vite`, `out/`, native build dirs — via the existing
`git clean -fdx -e …` mechanism in src/git.ts).

## 5. Open (`nectar open <env> [--target <string>] [--keep]`)

`resolve` stays **side-effect-free w.r.t. processes** — hard requirement: consumers
poll it (Apiary's forumPreview polls on a 10 s cache just from rendering a packet
pane). Resolve on a dev env reports `warm` (plus staleness info) and touches TTL, as
today. **`open` is the launch verb:**

- env `serving` → focus/no-op; deliver `--target` (§7); return handle.
- env `warm` → `spawnDetached(run)` from the worktree, wait for ready, record
  `serve {pid, pgid}` (no ports), status → `serving`, deliver `--target`.
- env `cold`/`expired` → error with the ladder hint (testpack rung, or republish).
- `--keep` pins the instance: exempt from idle-stop (§6). This is how the standing
  main bench is expressed — `nectar open apiary--main--dev --keep` — the "long-running
  dev app" is just a pinned dev env, not a separate mechanism.

Ready signal for `kind = "electron"` in v0: process alive + the consumer-side ready
file (§7) appearing, with `ready_timeout` as the cap. No port probing.

`nectar stop` works unchanged (`stopRuntime` learns to kill the pgid of a dev serve);
status returns to `warm`, not `stopped` — the registration outlives the process.

## 6. Lifecycle

New status **`warm`**: registered, worktree hot, no process. Machine:

```
publishing → warm ⇄ serving        (open / stop, idle-stop, crash→crashed→open again)
warm → expired → cold → reaped     (existing gc clocks; cold trashes nectar-owned worktrees)
```

- `serving` keeps its web-mode meaning (process up). Desktop-testpack's overloaded
  "serving = artifact exists" is unchanged (pre-existing wart, out of scope).
- **Idle-stop** (new gc transition in src/gc.ts): `serving` dev envs with no open/focus
  activity for `idle_stop_ms` (default 45 min) → kill process → `warm`. Clock is a new
  `last_opened_at`, **not** `last_touched_at` — resolve-polling from an inbox must
  never keep a process alive (it re-arms TTL today, which is fine for the *record*,
  wrong for the *process*). `--keep` sets `pinned: true` and exempts the env.
- Consumers should stop eagerly on verdict (`nectar stop`) rather than lean on the
  idle reaper; the reaper is the backstop.
- Disk tier: unchanged gc — `expired` +24 h → `cold` (worktree trashed unless
  borrowed), +14 d → reaped. A cold dev env degrades the claim to the testpack rung
  if a sibling `--desktop` env exists.

## 7. The target channel (no URL, so: a mailbox)

A web preview communicates "where to look" in the URL. A dev env needs an equivalent
that works without any gateway/auth machinery in v0:

- `open --target <string>` writes `${NECTAR_ENV_DIR}/open-target.json`
  (`{target, opened_at, nonce}`) before/after launch; also exports
  `NECTAR_OPEN_TARGET` into `run`'s environment for the cold-start case.
- The consumer app fs-watches that file (and reads the env var at boot), interprets
  `target` itself (Apiary: a command id + args → renderer command registry), and
  writes `${NECTAR_ENV_DIR}/ready` once it's up — which doubles as the §5 ready
  signal.

This file mailbox is deliberately dumb: same-machine, no principals, no sockets.
A richer control channel (Apiary's agent gateway with a trusted-local principal) can
replace it later without changing the nectar contract — `open` still just delivers a
target string.

## 8. The ladder (reviewer contract)

Resolve fan-out over modes for `app--branch` (existing `MultiResolveResult`) gives the
degradation ladder for free:

1. `--dev` env `serving` → focus + target. Instant.
2. `--dev` env `warm` → open launches from hot worktree. ~10 s.
3. `--dev` cold/absent, `--desktop` env present → testpack rung (today's path).
4. Nothing → diff + evidence only.

Packet side: `packet_hint` / `packetFields()` (src/service.ts:823) gains the dev ref;
desktop currently returns `preview_url: null` — a dev env instead contributes
`testpack_ref`-style `dev_ref: nectar://<host>/<app>--<branch>--dev`.

## 9. Mesh caveat

Dev envs are publisher-pinned, like web envs: the process can only run where the
worktree lives. Remote `resolve` already round-trips over `tailscale ssh`
(remoteNectar, src/tailscale.ts:163); remote `open` on a dev env is possible but
launches a window on the *publisher's* display — not useful for review. Cross-machine
review falls to the testpack rung by design. (Same-machine is the dominant case: the
reviewer's daily driver and the agents' worktrees are on the same box.)

## 10. Agent cookbook

- **On main** (most tracks): don't publish a dev env. Confirm `apiary--main--dev` is
  registered (the pinned bench tracks main's working tree via HMR; a merged change is
  live in it within seconds). Put the test target on the packet. Done — zero cost.
- **On a branch**: after verifying your work in the app, quit it and run
  `nectar publish --mode dev --worktree $(pwd)`; put the returned `dev_ref` + test
  target on the packet. Optionally also pack a testpack for durability if the review
  may be picked up late or on another machine.
- Either way: evidence (captures/recordings) on the packet regardless — most packets
  should be approvable without any launch.

## 11. Implementation map

Nectar (repos/nectar):
- `src/types.ts` — `Mode` + `"dev"`, `EnvStatus` + `"warm"`, `EnvRecord` +
  `{pinned?, last_opened_at?, dev?: {run, kind, warm_hash?}}`, `ResolveResult` deltas.
- `src/recipe.ts` — `[dev]` section (`rejectUnknownKeys`, `selectMode`).
- `src/service.ts` — `publishDev()` (skips pack; reuses checkout/install), `open` dev
  branch (spawn/focus/target), `stopRuntime` pgid kill, `isQualified` suffix `--dev`
  (:908), `publish()` dispatch (:142), `packetFields` (:823).
- `src/gc.ts` + `test/gc.test.ts` — idle-stop transition, `warm` handling.
- `src/git.ts` — cache-preserve allowlist beyond `node_modules/`.
- `src/cli.ts` — `--mode dev`, `open --target/--keep`, help text.
- Tests mirroring `recipe.test.ts`, `cli-contract.test.ts`, `integration.test.ts`.

Apiary (repos/apiary):
- `scripts/nectar-dev.sh` — `run` wrapper: derive `APIARY_USER_DATA`/`APIARY_HIVE_DIR`
  from `NECTAR_ENV_DIR`; write `ready` file; watch `open-target.json` → dispatch into
  the renderer command registry.
- `nectar.toml` — `[dev]` section.
- `apps/desktop/src/main/index.ts:2046` — implement `openDesktopTest` as
  `nectar open <dev_ref> --target … --json` (replacing the TODO stub); eager
  `nectar stop` on verdict.
- `apps/desktop/src/main/forumPreview.ts` — map dev-env resolutions
  (`warm`/`serving`, no URLs) into `PreviewResolution`; test-tab UI: "Open in bench
  (~10 s)" card instead of `DeadPreviewCard` for desktop packets.
- `packages/core/src/review.ts` + `packages/adapters/src/forum.ts` — `test_target`
  and `dev_ref` fields through the ingestion allowlist (`mapForumPacket`). Forum-side
  passthrough lives in the forum repo.

## 12. Open questions

- Mode name: `dev` (short, generic) vs `desktop-dev` (explicit). Draft assumes `dev`;
  if `[dev]` ever grows non-electron kinds the short name ages better.
- Should `open` on a `warm` env whose commit is behind the packet's commit warn, or
  is HMR-off-worktree-state always authoritative? Draft: report staleness in resolve
  output (`commit` vs packet), let the consumer decide.
- Idle-stop default (45 min?) and whether focus events (vs only opens) should bump
  `last_opened_at` — needs the consumer to report activity, or keep it opens-only.
- Does the pinned main bench belong in nectar (`--keep`) or should Apiary own its
  bench lifecycle entirely and nectar only ever see branch envs? Draft: nectar owns
  it — one mechanism, and `packet_hint` for main-track packets can then reference
  `apiary--main--dev` uniformly.
