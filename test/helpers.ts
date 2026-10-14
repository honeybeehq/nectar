import path from "node:path";
import os from "node:os";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
