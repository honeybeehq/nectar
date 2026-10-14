import path from "node:path";
import os from "node:os";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { vi } from "vitest";
import { runCommand } from "../src/commands.js";
import type { EnvRecord, Mode } from "../src/types.js";

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
    if (!state.volumes.some((item) => item.name === project + "_" + name)) state.volumes.push({ name: project + "_" + name, labels: volume.labels ?? {} });
  }
  for (const [name, service] of Object.entries(spec.services)) {
    const containerName = project + "-" + name + "-1";
    const existing = state.containers.find((item) => item.name === containerName);
    if (existing) existing.running = true;
    else state.containers.push({ id: "c" + Math.random().toString(16).slice(2, 10), name: containerName, labels: service.labels ?? {}, running: true });
  }
  save();
  process.exit(0);
}
if (command === "ps") {
  const all = args.includes("-a");
  print(state.containers.filter((item) => all || item.running).filter(filters()).map((item) => item.id));
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
  if (sub === "ls") { print(state[key].filter(filters()).map((item) => item.id ?? item.name)); process.exit(0); }
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
