# Nectar — specification

*v1 draft · 2026-07-18 · status: spec complete, nothing built. Companion docs:
[V0.md](V0.md) (the first slice), [DECISIONS.md](DECISIONS.md) (why it's shaped this way).*

## 1. Mission

Reviewing agent work means **testing** it, and testing must cost seconds, not minutes.
Nectar is the tool an agent calls once, at review-ready, that turns a branch into a
tasteable surface on the mesh and returns small stable references. Everything downstream —
the Forum packet, the Apiary review desk's Test tab, a reviewer bee, Tormod on any tailnet
device — consumes those references without knowing how the surface was produced.

The contract in one sentence: **`nectar publish` in a repo on any mesh machine produces a
reference that `nectar open` (or a browser, or the desk) can consume from any other mesh
machine, until it expires.**

Nectar deliberately lives outside Apiary. Apiary renders; Forum records; Nectar serves.
Agents of any harness call it directly; the packet carries only strings.

## 2. Non-goals

- **Not CI, not staging, not deploy.** Nectar environments are disposable review surfaces
  with TTLs. Nothing nectar serves is ever the path to production.
- **Not a packet ledger.** Nectar never writes to Forum, never creates packets, never knows
  packet state. References flow through the publishing agent.
- **Not a review UI.** No web dashboard, no queue. `nectar ls` is the whole "UI"; Apiary is
  the surface.
- **Not a build system.** Recipes name the repo's existing commands (`pnpm dev`,
  `pnpm dist:testpack`); nectar orchestrates, it does not compile.
- **Not multi-tenant infrastructure.** One operator's tailnet, machines that already run
  agents with full user permissions. No sandboxing story in v0/v1 (§9.3 is honest about
  this).
- **Not public.** Nothing nectar serves ever leaves the tailnet. There is no `--public`, and
  `tailscale funnel` is never invoked.

  *v0.2 amendment · 2026-07-19 (D19):* softened from absolute to **not public by default**.
  `nectar expose <env>` is a designed explicit, per-env, gated-by-default escalation through
  operator-configured targets (cloudflare-tunnel / ssh-tunnel / vercel-deploy — see
  [V0.2.md §5](V0.2.md)). Publishing itself remains tailnet-only, and `tailscale funnel`
  remains forbidden — exposure never rides funnel, so the doctor invariant stands.

## 3. Vocabulary and system overview

- **env** — one published test environment: a checkout + artifacts + (maybe) a serving
  process + a record. Identified per-machine by the mode-qualified **name**
  `<app>--<branch-slug>--<mode>` and a short random **eid** (`e7f3`). One env per
  (app, branch, mode) per machine; republish upserts. The env belongs to the source it was
  published from (`repo`: the git toplevel, or the static source path). Publishing
  another source into an existing name is `E_USAGE` naming that source and suggesting
  `--name`, and the existing env is untouched. A git worktree of the same repository
  (same `--git-common-dir` as the recorded `repo` or as Nectar's own worktree of the env)
  counts as the same source, so the recorded worktree may be removed afterwards. So does
  another clone of the same repository (a second Cell, or the same Cell after a move): same
  normalized `remote.origin.url` and a shared root commit, with the recorded branch or with
  the recorded `repo` gone. A different repository that only names the same origin is
  refused. Replace refs and grafts are ignored (DECISIONS D26 amendment).
- **app** — the repo's short name, from `--name`, else the recipe (`name` in `nectar.toml`,
  `package.json`, `[project].name`), else the repo directory name.
- **branch-slug** — the branch with `/` → `-` (`agent/coupons-stack` → `agent-coupons-stack`),
  lowercased, `[a-z0-9-]` only. The branch is `--branch`, else the checked-out branch. A
  detached HEAD takes a branch whose tip is HEAD, else a branch containing HEAD (local
  before remote-tracking, then by name), else a per-session slot `cell-<session>` when the
  publisher is a Honeybee session, else `detached-<8-hex sha>`, and publishes HEAD's
  commit. `<session>` is the publisher's `HIVE_BEE` (name), else `HIVE_BEE_ID`, slugified
  and cut to 40 characters; through nectard it is the caller's, never nectard's own. So
  an agent that commits past every branch keeps one env and URL across its publishes.
  `branch_source` in the plan, result and record says which (`flag`, `head`, `contains`,
  `session`, `detached`).
- **mode** — `web | desktop | cli | backend | ios`. Matches the packet `kind` vocabulary
  except `code`: a `code` packet is precisely one with **no** nectar env. (`ios` does not
  exist in the desk contract's kind vocabulary yet — coordination item, see §6.5 and open
  question 9.)
- **ref** — the canonical cross-machine handle: `nectar://<host>/<env-name>`, where `<host>`
  is the machine's tailnet hostname (`builder-1`). Refs are resolved by `nectar resolve`
  and consumed by `nectar open` / `nectar shell` on any mesh machine. Emitted refs are
  always mode-qualified. `nectar resolve <app>--<branch-slug>` accepts the mode-less base
  name as a discovery form and returns every mode record for that pair.

**v0 amendment · 2026-07-18:** the reviewed `<app>--<branch-slug>` identity could not
represent simultaneous web and desktop records, which `embed_url = "web"` requires. The
coordinator ruled that mode is part of the storage identity, file key, and emitted ref now,
while the greenfield format has no compatibility burden.
- **testpack** — the standard packaged desktop build (§6.2).
- **recipe** — the checked-in `nectar.toml` telling nectar *how* to serve/pack/seed this
  repo (§5).
- **pack store** — `~/.nectar/packs`, served read-only to the tailnet on port 8440.

Flow:

```text
bee finishes work on branch
  └─ nectar publish --json                    (on the machine where the bee runs)
       ├─ checkout branch into nectar-owned worktree
       ├─ run recipe step for the mode (serve / pack / provision / seed+smoke)
       ├─ expose on mesh (tailnet port) + locally (portless name)
       └─ emit { urls, ref, evidence } → agent puts strings on the Forum packet
reviewer (desk or human, any machine)
  └─ preview_url in an iframe / nectar open <ref> / nectar shell <ref>
gc (hourly, run by nectard)
  └─ expire → stop → cold → reap
```

## 4. Architecture

### 4.1 CLI-first; `nectard` supervises behind it

`nectar` is a single CLI. Long-running serve processes are spawned detached (`setsid`: own
session and process group, stdio to log files), so they outlive the CLI and the agent that
published them; their PIDs live in the env record; liveness is re-derived on every read
(`ls`, `show`, `resolve`, `expose`, dev `open`) from PID/process group + port (§4.4
"Liveness").

**Amendment 2026-10-14 (DECISIONS D24):** the optional supervisor `nectard` now exists. It is
`nectar daemon run`, installed as a user-level service with `nectar daemon install`
(launchd agent on macOS, systemd `--user` unit on Linux; §4.5). Every command still works
without it; the daemon only calls the same code the CLI calls.

### 4.2 On-disk layout (per machine)

```text
~/.nectar/
  envs/<name>.json          # <name> includes --web/--desktop; source of truth
  work/<name>/              # nectar-owned git worktree/clone of the branch, or a static site's copy
  work/<name>.deps/         # [deps] state (§5.1): compose.json + secrets.json (0600), sqlite copies
  pg/<major>/               # local-provider Postgres cluster (§5.1): data/, superuser.password (0600), cluster.json, server.log
  packs/<name>/             # testpacks + any served artifacts (tailnet :8440 root)
    acme-desktop--agent-coupons-stack.testpack.zip
  evidence/<name>/          # shell recordings, smoke output, screenshots
    shell-20260718T1204.cast
    smoke-20260718T1204.txt
  logs/<name>/serve.log     # dev-server stdout+stderr, rotated at 10 MB
  inbox/<key>/<dir>/        # sources other nodes shipped with publish --host (§4.5); removed with their last env
  nectar.json               # machine config: port ranges, quotas, tailnet name cache, pool (§4.6)
  placements.json           # where the pool put this node's publishes, for sticky republish (§4.6)
```

State is **one JSON file per env**, written atomically (temp + rename). No SQLite: records
are tiny, single-machine, and file-per-env means concurrent publishing agents never contend
on a shared writer (DECISIONS D5). `nectar ls` is a readdir.

**v0 amendment · 2026-07-18:** `<name>` is `<app>--<branch-slug>--<mode>`. An embedded
desktop publish creates/updates two independent files (web and desktop), each with its own
lifecycle, and composes the publish envelope's packet fields from both.

### 4.3 The env record

```json
{
  "eid": "e7f3",
  "name": "acme--agent-coupons-stack--web",
  "mode": "web",
  "app": "acme",
  "repo": "/home/you/Projects/acme/repos/acme",
  "branch": "agent/coupons-stack",
  "commit": "8f3ab21d",
  "worktree": "/home/you/.nectar/work/acme--agent-coupons-stack--web",
  "status": "serving",
  "serve": {
    "cmd": "pnpm dev",
    "pid": 48213,
    "pgid": 48213,
    "upstream_port": 4117,
    "portless_name": "agent-coupons-stack.acme",
    "tailnet_port": 8444,
    "proxy_port": 4118
  },
  "urls": {
    "local": "https://agent-coupons-stack.acme.localhost",
    "mesh": "https://builder-1.tailnet.ts.net:8444"
  },
  "ref": "nectar://builder-1/acme--agent-coupons-stack--web",
  "published_at": "2026-07-18T12:04:11Z",
  "expires_at": "2026-07-21T12:04:11Z",
  "last_touched_at": "2026-07-18T12:04:11Z",
  "publisher": { "hive_bee": "drone-11", "hive_session": "CL.9fc", "user": "tormodhaugland" },
  "packet_hint": "fp-0244",
  "evidence": ["evidence/acme--agent-coupons-stack--web/smoke-20260718T1204.txt"]
}
```

`publisher` is stamped from `HIVE_BEE` / hive session env vars when present — lineage for
free, no hive dependency. `packet_hint` is optional operator-supplied string; nectar never
reads Forum.

### 4.4 Env lifecycle

```text
publishing → serving → expired → cold → (reaped)
                │
                ├→ unhealthy        (process alive, port silent; flips back on answer)
                ├→ crashed          (serve process died; record + logs kept)
                └→ stopped          (explicit nectar stop; worktree kept)
```

- **publishing** — checkout + build/pack running. Failure here → the publish command errors
  and the partial env is recorded as `crashed` with logs (so a bee's failed publish is
  inspectable, not vanished). Once runtime allocation begins, failure rollback kills the
  detached process group, removes the allocated Tailscale Serve entry, clears `serve` and
  both URLs (releasing the port claims), and stores `failure: { code, message, failed_at,
  log_tail }` on the crashed record.
- **serving** — process up (web/cli/backend-with-shell) or artifacts available (desktop).
- **expired** — TTL passed. `gc` transition: stop process, remove tailscale-serve entry,
  keep worktree + packs + evidence. Env is revivable with `nectar publish` (fast path:
  worktree exists).
- **cold** — 24 h after expiry: worktree deleted. Packs and evidence persist to their own
  quotas (§10).
- **unhealthy / crashed (liveness)** — see "Liveness" below. Neither is sticky while the
  record still holds its `serve` block.
- **reaped** — record deleted after 14 days cold. Evidence referenced from packets should be
  copied out by then (Forum owns long-term evidence retention; nectar is not an archive).

#### Liveness

Every read re-probes an env whose status is `serving`, `unhealthy` or `crashed` and that
still has a `serve` block (`src/liveness.ts` `probeLiveness`, reusable by `nectard`):

- `upstream_port` answers on loopback → `serving` (`reason: port_open`), even when the
  record said `crashed` or the recorded PID is gone. Exception: an env nectard gave up on
  (`failure.code` `E_PORTS` or `E_CRASH_LOOP`) keeps `crashed` and its failure; the probe
  result is shown in `liveness` but never written back, because whatever answers on that port
  is not the env's process. `ls` rows carry `failure` (the code, or `null`).
- PID or its process group alive, port silent after retries (300/600/1200 ms timeouts with
  150 ms backoff, ≈2.4 s budget) → `unhealthy` (`port_unresponsive`). Still holds its port,
  counts toward quota, needs `rm --force`.
- Process and group gone, port silent on one probe → `crashed` (`process_exited`).
- No `upstream_port` → process alone decides (`process_alive` / `process_exited`).

The result is stored on the record as `liveness: { state, reason, checked_at, pid_alive,
port_open }` and returned by `ls` (per row), `show` and `resolve`. The record is rewritten
only when status or reason changes (best-effort lock; a publish in flight wins). Crashed
records from a failed publish or orphan cleanup have no `serve` block and stay `crashed`.
`gc`'s dead-Serve-proxy check uses the same port retries before tearing down an env. `gc`'s
expire and cold transitions drop the stale `liveness` field.

#### Lifetime

TTL default **7 d** for every mode, per-publish `--ttl 12h|30d`. Viewing an env is
touch-on-view: `nectar open`, `nectar resolve` and `nectar show <env>` (and desk render, which
calls `nectar touch` or `resolve` on view) set `expires_at` to now + the env's own TTL, so a
preview under review never runs out. `nectar ls` does not touch. While `nectard` runs, a
browser opening the mesh URL touches too: nectard's per-env proxy (§4.5) sees each page
navigation (`GET` with `Sec-Fetch-Dest: document`/`iframe`, or without fetch metadata an
`Accept` that includes `text/html`; assets, fetches and HMR never count) and touches the env
the same way, at most once per env per 5 min, after forwarding and without waiting for it.
Without nectard the mesh URL points straight at the app and only the verbs touch. Active review never
gets reaped mid-session: `gc` skips envs touched in the last 6 h. Dev envs keep their
separate 45 min idle-stop process clock (DEV_SERVE §6); touch-on-view also records the last real HTTP request and moves the record's
expiry, never the process clock.

### 4.5 `nectard`

One process per machine (per `NECTAR_HOME`, guarded by `~/.nectar/nectard.pid`). It manages
**only Nectar's own envs**: it reads `envs/*.json` and acts only on PIDs, process groups and
`tailscale serve` ports that a record names. It never scans the process table for other
work. (The hourly gc it runs keeps gc's existing rule: it turns off Serve entries in Nectar's
tailnet port range whose loopback target is dead, §10.2.)

- **Shared static.** Each sweep ensures the singleton in §6.1.1 is healthy when
  any unexpired static route is serving, restores it on its recorded loopback port after
  exit, and reasserts its one tailnet entry without changing route tokens.
- **Which envs.** `mode: web` envs (recipe and legacy static, §6.1.1) whose status is `serving`,
  `unhealthy` or `crashed`, that still hold a `serve` block, are not past `expires_at`, and
  are not given up (`failure.code` `E_CRASH_LOOP` or `E_PORTS`). `stopped`, `expired`, `cold`, `warm` dev envs,
  desktop and ios envs are left alone.
- **Liveness, every 30 s** (`--interval`). It calls `probeLiveness`. `crashed`
  (`process_exited`) → revive. `unhealthy` → restart after 3 consecutive unhealthy probes:
  SIGTERM/SIGKILL the recorded process group, but only when that process still carries the
  env's `NECTAR_ENV` (read from `/proc/<pid>/environ` on Linux, `ps eww` on macOS), so a
  recycled PID is never signalled; then revive. One timer, no overlap: the next
  cycle is scheduled after the previous one finishes.
- **Revive** (under the env lock, only if the record's PID is still the one probed): re-run
  `serve.cmd` in the env's work dir with the recipe's env plus `PORT=<upstream_port>`,
  `NECTAR_ENV`, `NECTAR_ENV_DIR`, detached like publish. Static envs get the static-server
  command re-derived from the running install, so a reinstall or node upgrade that moved the
  recorded absolute paths does not break revival. It waits for HTTP 200 at `ready_path`,
  then re-asserts `tailscale serve --https=<tailnet_port>` so the mesh URL stays the same,
  stamps `serve.started_at`, and sets `serving`. An env with `[deps]` postgres first runs
  `docker compose up -d --wait` on its own project (§5.1) and gets its dep vars again; a dep
  that does not come up marks the env `crashed` with `E_DEPS` and spawns nothing.
- **Port taken.** If the env's process is gone but something else answers on its upstream
  port, or the port is held when it wants to revive, nectard spawns nothing and signals
  nothing. It removes the env's own `tailscale serve` entry (so the mesh URL never fronts an
  unrelated process), marks `crashed` with `failure.code: E_PORTS`, and stops supervising the
  env. A republish allocates a free upstream port and keeps the tailnet URL. The same rule
  means nectard cannot supervise a serve command that forks its server out of the recorded
  process group and exits (`setsid -f …`, `docker compose up -d`): the answering port looks
  foreign and the env is given up. Such recipes are already outside Nectar's lifecycle
  (`stop`/`rm` cannot reach the orphan), so serve commands should run the server in the
  foreground, ideally with `exec`.
- **Backoff and crash-loop cap.** Revives of one env are spaced at least 10 s × 2^(n−1)
  apart. After 3 revives within 10 minutes the next death marks the env `crashed` with
  `failure.code: E_CRASH_LOOP`, removes its `tailscale serve` entry, and stops trying. The
  record keeps its `serve` block so a republish gets the same ports and URL; republish
  clears the failure.
