import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractTar, tarEntry } from "../src/archive.js";
import { runCommand, stopProcessGroup } from "../src/commands.js";
import { NectarError } from "../src/errors.js";
import { getPaths } from "../src/paths.js";
import { pinLocalApi, type TailnetPeer } from "../src/localapi.js";
import net from "node:net";
import { daemonLogger } from "../src/daemon.js";
import {
  authorize,
  callRemote,
  listenerCheck,
  peerView,
  remoteStatus,
  startRemoteListener,
  startRemoteServer,
  type RemoteListener,
  type RemoteServer,
} from "../src/remote.js";
import { NectarService } from "../src/service.js";
import { fakeLocalApi, tempDir } from "./helpers.js";

const OWNER = 1001;
const TOKEN = "0123456789abcdef0123";
const servers: Array<{ close: () => Promise<void> }> = [];
const pgids: number[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const pgid of pgids.splice(0)) await stopProcessGroup(pgid);
  pinLocalApi(undefined);
  vi.unstubAllEnvs();
});

interface Who {
  id?: string;
  name?: string;
  user?: number;
  login?: string;
  tags?: string[];
}

function whois(overrides: Who = {}): Record<string, unknown> {
  return {
    Node: {
      StableID: overrides.id ?? "nCLIENT",
      Name: `${overrides.name ?? "nodea"}.tail.ts.net.`,
      User: overrides.user ?? OWNER,
      Addresses: ["100.64.0.9/32"],
      ...(overrides.tags === undefined ? {} : { Tags: overrides.tags }),
    },
    UserProfile: { ID: overrides.user ?? OWNER, LoginName: overrides.login ?? "owner@example.com", DisplayName: "Owner" },
  };
}

function who(overrides: Who = {}): TailnetPeer {
  return {
    loginName: overrides.login ?? "owner@example.com",
    displayName: "Owner",
    nodeName: overrides.name ?? "nodea",
    dnsName: `${overrides.name ?? "nodea"}.tail.ts.net`,
    nodeId: overrides.id ?? "nCLIENT",
    userId: overrides.user ?? OWNER,
    nodeUserId: overrides.user ?? OWNER,
    tailscaleIPs: ["100.64.0.9"],
    tags: overrides.tags ?? [],
  };
}

type Transport = "socket" | "token port";

interface FakeTailnet {
  identity: unknown;
  asked: string[];
  close: () => Promise<void>;
}

let transport: Transport = "socket";

async function fakeTailnet(selfAddress = "127.0.0.3"): Promise<FakeTailnet> {
  const state: FakeTailnet = { identity: whois(), asked: [], close: () => Promise.resolve() };
  const options = {
    status: {
      BackendState: "Running",
      Self: { ID: "nSELF", HostName: "nodeself", TailscaleIPs: [selfAddress], UserID: OWNER },
      Peer: { key: { HostName: "nodeb", DNSName: "nodeb.tail.ts.net.", TailscaleIPs: ["127.0.0.1", "fd7a::1"] } },
    },
    postStatus: 403,
    postBody: "serve config denied",
    whois: (addr: string) => {
      state.asked.push(addr);
      return state.identity;
    },
  };
  vi.stubEnv("NECTAR_TAILSCALE_BIN", "/bin/false");
  const api =
    transport === "socket"
      ? await fakeLocalApi({ socket: path.join(await tempDir("localapi"), "tailscaled.sock") }, options)
      : await fakeLocalApi({ tcp: true }, { ...options, token: TOKEN });
  if (api.socket !== undefined) vi.stubEnv("NECTAR_TAILSCALE_SOCKET", api.socket);
  else {
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", path.join(await tempDir("localapi-none"), "missing.sock"));
    pinLocalApi({ kind: "tcp", port: api.port ?? 0, token: TOKEN, source: "app-store" });
  }
  let open = true;
  state.close = async () => {
    if (!open) return;
    open = false;
    await api.close();
  };
  servers.push({ close: () => state.close() });
  return state;
}

async function homes(
  config: Record<string, unknown> = { remote: { listen: true } },
  selfAddress?: string,
  log?: (event: Record<string, unknown>) => void,
): Promise<{ a: string; b: string; server: RemoteServer; tailnet: FakeTailnet }> {
  vi.stubEnv("NECTAR_TAILSCALE_BIN", "/bin/false");
  vi.stubEnv("NECTAR_STATIC_SERVER_ENTRY", fileURLToPath(new URL("../src/static-server.ts", import.meta.url)));
  const tailnet = await fakeTailnet(selfAddress);
  const a = await tempDir("remote-a");
  const b = await tempDir("remote-b");
  await writeFile(path.join(a, "nectar.json"), JSON.stringify({ tailnet_host: "nodea" }));
  await writeFile(
    path.join(b, "nectar.json"),
    JSON.stringify({ tailnet_host: "nodeb", upstream_port_start: 4700, upstream_port_end: 4799, ...config }),
  );
  const server = await startRemoteServer(getPaths(b), { address: "127.0.0.1", port: 0, ...(log === undefined ? {} : { log }) });
  servers.push(server);
  vi.stubEnv("NECTAR_REMOTE_PORT", String(server.port));
  return { a, b, server, tailnet };
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

async function caught(promise: Promise<unknown>): Promise<NectarError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NectarError) return error;
    throw error;
  }
  throw new Error("expected a NectarError");
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof NectarError ? error.code : String(error);
  }
}

async function track(home: string, env: string): Promise<void> {
  const record = JSON.parse(await readFile(path.join(home, "envs", `${env}.json`), "utf8")) as { serve?: { pgid: number } };
  if (record.serve !== undefined) pgids.push(record.serve.pgid);
}

function tar(...entries: Buffer[][]): Buffer {
  return Buffer.concat([...entries.flat(), Buffer.alloc(1024)]);
}

