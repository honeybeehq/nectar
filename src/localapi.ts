import { readdir, readFile, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./commands.js";

export type LocalApiEndpoint =
  | { kind: "socket"; socket: string; source: "env" | "default" }
  | { kind: "tcp"; port: number; token: string; source: "app-store" | "macsys" };

export const TAILSCALE_SOCKETS = ["/var/run/tailscale/tailscaled.sock", "/run/tailscale/tailscaled.sock"];
export const DARWIN_TAILSCALED_SOCKET = "/var/run/tailscaled.socket";
export const MACSYS_SHARED_DIR = "/Library/Tailscale";
const APP_STORE_CONTAINER = ".io.tailscale.ipn.macos";
const PROOF_FILE = /^sameuserproof-(\d{1,5})-([0-9a-f]+)$/;
const REQUEST_TIMEOUT_MS = 5_000;
const LSOF_TIMEOUT_MS = 5_000;
const BODY_EXCERPT = 300;

export function describeEndpoint(endpoint: LocalApiEndpoint): string {
  return endpoint.kind === "socket" ? `unix:${endpoint.socket}` : `127.0.0.1:${endpoint.port} (${endpoint.source} sameuserproof)`;
}

export interface Discovery {
  endpoints: LocalApiEndpoint[];
  notes: string[];
}

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  macsysDir?: string;
  sockets?: string[];
  lsof?: () => Promise<string>;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}

function tcpEndpoint(port: number, token: string, source: "app-store" | "macsys"): LocalApiEndpoint | undefined {
  return port > 0 && port <= 65_535 && token !== "" ? { kind: "tcp", port, token, source } : undefined;
}

export function parseLsofProofs(output: string): LocalApiEndpoint[] {
  const marker = `${APP_STORE_CONTAINER}/sameuserproof-`;
  const found: LocalApiEndpoint[] = [];
  for (const line of output.split("\n")) {
    const at = line.indexOf(marker);
    if (at === -1) continue;
    const match = PROOF_FILE.exec(`sameuserproof-${line.slice(at + marker.length).trim()}`);
    const endpoint = match === null ? undefined : tcpEndpoint(Number(match[1]), match[2] ?? "", "app-store");
    if (endpoint !== undefined) found.push(endpoint);
  }
  return found;
}

async function lsofIpnExtension(): Promise<string> {
  const binary = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const result = await runCommand(binary, ["-n", "-a", `-u${uid}`, "-c", "IPNExtension", "-F", "n"], { timeoutMs: LSOF_TIMEOUT_MS });
  return result.stdout;
}

async function groupContainerProofs(home: string, notes: string[]): Promise<LocalApiEndpoint[]> {
  const root = path.join(home, "Library", "Group Containers");
  let containers: string[];
  try {
    containers = (await readdir(root)).filter((name) => name.endsWith(APP_STORE_CONTAINER));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") notes.push(`cannot list ${root}: ${errorCode(error)}`);
    return [];
  }
  if (containers.length === 0) {
    notes.push(`no *${APP_STORE_CONTAINER} group container in ${root} (the App Store Tailscale is not installed for this user)`);
    return [];
  }
  const found: LocalApiEndpoint[] = [];
  for (const container of containers) {
    const directory = path.join(root, container);
    try {
      for (const name of await readdir(directory)) {
        const match = PROOF_FILE.exec(name);
        const endpoint = match === null ? undefined : tcpEndpoint(Number(match[1]), match[2] ?? "", "app-store");
        if (endpoint !== undefined) found.push(endpoint);
      }
    } catch (error) {
      const code = errorCode(error);
      notes.push(
        code === "EPERM" || code === "EACCES"
          ? `cannot read ${directory}: ${code}; macOS privacy protection keeps other apps' group containers from this process (a LaunchAgent cannot answer the access prompt)`
          : `cannot read ${directory}: ${code}`,
      );
      continue;
    }
    if (found.length === 0) notes.push(`no sameuserproof file in ${directory} (is the Tailscale app connected?)`);
  }
  return found;
}

