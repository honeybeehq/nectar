# nectar

**Taste it before it becomes honey.**

Nectar is the preview substrate on the mesh. When an agent finishes work and calls it
review-ready, reviewing that work means *testing* it — fast. Nectar is the standalone tool the
agent invokes at that moment: it packages a testable build of the branch and serves it on the
tailnet, then hands back small, stable references. The Forum packet carries only those
references; the review desk's Test tab renders whatever the packet points at.

One command at review-ready:

```bash
$ nectar publish --json
{
  "ok": true,
  "command": "publish",
  "result": {
    "env": "kontiki--coupons-stack--web",
    "mode": "web",
    "urls": {
      "local": "https://coupons-stack.kontiki.localhost",
      "mesh":  "https://trmd-metal-1.tailca9707.ts.net:8444"
    },
    "ref": "nectar://trmd-metal-1/kontiki--coupons-stack--web",
    "expires_at": "2026-07-21T12:04:11Z"
  }
}
```

Four modalities, one grammar:

| kind | what nectar produces | what the packet carries |
| --- | --- | --- |
| **web** | branch dev server, named URL on the mesh (portless grammar) | `preview_url` — embeds in the Test tab |
| **desktop** | a **testpack** — packaged build, one-click openable; Electron also embeds as webview | `testpack_ref` |
| **cli** | provisioned shell, branch build on PATH, session recorded to evidence | `shell_recipe` |
| **backend** | no surface — seeded env + smoke evidence | evidence lines + env ref |

Nectar lives **outside Apiary**. Agents call it; humans call it; the desk shells it. It knows
nothing about packets beyond emitting reference strings shaped to fit them.

## Status

**v0 implemented.** 2026-07-18. Web publish/lifecycle, Darwin desktop testpacks,
cross-machine resolution/open, atomic file state, doctor, and GC are built and covered by
unit plus fixture-backed integration tests. Real same-machine mesh and macOS `:8440` doctor
smokes pass; the two-machine and live review-desk procedures are recorded in
[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

- [docs/SPEC.md](docs/SPEC.md) — the full specification
- [docs/V0.md](docs/V0.md) — the thinnest end-to-end slice, with acceptance criteria
- [docs/DECISIONS.md](docs/DECISIONS.md) — every contested choice, alternatives, and why

Build and link locally:

```bash
pnpm install
pnpm build
pnpm link --global
nectar doctor --fix --json
```

## On the name

"Nectar" is a placeholder — what bees gather and bring back before it is transformed into
honey, i.e. the work in its raw, tasteable state. Alternatives considered:

- **waggle** — the waggle dance is how a returning forager tells the hive *exactly where the
  nectar is*; that is this tool's entire job: a pointer any bee or keeper can follow to the
  testable thing.
- **taster** — drops the metaphor and says what you do with it: `taster open` is the command
  you run before approving anything.
- **forage** — names the act of bringing samples back to the hive; frames `publish` as the
  forager's return.

Verdict: **waggle** is the strongest bee-canon fit (it's about *pointing at* the goods, which
is exactly the reference-passing architecture), but nectar reads better next to hive, comb,
and honey, and the tagline writes itself. Proceeding as **nectar** until someone objects.

## Where the implementation lives

Own repo — this one (`trmd/nectar`), shipped as a global CLI like `hive` and `portless`.
Not a hive or pollinate capability. Reasoning in [docs/SPEC.md §11](docs/SPEC.md) and
[docs/DECISIONS.md D10](docs/DECISIONS.md), short version: nectar must be callable by any
harness (Claude bees, Codex bees, humans, the desk) with its own lifecycle, state, and release
cadence; hive integration is env-var stamping, pollinate integration is a scheduled `nectar gc`.
