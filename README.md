# nectar

**Taste it before it becomes honey.**

Reviewing an agent's work means *testing* it — and testing should cost seconds, not
minutes. Nectar is the tool you run the moment work is review-ready: it turns a branch
into a **tasteable preview** on your mesh and hands back a small, stable reference.
Agents call it, humans call it, the review desk renders whatever the reference points at.

## One command

```bash
$ nectar publish --json
{
  "ok": true,
  "command": "publish",
  "result": {
    "env": "acme--coupons-stack--web",
    "mode": "web",
    "urls":          { "mesh": "https://builder-1.tailnet.ts.net:8444" },
    "packet_fields": { "preview_url": "https://builder-1.tailnet.ts.net:8444" },
    "ref": "nectar://builder-1/acme--coupons-stack--web",
    "expires_at": "2026-07-23T12:04:11Z"
  }
}
```

Put `packet_fields` on the review packet, flip to review-ready, done. Fix feedback and
re-publish — the URL stays stable, so the packet's references keep working. A republish
that fails to check out, install or build leaves the previous version serving. Publishing
a different repo whose app name and branch collide with a live env is refused with
`E_USAGE`; pass `--name <app>` to publish it beside the other one.

## Five modalities, one grammar

| kind | what nectar serves | the reference it hands back |
| --- | --- | --- |
| **web** | the branch dev server, named on the mesh | `preview_url` — embeds in the review desk |
| **desktop** | a signed, sha256-verified **testpack**, one-click openable | `testpack_ref` |
| **ios** | a streamed simulator you can drive, plus a simpack | `preview_url` + `testpack_ref` |
| **cli** | a provisioned shell, session recorded to evidence | `shell_recipe` |
| **backend** | a seeded environment + smoke evidence | evidence + env ref |

## Take a preview public

Previews are tailnet-private by default. To share one on the internet, route it through a
relay (e.g. `nctr.site`):

```bash
$ nectar expose acme--coupons-stack--web --to site
  → https://acme-coupons-stack-e7f3.nctr.site   # password-gated, torn down on expiry
```

Gated by default; add `--public` for an ungated link with an unguessable URL.
See [relay/](relay/) to run your own `<domain>.site` relay.

## Quick start

```bash
pnpm install && pnpm build && pnpm link --global
nectar doctor                # check nectard, gc, dead envs, serve entries, PATH tools, the pack store
nectar doctor --fix --dry-run  # list the repairs it would make
nectar doctor --fix          # run gc, remove orphaned Nectar serve entries, install nectard, restart the pack store
nectar doctor --fix --no-daemon --save  # the same cleanup, but never install nectard on this machine
nectar daemon install        # optional: nectard revives crashed previews, restores them after reboot, runs gc hourly
```

Nectar finds the `tailscale` CLI on `PATH`, inside the Mac app
(`/Applications/Tailscale.app/Contents/MacOS/Tailscale`) or in the Homebrew and standalone
locations. Set `NECTAR_TAILSCALE_BIN` to choose one; `nectar doctor` shows which it used.