- **Restore on start (after a reboot).** At start it sweeps every supervised env. An env whose
  serve was started before the machine booted (`serve.started_at`, else `published_at`) is
  revived without signalling its recorded PID, which after a reboot may belong to an
  unrelated process. Envs that are still alive get their `tailscale serve` mapping
  re-asserted. If Tailscale is not up yet, re-assertion is retried every cycle until it is.
- **gc hourly** (`--gc-interval`): the same `nectar gc` (§10.2), run once at start and then
  after the liveness cycle once an hour has passed.
- **Fronting proxy (touch on HTTP view, D25).** Inside the nectard process, one small
  `node:http` reverse proxy per web env listens on `127.0.0.1:<serve.proxy_port>` and
  forwards to the app's own loopback origin (`urls.local`). The chain becomes
  `tailscale serve --https=<tailnet_port>` → `127.0.0.1:<proxy_port>` → `127.0.0.1:<upstream_port>`.
  It fronts every `mode: web` env that holds a `serve` block with both ports, is
  `serving`/`unhealthy`/`crashed`, and is not given up. `proxy_port` is a third per-env port
  from the upstream range, allocated under the ports lock the first time nectard fronts the
  env and kept across republish and revive. The tailnet port and mesh URL never change.
  Requests, response streams (SSE), request bodies of any size and WebSocket/HMR upgrades
  pass through unchanged, `Host` included. While the app is down the proxy answers 502.
  The proxy only touches the env (§4.4). Liveness still probes `upstream_port`, so
  `ls`/`show`/`resolve` report the app's own health, not the proxy's.
  - Mapping. Nectar points the Serve entry at the proxy only after the proxy has answered
    a probe naming its env and the env's current upstream port (`x-nectar-proxy` header).
    Otherwise it points the entry at the app directly. Publish, revive and mesh
    re-assertion all apply this rule. A new or older env is adopted on nectard's next
    sweep, at most one interval later.
  - Dead proxy. A clean nectard stop (`systemctl --user stop`, `launchctl bootout`,
    `nectar daemon uninstall`, SIGTERM/SIGINT) first points every fronted env back at its
    app, then closes the listeners. If nectard is killed outright, the service manager
    restarts it (5 s on systemd, launchd's KeepAlive throttle on macOS) and it re-opens
    every listener on its recorded port at start. Meanwhile `nectar gc` (any caller)
    treats a Serve entry whose target is an env's dead `proxy_port` while the app still
    answers as a fallback case. It points the entry back at the app (orphan report row
    with `direct`) instead of tearing the env down.
  - If a proxy port is taken when nectard tries to listen, it drops that `proxy_port` and
    allocates a fresh one on the next sweep. The env is served directly in the meantime.
- **Control socket (publishing from Cells, D29).** Agents in Honeybee Cells cannot write
  `~/.nectar`, so nectard does the writing for them. It listens on
  `~/.config/nectar/nectard.sock` (`NECTAR_SOCKET` overrides it): HTTP/1.1 on a 0600 Unix
  socket in a directory that nectard creates with mode 0700 and refuses if it is not owned
  by the user or is writable by group or others. A stale socket is replaced only when
  nothing answers on it. If it cannot listen (another nectard holds the socket), nectard
  logs `control_unavailable` and keeps supervising.
  - `GET /v1/hello` → `{api: 1, ops, nectar_home, pid}`.
  - `POST /v1/<op>` with `op` one of `publish`, `ls`, `show`, `resolve`, `touch`, `stop`
    and `rm`. The body is `{nectar_home, caller: {cell?, hive_bee?, hive_session?}, args}`.
    `args` uses the CLI's option names (`publish`: `path` (absolute, required), `mode`,
    `branch`, `ttl`, `worktree`, `packet`, `verify`, `name`, `dry_run`; `ls`: `mode`,
    `status`; `show`/`resolve`: `target`; `touch`: `target`, `ttl`; `stop`: `env`; `rm`:
    `env`, `force`). Unknown names or wrong types are `E_USAGE`. A different
    `nectar_home` is `E_DAEMON`. The reply is always the CLI's envelope for that command.
  - Publish paths (`path`, `worktree`) are resolved with realpath. They must be inside the
    user's home or the caller's Cell. A Cell counts only if it is a directory the user owns
    below the Cells root (`NECTAR_CELLS_ROOT`, else `$HIVE_V2_DATA_DIR/cells`, else
    `~/.hive/v2/cells`). The published scope (the directory, or a file's directory, which
    is what a static copy takes) must neither lie inside nor contain `NECTAR_HOME`, the
    socket directory, `~/.ssh`, `~/.gnupg`, `~/.aws` or `~/Library/Keychains`. A path
    nectard cannot see (a Cell's private `/tmp`) is `E_USAGE`, with that reason. These
    refusals carry `refused: "path"`. When `NECTAR_HOME` is writable, the CLI then
    publishes in-process instead, so a host shell can still publish `/srv/app`.
    The source is then copied (static) or checked out (git) into `work/<env>`, the same
    as a local publish. The preview survives deleting the source or evicting the Cell.
  - The record's `publisher` is `{user, via: "nectard", cell?, hive_bee?, hive_session?}`
    from the request. The daemon's own environment does not leak into it. The CLI sends
    `hive_bee` from `HIVE_BEE` (else `HIVE_BEE_ID`), `hive_session` from `HIVE_SESSION`
    (else `HIVE_BEE_ID` when `HIVE_BEE` names the bee) and `cell` from `NECTAR_CELL`, or,
    when `HIVE_CELL` is set, the parent of the working directory's `HIVE_CELL_SPACE`
    ancestor (the Cell root, e.g. `~/.hive/v2/cells/<cell>`).
  - A publish through nectard returns the CLI's result plus `via: "nectard"`.
  - Logs: one `control` event per `publish`/`rm`/`stop`/`touch` and per failed request.
  - On SIGTERM nectard stops accepting connections and waits up to 15 s for requests in
    flight before closing them, inside launchd's default 20 s exit timeout and systemd's 90 s. A publish cut off after that is left as an interrupted
    local publish would be (`rm --force` cleans it up).
- **Tailnet listener (`publish --host`, D29 amendment · 2026-10-14).** Off unless
  `remote.listen` is `true` in `nectar.json`; `nectar daemon install --remote` sets it and
  `--no-remote` clears it. nectard then also serves the control API on this node's own
  Tailscale IPv4 address (from tailscaled's LocalAPI status), port **8441**
  (`NECTAR_REMOTE_PORT` overrides it, for tests). It never binds `0.0.0.0` or `::`.
  - Startup never fails silently. With `remote.listen` not `true` when it starts, nectard
    logs `remote_listen_off` (with the `nectar.json` path it read). Otherwise every attempt
    reads LocalAPI status (a read that has not finished after 20 s counts as failed; a
    still-pending read is reused, never stacked) and logs `remote_status` whenever the
    endpoint, `BackendState` or Tailscale IPs change. An attempt that cannot listen logs
    `remote_listen_failed` with `reason`: `localapi_unreachable`, `status_error`,
    `status_timeout`, `not_running` (BackendState is not `Running`), `ipv6_only` (no
    Tailscale IPv4), `no_tailnet_ip`, `address`, `bind` (with the errno `code`, e.g.
    `EADDRINUSE`, `EADDRNOTAVAIL`, plus `address` and `port`) or `internal`, and the
    `message`, `endpoint`, `backend_state` and `ips` it saw. It retries every 30 s for as
    long as it runs; the same failure is logged again only every 20th attempt (`repeats`).
  - Once bound it asks WhoIs about its own IPv4 and logs `remote_listen` with `address`,
    `port`, `endpoint`, `attempt`, `discovery` (the steps, as in doctor's message) and `whois` (`"ready"` or the reason WhoIs fails, in which
    case it refuses every caller). Every 30 s it re-reads status: a new Tailscale IPv4 closes
    the listener (`remote_listen_closed`, `reason: "address_changed"`) and binds the new one
    at once, and a WhoIs that was failing logs `remote_whois_ready` when it works again (or
    `remote_whois_failed` when its reason changes). A listener error after binding logs
    `remote_listen_closed` with `reason: "server_error"` and retries in 30 s; shutdown logs
    `reason: "shutdown"`.
  - nectard's control-socket hello carries `program` (the CLI file it runs) and `remote`:
    `{listen, listening, address, port, last_error, last_reason, whois, since, discovery}`.
    `last_reason` is the `reason` of the last `remote_listen_failed`/`remote_listen_closed`
    and `last_error` its message. Before the first status read finishes, `last_error`
    says so ("has not finished its first tailnet status read", with the seconds so far and
    the discovery step running), so `listening: false` never comes with a null
    `last_error`. `discovery` is nectard's LocalAPI discovery report (see "Talking to
    tailscaled"); `remote_listen_failed` with `status_timeout` or `localapi_unreachable`
    carries it too.
  - Every request, `GET /v1/hello` included, is authenticated before its body is read:
    nectard asks tailscaled `WhoIs(<peer ip>:<peer port>)` of the raw TCP peer through the
    LocalAPI (`/localapi/v0/whois`, at the endpoint found as in "Talking to tailscaled"
    below, the macOS app's sameuserproof port included; never the CLI). A WhoIs error, an
    unknown peer, an answer without a well-formed node (a string StableID, list Addresses and Tags)
    or an unreachable LocalAPI is `E_FORBIDDEN` (HTTP
    403, `refused: "whois"`), and the `remote` log event carries the reason as `whois`. So is
    a caller on this node itself (its peer address is one of this node's Tailscale IPs,
    or its WhoIs node is this node; `refused: "self"`): local processes use the 0600 control socket, and any
    user or container on the host could otherwise borrow the owner's identity here.
    A request must arrive within 10 minutes (headers within 30 s), and at most 32
    connections are open at once.
  - Authorization reads `nectar.json` on every request. `remote.allow` absent: only the
    node owner's own untagged nodes (WhoIs `Node.User` and `UserProfile.ID` both equal the
    user that owns this node, and the profile has a login). Present:
    exactly the entries `{node_id: "<stable node ID>"}` or `{login: "<tailnet login>"}`
    (a login never matches a tagged node). An empty list, a list that is not an array, or
    a `nectar.json` that cannot be read refuses everyone (`E_FORBIDDEN`). A caller that is
    not the node owner may `touch`, `stop` and `rm` only envs whose `publisher.node` is its
    own stable node ID, and its `show`/`resolve` of someone else's env do not touch it
    (`touched: false`). `remote.listen` turned off while nectard runs is `E_REMOTE`.
  - Ops: `POST /v1/{ls,show,resolve,touch,stop,rm}` with `{args, caller: {hive_bee?,
    hive_session?}}` (64 KiB cap). `target`/`env` must be an env name on this node; a
    `nectar://` ref is `E_NOT_FOUND`, so nothing is relayed to a third node. There is no
    `path`, `worktree`, `cell` or `nectar_home`.
  - `POST /v1/publish`: the body is a gzip tar (at most 256 MiB compressed, 1 GiB and
    100 000 entries unpacked), and `x-nectar-request` holds base64url JSON
    `{args, caller}` with `args`: `kind` (`git` or `static`), `source` (a key only: the
    repo's root commits for git, the site's path for static), `dir` (the source directory's name), `entry` (static single
    file), `branch`, `commit`, `mode`, `ttl`, `packet`, `verify`, `name`, `dry_run`, `fresh`,
    and `path` (git only: the directory or file inside the repo that was published, as
    plain `/`-separated components with no `.`, `..` or `.git`; absent for the repo root).
    nectard unpacks into `inbox/<key>/<dir>`, where `key` hashes the caller's stable node
    ID and `source`. So a repo republishes into the same copy from any checkout on that
    node (another Cell, after a move), and each node has its own. The archive is refused
    (`E_USAGE`, `refused: "archive"`) for an absolute path, a `..` component, a `.git`
    component, a hard link, device or FIFO, a duplicate entry, a write through a symlink,
    a symlink that is absolute, points outside the tree or into `.git`, or does not resolve
    inside it, a bad checksum, a truncated stream, or a cap. Files are created `O_EXCL |
    O_NOFOLLOW` with mode 0644 or 0755. A `static` tree publishes as a static site. A `git`
    tree becomes one commit on `branch` in the inbox repository (`git init`, `add`,
    `commit`, all with the §9.3 git hardening), which then publishes like a local repo,
    from `path` inside it when given: the same static-site check and recipe detection
    (`nectar.toml`, a `package.json` dev script, the Python and Rails fallbacks, static
    only when nothing else matches) as a local publish of that commit. A received publish
    never goes on to this node's own pool (§4.6) and carries no placement fields.
    The record's `publisher` is `{user, via: "tailnet", node, node_name, login?, hive_bee?,
    hive_session?}`; `node`, `node_name` and `login` come from WhoIs, not the request.
  - Replies are the CLI's envelope, redacted for the peer. `ls` drops `publisher_bee`.
    `show` returns the record without `repo`, `worktree`, `serve` (command, pids),
    `publisher` other than `via` and `node_name`, `install_hash`, `evidence` or
    `packet_hint`, with `deps` as `{kind}` only, `failure` as `{code, failed_at}`, `ports`
    as `{tailnet}` and no `log_tail`. `resolve` drops `log_tail`. `publish` returns `eid`,
    `env`, `mode`, `branch`, `commit`, `ref`, `urls`, `packet_fields`, `expires_at`,
    `warnings`, `mesh_error` and `deps` as `{kind}`. Error details are cut to `hint`,
    `refused` and `node_id` (`publish` keeps `log_tail`). In messages, warnings and log
    tails `NECTAR_HOME` reads `$NECTAR_HOME` and every other absolute path reads `<path>`.
  - `GET /v1/hello` answers an authorized caller with `{api, ops, host, caller}` plus this
    node's report for pool placement (§4.6): `version` (package version + the install's
    short commit), `nectard: {ok, pid}`, `mesh` (`ok`, `denied` when this user may not
    change Serve config, i.e. is not a Tailscale operator, or `unknown`), `deps` (the
    `[deps]` postgres provider §5.1 would pick: `docker`, `local` or `none`; cached for a
    minute, and `unknown` while the first probe takes longer than 3 s, so a slow Docker
    cannot make the hello miss the caller's 8 s timeout), `envs: {total, serving}` and
    `load: {load1, cpus, per_cpu}`.
  - Logs: one `remote` event per request with the caller's node ID and login. Every refused
    request also logs `remote_refused` with `rule`, `op`, `code`, `peer_address`,
    `node_name`, `node_id`, `login`, `tags`, `user_id`, `node_user_id`, `owner`, `whois`
    (when WhoIs failed) and `message`, and never a token. `rule` is `whois_failed`,
    `config_unreadable`, `listener_off`, `tagged`, `no_login`, `owner_unknown` or
    `not_owner` (no `remote.allow`), `allow_malformed`, `allow_empty` or `not_in_allow`
    (with `remote.allow`), or `not_publisher` (touch/stop/rm of someone else's env). A
    caller on this node itself, such as doctor's own probe, logs `remote_self_check`
    (`rule: "self"`) instead.
- **Logs.** Events (start, revive, crash_loop, mesh, proxy, proxy_closed, proxy_port_taken,
  touch, gc, tailscale, error, control_listen, control, and the tailnet listener's
  remote_status, remote_listen, remote_listen_failed, remote_listen_closed,
  remote_listen_off, remote_whois_ready, remote_whois_failed, remote, remote_refused and
  remote_self_check), one JSON line each, go to
  `~/.nectar/logs/nectard.log` (rotated like serve logs) and to stdout in the foreground.
  Quiet cycles write nothing. A `tailscale` event is written for every failed tailscale
  call nectard makes (status, serve, serve status). A LocalAPI call logs `{api: "localapi",
  ok, endpoint, method, path, status, duration_ms, cause}`, where `endpoint` is the socket
  path or the loopback port and never the token. A CLI call logs `{api: "cli", ok, binary,
  source, argv, exit_code, signal, stderr, duration_ms, cause, localapi}`, where `stderr` is cut
  to 500 characters and `localapi` says why the LocalAPI was not reachable. With
  `NECTAR_DEBUG=1` (in the unit's environment or the CLI's) every call is logged, including
  the CLI's own direct calls, which add `by: "cli"` and `pid`.

Service units (`nectar daemon install`; `uninstall` is the one removal command; `status`):

| | macOS | Linux |
| --- | --- | --- |
| unit | `~/Library/LaunchAgents/com.honeybeehq.nectard.plist` | `~/.config/systemd/user/nectard.service` |
| keeps running | `RunAtLoad`, `KeepAlive` | `Restart=always`, `WantedBy=default.target` |
| serves survive a daemon stop | `AbandonProcessGroup` (serves also have their own session) | `KillMode=process` |
| at boot | at login of the user | needs `loginctl enable-linger <user>` (install warns) |

The unit runs `<node> <nectar>/dist/cli.js daemon run` with the installing shell's `PATH`,
`HOME`, `SHELL`, `LANG`, `NECTAR_HOME` and, if set, `NECTAR_SOCKET`. When `tailscale` is not on `PATH`, it pins
`NECTAR_TAILSCALE_BIN` to the CLI the resolver below found (on a Mac usually the app's CLI).
`uninstall` stops the daemon and deletes the unit; envs keep serving and their records stay.
`install` and `status` report the daemon's live `pid` and `pid_source`: `launchctl print`'s
`pid` or systemd's `MainPID`, else `nectard.pid`. While the unit is starting, they wait a few
seconds for one to appear.

`install` is safe to repeat and ends with the agent loaded or a clear `E_PLATFORM` error. On
macOS an unchanged plist with a running agent is restarted in place (`launchctl kickstart -k`).
Otherwise it writes the plist, runs `launchctl bootout`, waits up to 25 s (launchd gives a job 20 s to exit) until `launchctl
print` no longer finds the agent, then runs `launchctl bootstrap`; launchd's transient
"Bootstrap failed: 5: Input/output error" gets one more bootout and bootstrap before install
fails, naming launchctl's error. On Linux `daemon-reload`, `enable` and `restart` are
idempotent; install then fails if the unit is not running (`failed`, `inactive`).
`daemon install` also clears a saved `daemon: "disabled"` (§10.5).

Cost: idle nectard is a Node process with ~60–90 MB RSS on both macOS and Linux (the Node
baseline, ~55 MB of it shared), and well under 0.1 % of one core at the default intervals.
systemd's cgroup accounting for the unit shows less (~27 MB, peak ~30 MB) because it counts
only the pages charged to the unit, not the shared Node mappings. Neither number is per env.

**Finding the tailscale CLI.** Every tailscale call (publish, nectard's re-assertion and proxy
re-pointing, gc, doctor, expose, the pack store, remote refs) uses one resolver, in this
order: `NECTAR_TAILSCALE_BIN`; `tailscale` on `PATH`; the Mac app's CLI
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`; `/opt/homebrew/bin/tailscale`;
`/usr/local/bin/tailscale`. `nectar doctor` names the binary it used and where it came from.

**Talking to tailscaled.** Status, the serve config and WhoIs go to tailscaled's LocalAPI
first (`src/localapi.ts`, plain `node:http`). The CLI is used only when no LocalAPI endpoint
answers. Nectar tries endpoints in the order Tailscale's own CLI uses (`safesocket`):
`NECTAR_TAILSCALE_SOCKET` alone when it is set. On macOS: the App Store app's loopback port and
token, read from the name of the `sameuserproof-<port>-<token>` file that `lsof -c IPNExtension`
shows the extension holding open; failing that, a listing of
`~/Library/Group Containers/*.io.tailscale.ipn.macos/`; the standalone app's
`/Library/Tailscale/ipnport` link and `sameuserproof-<port>`; then `/var/run/tailscaled.socket`.
On Linux: `/var/run/tailscale/tailscaled.sock`, then `/run/tailscale/tailscaled.sock`.
Every process discovers in this order on macOS: lsof, then macsys, then, only when neither
found anything, the group-container listing, then the socket. nectard (`daemon run`, a
LaunchAgent on macOS) discovers as a service: macsys first, then lsof, and it never lists
the group container (D32 amendment). The listing runs `/bin/ls` in a child process that is
SIGKILLed and let go just after the step's bound, so a listing blocked by macOS privacy protection
never keeps a Nectar process from exiting. Every discovery step (`env`,
`lsof`, `group-container`, `macsys`, `socket`) gets 3 s and the whole discovery 10 s; a
step that runs out is recorded as `timeout` and skipped, and a step whose earlier call
has still not returned is not started again (`stuck`), so a blocked file-system call
costs one worker thread once, not one per retry. A step left with no budget is
`skipped`. lsof and the listing's `ls` are killed 250 ms after their 3 s, so the step is always recorded as `timeout`. The discovery is cached in the process: an endpoint
that answers is reused until it fails, and when none answers, the same endpoints are
retried without a new discovery for 30 s, doubling to at most 5 min, back to 30 s once
one answers. A port that answers 401 to a reused discovery's token means the proof
changed (Tailscale restarted), so Nectar discovers again at once. doctor's `tailscale` and `remote` checks carry `discovery`: `{mode, at,
steps: [{step, outcome, ms, found, note?}], running, won: {step, endpoint} | null,
next_discovery_in_ms}`, and the tailscale message names the steps, e.g. `(service
discovery: macsys found 1 (answered), lsof none, group-container skipped, socket
none)`. For tests and Linux rehearsal only: `NECTAR_TEST_DISCOVERY_PLATFORM=darwin`,
`NECTAR_TEST_LSOF_BIN`, `NECTAR_TEST_LS_BIN`, `NECTAR_TEST_MACSYS_DIR` and `NECTAR_TEST_DISCOVERY_HANG=<step,…>`
(those steps never return). The token
goes in an HTTP basic-auth header and is never logged, shown or stored. A port that answers 401
counts as stale and the next endpoint is tried. Serve changes read `serve-config` with its
ETag, change only the one entry and POST the whole config back with `If-Match`. On 412 they
read and try again, up to 4 attempts. Adding `:N` sets `TCP[N] = {HTTPS: true}` and
`Web["<host>:N"].Handlers["/"]`, and drops that port's Funnel, like `tailscale serve --bg
--https=N <target>`. Removing it deletes every mount on `<host>:N`, `TCP[N]` and its Funnel, like
`tailscale serve --https=N off`. Both refuse a port that forwards raw TCP. Every other key is
written back exactly as read. An answer from a reachable LocalAPI is final: a 403 "serve config
denied" or a `BackendState` other than `Running` is reported, not retried through the CLI.
doctor's `tailscale` check carries `api: "localapi" | "cli"` and `localapi` (the endpoint).
`mesh_error` ends with `(api: localapi)`, or with `(api: cli; <why the LocalAPI was not
reachable>)`.

Nectar runs the CLI with its own environment minus launchd's job identity (`XPC_SERVICE_NAME`,
`XPC_FLAGS`), so a CLI started from nectard's launchd agent sees what it sees in a login
shell. `tailscale status --json` and `serve status --json` get 15 s, `serve` changes 20 s.

### 4.6 The publishing pool (amendment · 2026-10-14, DECISIONS D34)

A node can hand its web and static publishes to other nodes. The pool lives in that
node's `nectar.json`:

```json
"pool": { "hosts": ["metal-3", "trmd-moria-mini03"], "default_for": ["web", "static"], "prefer": "least-loaded" }
```

`hosts` are the other nodes, by name, in order of preference (as for `--host`).
`pool add` refuses this node itself (`E_USAGE`, "… is this host"), matched against
tailscaled's own host name and MagicDNS name, short or full, and the machine host name.
A publish that should stay here needs no entry: it stays here when no pool host is usable,
and `--local` keeps it here. If `nectar.json` already lists this node, `pool ls` and `pool
check` show the entry as `excluded` with a note, `check` marks it `(this host, excluded)`
and does not probe it, and placement skips it. `pool rm` removes any listed host,
this one included. It matches the short name, the full name and a trailing dot alike.
Neither command ever adds an entry the user did not list. `default_for` takes `web` (a `nectar.toml` `[web]` recipe or a §6.1.2 fallback such
as a `package.json` dev script) and `static`, both by default. `prefer` is `first-healthy`
(default) or `least-loaded`. No `pool`, or no hosts: every publish without `--host` stays
on this node, exactly as before. A malformed `pool` is `E_USAGE` on publish.

`publish` without `--host` and without `--local`, when a pool is configured:

1. The publishing node works out locally what the publish is (static site, or the
   recipe's mode and whether it has `[deps] postgres`) and the env name. If that fails,
   it publishes here and reports the real error.
2. `desktop`, `ios` and `dev` envs, and a category not in `default_for`, stay here.
3. An env that already exists on this node stays here (`<env> already lives on this host`).
   So does a static page or directory inside a repo with uncommitted changes (`git status`
   lists it, untracked files included; ignored build output does not count): a pool host
   would get only the commit, and a local static publish serves the working tree.
4. **Sticky.** If `placements.json` says where this source's env went (key: the repo's
   root commits, or a static site's path outside any repo, plus the env name, so another
   Cell's checkout of the same repo sticks too), it goes there again while that node is
   still in `hosts` and its nectard answers, mesh-denied or not. If it no longer answers or
   has left the pool, the env is placed anew and the reason says so.
   `rm nectar://<node>/<env>` drops the entry.
