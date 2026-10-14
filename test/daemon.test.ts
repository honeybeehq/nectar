import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pidAlive, spawnDetached, stopProcessGroup } from "../src/commands.js";
import { claimPidFile, Supervisor, supervised } from "../src/daemon.js";
import { installUnit, launchdPlist, systemdUnit, uninstallUnit, unitPath, unitStatus } from "../src/daemon-unit.js";
import { getPaths } from "../src/paths.js";
import { NectarService, type ReviveResult } from "../src/service.js";
import type { EnvRecord, Liveness, ServeRecord } from "../src/types.js";
import { fakeExecutable, fakeTailscale, initGitRepo, record, tempDir } from "./helpers.js";

const FUTURE = "2099-01-01T00:00:00.000Z";
const BOOT = Date.parse("2026-10-01T00:00:00.000Z");

function liveness(state: Liveness["state"]): Liveness {
  const reason = state === "serving" ? "port_open" : state === "unhealthy" ? "port_unresponsive" : "process_exited";
  return { state, reason, checked_at: new Date().toISOString(), pid_alive: state !== "crashed", port_open: state === "serving" };
}

function webRecord(overrides: Partial<EnvRecord> = {}): EnvRecord {
  return record({
    published_at: "2026-10-10T00:00:00.000Z",
    expires_at: FUTURE,
    serve: { cmd: "node server.mjs", pid: 4242, pgid: 4242, upstream_port: 4100, tailnet_port: 8443 },
    ...overrides,
  });
}

