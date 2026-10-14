import { chmod, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeDiscovery, discoverLocalApi, discoveryReport, parseLsofProofs, pinLocalApi, readStatus, SERVE_CONFIG_ATTEMPTS, whoIs } from "../src/localapi.js";
import { serveStatus, serveWeb, stopServe, tailnetStatus, traceTailscale } from "../src/tailscale.js";
import { fakeExecutable, fakeLocalApi, tempDir, type FakeLocalApi } from "./helpers.js";

const TOKEN = "0123456789abcdef0123";
const DNS = "fixture.tailtest.ts.net";

const FOREIGN = {
  TCP: { "443": { HTTPS: true }, "9000": { TCPForward: "127.0.0.1:22" }, "8443": { HTTPS: true } },
  Web: {
    [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" }, "/docs/": { Path: "/srv/docs" } } },
    [`${DNS}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4100" } } },
  },
  AllowFunnel: { [`${DNS}:443`]: true },
  Services: { "svc:grafana": { TCP: { "443": { HTTPS: true } }, Web: { "grafana.tailtest.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3001" } } } } } },
  Foreground: { "session-1": { TCP: { "8500": { HTTPS: true } } } },
  FutureField: { kept: [1, 2, 3] },
};

const servers: FakeLocalApi[] = [];

async function socketApi(options: Parameters<typeof fakeLocalApi>[1] = {}): Promise<FakeLocalApi> {
  const api = await fakeLocalApi({ socket: path.join(await tempDir("localapi"), "tailscaled.sock") }, options);
  servers.push(api);
  vi.stubEnv("NECTAR_TAILSCALE_SOCKET", api.socket);
  return api;
}

async function tcpApi(options: Parameters<typeof fakeLocalApi>[1] = {}): Promise<FakeLocalApi> {
  const api = await fakeLocalApi({ tcp: true }, { token: TOKEN, ...options });
  servers.push(api);
  pinLocalApi({ kind: "tcp", port: api.port ?? 0, token: TOKEN, source: "app-store" });
  return api;
}

async function failingCli(): Promise<string> {
  const cli = await fakeExecutable(await tempDir("localapi-cli"), "tailscale", `echo "cli $*" >> "$(dirname "$0")/calls"\necho "The Tailscale GUI failed to start" >&2\nexit 1`);
  vi.stubEnv("NECTAR_TAILSCALE_BIN", cli);
  return cli;
}

afterEach(async () => {
  pinLocalApi(undefined);
  traceTailscale(undefined);
  for (const server of servers.splice(0)) await server.close();
});

describe("LocalAPI status", () => {
  it("reads the tailnet identity over the Unix socket and logs which API answered", async () => {
    await failingCli();
    const api = await socketApi();
    const events: Array<Record<string, unknown>> = [];
    traceTailscale((event) => events.push(event), { all: true });
    expect(await tailnetStatus()).toEqual({ identity: { host: "fixture", dnsName: DNS }, api: "localapi", endpoint: `unix:${api.socket}` });
    expect(events).toEqual([expect.objectContaining({ event: "tailscale", api: "localapi", ok: true, endpoint: `unix:${api.socket}`, path: "/localapi/v0/status" })]);
    expect(api.requests[0]?.authorization).toBeUndefined();
  });

  it("reads it over a loopback port with the sameuserproof token as basic auth, and never logs the token", async () => {
    await failingCli();
    const api = await tcpApi({ status: { BackendState: "Stopped" } });
    const events: Array<Record<string, unknown>> = [];
    traceTailscale((event) => events.push(event), { all: true });
    const status = await tailnetStatus();
    expect(status).toMatchObject({ api: "localapi", reason: expect.stringContaining("Tailscale is Stopped, not Running") as unknown });
    expect(status.reason).toContain(`127.0.0.1:${api.port} (app-store sameuserproof)`);
    expect(api.requests[0]?.authorization).toBe(`Basic ${Buffer.from(`:${TOKEN}`).toString("base64")}`);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(status.reason).not.toContain(TOKEN);
  });

  it("falls back to the CLI when the LocalAPI is unreachable and says why in the reason and the log", async () => {
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", path.join(await tempDir("localapi-none"), "missing.sock"));
    const cli = await fakeExecutable(await tempDir("localapi-cli"), "tailscale", `printf '{"BackendState":"Running","Self":{"DNSName":"cli.tailtest.ts.net."}}\\n'`);
    vi.stubEnv("NECTAR_TAILSCALE_BIN", cli);
    const events: Array<Record<string, unknown>> = [];
    traceTailscale((event) => events.push(event), { all: true });
    expect(await tailnetStatus()).toEqual({ identity: { host: "cli", dnsName: "cli.tailtest.ts.net" }, api: "cli" });
    expect(events).toEqual([expect.objectContaining({ api: "cli", ok: true, localapi: expect.stringContaining("missing.sock: ENOENT") as unknown })]);
  });

  it("treats a token the LocalAPI refuses as unreachable and falls back to the CLI", async () => {
    await failingCli();
    const api = await fakeLocalApi({ tcp: true }, { token: "ffffffffffffffffffff" });
    servers.push(api);
    pinLocalApi({ kind: "tcp", port: api.port ?? 0, token: TOKEN, source: "app-store" });
    const status = await tailnetStatus();
    expect(status.api).toBe("cli");
    expect(status.reason).toContain("refused its token");
    expect(status.reason).toContain("The Tailscale GUI failed to start");
    expect(status.reason).not.toContain(TOKEN);
  });
});

describe("LocalAPI serve config", () => {
  for (const transport of ["socket", "tcp"] as const) {
    it(`adds and removes only Nectar's handler and keeps every foreign entry exactly (${transport})`, async () => {
      const cli = await failingCli();
      const api = transport === "socket" ? await socketApi({ config: structuredClone(FOREIGN) }) : await tcpApi({ config: structuredClone(FOREIGN) });
      const added = await serveWeb(8501, "http://127.0.0.1:4501");
      expect(added).toEqual({ ok: true, message: "", api: "localapi" });
      const expected = structuredClone(FOREIGN) as typeof FOREIGN & { Web: Record<string, unknown>; TCP: Record<string, unknown> };
      expected.TCP["8501"] = { HTTPS: true };
      expected.Web[`${DNS}:8501`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:4501" } } };
      expect(api.config()).toEqual(expected);
      expect(await serveStatus()).toEqual(expected);
      expect(await stopServe(8501)).toBe(true);
      expect(api.config()).toEqual(FOREIGN);
      const posts = api.requests.filter((request) => request.method === "POST");
      expect(posts).toHaveLength(2);
      expect(posts.every((request) => request.ifMatch !== undefined && request.ifMatch.length === 64)).toBe(true);
      expect(await readCalls(cli)).toBe("");
    });
  }

  it("replaces an existing handler on its port the way `tailscale serve --https=N` does, dropping that port's Funnel", async () => {
    const api = await socketApi({ config: structuredClone(FOREIGN) });
    expect((await serveWeb(443, "http://127.0.0.1:4999")).ok).toBe(true);
    const config = api.config() as typeof FOREIGN;
    expect(config.Web[`${DNS}:443`]).toEqual({ Handlers: { "/": { Proxy: "http://127.0.0.1:4999" }, "/docs/": { Path: "/srv/docs" } } });
    expect(config.AllowFunnel).toBeUndefined();
    expect(config.Services).toEqual(FOREIGN.Services);
  });

  it("removes every mount on the port like `serve --https=N off`, and refuses ports with no handler or TCP forwarding", async () => {
    const api = await socketApi({ config: structuredClone(FOREIGN) });
    expect(await stopServe(443)).toBe(true);
    const config = api.config() as Partial<typeof FOREIGN>;
    expect(config.Web?.[`${DNS}:443`]).toBeUndefined();
    expect(config.TCP).toEqual({ "9000": { TCPForward: "127.0.0.1:22" }, "8443": { HTTPS: true } });
    expect(config.AllowFunnel).toBeUndefined();
    const before = api.requests.length;
    await failingCli();
    expect(await stopServe(8600)).toBe(false);
    expect(await stopServe(9000)).toBe(false);
    expect(api.requests.slice(before).filter((request) => request.method === "POST")).toEqual([]);
    expect((await serveWeb(9000, "http://127.0.0.1:1")).message).toContain("already forwards TCP");
  });

  it("re-reads and retries when another writer changes the config between read and write, keeping that writer's entry", async () => {
    const api = await socketApi({
      config: structuredClone(FOREIGN),
      conflicts: 2,
      onConflict: (config) => {
        const web = config.Web as Record<string, unknown>;
        web[`${DNS}:8700`] = { Handlers: { "/": { Proxy: `http://127.0.0.1:${8700 + Object.keys(web).length}` } } };
      },
    });
    expect(await serveWeb(8501, "http://127.0.0.1:4501")).toEqual({ ok: true, message: "", api: "localapi" });
    const config = api.config() as typeof FOREIGN;
    expect(Object.keys(config.Web)).toEqual(expect.arrayContaining([`${DNS}:443`, `${DNS}:8443`, `${DNS}:8700`, `${DNS}:8501`]));
    expect(api.requests.filter((request) => request.method === "POST")).toHaveLength(3);
  });

  it("gives up after repeated ETag conflicts without falling back to the CLI", async () => {
    const cli = await failingCli();
    await socketApi({ config: structuredClone(FOREIGN), conflicts: 100 });
    const outcome = await serveWeb(8501, "http://127.0.0.1:4501");
    expect(outcome).toMatchObject({ ok: false, api: "localapi" });
    expect(outcome.message).toContain(`${SERVE_CONFIG_ATTEMPTS} ETag conflicts`);
    expect(await readCalls(cli)).toBe("");
  });

  it("reports tailscaled's denial for a non-operator and does not retry through the CLI", async () => {
    const cli = await failingCli();
    const api = await socketApi({ config: structuredClone(FOREIGN), postStatus: 403, postBody: "serve config denied\n" });
    const events: Array<Record<string, unknown>> = [];
    traceTailscale((event) => events.push(event));
    expect(await serveWeb(8501, "http://127.0.0.1:4501")).toEqual({ ok: false, message: "serve config denied", api: "localapi" });
    expect(api.config()).toEqual(FOREIGN);
    expect(events).toEqual([expect.objectContaining({ api: "localapi", ok: false, status: 403, method: "POST" })]);
    expect(await readCalls(cli)).toBe("");
  });

  it("uses the CLI for serve changes when the LocalAPI is unreachable and names both paths", async () => {
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", path.join(await tempDir("localapi-none"), "missing.sock"));
    const cli = await failingCli();
    const outcome = await serveWeb(8501, "http://127.0.0.1:4501");
    expect(outcome).toMatchObject({ ok: false, api: "cli", message: "The Tailscale GUI failed to start" });
    expect(outcome.unreachable).toContain("missing.sock: ENOENT");
    expect(await readCalls(cli)).toContain("cli serve --bg --yes --https=8501 http://127.0.0.1:4501");
  });
});