5. Otherwise every pool host other than this node is asked for `GET /v1/hello` (8 s
   timeout). A host is skipped when it does not answer, refuses
   (`E_FORBIDDEN`, `E_REMOTE`), reports nectard down, reports `mesh: denied` (a preview
   placed there would have no tailnet URL, and every placed publish needs one), or, for an
   env with `[deps] postgres`, reports `deps: none`. A postgres env prefers `docker`, then
   `local`, then a host whose provider is `unknown` or not reported. Then `first-healthy` takes the first in pool
   order and `least-loaded` the lowest `load.per_cpu`, then fewest serving envs, then pool
   order. A host on an older nectard that reports no fields is usable and sorts last by load.
6. The publish goes to the chosen host as `publish --host <host>` would. No usable host:
   it publishes here.
7. If building what would ship is refused before anything is sent (a symlink that is
   absolute or leads outside what is shipped, an uncommitted page, `--worktree`, an
   archive over the size limit, §4.5), it publishes here instead, and the reason is
   `not shipped to <host>: <the refusal>; published on this host`, so it names each
   offending link. Placement never turns a publish that works here into a failure.
   An explicit `--host` keeps the refusal as `E_USAGE`, since the user asked for that host.

The result, and the `--dry-run` plan, carry `placed_on` (the node) and `placement_reason`
(for example `pool: metal-3, because it is the least loaded (load 0.12 per CPU, 2 serving
envs); skipped netcup-4 (mesh denied: …)`). A dry run asks the chosen host for its plan and
records nothing; it builds the same archive first, so a refusal shows as the same local
placement. `--local` publishes here and is `E_USAGE` together with `--host`.

`nectar pool ls` shows the pool and the recorded placements. `nectar pool add <hosts…>
[--prefer first-healthy|least-loaded] [--for web,static]` and `nectar pool rm <hosts…>`
change it (they write `nectar.json`, so they run where `NECTAR_HOME` is writable, not in a
Cell). `nectar pool check` asks every host for its hello and prints a table (`--json`: an
envelope) with `healthy`, `version`, `nectard`, `mesh`, `deps`, `envs`, `serving`, `load`,
the error for a host that did not answer, and where the next web and postgres publish would go.
`ls`, `check` and placement also work from a Cell with a read-only home (placement then
records nothing unless it runs in nectard, which is how Cells publish).

### 4.7 Public previews through `nectar-relayd` (amendment · 2026-10-14, DECISIONS D35)

`nectar publish --public` publishes (or reuses) the env and then exposes it through the
machine's default exposure target. `nectar expose <env>` does the same for an env that
already serves, and both go through `nectar-relayd` when the target says
`"control": "relayd"`:

```jsonc
"exposures": {
  "site": { "kind": "relay", "host": "trmd-vps01", "domain": "nctr.site",
            "control": "relayd", "gate": "password", "default": true }
}
```

`host` is the relay's tailnet name (or IP); `port` overrides the control port 8450. The
default target is the one marked `default`, else the only one, else `site`.

**relayd** runs on the relay host and is the single owner of relay state: routes, owner
stable node IDs, minted names, generations, view times and the kill flags, in
`state.json` (0600). It renders one Caddy route file per route into the routes directory
Caddy imports (D21), then asks for a reload. It has three listeners:

- **control**, the node's Tailscale IPv4 on 8450, never a wildcard. Every request is
  identified with tailscaled WhoIs on the raw peer address before the body is read
  (src/localapi.ts). A failed, late or malformed WhoIs, a caller on the relay itself, an
  unreadable allowlist, or a stable node ID not on `allow` is 403. API: `PUT /routes`,
  `PATCH /routes/<sub>`, `DELETE /routes/<sub>`, `POST /routes/<sub>/rotate`,
  `GET /routes?mine=1`.
- **verify**, 127.0.0.1:8451, for Caddy `forward_auth` in slice 2. In slice 1 it answers
  204 for a live route's host and 404 otherwise; nothing points at it yet.
- **admin**, a Unix socket (0600 in a 0700 directory), used only by `nectar-relay` on
  the box: `ls`, `rm <sub>`, `disable-all [--node <name|id>]`, `enable-all [--node …]`,
  `prune`, `health`, and the old `add` so the Tailscale SSH control path keeps working.

Authorization, all on the relay: (1) the caller's stable node ID is on `allow`;
(2) the upstream is `https://<the caller's own MagicDNS name>:<8443–65535>`, with no
userinfo or other host; the only accepted path is an exact shared-static prefix
`/s/<env-name>/<32 lowercase hex token>/`. Query strings, fragments, encoded paths and
traversal are refused before URL normalization. Ports 443/8440/8441/8450/8451 remain
reserved. Relayd stores the rebuilt URL; (3) PATCH, DELETE and rotate need the route's owner (403 otherwise; the admin
socket can always remove); (4) the caller sends `name` (`<app>-<branch>`) and relayd
sanitizes it to one DNS label of at most 54 characters, refuses reserved names (`www`,
`api`, `app`, `auth`, `login`, `admin`, `mail`, … also as the first word) and appends 8
random hex characters; a body naming its own `sub` is refused; (5) `gate: "none"` only
for nodes on `ungated` (empty by default). Kill flags (relay-wide or per node) remove the
routes they cover and refuse every PUT until `enable-all`.
Static public routes require the upgraded relayd renderer. Prototype property names
(including sanitized forms) are reserved public names. Hard caps: 30 days from
creation for a gated route, 7 days ungated; a PATCH past the cap is clamped. relayd
prunes expired routes hourly and at start; `nectar-relay prune` from cron asks again.
Routes removed by `rm`, a kill flag or expiry leave a tombstone for 30 days, so
`GET /routes?mine=1` reports them `revoked` with the reason. A route past its expiry is
gone at once for PATCH, rotate, verify and the listing, before prune removes its file.
Quotas: 50 live routes per node, 200 per relay (429). The control port takes at most 64
connections, 8 per peer address, headers within 5 s (408), 15 s of silence and a 16 KiB
body.

**Gate (slice 1).** The password gate stays: Caddy `basic_auth` user `reviewer` with a
bcrypt hash from `caddy hash-password`, given the password on stdin. relayd mints a
16-character password unless the caller sends one (12–128 characters), returns it once
and stores only the hash. The route strips `Authorization` before proxying, so the
password never reaches the dev server.

**Results.** `url` is the tokenless `https://<sub>.<domain>`; it is what goes into
`packet_fields.public_url`, proof, PRs and transcripts. `share_url` is what goes to the
person who should open the preview; in slice 1 it equals `url`, and the password travels
in `password`, `credentials` and `share_note`. The result lists those fields in `secret`
(for `publish --public`: `share_url` and `public.*`). A second `expose` of a live route
updates it in place (`reused: true`, the password unchanged); `--rotate` mints a new
password and bumps the generation.

