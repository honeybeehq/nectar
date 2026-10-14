import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  vi.stubEnv("NECTAR_STATIC_SERVER_ENTRY", fileURLToPath(new URL("../src/static-server.ts", import.meta.url)));
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
      dev_ref: null,
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

describe("static sites", () => {
  async function siteDir(files: Record<string, string>): Promise<string> {
    const dir = path.join(await tempDir("static-src"), "proto");
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), contents);
    }
    return dir;
  }

  it("publishes a plain directory idempotently from a Nectar-owned copy that outlives the source", async () => {
    const { service, state, tailscaleLog } = await harness();
    const source = await siteDir({
      "index.html": `<link rel="stylesheet" href="style.css"><script src="app.js"></script><h1>proto</h1>`,
      "style.css": "h1{color:red}",
      "app.js": "console.log('proto')",
    });

    const first = await service.publish({ repo: source, ttl: "1h" });
    const env = first.env as string;
    track(service, env);
    expect(first).toMatchObject({
      env: "proto--static--web",
      mode: "web",
      branch: "static",
      source,
      packet_fields: { preview_url: "https://fixture.tailtest.ts.net:8600", testpack_ref: null },
    });
    expect(first.commit).toMatch(/^[0-9a-f]{8}$/);
    const local = (first.urls as { local: string }).local;
    const css = await fetch(`${local}/style.css`);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("h1{color:red}");
    expect(await readFile(tailscaleLog, "utf8")).toContain(`--https=8600 ${local}`);
    const stored = await service.store.readEnv(env);
    expect(stored.worktree).toBe(path.join(state, "work", env));
    expect(stored.serve?.cmd).toContain("static-server");

    const again = await service.publish({ repo: source, ttl: "1h" });
    expect(again).toMatchObject({ env, commit: first.commit, urls: first.urls });

    await rm(source, { recursive: true, force: true });
    expect(await fetch(local).then(async (response) => response.text())).toContain("<h1>proto</h1>");
    expect(((await service.list()).envs as Array<{ name: string; status: string }>).find((item) => item.name === env)?.status).toBe(
      "serving",
    );
  });

  it("detects static sites only where no recipe applies, and honours --mode static, --name, and single files", async () => {
    const { service } = await harness();
    const repo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-dist" }),
      "dist/index.html": "<h1>built</h1>",
    });
    const built = await service.publish({ repo, ttl: "1h" });
    track(service, built.env as string);
    expect(built.env).toBe(`${path.basename(repo).toLowerCase()}--main--web`);
    expect(await fetch((built.urls as { local: string }).local).then(async (response) => response.text())).toBe("<h1>built</h1>");

    const app = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-app", scripts: { dev: "node server.mjs" } }),
      "server.mjs": server,
      "index.html": "<h1>vite entry</h1>",
    });
    const web = await service.publish({ repo: app, ttl: "1h" });
    track(service, web.env as string);
    expect(web).toMatchObject({ env: "fixture-app--main--web" });
    expect(web.source).toBeUndefined();
    const forced = await service.publish({ repo: app, mode: "static", name: "App Shell", ttl: "1h" });
    track(service, forced.env as string);
    expect(forced.env).toBe("app-shell--main--web");
    expect(await fetch((forced.urls as { local: string }).local).then(async (response) => response.text())).toBe("<h1>vite entry</h1>");

    const single = path.join(await tempDir("static-single"), "Coupons Report.html");
    await writeFile(single, "<h1>coupons</h1>");
    const file = await service.publish({ repo: single, ttl: "1h" });
    track(service, file.env as string);
    expect(file.env).toBe("coupons-report--static--web");
    expect(await fetch((file.urls as { local: string }).local).then(async (response) => response.text())).toBe("<h1>coupons</h1>");

    const empty = await tempDir("static-empty");
    await expect(service.publish({ repo: empty, mode: "static" })).rejects.toMatchObject({ code: "E_NO_RECIPE" });
    await expect(service.publish({ repo: app, name: "x" })).rejects.toMatchObject({ code: "E_USAGE" });
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
      dev_ref: null,
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