describe("LocalAPI whois", () => {
  const node = {
    Node: { StableID: "nX1", Name: "laptop.tailtest.ts.net.", ComputedName: "laptop", User: 42, Addresses: ["100.64.0.7/32", "fd7a::7/128"], Tags: null },
    UserProfile: { ID: 42, LoginName: "q@example.com", DisplayName: "Q" },
  };

  it("names the tailnet peer behind an address and says when there is none", async () => {
    await tcpApi({ whois: { "100.64.0.7:51234": node } });
    expect(await whoIs("100.64.0.7:51234")).toEqual({
      peer: { loginName: "q@example.com", displayName: "Q", nodeName: "laptop", dnsName: "laptop.tailtest.ts.net", nodeId: "nX1", userId: 42, nodeUserId: 42, tailscaleIPs: ["100.64.0.7", "fd7a::7"], tags: [] },
    });
    expect(await whoIs("10.1.2.3:80")).toEqual({ reason: "10.1.2.3:80 is not a tailnet peer", notFound: true });
  });

  it("fails closed when the LocalAPI is unreachable", async () => {
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", path.join(await tempDir("localapi-none"), "missing.sock"));
    expect(await whoIs("100.64.0.7:1")).toMatchObject({ notFound: false, reason: expect.stringContaining("Tailscale LocalAPI unreachable") as unknown });
  });
});