function fakeService(records: EnvRecord[]): {
  service: NectarService;
  revive: ReturnType<typeof vi.fn>;
  markCrashLoop: ReturnType<typeof vi.fn>;
  reassertMesh: ReturnType<typeof vi.fn>;
  gc: ReturnType<typeof vi.fn>;
} {
  const revive = vi.fn((): Promise<ReviveResult> => Promise.resolve({ revived: true, reason: "spawned", pid: 5000, mesh: true }));
  const markCrashLoop = vi.fn(() => Promise.resolve(true));
  const reassertMesh = vi.fn(() => Promise.resolve(true));
  const gc = vi.fn(() => Promise.resolve({ transitions: [], serve_orphans: [], skipped: [] }));
  const service = {
    store: { listEnvs: () => Promise.resolve(records) },
    revive,
    markCrashLoop,
    reassertMesh,
    gc,
  } as unknown as NectarService;
  return { service, revive, markCrashLoop, reassertMesh, gc };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("supervisor decisions", () => {
  it("supervises only live, unexpired web envs that are not given up", () => {
    const now = Date.parse("2026-10-14T00:00:00.000Z");
    expect(supervised(webRecord(), now)).toBe(true);
    expect(supervised(webRecord({ status: "crashed" }), now)).toBe(true);
    expect(supervised(webRecord({ mode: "dev" }), now)).toBe(false);
    expect(supervised(webRecord({ status: "stopped" }), now)).toBe(false);
    expect(supervised(webRecord({ status: "expired" }), now)).toBe(false);
    expect(supervised(webRecord({ expires_at: "2026-10-13T00:00:00.000Z" }), now)).toBe(false);
    const withoutServe = webRecord({ status: "crashed" });
    delete withoutServe.serve;
    expect(supervised(withoutServe, now)).toBe(false);
    expect(
      supervised(webRecord({ status: "crashed", failure: { code: "E_CRASH_LOOP", message: "", failed_at: "", log_tail: [] } }), now),
    ).toBe(false);
  });

  it("revives an env whose process exited and leaves serving ones alone", async () => {
    const dead = webRecord({ name: "dead--main--web" });
    const alive = webRecord({ name: "alive--main--web", serve: { cmd: "x", pid: 7, pgid: 7, upstream_port: 4101 } });
    const fake = fakeService([dead, alive]);
    const probe = vi.fn((serve: ServeRecord) => Promise.resolve(liveness(serve.pid === 7 ? "serving" : "crashed")));
    const supervisor = new Supervisor(fake.service, { bootTimeMs: BOOT, probe });
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledTimes(1);
    expect(fake.revive).toHaveBeenCalledWith("dead--main--web", { expectPid: 4242, kill: false });
    expect(fake.reassertMesh).not.toHaveBeenCalled();
  });

  it("backs off between revives and gives up after the crash-loop cap", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T00:00:00.000Z") });
    const fake = fakeService([webRecord()]);
    const supervisor = new Supervisor(fake.service, {
      bootTimeMs: BOOT,
      probe: () => Promise.resolve(liveness("crashed")),
      backoffBaseMs: 20_000,
      maxRevives: 3,
      reviveWindowMs: 10 * 60_000,
    });
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(120_000);
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledTimes(3);
    expect(fake.markCrashLoop).toHaveBeenCalledWith("demo--main--web", 4242, expect.stringContaining("Revived 3 times"));
  });

  it("forgets old revives, so a rare crash is always revived", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T00:00:00.000Z") });
    const fake = fakeService([webRecord()]);
    const supervisor = new Supervisor(fake.service, { bootTimeMs: BOOT, probe: () => Promise.resolve(liveness("crashed")), maxRevives: 1 });
    await supervisor.sweep(false);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledTimes(2);
    expect(fake.markCrashLoop).not.toHaveBeenCalled();
  });

  it("does not count a revive that lost a race with a publish", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T00:00:00.000Z") });
    const fake = fakeService([webRecord()]);
    fake.revive.mockResolvedValue({ revived: false, reason: "E_BUSY" });
    const supervisor = new Supervisor(fake.service, { bootTimeMs: BOOT, probe: () => Promise.resolve(liveness("crashed")), maxRevives: 1 });
    await supervisor.sweep(false);
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledTimes(2);
    expect(fake.markCrashLoop).not.toHaveBeenCalled();
  });

  it("restarts an unhealthy env only after N consecutive unhealthy probes", async () => {
    const fake = fakeService([webRecord()]);
    const states: Array<Liveness["state"]> = ["unhealthy", "unhealthy", "serving", "unhealthy", "unhealthy", "unhealthy"];
    const supervisor = new Supervisor(fake.service, {
      bootTimeMs: BOOT,
      unhealthyRestartAfter: 3,
      probe: () => Promise.resolve(liveness(states.shift() ?? "serving")),
    });
    for (let index = 0; index < 5; index += 1) await supervisor.sweep(false);
    expect(fake.revive).not.toHaveBeenCalled();
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledWith("demo--main--web", { expectPid: 4242, kill: true });
  });

  it("on start restores envs from before the boot without killing their stale pids and re-asserts live mesh entries", async () => {
    const stale = webRecord({ name: "stale--main--web", published_at: "2026-09-20T00:00:00.000Z" });
    const restarted = webRecord({ name: "fresh--main--web", serve: { cmd: "x", pid: 9, pgid: 9, upstream_port: 4102, tailnet_port: 8444, started_at: "2026-09-20T00:00:00.000Z" } });
    const live = webRecord({ name: "live--main--web", serve: { cmd: "x", pid: 8, pgid: 8, upstream_port: 4103, tailnet_port: 8445 } });
    const fake = fakeService([stale, restarted, live]);
    const probe = vi.fn(() => Promise.resolve(liveness("serving")));
    const supervisor = new Supervisor(fake.service, { bootTimeMs: BOOT, probe });
    await supervisor.sweep(true);
    expect(fake.revive.mock.calls).toEqual(
      expect.arrayContaining([
        ["stale--main--web", { expectPid: 4242, kill: false }],
        ["fresh--main--web", { expectPid: 9, kill: false }],
      ]),
    );
    expect(fake.revive).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(fake.reassertMesh).toHaveBeenCalledWith("live--main--web");
  });

  it("retries mesh re-assertion while tailscale is not up yet", async () => {
    const fake = fakeService([webRecord()]);
    fake.reassertMesh.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const supervisor = new Supervisor(fake.service, { bootTimeMs: BOOT, probe: () => Promise.resolve(liveness("serving")) });
    await supervisor.sweep(true);
    await supervisor.sweep(false);
    await supervisor.sweep(false);
    expect(fake.reassertMesh).toHaveBeenCalledTimes(2);
  });

  it("schedules liveness every interval and gc hourly, without overlapping cycles", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T00:00:00.000Z") });
    const fake = fakeService([webRecord()]);
    const probe = vi.fn(() => Promise.resolve(liveness("serving")));
    const supervisor = new Supervisor(fake.service, { bootTimeMs: BOOT, probe, intervalMs: 30_000, gcIntervalMs: 60 * 60_000 });
    await supervisor.start();
    expect(fake.gc).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(fake.gc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 30_000);
    expect(probe).toHaveBeenCalledTimes(121);
    expect(fake.gc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fake.gc).toHaveBeenCalledTimes(3);
    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fake.gc).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const fixtureServer = `
import http from "node:http";
http.createServer((_q, r) => { r.writeHead(200); r.end("ok"); }).listen(Number(process.env.PORT), "127.0.0.1");
`;

