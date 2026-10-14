import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { pidAlive, runCommand } from "./commands.js";
import { daemonHello, socketPath } from "./control.js";
import { daemonLogFile, runningDaemonPid } from "./daemon.js";
import { NectarError } from "./errors.js";
import type { NectarPaths } from "./paths.js";
import { resolveTailscale, type TailscaleLookup } from "./tailscale.js";

export const LAUNCHD_LABEL = "com.honeybeehq.nectard";
export const SYSTEMD_UNIT = "nectard.service";
const LAUNCHD_SETTLE_MS = 25_000;
const LAUNCHD_RETRY_MS = 500;

type UnitPlatform = "darwin" | "linux";

export interface UnitSpec {
  program: string[];
  env: Record<string, string>;
  stderrLog: string;
}

function unitPlatform(platform: NodeJS.Platform): UnitPlatform {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new NectarError("E_PLATFORM", `nectar daemon supports launchd (macOS) and systemd --user (Linux), not ${platform}`);
}

export function unitPath(platform: NodeJS.Platform = process.platform): string {
  if (unitPlatform(platform) === "darwin") return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const config = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(config, "systemd", "user", SYSTEMD_UNIT);
}

export async function onPath(name: string, searchPath = process.env.PATH ?? ""): Promise<boolean> {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    try {
      await access(path.join(directory, name), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function unitSpec(paths: NectarPaths, platform: NodeJS.Platform = process.platform, lookup: TailscaleLookup = {}): UnitSpec {
  unitPlatform(platform);
  const env: Record<string, string> = { NECTAR_HOME: paths.root };
  for (const key of ["PATH", "HOME", "SHELL", "LANG", "NECTAR_TRASH_BIN", "NECTAR_SOCKET", "NECTAR_CELLS_ROOT", "NECTAR_DOCKER_BIN", "DOCKER_HOST", "NECTAR_PG_BIN"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const tailscale = resolveTailscale(lookup);
  if (tailscale.source !== "path" && tailscale.source !== "none") env.NECTAR_TAILSCALE_BIN = tailscale.path;
  return {
    program: [process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), "daemon", "run"],
    env,
    stderrLog: path.join(paths.logs, "nectard.stderr.log"),
  };
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function launchdPlist(spec: UnitSpec): string {
  const strings = (values: string[]): string => values.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(spec.program)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.stderrLog)}</string>
</dict>
</plist>
`;
}

function systemdQuote(value: string, exec = false): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${exec ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}

export function systemdUnit(spec: UnitSpec): string {
  const env = Object.entries(spec.env)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Nectar supervisor (nectard): revives, restores and garbage-collects Nectar envs

[Service]
Type=simple
ExecStart=${spec.program.map((arg) => systemdQuote(arg, true)).join(" ")}
${env}
Restart=always
RestartSec=5
KillMode=process
StandardOutput=null

[Install]
WantedBy=default.target
`;
}

export interface InstalledUnit {
  file: string;
  program: string[];
  env: Record<string, string>;
}

function unescapeQuoted(value: string, exec: boolean): string {
  const unpercent = value.replace(/%%/g, "%");
  return (exec ? unpercent.replace(/\$\$/g, "$") : unpercent).replace(/\\(.)/g, "$1");
}

function quotedWords(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "");
}

export function parseSystemdUnit(text: string): Omit<InstalledUnit, "file"> {
  const env: Record<string, string> = {};
  let program: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("ExecStart=")) program = quotedWords(line).map((word) => unescapeQuoted(word, true));
    if (line.startsWith("Environment=")) {
      for (const word of quotedWords(line)) {
        const pair = unescapeQuoted(word, false);
        const split = pair.indexOf("=");
        if (split > 0) env[pair.slice(0, split)] = pair.slice(split + 1);
      }
    }
  }
  return { program, env };
}

function unxml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

export function parseLaunchdPlist(text: string): Omit<InstalledUnit, "file"> {
  const strings = (block: string | undefined): string[] =>
    [...(block ?? "").matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unxml(match[1] ?? ""));
  const program = strings(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1]);
  const env: Record<string, string> = {};
  const block = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? "";
  for (const match of block.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
    env[unxml(match[1] ?? "")] = unxml(match[2] ?? "");
  }
  return { program, env };
}

export async function readInstalledUnit(platform: NodeJS.Platform = process.platform): Promise<InstalledUnit | undefined> {
  const kind = unitPlatform(platform);
  const file = unitPath(kind);
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  return { file, ...(kind === "darwin" ? parseLaunchdPlist(text) : parseSystemdUnit(text)) };
}

function launchctl(): string {
  return process.env.NECTAR_LAUNCHCTL_BIN ?? "launchctl";
}

function systemctl(): string {
  return process.env.NECTAR_SYSTEMCTL_BIN ?? "systemctl";
}

