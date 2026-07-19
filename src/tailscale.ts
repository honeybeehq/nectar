import os from "node:os";
import { runCommand } from "./commands.js";

export interface TailnetIdentity {
  host: string;
  dnsName: string;
}

function binary(): string {
  return process.env.NECTAR_TAILSCALE_BIN ?? "tailscale";
}

export async function tailnetIdentity(): Promise<TailnetIdentity | undefined> {
  try {
    const result = await runCommand(binary(), ["status", "--json"], { timeoutMs: 5_000 });
    if (result.exitCode !== 0) return undefined;
    const status = JSON.parse(result.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
    if (status.BackendState !== "Running" || !dnsName) return undefined;
    return { host: dnsName.split(".")[0] ?? os.hostname().split(".")[0] ?? "localhost", dnsName };
  } catch {
    return undefined;
  }
}

export async function serveWeb(tailnetPort: number, upstreamUrl: string): Promise<boolean> {
  const result = await runCommand(
    binary(),
    ["serve", "--bg", "--yes", `--https=${tailnetPort}`, upstreamUrl],
    { timeoutMs: 10_000 },
  );
  return result.exitCode === 0;
}

export async function servePackStore(target: string): Promise<{ ok: boolean; message: string }> {
  const result = await runCommand(binary(), ["serve", "--bg", "--yes", "--https=8440", target], { timeoutMs: 10_000 });
  return { ok: result.exitCode === 0, message: result.stderr.trim() || result.stdout.trim() };
}

export async function stopServe(tailnetPort: number): Promise<boolean> {
  try {
    const result = await runCommand(binary(), ["serve", `--https=${tailnetPort}`, "off"], { timeoutMs: 10_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function serveStatus(): Promise<unknown> {
  try {
    const result = await runCommand(binary(), ["serve", "status", "--json"], { timeoutMs: 5_000 });
    if (result.exitCode !== 0) return undefined;
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
}

function scalarStrings(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalarStrings);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => [key, ...scalarStrings(item)]);
  }
  return [];
}

export function statusHasPort(status: unknown, port: number): boolean {
  const exact = String(port);
  return scalarStrings(status).some((value) => {
    if (value === exact) return true;
    return new RegExp(`(?:^|[:=])${port}(?:$|[/\\s])`).test(value);
  });
}

export function statusHasProxyTarget(status: unknown, port: number, target: string): boolean {
  return statusHasPort(status, port) && scalarStrings(status).includes(target);
}

export function statusHasFunnel(status: unknown): boolean {
  if (typeof status !== "object" || status === null) return false;
  const entries = Object.entries(status as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (/funnel/i.test(key)) {
      if (value === true) return true;
      if (typeof value === "object" && value !== null && Object.keys(value).length > 0) return true;
      if (typeof value === "string" && value.length > 0) return true;
    }
    if (statusHasFunnel(value)) return true;
  }
  return false;
}

export async function remoteNectar(host: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runCommand(binary(), ["ssh", host, "nectar", ...args], { timeoutMs: 15_000 });
}
