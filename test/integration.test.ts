import path from "node:path";
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pidAlive, runCommand, stopProcessGroup } from "../src/commands.js";
import { NectarService } from "../src/service.js";
import { extractTestpack } from "../src/testpack.js";
import { fakeExecutable, fakeTailscale, initGitRepo, record, tempDir } from "./helpers.js";

const services: Array<{ service: NectarService; envs: string[] }> = [];

afterEach(async () => {
  for (const item of services.splice(0)) {
    for (const env of item.envs) await item.service.stop(env).catch(() => undefined);
    const config = await item.service.store.readConfig().catch(() => undefined);
    if (config?.pack_server_pgid !== undefined) await stopProcessGroup(config.pack_server_pgid).catch(() => undefined);
  }
  vi.unstubAllEnvs();
});

async function harness(): Promise<{
  service: NectarService;
  state: string;
  fakeDir: string;
  tailscaleLog: string;
  launchLog: string;
}> {
  const state = await tempDir("integration-state");
  const fakeDir = await tempDir("integration-bin");
  const tailscale = await fakeTailscale(fakeDir);
  const launchLog = path.join(fakeDir, "launch.log");
  const launcher = await fakeExecutable(fakeDir, "launch", `printf '%s\\n' "$*" >> "$FAKE_LAUNCH_LOG"`);
  const trash = await fakeExecutable(fakeDir, "trash", `for target in "$@"; do mv "$target" "$target.trash.$$"; done`);
  const packServer = path.join(fakeDir, "pack-server.mjs");
  await writeFile(
    packServer,
    `import http from "node:http"; http.createServer((_q, r) => { r.writeHead(404); r.end(); }).listen(Number(process.argv[3]), "127.0.0.1");`,
  );
  // Own port ranges: the machine's real nectar (pack server on 4099, envs on
  // 41xx, tailnet 8443+) and the ios suite (43xx/87xx) must never contend with
  // this suite's allocations.
  await writeFile(
    path.join(state, "nectar.json"),
    JSON.stringify({
      upstream_port_start: 4500,
      upstream_port_end: 4599,
      pack_server_port: 4499,
      tailnet_port_start: 8600,
      tailnet_port_end: 8699,
    }),
  );
  vi.stubEnv("NECTAR_HOME", state);
  vi.stubEnv("NECTAR_TAILSCALE_BIN", tailscale.binary);
  vi.stubEnv("FAKE_TS_LOG", tailscale.log);
  vi.stubEnv("NECTAR_LAUNCH_BIN", launcher);
  vi.stubEnv("FAKE_LAUNCH_LOG", launchLog);
  vi.stubEnv("NECTAR_TRASH_BIN", trash);
  vi.stubEnv("NECTAR_PACK_SERVER_ENTRY", packServer);
  vi.stubEnv("NECTAR_AX_PID_TIMEOUT_MS", "100");
  const service = new NectarService(state);
  services.push({ service, envs: [] });
  return { service, state, fakeDir, tailscaleLog: tailscale.log, launchLog };
}

function track(service: NectarService, ...envs: string[]): void {
  const found = services.find((item) => item.service === service);
  found?.envs.push(...envs);
}

const server = `
import http from "node:http";
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(process.env.VALHALL_HEM_TOKEN ?? "scrubbed");
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => console.log("fixture ready"));
`;

