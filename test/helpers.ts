import path from "node:path";
import os from "node:os";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { vi } from "vitest";
import { stopProcessGroup, runCommand } from "../src/commands.js";
import type { EnvRecord, Mode } from "../src/types.js";
import type { Relayd, RelaydDeps } from "../src/relayd.js";

const createdTempDirs: string[] = [];

export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `nectar-${prefix}-`));
  createdTempDirs.push(dir);
  return dir;
}

// Registered as an afterAll in test/setup.ts — without it every run leaks
// state/repo/fake-bin trees into os.tmpdir() forever.
export async function cleanupTempDirs(): Promise<void> {
  for (const dir of createdTempDirs.splice(0)) {
    const shared = await readFile(path.join(dir, "shared-static.json"), "utf8").then((text) => JSON.parse(text) as { pid: number }).catch(() => undefined);
    if (shared !== undefined) await stopProcessGroup(shared.pid).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function record(overrides: Partial<EnvRecord> = {}): EnvRecord {
  const now = "2026-07-18T12:00:00.000Z";
  const mode: Mode = overrides.mode ?? "web";
  const name = overrides.name ?? `demo--main--${mode}`;
  return {
    eid: "e7f3",
    name,
    mode,
    app: "demo",
    repo: "/tmp/demo",
    branch: "main",
    commit: "12345678",
    worktree: `/tmp/${name}`,
    borrowed_worktree: false,
    status: "serving",
    urls: { local: "http://127.0.0.1:4100", mesh: "https://demo.example.ts.net:8443" },
    ref: `nectar://demo/${name}`,
    published_at: now,
    expires_at: "2026-07-21T12:00:00.000Z",
    last_touched_at: now,
    publisher: { user: "tester" },
    evidence: [],
    ...overrides,
  };
}

export async function initGitRepo(files: Record<string, string>): Promise<string> {
  const repo = await tempDir("repo");
  const initialized = await runCommand("git", ["init", "-b", "main"], { cwd: repo });
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
  await runCommand("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await runCommand("git", ["config", "user.name", "Nectar Test"], { cwd: repo });
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(repo, name);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(file), { recursive: true }));
    await writeFile(file, contents);
  }
  await runCommand("git", ["add", "."], { cwd: repo });
  const committed = await runCommand("git", ["commit", "-m", "test fixture"], { cwd: repo });
  if (committed.exitCode !== 0) throw new Error(committed.stderr);
  return repo;
}

export async function fakeExecutable(directory: string, name: string, source: string): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\n${source}\n`);
  await chmod(file, 0o755);
  return file;
}

export async function fakeActiveOwner(directory: string): Promise<void> {
  await fakeExecutable(directory, "hive", `echo '[{"id":"fixture-active","status":"running"}]'`);
  vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("HIVE_BEE", "fixture-active");
}

export async function fakeTailscale(directory: string): Promise<{ binary: string; log: string }> {
  const log = path.join(directory, "tailscale.log");
  const binary = await fakeExecutable(
    directory,
    "tailscale",
    `
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  if [ "$FAKE_TS_DOWN" = "1" ]; then
    printf '{"BackendState":"Stopped"}\\n'
  else
    printf '{"BackendState":"Running","Self":{"DNSName":"fixture.tailtest.ts.net."}}\\n'
  fi
  exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "status" ]; then
  if [ -n "$FAKE_TS_SERVE_STATUS" ]; then
    printf '%s\\n' "$FAKE_TS_SERVE_STATUS"
  else
    printf '{}\\n'
  fi
  exit 0
fi
if [ "$1" = "ssh" ]; then
  if [ "$FAKE_TS_SSH_FAIL" = "1" ]; then
    printf 'offline\\n' >&2
    exit 1
  fi
  if [ -n "$FAKE_TS_SSH_RESPONSE" ]; then
    printf '%s\\n' "$FAKE_TS_SSH_RESPONSE"
    exit 0
  fi
fi
printf '%s\\n' "$*" >> "$FAKE_TS_LOG"
exit 0
`,
  );
  return { binary, log };
}

export async function fakeServiceManager(directory: string): Promise<{ calls: string; home: string }> {
  const calls = path.join(directory, "service-manager.log");
  const home = path.join(directory, "home");
  const state = path.join(directory, "unit-active");
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  vi.stubEnv(
    "NECTAR_SYSTEMCTL_BIN",
    await fakeExecutable(
      directory,
      "systemctl",
      `echo "systemctl $*" >> '${calls}'
