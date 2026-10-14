import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupAlive, pidAlive, scrubbedEnvironment, spawnDetachedExecutable, stopProcessGroup } from "../src/commands.js";
import { launchdPlist, parseLaunchdPlist, parseSystemdUnit, systemdUnit } from "../src/daemon-unit.js";
import { classifyServeEntry, commandTools, guardSharedPorts, type DoctorAction, type DoctorCheck } from "../src/doctor.js";
import { allocatePort } from "../src/ports.js";
import { DEFAULT_CONFIG } from "../src/state.js";
import { serveEntries } from "../src/tailscale.js";
import { NectarService } from "../src/service.js";
import { fakeServiceManager, record, statefulTailscale, tempDir } from "./helpers.js";

const config = { ...DEFAULT_CONFIG, upstream_port_start: 4100, upstream_port_end: 4199, tailnet_port_start: 8443, tailnet_port_end: 8542 };

describe("serve entry classification", () => {
  const live = record({
    name: "live--main--web",
    status: "serving",
    serve: { cmd: "node s.mjs", pid: 10, pgid: 10, upstream_port: 4100, tailnet_port: 8443 },
  });
  const expired = record({
    name: "old--main--web",
    status: "expired",
    serve: { cmd: "node s.mjs", pid: 11, pgid: 11, upstream_port: 4101, tailnet_port: 8444 },
  });
  const classify = (tailnetPort: number, target: string, probe = { answering: false, ownerAlive: false }) =>
    classifyServeEntry({ tailnetPort, target }, [live, expired], config, probe);

  it("keeps live envs and envs whose own process still runs", () => {
    expect(classify(8443, "http://127.0.0.1:4100", { answering: true, ownerAlive: false }).class).toBe("owned");
    expect(classify(8444, "http://127.0.0.1:4101", { answering: false, ownerAlive: true }).class).toBe("owned");
  });

  it("marks dead Nectar targets as orphans", () => {
    expect(classify(8444, "http://127.0.0.1:4101")).toMatchObject({ class: "orphan", env: "old--main--web" });
    expect(classify(8443, "http://127.0.0.1:4100")).toMatchObject({ class: "orphan", env: "live--main--web" });
    expect(classify(8450, "http://127.0.0.1:4150")).toMatchObject({ class: "orphan" });
    expect(classify(8450, "http://localhost:4150").class).toBe("orphan");
  });

  it("never treats non-Nectar targets as orphans", () => {
    expect(classify(8450, "http://127.0.0.1:3000").class).toBe("foreign");
    expect(classify(8450, "https://example.com").class).toBe("foreign");
    expect(classify(8450, "127.0.0.1:5432").class).toBe("foreign");
    expect(classify(8450, "/srv/files").class).toBe("foreign");
    expect(classify(8450, "http://10.0.0.5:4150").class).toBe("foreign");
  });

  it("counts an env's nectard proxy port as its own and re-points a dead proxy at a live app", () => {
    const fronted = record({
      name: "front--main--web",
      status: "serving",
      serve: { cmd: "node s.mjs", pid: 12, pgid: 12, upstream_port: 4102, tailnet_port: 8445, proxy_port: 4180 },
      urls: { local: "http://127.0.0.1:4102", mesh: "https://demo.example.ts.net:8445" },
    });
    const entry = { tailnetPort: 8445, target: "http://127.0.0.1:4180" };
    expect(classifyServeEntry(entry, [fronted], config, { answering: true, ownerAlive: true }).class).toBe("owned");
    expect(classifyServeEntry(entry, [fronted], config, { answering: false, ownerAlive: true, appAnswers: true })).toMatchObject({
      class: "orphan",
      direct: "http://127.0.0.1:4102",
    });
    expect(classifyServeEntry({ tailnetPort: 8445, target: "http://127.0.0.1:4181" }, [fronted], config, { answering: false, ownerAlive: false }).class).toBe("ambiguous");
  });

  it("treats Tailscale Service entries as foreign", () => {
    expect(classifyServeEntry({ tailnetPort: 8450, target: "http://127.0.0.1:4150", service: "svc:foo" }, [], config, { answering: false, ownerAlive: false }).class).toBe("foreign");
  });

  it("never removes an orphan that shares its port or is not the root mount", () => {
    const orphan = classify(8450, "http://127.0.0.1:4150");
    const shared = guardSharedPorts([
      { ...orphan, mount: "/nectar" },
      { tailnetPort: 8450, target: "http://127.0.0.1:3001", mount: "/", class: "foreign", reason: "x" },
    ]);
    expect(shared[0]).toMatchObject({ class: "ambiguous" });
    expect(guardSharedPorts([{ ...orphan, mount: "/nectar" }])[0]).toMatchObject({ class: "ambiguous" });
    expect(guardSharedPorts([{ ...orphan, mount: "/" }])[0]).toMatchObject({ class: "orphan" });
  });

  it("reports anything it cannot prove as ambiguous", () => {
    expect(classify(8450, "http://127.0.0.1:4150", { answering: true, ownerAlive: false }).class).toBe("ambiguous");
    expect(classify(8444, "http://127.0.0.1:4101", { answering: true, ownerAlive: false }).class).toBe("ambiguous");
    expect(classify(8443, "http://127.0.0.1:4120").class).toBe("ambiguous");
  });

  it("reads every target under a port key, including TCP forwards and text handlers", () => {
    const entries = serveEntries({
      TCP: { "8443": { HTTPS: true }, "8460": { TCPForward: "127.0.0.1:5432" } },
      Web: {
        "host.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4100" }, "/docs": { Text: "hi" } } },
      },
      AllowFunnel: { "host.ts.net:8443": true },
    });
    expect(entries).toEqual([
      { tailnetPort: 8443, target: "hi", mount: "/docs" },
      { tailnetPort: 8443, target: "http://127.0.0.1:4100", mount: "/" },
      { tailnetPort: 8460, target: "127.0.0.1:5432" },
    ]);
    expect(serveEntries({ Services: { "svc:foo": { Web: { "foo.ts.net:8462": { Handlers: { "/": { Proxy: "http://127.0.0.1:4163" } } } } } } })).toEqual([
      { tailnetPort: 8462, target: "http://127.0.0.1:4163", mount: "/", service: "svc:foo" },
    ]);
  });
});