describe("fixture-backed crystallized dev environments", () => {
  const devToml = (name: string): string => `
name = "${name}"
[dev]
run = "node dev.mjs"
kind = "electron"
warm = "node warm.mjs"
ready_timeout = "5s"
`;
  const devProcess = `
import path from "node:path";
import { writeFile } from "node:fs/promises";
await writeFile(path.join(process.env.NECTAR_ENV_DIR, "ready"), "ready\\n");
await writeFile(path.join(process.env.NECTAR_ENV_DIR, "boot-target.txt"), process.env.NECTAR_OPEN_TARGET ?? "");
console.log("dev ready", process.pid);
setInterval(() => {}, 1000);
`;
  const warmProcess = `
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir(path.join(process.env.NECTAR_ENV_DIR, ".vite"), { recursive: true });
await mkdir(path.join(process.env.NECTAR_ENV_DIR, "out"), { recursive: true });
await writeFile(path.join(process.env.NECTAR_ENV_DIR, ".vite", "warmed.txt"), "warm\\n");
await writeFile(path.join(process.env.NECTAR_ENV_DIR, "out", "native.txt"), "native\\n");
`;

  it("publishes warm, verifies without leaking a process, reports staleness, opens with target/keep, and stops warm", async () => {
    const { service } = await harness();
    const repo = await initGitRepo({
      "nectar.toml": devToml("fixture-dev"),
      "dev.mjs": devProcess,
      "warm.mjs": warmProcess,
    });
    const published = await service.publish({ repo, mode: "dev", ttl: "1h", verify: true });
    const env = "fixture-dev--main--dev";
    track(service, env);
    expect(published).toMatchObject({
      env,
      mode: "dev",
      status: "warm",
      verified: true,
      packet_fields: {
        preview_url: null,
        testpack_ref: null,
        dev_ref: `nectar://fixture/${env}`,
        shell_recipe: null,
        public_url: null,
      },
    });
    const warm = await service.store.readEnv(env);
    expect(warm).toMatchObject({
      status: "warm",
      borrowed_worktree: false,
      dev: { run: "node dev.mjs", kind: "electron", ready_timeout_ms: 5_000 },
    });
    expect(warm.dev?.warm_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(warm.serve).toBeUndefined();

    const fresh = await service.resolve(env);
    expect(fresh).toMatchObject({
      env,
      mode: "dev",
      status: "warm",
      commit: warm.commit,
      current_commit: warm.commit,
      stale: false,
    });
    expect((await service.store.readEnv(env)).serve).toBeUndefined();

    await writeFile(path.join(warm.worktree, "branch-change.txt"), "new commit\n");
    expect((await runCommand("git", ["add", "branch-change.txt"], { cwd: warm.worktree })).exitCode).toBe(0);
    expect((await runCommand("git", ["commit", "-m", "advance crystallized checkout"], { cwd: warm.worktree })).exitCode).toBe(0);
    const stale = await service.resolve(env);
    expect(stale).toMatchObject({ commit: warm.commit, stale: true });
    expect("resolutions" in stale ? null : stale.current_commit).not.toBe(warm.commit);

    await writeFile(path.join(warm.worktree, ".vite", "kept.txt"), "vite cache\n");
    await writeFile(path.join(warm.worktree, "out", "kept.txt"), "native cache\n");
    const republished = await service.publish({ repo, mode: "dev", ttl: "1h" });
    expect(republished).toMatchObject({ env, status: "warm", verified: false });
    expect(await readFile(path.join(warm.worktree, ".vite", "kept.txt"), "utf8")).toBe("vite cache\n");
    expect(await readFile(path.join(warm.worktree, "out", "kept.txt"), "utf8")).toBe("native cache\n");

    const opened = await service.open(republished.ref as string, { target: "review:settings", keep: true });
    expect(opened).toMatchObject({
      env,
      mode: "dev",
      status: "serving",
      launched: true,
      target: "review:settings",
      pinned: true,
    });
    const running = await service.store.readEnv(env);
    expect(running.serve?.cmd).toBe("node dev.mjs");
    expect(running.serve?.pid).toBeTypeOf("number");
    expect(running.serve?.pgid).toBeTypeOf("number");
    expect(running.serve).not.toHaveProperty("upstream_port");
    expect(running.serve).not.toHaveProperty("tailnet_port");
    const targetMessage = JSON.parse(
      await readFile(path.join(running.worktree, "open-target.json"), "utf8"),
    ) as { target: string; opened_at: string; nonce: string };
    expect(targetMessage).toMatchObject({
      target: "review:settings",
      opened_at: running.last_opened_at,
    });
    expect(targetMessage.nonce).toBeTypeOf("string");
    expect(await readFile(path.join(running.worktree, "boot-target.txt"), "utf8")).toBe("review:settings");

    const firstOpenedAt = running.last_opened_at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const focused = await service.open(env, { target: "review:editor" });
    expect(focused).toMatchObject({
      launched: false,
      handle: { pid: running.serve?.pid, pgid: running.serve?.pgid },
      target: "review:editor",
    });
    const focusedRecord = await service.store.readEnv(env);
    expect(focusedRecord.last_opened_at).not.toBe(firstOpenedAt);
    const openClock = focusedRecord.last_opened_at;
    await service.resolve(env);
    await service.touch(env, "1h");
    expect((await service.store.readEnv(env)).last_opened_at).toBe(openClock);

    const pid = focusedRecord.serve?.pid;
    expect(await service.stop(env)).toEqual({ env, status: "warm" });
    const stopped = await service.store.readEnv(env);
    expect(stopped.status).toBe("warm");
    expect(stopped.serve).toBeUndefined();
    expect(pid === undefined ? true : pidAlive(pid)).toBe(false);
  }, 30_000);

  it("idle-stops an unpinned dev serve even after a recent resolve touch", async () => {
    const { service } = await harness();
    const repo = await initGitRepo({
      "nectar.toml": devToml("fixture-dev-idle"),
      "dev.mjs": devProcess,
      "warm.mjs": warmProcess,
    });
    const published = await service.publish({ repo, mode: "dev", ttl: "1h" });
    const env = published.env as string;
    track(service, env);
    await service.open(env);
    await service.resolve(env);
    const running = await service.store.readEnv(env);
    const pid = running.serve?.pid;
    running.last_opened_at = new Date(Date.now() - 60_000).toISOString();
    running.last_touched_at = new Date().toISOString();
    await service.store.writeEnv(running);
    const config = await service.store.readConfig();
    await service.store.writeConfig({ ...config, idle_stop_ms: 1_000 });

    expect((await service.gc()).transitions).toEqual([{ env, action: "idle-stop" }]);
    const idled = await service.store.readEnv(env);
    expect(idled).toMatchObject({ status: "warm", last_opened_at: running.last_opened_at });
    expect(idled.serve).toBeUndefined();
    expect(pid === undefined ? true : pidAlive(pid)).toBe(false);
  }, 30_000);

  it("borrows an agent worktree without taking ownership of it", async () => {
    const { service } = await harness();
    const repo = await initGitRepo({
      "nectar.toml": `name = "fixture-dev-borrowed"\n[dev]\nrun = "node dev.mjs"\nkind = "electron"\n`,
      "dev.mjs": devProcess,
    });
    const borrowed = await import("node:fs/promises").then(({ realpath }) => realpath(repo));
    const published = await service.publish({ repo, mode: "dev", worktree: borrowed });
    const env = published.env as string;
    track(service, env);
    expect(await service.store.readEnv(env)).toMatchObject({
      status: "warm",
      worktree: borrowed,
      borrowed_worktree: true,
    });
    expect(await service.remove(env)).toMatchObject({
      env,
      removed: true,
      borrowed_worktree_preserved: true,
    });
    expect(await import("node:fs/promises").then(({ stat }) => stat(borrowed))).toBeTruthy();
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