case "$2" in
  restart) : > '${state}' ;;
  disable) rm -f '${state}' ;;
  is-active) if [ -f '${state}' ]; then echo active; else echo inactive; exit 3; fi ;;
  show) if [ -f '${state}' ]; then printf 'ActiveState=active\nMainPID=%s\n' "$PPID"; else printf 'ActiveState=inactive\nMainPID=0\n'; fi ;;
esac
exit 0`,
    ),
  );
  vi.stubEnv("NECTAR_LOGINCTL_BIN", await fakeExecutable(directory, "loginctl", `echo "Linger=yes"`));
  vi.stubEnv(
    "NECTAR_LAUNCHCTL_BIN",
    await fakeExecutable(
      directory,
      "launchctl",
      `echo "launchctl $*" >> '${calls}'
case "$1" in
  bootstrap) : > '${state}' ;;
  bootout) rm -f '${state}' ;;
  print) if [ -f '${state}' ]; then printf 'state = running\npid = %s\n' "$PPID"; else exit 113; fi ;;
esac
exit 0`,
    ),
  );
  return { calls, home };
}

export async function statefulTailscale(directory: string, initial: unknown = {}): Promise<{ binary: string; log: string; state: string }> {
  const log = path.join(directory, "tailscale-calls.log");
  const state = path.join(directory, "serve-state.json");
  const binary = path.join(directory, "tailscale-stateful");
  await writeFile(state, JSON.stringify(initial));
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
if (args[0] === "status") {
  console.log(JSON.stringify({ BackendState: "Running", Self: { DNSName: "fixture.tailtest.ts.net." } }));
} else if (args[0] === "serve" && args[1] === "status") {
  console.log(JSON.stringify(read()));
} else if (args[0] === "serve") {
  const port = (args.find((arg) => arg.startsWith("--https=")) ?? "").slice(8);
  const target = args[args.length - 1];
  const current = read();
  if (target === "off") {
    const mount = (args.find((arg) => arg.startsWith("--set-path=")) ?? "--set-path=/").slice(11);
    for (const key of Object.keys(current.Web ?? {})) {
      if (!key.endsWith(":" + port)) continue;
      delete current.Web[key].Handlers[mount];
      if (Object.keys(current.Web[key].Handlers).length === 0) {
        delete current.Web[key];
        if (current.TCP) delete current.TCP[port];
        if (current.AllowFunnel) delete current.AllowFunnel[key];
      }
    }
  } else {
    current.TCP = { ...current.TCP, [port]: { HTTPS: true } };
    current.Web = { ...current.Web, ["fixture.tailtest.ts.net:" + port]: { Handlers: { "/": { Proxy: target } } } };
  }
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(current));
}
`,
  );
  await chmod(binary, 0o755);
  vi.stubEnv("NECTAR_TAILSCALE_BIN", binary);
  return { binary, log, state };
}

export interface FakeDockerState {
  containers: Array<{ id: string; name: string; labels: Record<string, string>; running: boolean }>;
  volumes: Array<{ name: string; labels: Record<string, string> }>;
  networks: Array<{ id: string; name: string; labels: Record<string, string> }>;
}