describe("doctor helpers", () => {
  it("extracts the tools a serve or build command runs", () => {
    expect(commandTools("pnpm dev")).toEqual(["pnpm"]);
    expect(commandTools(`exec '/opt/node/bin/node' '/x/static-server.js'`)).toEqual([]);
    expect(commandTools(`rm -f .nectar/server.pid && BUNDLE_PATH=vendor/bundle exec bin/rails server -p "$PORT"`)).toEqual(["rm"]);
    expect(commandTools(`exec uv run --frozen python -m uvicorn app:app`)).toEqual(["uv"]);
    expect(commandTools("cd web; npm run dev | tee log")).toEqual(["npm", "tee"]);
  });

  it("parses the program and environment back out of both unit formats", () => {
    const spec = {
      program: ["/opt/node 24/bin/node", "/x/dist/cli.js", "daemon", "run"],
      env: { NECTAR_HOME: "/home/u/.nectar", PATH: "/usr/bin:/bin", ODD: `50% "$HOME" <&> \\x` },
      stderrLog: "/tmp/log",
    };
    expect(parseSystemdUnit(systemdUnit(spec))).toEqual({ program: spec.program, env: spec.env });
    expect(parseLaunchdPlist(launchdPlist(spec))).toEqual({ program: spec.program, env: spec.env });
  });
});

