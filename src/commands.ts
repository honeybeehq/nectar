import os from "node:os";
import { openSync, closeSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { NectarError } from "./errors.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export function scrubbedEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

export async function runCommand(file: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      stdio: "pipe",
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    };
    const child = spawn(file, args, spawnOptions);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${file} timed out after ${options.timeoutMs}ms`));
        return;
      }
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

export async function runShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<CommandResult> {
  const shell = process.env.SHELL ?? "/bin/sh";
  return runCommand(shell, ["-c", command], { cwd, env, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

export function spawnDetached(command: string, cwd: string, env: NodeJS.ProcessEnv, logFile: string): { pid: number; pgid: number } {
  const log = openSync(logFile, "a", 0o600);
  try {
    const shell = process.env.SHELL ?? "/bin/sh";
    const child = spawn(shell, ["-c", command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    if (child.pid === undefined) throw new NectarError("E_CHECKOUT", `Could not start serve command '${command}'`);
    child.unref();
    return { pid: child.pid, pgid: child.pid };
  } finally {
    closeSync(log);
  }
}

export function spawnDetachedExecutable(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logFile: string,
): { pid: number; pgid: number } {
  const log = openSync(logFile, "a", 0o600);
  try {
    const child = spawn(file, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    if (child.pid === undefined) throw new NectarError("E_CHECKOUT", `Could not start ${file}`);
    child.unref();
    return { pid: child.pid, pgid: child.pid };
  } finally {
    closeSync(log);
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function processBelongsToEnv(pid: number, env: string): Promise<boolean> {
  if (!pidAlive(pid)) return false;
  const marker = `NECTAR_ENV=${env}`;
  if (process.platform === "linux") {
    const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
    return environ.split("\0").includes(marker);
  }
  const listed = await runCommand("ps", ["eww", "-o", "command=", "-p", String(pid)]).catch(() => undefined);
  return listed?.stdout.split(/\s+/).includes(marker) ?? false;
}

export function groupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function groupBelongsToEnv(pgid: number, env: string): Promise<boolean> {
  if (!groupAlive(pgid)) return false;
  if (await processBelongsToEnv(pgid, env)) return true;
  const listed = await runCommand("ps", ["-A", "-o", "pid=,pgid="], { timeoutMs: 5_000 }).catch(() => undefined);
  const members = (listed?.stdout ?? "")
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => group === pgid && pid !== pgid && pid !== undefined && Number.isInteger(pid))
    .map(([pid]) => pid as number);
  for (const pid of members) if (await processBelongsToEnv(pid, env)) return true;
  return false;
}

export async function stopEnvGroup(pgid: number, env: string): Promise<boolean> {
  if (!(await groupBelongsToEnv(pgid, env))) return false;
  await stopProcessGroup(pgid);
  return true;
}

export async function stopProcessGroup(pgid: number, waitMs = 2_000): Promise<void> {
  const groupAlive = (): boolean => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  if (!Number.isInteger(pgid) || pgid <= 1 || !groupAlive()) return;
  // EPERM means the pgid now belongs to another user's process (recycled after a
  // reboot or long-dead record) — never escalate against a group that isn't ours.
  try {
    process.kill(-pgid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return;
    if (code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + waitMs;
  while (groupAlive() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (groupAlive()) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw error;
    }
  }
}

export function currentPublisher(): { hive_bee?: string; hive_session?: string; user: string } {
  const hiveBee = process.env.HIVE_BEE ?? process.env.HIVE_BEE_ID;
  const hiveSession = process.env.HIVE_SESSION ?? process.env.HIVE_SESSION_ID ?? (process.env.HIVE_BEE === undefined ? undefined : process.env.HIVE_BEE_ID);
  return {
    ...(hiveBee === undefined ? {} : { hive_bee: hiveBee }),
    ...(hiveSession === undefined ? {} : { hive_session: hiveSession }),
    user: os.userInfo().username,
  };
}