export async function fakeDocker(directory: string, seed: FakeDockerState = { containers: [], volumes: [], networks: [] }): Promise<{
  binary: string;
  log: string;
  stateFile: string;
  read: () => Promise<FakeDockerState>;
}> {
  const log = path.join(directory, "docker.log");
  const stateFile = path.join(directory, "docker-state.json");
  await writeFile(stateFile, JSON.stringify(seed));
  const binary = path.join(directory, "docker");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (process.env.FAKE_DOCKER_DOWN) {
  process.stderr.write("permission denied while trying to connect to the docker API at unix:///var/run/docker.sock\\n");
  process.exit(1);
}
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
const filters = () => {
  const wanted = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === "--filter") wanted.push(args[i + 1].replace(/^label=/, ""));
  return (item) => wanted.every((filter) => {
    const at = filter.indexOf("=");
    return at < 0 ? filter in item.labels : item.labels[filter.slice(0, at)] === filter.slice(at + 1);
  });
};
const print = (items) => { if (items.length) process.stdout.write(items.join("\\n") + "\\n"); };
const formatAt = args.indexOf("--format");
const show = (item) => formatAt < 0 ? (item.id ?? item.name) : args[formatAt + 1].replace(/\\{\\{\\.Label "([^"]+)"\\}\\}/g, (_, key) => item.labels[key] ?? "");
const [command, sub] = args;
if (command === "version") { process.stdout.write("27.5.1\\n"); process.exit(0); }
if (command === "compose" && sub === "version") { process.stdout.write("Docker Compose version v2.37.1\\n"); process.exit(0); }
if (command === "compose") {
  const project = args[args.indexOf("-p") + 1];
  const spec = JSON.parse(fs.readFileSync(args[args.indexOf("-f") + 1], "utf8"));
  if (process.env.FAKE_DOCKER_UP_FAIL) { process.stderr.write("container " + project + "-db-1 is unhealthy\\n"); process.exit(1); }
  for (const [name, net] of Object.entries(spec.networks ?? {})) {
    if (!state.networks.some((item) => item.name === project + "_" + name)) state.networks.push({ id: "net" + state.networks.length + project, name: project + "_" + name, labels: net.labels ?? {} });
  }
  for (const [name, volume] of Object.entries(spec.volumes ?? {})) {
    if (!state.volumes.some((item) => item.name === project + "_" + name)) state.volumes.push({ name: project + "_" + name, labels: { ...volume.labels, "com.docker.compose.project": project } });
  }
  for (const [name, service] of Object.entries(spec.services)) {
    const containerName = project + "-" + name + "-1";
    const existing = state.containers.find((item) => item.name === containerName);
    if (existing) existing.running = true;
    else state.containers.push({ id: "c" + Math.random().toString(16).slice(2, 10), name: containerName, labels: { ...service.labels, "com.docker.compose.project": project }, running: true });
  }
  save();
  process.exit(0);
}
if (command === "ps") {
  const all = args.includes("-a");
  print(state.containers.filter((item) => all || item.running).filter(filters()).map(show));
  process.exit(0);
}
if (command === "stop") {
  for (const id of args.slice(1)) { const found = state.containers.find((item) => item.id === id); if (found) found.running = false; }
  save();
  process.exit(0);
}
if (command === "rm") {
  const ids = args.slice(1).filter((arg) => !arg.startsWith("-"));
  state.containers = state.containers.filter((item) => !ids.includes(item.id));
  save();
  process.exit(0);
}
if (command === "volume" || command === "network") {
  const key = command === "volume" ? "volumes" : "networks";
  if (sub === "ls") { print(state[key].filter(filters()).map(show)); process.exit(0); }
  if (sub === "rm") {
    const ids = args.slice(2);
    state[key] = state[key].filter((item) => !ids.includes(item.id ?? item.name));
    save();
    process.exit(0);
  }
}
process.stderr.write("fake docker: unsupported " + args.join(" ") + "\\n");
process.exit(2);
`,
  );
  await chmod(binary, 0o755);
  return { binary, log, stateFile, read: async () => JSON.parse(await readFile(stateFile, "utf8")) as FakeDockerState };
}

export interface FakeLocalApiOptions {
  token?: string;
  status?: unknown;
  config?: unknown;
  whois?: Record<string, unknown> | ((addr: string) => unknown);
  postStatus?: number;
  postBody?: string;
  conflicts?: number;
  onConflict?: (config: Record<string, unknown>) => void;
}

export interface FakeLocalApi {
  socket?: string;
  port?: number;
  requests: Array<{ method: string; url: string; body: string; ifMatch?: string; authorization?: string }>;
  config: () => Record<string, unknown>;
  close: () => Promise<void>;
}

export async function fakeLocalApi(listen: { socket: string } | { tcp: true }, options: FakeLocalApiOptions = {}): Promise<FakeLocalApi> {
  const { createServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  let config = (options.config ?? null) as Record<string, unknown> | null;
  let conflicts = options.conflicts ?? 0;
  const etag = (): string => createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const requests: FakeLocalApi["requests"] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const authorization = request.headers.authorization;
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body,
        ...(typeof request.headers["if-match"] === "string" ? { ifMatch: request.headers["if-match"] } : {}),
        ...(authorization === undefined ? {} : { authorization }),
      });
      if (options.token !== undefined && authorization !== `Basic ${Buffer.from(`:${options.token}`).toString("base64")}`) {
        response.writeHead(401).end("invalid localapi credentials\n");
        return;
      }
      const url = new URL(request.url ?? "/", "http://local-tailscaled.sock");
      if (url.pathname === "/localapi/v0/status") {
        const status = typeof options.status === "function" ? (options.status as () => unknown)() : options.status;
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(status ?? { BackendState: "Running", Self: { DNSName: "fixture.tailtest.ts.net." } }));
      } else if (url.pathname === "/localapi/v0/whois") {
        const addr = url.searchParams.get("addr") ?? "";
        const found = typeof options.whois === "function" ? options.whois(addr) : options.whois?.[addr];
        if (found === undefined) response.writeHead(404).end("no match for IP:port\n");
        else if (typeof found === "number") response.writeHead(found).end("whois failed\n");
        else response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(found));
      } else if (url.pathname === "/localapi/v0/serve-config" && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "application/json", Etag: etag() }).end(JSON.stringify(config));
      } else if (url.pathname === "/localapi/v0/serve-config" && request.method === "POST") {
        if (options.postStatus !== undefined) {
          response.writeHead(options.postStatus).end(options.postBody ?? "");
        } else if (conflicts > 0) {
          conflicts -= 1;
          config ??= {};
          options.onConflict?.(config);
          response.writeHead(412).end("etag mismatch\n");
        } else if (request.headers["if-match"] !== etag()) {
          response.writeHead(412).end("etag mismatch\n");
        } else {
          config = JSON.parse(body) as Record<string, unknown>;
          response.writeHead(200).end();
        }
      } else {
        response.writeHead(404).end("not found\n");
      }
    });
  });
  if ("socket" in listen) await new Promise<void>((resolve) => server.listen(listen.socket, resolve));
  else await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    ...("socket" in listen ? { socket: listen.socket } : { port: typeof address === "object" && address !== null ? address.port : 0 }),
    requests,
    config: () => structuredClone(config ?? {}),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface TestPeer {
  nodeId: string;
  dnsName: string;
}

export interface TestRelayd {
  relayd: Relayd;
  dir: string;
  configFile: string;
  routesDir: string;
  config: Record<string, unknown>;
  as: (peer: TestPeer | string | Error) => void;
  call: (method: string, apiPath: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
  admin: (method: string, apiPath: string, body?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
  rewrite: (change: Record<string, unknown>) => Promise<void>;
  logs: Array<Record<string, unknown>>;
  clock: { now: number };
}

export const RELAY_SELF = { nodeId: "nRELAYSELF1", ip: "100.64.0.9" };

export function testHash(password: string): string {
  return `$2a$14$${Buffer.from(password).toString("hex").padEnd(40, "0")}`;
}

export async function testRelayd(config: Record<string, unknown> = {}, deps: Partial<RelaydDeps> = {}): Promise<TestRelayd> {
  const { adminRequest, startRelayd } = await import("../src/relayd.js");
  const http = await import("node:http");
  const dir = await tempDir("relayd");
  const routesDir = path.join(dir, "routes");
  const full: Record<string, unknown> = {
    domain: "nctr.site",
    allow: [],
    ungated: [],
    state_dir: path.join(dir, "state"),
    routes_dir: routesDir,
    admin_socket: path.join(dir, "run", "admin.sock"),
    control: { port: 0 },
    verify: { port: 0 },
    reload: { stamp: path.join(dir, "reload.stamp") },
    ...config,
  };
  const configFile = path.join(dir, "relayd.json");
  await writeFile(configFile, JSON.stringify(full));
  let current: TestPeer | string | Error = "nobody";
  const logs: Array<Record<string, unknown>> = [];
  const clock = { now: Date.parse("2026-10-14T12:00:00Z") };
  let counter = 0;
  const relayd = await startRelayd(configFile, {
    bind: "127.0.0.1",
    whois: (address) => {
      if (current instanceof Error) return Promise.reject(current);
      if (typeof current === "string") return Promise.resolve({ reason: `${address} ${current}`, notFound: true });
      const peer = current;
      return Promise.resolve({
        peer: { loginName: "op@example.com", displayName: "op", nodeName: peer.dnsName.split(".")[0] ?? "", dnsName: `${peer.dnsName}.`, nodeId: peer.nodeId, userId: 1, nodeUserId: 1, tailscaleIPs: ["100.64.0.2"], tags: [] },
      });
    },
    status: () => Promise.resolve({ ok: true, endpoint: { kind: "socket", socket: "/fake", source: "env" }, status: { BackendState: "Running", Self: { ID: RELAY_SELF.nodeId, TailscaleIPs: [RELAY_SELF.ip] } } }),
    hash: (secret) => Promise.resolve(testHash(secret)),
    now: () => clock.now,
    log: (event) => logs.push(event),
    random: (bytes) => Buffer.from(Array.from({ length: bytes }, () => (counter += 1) % 256)),
    ...deps,
  });
  const call = (method: string, apiPath: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
      const request = http.request({ host: "127.0.0.1", port: relayd.control?.port, method, path: apiPath, headers: { "content-type": "application/json" } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
      });
      request.on("error", reject);
      request.end(payload);
    });
  return {
    relayd,
    dir,
    configFile,
    routesDir: String(full.routes_dir),
    config: full,
    as: (peer) => {
      current = peer;
    },
    call,
    admin: (method, apiPath, body) => adminRequest(relayd.admin, method, apiPath, body),
    rewrite: async (change) => {
      Object.assign(full, change);
      await writeFile(configFile, JSON.stringify(full));
    },
    logs,
    clock,
  };
}