describe("doctor --fix on a messy machine", () => {
  const started: number[] = [];

  afterEach(async () => {
    for (const pgid of started.splice(0)) await stopProcessGroup(pgid).catch(() => undefined);
    vi.unstubAllEnvs();
  });

  function listen(port: number, env: Record<string, string>): { pid: number; pgid: number } {
    const child = spawnDetachedExecutable(
      process.execPath,
      ["-e", `require("node:http").createServer((q, r) => r.end("ok")).listen(${port}, "127.0.0.1")`],
      process.cwd(),
      scrubbedEnvironment(env),
      "/dev/null",
    );
    started.push(child.pgid);
    return child;
  }

  async function fakePackServer(directory: string): Promise<string> {
    const entry = path.join(directory, "pack-server.mjs");
    await writeFile(entry, `import http from "node:http"; http.createServer((_q, r) => { r.writeHead(404); r.end(); }).listen(Number(process.argv[3]), "127.0.0.1");`);
    return entry;
  }

  async function waitListening(port: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const open = await fetch(`http://127.0.0.1:${port}/`).then(
        () => true,
        () => false,
      );
      if (open) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`port ${port} never opened`);
  }

  it("removes only orphaned Nectar entries, stops only Nectar's processes, and is idempotent", async () => {
    const state = await tempDir("doctor-state");
    const fakeDir = await tempDir("doctor-bin");
    const packServer = await fakePackServer(fakeDir);
    await writeFile(
      path.join(state, "nectar.json"),
      JSON.stringify({ upstream_port_start: 4200, upstream_port_end: 4289, pack_server_port: 4295, tailnet_port_start: 8800, tailnet_port_end: 8899 }),
    );
    vi.stubEnv("NECTAR_HOME", state);
    vi.stubEnv("NECTAR_PACK_SERVER_ENTRY", packServer);
    vi.stubEnv("NECTAR_PORTLESS_BIN", path.join(fakeDir, "no-portless"));
    const manager = await fakeServiceManager(fakeDir);
    const service = new NectarService(state);
    await service.store.init();

    const reserved = new Set<number>();
    const port = async (): Promise<number> => {
      const chosen = await allocatePort({ start: 4200, end: 4289, reserved });
      reserved.add(chosen);
      return chosen;
    };
    const [liveUp, expiredUp, deadUp, orphanUp, strangerUp, subPathUp, serviceUp] = [
      await port(), await port(), await port(), await port(), await port(), await port(), await port(),
    ];
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();

    const liveProc = listen(liveUp, { NECTAR_ENV: "live--main--web" });
    const expiredProc = listen(expiredUp, { NECTAR_ENV: "old--main--web" });
    const stranger = listen(strangerUp, {});
    const recycled = listen(await port(), {});
    await Promise.all([liveUp, expiredUp, strangerUp].map(waitListening));

    const base = { published_at: past, last_touched_at: past };
    await service.store.writeEnv(
      record({
        ...base,
        name: "live--main--web",
        expires_at: future,
        serve: { cmd: "node s.mjs", ...liveProc, upstream_port: liveUp, tailnet_port: 8801 },
        urls: { local: `http://127.0.0.1:${liveUp}`, mesh: "https://fixture.tailtest.ts.net:8801" },
      }),
    );
    await service.store.writeEnv(
      record({
        ...base,
        name: "old--main--web",
        expires_at: past,
        liveness: { state: "serving", reason: "port_open", checked_at: past, pid_alive: true, port_open: true },
        serve: { cmd: "node s.mjs", ...expiredProc, upstream_port: expiredUp, tailnet_port: 8802 },
      }),
    );
    await service.store.writeEnv(
      record({
        ...base,
        name: "killed--main--web",
        status: "crashed",
        expires_at: future,
        serve: { cmd: "node s.mjs", pid: 999_998, pgid: 999_998, upstream_port: deadUp, tailnet_port: 8803 },
      }),
    );
    await service.store.writeEnv(
      record({
        ...base,
        name: "recycled--main--web",
        expires_at: past,
        serve: { cmd: "node s.mjs", ...recycled, upstream_port: 4288, tailnet_port: 8805 },
      }),
    );
    const proxy = (target: string) => ({ Handlers: { "/": { Proxy: target } } });
    const tailscale = await statefulTailscale(fakeDir, {
      TCP: { "8801": { HTTPS: true }, "8811": { TCPForward: "127.0.0.1:5432" } },
      Web: {
        "fixture.tailtest.ts.net:8801": proxy(`http://127.0.0.1:${liveUp}`),
        "fixture.tailtest.ts.net:8802": proxy(`http://127.0.0.1:${expiredUp}`),
        "fixture.tailtest.ts.net:8803": proxy(`http://127.0.0.1:${deadUp}`),
        "fixture.tailtest.ts.net:8804": proxy(`http://127.0.0.1:${orphanUp}`),
        "fixture.tailtest.ts.net:8805": proxy("http://127.0.0.1:3000"),
        "fixture.tailtest.ts.net:8806": proxy(`http://127.0.0.1:${strangerUp}`),
        "fixture.tailtest.ts.net:8807": proxy("https://grafana.internal.example"),
        "fixture.tailtest.ts.net:9443": proxy("http://127.0.0.1:4280"),
        "fixture.tailtest.ts.net:8808": { Handlers: { "/": { Proxy: "http://127.0.0.1:3001" }, "/nectar": { Proxy: `http://127.0.0.1:${subPathUp}` } } },
        "fixture.tailtest.ts.net:8809": proxy("http://localhost:3003"),
      },
      Services: { "svc:foo": { Web: { "foo.tailtest.ts.net:8809": proxy(`http://127.0.0.1:${serviceUp}`) } } },
    });
    const mutations = async (): Promise<string[]> =>
      (await readFile(tailscale.log, "utf8")).split("\n").filter((line) => line.startsWith("serve ") && line !== "serve status --json");
    const byName = (checks: unknown, name: string): DoctorCheck | undefined => (checks as DoctorCheck[]).find((check) => check.name === name);

    const diagnosed = await service.doctor();
    expect(byName(diagnosed.checks, "serve-orphans")).toMatchObject({ status: "fail" });
    expect(byName(diagnosed.checks, "serve-orphans")?.message).toContain(":8803");
    expect(byName(diagnosed.checks, "serve-orphans")?.message).toContain(":8804");
    expect(byName(diagnosed.checks, "serve-foreign")).toMatchObject({ status: "warn" });
    expect(byName(diagnosed.checks, "serve-foreign")?.message).toEqual(expect.stringContaining(":8805"));
    expect(byName(diagnosed.checks, "serve-foreign")?.message).toEqual(expect.stringContaining(":8807"));
    expect(byName(diagnosed.checks, "serve-foreign")?.message).toEqual(expect.stringContaining(":8811"));
    expect(byName(diagnosed.checks, "serve-ambiguous")?.message).toEqual(expect.stringContaining(":8806"));
    expect(byName(diagnosed.checks, "env-resources")?.message).toEqual(expect.stringContaining("expire old--main--web"));
    expect(byName(diagnosed.checks, "nectard")).toMatchObject({ status: "warn" });
    expect(byName(diagnosed.checks, "nectard")?.message).toContain("not installed");
    expect(byName(diagnosed.checks, "gc-recency")).toMatchObject({ status: "warn" });
    expect(byName(diagnosed.checks, "portless")).toMatchObject({ status: "warn" });
    expect(byName(diagnosed.checks, "portless")?.hint).toContain("PATH");
    expect(await mutations()).toEqual([]);

    const planned = await service.doctor({ fix: true, dryRun: true });
    const plannedActions = planned.actions as DoctorAction[];
    expect(plannedActions.every((action) => action.status === "planned")).toBe(true);
    expect(plannedActions.filter((action) => action.action === "remove-serve-entry").map((action) => action.target)).toEqual([":8803", ":8804"]);
    expect(plannedActions.map((action) => action.action)).toEqual(
      expect.arrayContaining(["gc-expire", "gc", "install-nectard", "start-pack-server", "serve-pack-store"]),
    );
    expect(await mutations()).toEqual([]);
    expect(await readFile(manager.calls, "utf8").catch(() => "")).not.toMatch(/restart|enable/);

    expect(plannedActions.find((action) => action.action === "gc-expire")?.before).toEqual({ env: "old--main--web", process: true, serve_entry: 8802 });
    const fixed = await service.doctor({ fix: true });
    const packPgid = (await service.store.readConfig()).pack_server_pgid;
    if (packPgid !== undefined) started.push(packPgid);
    const actions = fixed.actions as DoctorAction[];
    expect(actions.filter((action) => action.status !== "done")).toEqual([]);
    expect(actions.find((action) => action.action === "gc-expire")?.after).toEqual({ status: "expired", process: false, serve_entry: null });
    const removed = await mutations();
    expect(removed.filter((line) => line.endsWith(" off")).sort()).toEqual(["serve --https=8802 off", "serve --https=8803 off", "serve --https=8804 off"]);
    expect(removed.filter((line) => !line.endsWith(" off"))).toEqual([expect.stringMatching(/^serve --bg --yes --https=8440 http:\/\/127\.0\.0\.1:\d+$/)]);
    const after = JSON.parse(await readFile(tailscale.state, "utf8")) as { Web: Record<string, unknown>; TCP: Record<string, unknown> };
    expect(Object.keys(after.Web).sort()).toEqual(
      ["8440", "8801", "8805", "8806", "8807", "8808", "8809", "9443"].map((key) => `fixture.tailtest.ts.net:${key}`).sort(),
    );
    expect(byName(fixed.checks, "serve-ambiguous")?.message).toEqual(expect.stringContaining(`:8808 -> http://127.0.0.1:${subPathUp}`));
    expect(byName(fixed.checks, "serve-foreign")?.message).toEqual(expect.stringContaining(`:8809 -> http://127.0.0.1:${serviceUp}`));
    expect(after.TCP["8811"]).toEqual({ TCPForward: "127.0.0.1:5432" });

    expect(pidAlive(liveProc.pid)).toBe(true);
    expect(pidAlive(stranger.pid)).toBe(true);
    expect(groupAlive(recycled.pgid)).toBe(true);
    for (let attempt = 0; attempt < 40 && groupAlive(expiredProc.pgid); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(groupAlive(expiredProc.pgid)).toBe(false);
    expect(await service.store.readEnv("old--main--web")).toMatchObject({ status: "expired" });
    expect((await service.store.readEnv("old--main--web")).liveness).toBeUndefined();
    expect(await service.store.readEnv("killed--main--web")).toMatchObject({ status: "crashed", failure: { code: "E_SERVE_ORPHAN" } });
    expect(await readFile(path.join(manager.home, ".config", "systemd", "user", "nectard.service"), "utf8")).toContain(`NECTAR_HOME=${state}`);
    expect(byName(fixed.checks, "serve-orphans")).toMatchObject({ status: "pass", fixed: true });
    expect(byName(fixed.checks, "nectard")).toMatchObject({ status: "pass", fixed: true });
    expect(byName(fixed.checks, "env-resources")).toMatchObject({ status: "pass", fixed: true });
    expect(byName(fixed.checks, "serve-foreign")).toMatchObject({ status: "warn" });
    expect(fixed.healthy).toBe(true);

    const again = await service.doctor({ fix: true });
    expect(again.actions).toEqual([]);
    expect(await mutations()).toEqual(removed);
  });

  it("removes an entry that only becomes an orphan once release-env stops its process, in the same run", async () => {
    const state = await tempDir("doctor-freed-state");
    const fakeDir = await tempDir("doctor-freed-bin");
    await writeFile(
      path.join(state, "nectar.json"),
      JSON.stringify({ upstream_port_start: 4300, upstream_port_end: 4389, pack_server_port: 4395, tailnet_port_start: 8800, tailnet_port_end: 8899 }),
    );
    vi.stubEnv("NECTAR_HOME", state);
    vi.stubEnv("NECTAR_PACK_SERVER_ENTRY", await fakePackServer(fakeDir));
    vi.stubEnv("NECTAR_PORTLESS_BIN", path.join(fakeDir, "no-portless"));
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", path.join(fakeDir, "no-tailscaled.sock"));
    const service = new NectarService(state);
    await service.store.init();
    const reserved = new Set<number>();
    const port = async (): Promise<number> => {
      const chosen = await allocatePort({ start: 4300, end: 4389, reserved });
      reserved.add(chosen);
      return chosen;
    };
    const [heldUp, expiredUp] = [await port(), await port()];
    const held = listen(heldUp, { NECTAR_ENV: "helidex--main--web" });
    const expiring = listen(expiredUp, { NECTAR_ENV: "offshore--main--web" });
    await Promise.all([heldUp, expiredUp].map(waitListening));
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await service.store.writeEnv(
      record({
        name: "helidex--main--web",
        status: "crashed",
        published_at: past,
        last_touched_at: past,
        expires_at: future,
        serve: { cmd: "node s.mjs", ...held, upstream_port: heldUp, tailnet_port: 8852 },
        urls: { local: `http://127.0.0.1:${heldUp}`, mesh: "https://fixture.tailtest.ts.net:8852" },
      }),
    );
    await service.store.writeEnv(
      record({
        name: "offshore--main--web",
        published_at: past,
        last_touched_at: past,
        expires_at: past,
        serve: { cmd: "node s.mjs", ...expiring, upstream_port: expiredUp, tailnet_port: 8853 },
        urls: { local: `http://127.0.0.1:${expiredUp}`, mesh: "https://fixture.tailtest.ts.net:8853" },
      }),
    );
    const longAgo = new Date(Date.now() - 26 * 60 * 60_000).toISOString();
    await service.store.writeEnv(
      record({
        name: "frozen--main--web",
        status: "cold",
        published_at: longAgo,
        last_touched_at: longAgo,
        expires_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
        worktree: path.join(fakeDir, "frozen-worktree"),
        urls: { local: null, mesh: null },
      }),
    );
    const proxy = (target: string) => ({ Handlers: { "/": { Proxy: target } } });
    const tailscale = await statefulTailscale(fakeDir, {
      Web: {
        "fixture.tailtest.ts.net:8845": proxy(`http://127.0.0.1:${heldUp}`),
        "fixture.tailtest.ts.net:8846": proxy(`http://127.0.0.1:${expiredUp}`),
        "fixture.tailtest.ts.net:8852": proxy(`http://127.0.0.1:${heldUp}`),
        "fixture.tailtest.ts.net:8853": proxy(`http://127.0.0.1:${expiredUp}`),
      },
    });
    const offs = async (): Promise<string[]> => (await readFile(tailscale.log, "utf8")).split("\n").filter((line) => line.endsWith(" off"));
    const byName = (checks: unknown, name: string): DoctorCheck | undefined => (checks as DoctorCheck[]).find((check) => check.name === name);

    const planned = await service.doctor({ fix: true, dryRun: true, noDaemon: true });
    expect(byName(planned.checks, "serve-ambiguous")?.message).toContain(":8845");
    expect(byName(planned.checks, "serve-ambiguous")?.message).toContain(":8846");
    expect((planned.actions as DoctorAction[]).filter((action) => action.target === ":8845" || action.target === ":8846")).toEqual([]);

    const fixed = await service.doctor({ fix: true, noDaemon: true });
    const packPgid = (await service.store.readConfig()).pack_server_pgid;
    if (packPgid !== undefined) started.push(packPgid);
    const actions = fixed.actions as DoctorAction[];
    expect(actions.filter((action) => action.status !== "done")).toEqual([]);
    const order = actions.map((action) => `${action.action} ${action.target}`);
    expect(order.indexOf("remove-serve-entry :8845")).toBeGreaterThan(order.indexOf("release-env helidex--main--web"));
    expect(order.indexOf("remove-serve-entry :8846")).toBeLessThan(order.indexOf(`gc ${state}`));
    expect(order.indexOf("remove-serve-entry :8846")).toBeGreaterThan(-1);
    expect(actions.find((action) => action.target === ":8845")?.reason).toContain(`nothing listens on Nectar upstream ${heldUp}`);
    expect((await offs()).sort()).toEqual(["serve --https=8845 off", "serve --https=8846 off", "serve --https=8852 off", "serve --https=8853 off"]);
    for (let attempt = 0; attempt < 40 && (groupAlive(held.pgid) || groupAlive(expiring.pgid)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(groupAlive(held.pgid)).toBe(false);
    expect(groupAlive(expiring.pgid)).toBe(false);
    expect(byName(fixed.checks, "serve-ambiguous")).toMatchObject({ status: "pass" });
    expect(byName(fixed.checks, "serve-orphans")).toMatchObject({ status: "pass" });

    const helidex = await service.store.readEnv("helidex--main--web");
    expect(helidex).toMatchObject({ status: "crashed", urls: { mesh: null }, serve: { upstream_port: heldUp, tailnet_port: 8852 } });
    const offshore = await service.store.readEnv("offshore--main--web");
    expect(offshore).toMatchObject({ status: "expired", urls: { mesh: null }, serve: { upstream_port: expiredUp, tailnet_port: 8853 } });
    const listed = (await service.list()).envs as Array<{ name: string; mesh_url: string | null }>;
    expect(listed.map((env) => env.mesh_url)).toEqual([null, null, null]);
    expect(await service.store.readEnv("frozen--main--web")).toMatchObject({ status: "cold" });

    const again = await service.doctor({ fix: true, noDaemon: true });
    expect(again.actions).toEqual([]);
  });

  it("reports a foreign 443 entry as a warning and stays healthy", async () => {
    const state = await tempDir("doctor-443-state");
    const fakeDir = await tempDir("doctor-443-bin");
    await writeFile(path.join(state, "nectar.json"), JSON.stringify({ pack_server_port: 4396 }));
    vi.stubEnv("NECTAR_HOME", state);
    vi.stubEnv("NECTAR_PACK_SERVER_ENTRY", await fakePackServer(fakeDir));
    vi.stubEnv("NECTAR_PORTLESS_BIN", path.join(fakeDir, "no-portless"));
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", path.join(fakeDir, "no-tailscaled.sock"));
    const tailscale = await statefulTailscale(fakeDir, {
      TCP: { "443": { HTTPS: true } },
      Web: { "fixture.tailtest.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4321" } } } },
    });
    const service = new NectarService(state);
    const result = await service.doctor({ noDaemon: true });
    const check = (result.checks as DoctorCheck[]).find((item) => item.name === "serve-443");
    expect(check).toMatchObject({ status: "warn", details: [{ mount: "/", target: "http://127.0.0.1:4321" }] });
    expect(check?.message).toContain("left alone");
    expect(check?.hint).toContain("portless");
    expect((result.checks as DoctorCheck[]).filter((item) => item.status === "fail")).toEqual([]);
    expect(result.healthy).toBe(true);
    const fixed = await service.doctor({ fix: true, noDaemon: true });
    const packPgid = (await service.store.readConfig()).pack_server_pgid;
    if (packPgid !== undefined) started.push(packPgid);
    expect((await readFile(tailscale.log, "utf8")).split("\n")).not.toContain("serve --https=443 off");
    expect(JSON.parse(await readFile(tailscale.state, "utf8"))).toMatchObject({ Web: { "fixture.tailtest.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4321" } } } } });
    expect(fixed.healthy).toBe(true);
  });

  it("flags a unit that runs another node or CLI and leaves another home's unit alone", async () => {
    const state = await tempDir("doctor-unit-state");
    const fakeDir = await tempDir("doctor-unit-bin");
    vi.stubEnv("NECTAR_HOME", state);
    vi.stubEnv("NECTAR_TAILSCALE_BIN", "/bin/false");
    const manager = await fakeServiceManager(fakeDir);
    const service = new NectarService(state);
    const unit = path.join(manager.home, ".config", "systemd", "user", "nectard.service");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(unit), { recursive: true });
    const spec = { program: ["/old/node", "/old/dist/cli.js", "daemon", "run"], env: { NECTAR_HOME: state, PATH: "/usr/bin" }, stderrLog: "/tmp/x" };
    if (process.platform !== "linux") return;
    await writeFile(unit, systemdUnit(spec));
    const stale = await service.doctor({ fix: true, dryRun: true });
    expect((stale.checks as DoctorCheck[]).find((check) => check.name === "nectard")?.message).toContain("/old/node");
    expect((stale.actions as DoctorAction[]).map((action) => action.action)).toContain("reinstall-nectard");

    await writeFile(unit, systemdUnit({ ...spec, env: { NECTAR_HOME: "/elsewhere/.nectar" } }));
    const other = await service.doctor({ fix: true });
    expect((other.checks as DoctorCheck[]).find((check) => check.name === "nectard")?.message).toContain("/elsewhere/.nectar");
    expect((other.actions as DoctorAction[]).map((action) => action.action)).not.toContain("reinstall-nectard");
    expect(await readFile(unit, "utf8")).toContain("/elsewhere/.nectar");
    await expect(service.doctor({ dryRun: true })).rejects.toMatchObject({ code: "E_USAGE" });
  });
});

