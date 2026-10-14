import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandTimeout, runCommand, type CommandResult } from "./commands.js";
import {
  bodyExcerpt,
  callLocalApi,
  describeEndpoint,
  editServeConfig,
  readServeConfig,
  readStatus,
  removeWebHandlers,
  setProxyHandler,
  type LocalApiEndpoint,
  type ServeConfigEdit,
  type StatusJson,
} from "./localapi.js";

export { TAILSCALE_SOCKETS } from "./localapi.js";

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

export type TailscaleTrace = (event: Record<string, unknown>) => void;

let trace: { log: TailscaleTrace; all: boolean } | undefined;

export function traceTailscale(log: TailscaleTrace | undefined, options: { all: boolean } = { all: false }): void {
  trace = log === undefined ? undefined : { log, all: options.all };
}

export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NECTAR_DEBUG;
  return value !== undefined && value !== "" && value !== "0";
}

export const STATUS_TIMEOUT_MS = 15_000;
const SERVE_TIMEOUT_MS = 20_000;
const EXCERPT_CHARS = 500;
const LAUNCHD_JOB_ENV = ["XPC_SERVICE_NAME", "XPC_FLAGS"];

function excerpt(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat;
}

export function tailscaleEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !LAUNCHD_JOB_ENV.includes(key)));
}

export type TailscaleApi = "localapi" | "cli";

export function apiNote(api: TailscaleApi, unreachable: string | undefined): string {
  return api === "localapi" || unreachable === undefined ? `(api: ${api})` : `(api: cli; ${unreachable})`;
}

function traceLocalApi(event: { ok: boolean; endpoint?: LocalApiEndpoint; method: string; path: string; status?: number; started: number; cause?: string }): void {
  if (trace === undefined || (event.ok && !trace.all)) return;
  trace.log({
    event: "tailscale",
    api: "localapi",
    ok: event.ok,
    endpoint: event.endpoint === undefined ? null : describeEndpoint(event.endpoint),
    method: event.method,
    path: event.path,
    status: event.status ?? (event.ok ? 200 : null),
    duration_ms: Date.now() - event.started,
    ...(event.ok || event.cause === undefined ? {} : { cause: event.cause }),
  });
}

export interface TailscaleRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  cause: string;
}

export async function runTailscale(
  args: string[],
  timeoutMs: number,
  check: (stdout: string) => string | undefined = () => undefined,
  unreachable?: string,
): Promise<TailscaleRun> {
  const binary = resolveTailscale();
  const label = `tailscale ${args.join(" ")} via ${binary.path} (${binary.source})`;
  const started = Date.now();
  let result: CommandResult | undefined;
  let failure: Error | undefined;
  try {
    result = await runCommand(binary.path, args, { timeoutMs, env: tailscaleEnvironment() });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }
  const durationMs = Date.now() - started;
  const timedOut = failure instanceof CommandTimeout;
  const signal = result?.signal ?? (timedOut ? "SIGKILL" : null);
  const exitCode = result === undefined || signal !== null ? null : result.exitCode;
  const stderr = excerpt(result?.stderr ?? "");
  const unparsed = exitCode === 0 ? check(result?.stdout ?? "") : undefined;
  const cause = timedOut
    ? `${label} timed out after ${timeoutMs}ms`
    : failure !== undefined
      ? `${label} could not run: ${failure.message}`
      : signal !== null
        ? `${label} was killed by ${signal}`
        : exitCode !== 0
          ? `${label} exited ${exitCode}${stderr === "" ? "" : `: "${stderr}"`}`
          : unparsed === undefined
            ? ""
            : `${label}: ${unparsed}`;
  const ok = cause === "";
  if (trace !== undefined && (trace.all || !ok)) {
    trace.log({
      event: "tailscale",
      api: "cli",
      ok,
      binary: binary.path,
      source: binary.source,
      argv: args,
      exit_code: exitCode,
      signal,
      stderr,
      duration_ms: durationMs,
      ...(ok ? {} : { cause }),
      ...(unreachable === undefined ? {} : { localapi: unreachable }),
    });
  }
  return { ok, stdout: result?.stdout ?? "", stderr: result?.stderr ?? "", cause };
}