**Sync.** Every `gc` (nectard's hourly pass, or `nectar gc`) asks each relayd target for
`GET /routes?mine=1` once. A route still listed gets `PATCH` with the env's current
expiry when it differs by a minute or more (never for `--ttl` exposures, which are
fixed); PATCH never recreates a route. A route the relay reports revoked, or no longer
lists, or a PATCH answered 404, marks the exposure `revoked_at`/`revoked_reason` and
clears `urls.public`; gc does not try again, and `unexpose` then only clears the record.
The result's `exposures` lists `patched`, `unchanged`, `revoked`, `unreachable` or
`skipped` per env. Stop, expiry and `rm` still delete the route at once.

## 5. Recipes — `nectar.toml`

Checked into the repo root. Names the repo's own commands; nectar adds no build logic.

```toml
name = "acme"                # app name; default: repo dir name

[web]
serve = "pnpm dev"              # must respect $PORT
ready_path = "/"                # polled for HTTP 200 to declare "serving" (default "/")
ready_timeout = "90s"
env = { VITE_API_BASE = "http://127.0.0.1:$NECTAR_API_PORT" }   # extra env, literal or $-refs

[desktop]
pack = "pnpm dist:testpack"     # must produce the dir/zip named by $NECTAR_PACK_OUT
kind = "electron"               # electron | native
embed_url = "web"               # electron only: "web" = reuse this repo's [web] env as the
                                # webview URL; or an explicit URL template; omit = no embed

[cli]
build = "pnpm build"
bin = "dist/bin/acme"        # file or dir prepended to PATH in provisioned shells

[backend]
seed = "pnpm db:seed:review"    # idempotent; runs in the env worktree
smoke = "pnpm test:smoke"       # output captured as evidence

[ios]
pack = "pnpm ios:sim-release"   # must place the built *simulator* .app at $NECTAR_PACK_OUT
bundle_id = "no.kontrol.acme"
device = "iPhone 16"            # simctl device type for the streamed simulator
runtime = "latest"              # iOS runtime pin; default: newest installed
stream = true                   # false = simpack-only publish (no serve-sim stream)

[secrets]                       # optional; resolved via `hem get` at publish time (§9.2)
STRIPE_KEY = "project/acme/stripe-test"

[deps.db]                       # web envs only; one Postgres per env (§5.1)
kind = "postgres:16"            # "postgres:<tag>" pins the official image; bare "postgres" = 17
env = "DATABASE_URL"            # default; PG* vars are added when there is one postgres dep
database = "app"                # default "app" (Docker provider only)
user = "nectar"                 # default "nectar" (Docker provider only); the password is generated per env
provider = "local"              # optional: "docker" | "local"; default picks Docker, else local binaries

[deps.files]
kind = "sqlite"
path = "data/app.db"            # copied from the checkout into the env's own deps dir
env = "DATABASE_PATH"           # default; the absolute path of the copy

[scenarios.review]              # only seed + default so far; entry/login are E_NO_RECIPE
seed = "pnpm db:seed:review"    # runs once when the env's deps are created, and on --fresh
```

Sections are independent; a repo declares only the modes it supports. **Fallbacks without a
recipe** (web only; desktop/cli/backend/ios without a recipe are `E_NO_RECIPE`). The first
match wins, and `nectar publish --dry-run` prints which one matched, why, and its build and
serve commands without changing state:

1. `nectar.toml` — always wins; nothing below is consulted.
2. `package.json` with a `dev` script ⇒ `serve = "<pm> dev"`.
3. Python (§6.1.2): `requirements.txt` or `pyproject.toml` plus a known entrypoint —
   Django `manage.py`, then a FastAPI/Starlette app, then a Flask app.
4. Rails (§6.1.2): a `Gemfile` that declares `gem "rails"`.
5. **Static** (§6.1.1): the target has an `index.html` at its root or in `dist/`, `build/`,
   `out/`, `public/` or `_site/`, or is itself an `.html` file. A Python repo with no
   recognised entrypoint lands here, so there is no `python -m http.server` fallback.
`nectar publish` picks the mode: `--mode` flag > single declared section > `web` if
inferable > error.

Relation to Apiary's per-product review recipes: Apiary's recipe stores *who reviews and
which surface kind*; `nectar.toml` is the only owner of *how to produce that surface*. The
Apiary recipe's "test surface" line is descriptive (`nectar publish` + the mode), never a
second command definition (DECISIONS D8).

### 5.1 `[deps]` — per-env databases (amendment · 2026-10-14, DECISIONS D16, D30)

Built so far: `kind = "postgres:<tag>"` through Docker and Compose v2 or through local
Postgres binaries (the local provider below), and `kind = "sqlite"`. `[deps].compose`, `provision`/`teardown` commands and other kinds are
`E_NO_RECIPE` until built. Deps apply to web envs; other modes ignore them. The recipe is read
from the published branch, as for `[web]`.

- **Postgres.** Each env gets its own Compose project `nectar-<env>`, generated as
  `work/<env>.deps/compose.json`: the official image, a named volume `<dep>-data`, a
  `pg_isready` healthcheck, and the container's 5432 published on `127.0.0.1:<port>` only.
  The port comes from the upstream range under the same machine-wide lock as serve ports and
  is kept across republishes. Publish runs `docker compose up -d --wait` and starts the build
  only once the container is healthy. The password is random per env and lives in
  `secrets.json` (0600) next to the compose file, never in the env record.
- **Injection.** The dep's `env` var (`DATABASE_URL` =
  `postgresql://<user>:<password>@127.0.0.1:<port>/<database>`) plus `PGHOST`, `PGPORT`,
  `PGUSER`, `PGPASSWORD`, `PGDATABASE` (one postgres dep only) go into the scrubbed
  environment of build, seed, serve, and nectard revives. `show`, and the publish result,
  carry `deps` with the URL's password replaced by `***`.
- **SQLite.** The repo file is copied to `work/<env>.deps/<dep>/<file>` and the absolute path
  is injected (`DATABASE_PATH` by default), so envs never share one file. If the repo has no
  such file, the path is injected anyway and the app creates it.
- **Lifecycle.** A republish reuses the database, so its data persists. `publish --fresh`
  drops and recreates it (volume and password), or re-copies the SQLite file, and re-runs the
  seed. A live republish's old serve can briefly see the database disappear while that
  happens. `stop` and gc expire stop the containers. gc cold, reap and `rm` remove the
  containers, the network and the volume, and trash the deps dir. A publish whose new
  database never turns healthy removes only the deps it was creating (by their
  `dev.nectar.dep` label), restores the previous deps record and fails `E_DEPS`. A failed
  republish never removes an existing database, except two explicit cases: `--fresh`, and a
  republish whose recipe dropped every postgres dep, which removes them before its build.
  Without a docker binary, `rm` and gc cold fail `E_PLATFORM` rather than forget containers
  they could not remove.
- **Only Nectar's own.** Every container, volume and network carries `dev.nectar.env=<env>`
  and `dev.nectar.home=<NECTAR_HOME>`. Teardown lists by both labels (`docker ps -a`,
  `network ls`, `volume ls` with `--filter label=…`) and removes only what it listed. Volumes
  must also be named `nectar-…`. It never uses `compose down` or any prune. The project name
  does not include the home, so before `compose up` Nectar lists everything carrying
  `com.docker.compose.project=nectar-<env>`. If any of it lacks this home's label, for
  example the same env name under another user's `NECTAR_HOME`, the publish fails `E_DEPS`
  without touching it. `--name` picks another project.
- **Seed.** The default scenario's `seed` (or the only scenario's) runs in the worktree with
  the dep vars and `NECTAR_SCENARIO`, once when a dep is created and again on `--fresh`.
  A failing seed fails the publish `E_SEED` with its log tail. It is not retried by a later
  plain republish, because the database already exists; use `--fresh` to seed again.
- **Docker access.** nectard and the CLI run as the user, so the user must be able to reach
  the Docker daemon: membership in the `docker` group (root-equivalent) or rootless Docker
  with `DOCKER_HOST`. `NECTAR_DOCKER_BIN` picks the binary (default `docker`). Without
  access, publishing an app with postgres deps fails `E_PLATFORM` before any checkout, with
  that hint. `doctor` reports a `docker` check (fail when an existing env needs it, warn
  otherwise) and never changes Docker access. A host without Docker falls back to the local
  provider below when it has Postgres binaries.
- **Provider.** `[deps.<name>] provider = "docker" | "local"` picks one explicitly. Without
  it, a new dep uses Docker when the Docker probe succeeds, else the local provider when
  local binaries are found, else publish fails `E_PLATFORM` before any checkout, with a hint
  naming both options. An existing dep keeps the provider it was created with (recorded as
  `provider` in its deps record; records from before this field are `docker`). An explicit
  provider that differs from the recorded one fails `E_DEPS` and asks for `--fresh`, which
  drops the data. `doctor`'s `postgres-provider` check says which provider a dep without the
  key would use here (`provider`: `docker`, `local` or `null`), lists the local majors and
  their bin dirs, and fails when an env on the local provider needs a major whose binaries
  are gone.