describe("doctor --no-daemon", () => {
  it("skips installing nectard, reports it as info, and --save keeps that until daemon install", async () => {
    const state = await tempDir("doctor-nodaemon-state");
    vi.stubEnv("NECTAR_HOME", state);
    vi.stubEnv("NECTAR_TAILSCALE_BIN", "/bin/false");
    const manager = await fakeServiceManager(await tempDir("doctor-nodaemon-bin"));
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const service = new NectarService(state);
    const actionsOf = (result: Record<string, unknown>): string[] => (result.actions as DoctorAction[]).map((action) => action.action);
    const nectardOf = (result: Record<string, unknown>): DoctorCheck | undefined => (result.checks as DoctorCheck[]).find((check) => check.name === "nectard");

    expect(actionsOf(await service.doctor({ fix: true, dryRun: true }))).toContain("install-nectard");
    const skipped = await service.doctor({ fix: true, noDaemon: true });
    expect(actionsOf(skipped)).not.toContain("install-nectard");
    expect(nectardOf(skipped)).toMatchObject({ status: "info" });
    expect(nectardOf(skipped)?.message).toContain("--no-daemon");
    await expect(readFile(path.join(manager.home, ".config", "systemd", "user", "nectard.service"), "utf8")).rejects.toThrow();

    await expect(service.doctor({ save: true })).rejects.toMatchObject({ code: "E_USAGE" });
    await service.doctor({ noDaemon: true, save: true });
    expect(await service.store.readConfig()).toMatchObject({ daemon: "disabled" });
    const remembered = await service.doctor({ fix: true, dryRun: true });
    expect(actionsOf(remembered)).not.toContain("install-nectard");
    expect(nectardOf(remembered)).toMatchObject({ status: "info" });
    expect(nectardOf(remembered)?.message).toContain('daemon: "disabled"');

    await service.enableDaemon();
    expect((await service.store.readConfig()).daemon).toBeUndefined();
    expect(actionsOf(await service.doctor({ fix: true, dryRun: true }))).toContain("install-nectard");
  });
});