describe("fixture-backed web publish", () => {
  it("publishes, preserves its URL on republish, scrubs secrets, and reports a killed serve", async () => {
    const { service, tailscaleLog } = await harness();
    const repo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-web", scripts: { dev: "node server.mjs" } }),
      "server.mjs": server,
    });
    vi.stubEnv("VALHALL_HEM_TOKEN", "must-not-leak");

    const first = await service.publish({ repo, ttl: "1h" });
    const env = first.env as string;
    track(service, env);
    expect(env).toBe("fixture-web--main--web");
    expect(first.packet_fields).toEqual({
      preview_url: "https://fixture.tailtest.ts.net:8600",
      testpack_ref: null,
      shell_recipe: null,
      public_url: null,
    });
    expect(first.warnings).toEqual([expect.stringContaining("portless")]);
    const localUrl = (first.urls as { local: string }).local;
    expect(await fetch(localUrl).then(async (response) => response.text())).toBe("scrubbed");

    const second = await service.publish({ repo, ttl: "1h" });
    expect(second.env).toBe(env);
    expect((second.urls as { mesh: string }).mesh).toBe((first.urls as { mesh: string }).mesh);
    const serveCommands = await readFile(tailscaleLog, "utf8");
    expect(serveCommands).toContain("--https=8600");
    expect(serveCommands).not.toMatch(/--https=443(?:\s|$)/);
    expect(serveCommands).not.toContain("funnel");

    expect((await runCommand("git", ["branch", "agent/second"], { cwd: repo })).exitCode).toBe(0);
    const otherBranch = await service.publish({ repo, branch: "agent/second", ttl: "1h" });
    track(service, otherBranch.env as string);
    expect(otherBranch.env).toBe("fixture-web--agent-second--web");
    expect((otherBranch.urls as { mesh: string }).mesh).toBe("https://fixture.tailtest.ts.net:8601");
    expect(((await service.list()).envs as Array<{ status: string }>).filter((item) => item.status === "serving")).toHaveLength(2);

    const record = (await service.show(env)).env as { serve: { pgid: number } };
    process.kill(-record.serve.pgid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const listed = (await service.list()).envs as Array<{ name: string; status: string }>;
    expect(listed.find((item) => item.name === env)?.status).toBe("crashed");
    expect(await service.show(env)).toHaveProperty("log_tail");
  });

  it("implements F2 local-only fallback when Tailscale is down", async () => {
    const { service } = await harness();
    vi.stubEnv("FAKE_TS_DOWN", "1");
    const repo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-offline", scripts: { dev: "node server.mjs" } }),
      "server.mjs": server,
    });
    const result = await service.publish({ repo, ttl: "1h" });
    track(service, result.env as string);
    expect((result.urls as { mesh: string | null }).mesh).toBeNull();
    expect((result.packet_fields as { preview_url: string }).preview_url).toMatch(/^http:\/\/127\.0\.0\.1:45\d\d$/);
    expect(result.warnings).toEqual([expect.stringContaining("portless"), expect.stringContaining("tailscale unavailable")]);
  });

  it("rolls back the process, Serve entry, port claims, and runtime record after E_SERVE_TIMEOUT", async () => {
    const { service, tailscaleLog } = await harness();
    const repo = await initGitRepo({
      "nectar.toml": `name="fixture-broken"\n[web]\nserve="node broken.mjs"\nready_timeout="250ms"\n`,
      "broken.mjs": `console.log("never ready", process.pid); setInterval(() => {}, 1000);\n`,
    });
    let publishError: unknown;
    try {
      await service.publish({ repo });
    } catch (error) {
      publishError = error;
    }
    const failure = publishError as { code?: string; details?: { log_tail?: string[] } };
    const processLine = failure.details?.log_tail?.find((item) => item.startsWith("never ready "));
    const processId = Number(processLine?.split(" ").at(-1));
    expect(failure.code).toBe("E_SERVE_TIMEOUT");
    expect(processId).toBeGreaterThan(1);
    const env = "fixture-broken--main--web";
    track(service, env);
    const failed = (await service.show(env)).env as {
      status: string;
      serve?: unknown;
      urls: { local: string | null; mesh: string | null };
      failure: { code: string; log_tail: string[] };
    };
    expect(failed).toMatchObject({
      status: "crashed",
      urls: { local: null, mesh: null },
      failure: { code: "E_SERVE_TIMEOUT", log_tail: [expect.stringContaining("never ready")] },
    });
    expect(failed.serve).toBeUndefined();
    expect(pidAlive(processId)).toBe(false);
    expect(await readFile(tailscaleLog, "utf8")).toContain("serve --https=8600 off");

    const recoveryRepo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-recovery", scripts: { dev: "node server.mjs" } }),
      "server.mjs": server,
    });
    const recovered = await service.publish({ repo: recoveryRepo });
    track(service, recovered.env as string);
    const recoveredRecord = (await service.show(recovered.env as string)).env as {
      serve: { upstream_port: number; tailnet_port: number };
    };
    expect(recoveredRecord.serve).toMatchObject({ upstream_port: 4500, tailnet_port: 8600 });
  });

  it("accepts an IPv6-loopback server and routes Tailscale Serve to the healthy address", async () => {
    const { service, tailscaleLog } = await harness();
    const repo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-ipv6", scripts: { dev: "node server.mjs" } }),
      "server.mjs": server.replace('"127.0.0.1"', '"::1"'),
    });
    const result = await service.publish({ repo });
    track(service, result.env as string);
    const local = (result.urls as { local: string }).local;
    expect(local).toMatch(/^http:\/\/\[::1\]:45\d\d$/);
    expect(await fetch(local).then(async (response) => response.text())).toBe("scrubbed");
    expect(await readFile(tailscaleLog, "utf8")).toContain(`--https=8600 ${local}`);
  });
});