function loginctl(): string {
  return process.env.NECTAR_LOGINCTL_BIN ?? "loginctl";
}

function launchdDomain(): string {
  return `gui/${os.userInfo().uid}`;
}

async function safely(file: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runCommand(file, args, { timeoutMs: 15_000 }).catch((error: unknown) => ({
    exitCode: 127,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

export async function installUnit(
  paths: NectarPaths,
  platform: NodeJS.Platform = process.platform,
  options: { waitMs?: number } = {},
): Promise<Record<string, unknown>> {
  const kind = unitPlatform(platform);
  const file = unitPath(kind);
  const spec = unitSpec(paths, kind);
  const warnings: string[] = [];
  await mkdir(paths.logs, { recursive: true });
  await mkdir(path.dirname(file), { recursive: true });
  if (kind === "darwin") {
    const plist = launchdPlist(spec);
    const unchanged = (await readFile(file, "utf8").catch(() => undefined)) === plist;
    const running = await managerState(kind);
    const restarted =
      unchanged && running.pid !== undefined && (await safely(launchctl(), ["kickstart", "-k", `${launchdDomain()}/${LAUNCHD_LABEL}`])).exitCode === 0;
    if (!restarted) {
      await writeFile(file, plist, { mode: 0o644 });
      await bootstrapAgent(file);
    }
  } else {
    const session = await safely(systemctl(), ["--user", "show-environment"]);
    if (session.exitCode !== 0) {
      throw new NectarError("E_PLATFORM", `No systemd --user session for this user (${session.stderr.trim()}); log in once or run loginctl enable-linger ${os.userInfo().username}`);
    }
    await writeFile(file, systemdUnit(spec), { mode: 0o644 });
    for (const args of [["daemon-reload"], ["enable", SYSTEMD_UNIT], ["restart", SYSTEMD_UNIT]]) {
      const result = await safely(systemctl(), ["--user", ...args]);
      if (result.exitCode !== 0) {
        throw new NectarError("E_PLATFORM", `systemctl --user ${args.join(" ")} failed: ${result.stderr.trim()}`);
      }
    }
    const started = await daemonState(kind, paths, { ms: options.waitMs ?? 5_000, anyState: false });
    if (!RUNNING_STATES.has(started.active)) {
      throw new NectarError("E_PLATFORM", `systemctl --user restart ${SYSTEMD_UNIT} left it ${started.active}; see journalctl --user -u ${SYSTEMD_UNIT}`);
    }
    const linger = await safely(loginctl(), ["show-user", os.userInfo().username, "--property=Linger"]);
    if (!linger.stdout.includes("Linger=yes")) {
      warnings.push(`Linger is off: nectard starts only while you are logged in. Run: loginctl enable-linger ${os.userInfo().username}`);
    }
  }
  const state = await daemonState(kind, paths, { ms: options.waitMs ?? 5_000, anyState: true });
  return {
    installed: true,
    platform: kind,
    unit: file,
    active: state.active,
    pid: state.pid,
    pid_source: state.pid_source,
    nectar_home: paths.root,
    program: spec.program,
    log: daemonLogFile(paths),
    warnings,
  };
}

async function agentLoaded(): Promise<boolean> {
  return (await safely(launchctl(), ["print", `${launchdDomain()}/${LAUNCHD_LABEL}`])).exitCode === 0;
}

async function bootout(settleMs: number): Promise<{ unloaded: boolean; waited_ms: number }> {
  const started = Date.now();
  await safely(launchctl(), ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`]);
  while (await agentLoaded()) {
    if (Date.now() - started >= settleMs) return { unloaded: false, waited_ms: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { unloaded: true, waited_ms: Date.now() - started };
}

async function bootoutAgent(): Promise<void> {
  if (!(await bootout(LAUNCHD_SETTLE_MS)).unloaded) {
    throw new NectarError("E_PLATFORM", `launchctl bootout left ${LAUNCHD_LABEL} loaded after ${LAUNCHD_SETTLE_MS / 1_000}s; run launchctl bootout ${launchdDomain()}/${LAUNCHD_LABEL} and retry`);
  }
}

async function bootstrapAgent(file: string): Promise<void> {
  let failure = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await bootoutAgent();
    const loaded = await safely(launchctl(), ["bootstrap", launchdDomain(), file]);
    if (loaded.exitCode === 0 && (await agentLoaded())) return;
    failure = loaded.exitCode === 0 ? "bootstrap succeeded but the agent is not loaded" : loaded.stderr.trim() || loaded.stdout.trim() || `exit ${loaded.exitCode}`;
    await new Promise((resolve) => setTimeout(resolve, LAUNCHD_RETRY_MS));
  }
  throw new NectarError("E_PLATFORM", `launchctl bootstrap ${launchdDomain()} ${file} failed twice (${failure}); ${LAUNCHD_LABEL} is not loaded. Run nectar daemon install again`);
}

export async function uninstallUnit(
  paths: NectarPaths,
  platform: NodeJS.Platform = process.platform,
  options: { settleMs?: number } = {},
): Promise<Record<string, unknown>> {
  const kind = unitPlatform(platform);
  const file = unitPath(kind);
  const present = await exists(file);
  const warnings: string[] = [];
  let unload: { unloaded: boolean; waited_ms: number } | undefined;
  if (kind === "darwin") {
    const settleMs = options.settleMs ?? LAUNCHD_SETTLE_MS;
    unload = await bootout(settleMs);
    if (!unload.unloaded) {
      warnings.push(`launchctl print still finds ${LAUNCHD_LABEL} ${settleMs / 1_000}s after bootout; run launchctl bootout ${launchdDomain()}/${LAUNCHD_LABEL}`);
    }
  } else {
    await safely(systemctl(), ["--user", "disable", "--now", SYSTEMD_UNIT]);
  }
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (kind === "linux") await safely(systemctl(), ["--user", "daemon-reload"]);
  return { removed: present, platform: kind, unit: file, ...(unload ?? {}), envs_kept: true, nectar_home: paths.root, warnings };
}

interface ManagerState {
  active: string;
  pid: number | undefined;
}

const RUNNING_STATES = new Set(["running", "active", "activating", "reloading", "spawn scheduled"]);

function livePid(value: string | undefined): number | undefined {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 1 && pidAlive(pid) ? pid : undefined;
}

async function managerState(kind: UnitPlatform): Promise<ManagerState> {
  if (kind === "darwin") {
    const printed = await safely(launchctl(), ["print", `${launchdDomain()}/${LAUNCHD_LABEL}`]);
    if (printed.exitCode !== 0) return { active: "not-loaded", pid: undefined };
    return {
      active: /^\s*state = (.+)$/m.exec(printed.stdout)?.[1]?.trim() ?? "loaded",
      pid: livePid(/^\s*pid = (\d+)/m.exec(printed.stdout)?.[1]),
    };
  }
  const shown = await safely(systemctl(), ["--user", "show", "--property=ActiveState", "--property=MainPID", SYSTEMD_UNIT]);
  if (shown.exitCode !== 0) return { active: "unknown", pid: undefined };
  return {
    active: /^ActiveState=(.*)$/m.exec(shown.stdout)?.[1]?.trim() || "unknown",
    pid: livePid(/^MainPID=(\d+)$/m.exec(shown.stdout)?.[1]),
  };
}

async function daemonState(
  kind: UnitPlatform,
  paths: NectarPaths,
  wait: { ms: number; anyState: boolean },
): Promise<{ active: string; pid: number | null; pid_source: string | null }> {
  const deadline = Date.now() + wait.ms;
  for (;;) {
    const state = await managerState(kind);
    if (state.pid !== undefined) return { active: state.active, pid: state.pid, pid_source: kind === "darwin" ? "launchctl" : "systemctl" };
    const fromFile = await runningDaemonPid(paths);
    if (fromFile !== undefined) return { active: state.active, pid: fromFile, pid_source: "pidfile" };
    if ((!wait.anyState && !RUNNING_STATES.has(state.active)) || Date.now() >= deadline) return { active: state.active, pid: null, pid_source: null };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface UnitStatus {
  installed: boolean;
  platform: UnitPlatform;
  unit: string;
  active: string;
  pid: number | null;
  pid_source: string | null;
  nectar_home: string;
  last_gc_at: string | null;
  log: string;
  socket: string;
  control: { api: number; pid: number; nectar_home: string; ops: string[] } | null;
}

export async function unitStatus(
  paths: NectarPaths,
  platform: NodeJS.Platform = process.platform,
  options: { waitMs?: number } = {},
): Promise<UnitStatus> {
  const kind = unitPlatform(platform);
  const file = unitPath(kind);
  const installed = await exists(file);
  const state = await daemonState(kind, paths, { ms: options.waitMs ?? 3_000, anyState: false });
  const config = JSON.parse(await readFile(paths.config, "utf8").catch(() => "{}")) as { last_gc_at?: string };
  const socket = socketPath();
  const hello = await daemonHello(socket);
  return {
    installed,
    platform: kind,
    unit: file,
    active: state.active,
    pid: state.pid,
    pid_source: state.pid_source,
    nectar_home: paths.root,
    last_gc_at: config.last_gc_at ?? null,
    log: daemonLogFile(paths),
    socket,
    control: hello === undefined ? null : { api: hello.api, pid: hello.pid, nectar_home: hello.nectar_home, ops: hello.ops },
  };
}
