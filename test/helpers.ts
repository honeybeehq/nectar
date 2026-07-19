import path from "node:path";
import os from "node:os";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