async function liveHarness(): Promise<{ service: NectarService; tailscaleLog: string; repo: string }> {
  const state = await tempDir("daemon-state");
  const fakeDir = await tempDir("daemon-bin");
  const tailscale = await fakeTailscale(fakeDir);
  const trash = await fakeExecutable(fakeDir, "trash", `for target in "$@"; do mv "$target" "$target.trash.$$"; done`);
  await writeFile(
    path.join(state, "nectar.json"),
    JSON.stringify({ upstream_port_start: 4900, upstream_port_end: 4949, pack_server_port: 4899, tailnet_port_start: 8900, tailnet_port_end: 8949 }),
  );
  vi.stubEnv("NECTAR_HOME", state);
  vi.stubEnv("NECTAR_TAILSCALE_BIN", tailscale.binary);
  vi.stubEnv("FAKE_TS_LOG", tailscale.log);
  vi.stubEnv("NECTAR_TRASH_BIN", trash);
  const repo = await initGitRepo({
    "nectar.toml": `name = "daemon-fixture"\n\n[web]\nserve = "node server.mjs"\nready_path = "/"\nready_timeout = "10s"\n`,
    "server.mjs": fixtureServer,
  });
  return { service: new NectarService(state), tailscaleLog: tailscale.log, repo };
}

describe("supervisor against the real service", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  });

  it("revives a killed serve on the same port and re-asserts its tailscale mapping", async () => {
    const { service, tailscaleLog, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "1h" })) as { env: string };
    cleanups.push(async () => void (await service.stop(published.env)));
    const before = await service.store.readEnv(published.env);
    await stopProcessGroup(before.serve?.pgid ?? 0);
    const supervisor = new Supervisor(service);
    await supervisor.sweep(false);
    const after = await service.store.readEnv(published.env);
    expect(after.status).toBe("serving");
    expect(after.serve?.upstream_port).toBe(before.serve?.upstream_port);
    expect(after.serve?.tailnet_port).toBe(before.serve?.tailnet_port);
    expect(after.serve?.pid).not.toBe(before.serve?.pid);
    expect(after.urls.mesh).toBe(before.urls.mesh);
    expect(pidAlive(after.serve?.pid ?? 0)).toBe(true);
    const listed = (await service.list()) as { envs: Array<{ status: string }> };
    expect(listed.envs[0]?.status).toBe("serving");
    const calls = (await readFile(tailscaleLog, "utf8")).split("\n").filter((line) => line.includes(`--https=${before.serve?.tailnet_port} http`));
    expect(calls).toHaveLength(2);
  });

  it("revives a static env with a server command re-derived from this install, not the stale recorded path", async () => {
    const { service } = await liveHarness();
    vi.stubEnv("NECTAR_STATIC_SERVER_ENTRY", fileURLToPath(new URL("../src/static-server.ts", import.meta.url)));
    const site = path.join(await tempDir("daemon-static"), "proto");
    await mkdir(site, { recursive: true });
    await writeFile(path.join(site, "index.html"), "<h1>proto</h1>");
    const published = (await service.publish({ repo: site, ttl: "1h" })) as { env: string };
    cleanups.push(async () => void (await service.stop(published.env)));
    await service.store.updateEnv(published.env, (current) => {
      if (current.serve !== undefined) current.serve.cmd = "exec '/gone/node' '/gone/nectar/dist/static-server.js'";
    });
    const before = await service.store.readEnv(published.env);
    await stopProcessGroup(before.serve?.pgid ?? 0);
    await new Supervisor(service).sweep(false);
    const after = await service.store.readEnv(published.env);
    expect(after.status).toBe("serving");
    expect(after.serve?.cmd).toContain(fileURLToPath(new URL("../src/static-server.ts", import.meta.url)));
    expect(after.serve?.upstream_port).toBe(before.serve?.upstream_port);
    const body = await fetch(`http://127.0.0.1:${after.serve?.upstream_port}/`).then(async (response) => response.text());
    expect(body).toContain("proto");
  });

  it("restores after a simulated reboot and refuses to touch a stranger holding the port", async () => {
    const { service, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "1h" })) as { env: string };
    cleanups.push(async () => void (await service.stop(published.env)));
    const before = await service.store.readEnv(published.env);
    await stopProcessGroup(before.serve?.pgid ?? 0);
    const strangerDir = await tempDir("daemon-stranger");
    await writeFile(path.join(strangerDir, "server.mjs"), fixtureServer);
    const stranger = spawnDetached("node server.mjs", strangerDir, { ...process.env, PORT: String(before.serve?.upstream_port) }, path.join(strangerDir, "log"));
    cleanups.push(async () => stopProcessGroup(stranger.pgid));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterBoot = new Supervisor(service, { bootTimeMs: Date.now() + 1_000, backoffBaseMs: 0 });
    await afterBoot.sweep(true);
    const blocked = await service.store.readEnv(published.env);
    expect(blocked.status).toBe("crashed");
    expect(blocked.failure?.code).toBe("E_PORTS");
    expect(pidAlive(stranger.pid)).toBe(true);
    await stopProcessGroup(stranger.pgid);
    await afterBoot.sweep(true);
    const restored = await service.store.readEnv(published.env);
    expect(restored.status).toBe("serving");
    expect(restored.failure).toBeUndefined();
    expect(restored.serve?.upstream_port).toBe(before.serve?.upstream_port);
  });

  it("gives up on a crash loop: marks the env, removes its tailscale entry, keeps the record", async () => {
    const { service, tailscaleLog, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "1h" })) as { env: string };
    const before = await service.store.readEnv(published.env);
    await stopProcessGroup(before.serve?.pgid ?? 0);
    const worktreeServer = path.join(before.worktree, "server.mjs");
    await writeFile(worktreeServer, "process.exit(1);\n");
    await writeFile(path.join(before.worktree, "nectar.toml"), `name = "daemon-fixture"\n\n[web]\nserve = "node server.mjs"\nready_path = "/"\nready_timeout = "1s"\n`);
    const supervisor = new Supervisor(service, { maxRevives: 2, backoffBaseMs: 0 });
    for (let index = 0; index < 3; index += 1) await supervisor.sweep(false);
    const given = await service.store.readEnv(published.env);
    expect(given.status).toBe("crashed");
    expect(given.failure?.code).toBe("E_CRASH_LOOP");
    expect(given.serve?.tailnet_port).toBe(before.serve?.tailnet_port);
    expect(await readFile(tailscaleLog, "utf8")).toContain(`serve --https=${before.serve?.tailnet_port} off`);
    await supervisor.sweep(false);
    expect((await service.store.readEnv(published.env)).serve?.pid).toBe(given.serve?.pid);
  });

  it("gc on the supervisor schedule expires an env past its TTL and drops its tailscale entry", async () => {
    const { service, tailscaleLog, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "1h" })) as { env: string };
    const before = await service.store.readEnv(published.env);
    await service.store.updateEnv(published.env, (current) => {
      current.expires_at = new Date(Date.now() - 60_000).toISOString();
    });
    const supervisor = new Supervisor(service, { probe: () => Promise.resolve(liveness("serving")) });
    await supervisor.gc();
    const expired = await service.store.readEnv(published.env);
    expect(expired.status).toBe("expired");
    expect(pidAlive(before.serve?.pid ?? 0)).toBe(false);
    expect(await readFile(tailscaleLog, "utf8")).toContain(`serve --https=${before.serve?.tailnet_port} off`);
    await supervisor.sweep(false);
    expect((await service.store.readEnv(published.env)).status).toBe("expired");
  });
});

