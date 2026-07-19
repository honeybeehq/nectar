# Nectar v0 acceptance runbook

This runbook separates checks completed on the current Mac from checks that genuinely need
a publishing machine A and a reviewing Mac B. Never create a Tailscale Serve entry on 443,
and never invoke Tailscale Funnel.

## Install on A and B

```bash
cd /path/to/nectar
pnpm install
pnpm build
pnpm link --global
nectar --version
```

Tailscale SSH must permit B to run `nectar resolve <env> --json` on A. The pack bytes travel
over the read-only `:8440` server; SSH is only the authenticated remote-record lookup.

On each publishing machine, configure the pack chain and hourly GC:

```bash
nectar doctor --fix --json
NECTAR_BIN=$(command -v nectar)
pol create nectar-gc-hourly --source schedule --every 1h \
  --cwd "$HOME" --delivery immediate --max-concurrent 1 \
  --action command --command "$NECTAR_BIN gc --json"
pol trigger nectar-gc-hourly --payload '{"acceptance":true}' --dry-run
pol get nectar-gc-hourly
```

The current machine has an enabled `nectar-gc-hourly` trigger using the checkout's absolute
built-CLI path. Manual job `NE.625` completed with exit code 0; inspect it with
`mise exec node@24.12.0 -- pol job NE.625`.

## A → B: web and branch stability (AC1, AC2)

On A, from a real app branch:

```bash
cd /path/to/web-repo
OUT=$(nectar publish --json)
printf '%s\n' "$OUT" | jq -e '.ok and (.result.packet_fields | keys == ["preview_url","shell_recipe","testpack_ref"])'
URL=$(printf '%s\n' "$OUT" | jq -r '.result.packet_fields.preview_url')
REF=$(printf '%s\n' "$OUT" | jq -r '.result.ref')
printf 'URL=%s\nREF=%s\n' "$URL" "$REF"

nectar publish --json | jq -e --arg url "$URL" '.result.urls.mesh == $url'
git branch nectar-ac-second HEAD
git worktree add /tmp/nectar-ac-second nectar-ac-second
nectar publish --repo /tmp/nectar-ac-second --json
nectar ls --json
```

On B within five seconds of A returning:

```bash
curl -4 --fail --max-time 5 "$URL"
open "$URL"
nectar resolve "$REF" --json
```

Cleanup on A:

```bash
nectar stop "$(printf '%s\n' "$OUT" | jq -r '.result.env')"
nectar rm "$(printf '%s\n' "$OUT" | jq -r '.result.env')" --force
/usr/bin/trash /tmp/nectar-ac-second
```

## A → B: desktop and embed (AC3, AC4)

The Electron repo must produce `$NECTAR_PACK_OUT/testpack.json` plus `app/<entry>` and use
`embed_url = "web"` in `nectar.toml`.

On A:

```bash
cd /path/to/electron-repo
OUT=$(nectar publish --mode desktop --json)
REF=$(printf '%s\n' "$OUT" | jq -r '.result.packet_fields.testpack_ref')
URL=$(printf '%s\n' "$OUT" | jq -r '.result.packet_fields.preview_url')
SHA=$(printf '%s\n' "$OUT" | jq -r '.result.sha256')
printf '%s\n' "$OUT" | jq -e '.result.web_env and .result.packet_fields.testpack_ref and .result.packet_fields.preview_url'
printf 'REF=%s\nURL=%s\nSHA=%s\n' "$REF" "$URL" "$SHA"
```

On B:

```bash
nectar resolve "$REF" --json | jq -e --arg sha "$SHA" '.result.sha256 == $sha'
nectar open "$REF" --json
nectar open "$REF" --json | jq -e '.result.cache_hit == true'
open "$URL"
```

F8 retry on B (the source pack on A remains intact):

```bash
SHA=$(nectar resolve "$REF" --json | jq -r '.result.sha256')
printf 'corrupt-cache\n' > "$HOME/.nectar/packs/.cache/$SHA.testpack.zip"
nectar open "$REF" --json | jq -e '.ok and (.result.cache_hit == false)'
```

## Failure envelopes and lifecycle (AC5–AC7)

The automated suite exercises F1, F2, F4, and F8 without changing host mesh state:

```bash
pnpm vitest run test/integration.test.ts
```

On a dedicated A, F2 can additionally be checked with Tailscale offline; do not do this on a
machine carrying unrelated active work:

```bash
tailscale down
nectar publish --json | jq -e '.ok and (.result.urls.mesh == null) and (.result.packet_fields.preview_url | startswith("http://127.0.0.1:"))'
tailscale up
```

For F4, temporarily set `[web].serve` to a process that never listens and
`ready_timeout = "250ms"`; then:

```bash
nectar publish --json | jq -e '(.ok == false) and (.error.code == "E_SERVE_TIMEOUT") and (.error.log_tail | type == "array")'
```

Lifecycle on A:

```bash
OUT=$(nectar publish --ttl 1m --json)
ENV=$(printf '%s\n' "$OUT" | jq -r '.result.env')
URL=$(printf '%s\n' "$OUT" | jq -r '.result.urls.mesh')
sleep 120
nectar gc --json
nectar show "$ENV" --json | jq -e '.result.env.status == "expired"'
nectar publish --json | jq -e --arg url "$URL" '.result.urls.mesh == $url'
nectar touch "$ENV" --json
nectar gc --json
```

Crash honesty on A:

```bash
PID=$(nectar show "$ENV" --json | jq -r '.result.env.serve.pid')
kill -9 "$PID"
nectar ls --json | jq -e --arg env "$ENV" '.result.envs[] | select(.name == $env and .status == "crashed")'
nectar show "$ENV" --json | jq -e '.result.log_tail | type == "array"'
nectar publish --json | jq -e --arg url "$URL" '.result.urls.mesh == $url'
```

## Bee-only invocation (AC8)

After globally linking Nectar on A:

```bash
hive run codex --cwd /path/to/web-repo --wait --last \
  -p 'Publish this branch with nectar. Use --json only, verify ok=true, and return exactly result.packet_fields plus result.ref. Do not invent a URL.'
```

The run passes only if the bee returns the emitted snake_case fields without a human command
correction.

## Doctor and exposure (AC9, AC10)

On a fresh A:

```bash
nectar doctor --json | jq -e '.result.checks[] | select(.name == "pack-store-8440" and .status == "fail")'
nectar doctor --fix --json | jq -e '.result.checks[] | select(.name == "pack-store-8440" and .status == "pass")'
nectar doctor --fix --json
PID=$(jq -r '.pack_server_pid' "$HOME/.nectar/nectar.json")
/usr/sbin/lsof -nP -a -p "$PID" -iTCP -sTCP:LISTEN
tailscale serve status --json
```

The `lsof` line must be exactly a `127.0.0.1:<pack-port>` listener. Doctor reports Funnel
off by inspecting Serve JSON; neither Nectar nor this runbook invokes the Funnel command.
The 443 conflict is tested with a fake Serve-status fixture because the machine guardrail
forbids planting a real 443 entry:

```bash
pnpm vitest run test/integration.test.ts -t 'doctor fixes only 8440'
rg -n 'funnel|--https=443' src test
```

After a disposable doctor smoke only (production publishing machines keep this chain):

```bash
tailscale serve --https=8440 off
kill -TERM "-$PID"
tailscale serve status --json
```

## Review-desk taste

On A, copy only `result.packet_fields.preview_url`, `testpack_ref`, or `shell_recipe` from
the envelope into the Forum packet. On the desk machine B:

```bash
forum packet show "$PACKET_ID" --json
nectar resolve "$(forum packet show "$PACKET_ID" --json | jq -r '.result.packet.testpack_ref')" --json
```

Open the packet's Test tab and verify the iframe URL or Testpack action. This final wiring
requires the second machine and a live desk packet.

## Status from this checkout

| criterion | status | evidence |
| --- | --- | --- |
| AC1 | pass | 2026-07-19: real publish of `landoy--main--web` (Next.js + migrated review DB, recipe committed in-repo); Tormod verified the mesh URL rendering from multiple tailnet devices. `nectar resolve` *on* a B machine remains unexercised (nectar not yet linked on a second machine) |
| AC2 | pass-simulated | real republish stability plus two-branch fake-mesh integration |
| AC3 | needs-second-machine | pack/verify/cache/launch adapter passed; real B + signed Electron app remains |
| AC4 | needs-second-machine | two-record embed integration passed; remote browser remains |
| AC5 | pass-simulated | F1/F2/F4/F8 integration coverage and exact envelopes |
| AC6 | pass-simulated | expiry/revive/touch/cold transitions with controlled fixture time |
| AC7 | pass | real detached serve kill, lazy crash detection, same-URL recovery |
| AC8 | pass | Hive bee `CO.543` published from the disposable repo and returned emitted fields/ref without correction |
| AC9 | pass | real macOS doctor repair + idempotence; 443 fixture simulation |
| AC10 | pass | real `lsof` loopback-only bind and empty Serve status after cleanup |

The final real Forum/Apiary desk taste remains `needs-second-machine`.

## ios mode + AX channel (2026-07-19)

Implemented post-v0 (SPEC §6.5, D14) and live-smoked on macbook-pro-1:

- **ios publish, real chain**: `/tmp/nectar-dummy-ios` (the swiftc dummy fixture as a repo
  with `[ios]` recipe) → `nectar publish --mode ios --json` exited 0 with zero warnings:
  simpack built and digested, dedicated device `nectar-nectar-dummy--main--ios` created on
  iOS 26.5, app installed + launched, serve-sim 0.1.45 streamed on the tailnet
  (`preview_url` :8444), `ax_url` = stream + `/ax` returned live SSE snapshots of the
  running app. `packet_fields` carried both `preview_url` and `testpack_ref`.
- **serve-sim multi-instance refuted**: launching the nectar stream killed a concurrently
  running manual serve-sim instance (`error encoding frame: encodingFailed`). Consequence
  shipped: `serving_sim_limit` defaults to 1; a second streamed ios publish fails
  `E_QUOTA` loudly instead of silently breaking the first packet's stream.
- **desktop AX bridge, real chain**: `nectar open nectar://macbook-pro-1/flyt--main--desktop`
  launched the cached testpack, compiled `ax-dump` via swiftc, and returned
  `ax_url`/`ax_pid`; `/health` reported trusted, `/ax` streamed Flyt's real macOS
  accessibility tree (Electron `AXManualAccessibility` handshake) in the serve-sim schema.
- **Automated coverage**: `test/ios.test.ts` (fake simctl + fake serve-sim: full stream
  publish, F12 degrade, scratch-sim open, desktop AX plumb), `test/sim.test.ts` (runtime/
  devicetype selection, pinned serve-sim command), `test/ax-bridge.test.ts` (SSE relay,
  trust-error surfacing). Suite: 36/36.

Remaining manual checks: an ios open on a second Mac (scratch-sim path over the mesh), and
an AX-anchored feedback round-trip once the desk's composer overlay exists (Apiary side).