describe("LocalAPI discovery", () => {
  const container = "W5364U7YZB.io.tailscale.ipn.macos";

  it("prefers the pinned socket over everything", async () => {
    expect(await discoverLocalApi({ env: { NECTAR_TAILSCALE_SOCKET: "/x.sock" }, platform: "darwin", lsof: () => Promise.reject(new Error("unused")) })).toEqual({
      endpoints: [{ kind: "socket", socket: "/x.sock", source: "env" }],
      notes: [],
      steps: [{ step: "env", outcome: "found", ms: 0, found: 1 }],
      mode: "interactive",
    });
  });

  it("reads the App Store app's port and token from IPNExtension's open sameuserproof file", async () => {
    const lsof = `p812\ncIPNExtension\nn/Users/q/Library/Group Containers/${container}/sameuserproof-53771-${TOKEN}\nn127.0.0.1:53771\n`;
    expect(parseLsofProofs(lsof)).toEqual([{ kind: "tcp", port: 53771, token: TOKEN, source: "app-store" }]);
    const found = await discoverLocalApi({ env: {}, platform: "darwin", home: await tempDir("home"), macsysDir: "/nonexistent", sockets: [], lsof: () => Promise.resolve(lsof) });
    expect(found.endpoints).toEqual([{ kind: "tcp", port: 53771, token: TOKEN, source: "app-store" }]);
  });

  it("falls back to macsys and the tailscaled socket, and lists the group container only when nothing else was found", async () => {
    const home = await tempDir("home");
    const group = path.join(home, "Library", "Group Containers", container);
    await mkdir(group, { recursive: true });
    await writeFile(path.join(group, `sameuserproof-50001-${TOKEN}`), "");
    const macsys = await tempDir("macsys");
    await symlink("50002", path.join(macsys, "ipnport"));
    await writeFile(path.join(macsys, "sameuserproof-50002"), "abcdef\n");
    const socket = path.join(macsys, "tailscaled.socket");
    await writeFile(socket, "");
    const found = await discoverLocalApi({ env: {}, platform: "darwin", home, macsysDir: macsys, sockets: [socket], lsof: () => Promise.resolve("") });
    expect(found.endpoints).toEqual([
      { kind: "tcp", port: 50002, token: "abcdef", source: "macsys" },
      { kind: "socket", socket, source: "default" },
    ]);
    expect(found.steps.map((step) => [step.step, step.outcome])).toEqual([
      ["lsof", "none"],
      ["macsys", "found"],
      ["group-container", "skipped"],
      ["socket", "found"],
    ]);
    const listed = await discoverLocalApi({ env: {}, platform: "darwin", home, macsysDir: "/nonexistent", sockets: [], lsof: () => Promise.resolve("") });
    expect(listed.endpoints).toEqual([{ kind: "tcp", port: 50001, token: TOKEN, source: "app-store" }]);
    expect(listed.steps.map((step) => [step.step, step.outcome])).toEqual([
      ["lsof", "none"],
      ["macsys", "none"],
      ["group-container", "found"],
      ["socket", "none"],
    ]);
  });

  it("says plainly when macOS privacy protection hides the group container", async () => {
    if (process.getuid?.() === 0) return;
    const home = await tempDir("home");
    const group = path.join(home, "Library", "Group Containers", container);
    await mkdir(group, { recursive: true });
    await chmod(group, 0o000);
    try {
      const found = await discoverLocalApi({ env: {}, platform: "darwin", home, macsysDir: "/nonexistent", sockets: ["/nonexistent.sock"], lsof: () => Promise.resolve("") });
      expect(found.endpoints).toEqual([]);
      expect(found.notes.join("\n")).toMatch(/cannot read .*io\.tailscale\.ipn\.macos: EACCES; macOS privacy protection/);
    } finally {
      await chmod(group, 0o755);
    }
  });
});

