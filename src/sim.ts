import { runCommand, type CommandResult } from "./commands.js";
import { NectarError } from "./errors.js";

// Pinned so a publish path never floats on npx@latest.
export const SERVE_SIM_VERSION = "0.1.45";
const SIMCTL_TIMEOUT = 30_000;
const BOOT_TIMEOUT = 180_000;

export interface SimRuntime {
  identifier: string;
  version: string;
  name: string;
  available: boolean;
}

export interface SimDeviceType {
  name: string;
  identifier: string;
}

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  available: boolean;
}

export function isAppleSiliconMac(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

export function iosSimPlatform(): string {
  return `ios-sim-${process.arch === "arm64" ? "arm64" : process.arch}`;
}

async function xcrun(args: string[], timeoutMs = SIMCTL_TIMEOUT): Promise<CommandResult> {
  const binary = process.env.NECTAR_XCRUN_BIN ?? "xcrun";
  return runCommand(binary, ["simctl", ...args], { timeoutMs });
}

function simError(action: string, result: CommandResult): NectarError {
  const tail = [...result.stdout.split("\n"), ...result.stderr.split("\n")].filter(Boolean).slice(-20);
  const hint = /is not installed|No runtime/i.test(result.stderr)
    ? "; install a simulator runtime with `xcodebuild -downloadPlatform iOS`"
    : "";
  return new NectarError("E_SIM", `simctl ${action} failed${hint}`, { log_tail: tail });
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

export function parseRuntimes(json: string): SimRuntime[] {
  const value = JSON.parse(json) as { runtimes?: Array<Record<string, unknown>> };
  return (value.runtimes ?? [])
    .filter((runtime) => text(runtime.identifier).includes("SimRuntime.iOS"))
    .map((runtime) => ({
      identifier: text(runtime.identifier),
      version: text(runtime.version),
      name: text(runtime.name),
      available: runtime.isAvailable === true,
    }));
}

export function selectRuntime(runtimes: SimRuntime[], pin: string): SimRuntime {
  const available = runtimes.filter((runtime) => runtime.available);
  if (available.length === 0) {
    throw new NectarError(
      "E_SIM",
      "No available iOS simulator runtime; install one with `xcodebuild -downloadPlatform iOS`",
    );
  }
  const byVersionDesc = [...available].sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true }),
  );
  if (pin === "latest") return byVersionDesc[0] as SimRuntime;
  const wanted = pin.replace(/^ios\s*/i, "").trim();
  const match = byVersionDesc.find(
    (runtime) => runtime.version === wanted || runtime.version.startsWith(`${wanted}.`) || runtime.name === pin,
  );
  if (match === undefined) {
    const versions = available.map((runtime) => runtime.version).join(", ");
    throw new NectarError("E_SIM", `iOS runtime '${pin}' is not installed (available: ${versions})`);
  }
  return match;
}

export function parseDeviceTypes(json: string): SimDeviceType[] {
  const value = JSON.parse(json) as { devicetypes?: Array<Record<string, unknown>> };
  return (value.devicetypes ?? []).map((deviceType) => ({
    name: text(deviceType.name),
    identifier: text(deviceType.identifier),
  }));
}

export function selectDeviceType(deviceTypes: SimDeviceType[], name: string): SimDeviceType {
  const match = deviceTypes.find((deviceType) => deviceType.name === name || deviceType.identifier === name);
  if (match === undefined) {
    throw new NectarError("E_SIM", `Simulator device type '${name}' is not available on this host`);
  }
  return match;
}

export function parseDevices(json: string): SimDevice[] {
  const value = JSON.parse(json) as { devices?: Record<string, Array<Record<string, unknown>>> };
  return Object.values(value.devices ?? {})
    .flat()
    .map((device) => ({
      udid: text(device.udid),
      name: text(device.name),
      state: text(device.state),
      available: device.isAvailable === true,
    }));
}

export async function listRuntimes(): Promise<SimRuntime[]> {
  const result = await xcrun(["list", "runtimes", "--json"]);
  if (result.exitCode !== 0) throw simError("list runtimes", result);
  return parseRuntimes(result.stdout);
}

export async function listDeviceTypes(): Promise<SimDeviceType[]> {
  const result = await xcrun(["list", "devicetypes", "--json"]);
  if (result.exitCode !== 0) throw simError("list devicetypes", result);
  return parseDeviceTypes(result.stdout);
}

export async function listDevices(): Promise<SimDevice[]> {
  const result = await xcrun(["list", "devices", "--json"]);
  if (result.exitCode !== 0) throw simError("list devices", result);
  return parseDevices(result.stdout);
}

export async function createSimDevice(name: string, deviceTypeId: string, runtimeId: string): Promise<string> {
  const result = await xcrun(["create", name, deviceTypeId, runtimeId]);
  if (result.exitCode !== 0) throw simError(`create ${name}`, result);
  const udid = result.stdout.trim().split("\n").pop()?.trim();
  if (udid === undefined || udid.length < 8) throw simError(`create ${name} (no udid returned)`, result);
  return udid;
}

export async function bootSim(udid: string): Promise<void> {
  // bootstatus -b boots a shutdown device and blocks until it is usable.
  const result = await xcrun(["bootstatus", udid, "-b"], BOOT_TIMEOUT);
  if (result.exitCode !== 0) throw simError(`boot ${udid}`, result);
}

export async function installSimApp(udid: string, appPath: string): Promise<void> {
  const result = await xcrun(["install", udid, appPath], 60_000);
  if (result.exitCode !== 0) throw simError(`install ${appPath}`, result);
}

export async function launchSimApp(udid: string, bundleId: string): Promise<void> {
  const result = await xcrun(["launch", udid, bundleId], 60_000);
  if (result.exitCode !== 0) throw simError(`launch ${bundleId}`, result);
}

export async function shutdownSim(udid: string): Promise<void> {
  await xcrun(["shutdown", udid]).catch(() => undefined);
}

export async function deleteSim(udid: string): Promise<void> {
  await xcrun(["delete", udid]).catch(() => undefined);
}

export function serveSimCommand(device: string, port: number): string {
  const binary = process.env.NECTAR_SERVE_SIM_BIN ?? `npx -y serve-sim@${SERVE_SIM_VERSION}`;
  const quoted = `'${device.replaceAll("'", `'\\''`)}'`;
  return `${binary} ${quoted} -p ${port}`;
}