- **Local provider (DECISIONS D33).** One Nectar-managed Postgres cluster per major, with one
  role and one database per env and dep.
  - *Binaries.* Nectar never installs Postgres. A bin dir counts when it holds `initdb`,
    `pg_ctl`, `postgres` and `psql` and `postgres --version` says 13 or newer. It searches
    the directory of `initdb` on `PATH` (symlinks resolved), then
    `/opt/homebrew/opt/postgresql@*/bin`, `/opt/homebrew/opt/postgresql/bin`, the same under
    `/usr/local/opt`, `/Applications/Postgres.app/Contents/Versions/*/bin`,
    `/usr/lib/postgresql/*/bin` and `/usr/pgsql-*/bin`. `NECTAR_PG_BIN` (a `PATH`-style list
    of bin dirs) replaces that search; the nectard unit passes it through.
  - *Version.* The major from `postgres:<tag>` is used when local binaries of that major
    exist. Otherwise the newest local major is used and the publish carries a warning naming
    the pin and the major it got. There is no strict mode: `provider = "docker"` is how a
    repo insists on the exact image. A dep keeps its major across republishes; if those
    binaries disappear, publish and revive fail `E_PLATFORM` until they come back or
    `--fresh` recreates the dep on another major (with a warning that the old database
    stays in the old cluster). `rm`, gc cold and reap also fail `E_PLATFORM` for that env
    until the binaries are back, as they do without Docker, rather than forget a database
    they could not drop.
  - *Cluster.* `initdb` runs once, only while `data/PG_VERSION` does not exist, into
    `<NECTAR_HOME>/pg/<major>/data` with superuser
    `nectar`, a generated password in `pg/<major>/superuser.password` (0600),
    `scram-sha-256` auth, UTF8 and no locale. `pg_hba.conf` is replaced by the single line
    `host all all 127.0.0.1/32 scram-sha-256`. `postgresql.conf` includes `nectar.conf`,
    which sets `listen_addresses = '127.0.0.1'`, the port, `unix_socket_directories = ''`
    (no socket file) and `log_min_error_statement = panic` (failed statements, which can
    hold a password, are not logged). The port comes from the upstream range under the
    machine ports lock, is kept in `pg/<major>/cluster.json`, and is reserved by every env
    record that points at the cluster. `pg_ctl start -w` starts it with the server log at
    `pg/<major>/server.log`. Every start revokes `CONNECT` and `TEMPORARY` on `postgres` and
    `template1` from `PUBLIC`. A data dir whose `superuser.password` is missing fails
    `E_DEPS` and is never re-initialised or removed by Nectar.
  - *Per env.* The role and the database are both named
    `nectar_<env>_<dep>_<hash>`: the env and dep names with every run of characters outside
    `[a-z0-9]` turned into `_`, cut so the whole name fits Postgres's 63 bytes, plus the
    first 8 hex digits of `sha256(env + NUL + dep)`, so two envs never share a name. The
    recipe's `database` and `user` keys apply to the Docker provider only. The role gets a
    generated password (kept in the env's `secrets.json`, 0600, exactly as for Docker) and
    `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`; the database is owned by it
    and `PUBLIC` loses all rights on it, so one env's role cannot connect to another env's
    database. All SQL is sent to `psql` on stdin as the superuser (password in the child's
    environment, never on the command line); names are checked against
    `^nectar_[a-z0-9_]{1,56}$` and double-quoted, the password is checked to be one Nectar
    generated and single-quoted, and create statements are conditional (`\gexec`), so a
    republish or revive re-runs them safely and resets the role's password to the stored
    one. psql errors in `E_DEPS` details have both passwords replaced by `***`.
  - *Injection and redaction* are the Docker path's: the same `DATABASE_URL` and `PG*`
    vars, pointing at the cluster port, and `***` in `show` and the publish result.
  - *Lifecycle.* Publish starts the cluster if needed before creating the role and
    database; a republish keeps them. `--fresh` drops the database (`WITH (FORCE)`, which
    ends the old serve's connections) and the role, creates them again with a new password,
    and re-runs the seed. A recipe that drops a local dep, or moves it to Docker with
    `--fresh`, drops its database and role. `stop` and gc expire leave the database and the
    cluster alone. gc cold, reap and `rm` drop the env's databases and roles. nectard's
    revive, including the revive of every env after boot, starts the cluster and re-checks
    the role and database before it spawns the app. A publish whose new local database
    cannot be created drops what it created and restores the previous deps record (`E_DEPS`).
  - *Cluster stop.* After `rm`, gc cold or reap removes an env's local databases, Nectar
    stops (`pg_ctl stop -m fast`) every cluster that no env record points at any more; a
    failed first publish that started a cluster does the same.
    While any env, including an expired one, has a database in it, the cluster keeps
    running: an idle Postgres costs a few tens of MB and no CPU, and a running cluster
    keeps its reserved port in use. The start, the create and the stop decision hold a
    per-major lock (`locks/machine--pg-<major>.lock`), so a stop cannot race a publish.
  - *Scope.* Nectar only touches the cluster under its own `NECTAR_HOME`, through its own
    port and superuser, and only the `nectar_…` names its env records hold. It never
    connects to another Postgres on the host.

## 6. The five modalities

### 6.1 web

The easy, important case: embed a live branch build in the desk's Test tab.

**Publish sequence** (`nectar publish --mode web`):

1. Ensure worktree `~/.nectar/work/<name>` at the branch tip (clone-or-fetch from `--repo`,
   local object sharing via `git worktree` when the repo is local, else a shallow clone).
   Install deps if the lockfile hash changed (`pnpm install --frozen-lockfile` / npm / yarn
   detected from lockfile).
2. Allocate an **upstream port** from the machine's range (default 4100–65535) and spawn the
   recipe's `serve` with `PORT=<p>`, detached, logs to `logs/<name>/serve.log`.
3. Register the **local name** with portless so the same-machine URL follows portless
   grammar: `agent-coupons-stack.acme.localhost`. Nectar runs the serve command itself
   and points portless at the already-allocated port; if portless is absent or its proxy is
   down, the local URL degrades to the healthy loopback origin (`http://127.0.0.1:<p>` or
   `http://[::1]:<p>`) with a warning in the envelope — never a failure (DECISIONS D3, F1).
4. Poll `ready_path` on both IPv4 (`127.0.0.1`) and IPv6 (`::1`) until one returns 200;
   retain the healthy loopback origin. `ready_timeout` fails with `E_SERVE_TIMEOUT` and the
   transactional rollback described in §4.4.
5. Expose to the mesh: allocate a **tailnet port** from 8443–65535 and run
   `tailscale serve --bg --https=<tport> <healthy-loopback-origin>`.
   **The 443 caveat is load-bearing**: port 443 on nectar machines belongs to the portless
   proxy (launchd), so tailscale serve must always bind non-443 — nectar never allocates
   443 and `nectar doctor` reports any existing 443 serve entry as a warning (§10.5); it never
   touches it, since portless or another service may publish there on purpose.
6. Write the env record; emit the envelope.

**On-demand dynamic web previews.** With nectard running, recipe-backed web publishes
prepare and build the checkout, then return a stable daemon proxy URL in `warm` state.
No app process or upstream port is retained until a real HTTP request arrives. The proxy
holds the request until the recipe is ready, including WebSocket upgrade requests;
concurrent requests share the wake. Memory admission applies when starting the app,
not when registering a sleeping preview. Failed wakes return 503 with Retry-After and
leave the URL available for another attempt. Without nectard, publish retains the
existing eager-start behavior.

The default idle window is 45 minutes (`idle_stop_ms`). Real requests update
`last_opened_at`; metadata resolve/touch does not keep the app running. On each daemon
cycle, idle dynamic web apps and Electron dev apps stop. Web routes retain their proxy
and tailnet listener, release the upstream port and app process, and wake on the next
request. Pinned/`open --keep` previews and the main bench are protected. `--keep` persists
until the preview is removed; republish preserves it. Static previews
are excluded. Electron `[dev]` apps have no HTTP URL and continue to wake through
`nectar open`. Explicit stop, expiry and removal disable the HTTP route. Restarting
nectard restores sleeping listeners without starting their apps. Local fallback URLs
remain stable once fronted. Long-lived HTTP streams and WebSockets count as activity.
A stopped daemon cannot serve its listeners; warm routes are retained for its restart. Port 443 is never allocated.

**Republish of a live env (amendment · 2026-10-14, DECISIONS D26).** When the env is
`serving` or `unhealthy` and Nectar owns its worktree, steps 1 and the build step (§6.1.2)
run in the env's other worktree slot (`work/<name>` and `work/<name>.alt` alternate) while
the old serve keeps running and the record is left as it was. Only when checkout, install
and build succeed does Nectar stop the old serve, write the new record, remove the old slot
(`git worktree remove`) and continue at step 2 with the old ports. A failure removes the
staging slot and returns its code (`E_CHECKOUT`, `E_INSTALL`, …) with the log tail; the
message says the previous publish still serves and `details.still_serving` is its commit.
Static sites stage through their existing copy-and-swap (§6.1.1) before the old serve
stops. Republishing a stopped or crashed env works in place, in whichever slot it holds, and
removes the other slot if one is left over; a borrowed `--worktree` works in place as
before. A slot starts without the other slot's `node_modules` or `.nectar/` caches, so a
live republish reinstalls dependencies.

**URLs.** `urls.mesh` (`https://<host>.tailnet.ts.net:<tport>`) is the primary reference
for other authorized tailnet devices. `urls.local` is the loopback/portless URL for
same-machine consumers. **`preview_url` on the packet remains `urls.mesh`** because packets
are location-independent; consumers choose at resolve time (DECISIONS D4). One tailnet
port per dynamic env. Static previews use the shared path scheme in §6.1.1. No subdomains (ts.net has no per-machine
wildcards) (DECISIONS D3).

**Live-use amendment · 2026-07-19 — same-node Serve identity.** A request from the
publishing machine to its own tailnet Serve URL carries no Tailscale identity and receives
HTTP 403. `resolve --json` therefore includes `is_self: boolean`, comparing the ref host
with this machine's Tailscale status identity using case-insensitive full-name and
short-name aliases. When `is_self` is true, consumers (including the Apiary desk) **must
prefer `urls.local`**, falling back to `urls.mesh` only when local is null. When false they
prefer `urls.mesh`. `packet_fields.preview_url` stays mesh-canonical and unchanged.

**Auth.** Two layers, both honest:

- *Transport*: tailnet-only. Reachability is governed by tailscale ACLs (§9.1). No nectar
  login in v0/v1.
- *App-level*: branch apps that need a logged-in user follow Forum's preview contract
  ladder (PRD R5): the recipe's `env`/`secrets` inject demo-account or seeded-tenant
  credentials, and the app's own dev auto-login does the rest. Nectar's job ends at
  environment variables; it does not proxy-inject sessions.

**Per-branch names.** The portless grammar `<branch-slug>.<app>.localhost` is exactly
portless's worktree convention, produced deliberately so a human running portless by hand
and a nectar env are indistinguishable locally.

#### 6.1.1 Static sites (amendment · 2026-10-14, DECISIONS D22)

A prototype that is just HTML (plus CSS/JS/images) publishes with the same command and
envelope as any web env, and needs no `package.json` or `nectar.toml`:

```bash
nectar publish ./proto --json             # directory: index.html at root or in a build dir
nectar publish ./report.html --json       # one file, served as index.html
nectar publish --mode static --name shell # force it where a recipe would otherwise win
```

- **Detection.** `--mode static` forces it. Without `--mode`, a path to an `.html` file is
  static; a directory is static only when the recipe path does not apply (not a git repo,
  or a repo with no `nectar.toml`, no `dev` script and no Python/Rails match, §6.1.2). Existing recipe behaviour is
  unchanged. The site root is the first of `.`, `dist`, `build`, `out`, `public`, `_site`
  holding an `index.html`.
- **Copy, not checkout.** Nectar copies the site root's regular files into
  `~/.nectar/work/<name>/` through a staging directory and an atomic swap. It skips
  symlinks (with a warning), `node_modules`, and every dotfile and dot-directory except
  `.well-known`, so `.env`, `.npmrc` and `.git` are never served. The copy is capped at
  20 000 files / 512 MiB. A single `.html` file is copied alone, so sibling assets it
  references are not included; publish the directory instead. The preview
  serves that copy, so it survives the source directory or Cell being deleted. Uncommitted
  files are included. `commit` is an 8-hex content hash of the copy.
- **Name.** `<app>--<branch>--web`. `<app>` is `--name`, or else the directory name (file
  name without `.html`). `<branch>` is `--branch`, or else the enclosing git branch, or else
  `static`. Re-publishing the same name is the usual idempotent upsert: same
  URL, fresh copy. If the name already belongs to a git-checkout env (or a static env when
  publishing a recipe), publish refuses with `E_USAGE` and leaves that env running:
  `nectar rm <env> --force` first, or pick another `--name`. The same holds for a static
  source at a different path with the same name.
- **Shared serve (2026-10-24, D36).** New static previews, including recipes whose
  serve command invokes `static-server`, share one detached read-only server per
  Nectar state home (one home per production host). Nectard restores that server after
  exit or reboot. `shared-static.json` holds its PID, health identity, loopback port and
  tailnet port. Env records hold `static_route` (128 random bits), no `serve` runtime,
  and URLs ending `/s/<env>/<token>/`. Recipes preserve a literal root argument in
  `static_root`, recomputed from the current worktree on every publish. Republish keeps
  the token and URL. The loopback
  port is OS-assigned; one shared tailnet port is allocated scanning from 10240.
  Both avoid recorded env ports and reserved service ports, including 443. Concurrent
  publishes serialize singleton startup; foreign tailnet entries are left untouched.
- **Assets.** GET/HEAD only; `/dir/` serves `dir/index.html`, `/dir` redirects with the
  preview prefix preserved. Relative assets resolve beneath the trailing-slash URL.
  Build SPAs with a relative asset base (for example Vite `base: './'`) or their mount
  prefix; root-absolute asset paths and history routers require an app base. Missing
  files return 404, directories are never listed, symlinks and paths outside the copy
  are refused, and responses use `cache-control: no-cache`. Tokens separate routes,
  not browser origins. The server reads the named env record on every request.
- **Lifetime and resources.** Static routes have no count limit and bypass preview
  memory admission and per-env port allocation. Every request enforces `expires_at`:
  an expired route returns HTTP 410 with an explicit expired message before GC runs.
  A stopped route returns 410; a removed/unknown route returns 404. Existing TTL/touch
  and GC expire/cold/reap still own renewal and file cleanup; stopping/removing one
  preview never stops the shared listener or another preview. Public relay exposure
  accepts the exact shared-static prefix (§4.7). Its public URL stays at the origin root:
  Caddy prepends the prefix to requests and removes it from directory Location headers.
  Raw dot segments, encoded separators and backslashes are refused before URL
  normalization, including public requests, so a request cannot escape its prefix.
  Password gates and expiry apply as for dynamic previews. Root-absolute assets and
  browser history paths resolve within this public preview; relative assets also work.
- **Existing URLs.** Static records that already own `serve` keep their old server,
  ports and URLs, including on republish and supervisor revival, until normal retirement.
  Newly published static routes use the shared server. The envelope still supplies
  `packet_fields.preview_url` from `urls.mesh` (loopback fallback when offline) and
  `source` (the copied path). `--worktree` and `--verify` are `E_USAGE`.

#### 6.1.2 Python and Rails apps (amendment · 2026-10-14, DECISIONS D23)

A repo with no `nectar.toml` and no `dev` script still publishes as a web env when it is a
recognisable Python or Rails app. Detection reads files only and is deterministic for a
given repo and host (the host decides only uv vs pip):

| Stack | Matches | Build (cwd = env worktree) | Serve |
|---|---|---|---|
| Django | `manage.py` at the root | install deps (below) | `exec .nectar/venv/bin/python manage.py runserver --noreload 127.0.0.1:"$PORT"` |
| FastAPI / Starlette | first of `app.py`, `main.py`, `server.py`, `api.py`, `asgi.py`, `wsgi.py`, `app/main.py`, `app/app.py`, `app/__init__.py` that assigns `<var> = FastAPI(` / `Starlette(` | install deps, plus `uvicorn` when the deps don't name it | `exec .nectar/venv/bin/python -m uvicorn <module>:<var> --host 127.0.0.1 --port "$PORT"` |
| Flask | first of those files that calls `Flask(` | install deps | `exec .nectar/venv/bin/python -m flask --app <module>[:<var>] run --host 127.0.0.1 --port "$PORT"` |
| Rails | `Gemfile` declares `gem "rails"` | `mkdir -p .nectar && BUNDLE_PATH=.nectar/bundle bundle install` | `rm -f .nectar/server.pid && BUNDLE_PATH=.nectar/bundle exec bin/rails server -b 127.0.0.1 -p "$PORT" --pid .nectar/server.pid` (`bundle exec rails` without `bin/rails`) |

- **Python deps** go into a venv at `<worktree>/.nectar/venv`, never a global or user
  site. With `uv` on PATH: `uv sync --frozen --no-dev` into that venv when `pyproject.toml`
  and `uv.lock` exist, else `uv venv` + `uv pip install -r requirements.txt` (or
  `-r pyproject.toml`). Without `uv`: `python3 -m venv` + `pip install -r requirements.txt`,
  or the `[project].dependencies` list of `pyproject.toml`. `requirements.txt` wins over
  `pyproject.toml` unless uv and `uv.lock` are both present.
- **Build** is a new internal `WebRecipe.build` step, run after checkout and before the
  serve spawn on every publish; failure is `E_INSTALL` with a log tail. `nectar.toml` has
  no build key; it stays the recipe's job to name its own commands. `.nectar/` is kept
  across republishes (excluded from `git clean`), so reinstalls are incremental.
- **Serve** commands `exec` the server so `serve.pid` is the server itself, bind
  `127.0.0.1`, and carry everything they need in the command string (relative venv and
  `BUNDLE_PATH`), so a supervisor restarting `cd <worktree> && PORT=<p> $SHELL -c
  "<serve.cmd>"` gets the same process. Liveness, quota, gc, `stop`/`rm` and `expose` are
  unchanged.
- **Missing runtime.** Each fallback names the binaries it needs (`uv` or `python3`;
  `ruby` and `bundle`). If one is missing, publish fails fast with `E_PLATFORM` before any
  env is created; the message and `details.hint` say to install it, publish from a node
  that has it, or declare `[web] serve` in `nectar.toml`. `--dry-run` lists `missing`.
- Not handled: Django migrations (run them in the app or via `nectar.toml`), Poetry/PDM
  lockfiles (deps come from `[project].dependencies`), Rails `db:prepare`, and Rails/Django
  host checks for mesh hostnames (Django fixtures set `ALLOWED_HOSTS`; Rails development
  may need `config.hosts` for the tailnet name).

### 6.2 desktop — the testpack

Desktop review needs a *standard, packet-referenceable, one-click-openable* build. That
standard is the **testpack**.

**Layout** — a zip, name `<app>--<branch-slug>--<platform>.testpack.zip`:

```text
acme-desktop--agent-coupons-stack--darwin-arm64.testpack/
  testpack.json            # manifest — see below
  app/
    Acme.app/           # darwin: the .app bundle
                           # (win: app/Acme/Acme.exe · linux: app/acme.AppImage)
```

**Manifest** — `testpack.json`:

```json
{
  "testpack": 1,
  "app": "acme-desktop",
  "branch": "agent/coupons-stack",
  "commit": "8f3ab21d",
  "platform": "darwin-arm64",
  "kind": "electron",
  "entry": "app/Acme.app",
  "embed": {
    "mode": "webview",
    "url": "https://builder-1.tailnet.ts.net:8444"
  },
  "built_at": "2026-07-18T12:04:11Z",
  "built_by": { "hive_bee": "drone-11", "hive_session": "CL.9fc", "host": "builder-1" }
}
```

- `testpack: 1` — format version; consumers must reject unknown majors.
- `entry` — what `nectar open` launches, relative to the pack root.
- `embed` — **Electron webview mode**: when the app's renderer can run against a served
  URL, the manifest carries it and the desk embeds that URL as a webview *instead of*
  launching the binary — desktop review collapses into web review for the 80 % case, with
  "open the real build" one click away. Produced when the recipe sets `embed_url` (with
  `"web"`, publish spins up the `[web]` env alongside the pack and links it). Non-Electron
  or no embed: field absent, desk shows only "open".
- The manifest deliberately contains no digest. After the zip is finalized, Nectar computes
  its whole-zip SHA-256, stores it in the desktop env record, emits it from `publish --json`
  and `resolve --json`, and makes `open` verify fetched bytes against that value before launch.

**v0 amendment · 2026-07-18:** the earlier manifest `sha256` field was self-referential: a
zip cannot carry its own final digest without changing the bytes being digested. The
authoritative value is therefore the post-zip digest in the env record/resolve result. The
manifest contains no digest; a payload-only digest would add nothing to whole-zip integrity.

**Signing / updates posture** (DECISIONS D6): testpacks are **ad-hoc signed**
(`codesign --sign -` on darwin — the recipe's pack step is expected to do this; nectar
verifies the bundle launches, it does not sign), **never notarized**, and **immutable** —
no update channel, no Sparkle/Squirrel. A new publish is a new testpack; the old one ages
out under quota. Gatekeeper: packs are fetched by the nectar CLI (no browser quarantine
xattr) and, belt-and-braces, `nectar open` strips `com.apple.quarantine` from its own
downloads into `~/.nectar/packs`. These are review builds of code the operator's own agents
wrote, moving only inside the tailnet — notarization would add minutes and an Apple
dependency for zero threat-model gain.

**Distribution.** The pack store `~/.nectar/packs` is served read-only to the tailnet on the
well-known port **8440**, set up by `nectar doctor --fix` once per machine. The packet's
`testpack_ref` is the `nectar://` ref;
`nectar resolve` maps it to the concrete
`https://<host>.tailnet.ts.net:8440/<name>/<file>.testpack.zip`, and `nectar open <ref>`
on any mesh machine fetches (cached in its own pack store by sha256), verifies, and launches
`entry`. Cross-platform: `nectar open` errors with `E_PLATFORM` if the pack's platform
doesn't match — publishing multi-platform packs is one publish per platform (usually the
build machine's own).

**v0 amendment · 2026-07-18:** the sandboxed macOS Tailscale distribution rejects directory
targets. Nectar therefore runs its own detached, read-only static server bound only to
`127.0.0.1`, with no directory listings and traversal/symlink rejection, then configures
`tailscale serve --bg --https=8440 http://127.0.0.1:<pack-port>`. `doctor` verifies the
static server PID + loopback port, the `:8440` proxy entry, and that Funnel is off;
`doctor --fix` idempotently repairs the local server and proxy links. This is also used on
non-sandboxed machines so the external contract is uniform.

### 6.3 cli

Reviewing a CLI means *typing at the branch build*, and the typing should become evidence.

**Publish** (`--mode cli`): worktree + recipe `build`; record `bin`. No serving process —
the env is inert until a shell attaches. Packet field: `shell_recipe` = the `nectar://` ref.

**`nectar shell <ref>`** provisions the review shell:

1. Same-machine: spawn `$SHELL` in the worktree with `PATH=<env bin dir>:$PATH`,
   `NECTAR_ENV=<name>` exported, and a `[nectar <name>]` prompt marker.
   Cross-machine: `tailscale ssh <host> -t nectar shell <name>` — the ref makes this
   transparent; the desk's terminal pane just runs `nectar shell <ref>`.
2. **Recording is on by default**: the session runs under asciinema (`asciinema rec`) when
   installed, else BSD/`util-linux` `script`, writing
   `evidence/<name>/shell-<timestamp>.cast`. `--no-record` opts out; the desk never opts
   out. On exit, the envelope (`--json` on the parent command) lists the new evidence file
   so the agent/desk can attach it to the packet's `test_evidence`.
3. Multiple concurrent shells are fine; each records separately.

### 6.4 backend

No surface to render — the deliverable is *evidence that the thing runs against seeded
data*, plus a pokeable env for the skeptical reviewer.

**Publish** (`--mode backend`):

1. Worktree + deps as usual.
2. Run recipe `seed` (idempotent, env-local — seeded stores live inside the worktree or in
   per-env resources the seed script creates; nectar passes `NECTAR_ENV_DIR` so scripts can
   scope databases/files under the env).
3. Run recipe `smoke`; capture combined output to `evidence/<name>/smoke-<ts>.txt`;
   non-zero smoke exit ⇒ publish **fails** (`E_SMOKE_FAILED`, evidence still written) — a
   backend env whose smoke fails is not review-ready and the bee should know before the
   packet exists.
4. The env stays on disk until TTL: `nectar shell <ref>` works on backend envs too (seeded
   state + branch code, for `curl`ing a locally-started server or inspecting the DB).

Packet: no `preview_url`/`testpack_ref`; the agent puts the smoke summary lines into
`test_evidence` and may append the env ref as a final evidence line
(`nectar://builder-1/acme-api--agent-rate-limit · seeded env, `nectar shell` to poke`).
The desk renders backend packets diff-first, exactly as designed.

### 6.5 ios — the simpack + the streamed simulator

*Added 2026-07-18, post-v0. Targets v0.1 (V0.md).*

iOS review is **simulator-only, streamed-first**. Two artifacts per publish:

1. **The simpack** — the iOS testing package: a build for the iOS *Simulator*, in the
   existing testpack format. Simulator builds need no code signing, no provisioning
   profiles, no TestFlight — they build wherever Xcode runs and launch on any Mac with a
   matching runtime. Device builds are explicitly out of scope (DECISIONS D14).
2. **The streamed simulator** — the hero surface. On the publishing Mac, nectar boots the
   app in a dedicated simulator and streams it interactively to the mesh via
   [serve-sim](https://github.com/EvanBacon/serve-sim) ("the `npx serve` of Apple
   Simulators"): 60 fps video over MJPEG/WS with touch, keyboard, and rotation control in
   a plain web page. `preview_url` therefore embeds in the desk's Test tab *exactly like a
   web env* — the reviewer taps through the app from any tailnet device, including an
   iPad, with zero Xcode anywhere on the review side.

**Host requirement.** Publishing `--mode ios` requires a macOS Apple-Silicon host with
Xcode + simulator runtimes (serve-sim is arm64-only). Non-Mac hosts fail fast with
`E_PLATFORM` — iOS publishes route to the Mac fleet (the `trmd-*-mini*` machines are the
intended publish hosts). Every other mode stays platform-agnostic.

*Field notes (2026-07-19 spike, desk-mac):* two failure modes observed that v0.1 must
design around. (1) Xcode's destination matcher prefers *physical* devices when one is
paired — builds must always pin `-destination` to the nectar-created simulator's UDID,
never a device name. (2) Xcode/runtime skew is real: Xcode 26.6 refused the installed
26.1/26.2 simulator runtimes outright ("iOS 26.5 is not installed"), listing zero eligible
simulator destinations; `nectar doctor` on ios hosts must therefore check for an
xcodebuild-eligible simulator runtime (not merely `simctl list runtimes`), and `E_SIM`
must surface the `xcodebuild -downloadPlatform iOS` remedy.

**Publish sequence** (`nectar publish --mode ios`):

1. Worktree + deps as usual (§6.1 step 1).
2. Run recipe `pack`, which must place the built simulator `.app` (arm64 sim slice) at
   `$NECTAR_PACK_OUT`. For Expo/RN repos the script typically wraps
   `xcodebuild -sdk iphonesimulator` or `expo run:ios --configuration Release`; nectar
   doesn't care, per the not-a-build-system rule.
3. Finalize the simpack into the pack store — testpack format with
   `platform: "ios-sim-arm64"`, `kind: "ios-sim"`, `entry: "app/Acme.app"`, and the
   ios-kind-required manifest field `bundle_id` (simctl launches by bundle id, not path).
   Post-zip digest in the env record per §6.2. Emits `testpack_ref`.
4. Stream (default, `stream = true`): create a **dedicated simulator per env**
   (`xcrun simctl create nectar-<eid> "<device>" <runtime>`), boot it headless, `simctl
   install` the `.app`, `simctl launch <bundle_id>`; then start `serve-sim` against that
   device on an allocated upstream port and expose it with
   `tailscale serve --bg --https=<tport>` like any web env. `preview_url` = the mesh URL
   of the stream. The dedicated device means parallel branch envs never fight over one
   simulator, and GC is clean.
5. Ready-poll the stream URL; write the env record (`serve` gains `sim_udid`,
   `bundle_id`, `serve_sim_pid`).

**Degradation.** serve-sim missing/unsupported (Intel Mac) or failing to start degrades
the publish to **simpack-only**: `testpack_ref` present, `preview_url: null`, loud warning
— same philosophy as F1. A stream that dies post-publish is F3 (`crashed`, log tail,
republish restores the same URL).

**`nectar open <ref>`** on a reviewer's Mac: fetch + digest-verify the simpack, pick or
create a scratch simulator matching `device`/`runtime` (`nectar-open` device, reused),
`simctl install` + `launch`. No Mac / no matching runtime → `E_PLATFORM` with the hint
that `preview_url` needs no install at all. On non-Mac machines `open` just opens the
stream URL.

**Stop/GC** extends the standard lifecycle: kill the serve-sim process group, `simctl
shutdown` then `simctl delete` the nectar-created device (never touches devices nectar
didn't create). Booted nectar simulators count against their own quota (§10.1) — they are
RAM-heavy.

**Evidence.** `simctl io <udid> screenshot` makes screenshots nearly free; v0.1 wires
`nectar evidence add` to accept them, and a later `nectar snap <env>` can capture from the
serving simulator directly. serve-sim's gesture/log APIs are a future hook for scripted
walkthroughs recorded as evidence.

**The AX channel.** serve-sim exposes `/ax` on the stream port — an SSE stream of the
normalized accessibility snapshot: `{screen, elements[]}` with per-element
`{id, path, label, value, role, type, enabled, frame}`. Verified live 2026-07-19 (0.1.45):
the full semantic tree of the foreground app, updating as the UI changes. Because it rides
the same origin as `preview_url`, packets get it for free — no extra port, no extra nectar
work. Two consumers are designed-for:

- *Element-anchored feedback (desk).* The Test tab overlays AX frames on the stream
  (scale by `screen` vs. video size); an inspect-mode click hit-tests client-side and
  inserts a structured element chip into the verdict composer —
  `[tap me · Button · path 0.4]` — so steers carry machine-readable anchors instead of
  "the button lower left". Apiary-side work; coordination item alongside OQ9.
- *Structured assertions (reviewer bees).* An e2e/scout bee curls `/ax` and asserts on
  roles/labels — cheaper and more robust than screenshot reading. v0.1's
  `nectar evidence` can snapshot `/ax` at publish as a baseline evidence line.

Caveat: AX `path`s are positional and shift with layout; the durable anchor is the app's
own accessibility identifier (RN `testID` → AX id). House rule for reviewable apps: set
`testID` on interactive elements. serve-sim also defines an unavailability error for
sims without AX — treat `/ax` as best-effort, never gate publish on it.

**Desktop parity (implemented 2026-07-19).** Testpacks get the same channel: `nectar
open` on a desktop env launches the build, finds its pid, and starts a loopback **AX
bridge** — a swiftc-compiled helper (`assets/ax-dump.swift`, cached per source hash under
`~/.nectar/bin`) walks the macOS Accessibility tree (with the `AXManualAccessibility`
handshake Electron requires) and emits snapshots in the exact serve-sim schema; a small
SSE server (`src/ax-bridge.ts`) relays them at the `ax_url`/`ax_pid` returned in the open
envelope (`--no-ax` opts out). Loopback-only by design: the bridge serves the machine
doing the reviewing, and dies with the app. Requires Accessibility permission for the
process running nectar; without it `/health` reports `ax-not-trusted` with instructions,
and the open still succeeds with `ax_warning`.

**Packet mapping.** `packet_fields` emits `preview_url` (stream) + `testpack_ref`
(simpack) — both fit the existing Forum schema unchanged. The desk-side
`ReviewPacketKind` vocabulary (`web | desktop | cli | code`) has no `ios` yet; until
Apiary adds one (open question 9), ios packets will render acceptably as `web` (the
stream embeds), but the kind glyph and "open the simpack" affordance want the real kind.

## 7. CLI surface

Global flags: `--json` (envelope output, exact shape below), `--repo <path>` (default: cwd's
repo), `--direct` (never use nectard, act on `NECTAR_HOME` in this process).

Another node (D29 amendment): `publish --host <node>`, `ls --host <node>`, and `show`,
`resolve`, `touch`, `stop`, `rm` with a `nectar://<node>/<env>` ref whose host is not this
machine run against that node's tailnet listener (§4.5). The CLI finds the node's IPv4 in
tailscaled's status by MagicDNS name, its first label or its host name; none is
`E_NOT_FOUND`. These calls go through the local nectard like any other when it answers,
and otherwise run in-process even when `NECTAR_HOME` is read-only, since they write
nothing here. Only when `remote.ssh_fallback` is `true` in `nectar.json` does a node
that cannot be reached fall back to `tailscale ssh <node> nectar …`. `publish --host`
ships a tar. Anything inside a git repo ships as `git archive` of the branch's commit
(`--branch`, else the current branch, else the D29 slot for a detached HEAD) plus the
published path inside it, so the target gets only committed files, never `.git` or its
config, and runs the same detection as a local publish of that commit (a repo without
`nectar.toml` included). A static site inside a repo ships only its own path from that
commit (the page, or the directory holding `index.html`), so the rest of the repo, its
symlinks included, never leaves this node. A recipe publish ships the whole committed tree.
Before sending, the publisher reads the archive's symlinks and refuses (`E_USAGE`,
`refused: "symlink"`, `links: […]`) any that is absolute or leads outside what is shipped,
naming each one: `Symlink 'site/leak.md' (-> ../other/readme.md) points outside site`. The
target's archive rules below are unchanged and still apply. Uncommitted edits are not
shipped. A static page or directory in a repo that is not committed is `E_USAGE` ("commit it first"), except when git ignores it
(build output such as `dist/`), which ships as files. A static site outside any repo ships
the files a local static publish would copy. For a static site `--branch` is a label, so
an unknown branch ships `HEAD`. `--worktree` does not apply.

Route (D29): `publish`, `ls`, `show`, `resolve`, `touch`, `stop` and `rm` go through the
local nectard (§4.5 control socket) when it answers for the same `NECTAR_HOME`.
Otherwise they run in-process if `NECTAR_HOME` is writable (or can be created). If it is
not, `ls`, `show` and `resolve` still answer from the records in read-only mode. They
write nothing: no liveness write-back and no touch. `show` and `resolve` add
`touched: false` and `touch_skipped: "<why>"`. The others fail with `E_DAEMON`. Every other command runs in-process. On a read-only
`NECTAR_HOME` it fails with `E_DAEMON`. Through nectard, publish runs with nectard's
environment (the unit's frozen `PATH`), not the calling shell's. Use `--direct` from a
normal shell to publish with the shell's own toolchain. Everything an agent needs is a flag — no interactive prompts on any command an agent
runs. Envelope matches Forum's shape so every harness already knows how to read it:

```json
{ "ok": true,  "command": "publish", "result": { … } }
{ "ok": false, "command": "publish", "error": { "code": "E_SERVE_TIMEOUT", "message": "…", "log_tail": ["…"] } }
```

Non-zero exit iff `ok: false`. Error codes are part of the contract: `E_NO_RECIPE`,
`E_NO_MODE`, `E_CHECKOUT`, `E_INSTALL`, `E_SERVE_TIMEOUT`, `E_SMOKE_FAILED`, `E_PORTS`,
`E_TAILNET_DOWN`, `E_PLATFORM`, `E_NOT_FOUND`, `E_QUOTA`, `E_SIM` (simctl
create/boot/install/launch failures, with the simctl stderr in `error.log_tail`),
plus (added post-v0 review, 2026-07-19):

- `E_USAGE` — the invocation itself is wrong (unknown command/flag, bad `--ttl`,
  `rm` of a serving env without `--force`). Fix the call, not the environment.
- `E_BUSY` — a per-env lock is held by a live process; retry shortly. (Stale locks
  from killed processes are stolen automatically, so E_BUSY always means real work
  is in flight.)
- `E_VERIFY` — testpack/simpack verification failed (sha mismatch, invalid or
  escaping manifest entry, metadata mismatch). Never launched; `E_PLATFORM` now
  means platform mismatch only, including a host that lacks the runtime a fallback
  recipe needs (§6.1.2).
- `E_INTERNAL` — an unexpected internal failure (bug, fs error); `details.unexpected`
  is set when it was not a typed nectar error. Report it, don't remediate.
- `E_DAEMON` (2026-10-14, D29) — `NECTAR_HOME` is read-only here (a Honeybee Cell) and
  no nectard for that home answers on the control socket, for `publish`, `touch`, `stop`
  or `rm`, or for any command nectard does not serve. (`ls`, `show` and `resolve` fall
  back to a read-only view instead.)
  `error.hint` is `nectar daemon install`. The user runs it from a shell outside any
  Cell. An agent reports it as a blocker and does not install anything itself.
- `E_REMOTE` (D29 amendment) — the node exists but nothing answers on its tailnet listener
  (no nectard, an old one, or `remote.listen` off), or something other than nectard
  answered. `error.hint` is `on <node>: nectar daemon install --remote`.
- `E_FORBIDDEN` (D29 amendment) — the target's nectard refused this node: WhoIs failed,
  `remote.allow` does not list it, its `nectar.json` is unreadable, or the env belongs to
  another node. `error.node_id` is this node's stable ID, for the target's allowlist.
- `E_DEPS` — a `[deps]` database did not come up healthy, Docker refused a teardown step,
  or the local Postgres cluster failed to init, start or run Nectar's SQL (§5.1); `log_tail`
  has Compose's, `initdb`'s, `pg_ctl`'s or `psql`'s output, with passwords as `***`. `E_SEED` — the scenario seed exited non-zero.

### Commands

```bash
nectar publish [path] [--mode web|desktop|cli|backend|ios|dev|static] [--branch <b>]
               [--ttl 7d] [--worktree <path>] [--packet <hint>] [--name <app>] [--fresh] [--dry-run]
               [--host <node> | --local] [--public] [--json]
    # Idempotent upsert per (app, branch, mode): re-publish refreshes checkout, restarts
    # serve, keeps ports and URLs stable; a failed web republish leaves the old serve
    # running (§6.1). --name overrides the app name for any source; a different source
    # colliding with an existing env is E_USAGE. --worktree borrows an existing checkout instead
    # of creating one (agent worktrees; nectar then never deletes it — DECISIONS D2).
    # [path] overrides --repo. Static sites (a directory of HTML or one .html file) are
    # detected or forced with --mode static and publish as web envs (§6.1.1). Python and
    # Rails apps without a recipe publish through the §5 fallbacks (§6.1.2). --dry-run
    # prints the matched recipe source, stack, reason, build, serve, deps and seed; it changes
    # nothing. --fresh drops and recreates the env's [deps] databases and re-runs the seed (§5.1).
    # --host <node> ships the source to that node's nectard and publishes there (§4.5, §7
    # route); the result's ref is nectar://<node>/<env> and its URLs are the node's.
    # Without --host, a configured pool (§4.6) may place web and static publishes on another
    # node; the result then carries placed_on and placement_reason. --local stays here.
    # --public also exposes the env, gated, through the default exposure target (§4.7);
    # the result adds url, share_url, public {target, gate, expires_at, password, …} and
    # secret. With --host the target node exposes it with its own config and relayd sees
    # that node as the owner. A failed exposure is an error that names the published ref.

nectar expose <env|ref> [--to <target>] [--gate password|none] [--password <p>]
              [--public] [--ttl <d>] [--expose-interactive] [--rotate] [--json]
nectar unexpose <env|ref> [--json]
    # Put a serving env on the internet through a relay (§4.7, D21). --gate none needs
    # --public; iOS streams need --expose-interactive. --rotate (relayd) replaces the gate
    # password of a live route. Both go through nectard from a Cell.

nectar pool ls | add <hosts…> [--prefer first-healthy|least-loaded] [--for web,static]
          | rm <hosts…> | check [--json]
    # The hosts that take this node's web and static publishes (§4.6). check asks each
    # host's listener for version, nectard, mesh, deps provider, env count and load.

nectar ls [--json] [--mode <m>] [--status <s>] [--host <node>]
    # This machine's envs: name, mode, status, urls.mesh, expires_at (ISO), expires_in,
    # publisher bee, liveness. Listing does not touch.

nectar show <env|ref> [--json]
    # { env: <full record>, name, mode, status, ref, urls, serve, pid, pgid,
    #   ports: { upstream, tailnet }, liveness, deps, expires_at, expires_in, failure }
    # deps: per dep { kind, env, image, project, port, database, user, file, url } with
    #   the password in url shown as *** (§5.1); null without [deps].
    # (missing values are null) + log_tail (last 40 lines) when status is crashed or
    # unhealthy. Touches the env (TTL reset).

nectar open <env|ref>
    # web → open urls.local when resolve.is_self, otherwise urls.mesh ·
    # desktop → fetch/verify/launch testpack ·
    # ios → fetch/verify simpack, simctl install+launch (Mac) or open the stream URL ·
    # cli → alias for `nectar shell` · backend → print evidence + shell hint.
    # Always touches the env (TTL reset).

nectar shell <env|ref> [--no-record] [--json]
nectar resolve <ref> [--json]
    # ref → concrete consumables: { env, ref, mode, commit, current_commit, stale, is_self,
    #   urls, testpack_url, sha256, size_bytes, platform, entry, bundle_id, ax_url, host,
    #   status, liveness, packet_fields, expires_at, expires_in } (+ log_tail when crashed or
    #   unhealthy); a bare env name matching several modes returns { env, host, is_self,
    #   resolutions: [...] } with that shape per mode.
    # packet_fields has publish's keys and meaning (preview_url, testpack_ref, dev_ref,
    # shell_recipe, public_url), read from the record, so it shows the current mesh and public
    # URL; a desktop env's preview_url is null here (publish fills it from its embedded web
    # env). expires_at is the expiry after this resolve's touch. A remote ref returns the
    # remote's values; when the remote's Nectar predates these fields, ref and packet_fields
    # are derived from its urls and mode (public_url from urls.public) and expires_at /
    # expires_in are null. When the env is expired, cold, stopped or crashed, nothing serves
    # its URLs, so packet_fields.preview_url is null and preview_url_reason says why.
    # Consumers prefer urls.local when is_self, urls.mesh otherwise. Touches the env.

nectar touch <env|ref> [--ttl <duration>]
    # Re-arms with the env's own TTL; --ttl replaces that TTL from here on. Implicit
    # touches (open/resolve/show) re-arm the env's own TTL, never the 7 d default.
    # Result expires_at is one ISO string, or an env→ISO map when a bare env name
    # matched several modes whose expiries differ. Implicit touches skip expired/cold
    # envs (republish revives them); explicit touch still re-arms them.
nectar stop <env|ref>        # stop serve process, keep everything; status → stopped
nectar rm <env|ref> [--force]  # stop + delete worktree/packs/evidence/record (uses trash);
                             # a *serving*/*unhealthy* env refuses without --force (E_USAGE)
nectar gc [--dry-run] [--json]
    # Enforce §10: expire → stop; cold → delete worktrees; reap old records; prune pack
    # store to quota (LRU). Prints a reap report. Safe to run concurrently (per-env locks).
    # Also syncs relayd exposures (§4.7): exposures[] of {env, action, reason, expires_at}.

nectar evidence add <env> <file...>   # copy files into evidence/, print refs
nectar evidence ls <env> [--json]

nectar daemon install [--remote | --no-remote] | uninstall | status [--json]
nectar daemon run [--interval 30s] [--gc-interval 1h]
    # nectard (§4.5). install writes and starts the launchd agent / systemd --user unit;
    # uninstall is the one removal command (stops it, deletes the unit, envs keep running);
    # on macOS it waits up to 25 s until launchctl print no longer finds the agent and
    # reports unloaded and waited_ms (a warning if it is still loaded);
    # run is the foreground supervisor the unit starts. status adds socket (the control
    # socket path) and control (nectard's hello: api, pid, nectar_home, ops; null when
    # nothing answers there; also program and remote, see §4.5) and remote ({listen, port,
    # listening, address, last_error, last_reason, discovery}: listen is nectar.json, the rest is what nectard
    # reports; last_error also says when nectard does not answer, runs an older build
    # that reports no listener, or read remote.listen off when it started). install --remote turns on the
    # tailnet listener (remote.listen in nectar.json); --no-remote turns it off.

nectar doctor [--fix [--dry-run]] [--no-daemon [--save]]
    # Checks (§10.5): portless on PATH + proxy up · tailscale up (names the CLI
    # used and its source, §4.5) · tailscale-serve: this user may change the serve
    # config (Linux) · a 443 serve entry (warning, left alone) · no funnel · Serve entries in Nectar's tailnet range, classified
    # owned / orphan / foreign / ambiguous · dead or expired envs still holding a process or
    # Serve entry · gc recency · nectard installed, active and pointing at this install ·
    # remote: the tailnet listener (listener: off | listening, with address <ip>:8441 |
    # failed, with the reason; api and localapi as in the tailscale check). doctor asks
    # the listener for /v1/hello from this node: refused as "self" means it listens and
    # WhoIs works, refused as "whois" means it refuses every caller (reason from
    # nectard.log), no answer is failed with what nectard's hello says about its listener
    # and its last remote_listen_failed/closed/off message, plus last_reason and
    # nectard_discovery from the hello; discovery is doctor's own. The check carries last_event
    # (the newest listener lifecycle event in nectard.log) and refusals ({count,
    # window_hours: 24, last: {at, rule, node_name, node_id, login, tags}}; self-checks
    # are not counted) ·
    # tools env recipes need on PATH and on nectard's PATH · pack store on 8440 · port
    # ranges · pack quota. --fix runs gc, removes orphan entries, releases dead envs,
    # installs or reinstalls nectard and restarts the pack server (testpacks only: with no
    # packs stored, a stopped pack chain is a warning); --dry-run lists those
    # actions without making them. Result: { healthy, checks[], actions[] } where every
    # action has { action, target, reason, status, before, after }. Check status is pass,
    # info, warn or fail; only fail makes healthy false. --no-daemon never installs or
    # restarts nectard and reports it as info; --save stores that as daemon: "disabled"
    # in nectar.json until `nectar daemon install`.
```

### `publish --json` result (web example)

```json
{
  "ok": true,
  "command": "publish",
  "result": {
    "eid": "e7f3",
    "env": "acme--agent-coupons-stack--web",
    "mode": "web",
    "branch": "agent/coupons-stack",
    "commit": "8f3ab21d",
    "ref": "nectar://builder-1/acme--agent-coupons-stack--web",
    "urls": { "local": "https://agent-coupons-stack.acme.localhost",
              "mesh": "https://builder-1.tailnet.ts.net:8444" },
    "packet_fields": {
      "preview_url": "https://builder-1.tailnet.ts.net:8444",
      "testpack_ref": null,
      "shell_recipe": null
    },
    "evidence": [],
    "expires_at": "2026-07-21T12:04:11Z",
    "warnings": ["portless proxy not running — local URL degraded to http://127.0.0.1:4117"],
    "mesh_error": null
  }
}
```

`mesh_error` (web, static, and desktop with an embedded web env) is `tailscale serve`'s own
output when it refused the mesh entry, else null. The warning quotes it. When tailscaled
denied the change ("Access denied: serve config denied"), the warning says this user is not a
Tailscale operator and to run `sudo tailscale set --operator=$USER` once. Nectar never runs
sudo. When Nectar could not get a tailnet name at all, the warning is "tailscale unavailable:
<cause>" and `mesh_error` is that cause: the LocalAPI endpoint, or the binary and its source,
and why the call failed (exit code and stderr, a signal, a timeout, output that is not status
JSON, or a `BackendState` other than `Running`). Every `mesh_error` ends with the API that was
used (§4.5 "Talking to tailscaled").

`result.packet_fields` is the ergonomic core: **the exact strings to copy onto the Forum
packet**, keyed with Forum's snake_case names. Desktop publish fills `testpack_ref`
(+ `preview_url` when the manifest has `embed`); cli publish fills `shell_recipe`; backend
fills none and returns `evidence` lines instead.

## 8. How agents invoke it — hive/harness ergonomics

The review-ready ritual, harness-agnostic (bash + jq only):

```bash
out=$(nectar publish --json --packet "$PACKET_ID")
prev=$(jq -r '.result.packet_fields.preview_url // empty' <<<"$out")
ref=$(jq -r '.result.ref' <<<"$out")
# put $prev / testpack_ref / shell_recipe on the packet via forum's CLI; append
# .result.evidence lines to test_evidence. Then flip the session to review-ready.
```

Rules of engagement for bees (goes into project AGENTS.md snippets):

- Publish **before** declaring review-ready; a packet whose kind has a surface but whose
  reference fields are empty is malformed.
- Never hand-craft URLs — always pass through `packet_fields`.
- A failed publish is a blocker, not a shrug: fix or escalate; the `crashed` env's
  `nectar show` log tail is your first stop.
- Re-publish after addressing review feedback — same command; URLs are stable, so the
  packet's references keep working across iterations (successor packets inherit them).

Nectar reads `HIVE_BEE` and the hive session env to stamp `publisher` — that is the entire
hive integration surface. No hive API calls, no harness detection.

## 9. Security model

### 9.1 What the tailnet sees

- Exposure = tailnet-only, on ports **8440** (pack store, read-only static) and
  **8443–65535** (web envs). Nothing binds public interfaces; funnel is never used.
- **8441** is nectard's tailnet listener, only when `remote.listen` is on (§4.5). It binds
  the node's Tailscale address only, identifies every caller with WhoIs, and serves only
  the allowlist (default: the node owner's own untagged nodes). An allowed node can run
  code here as the user, because a publish runs the shipped recipe, so list node IDs of
  machines you trust that much. The ACL should limit 8441 to pool hosts and operator
  devices as a second layer. `tailscale serve` is not put in front of it, because that
  would hide the peer address WhoIs needs; WireGuard already encrypts the hop.
- **8450** on the relay host is nectar-relayd's control port (§4.7). It binds the relay's
  Tailscale IPv4 only, identifies every caller with WhoIs and serves only listed stable
  node IDs; each node manages only routes to its own MagicDNS name and preview ports.
  The ACL should let only pool hosts reach it and let the relay reach only 8443–65535 on
  pool hosts (design/relayd-acl-diff.md in the Project).
- Reachability is tailscale ACL policy. **Today's tailnet is not single-user** — it includes
  a shared external node (`shared-node`, user `mbtz@`). Deploy rule (ops task, not code):
  ACL-restrict `8440-65535` on nectar hosts to the operator's own devices. `nectar doctor`
  reminds; it cannot verify ACLs.
- Dev servers are dev servers: debug endpoints, sourcemaps, verbose errors. Acceptable
  inside the ACL boundary above; a nectar-side signed-token layer is the designated
  hardening step if the tailnet ever grows real second users (DECISIONS D9).
- Streamed simulators (§6.5) are **interactive control surfaces** — anyone who can reach
  the port can tap, type, and drive the app under test. Same ACL boundary, but it raises
  the stakes of the ACL rule above from "can read a dev server" to "can operate a device";
  the ios ports live in the same 8443–65535 block that rule already covers.

### 9.2 Secrets

- Serve/pack/seed/smoke commands run with a **scrubbed environment**: `PATH`, `HOME`,
  `SHELL`, locale, `PORT`/`NECTAR_*`, plus exactly what the recipe declares. Agent-session
  variables (API keys, hive tokens, `VALHALL_HEM_TOKEN`) are **not** inherited.
- `[secrets]` entries resolve via `hem get <ref>` at publish time and must be test-scoped
  refs (`project/<p>/*-test` convention); values go into the child env only, never the env
  record, never logs. A pending-approval response from hem aborts publish with the
  approval instructions in the error envelope — the bee escalates to the human.
- Env records, envelopes, and evidence are secret-free by construction — with one
  honest caveat: `error.log_tail` is the raw last lines of the branch process's
  output. An app that prints its own config/secrets on boot puts them there. The
  scrubbed environment keeps *injected* agent tokens out of that output; what the
  branch chooses to print is the branch's doing.

### 9.3 Untrusted branch code

Branch code executed by nectar (serve/build/seed) runs as the operator's user on the
publishing machine — the same code the agent just wrote, built, and tested in the same
account. **Nectar adds no sandbox and claims none.** The honest statement: nectar's trust
boundary equals the existing agent-execution trust boundary; the scrubbed env (9.2) removes
the *casual* exfiltration surface (inherited tokens), nothing more. If agent code ever runs
with less trust, publishes belong in that same jail — a dedicated runner user/VM is the
noted future step, out of scope here.

**Cells (D29).** An agent in a Honeybee Cell publishes through nectard's control socket.
nectard runs the build and serve commands outside the Cell's sandbox, as the user. These
are the same commands a local publish of that source would run, and the socket accepts
no others: it has no command, environment or recipe field. The socket is reachable only
by the same user on the same host (0600 socket in a 0700 directory). Publish paths are
limited to the home directory and the caller's Cell, and Nectar's own state and the
usual key directories are excluded, so a Cell cannot ask nectard to serve files its
sandbox hides from it elsewhere. The caller's session name only picks a detached
HEAD's slot (§3); it grants nothing, and a different repo that lands on the same slot is
refused by the same source checks as any other republish. Git is the other way a repo can make nectard run something,
through its own config and hooks. So every git command Nectar runs (rev-parse, branch,
status, worktree add/remove/prune, reset) runs with global and system config ignored
(`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`; a Linux Cell can write
`~/.config/git/config`). It runs with every transport refused (`GIT_ALLOW_PROTOCOL=none`,
`protocol.*.allow=never`) and lazy fetch off (`GIT_NO_LAZY_FETCH=1`), so a planted
promisor or `ext::` remote never runs. Replace refs and grafts are ignored
(`GIT_NO_REPLACE_OBJECTS=1`, `GIT_GRAFT_FILE=/dev/null`) and the commit-graph is not read
(`core.commitGraph=false`), so what Nectar checks out and the root commits it compares (§3)
come from the repo's real objects. It pins `core.hooksPath=/dev/null`,
`core.fsmonitor=false`, `gc.auto=0`, `maintenance.auto=false` and submodule recursion off.
Every filter driver and `hook.*` entry in the repo's config (including `include.path`,
`includeIf` and worktree config) is neutralized. The filter's `smudge`, `clean` and
`process` become empty with `required=false`, and the hook command becomes `true`.
These overrides go through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`, so a key such as
`filter.a=b.smudge` cannot escape them. If nectard cannot read the repo's config, the
command fails. A partial clone (`extensions.partialClone` or a promisor remote) is
refused with `E_CHECKOUT`. Files check out unfiltered, so Git LFS files arrive as
pointers. A test plants all of
these in a repo and publishes, republishes and borrows it through nectard. Running a
Cell's serves under the Cell's own sandbox profile is the hardening step if Cells ever
hold less-trusted code.

**Other nodes (D29 amendment).** `publish --host` runs the shipped recipe on the target as
the user, exactly as a local publish of that tree would, so the allowlist (§4.5) is a
code-execution grant. The target never fetches, clones or reads git config from the
caller: it unpacks a tar under the archive rules of §4.5 and makes its own repository,
with the same git hardening. The caller sends only committed files (`git archive`) or a
static site's files, never `.git`.

## 10. Resource limits, GC, failure modes

### 10.1 Limits (machine config `~/.nectar/nectar.json`, defaults shown)

| knob | default | on exceed |
| --- | --- | --- |
| running dynamic web apps | Available host memory | No preview-count refusal; sleep eligible idle apps and try configured pool hosts before reporting `E_QUOTA`. Admission needs 256 MiB plus a reserve of min(1 GiB, RAM / 8); static previews bypass it |
| streamed nectar simulators (ios) | 1 | `E_QUOTA` — serve-sim 0.1.45 cannot run two encoder instances (OQ8); raise when upstream fixes multi-instance |
| tailnet ports | 8443–65535 | `E_PORTS` only when the configured range has no available port |
| upstream ports | 4100–65535 | `E_PORTS` |
| pack store size | 10 GB | LRU prune at `gc`, never mid-publish below 1 pack |
| evidence per env | 500 MB | oldest recordings pruned at `gc` |
| serve log | 10 MB × 2 | rotate |

The old default 100-port ranges are expanded on read, including saved copies of those
defaults, even if those exact values were deliberately pinned; other custom ranges
are preserved. The allocator skips occupied listeners on any
local interface, recorded app/proxy/dependency/mesh ports, and existing Tailscale Serve
entries. Pack/control ports 8440, 8441, 8450 and 8451 are excluded from preview
allocation and relay routes. Port 443 is always excluded, even with a misconfigured
range. Upstream and
tailnet ranges may overlap; a publish reserves its chosen upstream before choosing its
mesh port. A supervised web preview normally needs two upstream ports (app and viewing
proxy) and one mesh port. There is no independent preview-count refusal. Real remaining
limits are memory admission, available TCP ports, process/file-descriptor limits, disk,
and the host's Tailscale/ACL policy. The relay accepts preview ports through 65535;
operators must update relay deployments and any narrower tailnet ACLs before expecting
higher mesh ports to be reachable. Doctor never removes an unrecorded entry outside the
legacy ranges merely because its port falls inside an expanded range (more than
100 configured ports).

### 10.2 GC policy

`nectar gc` (idempotent, per-env lockfiles): expire past-TTL envs (stop process group,
remove tailscale-serve entry, stop `[deps]` containers) → cold at expiry+24 h (delete
worktree; remove `[deps]` containers, network and volume by label, §5.1; once, a `cold` env
is not cooled again) → reap records at
cold+14 d → prune pack store/evidence to quota. Expire and cold set `urls.mesh` to
`null` once the env's own Serve entry is gone (removed, or confirmed absent or foreign), so
`ls`/`show`/`resolve` never hand out a dead mesh URL; the `serve` block keeps its ports and a
republish restores the same URL. `nectar stop` does the same. Grace: envs *touched after publish* within
the last 6 h are never transitioned, so an open review can't be reaped underneath the
reviewer (open/resolve/show/touch all bump `last_touched_at`). The publish stamp itself does not
count as a touch — otherwise `--ttl 1m` would silently mean six hours. A busy env (lock
held by a live publish) is skipped and reported, never an abort of the sweep. Every non-dry
run also removes Nectar-range Serve entries whose loopback proxy target is dead, once before
the transitions and again after them when a transition ran, because stopping an env's process
can free an upstream that another entry still points at. An entry
whose dead target is the owning env's nectard `proxy_port` while the app still answers is
pointed back at the app instead (§4.5). Otherwise, if an env
record owns the entry, GC kills its process group, clears its runtime claims, and marks it
`crashed` with failure details (an `expired`, `stopped` or `cold` owner keeps its status and
ports; only the entry and its `urls.mesh` go). "Dead" and "Nectar's" are defined by §10.5's classification, which
`gc`, `doctor` and `doctor --fix` share. Stopping an env's process group (gc, `stop`, `rm`)
signals it only when a process in the group still carries that env's `NECTAR_ENV`, and
removing its Serve entry is skipped when anything on its tailnet port is not the env's own `/`
proxy to its upstream or proxy port. nectard's revive, mesh re-assertion and unfronting apply the same check and
leave such a port alone (the env serves locally with `urls.mesh: null` until a republish).

### 10.3 Scheduling

`nectard` (§4.5) runs gc at start and hourly. Machines without it can still schedule hourly
`nectar gc --json` externally (a pollinate schedule, cron or a launchd line). `nectar doctor`
warns if `gc` hasn't run in 24 h.

### 10.4 Failure modes (contract, not aspiration)

| # | failure | behavior |
| --- | --- | --- |
| F1 | portless missing / proxy down | web publish **succeeds**; `urls.local` degrades to the healthy IPv4/IPv6 loopback origin; warning in envelope; mesh URL unaffected |
| F2 | tailscale down / logged out, or `tailscale serve` refused | publish succeeds local-only: `urls.mesh: null`, `packet_fields.preview_url` falls back to `urls.local`, loud warning (`E_TAILNET_DOWN` only if `--require-mesh`); a refused serve quotes tailscale's output in the warning and `mesh_error`, with the operator hint when it was a permission denial |
| F3 | serve crashes post-publish | lazy detection on every read → `status: crashed` (process gone) or `unhealthy` (port silent), back to `serving` when the port answers; `show`/`resolve` return log tail; desk renders "surface down — re-request publish"; re-publish restarts on the same URLs |
| F4 | `ready_path` never 200s | publish fails `E_SERVE_TIMEOUT` with log tail; detached process killed, Serve entry removed, runtime fields/port claims cleared; env kept as `crashed` with `failure` details |
| F5 | port collision or stale Serve proxy | allocator probes IPv4+IPv6 before binding and skips occupied ports; `doctor` reports Serve entries targeting dead loopback ports; `gc` / `doctor --fix` remove only the orphan class of §10.5 and clear matching env claims; foreign and ambiguous entries are reported and left alone. A republish keeps its tailnet port only while the entry there is still its own; if something else took the port, the republish leaves that entry alone, moves to a free port and warns that the mesh URL changed |
| F6 | checkout conflict / dirty nectar worktree | worktree is nectar-owned ⇒ `git reset --hard` + clean is always legal; borrowed `--worktree` is never reset — publish fails `E_CHECKOUT` instead |
| F7 | smoke fails (backend) | publish fails `E_SMOKE_FAILED`; evidence written; no packet fields emitted |
| F8 | testpack fetch sha mismatch | `open` deletes the download, retries once, then errors — never launches an unverified pack |
| F9 | machine offline at review time | `resolve`/`open` report `host unreachable` with the host name — the desk shows it; references are machine-bound by design (DECISIONS D4) |
| F10 | hem approval pending for a `[secrets]` ref | publish aborts with approval instructions in error envelope; human approves; bee retries |
| F11 | `--mode ios` on a non-Mac / non-arm64 host | fails fast `E_PLATFORM` before any work — route the publish to a Mac host |
| F12 | serve-sim missing or fails to start | ios publish **succeeds** simpack-only: `preview_url: null`, `testpack_ref` present, loud warning; stream death post-publish is F3 |
| F13 | simctl failure (no runtime, boot timeout, install/launch error) | publish fails `E_SIM` with simctl stderr; env kept as `crashed`; nectar-created device cleaned up |
| F14 | `open` on a Mac without a matching iOS runtime | `E_PLATFORM` with the `preview_url`-needs-nothing hint; non-Mac `open` goes straight to the stream URL |
| F15 | publishing host requests its own tailnet Serve URL | Tailscale supplies no caller identity and Serve returns 403; `resolve.is_self: true` tells consumers to prefer `urls.local`; packet `preview_url` remains the canonical mesh URL |
| F16 | `[deps]` postgres on a host where this user cannot reach Docker | without a `provider` key, the dep uses the local provider when the host has Postgres 13+ binaries (a pinned major it lacks gives a warning); with neither, or with `provider = "docker"`, publish fails `E_PLATFORM` before any checkout, with a hint naming Docker access and local Postgres binaries; Nectar never changes Docker access and never installs Postgres; `doctor`'s `docker` and `postgres-provider` checks say the same |

### 10.5 `doctor --fix`

`nectar doctor --fix` repairs only what is provably Nectar's, and is safe to re-run: a second
run on a repaired machine plans no actions. `--dry-run` prints the same action list with
`status: planned` and changes nothing.

**Serve entries.** Every `tailscale serve` target under a port in
`tailnet_port_start..tailnet_port_end` (8440, the pack store, is handled separately; ports
outside the range are never read) is classified (`src/doctor.ts`):

| class | rule | doctor | `--fix` / gc |
| --- | --- | --- | --- |
| owned | the env record holding this tailnet port has this upstream port or this `proxy_port` (§4.5), and its process (carrying its `NECTAR_ENV`) runs, or it is `serving`/`unhealthy` and the upstream answers | pass | kept |
| orphan | loopback HTTP proxy to a Nectar upstream port (in `upstream_port_start..end`, or a record's upstream or proxy port), nothing answers there, no live process of the owning env, mounted at `/`, and the only handler on that tailnet port | `serve-orphans` fail | `tailscale serve --https=<port> off`, after re-reading the table to confirm it is still the port's only handler (a dead `proxy_port` whose app still answers is re-pointed at the app instead); an owning `serving`/`crashed` record is marked `crashed` + `E_SERVE_ORPHAN` |
| foreign | not a loopback HTTP proxy (remote URL, TCP forward, path, text), a loopback port outside Nectar's upstream range that no record allocated, or any entry under a Tailscale Service (`Services`) | `serve-foreign` warn | never touched |
| ambiguous | something answers on the Nectar upstream port but no live env owns it; the record holding the tailnet port points at a different upstream; or a dead Nectar target that shares its port with other handlers or sits on a sub-path (turning the port off would take the others down) | `serve-ambiguous` warn | never touched |

**Dead envs.** A record that is `expired`, `cold`, `stopped` or `crashed`, or past
`expires_at`, and still has its own process (by `NECTAR_ENV`) or a Serve entry pointing at its
upstream is reported by `env-resources` along with pending gc transitions.

**Actions, in order.**
1. `gc` (when it has not run in 24 h or has pending work), reported as one
   `remove-serve-entry` per orphan, one `gc-<transition>` per env and the `gc` run itself.
2. `release-env` for dead envs gc did not cover: stop the env's own process group and its own
   Serve entry; the record keeps its status and ports, and `urls.mesh` becomes `null` once
   the entry is gone (removed, or confirmed absent or foreign), so a republish restores it.
   After the releases, the Serve table is classified again and entries that only now prove
   to be orphans (their upstream was answered by a released process) are removed in the same
   run, with one `remove-serve-entry` / `repoint-serve-entry` each, placed after the
   releases. gc does the same after its own transitions. `--dry-run` cannot list these: they
   are `serve-ambiguous` until the process stops.
3. (skipped with `--no-daemon` or a saved `daemon: "disabled"`; the `nectard` check is then
   `info`) `install-nectard` / `reinstall-nectard` through `nectar daemon install` when nectard is
   missing, inactive, or its unit runs a different node or CLI than the running install. A
   unit bound to another `NECTAR_HOME` is reported and left alone. `nectar daemon uninstall`
   removes it.
4. `start-pack-server` / `serve-pack-store` when Tailscale is up, this user may change the
   serve config (`tailscale-serve` passes) and no Funnel is on: start a
   new read-only pack server (an old recorded PID is never signalled) and point `:8440` at it.

**Serve rights.** On Linux, `tailscale-serve` asks tailscaled whether this user may change
the serve config without changing it: it POSTs a body that is not JSON to the LocalAPI
`/localapi/v0/serve-config` on the endpoint found as in §4.5 "Talking to tailscaled". tailscaled checks
write permission before it parses the body, so a 403 "serve config denied" means the user is
not a Tailscale operator (fail, hint `sudo tailscale set --operator=$USER`), and any other
answer means it may. Without a socket it warns; on macOS it is not probed. `--fix` never
repairs it.

Doctor never starts, stops or configures Portless and never touches port 443, Funnel, or any
process without the env's `NECTAR_ENV`. A Serve entry on 443 is `serve-443` warn with its
targets and a hint: Nectar allocates no tailnet port below 8440 and no Nectar feature binds
443 through Serve, so the entry blocks nothing of Nectar's (portless owns local 443 on the
machines that run it, and some publish their own 443 Serve entry on purpose). Missing tools (`path-tools`, `portless`) are warnings
with hints, not repairs.

## 11. Where the implementation lives

**Own repo — this one.** TypeScript CLI (Node ≥ 20), shipped like `hive` and `portless`
as a globally-linked binary; single package until proven otherwise.

Why not a hive capability: nectar must be invocable by *any* harness and by humans, with a
lifecycle (serving processes, TTLs, per-machine state, doctor) that is nothing like hive's
session model; welding it in couples release cadences and forces non-hive callers through
hive. Why not pollinate: pollinate triggers things — it is nectar's *scheduler* (one gc
schedule), not its home. The couplings that remain are deliberately thin: hive = env-var
stamping; pollinate = one schedule; portless = optional local nicety; tailscale = the mesh;
forum/apiary = consume strings. Each degrades independently (F1/F2).

## 12. Open questions

Genuinely unresolved — flagged here rather than hedged inline:

1. **Portless introspection.** Registering an externally-managed port under a portless name
   (step 6.1.3) assumes portless can adopt a port it didn't allocate, or expose the port it
   did (`portless list` machine-readably). Portless was not installed on the spec machine to
   verify; if it can't, v0 ships the F1 degraded local URL unconditionally and portless
   grows an `adopt <name> <port>` (it's our tool). Owner: whoever builds v0, day 1.
2. **`tailscale serve` per-port ceiling.** The 100-port range assumes tailscale serve
   handles ~15 concurrent `--bg` entries per node without degradation. Believed fine;
   unverified at that count.
3. **Cross-machine `nectar shell` UX in the desk.** `tailscale ssh` from an Electron
   terminal pane needs key/auth plumbing on each host pair. Works for humans in a terminal
   today; the desk integration may want a nectar-side PTY relay instead. Defer until the
   desk's terminal pane exists.
4. **Windows testpacks.** `kontrol-build-ovh` (windows) will eventually publish packs;
   entry-launch and quarantine semantics there are unspecified. Darwin-only until a real
   windows desktop packet appears.
5. **Forum `validation_runs` linkage.** Should reviewer bees' nectar envs (e2e-agent
   opening a preview) stamp their `run_` id into the env record for cost attribution?
   Cheap to add; waiting for Forum v2's validation runner to exist.
6. **Republish vs. reviewer mid-session.** Re-publish restarts the serve process under a
   reviewer's feet (same URL, brief blip). Acceptable; if it isn't in practice, add
   `--drain` (new env, atomic port swap).
7. **Content-pinned testpack refs.** v0 refs identify the mode-qualified env and therefore
   resolve to its latest publish. Long-lived packets may eventually need an exact-build
   digest in the ref so later republishes cannot move their artifact. The v0.1 design must
   preserve direct browser URLs for web while adding content pinning where `open` is the
   consumer.
8. **serve-sim per-env isolation.** §6.5 assumes serve-sim can (a) target one specific
   simulator by device name/udid while others are booted, and (b) run multiple instances
   on distinct ports (its `--list`/`--kill` surface suggests multi-instance is supported).
   Verify both on a mini before v0.1; if instance-per-device doesn't hold, fall back to
   one streamed env per host (quota 1) until it does. Also: pin the serve-sim version as a
   nectar dependency — `npx serve-sim@latest` drift inside a publish path is not
   acceptable.
   *Resolved 2026-07-19 (serve-sim 0.1.45, desk-mac):* (a) holds — device-targeted
   streaming works and binds loopback by default, fitting the exposure model. (b) is
   **refuted**: starting a second serve-sim instance killed the first one's encoder
   (`error encoding frame: encodingFailed`, then exit). The planned fallback shipped:
   `serving_sim_limit` defaults to **1** streamed env per host, so a second ios publish
   fails loudly with `E_QUOTA` instead of silently breaking the first packet's
   `preview_url`. Raise the default when upstream multi-instance is verified.
9. **`ios` in the packet kind vocabulary.** The desk contract's `ReviewPacketKind` is
   `web | desktop | cli | code`; ios packets need their own kind (glyph, "open simpack"
   affordance, Test-tab sizing for a phone aspect ratio). Nectar's emitted fields already
   fit the schema — this is an Apiary/Forum coordination item, not a nectar blocker.
10. **Electron testpack profile isolation.** Observed 2026-07-19: a flyt testpack launched
    via `nectar open` shares `user-data-dir` (`~/Library/Application Support/<app>`) with
    the installed production app — a review build mutating real user data. Candidate fix:
    `open` passes an env the app honors (`NECTAR_USER_DATA_DIR`) or launches Electron
    entries with `--user-data-dir` under the pack cache. Needs a convention apps opt into;
    decide before testpacks are used for apps with valuable local state.

### Session-owned preview cleanup

Hourly GC checks serving previews against `hive list --all --json` on the publisher's host (Tailnet SSH for remote publishers). A confirmed done, archived, or missing owner starts a persisted one-hour grace period; another confirmed inactive observation after that period reaps the environment through the existing cleanup path. Idle and stopped sessions remain active owners. Unknown owners and failed lookups are kept and logged in the GC skipped report. Pinned environments and the main bench are protected. Republish resets the grace period.

The default `serving_web_limit` is now a memory-based capacity estimate; a stored legacy value of 12 reads as the new default. Stored values no longer refuse publishes by count; new web publishes require memory headroom instead. Admission includes reclaimable memory (inactive and speculative pages on macOS, MemAvailable on Linux), with free memory as a conservative fallback. Port-range exhaustion remains a separate resource constraint. The reserve and per-preview allowance are admission estimates, not a guarantee against later application memory growth.

### Proof-aware GC

Before GC changes an environment, it checks linked proof state, including for expired and stopped records. A waiting proof prevents GC retirement, TTL expiry and cold transitions regardless of owner session state. Unknown proof state also preserves the environment and appears in `gc.skipped`. Terminal proofs are reaped through the existing GC removal path after 24 hours from their first observed terminal state. Waiting proofs reset that grace clock. Failed reads retain the clock but block retirement until a successful read. Only confirmed unlinked previews use the existing session abandonment and TTL rules. Pinned previews and the main bench remain protected.

Hosts configure `NECTAR_PROOF_LOOKUP` in nectard's environment (or the CLI environment for direct GC) to an executable path. Nectar invokes it without arguments or a shell, sends one JSON object `{ "version": 1, "ref": "nectar://...", "urls": { "local": "...", "mesh": "..." } }` on stdin, and waits at most ten seconds. The command owns authentication; credentials never appear in the request. It must return one JSON object with `state` equal to `waiting`, `terminal`, or `unlinked`. Any other result fails safe. Nectar checks again under the environment lock before applying a transition.

The adapter must search all relevant Apiary proofs and Projects, including terminal Projects, by canonical URL or Nectar reference. It must match `previewUrl`, evidence `url`, and evidence `nectarRef`. Any waiting proof wins over terminal proofs. `terminal` means all linked proofs are accepted/landed, closed/refused/changes requested, or belong to a finished/dropped Project. `unlinked` requires a complete successful search finding no linked proof. A partial, unauthorized or unavailable search must fail, never claim `unlinked`.

Run the isolated real-daemon fixture with `pnpm build && node test/fixtures/proof-gc.mjs`. It publishes three actual static previews, opens each local URL, then records GC output and environment listings for terminal, waiting and failing lookups. Tailscale and proof metadata are fixtures; no shared preview or host Serve entry is changed.

### Capacity recovery and placement

Dynamic web publish and wake retry E_QUOTA/E_PORTS by putting the least recently viewed
eligible running app to sleep, one at a time. A view is a real request from a person or
agent through the preview URL, including plain curl requests and ongoing request activity.
Nectar readiness/proxy probes and wake operations themselves do not count. Recovery uses
the freshest of live proxy activity and persisted last_viewed_at; persistence is throttled,
but the live map updates on every request. Older records without a saved view and unvisited
previews sort by published_at. last_opened_at remains the separate open/idle timestamp.
Pinned/--keep previews, the
main bench, active requests/streams/upgrades and static previews are excluded. Missing
live activity protects a runtime. Recheck eligibility under its environment lock.
Sleeping retains its files, stable URL listener and mesh route; a later visit wakes it.
Capacity recovery never retires or deletes previews. Retained URL ports cannot be
reclaimed by sleeping, so finite/custom port ranges can still exhaust.

After local recovery, ordinary publishes can try configured pool hosts in least-loaded
order, skipping unhealthy/mesh-denied hosts and retrying capacity refusals. No pool means
an error explaining how to add one, free memory or widen custom port bounds; no automatic
tailnet discovery. --local/--host and received shipments keep their explicit destination.
A wake can place the exact published commit remotely and proxy HTTPS requests/upgrades
through its original URL; the persisted remote target resets on republish. capacity.jsonl
records every pressure decision, including refusals, with ordered candidates, their view
times and timestamp sources, skip reasons (including active requests and held locks), and
chosen previews. It also records wake placements (host, final remote URL) and slept preview
names. Daemon control becomes ready after initial route restoration; Serve edits within a
process are serialized across LocalAPI and CLI paths so concurrent restorations cannot
leave views bypassing the proxy. Control readiness precedes app revival and initial GC,
so slow app startup does not force callers to bypass the daemon. Recovery logs rotate at
log_max_bytes with two previous files, using the existing recoverable log rotation.
A wake response
also names slept previews in x-nectar-slept-previews. Remote placement requires a reachable
HTTPS mesh URL; local-only URLs are not accepted as remote destinations.

Publish JSON includes slept_previews and top-level
preview_url, equal to packet_fields.preview_url. Remote placement adds placed_on and
placement_reason and returns the destination's URL directly. Human output prints the final
`Preview: <URL>`, one `Put to sleep:` line naming any sleeping previews (which wake on a
visit), and one `Published on <host>:` line with the placement reason. Failed publishes
retain the exact error code and actionable message in both human and JSON output; human
failures also name any previews put to sleep before the failure.
Publishing never requires a free place in a preview count; do not remove previews to
make room. Existing pool defaults and
sticky routing still apply before local publishing. Static previews bypass runtime
memory admission and are never capacity victims.

For isolated fixture runs only, NECTAR_TEST_RUNTIME_MEMORY_BYTES gives the daemon a
synthetic byte budget: each running dynamic web process and the next admission charge
256 MiB. Unset/invalid values use normal host-memory admission. This does not alter the
production reserve or add a preview-count cap.

Capacity sleeping gates newly arriving requests until the transition completes. Cold
wakes remain concurrent across environments; admission does not reserve host RAM
atomically. A persisted remote wake target stays until republish. Local removal does
not immediately remove the shipped copy, whose TTL is bounded by the original remaining
TTL; a dead remote target currently requires republish to place again.