describe("LocalAPI discovery bounds", () => {
  const container = "W5364U7YZB.io.tailscale.ipn.macos";
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

  async function macsysDir(port = 50002): Promise<string> {
    const macsys = await tempDir("macsys");
    await symlink(String(port), path.join(macsys, "ipnport"));
    await writeFile(path.join(macsys, `sameuserproof-${port}`), "abcdef\n");
    return macsys;
  }

  async function homeWithContainer(): Promise<string> {
    const home = await tempDir("home");
    await mkdir(path.join(home, "Library", "Group Containers", container), { recursive: true });
    return home;
  }

  function hangingReaddir(home: string, calls: string[]): (directory: string) => Promise<string[]> {
    return (directory) => {
      calls.push(directory);
      return directory.startsWith(path.join(home, "Library")) ? never() : readdir(directory);
    };
  }

  it("skips a group-container listing that never returns and still reaches the socket within the bound", async () => {
    const home = await homeWithContainer();
    const socket = path.join(await tempDir("sock"), "tailscaled.socket");
    await writeFile(socket, "");
    const calls: string[] = [];
    const options = { env: {}, platform: "darwin" as const, home, macsysDir: "/nonexistent", sockets: [socket], lsof: () => Promise.resolve(""), fs: { readdir: hangingReaddir(home, calls) }, stepTimeoutMs: 200 };
    const started = Date.now();
    const found = await discoverLocalApi(options);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(found.endpoints).toEqual([{ kind: "socket", socket, source: "default" }]);
    expect(found.steps.map((step) => [step.step, step.outcome])).toEqual([
      ["lsof", "none"],
      ["macsys", "none"],
      ["group-container", "timeout"],
      ["socket", "found"],
    ]);
    expect(found.notes.join("\n")).toContain("group-container: did not finish within 0.2s, so it was skipped");

    const again = await discoverLocalApi(options);
    expect(again.steps.find((step) => step.step === "group-container")).toMatchObject({ outcome: "stuck", ms: 0 });
    expect(again.endpoints).toEqual(found.endpoints);
    expect(calls).toHaveLength(1);
  });

  it("lists the group container in a child process that it can abandon", async () => {
    const home = await homeWithContainer();
    await writeFile(path.join(home, "Library", "Group Containers", container, `sameuserproof-50009-${TOKEN}`), "");
    const found = await discoverLocalApi({ env: {}, platform: "darwin", home, macsysDir: "/nonexistent", sockets: [], lsof: () => Promise.resolve("") });
    expect(found.endpoints).toEqual([{ kind: "tcp", port: 50009, token: TOKEN, source: "app-store" }]);
    const missing = await discoverLocalApi({ env: {}, platform: "darwin", home: await tempDir("home"), macsysDir: "/nonexistent", sockets: [], lsof: () => Promise.resolve("") });
    expect(missing.steps.find((step) => step.step === "group-container")).toMatchObject({ outcome: "none" });
    expect(missing.notes.join("\n")).not.toContain("cannot list");
  });

  it("kills an lsof that never exits and moves on to the next step", async () => {
    const bin = await tempDir("lsof-bin");
    const lsof = await fakeExecutable(bin, "lsof", `echo "$$" > "$(dirname "$0")/pid"\nexec sleep 30`);
    const macsys = await macsysDir(50003);
    const started = Date.now();
    const found = await discoverLocalApi({ env: { NECTAR_TEST_LSOF_BIN: lsof }, platform: "darwin", home: await tempDir("home"), macsysDir: macsys, sockets: [], stepTimeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(found.steps[0]).toMatchObject({ step: "lsof", outcome: "timeout" });
    expect(found.endpoints).toEqual([{ kind: "tcp", port: 50003, token: "abcdef", source: "macsys" }]);
    const pid = Number((await readFile(path.join(bin, "pid"), "utf8")).trim());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("as a service tries macsys first and never lists the group container", async () => {
    const home = await homeWithContainer();
    const calls: string[] = [];
    let lsofCalled = false;
    const found = await discoverLocalApi({
      env: {},
      platform: "darwin",
      mode: "service",
      home,
      macsysDir: await macsysDir(),
      sockets: [],
      lsof: () => {
        lsofCalled = true;
        return Promise.resolve("");
      },
      fs: { readdir: hangingReaddir(home, calls) },
      stepTimeoutMs: 200,
    });
    expect(found.mode).toBe("service");
    expect(found.steps.map((step) => [step.step, step.outcome])).toEqual([
      ["macsys", "found"],
      ["lsof", "none"],
      ["group-container", "skipped"],
      ["socket", "none"],
    ]);
    expect(found.endpoints[0]).toMatchObject({ source: "macsys" });
    expect(lsofCalled).toBe(true);
    expect(calls).toEqual([]);
    expect(found.notes.join("\n")).toContain("a prompt nobody can answer");
  });

  it("keeps the whole discovery inside its budget when every step hangs", async () => {
    const home = await homeWithContainer();
    const started = Date.now();
    const found = await discoverLocalApi({
      env: {},
      platform: "darwin",
      home,
      macsysDir: "/nonexistent",
      sockets: [],
      lsof: () => never(),
      fs: { readdir: () => never(), readlink: () => never() },
      stepTimeoutMs: 300,
      budgetMs: 500,
    });
    expect(Date.now() - started).toBeLessThan(900);
    expect(found.steps.map((step) => [step.step, step.outcome])).toEqual([
      ["lsof", "timeout"],
      ["macsys", "timeout"],
      ["group-container", "skipped"],
      ["socket", "skipped"],
    ]);
  });

  it("caches the discovery in the process, backs off before discovering again, and reports which step answered", async () => {
    const api = await fakeLocalApi({ tcp: true }, { token: "abcdef" });
    servers.push(api);
    const bin = await tempDir("lsof-bin");
    const lsof = await fakeExecutable(bin, "lsof", `echo run >> "$(dirname "$0")/runs"`);
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", "");
    vi.stubEnv("NECTAR_TEST_DISCOVERY_PLATFORM", "darwin");
    vi.stubEnv("NECTAR_TEST_LSOF_BIN", lsof);
    vi.stubEnv("NECTAR_TEST_MACSYS_DIR", await macsysDir(api.port));
    vi.stubEnv("HOME", await tempDir("home"));
    const runs = async (): Promise<number> => (await readFile(path.join(bin, "runs"), "utf8").catch(() => "")).split("\n").filter(Boolean).length;

    const [first, second] = await Promise.all([readStatus(), readStatus()]);
    expect(first).toMatchObject({ ok: true, endpoint: { source: "macsys" } });
    expect(second).toMatchObject({ ok: true, endpoint: { source: "macsys" } });
    const report = discoveryReport();
    expect(report).toMatchObject({ mode: "interactive", won: { step: "macsys", endpoint: `127.0.0.1:${api.port} (macsys sameuserproof)` }, running: null });
    expect(describeDiscovery(report)).toContain("macsys found 1 (answered)");
    expect(JSON.stringify(report)).not.toContain("abcdef");
    expect(await runs()).toBe(1);

    await api.close();
    servers.splice(servers.indexOf(api), 1);
    const down = await readStatus();
    expect(down).toMatchObject({ ok: false, reachable: false });
    expect(await runs()).toBe(1);
    const again = await readStatus();
    expect(again.ok ? "" : again.reason).toMatch(/endpoints from the discovery .* ago; the next discovery runs in/);
    expect(await runs()).toBe(1);
    expect(discoveryReport()).toMatchObject({ won: null });
    expect(discoveryReport()?.next_discovery_in_ms).toBeGreaterThan(0);
    expect(discoveryReport()?.next_discovery_in_ms).toBeLessThanOrEqual(30_000);
  });

  it("discovers again at once when a cached endpoint's token went stale", async () => {
    const api = await fakeLocalApi({ tcp: true }, { token: "abcdef" });
    servers.push(api);
    const macsys = await tempDir("macsys");
    await symlink(String(api.port), path.join(macsys, "ipnport"));
    const proof = path.join(macsys, `sameuserproof-${api.port}`);
    await writeFile(proof, "0ld0ld\n");
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", "");
    vi.stubEnv("NECTAR_TEST_DISCOVERY_PLATFORM", "darwin");
    vi.stubEnv("NECTAR_TEST_LSOF_BIN", await fakeExecutable(await tempDir("lsof-bin"), "lsof", "exit 0"));
    vi.stubEnv("NECTAR_TEST_MACSYS_DIR", macsys);
    vi.stubEnv("HOME", await tempDir("home"));
    const stale = await readStatus();
    expect(stale.ok ? "" : stale.reason).toContain("refused its token (a stale sameuserproof)");
    await writeFile(proof, "abcdef\n");
    expect(await readStatus()).toMatchObject({ ok: true, endpoint: { source: "macsys" } });
    expect(discoveryReport()).toMatchObject({ won: { step: "macsys" } });
  });

  it("backs off once per failed discovery, however many callers shared it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.stubEnv("NECTAR_TAILSCALE_SOCKET", "");
      vi.stubEnv("NECTAR_TEST_DISCOVERY_PLATFORM", "darwin");
      vi.stubEnv("NECTAR_TEST_LSOF_BIN", await fakeExecutable(await tempDir("lsof-bin"), "lsof", "exit 0"));
      vi.stubEnv("NECTAR_TEST_MACSYS_DIR", await tempDir("no-macsys"));
      vi.stubEnv("HOME", await tempDir("home"));
      const discover = (): Promise<unknown> => Promise.all([readStatus(), readStatus(), readStatus()]);
      await discover();
      expect(discoveryReport()?.next_discovery_in_ms).toBe(30_000);
      vi.setSystemTime(Date.now() + 30_000);
      await discover();
      expect(discoveryReport()?.next_discovery_in_ms).toBe(60_000);
      vi.setSystemTime(Date.now() + 60_000);
      await discover();
      expect(discoveryReport()?.next_discovery_in_ms).toBe(120_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

async function readCalls(cli: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path.join(path.dirname(cli), "calls"), "utf8").catch(() => "");
}
