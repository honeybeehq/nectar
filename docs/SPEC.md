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
  (app, branch, mode) per machine; republish upserts.
- **app** — the repo's short name, from the recipe (`name` in `nectar.toml`), else the repo
  directory name.
- **branch-slug** — the branch with `/` → `-` (`agent/coupons-stack` → `agent-coupons-stack`),
  lowercased, `[a-z0-9-]` only.
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
  packs/<name>/             # testpacks + any served artifacts (tailnet :8440 root)
    acme-desktop--agent-coupons-stack.testpack.zip
  evidence/<name>/          # shell recordings, smoke output, screenshots
    shell-20260718T1204.cast
    smoke-20260718T1204.txt
  logs/<name>/serve.log     # dev-server stdout+stderr, rotated at 10 MB
  nectar.json               # machine config: port ranges, quotas, tailnet name cache
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
    "tailnet_port": 8444
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
  record said `crashed` or the recorded PID is gone.
- PID or its process group alive, port silent after retries (300/600/1200 ms timeouts with
  150 ms backoff, ≈2.4 s budget) → `unhealthy` (`port_unresponsive`). Still holds its port,
  counts toward quota, needs `rm --force`.
- Process and group gone, port silent on one probe → `crashed` (`process_exited`).
- No `upstream_port` → process alone decides (`process_alive` / `process_exited`).

The result is stored on the record as `liveness: { state, reason, checked_at, pid_alive,
port_open }` and returned by `ls` (per row), `show` and `resolve`. The record is rewritten
only when status or reason changes (best-effort lock; a publish in flight wins). Crashed
records from a failed publish or orphan cleanup have no `serve` block and stay `crashed`.
`gc`'s dead-Serve-proxy check uses the same port retries before tearing down an env.

#### Lifetime

TTL default **7 d** for every mode, per-publish `--ttl 12h|30d`. Viewing an env is
touch-on-view: `nectar open`, `nectar resolve` and `nectar show <env>` (and desk render, which
calls `nectar touch` or `resolve` on view) set `expires_at` to now + the env's own TTL, so a
preview under review never runs out. `nectar ls` does not touch. HTTP requests to the
preview URL do not touch yet: `tailscale serve` proxies straight to the upstream port, so
Nectar never sees them (a supervisor-owned proxy is the planned hook). Active review never
gets reaped mid-session: `gc` skips envs touched in the last 6 h. Dev envs keep their
separate 45 min idle-stop process clock (DEV_SERVE §6); touch-on-view moves only the record's
expiry, never the process clock.

### 4.5 `nectard`

One process per machine (per `NECTAR_HOME`, guarded by `~/.nectar/nectard.pid`). It manages
**only Nectar's own envs**: it reads `envs/*.json` and acts only on PIDs, process groups and
`tailscale serve` ports that a record names. It never scans the process table or the serve
table for other work.

- **Which envs.** `mode: web` envs (recipe and static, §6.1.1) whose status is `serving`,
  `unhealthy` or `crashed`, that still hold a `serve` block, are not past `expires_at`, and
  are not marked `failure.code: E_CRASH_LOOP`. `stopped`, `expired`, `cold`, `warm` dev envs,
  desktop and ios envs are left alone.
- **Liveness, every 30 s** (`--interval`). It calls `probeLiveness`. `crashed`
  (`process_exited`) → revive. `unhealthy` → restart (SIGTERM/SIGKILL the recorded process
  group, then revive) after 3 consecutive unhealthy probes. One timer, no overlap: the next
  cycle is scheduled after the previous one finishes.