describe("daemon pid file", () => {
  it("refuses a second live daemon for the same NECTAR_HOME and releases on exit", async () => {
    const paths = getPaths(await tempDir("daemon-pid"));
    await writeFile(path.join(paths.root, "nectard.pid"), `${process.ppid}\n`);
    await expect(claimPidFile(paths)).rejects.toMatchObject({ code: "E_BUSY" });
    await writeFile(path.join(paths.root, "nectard.pid"), "999999999\n");
    const release = await claimPidFile(paths);
    expect((await readFile(path.join(paths.root, "nectard.pid"), "utf8")).trim()).toBe(String(process.pid));
    await release();
    await expect(access(path.join(paths.root, "nectard.pid"))).rejects.toThrow();
  });
});

describe("service units", () => {
  const spec = {
    program: ["/usr/bin/node", "/opt/nectar dir/dist/cli.js", "daemon", "run"],
    env: { NECTAR_HOME: "/home/u/.nectar", PATH: "/usr/bin:/bin", ODD: `50% "$HOME" <&>` },
    stderrLog: "/home/u/.nectar/logs/nectard.stderr.log",
  };

  it("renders a systemd --user unit that restarts nectard and never kills its serves", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain(`ExecStart="/usr/bin/node" "/opt/nectar dir/dist/cli.js" "daemon" "run"`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain(`Environment="ODD=50%% \\"$HOME\\" <&>"`);
  });

  it("renders a launchd agent with KeepAlive, RunAtLoad and an abandoned process group", () => {
    const plist = launchdPlist(spec);
    expect(plist).toContain("<string>com.honeybeehq.nectard</string>");
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/);
    expect(plist).toContain("<string>50% &quot;$HOME&quot; &lt;&amp;&gt;</string>");
  });

  it("installs, reports and uninstalls the systemd unit through systemctl --user", async () => {
    const home = await tempDir("daemon-home");
    const fakeDir = await tempDir("daemon-systemctl");
    const calls = path.join(fakeDir, "calls.log");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    vi.stubEnv("NECTAR_SYSTEMCTL_BIN", await fakeExecutable(fakeDir, "systemctl", `echo "systemctl $*" >> ${calls}; [ "$2" = "is-active" ] && echo active; exit 0`));
    vi.stubEnv("NECTAR_LOGINCTL_BIN", await fakeExecutable(fakeDir, "loginctl", `echo "Linger=no"`));
    const paths = getPaths(path.join(home, ".nectar"));
    const installed = await installUnit(paths, "linux");
    const file = unitPath("linux");
    expect(file).toBe(path.join(home, ".config", "systemd", "user", "nectard.service"));
    expect(installed).toMatchObject({ installed: true, unit: file, warnings: [expect.stringContaining("loginctl enable-linger")] });
    expect(await readFile(file, "utf8")).toContain(`Environment="NECTAR_HOME=${paths.root}"`);
    expect(await unitStatus(paths, "linux")).toMatchObject({ installed: true, active: "active", pid: null });
    expect(await uninstallUnit(paths, "linux")).toMatchObject({ removed: true, envs_kept: true });
    await expect(access(file)).rejects.toThrow();
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "systemctl --user show-environment",
      "systemctl --user daemon-reload",
      "systemctl --user enable nectard.service",
      "systemctl --user restart nectard.service",
      "systemctl --user is-active nectard.service",
      "systemctl --user disable --now nectard.service",
      "systemctl --user daemon-reload",
    ]);
  });

  it("installs and removes the launchd agent through launchctl bootstrap/bootout", async () => {
    const home = await tempDir("daemon-home");
    const fakeDir = await tempDir("daemon-launchctl");
    const calls = path.join(fakeDir, "calls.log");
    vi.stubEnv("HOME", home);
    vi.stubEnv("NECTAR_LAUNCHCTL_BIN", await fakeExecutable(fakeDir, "launchctl", `echo "launchctl $*" >> ${calls}; exit 0`));
    const paths = getPaths(path.join(home, ".nectar"));
    await installUnit(paths, "darwin");
    const file = path.join(home, "Library", "LaunchAgents", "com.honeybeehq.nectard.plist");
    expect(await readFile(file, "utf8")).toContain("<key>KeepAlive</key>");
    await uninstallUnit(paths, "darwin");
    await expect(access(file)).rejects.toThrow();
    const uid = process.getuid?.() ?? 0;
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      `launchctl bootout gui/${uid}/com.honeybeehq.nectard`,
      `launchctl bootstrap gui/${uid} ${file}`,
      `launchctl bootout gui/${uid}/com.honeybeehq.nectard`,
    ]);
  });

  it("fails clearly when there is no user systemd session", async () => {
    const home = await tempDir("daemon-home");
    const fakeDir = await tempDir("daemon-systemctl");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    vi.stubEnv("NECTAR_SYSTEMCTL_BIN", await fakeExecutable(fakeDir, "systemctl", `echo "Failed to connect to bus" >&2; exit 1`));
    await expect(installUnit(getPaths(path.join(home, ".nectar")), "linux")).rejects.toMatchObject({ code: "E_PLATFORM" });
    await expect(access(unitPath("linux"))).rejects.toThrow();
  });
});