async function extract(archive: Buffer, limits?: { maxBytes: number; maxEntries: number }): Promise<{ code: string; root: string; message: string }> {
  const root = await tempDir("extract");
  const target = path.join(root, "tree");
  await mkdir(target);
  try {
    await extractTar(Readable.from([archive]), target, limits);
    return { code: "ok", root, message: "" };
  } catch (error) {
    return { code: error instanceof NectarError ? error.code : String(error), root, message: error instanceof Error ? error.message : "" };
  }
}

describe("tailnet authorization", () => {
  it("allows only the owner's own untagged nodes by default", () => {
    expect(authorize(who(), undefined, OWNER)).toMatchObject({ node_id: "nCLIENT", node_name: "nodea", login: "owner@example.com", operator: true });
    expect(() => authorize(who({ user: 2002, login: "other@example.com" }), undefined, OWNER)).toThrow(expect.objectContaining({ code: "E_FORBIDDEN" }));
    expect(() => authorize(who({ tags: ["tag:ci"] }), undefined, OWNER)).toThrow(expect.objectContaining({ code: "E_FORBIDDEN" }));
    expect(() => authorize(who(), undefined, undefined)).toThrow(expect.objectContaining({ code: "E_FORBIDDEN" }));
    expect(() => authorize(who({ login: "" }), undefined, OWNER)).toThrow(expect.objectContaining({ code: "E_FORBIDDEN" }));
    expect(() => authorize(who({ user: 0 }), undefined, 0)).toThrow(expect.objectContaining({ code: "E_FORBIDDEN" }));
    expect(() => authorize({ ...who(), nodeUserId: 2002 }, undefined, OWNER)).toThrow(expect.objectContaining({ code: "E_FORBIDDEN" }));
    expect(() => authorize({ ...who(), userId: 0 }, undefined, OWNER)).toThrow(expect.objectContaining({ code: "E_FORBIDDEN" }));
  });

  it("fails closed on an empty or malformed allowlist and matches node IDs and logins exactly", () => {
    expect(() => authorize(who(), { allow: [] }, OWNER)).toThrow(expect.objectContaining({ code: "E_FORBIDDEN" }));
    expect(() => authorize(who(), { allow: "everyone" as never }, OWNER)).toThrow(expect.objectContaining({ code: "E_FORBIDDEN" }));
    expect(() => authorize(who(), { allow: [{ node_id: "" }, { login: "" }, "nCLIENT" as never] }, OWNER)).toThrow(expect.objectContaining({ code: "E_FORBIDDEN" }));
    const stranger = who({ id: "nSTRANGER", user: 2002, login: "friend@example.com" });
    expect(authorize(stranger, { allow: [{ node_id: "nSTRANGER" }] }, OWNER)).toMatchObject({ operator: false });
    expect(authorize(stranger, { allow: [{ login: "Friend@example.com" }] }, OWNER)).toMatchObject({ operator: false });
    expect(() => authorize(who({ id: "nTAGGED", tags: ["tag:x"], login: "friend@example.com" }), { allow: [{ login: "friend@example.com" }] }, OWNER)).toThrow(
      expect.objectContaining({ code: "E_FORBIDDEN" }),
    );
  });
});

