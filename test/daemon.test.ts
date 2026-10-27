import path from "node:path";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pidAlive, processBelongsToEnv, spawnDetached, stopProcessGroup } from "../src/commands.js";
import { portOpen } from "../src/ports.js";
import { claimPidFile, Supervisor, supervised } from "../src/daemon.js";
import { installUnit, launchdPlist, systemdUnit, uninstallUnit, unitPath, unitStatus } from "../src/daemon-unit.js";
import { getPaths } from "../src/paths.js";
import { NectarService, type ReviveResult } from "../src/service.js";
import type { EnvRecord, Liveness, ServeRecord } from "../src/types.js";
import { fakeExecutable, fakeServiceManager, fakeTailscale, initGitRepo, record, tempDir } from "./helpers.js";

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
  giveUp: ReturnType<typeof vi.fn>;
  reassertMesh: ReturnType<typeof vi.fn>;
  gc: ReturnType<typeof vi.fn>;
} {
  const revive = vi.fn((): Promise<ReviveResult> => Promise.resolve({ revived: true, reason: "spawned", pid: 5000, mesh: true }));
  const giveUp = vi.fn(() => Promise.resolve(true));
  const reassertMesh = vi.fn(() => Promise.resolve(true));
  const gc = vi.fn(() => Promise.resolve({ transitions: [], serve_orphans: [], skipped: [] }));
  const service = {
    store: { listEnvs: () => Promise.resolve(records) },
    revive,
    giveUp,
    reassertMesh,
    idleStop: () => Promise.resolve(),
    gc,
  } as unknown as NectarService;
  return { service, revive, giveUp, reassertMesh, gc };
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
    expect(fake.giveUp).toHaveBeenCalledWith("demo--main--web", 4242, "E_CRASH_LOOP", expect.stringContaining("Revived 3 times"));
  });

  it("forgets old revives, so a rare crash is always revived", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T00:00:00.000Z") });
    const fake = fakeService([webRecord()]);
    const supervisor = new Supervisor(fake.service, { bootTimeMs: BOOT, probe: () => Promise.resolve(liveness("crashed")), maxRevives: 1 });
    await supervisor.sweep(false);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledTimes(2);
    expect(fake.giveUp).not.toHaveBeenCalled();
  });

  it("does not count a revive that lost a race with a publish", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-14T00:00:00.000Z") });
    const fake = fakeService([webRecord()]);
    fake.revive.mockResolvedValue({ revived: false, reason: "E_BUSY" });
    const supervisor = new Supervisor(fake.service, { bootTimeMs: BOOT, probe: () => Promise.resolve(liveness("crashed")), maxRevives: 1 });
    await supervisor.sweep(false);
    await supervisor.sweep(false);
    expect(fake.revive).toHaveBeenCalledTimes(2);
    expect(fake.giveUp).not.toHaveBeenCalled();
  });

  it("gives up with E_PORTS instead of re-pointing the mesh when a stranger answers on a dead env's port", async () => {
    const fake = fakeService([webRecord()]);
    const stranger: Liveness = { ...liveness("serving"), pid_alive: false };
    const supervisor = new Supervisor(fake.service, { bootTimeMs: BOOT, probe: () => Promise.resolve(stranger) });
    await supervisor.sweep(true);
    expect(fake.giveUp).toHaveBeenCalledWith("demo--main--web", 4242, "E_PORTS", expect.stringContaining("another process holds it"));
    expect(fake.reassertMesh).not.toHaveBeenCalled();
    expect(fake.revive).not.toHaveBeenCalled();
    expect(supervised(webRecord({ status: "crashed", failure: { code: "E_PORTS", message: "", failed_at: "", log_tail: [] } }), Date.now())).toBe(false);
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

async function startStranger(port: number): Promise<{ pid: number; pgid: number }> {
  const dir = await tempDir("daemon-stranger");
  await writeFile(path.join(dir, "server.mjs"), fixtureServer);
  const stranger = spawnDetached("exec node server.mjs", dir, { ...process.env, PORT: String(port) }, path.join(dir, "log"));
  for (let attempt = 0; attempt < 50 && !(await portOpen(port)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return stranger;
}

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

  it("restores the shared static server at the original URLs without per-preview runtimes", async () => {
    const { service } = await liveHarness();
    const site = path.join(await tempDir("daemon-static"), "proto");
    await mkdir(site, { recursive: true });
    await writeFile(path.join(site, "index.html"), "<h1>proto</h1>");
    const published = (await service.publish({ repo: site, ttl: "1h" })) as { env: string; urls: { local: string } };
    cleanups.push(async () => void (await service.stop(published.env)));
    const sharedFile = path.join(service.paths.root, "shared-static.json");
    const before = JSON.parse(await readFile(sharedFile, "utf8")) as { pid: number; port: number };
    await stopProcessGroup(before.pid);
    await new Supervisor(service).sweep(false);
    const after = JSON.parse(await readFile(sharedFile, "utf8")) as { pid: number; port: number };
    expect(after.pid).not.toBe(before.pid);
    expect(after.port).toBe(before.port);
    expect((await service.store.readEnv(published.env)).serve).toBeUndefined();
    const body = await fetch(published.urls.local).then(async (response) => response.text());
    expect(body).toContain("proto");
  });

  it("after a reboot, never signals a stranger on the port: drops only its own mesh entry and waits for a republish", async () => {
    const { service, tailscaleLog, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "1h" })) as { env: string };
    cleanups.push(async () => void (await service.stop(published.env)));
    const before = await service.store.readEnv(published.env);
    await stopProcessGroup(before.serve?.pgid ?? 0);
    const stranger = await startStranger(before.serve?.upstream_port ?? 0);
    cleanups.push(async () => stopProcessGroup(stranger.pgid));
    const afterBoot = new Supervisor(service, { bootTimeMs: Date.now() + 1_000, backoffBaseMs: 0 });
    await afterBoot.sweep(true);
    const blocked = await service.store.readEnv(published.env);
    expect(blocked.status).toBe("crashed");
    expect(blocked.failure?.code).toBe("E_PORTS");
    expect(blocked.urls.mesh).toBeNull();
    expect(pidAlive(stranger.pid)).toBe(true);
    expect(await readFile(tailscaleLog, "utf8")).toContain(`serve --https=${before.serve?.tailnet_port} off`);
    await stopProcessGroup(stranger.pgid);
    await afterBoot.sweep(true);
    expect((await service.store.readEnv(published.env)).failure?.code).toBe("E_PORTS");
    await service.publish({ repo, ttl: "1h" });
    const republished = await service.store.readEnv(published.env);
    expect(republished.status).toBe("serving");
    expect(republished.urls.mesh).toBe(before.urls.mesh);
  });

  it("does not re-point the mesh at a stranger answering on a dead env's port", async () => {
    const { service, tailscaleLog, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "1h" })) as { env: string };
    const before = await service.store.readEnv(published.env);
    await stopProcessGroup(before.serve?.pgid ?? 0);
    const stranger = await startStranger(before.serve?.upstream_port ?? 0);
    cleanups.push(async () => stopProcessGroup(stranger.pgid));
    await new Supervisor(service).sweep(true);
    const after = await service.store.readEnv(published.env);
    expect(after.failure?.code).toBe("E_PORTS");
    expect(pidAlive(stranger.pid)).toBe(true);
    const pointed = (await readFile(tailscaleLog, "utf8")).split("\n").filter((line) => line.includes(`--https=${before.serve?.tailnet_port} http`));
    expect(pointed).toHaveLength(1);
  });

  it("revives without re-pointing its tailnet port once something else took that port over", async () => {
    const { service, tailscaleLog, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "1h" })) as { env: string };
    cleanups.push(async () => void (await service.stop(published.env)));
    const before = await service.store.readEnv(published.env);
    vi.stubEnv(
      "FAKE_TS_SERVE_STATUS",
      JSON.stringify({ Web: { [`fixture.tailtest.ts.net:${before.serve?.tailnet_port}`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } }),
    );
    await stopProcessGroup(before.serve?.pgid ?? 0);
    await new Supervisor(service).sweep(false);
    const after = await service.store.readEnv(published.env);
    expect(after.status).toBe("serving");
    expect(after.urls.mesh).toBeNull();
    const pointed = (await readFile(tailscaleLog, "utf8")).split("\n").filter((line) => line.includes(`--https=${before.serve?.tailnet_port}`));
    expect(pointed).toHaveLength(1);
  });

  it("restarting an unhealthy env never signals a recorded pid that is not the env's own process", async () => {
    const { service, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "1h" })) as { env: string };
    cleanups.push(async () => void (await service.stop(published.env)));
    const before = await service.store.readEnv(published.env);
    await stopProcessGroup(before.serve?.pgid ?? 0);
    const sleeperDir = await tempDir("daemon-sleeper");
    const sleeper = spawnDetached("exec sleep 60", sleeperDir, { ...process.env }, path.join(sleeperDir, "log"));
    cleanups.push(async () => stopProcessGroup(sleeper.pgid));
    await service.store.updateEnv(published.env, (current) => {
      if (current.serve !== undefined) Object.assign(current.serve, { pid: sleeper.pid, pgid: sleeper.pgid });
    });
    await new Supervisor(service, { unhealthyRestartAfter: 1, probe: () => Promise.resolve(liveness("unhealthy")) }).sweep(false);
    const after = await service.store.readEnv(published.env);
    expect(pidAlive(sleeper.pid)).toBe(true);
    expect(after.status).toBe("serving");
    expect(after.serve?.pid).toBe(sleeper.pid);
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