describe("fixture-backed desktop testpacks", () => {
  it("publishes two records for embed mode, verifies/caches/launches, and retries F8 corruption", async () => {
    const { service, state, launchLog } = await harness();
    const repo = await initGitRepo({
      "nectar.toml": `
name = "fixture-desktop"
[web]
serve = "node server.mjs"
ready_timeout = "5s"
[desktop]
pack = "node pack.mjs"
kind = "electron"
embed_url = "web"
`,
      "server.mjs": server,
      "pack.mjs": `
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const root = process.env.NECTAR_PACK_OUT;
await mkdir(path.join(root, "app", "Fixture.app"), { recursive: true });
await writeFile(path.join(root, "testpack.json"), JSON.stringify({ testpack: 1, entry: "app/Fixture.app" }));
`,
    });
    const result = await service.publish({ repo, mode: "desktop", ttl: "1h" });
    const desktopEnv = "fixture-desktop--main--desktop";
    const webEnv = "fixture-desktop--main--web";
    track(service, desktopEnv, webEnv);
    expect(result.env).toBe(desktopEnv);
    expect(result.web_env).toBe(webEnv);
    expect(result.packet_fields).toEqual({
      preview_url: "https://fixture.tailtest.ts.net:8600",
      testpack_ref: `nectar://fixture/${desktopEnv}`,
      shell_recipe: null,
      public_url: null,
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

    const all = await service.resolve("fixture-desktop--main");
    expect("resolutions" in all && all.resolutions.map((item) => item.mode).sort()).toEqual(["desktop", "web"]);
    const desktop = (await service.show(desktopEnv)).env as {
      testpack: { file: string; sha256: string };
    };
    const sourceZip = path.join(state, "packs", desktopEnv, desktop.testpack.file);
    const extracted = await extractTestpack(sourceZip, await tempDir("manifest"));
    const manifest = JSON.parse(await readFile(path.join(extracted, "testpack.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty("sha256");
    expect(manifest).toMatchObject({
      testpack: 1,
      app: "fixture-desktop",
      branch: "main",
      platform: "darwin-arm64",
      kind: "electron",
      embed: { mode: "webview", url: "https://fixture.tailtest.ts.net:8600" },
    });

    const firstOpen = await service.open(result.ref as string);
    expect(firstOpen).toMatchObject({ env: desktopEnv, cache_hit: false, sha256: result.sha256 });
    const secondOpen = await service.open(result.ref as string);
    expect(secondOpen).toMatchObject({ cache_hit: true });
    expect((await readFile(launchLog, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);

    const servedZip = await readFile(sourceZip);
    const packServer = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/zip", "content-length": servedZip.length });
      response.end(servedZip);
    });
    await new Promise<void>((resolve) => packServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = packServer.address();
      if (address === null || typeof address === "string") throw new Error("missing pack test server address");
      const remoteResult = {
        env: desktopEnv,
        mode: "desktop",
        urls: { local: null, mesh: null },
        testpack_url: `http://127.0.0.1:${address.port}/pack.testpack.zip`,
        sha256: desktop.testpack.sha256,
        size_bytes: servedZip.length,
        platform: "darwin-arm64",
        entry: "app/Fixture.app",
        host: "remote",
        status: "serving",
      };
      vi.stubEnv("FAKE_TS_SSH_RESPONSE", JSON.stringify({ ok: true, command: "resolve", result: remoteResult }));
      const consumer = new NectarService(await tempDir("remote-consumer"));
      services.push({ service: consumer, envs: [] });
      expect(await consumer.open(`nectar://remote/${desktopEnv}`)).toMatchObject({ cache_hit: false, sha256: desktop.testpack.sha256 });
      expect(await consumer.open(`nectar://remote/${desktopEnv}`)).toMatchObject({ cache_hit: true });
    } finally {
      await new Promise<void>((resolve) => packServer.close(() => resolve()));
      vi.stubEnv("FAKE_TS_SSH_RESPONSE", "");
    }

    const cacheZip = path.join(state, "packs", ".cache", `${desktop.testpack.sha256}.testpack.zip`);
    await writeFile(cacheZip, "corrupt-cache");
    expect(await service.open(result.ref as string)).toMatchObject({ cache_hit: false });

    await writeFile(cacheZip, "corrupt-cache-again");
    await writeFile(sourceZip, "corrupt-source");
    await expect(service.open(result.ref as string)).rejects.toThrow(/sha256 mismatch after one retry/);
  });
});

describe("lifecycle, doctor, and cross-machine command adapters", () => {
  it("marks same-node resolves and opens their local URL while packet fields remain mesh-canonical", async () => {
    const { service, launchLog } = await harness();
    const repo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-self", scripts: { dev: "node server.mjs" } }),
      "server.mjs": server,
    });
    const published = await service.publish({ repo });
    const env = published.env as string;
    track(service, env);
    expect(published.packet_fields).toMatchObject({ preview_url: "https://fixture.tailtest.ts.net:8600" });

    const byFqdn = await service.resolve(`nectar://FIXTURE.TAILTEST.TS.NET/${env}`);
    expect(byFqdn).toMatchObject({ env, host: "fixture.tailtest.ts.net", is_self: true });
    const byShortName = await service.resolve(`nectar://FiXtUrE/${env}`);
    expect(byShortName).toMatchObject({ env, host: "fixture", is_self: true });
    const byBase = await service.resolve("fixture-self--main");
    expect(byBase).toMatchObject({ env: "fixture-self--main", is_self: true });
    expect("resolutions" in byBase && byBase.resolutions.every((item) => item.is_self)).toBe(true);

    const opened = await service.open(`nectar://fixture/${env}`);
    expect(opened.opened).toBe((published.urls as { local: string }).local);
    expect((await readFile(launchLog, "utf8")).trim()).toBe((published.urls as { local: string }).local);
  });

  it("expires, revives on the same URL, stops, cools, and trashes an env", async () => {
    const { service } = await harness();
    const repo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-life", scripts: { dev: "node server.mjs" } }),
      "server.mjs": server,
    });
    const published = await service.publish({ repo, ttl: "1m" });
    const env = published.env as string;
    track(service, env);
    const initialUrl = (published.urls as { mesh: string }).mesh;
    const record = await service.store.readEnv(env);
    record.published_at = new Date(Date.now() - 2 * 60_000).toISOString();
    record.last_touched_at = record.published_at;
    record.expires_at = new Date(Date.now() - 60_000).toISOString();
    await service.store.writeEnv(record);
    expect((await service.gc()).transitions).toEqual([{ env, action: "expire" }]);
    const expired = await service.store.readEnv(env);
    expect(expired.status).toBe("expired");
    expect(await import("node:fs/promises").then(({ stat }) => stat(expired.worktree))).toBeTruthy();

    const revived = await service.publish({ repo, ttl: "1h" });
    expect((revived.urls as { mesh: string }).mesh).toBe(initialUrl);
    expect(await service.touch(env, "2h")).toMatchObject({ envs: [env] });
    expect(await service.stop(env)).toEqual({ env, status: "stopped" });

    const cold = await service.store.readEnv(env);
    cold.published_at = new Date(Date.now() - 26 * 60 * 60_000).toISOString();
    cold.last_touched_at = cold.published_at;
    cold.expires_at = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    await service.store.writeEnv(cold);
    expect((await service.gc()).transitions).toEqual([{ env, action: "cold" }]);
    await expect(import("node:fs/promises").then(({ stat }) => stat(cold.worktree))).rejects.toMatchObject({ code: "ENOENT" });

    expect(await service.remove(env)).toMatchObject({ env, removed: true });
    await expect(service.store.readEnv(env)).rejects.toMatchObject({ code: "E_NOT_FOUND" });
  });

  it("gc skips a busy env instead of aborting, and implicit touches keep the publish TTL", async () => {
    const { service } = await harness();
    const repo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-busy", scripts: { dev: "node server.mjs" } }),
      "server.mjs": server,
    });
    const published = await service.publish({ repo, ttl: "1m" });
    const env = published.env as string;
    track(service, env);

    // A desk resolve touches the env but re-arms its own 1 m TTL — not 72 h.
    await service.resolve(env);
    const touched = await service.store.readEnv(env);
    expect(new Date(touched.expires_at).getTime() - Date.now()).toBeLessThan(10 * 60_000);

    const record = await service.store.readEnv(env);
    record.published_at = new Date(Date.now() - 2 * 60_000).toISOString();
    record.last_touched_at = record.published_at;
    record.expires_at = new Date(Date.now() - 60_000).toISOString();
    await service.store.writeEnv(record);

    // Hold the env lock as a concurrent publish would: the hourly gc must report
    // a skip and finish, not abort the sweep with E_BUSY.
    let release: (() => void) | undefined;
    const held = service.store.withLock(env, async () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const swept = await service.gc();
    expect(swept.transitions).toEqual([]);
    expect(swept.skipped).toEqual([{ env, reason: "busy" }]);
    release?.();
    await held;

    const rerun = await service.gc();
    expect(rerun.transitions).toEqual([{ env, action: "expire" }]);
  });

  it("doctor fixes only 8440 and flags a planted 443 conflict", async () => {
    const { service, tailscaleLog } = await harness();
    const fixed = await service.doctor({ fix: true });
    expect(fixed.healthy).toBe(true);
    expect(fixed.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: "pack-store-8440", status: "pass", fixed: true })]));
    // Doctor persists the port it actually started the pack server on (the configured
    // one when free, otherwise allocated) — assert against that, not a constant.
    const config = await service.store.readConfig();
    const log = await readFile(tailscaleLog, "utf8");
    expect(log).toContain(`serve --bg --yes --https=8440 http://127.0.0.1:${config.pack_server_port}`);
    expect(log).not.toContain("--https=443");
    expect(log).not.toContain("funnel");

    vi.stubEnv(
      "FAKE_TS_SERVE_STATUS",
      JSON.stringify({ AllowFunnel: { "8440": true }, Web: { "fixture:443": {}, "fixture:8440": {} } }),
    );
    const conflicted = await service.doctor();
    expect(conflicted.healthy).toBe(false);
    const checks = conflicted.checks as Array<{ name: string; status: string; message: string }>;
    expect(checks.find((check) => check.name === "serve-443")).toMatchObject({ name: "serve-443", status: "fail" });
    expect(checks.find((check) => check.name === "serve-443")?.message).toContain("portless");
    expect(checks.find((check) => check.name === "funnel")).toMatchObject({ name: "funnel", status: "fail" });
  });

  it.each(["service", "legacy"] as const)("recognizes a healthy %s Portless proxy", async (mode) => {
    const { service, fakeDir } = await harness();
    const portlessLog = path.join(fakeDir, "portless.log");
    const portless = await fakeExecutable(
      fakeDir,
      "portless",
      `
printf '%s\\n' "$*" >> "$FAKE_PORTLESS_LOG"
if [ "$1" = "--version" ]; then
  printf '0.15.4\\n'
  exit 0
fi
if [ "$1" = "service" ] && [ "$2" = "status" ]; then
  if [ "$FAKE_PORTLESS_MODE" = "service" ]; then
    printf 'portless service\\n  Manager state: running\\n  Proxy on 443: responding\\n'
    exit 0
  fi
  exit 1
fi
if [ "$1" = "status" ] && [ "$2" = "--json" ] && [ "$FAKE_PORTLESS_MODE" = "legacy" ]; then
  printf '{"running":true}\\n'
  exit 0
fi
exit 1
`,
    );
    vi.stubEnv("NECTAR_PORTLESS_BIN", portless);
    vi.stubEnv("FAKE_PORTLESS_LOG", portlessLog);
    vi.stubEnv("FAKE_PORTLESS_MODE", mode);

    const diagnosed = await service.doctor();
    const checks = diagnosed.checks as Array<{ name: string; status: string; message: string }>;
    const portlessCheck = checks.find((check) => check.name === "portless");
    expect(portlessCheck).toMatchObject({ name: "portless", status: "pass" });
    expect(portlessCheck?.message).toContain("proxy are up");
    const commands = await readFile(portlessLog, "utf8");
    expect(commands).toContain("--version");
    expect(commands).toContain("service status");
    expect(commands.includes("status --json")).toBe(mode === "legacy");
  });

  it("reports dead loopback Serve entries and cleans them through doctor --fix and gc", async () => {
    const { service, tailscaleLog } = await harness();
    vi.stubEnv(
      "FAKE_TS_SERVE_STATUS",
      JSON.stringify({
        Web: {
          "fixture.tailtest.ts.net:8601": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:4598" } },
          },
        },
      }),
    );
    const diagnosed = await service.doctor();
    expect(diagnosed.healthy).toBe(false);
    const diagnosedChecks = diagnosed.checks as Array<{ name: string; status: string; message: string }>;
    const orphanCheck = diagnosedChecks.find((check) => check.name === "serve-orphans");
    expect(orphanCheck).toMatchObject({ name: "serve-orphans", status: "fail" });
    expect(orphanCheck?.message).toContain(":8601 -> http://127.0.0.1:4598");

    const fixed = await service.doctor({ fix: true });
    expect(fixed.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "serve-orphans", status: "pass", fixed: true })]),
    );
    expect(await readFile(tailscaleLog, "utf8")).toContain("serve --https=8601 off");

    const orphanEnv = record({
      name: "fixture-orphan--main--web",
      serve: {
        cmd: "node dead.mjs",
        pid: 999_999,
        pgid: 999_999,
        upstream_port: 4597,
        tailnet_port: 8602,
      },
      urls: { local: "http://127.0.0.1:4597", mesh: "https://fixture.tailtest.ts.net:8602" },
    });
    await service.store.writeEnv(orphanEnv);
    vi.stubEnv(
      "FAKE_TS_SERVE_STATUS",
      JSON.stringify({
        Web: {
          "fixture.tailtest.ts.net:8602": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:4597" } },
          },
        },
      }),
    );
    expect(await service.gc()).toMatchObject({
      serve_orphans: [
        {
          tailnet_port: 8602,
          target: "http://127.0.0.1:4597",
          env: orphanEnv.name,
          fixed: true,
        },
      ],
    });
    const cleaned = await service.store.readEnv(orphanEnv.name);
    expect(cleaned).toMatchObject({
      status: "crashed",
      urls: { local: null, mesh: null },
      failure: { code: "E_SERVE_ORPHAN" },
    });
    expect(cleaned.failure?.message).toContain(":8602");
    expect(cleaned.serve).toBeUndefined();
    expect(await readFile(tailscaleLog, "utf8")).toContain("serve --https=8602 off");
  });

  it("resolves a mode-qualified remote ref through tailscale ssh and reports F9", async () => {
    const { service } = await harness();
    const remote = {
      env: "remote-app--main--web",
      mode: "web",
      urls: { local: "http://127.0.0.1:4100", mesh: "https://remote.tailtest.ts.net:8443" },
      testpack_url: null,
      sha256: null,
      size_bytes: null,
      platform: null,
      entry: null,
      host: "remote",
      status: "serving",
      is_self: true,
    };
    vi.stubEnv("FAKE_TS_SSH_RESPONSE", JSON.stringify({ ok: true, command: "resolve", result: remote }));
    expect(await service.resolve("nectar://remote/remote-app--main--web")).toEqual({ ...remote, is_self: false });
    vi.stubEnv("FAKE_TS_SSH_RESPONSE", "");
    vi.stubEnv("FAKE_TS_SSH_FAIL", "1");
    await expect(service.resolve("nectar://offline/remote-app--main--web")).rejects.toThrow(/Host 'offline' unreachable/);
  });
});
