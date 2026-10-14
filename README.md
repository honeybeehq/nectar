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
re-publish — the URL stays stable, so the packet's references keep working.

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
nectar doctor --fix          # check deps, ports, and serve entries
```

Then, in any repo with a `dev` script (or a `nectar.toml`):

```bash
nectar publish --json
```

A directory of plain HTML (or one `.html` file) needs no recipe. Nectar copies it into
`~/.nectar/work` and serves the copy with its own static server:

```bash
nectar publish ./proto --json
```

## The CLI

`publish` · `ls` · `show` · `open` · `resolve` · `touch` · `stop` · `rm` · `gc` ·
`doctor` · `expose` / `unexpose`.

Everything speaks `--json` with one envelope — `{ ok, command, result | error }`, exit
non-zero iff `ok:false` — so any harness already knows how to read it. Nectar is
per-machine and tailnet-first; every preview is disposable and carries a TTL.

## Status

**Built and tested.** Web / desktop / iOS publish, cross-machine resolve & open, atomic
file state, garbage collection, `doctor`, and public exposure (`expose`/`unexpose` via the
nctr.site relay) are implemented and covered by unit + fixture-backed integration tests.
`cli` and `backend` modes are next.

## Docs

- [docs/SPEC.md](docs/SPEC.md) — the full specification
- [docs/V0.md](docs/V0.md) · [docs/V0.2.md](docs/V0.2.md) — the first slice, and the
  review-experience wave (scenarios, deps, taste, drops, expose)
- [docs/DECISIONS.md](docs/DECISIONS.md) — every contested choice, alternatives, and why
- [docs/FUTURE-nctr-cloud.md](docs/FUTURE-nctr-cloud.md) ·
  [docs/FUTURE-productization.md](docs/FUTURE-productization.md) — hosted & multi-tenant
- [relay/](relay/) — the public-preview relay
