import { createHash, randomBytes } from "node:crypto";
import type http from "node:http";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pidAlive, spawnDetached, stopProcessGroup } from "../src/commands.js";
import { ProxyHub, Supervisor } from "../src/daemon.js";
import { portOpen } from "../src/ports.js";
import { EnvProxy, isView, probeProxy } from "../src/proxy.js";
import { NectarService } from "../src/service.js";
import { fakeExecutable, fakeTailscale, initGitRepo, record, tempDir } from "./helpers.js";

const fixtureDir = fileURLToPath(new URL("./fixtures/ws-app/", import.meta.url));

async function fixtureFiles(): Promise<Record<string, string>> {
  return {
    "nectar.toml": await readFile(path.join(fixtureDir, "nectar.toml"), "utf8"),
    "server.mjs": await readFile(path.join(fixtureDir, "server.mjs"), "utf8"),
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startApp(port: number): Promise<{ pgid: number }> {
  const dir = await tempDir("proxy-app");
  for (const [name, contents] of Object.entries(await fixtureFiles())) await writeFile(path.join(dir, name), contents);
  const app = spawnDetached("exec node server.mjs", dir, { ...process.env, PORT: String(port) }, path.join(dir, "log"));
  await waitFor(async () => portOpen(port));
  return app;
}

async function echo(url: string, message: string): Promise<string> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => socket.send(message));
    socket.addEventListener("message", (event) => {
      resolve(String(event.data));
      socket.close();
    });
    socket.addEventListener("error", () => reject(new Error("websocket failed")));
  });
}

async function get(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, { headers });
  return { status: response.status, body: await response.text() };
}

const html = { accept: "text/html,application/xhtml+xml" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("view detection", () => {
  const request = (method: string, headers: Record<string, string>): http.IncomingMessage =>
    ({ method, headers }) as unknown as http.IncomingMessage;

  it("counts document navigations, not assets, fetches or HMR", () => {
    expect(isView(request("GET", { "sec-fetch-dest": "document", accept: "text/html" }))).toBe(true);
    expect(isView(request("GET", { "sec-fetch-dest": "iframe" }))).toBe(true);
    expect(isView(request("GET", { accept: "text/html" }))).toBe(true);
    expect(isView(request("GET", { "sec-fetch-dest": "script", accept: "*/*" }))).toBe(false);
    expect(isView(request("GET", { "sec-fetch-dest": "empty", accept: "text/html" }))).toBe(false);
    expect(isView(request("GET", { accept: "*/*" }))).toBe(false);
    expect(isView(request("POST", { accept: "text/html" }))).toBe(false);
  });
});

describe("env proxy", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  });

  async function fronted(upstreamPort: number, proxyPort: number, onView = (): void => undefined): Promise<EnvProxy> {
    const app = await startApp(upstreamPort);
    cleanups.push(async () => stopProcessGroup(app.pgid));
    const proxy = new EnvProxy("ws--main--web", proxyPort, { host: "127.0.0.1", port: upstreamPort }, onView);
    await proxy.listen();
    cleanups.push(async () => proxy.close());
    return proxy;
  }

  it("passes WebSocket upgrades through in both directions", async () => {
    await fronted(4960, 4961);
    expect(await echo("ws://127.0.0.1:4961/ws", "hello through nectar")).toBe("echo: hello through nectar");
  });

  it("streams responses as they are written and passes large request bodies intact", async () => {
    await fronted(4962, 4963);
    const started = Date.now();
    const arrivals: number[] = [];
    const response = await fetch("http://127.0.0.1:4963/stream");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      arrivals.push(Date.now() - started);
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toContain("tick 3");
    expect(arrivals.length).toBeGreaterThanOrEqual(3);
    expect((arrivals[0] ?? 0) < 400).toBe(true);
    const body = randomBytes(24 * 1024 * 1024);
    const echoed = (await fetch("http://127.0.0.1:4963/upload", { method: "POST", body }).then(async (reply) => (await reply.json()) as unknown)) as {
      size: number;
      sha256: string;
    };
    expect(echoed).toEqual({ size: body.length, sha256: createHash("sha256").update(body).digest("hex") });
  });

  it("answers 502 while the app is down, identifies itself to Nectar, and calls onView only for navigations", async () => {
    const views = vi.fn();
    const proxy = new EnvProxy("down--main--web", 4965, { host: "127.0.0.1", port: 4964 }, views);
    await proxy.listen();
    cleanups.push(async () => proxy.close());
    expect((await get(4965, "/", html)).status).toBe(502);
    expect(await probeProxy(4965, "down--main--web")).toBe(4964);
    expect(await probeProxy(4965, "other--main--web")).toBeUndefined();
    await get(4965, "/app.js", { accept: "*/*" });
    expect(views).toHaveBeenCalledTimes(1);
  });
});