describe("tailscale-serve doctor check", () => {
  const sockets: Server[] = [];
  afterEach(async () => {
    for (const server of sockets.splice(0)) await new Promise((resolve) => server.close(resolve));
  });

  async function fakeTailscaled(status: number, body: string, seen: string[]): Promise<string> {
    const socket = path.join(await tempDir("tsd"), "tailscaled.sock");
    const server = createServer((request, response) => {
      let received = "";
      request.on("data", (chunk: Buffer) => (received += chunk.toString()));
      request.on("end", () => {
        seen.push(`${request.method} ${request.url} ${received}`);
        response.writeHead(status, { "Content-Type": "text/plain" }).end(body);
      });
    });
    sockets.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return socket;
  }

  it("fails with the operator hint when tailscaled denies serve changes, and never changes the config", async () => {
    if (process.platform !== "linux") return;
    const state = await tempDir("doctor-serve-state");
    vi.stubEnv("NECTAR_HOME", state);
    await statefulTailscale(await tempDir("doctor-serve-bin"));
    const seen: string[] = [];
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", await fakeTailscaled(403, "serve config denied\n", seen));
    const service = new NectarService(state);
    const denied = await service.doctor();
    const check = (denied.checks as DoctorCheck[]).find((item) => item.name === "tailscale-serve");
    expect(check).toMatchObject({ status: "fail", hint: expect.stringContaining("sudo tailscale set --operator=$USER") as unknown });
    expect(check?.message).toContain("serve config denied");
    expect(denied.healthy).toBe(false);
    expect(seen).toEqual(["POST /localapi/v0/serve-config not json"]);

    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", await fakeTailscaled(400, "decoding config: invalid character\n", seen));
    const allowed = await service.doctor();
    expect((allowed.checks as DoctorCheck[]).find((item) => item.name === "tailscale-serve")).toMatchObject({ status: "pass" });
  });
});

