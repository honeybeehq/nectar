import path from "node:path";
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
    const packServer = path.join(fakeDir, "pack-server.mjs");
    await writeFile(packServer, `import http from "node:http"; http.createServer((_q, r) => { r.writeHead(404); r.end(); }).listen(Number(process.argv[3]), "127.0.0.1");`);
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