describe("process ownership", () => {
  it("recognises only the recorded process start identity", async () => {
    const dir = await tempDir("daemon-owner");
    const child = spawnDetached("exec sleep 30", dir, { ...process.env, NECTAR_ENV: "demo--main--web" }, path.join(dir, "log"));
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await processBelongsToEnv(child)).toBe(true);
      expect(await processBelongsToEnv({ ...child, start_time: "stale" })).toBe(false);
      expect(await processBelongsToEnv({ pid: process.pid, pgid: process.pid })).toBe(false);
      expect(await processBelongsToEnv({ pid: 999_999_999, pgid: 999_999_999 })).toBe(false);
    } finally {
      await stopProcessGroup(child.pgid);
    }
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
    vi.stubEnv(
      "NECTAR_SYSTEMCTL_BIN",
      await fakeExecutable(fakeDir, "systemctl", `echo "systemctl $*" >> ${calls}; [ "$2" = "show" ] && printf 'ActiveState=active\\nMainPID=${process.pid}\\n'; exit 0`),
    );
    vi.stubEnv("NECTAR_LOGINCTL_BIN", await fakeExecutable(fakeDir, "loginctl", `echo "Linger=no"`));
    const paths = getPaths(path.join(home, ".nectar"));
    const installed = await installUnit(paths, "linux");
    const file = unitPath("linux");
    expect(file).toBe(path.join(home, ".config", "systemd", "user", "nectard.service"));
    expect(installed).toMatchObject({ installed: true, unit: file, pid: process.pid, warnings: [expect.stringContaining("loginctl enable-linger")] });
    expect(await readFile(file, "utf8")).toContain(`Environment="NECTAR_HOME=${paths.root}"`);
    expect(await unitStatus(paths, "linux")).toMatchObject({ installed: true, active: "active", pid: process.pid, pid_source: "systemctl" });
    expect(await uninstallUnit(paths, "linux")).toMatchObject({ removed: true, envs_kept: true });
    await expect(access(file)).rejects.toThrow();
    const show = "systemctl --user show --property=ActiveState --property=MainPID nectard.service";
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      "systemctl --user show-environment",
      "systemctl --user daemon-reload",
      "systemctl --user enable nectard.service",
      "systemctl --user restart nectard.service",
      show,
      show,
      show,
      "systemctl --user disable --now nectard.service",
      "systemctl --user daemon-reload",
    ]);
  });

  async function fakeLaunchd(options: { loaded?: boolean; unloadPrints?: number; bootstrapFailures?: number } = {}): Promise<{ home: string; calls: string; file: string }> {
    const home = await tempDir("daemon-home");
    const fakeDir = await tempDir("daemon-launchctl");
    const calls = path.join(fakeDir, "calls.log");
    const loaded = path.join(fakeDir, "loaded");
    const unloading = path.join(fakeDir, "unloading");
    const failures = path.join(fakeDir, "failures");
    vi.stubEnv("HOME", home);
    if (options.loaded === true) await writeFile(loaded, "");
    await writeFile(failures, String(options.bootstrapFailures ?? 0));
    vi.stubEnv(
      "NECTAR_LAUNCHCTL_BIN",
      await fakeExecutable(
        fakeDir,
        "launchctl",
        `echo "launchctl $*" >> '${calls}'
case "$1" in
  bootout) [ -f '${loaded}' ] && echo ${options.unloadPrints ?? 0} > '${unloading}' ;;
  list)
    if [ -f '${unloading}' ]; then
      left=$(cat '${unloading}')
      if [ "$left" -le 0 ]; then rm -f '${unloading}' '${loaded}'; else echo $((left - 1)) > '${unloading}'; fi
    fi
    [ -f '${loaded}' ] || exit 113
    printf '"PID" = %s;\n' "$PPID" ;;
  bootstrap)
    left=$(cat '${failures}')
    if [ -f '${loaded}' ] || [ "$left" -gt 0 ]; then
      echo $((left - 1)) > '${failures}'
      printf 'Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.\n' >&2
      exit 5
    fi
    : > '${loaded}' ;;
esac
exit 0`,
      ),
    );
    return { home, calls, file: path.join(home, "Library", "LaunchAgents", "com.honeybeehq.nectard.plist") };
  }

  async function launchctlCalls(calls: string, verb: string): Promise<string[]> {
    return (await readFile(calls, "utf8")).trim().split("\n").filter((line) => line.startsWith(`launchctl ${verb}`));
  }

  it("installs and removes the launchd agent through launchctl bootstrap/bootout", async () => {
    const { home, calls, file } = await fakeLaunchd();
    const paths = getPaths(path.join(home, ".nectar"));
    expect(await installUnit(paths, "darwin", { waitMs: 0 })).toMatchObject({ active: "running", pid: process.pid, pid_source: "launchctl" });
    expect(await readFile(file, "utf8")).toContain("<key>KeepAlive</key>");
    await uninstallUnit(paths, "darwin");
    await expect(access(file)).rejects.toThrow();
    const uid = process.getuid?.() ?? 0;
    const print = `launchctl list com.honeybeehq.nectard`;
    expect((await readFile(calls, "utf8")).trim().split("\n")).toEqual([
      print,
      `launchctl bootout gui/${uid}/com.honeybeehq.nectard`,
      print,
      `launchctl bootstrap gui/${uid} ${file}`,
      print,
      print,
      `launchctl bootout gui/${uid}/com.honeybeehq.nectard`,
      print,
    ]);
  });

  it("uninstall waits until launchctl list no longer finds the agent and reports it", async () => {
    const { home, calls, file } = await fakeLaunchd({ loaded: true, unloadPrints: 3 });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "<plist>installed</plist>");
    const removed = await uninstallUnit(getPaths(path.join(home, ".nectar")), "darwin");
    expect(removed).toMatchObject({ removed: true, unloaded: true, warnings: [] });
    expect(await launchctlCalls(calls, "list")).toHaveLength(4);
  });

  it("uninstall gives up waiting after its bound and says the agent is still loaded", async () => {
    const { home } = await fakeLaunchd({ loaded: true, unloadPrints: 1_000 });
    const removed = await uninstallUnit(getPaths(path.join(home, ".nectar")), "darwin", { settleMs: 300 });
    expect(removed).toMatchObject({ unloaded: false });
    expect((removed.waited_ms as number) >= 300).toBe(true);
    expect(removed.warnings).toEqual([expect.stringContaining("still finds com.honeybeehq.nectard")]);
  });

  it("reinstalling over a loaded agent waits for bootout to finish before bootstrapping", async () => {
    const { home, calls, file } = await fakeLaunchd({ loaded: true, unloadPrints: 3 });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "<plist>an older install</plist>");
    const installed = await installUnit(getPaths(path.join(home, ".nectar")), "darwin");
    expect(installed).toMatchObject({ active: "running", pid: process.pid });
    expect(await launchctlCalls(calls, "bootstrap")).toHaveLength(1);
    expect(await launchctlCalls(calls, "kickstart")).toHaveLength(0);
  });

  it("retries bootstrap once on launchd's transient I/O error 5 and ends loaded", async () => {
    const { home, calls } = await fakeLaunchd({ bootstrapFailures: 1 });
    expect(await installUnit(getPaths(path.join(home, ".nectar")), "darwin")).toMatchObject({ active: "running", pid: process.pid });
    expect(await launchctlCalls(calls, "bootstrap")).toHaveLength(2);
  });

  it("fails clearly, naming launchctl's error, when bootstrap keeps failing", async () => {
    const { home, calls } = await fakeLaunchd({ bootstrapFailures: 5 });
    const failed = installUnit(getPaths(path.join(home, ".nectar")), "darwin");
    await expect(failed).rejects.toMatchObject({ code: "E_PLATFORM" });
    await expect(failed).rejects.toThrow(/Input\/output error.*is not loaded/s);
    expect(await launchctlCalls(calls, "bootstrap")).toHaveLength(2);
  });

  it("reinstalling an unchanged, running launchd agent restarts it in place", async () => {
    const { home, calls } = await fakeLaunchd();
    const paths = getPaths(path.join(home, ".nectar"));
    await installUnit(paths, "darwin");
    await writeFile(calls, "");
    expect(await installUnit(paths, "darwin")).toMatchObject({ active: "running", pid: process.pid });
    expect(await launchctlCalls(calls, "kickstart")).toEqual([`launchctl kickstart -k gui/${process.getuid?.() ?? 0}/com.honeybeehq.nectard`]);
    expect(await launchctlCalls(calls, "bootout")).toHaveLength(0);
    expect(await launchctlCalls(calls, "bootstrap")).toHaveLength(0);
  });

  it("reinstalling the systemd unit twice restarts it and leaves it active with a pid", async () => {
    const fakeDir = await tempDir("daemon-systemctl");
    const { calls, home } = await fakeServiceManager(fakeDir);
    const paths = getPaths(path.join(home, ".nectar"));
    for (let run = 0; run < 2; run += 1) {
      const installed = await installUnit(paths, "linux");
      expect(installed).toMatchObject({ installed: true, active: "active", pid_source: "systemctl" });
      expect(installed.pid).toBeGreaterThan(1);
    }
    expect((await readFile(calls, "utf8")).split("\n").filter((line) => line.includes(" restart "))).toHaveLength(2);
  });

  it("fails clearly when systemctl restart leaves the unit failed", async () => {
    const home = await tempDir("daemon-home");
    const fakeDir = await tempDir("daemon-systemctl");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    vi.stubEnv("NECTAR_SYSTEMCTL_BIN", await fakeExecutable(fakeDir, "systemctl", `[ "$2" = "show" ] && printf 'ActiveState=failed\nMainPID=0\n'; exit 0`));
    const failed = installUnit(getPaths(path.join(home, ".nectar")), "linux");
    await expect(failed).rejects.toMatchObject({ code: "E_PLATFORM" });
    await expect(failed).rejects.toThrow("left it failed");
  });

  it("daemon status reads the live pid from launchctl list right after install", async () => {
    const { home } = await fakeLaunchd();
    const paths = getPaths(path.join(home, ".nectar"));
    expect(await installUnit(paths, "darwin")).toMatchObject({ active: "running", pid: process.pid, pid_source: "launchctl" });
    expect(await unitStatus(paths, "darwin")).toMatchObject({ installed: true, active: "running", pid: process.pid, pid_source: "launchctl" });
  });

  it("daemon status falls back to nectard.pid and waits briefly for it while the unit is starting", async () => {
    const home = await tempDir("daemon-home");
    const fakeDir = await tempDir("daemon-systemctl");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    vi.stubEnv("NECTAR_SYSTEMCTL_BIN", await fakeExecutable(fakeDir, "systemctl", `printf 'ActiveState=activating\\nMainPID=0\\n'`));
    const paths = getPaths(path.join(home, ".nectar"));
    await mkdir(paths.root, { recursive: true });
    setTimeout(() => void writeFile(path.join(paths.root, "nectard.pid"), `${process.pid}\n`), 300);
    expect(await unitStatus(paths, "linux")).toMatchObject({ active: "activating", pid: process.pid, pid_source: "pidfile" });
  });

  it("daemon status does not wait when the unit is not running", async () => {
    const home = await tempDir("daemon-home");
    const fakeDir = await tempDir("daemon-systemctl");
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    vi.stubEnv("NECTAR_SYSTEMCTL_BIN", await fakeExecutable(fakeDir, "systemctl", `printf 'ActiveState=inactive\\nMainPID=0\\n'`));
    const started = Date.now();
    expect(await unitStatus(getPaths(path.join(home, ".nectar")), "linux")).toMatchObject({ active: "inactive", pid: null, pid_source: null });
    expect(Date.now() - started).toBeLessThan(1_000);
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
