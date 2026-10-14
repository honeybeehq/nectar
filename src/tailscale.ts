import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./commands.js";

export interface TailnetIdentity {
  host: string;
  dnsName: string;
}

export interface ServeEntry {
  tailnetPort: number;
  target: string;
  mount?: string;
  service?: string;
}

export interface LoopbackUpstream {
  upstreamHost: string;
  upstreamPort: number;
}

export const MAC_APP_TAILSCALE = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const FALLBACK_TAILSCALE: Array<{ path: string; source: TailscaleSource }> = [
  { path: MAC_APP_TAILSCALE, source: "app-bundle" },
  { path: "/opt/homebrew/bin/tailscale", source: "homebrew" },
  { path: "/usr/local/bin/tailscale", source: "standalone" },
];

export type TailscaleSource = "env" | "path" | "app-bundle" | "homebrew" | "standalone" | "none";

export const TAILSCALE_FALLBACKS = FALLBACK_TAILSCALE.map((fallback) => fallback.path);

export interface TailscaleBinary {
  path: string;
  source: TailscaleSource;
  searched: string[];
}

export interface TailscaleLookup {
  env?: NodeJS.ProcessEnv;
  executable?: (file: string) => boolean;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveTailscale(lookup: TailscaleLookup = {}): TailscaleBinary {
  const env = lookup.env ?? process.env;
  const executable = lookup.executable ?? isExecutable;
  const pinned = env.NECTAR_TAILSCALE_BIN;
  if (pinned !== undefined && pinned !== "") return { path: pinned, source: "env", searched: [] };
  const searched: string[] = [];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "tailscale");
    searched.push(candidate);
    if (executable(candidate)) return { path: candidate, source: "path", searched };
  }
  for (const fallback of FALLBACK_TAILSCALE) {
    searched.push(fallback.path);
    if (executable(fallback.path)) return { path: fallback.path, source: fallback.source, searched };
  }
  return { path: "tailscale", source: "none", searched };
}

export function tailscaleBinary(): string {
  return resolveTailscale().path;
}

export async function tailnetIdentity(): Promise<TailnetIdentity | undefined> {
  try {
    const result = await runCommand(tailscaleBinary(), ["status", "--json"], { timeoutMs: 5_000 });
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
    tailscaleBinary(),
    ["serve", "--bg", "--yes", `--https=${tailnetPort}`, upstreamUrl],
    { timeoutMs: 10_000 },
  );
  return result.exitCode === 0;
}

export async function servePackStore(target: string): Promise<{ ok: boolean; message: string }> {
  const result = await runCommand(tailscaleBinary(), ["serve", "--bg", "--yes", "--https=8440", target], { timeoutMs: 10_000 });
  return { ok: result.exitCode === 0, message: result.stderr.trim() || result.stdout.trim() };
}

export async function stopServe(tailnetPort: number): Promise<boolean> {
  try {
    const result = await runCommand(tailscaleBinary(), ["serve", `--https=${tailnetPort}`, "off"], { timeoutMs: 10_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function serveStatus(): Promise<unknown> {
  try {
    const result = await runCommand(tailscaleBinary(), ["serve", "status", "--json"], { timeoutMs: 5_000 });
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

function portFromServeKey(key: string): number | undefined {
  const match = key.match(/(?:^|:)(\d{1,5})$/);
  if (match?.[1] === undefined) return undefined;
  const port = Number(match[1]);
  return port > 0 && port <= 65_535 ? port : undefined;
}

export function loopbackProxy(value: string): LoopbackUpstream | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") return undefined;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
  return { upstreamHost: host, upstreamPort: port };
}

export function serveEntries(status: unknown): ServeEntry[] {
  const found = new Map<string, ServeEntry>();
  const walk = (value: unknown, scope: { port: number | undefined; mount: string | undefined; service: string | undefined; parent: string | undefined }): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, scope);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const next = {
        port: portFromServeKey(key) ?? scope.port,
        mount: key.startsWith("/") ? key : scope.mount,
        service: scope.service ?? (scope.parent === "Services" ? key : undefined),
        parent: key,
      };
      if (typeof child === "string" && next.port !== undefined) {
        const entry: ServeEntry = {
          tailnetPort: next.port,
          target: child,
          ...(next.mount === undefined ? {} : { mount: next.mount }),
          ...(next.service === undefined ? {} : { service: next.service }),
        };
        found.set(`${entry.tailnetPort}\0${entry.service ?? ""}\0${entry.mount ?? ""}\0${child}`, entry);
      } else {
        walk(child, next);
      }
    }
  };
  walk(status, { port: undefined, mount: undefined, service: undefined, parent: undefined });
  return [...found.values()].sort((a, b) => a.tailnetPort - b.tailnetPort || a.target.localeCompare(b.target));
}

export function rootMount(entry: ServeEntry): boolean {
  return entry.service === undefined && (entry.mount ?? "/") === "/";
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

// Every port mentioned anywhere in the serve table ("host:8443" keys, bare "8440"
// entries, proxy targets). Over-collecting is safe — callers only treat these as
// reserved, never as free.
export function statusPorts(status: unknown): Set<number> {
  const ports = new Set<number>();
  for (const value of scalarStrings(status)) {
    if (/^\d{2,5}$/.test(value)) ports.add(Number(value));
    const trailing = /:(\d{2,5})(?:$|\/)/.exec(value);
    if (trailing !== null) ports.add(Number(trailing[1]));
  }
  return ports;
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
  return runCommand(tailscaleBinary(), ["ssh", host, "nectar", ...args], { timeoutMs: 15_000 });
}