describe("touch on request", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  });

  it("touches at most once per env per throttle window, never for assets, without waiting for the touch, and reports a moved upstream", async () => {
    const app = await startApp(4966);
    cleanups.push(async () => stopProcessGroup(app.pgid));
    let release: () => void = () => undefined;
    const touchView = vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          release = () => resolve("2099-01-01T00:00:00.000Z");
        }),
    );
    const log = vi.fn();
    const hub = new ProxyHub(
      {
        assignProxyPort: () => Promise.resolve(4967),
        releaseProxyPort: () => Promise.resolve(),
        unfront: () => Promise.resolve(true),
        touchView,
      },
      400,
      log,
    );
    cleanups.push(async () => hub.close());
    const env = record({ name: "ws--main--web", urls: { local: "http://127.0.0.1:4966", mesh: "https://x.ts.net:8443" }, serve: { cmd: "x", pid: 1, pgid: 1, upstream_port: 4966, tailnet_port: 8443 } });
    expect(await hub.sync([env])).toEqual(["ws--main--web"]);
    expect((await get(4967, "/", html)).status).toBe(200);
    expect((await get(4967, "/", html)).status).toBe(200);
    await get(4967, "/main.js", { "sec-fetch-dest": "script", accept: "*/*" });
    expect(touchView).toHaveBeenCalledTimes(1);
    release();
    await waitFor(async () => Promise.resolve(log.mock.calls.some(([event]) => (event as { event: string }).event === "touch")));
    await new Promise((resolve) => setTimeout(resolve, 450));
    await get(4967, "/", { "sec-fetch-dest": "document" });
    expect(touchView).toHaveBeenCalledTimes(2);
    expect(await hub.sync([env])).toEqual([]);
    const moved = { ...env, urls: { ...env.urls, local: "http://127.0.0.1:4968" }, serve: { cmd: "x", pid: 1, pgid: 1, upstream_port: 4968, tailnet_port: 8443 } };
    expect(await hub.sync([moved])).toEqual(["ws--main--web"]);
    expect(await probeProxy(4967, "ws--main--web")).toBe(4968);
    expect(await hub.sync([moved])).toEqual([]);
    expect(await hub.sync([])).toEqual([]);
    expect(await portOpen(4967)).toBe(false);
  });
});

async function liveHarness(): Promise<{ service: NectarService; tailscaleLog: string; repo: string }> {
  const state = await tempDir("proxy-state");
  const fakeDir = await tempDir("proxy-bin");
  const tailscale = await fakeTailscale(fakeDir);
  const trash = await fakeExecutable(fakeDir, "trash", `for target in "$@"; do mv "$target" "$target.trash.$$"; done`);
  await writeFile(
    path.join(state, "nectar.json"),
    JSON.stringify({ upstream_port_start: 4970, upstream_port_end: 4989, pack_server_port: 4969, tailnet_port_start: 8970, tailnet_port_end: 8989 }),
  );
  vi.stubEnv("NECTAR_HOME", state);
  vi.stubEnv("NECTAR_TAILSCALE_BIN", tailscale.binary);
  vi.stubEnv("FAKE_TS_LOG", tailscale.log);
  vi.stubEnv("NECTAR_TRASH_BIN", trash);
  return { service: new NectarService(state), tailscaleLog: tailscale.log, repo: await initGitRepo(await fixtureFiles()) };
}

async function serveCalls(log: string, tailnetPort: number | undefined): Promise<string[]> {
  return (await readFile(log, "utf8")).split("\n").filter((line) => line.includes(`--https=${tailnetPort} http`));
}

