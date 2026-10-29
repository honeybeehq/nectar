# Bind-first port allocation evidence

Base: 9cf51064c711abdc0b39cd23e6222a2cc141daaf. Branch: review/pws-t23-bindfirst.

The selection path now attempts TCP listen/close, without a TCP connection. It checks the wildcard of each assigned address family and every assigned address (including loopbacks and scoped IPv6). Probes run sequentially so they cannot collide with one another. All attempted bind/listen errors, including EADDRINUSE and EACCES, mean unavailable. Absent families are skipped by the orchestrator's explicit decision; an empty address list refuses allocation. The WHATWG blocked ports, reserved service ports, caller reservations, preference ordering, and E_PORTS text are unchanged. No new code comments were added.

## Semantics relied on

- [Node 24 net implementation](https://github.com/nodejs/node/blob/v24.18.0/lib/net.js): getFlags sets UV_TCP_REUSEPORT only for reusePort:true; exclusive selects a private handle rather than cluster sharing. exclusive does not disable SO_REUSEADDR. IPv6-only flags keep IPv4 and IPv6 checks separate.
- [libuv 1.52.1 TCP implementation](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/tcp.c): uv__tcp_bind sets SO_REUSEADDR; SO_REUSEPORT requires the explicit UV_TCP_REUSEPORT flag, which the probe never supplies. Listen completion matters because an address conflict can be deferred until listen.
- [libuv TCP documentation](https://docs.libuv.org/en/v1.x/tcp.html): all duplicate bindings must opt into reuseport; macOS is not a supported platform for UV_TCP_REUSEPORT. The Darwin-only test explicitly checks Node ENOTSUP; native SO_REUSEPORT validation is pending separately.
- [Linux inet_bind_conflict](https://github.com/torvalds/linux/blob/v6.18/net/ipv4/inet_connection_sock.c): the reuseaddr relaxation excludes a listening existing socket; the reuseport relaxation requires both sockets to opt in. Our probe does not opt in. Linux listener matrix ran successfully, including SO_REUSEPORT, wildcard/specific IPv4 and IPv6, dual stack and assigned interfaces.
- [XNU IPv4 binding](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/netinet/in_pcb.c), in_pcbbind and in_pcblookup_local: SO_REUSEADDR causes exact-address lookup; a bind to loopback can miss an existing wildcard. Exact-address conflict is rejected when the new socket has no overlapping SO_REUSEPORT permission. This is why both wildcard and assigned-address checks are necessary.
- [XNU IPv6 binding](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/netinet6/in6_pcb.c), in6_pcbbind and in6_pcblookup_local: analogous exact lookup and reuseport intersection; scope identifiers participate in local IPv6 lookup. Assigned link-local addresses retain their zone for a valid bind.

The XNU conclusion is a source-based inference until the orchestrator supplies the real macOS run. Proof submission is held for that result.

## Availability caller inventory

All of these use the revised helper, directly or through allocatePort:

- service.ts:1642 Docker dependency allocation; :1723 local Postgres cluster allocation; :1861 upstream and :1870 tailnet allocation; :2692 stale upstream recovery; :2780 proxy assignment; :3275 AX bridge allocation; :3851 pack port reuse and :3853 replacement allocation; :4585 whole-range capacity check.
- shared-static.ts:71 prior listener port reuse; :97 tailnet allocation.
- pg-local.ts:264 stopped cluster port reuse.

## Connection probes deliberately retained

- service.ts:1355-1356 checks the upstream explicitly registered in an existing Tailscale Serve entry (localhost via portAnswers; specific host via portOpenOnHost). It classifies an existing route, not an allocation candidate.
- service.ts:1360 checks the recorded application's own upstream when its registered proxy does not answer.
- service.ts:3286 and :3289 wait for the AX bridge child just spawned by Nectar.
- service.ts:3844 checks pack_server_port only with recorded pack PID and process group and a live PID.
- service.ts:3865 and :3868 wait for the pack-server child just spawned by Nectar.
- liveness.ts:37 (through portAnswers and probeLiveness) checks a recorded runtime's upstream, including lifecycle checks after exit.
- ports.ts portOpen and portOpenOnHost remain solely for these registered or owned runtime checks; the connect-based availability block was deleted.
- test/proxy.test.ts:35 waits for its own fixture child; :179 checks its own removed proxy; :236 checks its existing proxy; :254 checks its proxy after shutdown.
- test/daemon.test.ts:225 waits for the test's own deliberately foreign fixture process.
- verify-demand.mjs:60 checks its stopped child upstreams; :66 checks its own restored proxies. verify-combined.mjs:51 checks stopped fixture apps. verify-lru.mjs:52 checks its own not-yet-booted app. These are lifecycle assertions, not availability tests.
- Shared-static HTTP health requests are retained: they target its recorded PID, port and secret, not allocation candidates.

## Linux verification

All tests and dynamic fixtures ran inside private network namespaces. Each namespace brings up lo. State/config and fixture repositories are disposable; installed Nectar daemons were not used. No sudo, unrelated process environments, unrelated previews, SSH to Macs, merge or force push was used.

- final-checks.log: typecheck, lint, build and ordinary allocator suite.
- allocator-final.log: namespace with its own dummy interface, assigned 192.0.2.1 and scoped IPv6; wildcard/specific v4/v6, dual stack and Linux reuseport cases. Each matrix listener uses port0 and tests only its exact allocated port. net.createConnection is mocked to throw; connection callbacks remain untouched.
- ipv6-disabled-final.log: namespace-only disable_ipv6=1 and full allocator suite; IPv4-only allocation is also tested independently with a constrained interface inventory.
- checks.log / baseline-checks.log: original concurrent full suite comparison (30 failures vs28). The two extra failures were pg-local restart and remote republish old body.
- targeted.log / baseline-targeted.log: allocator/proxy/daemon/pool comparison, identical18 failures (17 pre-existing pool timeouts, known daemon GC expiry). Allocator and proxy pass. These initial runs preceded the address-family follow-up.
- delta.log / baseline-delta.log: isolated delta tests all pass on both.
- delta-files.log / baseline-delta-files.log: complete pg-local and remote files run serially, identical69 passes and1 existing remote startup timeout. The concurrent suite shares fixed ranges: pg-local/daemon4900-4949 and remote/expose4700-4799; the serial result supports interference, not an allocator regression.
- demand-final.log / baseline-demand-isolated.log: dynamic fixture publishes16 sleeping apps, wakes them, checks idle release, restarts the daemon, recovers from503 to200, serves concurrent requests in one process, and republishes under traffic with all200. Both reach the known final0-vs16 Tailscale route assertion because Tailscale is disabled. The latest final fixture run includes the assigned-family follow-up.

For reliable fixture isolation BOTH NECTAR_TAILSCALE_SOCKET=/nonexistent/t23.sock and NECTAR_TAILSCALE_BIN=/bin/false are required. Earlier trial runs with only the socket blocked fell back to the host CLI, produced mesh URLs and failed DNS before waking; those are not counted as verification evidence.

## Attention

Reviewed by claude-opus-5-5. The review found the IPv6-disabled bug, now corrected by probing only assigned families. Mac native SO_REUSEPORT execution remains pending. A transient assigned address that disappears or cannot bind will conservatively reject candidates; this follows the accepted strict-error rule. Pool integration coverage is limited by matching baseline timeouts. Empty interface inventories now fail closed.

## Paused handoff, 2026-10-29

Paused at Tormod's request. Implementation tip before this notes commit: 4d154b3df43be3217d088de7108e279ad246bff3, pushed unforced over SSH to review/pws-t23-bindfirst. No proof was submitted. Mac validation remains pending with the orchestrator. Final Linux allocator counts: ordinary namespace13 passed/1 Darwin skip; dummy assigned IPv4 plus scoped IPv6 namespace15 passed/1 skip; IPv6-disabled namespace8 passed/1 skip. Typecheck, lint and build pass. Detailed logs, source research snapshots, baseline extraction and proof draft remain local in this retained Cell; they are evidence artifacts rather than deliverable code.

Security restriction remains in force on every node: no web browsing or fetching, no third-party repos/packages beyond pinned dependencies, no unverified-sender inputs until T11 is live on a sandbox-ON node. Do not touch the systemd user manager/socket or run systemctl --user.