- **Revive** (under the env lock, only if the record's PID is still the one probed): re-run
  `serve.cmd` in the env's work dir with the recipe's env plus `PORT=<upstream_port>`,
  `NECTAR_ENV`, `NECTAR_ENV_DIR`, detached like publish. Static envs get the static-server
  command re-derived from the running install, so a reinstall or node upgrade that moved the
  recorded absolute paths does not break revival. It waits for HTTP 200 at `ready_path`,
  then re-asserts `tailscale serve --https=<tailnet_port>` so the mesh URL stays the same,
  stamps `serve.started_at`, and sets `serving`. If the upstream port is held by a process
  Nectar did not start, it does not spawn and records `failure.code: E_PORTS`.
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
- **Logs.** Events (start, revive, crash_loop, mesh, gc, error), one JSON line each, go to
  `~/.nectar/logs/nectard.log` (rotated like serve logs) and to stdout in the foreground.
  Quiet cycles write nothing.

Service units (`nectar daemon install`; `uninstall` is the one removal command; `status`):

| | macOS | Linux |
| --- | --- | --- |
| unit | `~/Library/LaunchAgents/com.honeybeehq.nectard.plist` | `~/.config/systemd/user/nectard.service` |
| keeps running | `RunAtLoad`, `KeepAlive` | `Restart=always`, `WantedBy=default.target` |
| serves survive a daemon stop | `AbandonProcessGroup` (serves also have their own session) | `KillMode=process` |
| at boot | at login of the user | needs `loginctl enable-linger <user>` (install warns) |

The unit runs `<node> <nectar>/dist/cli.js daemon run` with the installing shell's `PATH`,
`HOME`, `SHELL`, `LANG` and `NECTAR_HOME`. On macOS, when `tailscale` is not on `PATH`, it
pins `NECTAR_TAILSCALE_BIN` to the app's CLI. `uninstall` stops the daemon and deletes the
unit; envs keep serving and their records stay.

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

## 6. The five modalities

### 6.1 web

The easy, important case: embed a live branch build in the desk's Test tab.

**Publish sequence** (`nectar publish --mode web`):

1. Ensure worktree `~/.nectar/work/<name>` at the branch tip (clone-or-fetch from `--repo`,
   local object sharing via `git worktree` when the repo is local, else a shallow clone).
   Install deps if the lockfile hash changed (`pnpm install --frozen-lockfile` / npm / yarn
   detected from lockfile).
2. Allocate an **upstream port** from the machine's range (default 4100–4199) and spawn the
   recipe's `serve` with `PORT=<p>`, detached, logs to `logs/<name>/serve.log`.
3. Register the **local name** with portless so the same-machine URL follows portless
   grammar: `agent-coupons-stack.acme.localhost`. Nectar runs the serve command itself
   and points portless at the already-allocated port; if portless is absent or its proxy is
   down, the local URL degrades to the healthy loopback origin (`http://127.0.0.1:<p>` or
   `http://[::1]:<p>`) with a warning in the envelope — never a failure (DECISIONS D3, F1).
4. Poll `ready_path` on both IPv4 (`127.0.0.1`) and IPv6 (`::1`) until one returns 200;
   retain the healthy loopback origin. `ready_timeout` fails with `E_SERVE_TIMEOUT` and the
   transactional rollback described in §4.4.
5. Expose to the mesh: allocate a **tailnet port** from 8443–8542 and run
   `tailscale serve --bg --https=<tport> <healthy-loopback-origin>`.
   **The 443 caveat is load-bearing**: port 443 on nectar machines belongs to the portless
   proxy (launchd), so tailscale serve must always bind non-443 — nectar never allocates
   443 and `nectar doctor` flags any existing 443 serve entry as a portless-breaker.
6. Write the env record; emit the envelope.

**URLs.** `urls.mesh` (`https://<host>.tailnet.ts.net:<tport>`) is the primary reference
for other authorized tailnet devices. `urls.local` is the loopback/portless URL for
same-machine consumers. **`preview_url` on the packet remains `urls.mesh`** because packets
are location-independent; consumers choose at resolve time (DECISIONS D4). One tailnet
port per env — no path prefixes (SPAs break), no subdomains (ts.net has no per-machine
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
  `static`. Re-publishing the same name is the usual idempotent upsert: same ports, same
  URL, fresh copy. If the name already belongs to a git-checkout env (or a static env when
  publishing a recipe), publish refuses with `E_USAGE` and leaves that env running:
  `nectar rm <env> --force` first, or pick another `--name`.
- **Serve.** The serve command is Nectar's own static server
  (`exec <node> <nectar>/dist/static-server.js`, cwd = the copy, `PORT` from the
  allocator). It is recorded in `serve.cmd` like any recipe's command, so anything that
  restarts web serves restarts static ones. The server binds `127.0.0.1`, answers GET/HEAD
  only, maps `/dir/` to `dir/index.html` (redirecting `/dir`), refuses symlinks and paths
  outside the copy, never lists directories, and sends `cache-control: no-cache`.
- Everything after step 1 of §6.1 is identical: readiness, tailnet port, `preview_url`,
  quota (static envs count toward `serving_web_limit`), gc, `stop`/`rm`, `expose`. The
  envelope adds `source` (the path that was copied). `--worktree` and `--verify` are
  `E_USAGE`; `--name` on a non-static publish is `E_USAGE`.

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
repo). Everything an agent needs is a flag — no interactive prompts on any command an agent
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

### Commands

```bash
nectar publish [path] [--mode web|desktop|cli|backend|ios|dev|static] [--branch <b>]
               [--ttl 7d] [--worktree <path>] [--packet <hint>] [--name <app>] [--dry-run] [--json]
    # Idempotent upsert per (app, branch, mode): re-publish refreshes checkout, restarts
    # serve, keeps ports and URLs stable. --worktree borrows an existing checkout instead
    # of creating one (agent worktrees; nectar then never deletes it — DECISIONS D2).
    # [path] overrides --repo. Static sites (a directory of HTML or one .html file) are
    # detected or forced with --mode static and publish as web envs (§6.1.1). Python and
    # Rails apps without a recipe publish through the §5 fallbacks (§6.1.2). --dry-run
    # prints the matched recipe source, stack, reason, build and serve; it changes nothing.

nectar ls [--json] [--mode <m>] [--status <s>]
    # This machine's envs: name, mode, status, urls.mesh, expires_at (ISO), expires_in,
    # publisher bee, liveness. Listing does not touch.

nectar show <env|ref> [--json]
    # Full record (incl. liveness) + last 40 log lines when status is crashed or unhealthy.
    # Touches the env (TTL reset).

nectar open <env|ref>
    # web → open urls.local when resolve.is_self, otherwise urls.mesh ·
    # desktop → fetch/verify/launch testpack ·
    # ios → fetch/verify simpack, simctl install+launch (Mac) or open the stream URL ·
    # cli → alias for `nectar shell` · backend → print evidence + shell hint.
    # Always touches the env (TTL reset).

nectar shell <env|ref> [--no-record] [--json]
nectar resolve <ref> [--json]
    # ref → concrete consumables: { mode, is_self, urls, testpack_url, host, status, liveness }.
    # Consumers prefer urls.local when is_self, urls.mesh otherwise. Touches the env.

nectar touch <env|ref> [--ttl <duration>]
    # Re-arms with the env's own TTL; --ttl replaces that TTL from here on. Implicit
    # touches (open/resolve/show) re-arm the env's own TTL, never the 7 d default.
    # Result expires_at is one ISO string, or an env→ISO map when a bare env name
    # matched several modes whose expiries differ. Implicit touches skip expired/cold
    # envs (republish revives them); explicit touch still re-arms them.
nectar stop <env>            # stop serve process, keep everything; status → stopped
nectar rm <env> [--force]    # stop + delete worktree/packs/evidence/record (uses trash);
                             # a *serving*/*unhealthy* env refuses without --force (E_USAGE)
nectar gc [--dry-run] [--json]
    # Enforce §10: expire → stop; cold → delete worktrees; reap old records; prune pack
    # store to quota (LRU). Prints a reap report. Safe to run concurrently (per-env locks).

nectar evidence add <env> <file...>   # copy files into evidence/, print refs
nectar evidence ls <env> [--json]

nectar daemon install | uninstall | status [--json]
nectar daemon run [--interval 30s] [--gc-interval 1h]
    # nectard (§4.5). install writes and starts the launchd agent / systemd --user unit;
    # uninstall is the one removal command (stops it, deletes the unit, envs keep running);
    # run is the foreground supervisor the unit starts.

nectar doctor [--fix]
    # Checks: portless present + proxy up · tailscale up + this host's serve entries ·
    # port-range availability · pack store served on 8440 · no 443 tailscale serve entry
    # (portless killer) · dead Nectar-range Serve proxies · quota headroom. --fix repairs
    # the pack chain and removes dead Nectar-range proxies.
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
    "warnings": ["portless proxy not running — local URL degraded to http://127.0.0.1:4117"]
  }
}
```

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
  **8443–8542** (web envs). Nothing binds public interfaces; funnel is never used.
- Reachability is tailscale ACL policy. **Today's tailnet is not single-user** — it includes
  a shared external node (`shared-node`, user `mbtz@`). Deploy rule (ops task, not code):
  ACL-restrict `8440-8542` on nectar hosts to the operator's own devices. `nectar doctor`
  reminds; it cannot verify ACLs.
- Dev servers are dev servers: debug endpoints, sourcemaps, verbose errors. Acceptable
  inside the ACL boundary above; a nectar-side signed-token layer is the designated
  hardening step if the tailnet ever grows real second users (DECISIONS D9).
- Streamed simulators (§6.5) are **interactive control surfaces** — anyone who can reach
  the port can tap, type, and drive the app under test. Same ACL boundary, but it raises
  the stakes of the ACL rule above from "can read a dev server" to "can operate a device";
  the ios ports live in the same 8443–8542 block that rule already covers.

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

## 10. Resource limits, GC, failure modes

### 10.1 Limits (machine config `~/.nectar/nectar.json`, defaults shown)

| knob | default | on exceed |
| --- | --- | --- |
| serving web envs | 12 | `E_QUOTA` — publish tells the bee to `nectar gc` or pick a victim (`--evict-oldest` flag does it) |
| streamed nectar simulators (ios) | 1 | `E_QUOTA` — serve-sim 0.1.45 cannot run two encoder instances (OQ8); raise when upstream fixes multi-instance |
| tailnet ports | 8443–8542 | `E_PORTS` (only reachable if quota raised past range) |
| upstream ports | 4100–4199 | `E_PORTS` |
| pack store size | 10 GB | LRU prune at `gc`, never mid-publish below 1 pack |
| evidence per env | 500 MB | oldest recordings pruned at `gc` |
| serve log | 10 MB × 2 | rotate |

### 10.2 GC policy

`nectar gc` (idempotent, per-env lockfiles): expire past-TTL envs (stop process group,
remove tailscale-serve entry) → cold at expiry+24 h (delete worktree) → reap records at
cold+14 d → prune pack store/evidence to quota. Grace: envs *touched after publish* within
the last 6 h are never transitioned, so an open review can't be reaped underneath the
reviewer (open/resolve/show/touch all bump `last_touched_at`). The publish stamp itself does not
count as a touch — otherwise `--ttl 1m` would silently mean six hours. A busy env (lock
held by a live publish) is skipped and reported, never an abort of the sweep. Every non-dry
run also removes Nectar-range Serve entries whose loopback proxy target is dead; if an env
record owns the entry, GC kills its process group, clears its runtime claims, and marks it
`crashed` with failure details. `doctor` reports the same orphan class and `doctor --fix`
applies the same cleanup.

### 10.3 Scheduling

`nectard` (§4.5) runs gc at start and hourly. Machines without it can still schedule hourly
`nectar gc --json` externally (a pollinate schedule, cron or a launchd line). `nectar doctor`
warns if `gc` hasn't run in 24 h.

### 10.4 Failure modes (contract, not aspiration)

| # | failure | behavior |
| --- | --- | --- |
| F1 | portless missing / proxy down | web publish **succeeds**; `urls.local` degrades to the healthy IPv4/IPv6 loopback origin; warning in envelope; mesh URL unaffected |
| F2 | tailscale down / logged out | publish succeeds local-only: `urls.mesh: null`, `packet_fields.preview_url` falls back to `urls.local`, loud warning (`E_TAILNET_DOWN` only if `--require-mesh`) |
| F3 | serve crashes post-publish | lazy detection on every read → `status: crashed` (process gone) or `unhealthy` (port silent), back to `serving` when the port answers; `show`/`resolve` return log tail; desk renders "surface down — re-request publish"; re-publish restarts on the same URLs |
| F4 | `ready_path` never 200s | publish fails `E_SERVE_TIMEOUT` with log tail; detached process killed, Serve entry removed, runtime fields/port claims cleared; env kept as `crashed` with `failure` details |
| F5 | port collision or stale Serve proxy | allocator probes IPv4+IPv6 before binding and skips occupied ports; `doctor` reports Serve entries targeting dead loopback ports; `gc` / `doctor --fix` remove them and clear matching env claims |
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