describe("nectard fronting the real service", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
  });

  it("fronts a published env, touches on a view, reports the app's health, revives behind the proxy and hands back on stop", async () => {
    const { service, tailscaleLog, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "2m" })) as { env: string; expires_at: string };
    cleanups.push(async () => void (await service.remove(published.env, true)));
    const supervisor = new Supervisor(service, { front: true });
    cleanups.push(async () => supervisor.stop());
    await supervisor.sweep(false);
    await supervisor.sweep(false);
    const fronted = await service.store.readEnv(published.env);
    const proxyPort = fronted.serve?.proxy_port ?? 0;
    const upstreamPort = fronted.serve?.upstream_port ?? 0;
    expect(proxyPort).toBeGreaterThanOrEqual(4970);
    expect(proxyPort).not.toBe(upstreamPort);
    expect(fronted.urls.mesh).toBe(`https://fixture.tailtest.ts.net:${fronted.serve?.tailnet_port}`);
    expect(fronted.urls.local).toBe(`http://127.0.0.1:${upstreamPort}`);
    expect((await serveCalls(tailscaleLog, fronted.serve?.tailnet_port)).at(-1)).toContain(`http://127.0.0.1:${proxyPort}`);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await get(proxyPort, "/", html)).body).toContain(published.env);
    await waitFor(async () => (await service.store.readEnv(published.env)).expires_at !== published.expires_at);
    expect(Date.parse((await service.store.readEnv(published.env)).expires_at)).toBeGreaterThan(Date.parse(published.expires_at));
    expect(await echo(`ws://127.0.0.1:${proxyPort}/ws`, "hi")).toBe("echo: hi");

    await stopProcessGroup(fronted.serve?.pgid ?? 0);
    const shown = (await service.show(published.env)) as { env: { status: string; liveness: { port_open: boolean } } };
    expect(shown.env.status).toBe("crashed");
    expect(shown.env.liveness.port_open).toBe(false);
    expect(await portOpen(proxyPort)).toBe(true);
    expect((await get(proxyPort, "/", html)).status).toBe(502);

    await supervisor.sweep(false);
    const revived = await service.store.readEnv(published.env);
    expect(revived.status).toBe("serving");
    expect(pidAlive(revived.serve?.pid ?? 0)).toBe(true);
    expect(revived.serve?.proxy_port).toBe(proxyPort);
    expect((await get(proxyPort, "/", html)).status).toBe(200);
    expect((await serveCalls(tailscaleLog, revived.serve?.tailnet_port)).at(-1)).toContain(`http://127.0.0.1:${proxyPort}`);

    const republished = (await service.publish({ repo, ttl: "2m" })) as { urls: { mesh: string } };
    const after = await service.store.readEnv(published.env);
    expect(republished.urls.mesh).toBe(fronted.urls.mesh);
    expect(after.serve?.proxy_port).toBe(proxyPort);
    expect((await serveCalls(tailscaleLog, after.serve?.tailnet_port)).at(-1)).toContain(`http://127.0.0.1:${proxyPort}`);

    await supervisor.stop();
    expect(await portOpen(proxyPort)).toBe(false);
    expect((await serveCalls(tailscaleLog, after.serve?.tailnet_port)).at(-1)).toContain(`http://127.0.0.1:${upstreamPort}`);
  });

  it("adopts an env published before fronting existed without changing its tailnet port", async () => {
    const { service, tailscaleLog, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "1h" })) as { env: string };
    cleanups.push(async () => void (await service.remove(published.env, true)));
    const before = await service.store.readEnv(published.env);
    expect(before.serve?.proxy_port).toBeUndefined();
    expect((await serveCalls(tailscaleLog, before.serve?.tailnet_port)).at(-1)).toContain(`http://127.0.0.1:${before.serve?.upstream_port}`);
    const supervisor = new Supervisor(service, { front: true });
    cleanups.push(async () => supervisor.stop());
    await supervisor.start();
    const after = await service.store.readEnv(published.env);
    expect(after.serve?.tailnet_port).toBe(before.serve?.tailnet_port);
    expect(after.urls.mesh).toBe(before.urls.mesh);
    expect((await serveCalls(tailscaleLog, after.serve?.tailnet_port)).at(-1)).toContain(`http://127.0.0.1:${after.serve?.proxy_port}`);
  });

  it("re-fronts an env whose republish moved it to a new upstream port", async () => {
    const { service, tailscaleLog, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "1h" })) as { env: string };
    cleanups.push(async () => void (await service.remove(published.env, true)));
    const supervisor = new Supervisor(service, { front: true });
    cleanups.push(async () => supervisor.stop());
    await supervisor.sweep(false);
    const before = await service.store.readEnv(published.env);
    await stopProcessGroup(before.serve?.pgid ?? 0);
    const squatter = await startApp(before.serve?.upstream_port ?? 0);
    cleanups.push(async () => stopProcessGroup(squatter.pgid));
    await service.publish({ repo, ttl: "1h" });
    const moved = await service.store.readEnv(published.env);
    expect(moved.serve?.upstream_port).not.toBe(before.serve?.upstream_port);
    expect(moved.serve?.proxy_port).toBe(before.serve?.proxy_port);
    expect((await serveCalls(tailscaleLog, moved.serve?.tailnet_port)).at(-1)).toContain(`http://127.0.0.1:${moved.serve?.upstream_port}`);
    await supervisor.sweep(false);
    expect((await serveCalls(tailscaleLog, moved.serve?.tailnet_port)).at(-1)).toContain(`http://127.0.0.1:${moved.serve?.proxy_port}`);
    expect((await get(moved.serve?.proxy_port ?? 0, "/", html)).body).toContain(published.env);
  });

  it("gc points the tailnet URL straight at a live app when its proxy is gone", async () => {
    const { service, tailscaleLog, repo } = await liveHarness();
    const published = (await service.publish({ repo, ttl: "1h" })) as { env: string };
    cleanups.push(async () => void (await service.remove(published.env, true)));
    const supervisor = new Supervisor(service, { front: true });
    await supervisor.sweep(false);
    await supervisor.sweep(false);
    const fronted = await service.store.readEnv(published.env);
    await supervisor.hub?.close();
    vi.stubEnv(
      "FAKE_TS_SERVE_STATUS",
      JSON.stringify({ Web: { [`fixture.tailtest.ts.net:${fronted.serve?.tailnet_port}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${fronted.serve?.proxy_port}` } } } } }),
    );
    const report = (await service.gc()) as { serve_orphans: Array<{ env: string; fixed: boolean; direct?: string }> };
    expect(report.serve_orphans).toEqual([expect.objectContaining({ env: published.env, fixed: true, direct: fronted.urls.local })]);
    const after = await service.store.readEnv(published.env);
    expect(after.status).toBe("serving");
    expect(after.urls.mesh).toBe(fronted.urls.mesh);
    expect((await serveCalls(tailscaleLog, fronted.serve?.tailnet_port)).at(-1)).toContain(`${fronted.urls.local}`);
  });
});
