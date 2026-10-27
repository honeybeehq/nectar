import os from "node:os";
import { openSync, closeSync, readFileSync, existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SpawnOptions } from "node:child_process";
import { NectarError } from "./errors.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
}

export class CommandTimeout extends Error {
  constructor(
    readonly file: string,
    readonly timeoutMs: number,
  ) {
    super(`${file} timed out after ${timeoutMs}ms`);
  }
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
    child.once("close", (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) {
        reject(new CommandTimeout(file, options.timeoutMs ?? 0));
        return;
      }
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), signal });
    });
    child.stdin?.once("error", reject);
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

function runtimeLauncher(): string {
  const built = fileURLToPath(new URL("./runtime-launcher.js", import.meta.url));
  return existsSync(built) ? built : fileURLToPath(new URL("../dist/runtime-launcher.js", import.meta.url));
}

export function spawnDetached(command: string, cwd: string, env: NodeJS.ProcessEnv, logFile: string): ProcessIdentity {
  const log = openSync(logFile, "a", 0o600);
  try {
    const shell = process.env.SHELL ?? "/bin/sh";
    const child = spawn(process.execPath, [runtimeLauncher(), shell, "-c", command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    if (child.pid === undefined) throw new NectarError("E_CHECKOUT", `Could not start serve command '${command}'`);
    child.unref();
    const identity = readProcessIdentity(child.pid);
    return { pid: child.pid, pgid: child.pid, ...(identity?.pgid === child.pid ? { start_time: identity.start_time } : {}) };
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
): ProcessIdentity {
  const log = openSync(logFile, "a", 0o600);
  try {
    const child = spawn(process.execPath, [runtimeLauncher(), file, ...args], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    if (child.pid === undefined) throw new NectarError("E_CHECKOUT", `Could not start ${file}`);
    child.unref();
    const identity = readProcessIdentity(child.pid);
    return { pid: child.pid, pgid: child.pid, ...(identity?.pgid === child.pid ? { start_time: identity.start_time } : {}) };
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

export interface ProcessIdentity {
  pid: number;
  pgid: number;
  start_time?: string;
}

export function readProcessIdentity(pid: number): { pgid: number; start_time: string } | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const pgid = Number(fields[2]);
      const ticks = fields[19];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!Number.isInteger(pgid) || pgid <= 1 || ticks === undefined || !/^\d+$/.test(ticks) || !boot) return undefined;
      return { pgid, start_time: `${boot}:${ticks}` };
    }
    const output = execFileSync("ps", ["-o", "pgid=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000, env: { ...process.env, LC_ALL: "C" } }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(output);
    if (match === null) return undefined;
    return { pgid: Number(match[1]), start_time: match[2]! };
  } catch {
    return undefined;
  }
}

export function ownershipRefusal(record: ProcessIdentity): string | undefined {
  if (!Number.isInteger(record.pid) || record.pid <= 1 || record.pid !== record.pgid) return "record has no dedicated process group; left alone";
  if (record.start_time === undefined) return "record has no process start time; left alone";
  const current = readProcessIdentity(record.pid);
  if (current === undefined) return "process identity unavailable; left alone";
  if (current.pgid !== record.pgid) return "process group differs from record; left alone";
  if (current.start_time !== record.start_time) return "process start time differs from record; left alone";
  return undefined;
}

export function processBelongsToEnv(record: ProcessIdentity): Promise<boolean> {
  return Promise.resolve(ownershipRefusal(record) === undefined);
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

export function groupBelongsToEnv(record: ProcessIdentity): Promise<boolean> {
  return Promise.resolve(groupAlive(record.pgid) && ownershipRefusal(record) === undefined);
}

export async function stopEnvGroup(record: ProcessIdentity): Promise<boolean> {
  if (record.pid === 0 && record.pgid === 0) return false;
  if (!Number.isInteger(record.pgid) || record.pgid <= 1) throw new NectarError("E_BUSY", "Runtime ownership unknown: record has no dedicated process group; left alone");
  if (!groupAlive(record.pgid)) return false;
  const refusal = ownershipRefusal(record);
  if (refusal !== undefined) throw new NectarError("E_BUSY", `Runtime ownership unknown: ${refusal}`, { hint: `Verify PID ${record.pid} and PGID ${record.pgid} with ps -o pid,pgid,lstart -p ${record.pid}; after confirming ownership, stop that group manually, then retry nectar stop or nectar rm --force` });
  await stopProcessGroup(record.pgid, 2_000, record);
  return true;
}

export async function stopProcessGroup(pgid: number, waitMs = 2_000, identity?: ProcessIdentity): Promise<void> {
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
    if (identity !== undefined) {
      const refusal = ownershipRefusal(identity);
      if (refusal !== undefined) throw new NectarError("E_BUSY", `Runtime ownership unknown: ${refusal}`, { hint: `Verify PID ${identity.pid} and PGID ${identity.pgid} with ps -o pid,pgid,lstart -p ${identity.pid}; after confirming ownership, stop that group manually, then retry nectar stop or nectar rm --force` });
    }
    try {
      process.kill(-pgid, "SIGKILL");
      const killedDeadline = Date.now() + waitMs;
      while (groupAlive() && Date.now() < killedDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
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