`doctor --fix` only removes what it can prove is Nectar's: a `tailscale serve` entry goes only
when it is in Nectar's tailnet range, points at a Nectar upstream port and nothing answers
there. Entries pointing elsewhere, and Portless, are reported and left alone (SPEC §10.5).
`nectar daemon uninstall` stops and removes nectard again (envs keep running);
`nectar daemon status` shows whether it is installed and running. On Linux it is a
`systemd --user` unit: run `loginctl enable-linger $USER` once so it starts at boot without
a login. On macOS it is a launchd agent in `~/Library/LaunchAgents`. Idle, it is one Node
process of ~60–90 MB RSS (systemd's cgroup accounting shows ~27 MB). Its log is
`~/.nectar/logs/nectard.log`; it records every failed tailscale call as a `tailscale` line,
and every call when `NECTAR_DEBUG=1`. While it runs, nectard also sits between `tailscale serve`
and each web preview (a small proxy on one extra loopback port per env), so a person
opening the mesh URL in a browser extends the preview's lifetime the same way `nectar open`
does. Uninstalling it points the mesh URLs straight back at the apps.

Agents in Honeybee Cells can't write `~/.nectar`, so with nectard running the CLI hands
`publish`, `ls`, `show`, `resolve`, `touch`, `stop` and `rm` to it over a Unix socket at
`~/.config/nectar/nectard.sock` (owner-only). The CLI uses nectard whenever it answers for
the same `NECTAR_HOME`, and acts on `NECTAR_HOME` itself otherwise. `--direct` forces the
local path. If the home is read-only and nectard isn't running, `ls`, `show` and
`resolve` still answer read-only (`touched: false`), and the rest fail with `E_DAEMON`
and the hint `nectar daemon install`, which the user runs outside any Cell.
nectard copies or checks out the Cell's source into its own work dir, so the preview
outlives the Cell.

Then, in any repo with a `dev` script (or a `nectar.toml`):

```bash
nectar publish --json
```

A directory of plain HTML (or one `.html` file) needs no recipe. Nectar copies it into
`~/.nectar/work` and serves the copy with its own static server:

```bash
nectar publish ./proto --json
```

Python (Django, FastAPI/Starlette, Flask) and Rails apps also need no recipe. Nectar
installs their dependencies into a venv or bundle inside the env's work dir and serves them
on the allocated port. To see what it would run:

```bash
nectar publish --dry-run     # recipe source, stack, reason, build and serve commands
```

Order: `nectar.toml` > `package.json` dev script > Python > Rails > static HTML
(SPEC §5, §6.1.2).

An app that needs a database declares it, and each preview gets its own (SPEC §5.1):

```toml
[deps.db]
kind = "postgres:16"   # its own container, volume and loopback port per env; DATABASE_URL + PG* injected

[scenarios.review]
seed = "pnpm db:seed"  # runs when the database is created, and again on publish --fresh
```

Republishing keeps the data, `nectar publish --fresh` starts from an empty database, and
`nectar rm` removes the container and its volume. This needs Docker with Compose that the
user can reach (docker group or rootless Docker); without it the publish fails `E_PLATFORM`.
Nectar only ever touches containers, volumes and networks labelled `dev.nectar.env`.
`kind = "sqlite"` with `path = "data/app.db"` gives each env its own copy of the file
instead.

## The CLI

`publish` · `ls` · `show` · `open` · `resolve` · `touch` · `stop` · `rm` · `gc` ·
`doctor` · `expose` / `unexpose` · `daemon install` / `uninstall` / `status` / `run`.

Everything speaks `--json` with one envelope — `{ ok, command, result | error }`, exit
non-zero iff `ok:false` — so any harness already knows how to read it. Nectar is
per-machine and tailnet-first; every preview is disposable and carries a TTL.

## Status

**Built and tested.** Web / desktop / iOS publish, cross-machine resolve & open, atomic
file state, garbage collection, `doctor`, and public exposure (`expose`/`unexpose` via the
nctr.site relay) and per-env Postgres/SQLite `[deps]` are implemented and covered by unit +
fixture-backed integration tests.
`cli` and `backend` modes are next.

## Docs

- [docs/SPEC.md](docs/SPEC.md) — the full specification
- [docs/V0.md](docs/V0.md) · [docs/V0.2.md](docs/V0.2.md) — the first slice, and the
  review-experience wave (scenarios, deps, taste, drops, expose)
- [docs/DECISIONS.md](docs/DECISIONS.md) — every contested choice, alternatives, and why
- [docs/FUTURE-nctr-cloud.md](docs/FUTURE-nctr-cloud.md) ·
  [docs/FUTURE-productization.md](docs/FUTURE-productization.md) — hosted & multi-tenant
- [relay/](relay/) — the public-preview relay
