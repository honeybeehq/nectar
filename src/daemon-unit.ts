import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { runCommand } from "./commands.js";
import { daemonLogFile, runningDaemonPid } from "./daemon.js";
import { NectarError } from "./errors.js";
import type { NectarPaths } from "./paths.js";

export const LAUNCHD_LABEL = "com.honeybeehq.nectard";
export const SYSTEMD_UNIT = "nectard.service";
const MAC_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

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

async function onPath(name: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    try {
      await access(path.join(directory, name), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function tailscaleBinary(platform: UnitPlatform): Promise<string | undefined> {
  if (process.env.NECTAR_TAILSCALE_BIN !== undefined) return process.env.NECTAR_TAILSCALE_BIN;
  if (await onPath("tailscale")) return undefined;
  if (platform !== "darwin") return undefined;
  return access(MAC_TAILSCALE, constants.X_OK).then(
    () => MAC_TAILSCALE,
    () => undefined,
  );
}

export async function unitSpec(paths: NectarPaths, platform: NodeJS.Platform = process.platform): Promise<UnitSpec> {
  const env: Record<string, string> = { NECTAR_HOME: paths.root };
  for (const key of ["PATH", "HOME", "SHELL", "LANG", "NECTAR_TRASH_BIN"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const tailscale = await tailscaleBinary(unitPlatform(platform));
  if (tailscale !== undefined) env.NECTAR_TAILSCALE_BIN = tailscale;
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

export async function installUnit(paths: NectarPaths, platform: NodeJS.Platform = process.platform): Promise<Record<string, unknown>> {
  const kind = unitPlatform(platform);
  const file = unitPath(kind);
  const spec = await unitSpec(paths, kind);
  const warnings: string[] = [];
  await mkdir(paths.logs, { recursive: true });
  await mkdir(path.dirname(file), { recursive: true });
  if (kind === "darwin") {
    await writeFile(file, launchdPlist(spec), { mode: 0o644 });
    await safely(launchctl(), ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`]);
    const loaded = await safely(launchctl(), ["bootstrap", launchdDomain(), file]);
    if (loaded.exitCode !== 0) {
      throw new NectarError("E_PLATFORM", `launchctl bootstrap failed: ${loaded.stderr.trim() || loaded.stdout.trim()}`);
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
    const linger = await safely(loginctl(), ["show-user", os.userInfo().username, "--property=Linger"]);
    if (!linger.stdout.includes("Linger=yes")) {
      warnings.push(`Linger is off: nectard starts only while you are logged in. Run: loginctl enable-linger ${os.userInfo().username}`);
    }
  }
  return { installed: true, platform: kind, unit: file, nectar_home: paths.root, program: spec.program, log: daemonLogFile(paths), warnings };
}

export async function uninstallUnit(paths: NectarPaths, platform: NodeJS.Platform = process.platform): Promise<Record<string, unknown>> {
  const kind = unitPlatform(platform);
  const file = unitPath(kind);
  const present = await exists(file);
  if (kind === "darwin") {
    await safely(launchctl(), ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`]);
  } else {
    await safely(systemctl(), ["--user", "disable", "--now", SYSTEMD_UNIT]);
  }
  await unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (kind === "linux") await safely(systemctl(), ["--user", "daemon-reload"]);
  return { removed: present, platform: kind, unit: file, envs_kept: true, nectar_home: paths.root };
}

export async function unitStatus(paths: NectarPaths, platform: NodeJS.Platform = process.platform): Promise<Record<string, unknown>> {
  const kind = unitPlatform(platform);
  const file = unitPath(kind);
  const installed = await exists(file);
  let active: string;
  if (kind === "darwin") {
    const printed = await safely(launchctl(), ["print", `${launchdDomain()}/${LAUNCHD_LABEL}`]);
    active = printed.exitCode !== 0 ? "not-loaded" : (/state = (\S+)/.exec(printed.stdout)?.[1] ?? "loaded");
  } else {
    active = (await safely(systemctl(), ["--user", "is-active", SYSTEMD_UNIT])).stdout.trim() || "unknown";
  }
  const config = JSON.parse(await readFile(paths.config, "utf8").catch(() => "{}")) as { last_gc_at?: string };
  return {
    installed,
    platform: kind,
    unit: file,
    active,
    pid: (await runningDaemonPid(paths)) ?? null,
    nectar_home: paths.root,
    last_gc_at: config.last_gc_at ?? null,
    log: daemonLogFile(paths),
  };
}