async function macsysProof(directory: string, notes: string[]): Promise<LocalApiEndpoint[]> {
  let portText: string;
  try {
    portText = await readlink(path.join(directory, "ipnport"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") notes.push(`cannot read ${path.join(directory, "ipnport")}: ${errorCode(error)}`);
    return [];
  }
  const file = path.join(directory, `sameuserproof-${portText}`);
  try {
    const endpoint = tcpEndpoint(Number(portText), (await readFile(file, "utf8")).trim(), "macsys");
    if (endpoint !== undefined) return [endpoint];
    notes.push(`${file} holds no usable port and token`);
  } catch (error) {
    notes.push(`cannot read ${file}: ${errorCode(error)} (the standalone Tailscale app lets only the admin group read it)`);
  }
  return [];
}

export async function discoverLocalApi(options: DiscoveryOptions = {}): Promise<Discovery> {
  const env = options.env ?? process.env;
  const pinned = env.NECTAR_TAILSCALE_SOCKET;
  if (pinned !== undefined && pinned !== "") return { endpoints: [{ kind: "socket", socket: pinned, source: "env" }], notes: [] };
  const platform = options.platform ?? process.platform;
  const endpoints: LocalApiEndpoint[] = [];
  const notes: string[] = [];
  if (platform === "darwin") {
    try {
      endpoints.push(...parseLsofProofs(await (options.lsof ?? lsofIpnExtension)()));
    } catch (error) {
      notes.push(`lsof could not list IPNExtension's files: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (endpoints.length === 0) {
      notes.push("lsof found no IPNExtension sameuserproof file");
      endpoints.push(...(await groupContainerProofs(options.home ?? os.homedir(), notes)));
    }
    endpoints.push(...(await macsysProof(options.macsysDir ?? MACSYS_SHARED_DIR, notes)));
  }
  const sockets = options.sockets ?? (platform === "darwin" ? [DARWIN_TAILSCALED_SOCKET] : TAILSCALE_SOCKETS);
  const present = sockets.filter((socket) => existsSync(socket));
  if (present.length === 0) notes.push(`no tailscaled socket at ${sockets.join(" or ")}`);
  endpoints.push(...present.map((socket): LocalApiEndpoint => ({ kind: "socket", socket, source: "default" })));
  return { endpoints, notes };
}

export interface LocalApiResponse {
  status: number;
  etag: string | undefined;
  body: string;
}

export class LocalApiUnreachable extends Error {}

export interface LocalApiRequestOptions {
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export function localApiRequest(endpoint: LocalApiEndpoint, method: string, apiPath: string, options: LocalApiRequestOptions = {}): Promise<LocalApiResponse> {
  const headers: Record<string, string> = { Host: "local-tailscaled.sock", "Sec-Tailscale": "localapi", ...options.headers };
  if (endpoint.kind === "tcp") headers.Authorization = `Basic ${Buffer.from(`:${endpoint.token}`).toString("base64")}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        ...(endpoint.kind === "socket" ? { socketPath: endpoint.socket } : { host: "127.0.0.1", port: endpoint.port }),
        path: apiPath,
        method,
        headers,
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", (error) => reject(new LocalApiUnreachable(error.message)));
        response.on("end", () => {
          const etag = response.headers.etag;
          resolve({ status: response.statusCode ?? 0, etag: typeof etag === "string" ? etag : undefined, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error(`no answer within ${timeoutMs}ms`)));
    request.on("error", (error) => reject(new LocalApiUnreachable(errorCode(error))));
    request.end(options.body);
  });
}

export type LocalApiCall = { ok: true; endpoint: LocalApiEndpoint; response: LocalApiResponse } | { ok: false; reason: string };

let pinnedEndpoint: LocalApiEndpoint | undefined;
let cachedEndpoint: LocalApiEndpoint | undefined;

export function pinLocalApi(endpoint: LocalApiEndpoint | undefined): void {
  pinnedEndpoint = endpoint;
  cachedEndpoint = undefined;
}

async function attempt(endpoint: LocalApiEndpoint, method: string, apiPath: string, options: LocalApiRequestOptions): Promise<LocalApiResponse | string> {
  try {
    const response = await localApiRequest(endpoint, method, apiPath, options);
    if (endpoint.kind === "tcp" && response.status === 401) return `${describeEndpoint(endpoint)} refused its token (a stale sameuserproof)`;
    return response;
  } catch (error) {
    return `${describeEndpoint(endpoint)}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function sameEndpoint(a: LocalApiEndpoint, b: LocalApiEndpoint): boolean {
  if (a.kind === "socket") return b.kind === "socket" && a.socket === b.socket;
  return b.kind === "tcp" && a.port === b.port && a.token === b.token;
}

export async function callLocalApi(method: string, apiPath: string, options: LocalApiRequestOptions = {}): Promise<LocalApiCall> {
  const failures: string[] = [];
  const envPinned = process.env.NECTAR_TAILSCALE_SOCKET !== undefined && process.env.NECTAR_TAILSCALE_SOCKET !== "";
  const first = pinnedEndpoint ?? (envPinned ? undefined : cachedEndpoint);
  if (first !== undefined) {
    const response = await attempt(first, method, apiPath, options);
    if (typeof response !== "string") return { ok: true, endpoint: first, response };
    if (pinnedEndpoint !== undefined) return { ok: false, reason: `Tailscale LocalAPI unreachable: ${response}` };
    cachedEndpoint = undefined;
    failures.push(response);
  }
  const discovery = await discoverLocalApi();
  for (const endpoint of discovery.endpoints) {
    if (first !== undefined && sameEndpoint(endpoint, first)) continue;
    const response = await attempt(endpoint, method, apiPath, options);
    if (typeof response !== "string") {
      cachedEndpoint = endpoint;
      return { ok: true, endpoint, response };
    }
    failures.push(response);
  }
  return { ok: false, reason: `Tailscale LocalAPI unreachable: ${[...discovery.notes, ...failures].join("; ") || "nothing to try"}` };
}

export function bodyExcerpt(body: string): string {
  const flat = body.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > BODY_EXCERPT ? `${flat.slice(0, BODY_EXCERPT)}…` : flat;
}

export interface TailnetPeer {
  loginName: string;
  displayName: string;
  nodeName: string;
  dnsName: string;
  nodeId: string;
  userId: number;
  tailscaleIPs: string[];
  tags: string[];
}

export type WhoIsResult = { peer: TailnetPeer; reason?: undefined } | { peer?: undefined; reason: string; notFound: boolean };

interface WhoIsJson {
  Node?: { StableID?: string; Name?: string; ComputedName?: string; User?: number; Addresses?: string[] | null; Tags?: string[] | null };
  UserProfile?: { ID?: number; LoginName?: string; DisplayName?: string };
}

export async function whoIs(addr: string): Promise<WhoIsResult> {
  const call = await callLocalApi("GET", `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`);
  if (!call.ok) return { reason: call.reason, notFound: false };
  const { status, body } = call.response;
  if (status === 404) return { reason: `${addr} is not a tailnet peer`, notFound: true };
  if (status !== 200) return { reason: `Tailscale LocalAPI whois answered ${status}: "${bodyExcerpt(body)}"`, notFound: false };
  let parsed: WhoIsJson;
  try {
    parsed = JSON.parse(body) as WhoIsJson;
  } catch {
    return { reason: `Tailscale LocalAPI whois printed no JSON: "${bodyExcerpt(body)}"`, notFound: false };
  }
  const dnsName = (parsed.Node?.Name ?? "").replace(/\.$/, "");
  return {
    peer: {
      loginName: parsed.UserProfile?.LoginName ?? "",
      displayName: parsed.UserProfile?.DisplayName ?? "",
      nodeName: parsed.Node?.ComputedName || dnsName.split(".")[0] || "",
      dnsName,
      nodeId: parsed.Node?.StableID ?? "",
      userId: parsed.UserProfile?.ID ?? parsed.Node?.User ?? 0,
      tailscaleIPs: (parsed.Node?.Addresses ?? []).map((prefix) => prefix.replace(/\/\d+$/, "")),
      tags: parsed.Node?.Tags ?? [],
    },
  };
}

export interface StatusNodeJson {
  DNSName?: string;
  HostName?: string;
  UserID?: number;
  TailscaleIPs?: string[] | null;
  Tags?: string[] | null;
  Online?: boolean;
}

export interface StatusJson {
  BackendState?: string;
  Self?: StatusNodeJson;
  Peer?: Record<string, StatusNodeJson> | null;
  User?: Record<string, { ID?: number; LoginName?: string; DisplayName?: string }> | null;
}

export type StatusRead = { ok: true; endpoint: LocalApiEndpoint; status: StatusJson } | { ok: false; reachable: boolean; endpoint?: LocalApiEndpoint; reason: string };

export async function readStatus(): Promise<StatusRead> {
  const call = await callLocalApi("GET", "/localapi/v0/status");
  if (!call.ok) return { ok: false, reachable: false, reason: call.reason };
  const { status, body } = call.response;
  const where = `Tailscale LocalAPI ${describeEndpoint(call.endpoint)}`;
  if (status !== 200) return { ok: false, reachable: true, endpoint: call.endpoint, reason: `${where} status answered ${status}: "${bodyExcerpt(body)}"` };
  try {
    return { ok: true, endpoint: call.endpoint, status: JSON.parse(body) as StatusJson };
  } catch {
    return { ok: false, reachable: true, endpoint: call.endpoint, reason: `${where} status printed no JSON: "${bodyExcerpt(body)}"` };
  }
}

type JsonObject = Record<string, unknown>;

function objectAt(parent: JsonObject, key: string): JsonObject | undefined {
  const value = parent[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function dropIfEmpty(parent: JsonObject, key: string): void {
  const value = objectAt(parent, key);
  if (value !== undefined && Object.keys(value).length === 0) delete parent[key];
}

function tcpForwarding(config: JsonObject, port: number): boolean {
  const handler = objectAt(objectAt(config, "TCP") ?? {}, String(port));
  return handler !== undefined && handler.HTTPS !== true && handler.HTTP !== true;
}

export function setProxyHandler(config: JsonObject, dnsName: string, port: number, target: string): string | undefined {
  if (tcpForwarding(config, port)) return `cannot serve web on :${port}; it already forwards TCP`;
  const hostPort = `${dnsName}:${port}`;
  const tcp = objectAt(config, "TCP") ?? {};
  tcp[String(port)] = { HTTPS: true };
  config.TCP = tcp;
  const web = objectAt(config, "Web") ?? {};
  const server = objectAt(web, hostPort) ?? {};
  const handlers = objectAt(server, "Handlers") ?? {};
  delete handlers[""];
  handlers["/"] = { Proxy: target };
  server.Handlers = handlers;
  web[hostPort] = server;
  config.Web = web;
  const funnel = objectAt(config, "AllowFunnel");
  if (funnel !== undefined) delete funnel[hostPort];
  dropIfEmpty(config, "AllowFunnel");
  return undefined;
}

export function removeWebHandlers(config: JsonObject, dnsName: string, port: number): string | undefined {
  const hostPort = `${dnsName}:${port}`;
  if (tcpForwarding(config, port)) return `cannot remove web handler on :${port}; it forwards TCP`;
  const web = objectAt(config, "Web");
  const handlers = objectAt(objectAt(web ?? {}, hostPort) ?? {}, "Handlers");
  if (web === undefined || handlers === undefined || Object.keys(handlers).length === 0) return `handler does not exist on ${hostPort}`;
  delete web[hostPort];
  delete objectAt(config, "TCP")?.[String(port)];
  delete objectAt(config, "AllowFunnel")?.[hostPort];
  for (const key of ["Web", "TCP", "AllowFunnel"]) dropIfEmpty(config, key);
  return undefined;
}

export type ServeConfigRead = { ok: true; endpoint: LocalApiEndpoint; config: JsonObject; etag: string } | { ok: false; reachable: boolean; endpoint?: LocalApiEndpoint; reason: string; status?: number };

export async function readServeConfig(): Promise<ServeConfigRead> {
  const call = await callLocalApi("GET", "/localapi/v0/serve-config");
  if (!call.ok) return { ok: false, reachable: false, reason: call.reason };
  const { status, body, etag } = call.response;
  if (status !== 200) return { ok: false, reachable: true, endpoint: call.endpoint, status, reason: bodyExcerpt(body) || `serve-config answered ${status}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reachable: true, endpoint: call.endpoint, status, reason: `serve-config printed no JSON: "${bodyExcerpt(body)}"` };
  }
  const config = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
  return { ok: true, endpoint: call.endpoint, config, etag: etag ?? "" };
}

export type ServeConfigEdit = (config: JsonObject) => string | undefined;

export type ServeConfigWrite = { ok: true; endpoint: LocalApiEndpoint; attempts: number } | { ok: false; reachable: boolean; endpoint?: LocalApiEndpoint; reason: string; status?: number };

export const SERVE_CONFIG_ATTEMPTS = 4;

export async function editServeConfig(edit: ServeConfigEdit): Promise<ServeConfigWrite> {
  let conflict = "";
  for (let attempts = 1; attempts <= SERVE_CONFIG_ATTEMPTS; attempts += 1) {
    const read = await readServeConfig();
    if (!read.ok) return read;
    const refused = edit(read.config);
    if (refused !== undefined) return { ok: false, reachable: true, endpoint: read.endpoint, reason: refused };
    const call = await callLocalApi("POST", "/localapi/v0/serve-config", {
      body: JSON.stringify(read.config),
      ...(read.etag === "" ? {} : { headers: { "If-Match": read.etag } }),
    });
    if (!call.ok) return { ok: false, reachable: false, reason: call.reason };
    const { status, body } = call.response;
    if (status === 200) return { ok: true, endpoint: call.endpoint, attempts };
    if (status !== 412) return { ok: false, reachable: true, endpoint: call.endpoint, status, reason: bodyExcerpt(body) || `serve-config POST answered ${status}` };
    conflict = bodyExcerpt(body);
  }
  return { ok: false, reachable: true, reason: `serve config kept changing under Nectar (${SERVE_CONFIG_ATTEMPTS} ETag conflicts${conflict === "" ? "" : `: "${conflict}"`})` };
}