export type TailnetStatus = ({ identity: TailnetIdentity; reason?: undefined } | { identity?: undefined; reason: string }) & {
  api: TailscaleApi;
  endpoint?: string;
};

function parseStatus(stdout: string): StatusJson | string {
  try {
    return JSON.parse(stdout) as StatusJson;
  } catch {
    return `printed no status JSON: "${excerpt(stdout)}"`;
  }
}

function statusProblem(stdout: string): string | undefined {
  const status = parseStatus(stdout);
  return typeof status === "string" ? status : statusJsonProblem(status);
}

function statusJsonProblem(status: StatusJson): string | undefined {
  if (status.BackendState !== "Running") return `Tailscale is ${status.BackendState ?? "in no BackendState"}, not Running (logged out or stopped)`;
  if (!status.Self?.DNSName) return "status JSON has no Self.DNSName";
  return undefined;
}

function identityOf(status: StatusJson): TailnetIdentity {
  const dnsName = (status.Self?.DNSName ?? "").replace(/\.$/, "");
  return { host: dnsName.split(".")[0] ?? os.hostname().split(".")[0] ?? "localhost", dnsName };
}

type LocalStatus =
  | { kind: "up"; status: StatusJson; endpoint: LocalApiEndpoint }
  | { kind: "problem"; problem: string; endpoint?: LocalApiEndpoint }
  | { kind: "unreachable"; unreachable: string };

async function localStatus(): Promise<LocalStatus> {
  const started = Date.now();
  const read = await readStatus();
  if (!read.ok && !read.reachable) return { kind: "unreachable", unreachable: read.reason };
  const endpoint = read.endpoint;
  const problem = read.ok ? statusJsonProblem(read.status) : undefined;
  const cause = read.ok ? (problem === undefined ? undefined : `Tailscale LocalAPI ${describeEndpoint(read.endpoint)}: ${problem}`) : read.reason;
  traceLocalApi({ ok: cause === undefined, ...(endpoint === undefined ? {} : { endpoint }), method: "GET", path: "/localapi/v0/status", started, ...(cause === undefined ? {} : { cause }) });
  if (read.ok && cause === undefined) return { kind: "up", status: read.status, endpoint: read.endpoint };
  return { kind: "problem", problem: cause ?? "", ...(endpoint === undefined ? {} : { endpoint }) };
}

export async function tailnetStatus(): Promise<TailnetStatus> {
  const local = await localStatus();
  if (local.kind === "up") return { identity: identityOf(local.status), api: "localapi", endpoint: describeEndpoint(local.endpoint) };
  if (local.kind === "problem") {
    return { reason: `${local.problem} ${apiNote("localapi", undefined)}`, api: "localapi", ...(local.endpoint === undefined ? {} : { endpoint: describeEndpoint(local.endpoint) }) };
  }
  const run = await runTailscale(["status", "--json"], STATUS_TIMEOUT_MS, statusProblem, local.unreachable);
  if (!run.ok) return { reason: `${run.cause} ${apiNote("cli", local.unreachable)}`, api: "cli" };
  return { identity: identityOf(parseStatus(run.stdout) as StatusJson), api: "cli" };
}

export interface ServeOutcome {
  ok: boolean;
  message: string;
  api: TailscaleApi;
  unreachable?: string;
}

export const OPERATOR_HINT = "sudo tailscale set --operator=$USER";

export function serveDenied(message: string): boolean {
  return /access denied|serve config denied/i.test(message);
}

function outcome(run: TailscaleRun, unreachable: string | undefined): ServeOutcome {
  return { ok: run.ok, message: run.stderr.trim() || run.stdout.trim() || run.cause, api: "cli", ...(unreachable === undefined ? {} : { unreachable }) };
}