describe("republish next to a foreign serve entry", () => {
  it("leaves a foreign entry on its old tailnet port alone and moves to a fresh port", async () => {
    const state = await tempDir("foreign-state");
    vi.stubEnv("NECTAR_HOME", state);
    vi.stubEnv("NECTAR_STATIC_SERVER_ENTRY", fileURLToPath(new URL("../src/static-server.ts", import.meta.url)));
    const tailscale = await statefulTailscale(await tempDir("foreign-bin"));
    const site = await tempDir("foreign-site");
    await writeFile(path.join(site, "index.html"), "<h1>one</h1>\n");
    const service = new NectarService(state);
    const first = await service.publish({ repo: site, name: "foreign", ttl: "1h" });
    const env = first.env as string;
    try {
      const oldPort = (await service.store.readEnv(env)).serve?.tailnet_port;
      const table = JSON.parse(await readFile(tailscale.state, "utf8")) as { Web: Record<string, { Handlers: Record<string, { Proxy: string }> }> };
      table.Web[`fixture.tailtest.ts.net:${oldPort}`] = { Handlers: { "/": { Proxy: "https://someone-else.example" } } };
      await writeFile(tailscale.state, JSON.stringify(table));

      await writeFile(path.join(site, "index.html"), "<h1>two</h1>\n");
      const second = await service.publish({ repo: site, name: "foreign", ttl: "1h" });
      const newPort = (await service.store.readEnv(env)).serve?.tailnet_port;
      expect(newPort).not.toBe(oldPort);
      expect((second.urls as { mesh: string }).mesh).toBe(`https://fixture.tailtest.ts.net:${newPort}`);
      expect((second.warnings as string[]).join("\n")).toContain(`:${oldPort} now holds an entry Nectar did not create`);
      const after = JSON.parse(await readFile(tailscale.state, "utf8")) as typeof table;
      expect(after.Web[`fixture.tailtest.ts.net:${oldPort}`]).toEqual({ Handlers: { "/": { Proxy: "https://someone-else.example" } } });
      expect((await readFile(tailscale.log, "utf8")).split("\n")).not.toContain(`serve --https=${oldPort} off`);
    } finally {
      await service.remove(env, true);
    }
  });
});