describe.each<Transport>(["socket", "token port"])("tailnet listener over the LocalAPI %s", (variant) => {
  beforeEach(() => {
    transport = variant;
  });

  it("refuses to bind a wildcard address", async () => {
    await fakeTailnet();
    const home = await tempDir("remote-wild");
    await expect(startRemoteServer(getPaths(home), { address: "0.0.0.0", port: 0 })).rejects.toMatchObject({ code: "E_USAGE" });
    await expect(startRemoteServer(getPaths(home), { address: "::", port: 0 })).rejects.toMatchObject({ code: "E_USAGE" });
  });

  it("asks WhoIs about the raw peer and fails closed when it, the config or the allowlist says no", async () => {
    const { b, tailnet } = await homes();
    const call = (): Promise<unknown> => callRemote("nodeb", "ls", { args: {}, caller: {} });
    expect(await call()).toEqual({ envs: [] });
    expect(tailnet.asked.at(-1)).toMatch(/^127\.0\.0\.1:\d+$/);

    tailnet.identity = undefined;
    const unknown = await caught(call());
    expect(unknown.code).toBe("E_FORBIDDEN");
    expect(unknown.message).toContain("could not identify");
    tailnet.identity = whois({ id: "nOTHER", user: 2002, login: "other@example.com" });
    expect(await caught(call())).toMatchObject({ code: "E_FORBIDDEN", details: { node_id: "nOTHER" } });
    tailnet.identity = whois();

    await writeFile(path.join(b, "nectar.json"), JSON.stringify({ tailnet_host: "nodeb", remote: { listen: true, allow: [] } }));
    await expect(call()).rejects.toMatchObject({ code: "E_FORBIDDEN" });
    await writeFile(path.join(b, "nectar.json"), "{ not json");
    const unreadable = await caught(call());
    expect(unreadable.code).toBe("E_FORBIDDEN");
    expect(unreadable.message).toContain("unreadable");
    await writeFile(path.join(b, "nectar.json"), JSON.stringify({ tailnet_host: "nodeb" }));
    await expect(call()).rejects.toMatchObject({ code: "E_REMOTE" });
    await writeFile(path.join(b, "nectar.json"), JSON.stringify({ tailnet_host: "nodeb", remote: { listen: true } }));
    await expect(callRemote("nodeb", "show", { args: { target: "nectar://nodec/app--main--web" }, caller: {} })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    await expect(callRemote("nodeb", "ls", { args: { path: "/etc" }, caller: {} })).rejects.toMatchObject({ code: "E_USAGE" });
  });

  it("refuses every caller when WhoIs fails, names no node or the LocalAPI stops answering", async () => {
    const { server, tailnet } = await homes();
    const hello = async (): Promise<{ status: number; code: unknown; refused: unknown }> => {
      const reply = await get(`http://127.0.0.1:${server.port}/v1/hello`);
      const envelope = JSON.parse(reply.body) as { error?: { code?: unknown; refused?: unknown } };
      return { status: reply.status, code: envelope.error?.code, refused: envelope.error?.refused };
    };
    expect(await hello()).toMatchObject({ status: 200 });
    const refused = { status: 403, code: "E_FORBIDDEN", refused: "whois" };
    const node = whois().Node as Record<string, unknown>;
    const malformed = [null, [], "text", { Node: null }, { Node: { ...node, StableID: 5 } }, { Node: { ...node, Addresses: "100.64.0.9" } }, { Node: { ...node, Tags: {} } }];
    for (const identity of [undefined, 500, 401, {}, { Node: { StableID: "" } }, ...malformed]) {
      tailnet.identity = identity;
      expect(await hello()).toEqual(refused);
    }
    const profile = whois().UserProfile as Record<string, unknown>;
    for (const identity of [
      { Node: node, UserProfile: { LoginName: profile.LoginName } },
      { Node: { ...node, User: 2002 }, UserProfile: profile },
      { Node: { ...node, User: undefined }, UserProfile: profile },
    ]) {
      tailnet.identity = identity;
      expect(await hello()).toMatchObject({ status: 403, code: "E_FORBIDDEN" });
    }
    tailnet.identity = whois();
    expect(await hello()).toMatchObject({ status: 200 });
    await tailnet.close();
    expect(await hello()).toEqual(refused);
  });

  it("reports the listener in doctor as off, listening, failing WhoIs or not answering", async () => {
    const off = await homes({ remote: { listen: false } }, "127.0.0.1");
    expect(await listenerCheck(getPaths(off.b), { remote: { listen: false } } as never)).toMatchObject({ name: "remote", status: "info", listener: "off" });
    const on = { remote: { listen: true } } as never;
    await off.server.close();
    servers.splice(servers.indexOf(off.server), 1);

    const { b, tailnet } = await homes({ remote: { listen: true } }, "127.0.0.1");
    const discovery = {
      mode: "service" as const,
      at: "t",
      steps: [
        { step: "macsys" as const, outcome: "timeout" as const, ms: 3_000, found: 0 },
        { step: "lsof" as const, outcome: "found" as const, ms: 9, found: 1 },
      ],
      running: null,
      won: { step: "lsof" as const, endpoint: "127.0.0.1:1 (app-store sameuserproof)" },
      next_discovery_in_ms: null,
    };
    const nectard = { api: 1, ops: [], nectar_home: b, pid: 1, remote: { listen: true, listening: true, address: "127.0.0.1", port: 1, last_error: null, whois: null, since: null, discovery } };
    const listening = await listenerCheck(getPaths(b), on, { hello: () => Promise.resolve(nectard) });
    expect(listening).toMatchObject({ name: "remote", status: "pass", listener: "listening", api: "localapi", address: `127.0.0.1:${process.env.NECTAR_REMOTE_PORT}`, nectard_discovery: discovery });
    expect(listening.message).toContain("(nectard's service discovery: macsys timed out after 3s, lsof found 1 (answered))");
    expect(listening).toHaveProperty("discovery");
    expect(listening.localapi).toEqual(transport === "socket" ? expect.stringMatching(/^unix:/) : expect.stringContaining("(app-store sameuserproof)"));
    expect(JSON.stringify(listening)).not.toContain(TOKEN);
    tailnet.identity = 500;
    const whoisBroken = await listenerCheck(getPaths(b), on);
    expect(whoisBroken).toMatchObject({ status: "fail", listener: "failed", api: "localapi" });
    expect(whoisBroken.message).toContain("WhoIs fails inside nectard");
    await tailnet.close();
    const down = await listenerCheck(getPaths(b), on);
    expect(down).toMatchObject({ status: "fail", listener: "failed", api: "localapi", localapi: null });
    expect(down.message).toContain("LocalAPI does not answer");
  });

  it("reports a listener that nothing answers for, with nectard's own reason", async () => {
    const { b } = await homes();
    await mkdir(path.join(b, "logs"), { recursive: true });
    await writeFile(path.join(b, "logs", "nectard.log"), `${JSON.stringify({ event: "remote_unavailable", message: "bind failed" })}\n`);
    const check = await listenerCheck(getPaths(b), { remote: { listen: true } } as never, { hello: () => Promise.resolve(undefined) });
    expect(check).toMatchObject({ status: "fail", listener: "failed", last_event: { event: "remote_unavailable" } });
    expect(check.message).toContain(`nothing answers on 127.0.0.3:${process.env.NECTAR_REMOTE_PORT}`);
    expect(check.message).toContain("nectard does not answer on its control socket");
    expect(check.message).toContain("nectard logged: bind failed");
    const older = { api: 1, ops: [], nectar_home: b, pid: 4242, program: "/opt/old/dist/cli.js" };
    const stale = await listenerCheck(getPaths(b), { remote: { listen: true } } as never, { hello: () => Promise.resolve(older) });
    expect(stale.message).toContain("nectard (pid 4242, /opt/old/dist/cli.js) does not report a tailnet listener, so it runs an older nectar build");
    const off = { ...older, remote: { listen: false, listening: false, address: null, port: 8441, last_error: null, whois: null, since: null } };
    expect((await listenerCheck(getPaths(b), { remote: { listen: true } } as never, { hello: () => Promise.resolve(off) })).message).toContain("read remote.listen as off");
  });

  it("refuses callers on its own node, by address or by node ID", async () => {
    const { tailnet } = await homes({ remote: { listen: true } }, "127.0.0.1");
    const local = await caught(callRemote("nodeb", "ls", { args: {}, caller: {} }));
    expect(local.code).toBe("E_FORBIDDEN");
    expect(local.message).toContain("control socket");
    tailnet.identity = whois({ id: "nSELF" });
    expect(await codeOf(callRemote("nodeb", "ls", { args: {}, caller: {} }))).toBe("E_FORBIDDEN");
  });

  it("maps a missing node to E_NOT_FOUND and a node without a listener to E_REMOTE with the install hint", async () => {
    const { server } = await homes();
    await expect(callRemote("nodez", "ls", { args: {}, caller: {} })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(await caught(callRemote("nodeb", "ls", { args: {}, caller: {} }))).toMatchObject({ code: "E_REMOTE", details: { hint: "on nodeb: nectar daemon install --remote" } });
    const service = new NectarService(await tempDir("remote-fallback"));
    expect(await codeOf(service.resolve("nectar://nodeb/app--main--web"))).toBe("E_REMOTE");
  });

  it("publishes a static dir on another node, resolves, shows, lists, touches and removes it by ref", async () => {
    const { a, b } = await homes();
    const site = path.join(await tempDir("remote-src"), "demo site");
    await mkdir(path.join(site, "css"), { recursive: true });
    await writeFile(path.join(site, "index.html"), "<h1>shipped</h1>");
    await writeFile(path.join(site, "css", "app.css"), "h1{}");
    await writeFile(path.join(site, ".env"), "SECRET=1");
    vi.stubEnv("HIVE_BEE", "bee-7");
    const client = new NectarService(a);
    const published = (await client.publish({ repo: site, host: "nodeb", branch: "review" })) as { env: string; ref: string; urls: { local: string } };
    expect(published).toMatchObject({ env: "demo-site--review--web", ref: "nectar://nodeb/demo-site--review--web" });
    await track(b, published.env);
    expect(await get(published.urls.local)).toEqual({ status: 200, body: "<h1>shipped</h1>" });
    expect(await get(`${published.urls.local}/css/app.css`)).toMatchObject({ status: 200 });
    expect(await get(`${published.urls.local}/.env`)).toMatchObject({ status: 404 });
    expect(JSON.stringify(published)).not.toContain(b);
    expect(await readdir(path.join(a, "envs")).catch(() => [])).toEqual([]);

    const record = JSON.parse(await readFile(path.join(b, "envs", `${published.env}.json`), "utf8")) as { publisher: Record<string, unknown>; repo: string };
    expect(record.publisher).toMatchObject({ via: "tailnet", node: "nCLIENT", node_name: "nodea", login: "owner@example.com", hive_bee: "bee-7", user: os.userInfo().username });
    expect(record.repo.startsWith(path.join(b, "inbox"))).toBe(true);

    const resolved = (await client.resolve(published.ref)) as { is_self: boolean; urls: { local: string }; host: string };
    expect(resolved).toMatchObject({ is_self: false, host: "nodeb", urls: { local: published.urls.local } });
    const shown = await client.show(published.ref);
    const text = JSON.stringify(shown);
    for (const leak of [b, "bee-7", "owner@example.com", "nCLIENT", '"cmd"', '"pgid"', "worktree", "hive_session"]) expect(text).not.toContain(leak);
    expect(shown).toMatchObject({ name: published.env, env: { publisher: { via: "tailnet", node_name: "nodea" } } });
    expect(await client.list({ host: "nodeb" })).toMatchObject({ envs: [{ name: published.env }] });
    expect(JSON.stringify(await client.list({ host: "nodeb" }))).not.toContain("bee-7");
    expect(await client.touch(published.ref, "2d")).toMatchObject({ envs: [published.env] });

    const again = (await client.publish({ repo: site, host: "nodeb", branch: "review" })) as { env: string; urls: { local: string } };
    await track(b, again.env);
    expect(again.env).toBe(published.env);
    expect(await codeOf(client.remove(published.ref))).toBe("E_USAGE");
    expect(await client.remove(published.ref, true)).toMatchObject({ removed: true });
    expect(await readdir(path.join(b, "inbox"))).toEqual([]);
  });

  it("ships only the committed tree of a repo, never .git, and publishes its recipe there", async () => {
    const { a, b } = await homes();
    const repo = path.join(await tempDir("remote-repo"), "webapp");
    await mkdir(repo, { recursive: true });
    const git = async (...args: string[]): Promise<void> => {
      const result = await runCommand("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    };
    await git("init", "-q", "-b", "main");
    await writeFile(path.join(repo, "nectar.toml"), '[web]\nserve = "exec node server.mjs"\nready_path = "/"\n');
    await writeFile(
      path.join(repo, "server.mjs"),
      'import http from "node:http";\nimport { readFileSync } from "node:fs";\nhttp.createServer((q, r) => r.end(readFileSync("page.txt", "utf8"))).listen(Number(process.env.PORT), "127.0.0.1");\n',
    );
    await writeFile(path.join(repo, "page.txt"), "committed\n");
    await writeFile(path.join(repo, ".gitignore"), "page.txt\n");
    await git("add", "-A", "-f");
    await git("commit", "-qm", "first");
    await git("config", "core.secret", "do-not-ship");
    await writeFile(path.join(repo, "page.txt"), "dirty\n");
    const client = new NectarService(a);
    const published = (await client.publish({ repo, host: "nodeb" })) as { env: string; ref: string; urls: { local: string } };
    expect(published).toMatchObject({ env: "webapp--main--web", ref: "nectar://nodeb/webapp--main--web" });
    await track(b, published.env);
    expect(await get(published.urls.local)).toEqual({ status: 200, body: "committed\n" });
    const inbox = path.join(b, "inbox");
    const [key] = await readdir(inbox);
    const config = await readFile(path.join(inbox, key ?? "", "webapp", ".git", "config"), "utf8");
    expect(config).not.toContain("do-not-ship");
    await expect(client.publish({ repo, host: "nodeb", worktree: repo })).rejects.toMatchObject({ code: "E_USAGE" });
    const clone = path.join(path.dirname(repo), "cell2", "webapp");
    await mkdir(path.dirname(clone), { recursive: true });
    expect((await runCommand("git", ["clone", "-q", repo, clone])).exitCode).toBe(0);
    await writeFile(path.join(clone, "page.txt"), "from the second checkout\n");
    expect((await runCommand("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qam", "second"], { cwd: clone })).exitCode).toBe(0);
    const moved = (await client.publish({ repo: clone, host: "nodeb" })) as { env: string; urls: { local: string } };
    await track(b, moved.env);
    expect(moved.env).toBe(published.env);
    expect(await get(moved.urls.local)).toEqual({ status: 200, body: "from the second checkout\n" });
    expect(await readdir(path.join(b, "inbox"))).toHaveLength(1);
    const other = path.join(path.dirname(repo), "other", "webapp");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "index.html"), "static");
    const clash = await caught(client.publish({ repo: other, host: "nodeb", branch: "main", mode: "static", name: "webapp" }));
    expect(clash.code).toBe("E_USAGE");
    expect(clash.message).not.toContain(b);
    expect(clash.message).not.toContain(path.dirname(repo));
    expect(clash.details).not.toHaveProperty("existing_repo");
    expect(await client.remove(published.ref, true)).toMatchObject({ removed: true });
  });

  it("keeps the operator's own checkout paths out of a peer's error", async () => {
    const { a, b } = await homes();
    const secret = path.join(await tempDir("operator-secret"), "My Projects", "webapp");
    await mkdir(secret, { recursive: true });
    await writeFile(path.join(secret, "index.html"), "operator");
    const local = (await new NectarService(b).publish({ repo: secret, branch: "main" })) as { env: string };
    await track(b, local.env);
    const mine = path.join(await tempDir("remote-clash"), "other");
    await mkdir(mine);
    await writeFile(path.join(mine, "index.html"), "peer");
    const clash = await caught(new NectarService(a).publish({ repo: mine, host: "nodeb", branch: "main", name: "webapp" }));
    expect(clash.code).toBe("E_USAGE");
    expect(clash.message).not.toContain(secret);
    expect(clash.message).not.toContain("Projects");
    expect(clash.message).toContain("published from <path>");
    expect(await new NectarService(b).remove(local.env, true)).toMatchObject({ removed: true });
  });

  it("lets an allowlisted foreign node change only its own envs", async () => {
    const { a, b, tailnet } = await homes({ remote: { listen: true, allow: [{ node_id: "nCLIENT" }, { node_id: "nFRIEND" }] } });
    const site = path.join(await tempDir("remote-own"), "mine");
    await mkdir(site);
    await writeFile(path.join(site, "index.html"), "x");
    const client = new NectarService(a);
    const published = (await client.publish({ repo: site, host: "nodeb", branch: "main" })) as { env: string; ref: string };
    await track(b, published.env);
    const before = JSON.parse(await readFile(path.join(b, "envs", `${published.env}.json`), "utf8")) as { expires_at: string };
    tailnet.identity = whois({ id: "nFRIEND", name: "friend", user: 2002, login: "friend@example.com" });
    expect(await client.resolve(published.ref)).toMatchObject({ env: published.env, touched: false });
    expect(await client.show(published.ref)).toMatchObject({ name: published.env, touched: false });
    const after = JSON.parse(await readFile(path.join(b, "envs", `${published.env}.json`), "utf8")) as { expires_at: string };
    expect(after.expires_at).toBe(before.expires_at);
    expect(await codeOf(client.touch(published.ref))).toBe("E_FORBIDDEN");
    expect(await codeOf(client.stop(published.ref))).toBe("E_FORBIDDEN");
    expect(await codeOf(client.remove(published.ref, true))).toBe("E_FORBIDDEN");
    tailnet.identity = whois();
    expect(await client.remove(published.ref, true)).toMatchObject({ removed: true });
  });

  it("refuses a malicious archive and writes nothing outside the inbox", async () => {
    const { b } = await homes();
    const outside = path.join(b, "escaped.txt");
    const send = (archive: Buffer): Promise<unknown> =>
      callRemote("nodeb", "publish", { args: { kind: "static", source: "/x", dir: "evil", branch: "main" }, caller: {} }, zlib.gzipSync(archive));
    await expect(send(tar(tarEntry("../../escaped.txt", Buffer.from("pwned"))))).rejects.toMatchObject({ code: "E_USAGE", details: { refused: "archive" } });
    await expect(send(tar(tarEntry("link", Buffer.alloc(0), 0o777, "2", "../../.."), tarEntry("link/escaped.txt", Buffer.from("x"))))).rejects.toMatchObject({ code: "E_USAGE" });
    await expect(send(Buffer.from("not gzip at all"))).rejects.toMatchObject({ code: "E_USAGE" });
    await expect(
      callRemote("nodeb", "publish", { args: { kind: "static", source: "/x", dir: "../up", branch: "main" }, caller: {} }, zlib.gzipSync(tar(tarEntry("index.html", Buffer.from("x"))))),
    ).rejects.toMatchObject({ code: "E_USAGE" });
    expect(await lstat(outside).catch(() => undefined)).toBeUndefined();
    expect(await readdir(path.join(b, "inbox")).catch(() => [])).toEqual([]);
    expect(await readdir(path.join(b, "envs")).catch(() => [])).toEqual([]);
  });
});

describe("archive defences", () => {
  it("unpacks plain files, directories, long names and inner symlinks", async () => {
    const long = `${"d".repeat(80)}/${"f".repeat(80)}.txt`;
    const result = await extract(
      tar(
        tarEntry("./site/", Buffer.alloc(0), 0o755, "5"),
        tarEntry("site/index.html", Buffer.from("hi")),
        tarEntry("site/run.sh", Buffer.from("#!/bin/sh"), 0o4755),
        tarEntry(long, Buffer.from("long")),
        tarEntry("site/alias.html", Buffer.alloc(0), 0o777, "2", "index.html"),
      ),
    );
    expect(result.code).toBe("ok");
    const tree = path.join(result.root, "tree");
    expect(await readFile(path.join(tree, long), "utf8")).toBe("long");
    expect(await readFile(path.join(tree, "site", "alias.html"), "utf8")).toBe("hi");
    expect((await lstat(path.join(tree, "site", "run.sh"))).mode & 0o7777).toBe(0o755);
  });

  it.each([
    ["an absolute path", [tarEntry("/etc/passwd", Buffer.from("x"))]],
    ["a parent path", [tarEntry("a/../../b", Buffer.from("x"))]],
    ["a .git directory", [tarEntry("sub/.git/config", Buffer.from("[core]"))]],
    ["a .GIT directory", [tarEntry(".GIT/hooks/pre-commit", Buffer.from("x"))]],
    ["an absolute symlink", [tarEntry("l", Buffer.alloc(0), 0o777, "2", "/etc/passwd")]],
    ["an escaping symlink", [tarEntry("a/l", Buffer.alloc(0), 0o777, "2", "../../secret")]],
    ["a symlink into .git", [tarEntry("l", Buffer.alloc(0), 0o777, "2", ".git/config")]],
    ["a write through a symlink", [tarEntry("dir", Buffer.alloc(0), 0o777, "2", "."), tarEntry("dir/x", Buffer.from("x"))]],
    ["a chained symlink escape", [tarEntry("q", Buffer.alloc(0), 0o777, "2", "."), tarEntry("s", Buffer.alloc(0), 0o777, "2", "q/.."), tarEntry("index.html", Buffer.from("x"))]],
    ["a dangling symlink", [tarEntry("l", Buffer.alloc(0), 0o777, "2", "missing")]],
    ["a hard link", [tarEntry("a", Buffer.from("x")), tarEntry("b", Buffer.alloc(0), 0o644, "1", "a")]],
    ["a character device", [tarEntry("tty", Buffer.alloc(0), 0o644, "3")]],
    ["a block device", [tarEntry("sda", Buffer.alloc(0), 0o644, "4")]],
    ["a FIFO", [tarEntry("pipe", Buffer.alloc(0), 0o644, "6")]],
    ["a duplicate entry", [tarEntry("a", Buffer.from("x")), tarEntry("a", Buffer.from("y"))]],
  ])("refuses %s", async (_label, entries) => {
    const result = await extract(tar(...entries));
    expect(result.code).toBe("E_USAGE");
    expect(result.message).toMatch(/^Archive refused/);
    expect(await lstat(path.join(result.root, "secret")).catch(() => undefined)).toBeUndefined();
  });

  it("refuses a corrupt header, a truncated stream and archives over the size or entry caps", async () => {
    const corrupt = tar(tarEntry("a", Buffer.from("x")));
    corrupt[0] = "b".charCodeAt(0);
    expect((await extract(corrupt)).message).toContain("checksum");
    expect((await extract(tar(tarEntry("a", Buffer.alloc(4096))).subarray(0, 1024))).message).toContain("truncated");
    expect((await extract(tar(tarEntry("a", Buffer.alloc(2048))), { maxBytes: 1024, maxEntries: 10 })).message).toContain("1024 bytes");
    expect((await extract(tar(tarEntry("a", Buffer.from("1")), tarEntry("b", Buffer.from("2"))), { maxBytes: 1024, maxEntries: 1 })).message).toContain("1 entries");
  });
});

describe("peer redaction", () => {
  it("keeps paths, bee ids, serve commands, deps credentials and log tails out of remote views", () => {
    const root = "/home/u/.nectar";
    const env = {
      eid: "e1",
      name: "app--main--web",
      mode: "web",
      app: "app",
      repo: "/home/u/.hive/v2/cells/c1/space/app",
      branch: "main",
      commit: "abc",
      worktree: `${root}/work/app--main--web`,
      status: "crashed",
      serve: { cmd: "DATABASE_URL=postgres://u:hunter2@x exec node", pid: 1, pgid: 1 },
      urls: { local: "http://127.0.0.1:4100", mesh: null },
      ref: "nectar://nodeb/app--main--web",
      publisher: { user: "u", via: "nectard", cell: "/home/u/.hive/v2/cells/c1", hive_bee: "bee-1", hive_session: "s-1", node: "nX", login: "a@b" },
      failure: { code: "E_SERVE_TIMEOUT", message: `see ${root}/logs`, failed_at: "t", log_tail: ["PASSWORD=hunter2"] },
      deps: { db: { kind: "postgres", env: "DATABASE_URL", created_at: "t", user: "app", port: 5432, project: "nectar-app" } },
      install_hash: "h",
    };
    const shown = peerView("show", { env, name: env.name, ports: { upstream: 4100, tailnet: 8443 }, deps: { db: { ...env.deps.db, url: "postgres://app:***@127.0.0.1:5432/app" } }, failure: env.failure, log_tail: ["PASSWORD=hunter2"], serve: env.serve, pid: 1 }, root);
    const listed = peerView("ls", { envs: [{ name: env.name, publisher_bee: "bee-1", status: "crashed" }] }, root);
    const resolved = peerView("resolve", { env: env.name, log_tail: ["PASSWORD=hunter2"], urls: env.urls }, root);
    const multi = peerView("resolve", { env: "app", resolutions: [{ env: env.name, log_tail: ["PASSWORD=hunter2"] }] }, root);
    const published = peerView(
      "publish",
      { env: env.name, source: `${root}/inbox/k/app`, warnings: [`skipped 1 symlink(s) while copying ${root}/inbox/k/app`, "see /home/u/.hive/v2/cells/c1/log, ~/code/app, file:///home/u/app and https://x.ts.net:8443/a"], deps: { db: env.deps.db } },
      root,
    );
    const text = JSON.stringify([shown, listed, resolved, multi, published]);
    for (const leak of ["hunter2", "bee-1", "s-1", "/home/u", "cells", '"cmd"', "nectar-app", "5432", "a@b", "nX", "install_hash", "log_tail", "DATABASE_URL"]) {
      expect(text).not.toContain(leak);
    }
    expect(shown).toMatchObject({ env: { name: env.name, publisher: { via: "nectard" }, deps: { db: { kind: "postgres" } }, failure: { code: "E_SERVE_TIMEOUT" } }, ports: { tailnet: 8443 } });
    expect(published).toMatchObject({ warnings: ["skipped 1 symlink(s) while copying $NECTAR_HOME/inbox/k/app", "see <path>, <path>, <path> and https://x.ts.net:8443/a"] });
  });
});

describe("tailnet listener startup", () => {
  type Event = Record<string, unknown>;
  const SELF = { ID: "nSELF", HostName: "nodeself", UserID: OWNER };
  const running = (ips: string[]): Record<string, unknown> => ({ BackendState: "Running", Self: { ...SELF, TailscaleIPs: ips } });

  async function localApi(status: () => unknown, identity: (addr: string) => unknown = () => whois({ id: "nSELF" })): Promise<void> {
    const api = await fakeLocalApi({ socket: path.join(await tempDir("localapi"), "tailscaled.sock") }, { status, whois: identity });
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", api.socket ?? "");
    servers.push(api);
  }

  async function listener(options: { port?: number; deadlineMs?: number } = {}): Promise<{ events: Event[]; listener: RemoteListener; home: string }> {
    const home = await tempDir("listener");
    await writeFile(path.join(home, "nectar.json"), JSON.stringify({ remote: { listen: true } }));
    const events: Event[] = [];
    const started = startRemoteListener(getPaths(home), (event) => events.push(event), { port: options.port ?? 0, retryMs: 40, deadlineMs: options.deadlineMs ?? 2_000 });
    servers.push(started);
    return { events, listener: started, home };
  }

  async function until(events: Event[], wanted: (event: Event) => boolean): Promise<Event> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = events.find(wanted);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`no such event in ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("logs remote_listen_failed while tailscale is not Running, then listens once it is", async () => {
    let state = "Starting";
    await localApi(() => ({ ...running(["127.0.0.1", "fd7a::5"]), BackendState: state }));
    const { events, listener: started } = await listener();
    const failed = await until(events, (event) => event.event === "remote_listen_failed");
    expect(failed).toMatchObject({ reason: "not_running", backend_state: "Starting", ips: ["127.0.0.1", "fd7a::5"], retry_in_ms: 40 });
    expect(failed.endpoint).toMatch(/^unix:/);
    expect(started.state()).toMatchObject({ listen: true, listening: false });
    expect(started.state().last_error).toContain("tailscale is Starting here, not Running");
    state = "Running";
    const listening = await until(events, (event) => event.event === "remote_listen");
    expect(listening).toMatchObject({ address: "127.0.0.1", api: "localapi", whois: "ready" });
    expect(listening.discovery).toBe("interactive discovery: env found 1 (answered)");
    expect(events.find((event) => event.event === "remote_status" && event.backend_state === "Running")).toMatchObject({ ipv4: "127.0.0.1" });
    expect(started.state()).toMatchObject({ listening: true, address: "127.0.0.1", last_error: null, whois: null });
    await started.close();
    expect(events.at(-1)).toMatchObject({ event: "remote_listen_closed", reason: "shutdown" });
  });

  it("names an IPv6-only node and logs each repeated failure only once in a while", async () => {
    await localApi(() => running(["fd7a:115c:a1e0::1"]));
    const { events, listener: started } = await listener();
    const failed = await until(events, (event) => event.event === "remote_listen_failed");
    expect(failed).toMatchObject({ reason: "ipv6_only", ips: ["fd7a:115c:a1e0::1"] });
    expect(failed.message).toContain("only IPv6 tailnet addresses");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events.filter((event) => event.event === "remote_listen_failed")).toHaveLength(1);
    expect(started.state().listening).toBe(false);
  });

  it("logs an unreachable LocalAPI and a status read that never finishes, and retries both", async () => {
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", path.join(await tempDir("localapi-none"), "missing.sock"));
    const first = await listener();
    expect(await until(first.events, (event) => event.event === "remote_listen_failed")).toMatchObject({ reason: "localapi_unreachable" });
    await first.listener.close();

    const socket = path.join(await tempDir("localapi-hang"), "tailscaled.sock");
    const hanging = http.createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(socket, resolve));
    servers.push({ close: () => new Promise<void>((resolve) => { hanging.closeAllConnections(); hanging.close(() => resolve()); }) });
    vi.stubEnv("NECTAR_TAILSCALE_SOCKET", socket);
    const { events, listener: started } = await listener({ deadlineMs: 300 });
    const waiting = started.state();
    expect(waiting).toMatchObject({ listening: false, last_reason: null });
    expect(waiting.last_error).toMatch(/^nectard has not finished its first tailnet status read \(\d+s so far; interactive discovery: /);
    const failed = await until(events, (event) => event.event === "remote_listen_failed");
    expect(failed).toMatchObject({ reason: "status_timeout", discovery: { steps: [{ step: "env", outcome: "found" }] } });
    expect(failed.message).toContain("did not finish within 0.3s");
    expect(failed.message).toContain("interactive discovery: env found 1");
    const shown = remoteStatus({ remote: { listen: true } } as never, { pid: 1, nectar_home: "/h", remote: started.state() });
    expect(shown).toMatchObject({ listening: false, last_reason: "status_timeout", last_error: failed.message, discovery: { mode: "interactive" } });
  });

  it("logs a bind failure with its errno and listens once the port is free", async () => {
    await localApi(() => running(["127.0.0.1"]));
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
    const port = (holder.address() as net.AddressInfo).port;
    const { events, listener: started } = await listener({ port });
    const failed = await until(events, (event) => event.event === "remote_listen_failed");
    expect(failed).toMatchObject({ reason: "bind", code: "EADDRINUSE", address: "127.0.0.1", port });
    expect(failed.message).toContain("another process holds that port");
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    expect(await until(events, (event) => event.event === "remote_listen")).toMatchObject({ address: "127.0.0.1", port });
    expect(started.state()).toMatchObject({ listening: true, port });
  });

  it("reports WhoIs that fails inside nectard, and when it recovers", async () => {
    let broken = true;
    await localApi(() => running(["127.0.0.1"]), () => (broken ? 500 : whois({ id: "nSELF" })));
    const { events, listener: started } = await listener();
    const listening = await until(events, (event) => event.event === "remote_listen");
    expect(listening.whois).toContain("whois answered 500");
    expect(started.state().last_error).toContain("WhoIs does not work inside nectard");
    broken = false;
    await until(events, (event) => event.event === "remote_whois_ready");
    expect(started.state()).toMatchObject({ listening: true, whois: null, last_error: null });
  });

  it("restarts on a new tailnet address and logs the close", async () => {
    let address = "127.0.0.1";
    await localApi(() => running([address]));
    const { events, listener: started } = await listener();
    await until(events, (event) => event.event === "remote_listen");
    address = "127.0.0.2";
    expect(await until(events, (event) => event.event === "remote_listen_closed")).toMatchObject({ reason: "address_changed", address: "127.0.0.1", to: "127.0.0.2" });
    expect(await until(events, (event) => event.event === "remote_listen" && event.address === "127.0.0.2")).toBeDefined();
    expect(started.state().address).toBe("127.0.0.2");
  });

  it("logs that the listener is off when nectard starts with remote.listen off", () => {
    const events: Event[] = [];
    const off = startRemoteListener(getPaths("/nonexistent/home"), (event) => events.push(event), { listen: false });
    expect(events).toEqual([expect.objectContaining({ event: "remote_listen_off", config: "/nonexistent/home/nectar.json" })]);
    expect(off.state()).toMatchObject({ listen: false, listening: false });
  });

  it("puts listening, address and last_error in daemon status", () => {
    const on = { remote: { listen: true } } as never;
    const state = { listen: true, listening: true, address: "100.64.0.1", port: 8441, last_error: null, whois: null, since: null };
    expect(remoteStatus(on, { pid: 1, nectar_home: "/h", remote: state })).toEqual({ listen: true, port: 8441, listening: true, address: "100.64.0.1", last_error: null, last_reason: null, discovery: null });
    expect(remoteStatus(on, null)).toMatchObject({ listening: false, address: null, last_error: "nectard does not answer on its control socket" });
    expect(remoteStatus(on, { pid: 9, nectar_home: "/h", program: null, remote: null }).last_error).toContain("runs an older nectar build");
    expect(remoteStatus({ remote: { listen: false } } as never, null)).toMatchObject({ listen: false, listening: false, last_error: null });
  });
});

describe("tailnet refusal log", () => {
  it("logs every refusal with the node, its tags and the rule, never the self-check as a refusal, and doctor counts them", async () => {
    transport = "socket";
    const events: Record<string, unknown>[] = [];
    let log: (event: Record<string, unknown>) => void = (event) => events.push(event);
    const { b, tailnet } = await homes({ remote: { listen: true } }, "127.0.0.3", (event) => log(event));
    const paths = getPaths(b);
    await mkdir(paths.logs, { recursive: true });
    const file = daemonLogger(paths, 10_000_000, () => undefined);
    log = (event) => {
      events.push(event);
      file(event);
    };
    const cases: Array<[unknown, Record<string, unknown>, string, string]> = [
      [whois({ id: "nTAGGED", name: "ci", tags: ["tag:ci"] }), { listen: true }, "remote_refused", "tagged"],
      [whois({ id: "nOTHER", name: "laptop", user: 2002, login: "other@example.com" }), { listen: true }, "remote_refused", "not_owner"],
      [whois({ id: "nFRIEND" }), { listen: true, allow: [] }, "remote_refused", "allow_empty"],
      [whois({ id: "nFRIEND" }), { listen: true, allow: [{ node_id: "nSOMEONE" }] }, "remote_refused", "not_in_allow"],
      [500, { listen: true }, "remote_refused", "whois_failed"],
      [whois({ id: "nSELF" }), { listen: true }, "remote_self_check", "self"],
    ];
    for (const [identity, remote] of cases) {
      tailnet.identity = identity;
      await writeFile(path.join(b, "nectar.json"), JSON.stringify({ tailnet_host: "nodeb", remote }));
      expect(await codeOf(callRemote("nodeb", "ls", { args: {}, caller: {} }))).toBe("E_FORBIDDEN");
    }
    const refusals = events.filter((event) => event.event === "remote_refused" || event.event === "remote_self_check");
    expect(refusals.map((event) => [event.event, event.rule])).toEqual(cases.map(([, , event, rule]) => [event, rule]));
    expect(refusals[0]).toMatchObject({ node_name: "ci", node_id: "nTAGGED", tags: ["tag:ci"], login: "owner@example.com", peer_address: "127.0.0.1" });
    expect(refusals[1]).toMatchObject({ node_id: "nOTHER", login: "other@example.com", user_id: 2002, node_user_id: 2002, owner: OWNER, tags: [] });
    expect(refusals[4]).toMatchObject({ node_id: null });
    expect(refusals[4]?.whois).toContain("whois answered 500");

    await new Promise((resolve) => setTimeout(resolve, 50));
    const check = await listenerCheck(paths, { remote: { listen: true } } as never, { hello: () => Promise.resolve(undefined) });
    expect(check).toMatchObject({ refusals: { count: 5, window_hours: 24, last: { rule: "whois_failed", node_id: null } } });
  });
});