async function changeServe(args: string[], edit: (config: Parameters<ServeConfigEdit>[0], dnsName: string) => string | undefined): Promise<ServeOutcome> {
  const local = await localStatus();
  if (local.kind !== "unreachable") {
    if (local.kind === "problem") return { ok: false, message: local.problem, api: "localapi" };
    const dnsName = identityOf(local.status).dnsName;
    const started = Date.now();
    const write = await editServeConfig((config) => edit(config, dnsName));
    if (write.ok || write.reachable) {
      traceLocalApi({
        ok: write.ok,
        ...(write.endpoint === undefined ? {} : { endpoint: write.endpoint }),
        method: "POST",
        path: "/localapi/v0/serve-config",
        started,
        ...(write.ok ? {} : { cause: `${args.join(" ")}: ${write.reason}`, ...(write.status === undefined ? {} : { status: write.status }) }),
      });
      return { ok: write.ok, message: write.ok ? "" : write.reason, api: "localapi" };
    }
    return outcome(await runTailscale(args, SERVE_TIMEOUT_MS, undefined, write.reason), write.reason);
  }
  return outcome(await runTailscale(args, SERVE_TIMEOUT_MS, undefined, local.unreachable), local.unreachable);
}

export async function serveWeb(tailnetPort: number, upstreamUrl: string): Promise<ServeOutcome> {
  return changeServe(["serve", "--bg", "--yes", `--https=${tailnetPort}`, upstreamUrl], (config, dnsName) => setProxyHandler(config, dnsName, tailnetPort, upstreamUrl));
}

export type ServeRights = { state: "allowed"; api: "localapi" } | { state: "denied"; message: string; api: "localapi" } | { state: "unknown"; message: string };

export async function probeServeRights(): Promise<ServeRights> {
  const call = await callLocalApi("POST", "/localapi/v0/serve-config", { body: "not json" });
  if (!call.ok) return { state: "unknown", message: call.reason };
  const body = call.response.body.trim();
  return call.response.status === 403 && serveDenied(body) ? { state: "denied", message: body, api: "localapi" } : { state: "allowed", api: "localapi" };
}

export function tailscaledSocket(): string | undefined {
  const pinned = process.env.NECTAR_TAILSCALE_SOCKET;
  if (pinned !== undefined && pinned !== "") return existsSync(pinned) ? pinned : undefined;
  return TAILSCALE_SOCKETS.find((file) => existsSync(file));
}

function localApiSocket(socket: string, route: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath: socket, path: route, method: "GET", headers: { Host: "local-tailscaled.sock", "Sec-Tailscale": "localapi" }, timeout: 5_000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error(`tailscaled socket ${socket} did not answer`)));
    request.on("error", reject);
    request.end();
  });
}

export async function localApi(route: string, cli: string[]): Promise<unknown> {
  const socket = tailscaledSocket();
  if (socket !== undefined) {
    try {
      return await localApiSocket(socket, route);
    } catch {
      return undefined;
    }
  }
  const run = await runTailscale(cli, STATUS_TIMEOUT_MS);
  if (!run.ok) return undefined;
  try {
    return JSON.parse(run.stdout) as unknown;
  } catch {
    return undefined;
  }
}

export async function servePackStore(target: string): Promise<ServeOutcome> {
  return changeServe(["serve", "--bg", "--yes", "--https=8440", target], (config, dnsName) => setProxyHandler(config, dnsName, 8440, target));
}

export async function stopServe(tailnetPort: number): Promise<boolean> {
  return (await changeServe(["serve", `--https=${tailnetPort}`, "off"], (config, dnsName) => removeWebHandlers(config, dnsName, tailnetPort))).ok;
}

function jsonProblem(stdout: string): string | undefined {
  try {
    JSON.parse(stdout);
    return undefined;
  } catch {
    return `printed no JSON: "${excerpt(stdout)}"`;
  }
}

export async function serveStatus(): Promise<unknown> {
  const started = Date.now();
  const read = await readServeConfig();
  if (read.ok || read.reachable) {
    traceLocalApi({
      ok: read.ok,
      ...(read.endpoint === undefined ? {} : { endpoint: read.endpoint }),
      method: "GET",
      path: "/localapi/v0/serve-config",
      started,
      ...(read.ok ? {} : { cause: bodyExcerpt(read.reason), ...(read.status === undefined ? {} : { status: read.status }) }),
    });
    return read.ok ? read.config : undefined;
  }
  const run = await runTailscale(["serve", "status", "--json"], STATUS_TIMEOUT_MS, jsonProblem, read.reason);
  return run.ok ? (JSON.parse(run.stdout) as unknown) : undefined;
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
