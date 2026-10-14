import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { readStatus, whoIs as localWhoIs, type StatusRead, type WhoIsResult } from "./localapi.js";

export const RELAYD_CONTROL_PORT = 8450;
export const RELAYD_VERIFY_PORT = 8451;
export const PREVIEW_PORT_MIN = 8443;
export const PREVIEW_PORT_MAX = 8542;
export const GATED_CAP_MS = 30 * 24 * 60 * 60_000;
export const UNGATED_CAP_MS = 7 * 24 * 60 * 60_000;
export const PRUNE_INTERVAL_MS = 60 * 60_000;
export const TOMBSTONE_MS = 30 * 24 * 60 * 60_000;
export const ADMIN_NODE = "admin";
export const RESERVED_NAMES = new Set([
  "www", "api", "app", "apps", "auth", "login", "logout", "signin", "signup", "sso", "oauth", "id", "account", "accounts",
  "admin", "administrator", "root", "mail", "email", "smtp", "imap", "pop", "mx", "ns", "ns1", "ns2", "dns", "ftp", "vpn",
  "status", "dashboard", "console", "billing", "pay", "payment", "support", "help", "docs", "blog", "static", "cdn", "assets",
  "relay", "control", "nectar", "nctr", "secure", "security", "abuse", "postmaster", "webmaster", "hostmaster", "wpad", "autodiscover",
]);
const SUB = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PASSWORD_HASH = /^[A-Za-z0-9./$+=]{20,200}$/;
const LEGACY_UPSTREAM = /^https:\/\/[a-zA-Z0-9._-]+(:[0-9]+)?$/;
const MAX_BODY_BYTES = 16 * 1024;
const WHOIS_DEADLINE_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 64;
const MAX_CONNECTIONS_PER_PEER = 8;
const SUFFIX_BYTES = 4;
const BASE_BUDGET = 63 - 1 - SUFFIX_BYTES * 2;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 128;
const BIND_RETRY_MS = 10_000;

export type Gate = "password" | "none";

export interface NodeEntry {
  node_id: string;
  name?: string;
}

export type ReloadSpec = { argv: string[] } | { stamp: string } | { none: true };

export interface RelaydConfig {
  domain: string;
  allow: NodeEntry[];
  ungated: NodeEntry[];
  state_dir: string;
  routes_dir: string;
  admin_socket: string;
  control: { address?: string; port: number };
  verify: { port: number };
  reload: ReloadSpec;
  hash: string[];
  max_routes_per_node: number;
  max_routes: number;
}

export interface Owner {
  node_id: string;
  node_name: string;
}

export interface Route {
  sub: string;
  owner: Owner;
  upstream: string;
  gate: Gate;
  password_hash?: string;
  created_at: number;
  expires_at: number;
  cap_at: number;
  generation: number;
  last_view_at: number | null;
}

export interface Tombstone {
  sub: string;
  owner: Owner;
  revoked_at: number;
  reason: "admin" | "kill" | "expired";
}

export interface KillFlags {
  all: { at: number } | null;
  nodes: Record<string, { at: number; name: string }>;
}

export interface RelaydState {
  version: 1;
  routes: Record<string, Route>;
  revoked: Record<string, Tombstone>;
  kill: KillFlags;
}

export interface Peer {
  node_id: string;
  node_name: string;
  dns_name: string;
}

export class RelaydError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  if (isObject(error) && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.message : String(error);
}

function nodeEntries(value: unknown, key: string): NodeEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${key} must be a list of {node_id}`);
  return value.map((entry: unknown, index) => {
    if (!isObject(entry) || typeof entry.node_id !== "string" || !/^[A-Za-z0-9]{4,64}$/.test(entry.node_id)) {
      throw new Error(`${key}[${index}] needs a stable node_id`);
    }
    if (entry.name !== undefined && typeof entry.name !== "string") throw new Error(`${key}[${index}].name must be a string`);
    return { node_id: entry.node_id, ...(typeof entry.name === "string" ? { name: entry.name } : {}) };
  });
}

function absolute(value: unknown, key: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
  return path.normalize(value);
}

function port(value: unknown, fallback: number, key: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= 65_536) throw new Error(`${key} must be a TCP port`);
  return value;
}

function positive(value: unknown, fallback: number, key: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

function argv(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item !== "")) {
    throw new Error(`${key} must be a non-empty list of strings`);
  }
  return value as string[];
}

function reloadSpec(value: unknown): ReloadSpec {
  if (!isObject(value)) throw new Error("reload must be {argv: [...]}, {stamp: \"/path\"} or {none: true}");
  if (value.argv !== undefined) return { argv: argv(value.argv, "reload.argv") };
  if (value.stamp !== undefined) return { stamp: absolute(value.stamp, "reload.stamp") };
  if (value.none === true) return { none: true };
  throw new Error("reload must be {argv: [...]}, {stamp: \"/path\"} or {none: true}");
}

export function parseConfig(text: string): RelaydConfig {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw)) throw new Error("config must be a JSON object");
  if (typeof raw.domain !== "string" || !DOMAIN.test(raw.domain)) throw new Error("domain must be a lowercase DNS name such as nctr.site");
  const control = raw.control === undefined ? {} : raw.control;
  const verify = raw.verify === undefined ? {} : raw.verify;
  if (!isObject(control) || !isObject(verify)) throw new Error("control and verify must be objects");
  if (control.address !== undefined && (typeof control.address !== "string" || !net.isIPv4(control.address))) {
    throw new Error("control.address must be this node's Tailscale IPv4 address");
  }
  return {
    domain: raw.domain,
    allow: nodeEntries(raw.allow, "allow"),
    ungated: nodeEntries(raw.ungated, "ungated"),
    state_dir: absolute(raw.state_dir, "state_dir"),
    routes_dir: absolute(raw.routes_dir, "routes_dir"),
    admin_socket: absolute(raw.admin_socket, "admin_socket"),
    control: { ...(typeof control.address === "string" ? { address: control.address } : {}), port: port(control.port, RELAYD_CONTROL_PORT, "control.port") },
    verify: { port: port(verify.port, RELAYD_VERIFY_PORT, "verify.port") },
    reload: reloadSpec(raw.reload ?? { none: true }),
    hash: raw.hash === undefined ? ["caddy", "hash-password"] : argv(raw.hash, "hash"),
    max_routes_per_node: positive(raw.max_routes_per_node, 50, "max_routes_per_node"),
    max_routes: positive(raw.max_routes, 200, "max_routes"),
  };
}

export async function loadConfig(file: string): Promise<RelaydConfig> {
  return parseConfig(await readFile(file, "utf8"));
}

function table<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function emptyState(): RelaydState {
  return { version: 1, routes: table(), revoked: table(), kill: { all: null, nodes: table() } };
}

function checkOwner(value: unknown): Owner {
  if (!isObject(value) || typeof value.node_id !== "string" || typeof value.node_name !== "string") throw new Error("route owner is malformed");
  return { node_id: value.node_id, node_name: value.node_name };
}

function checkRoute(sub: string, value: unknown): Route {
  if (!isObject(value) || value.sub !== sub || !SUB.test(sub)) throw new Error(`route ${sub} is malformed`);
  const numbers = ["created_at", "expires_at", "cap_at", "generation"] as const;
  for (const key of numbers) if (typeof value[key] !== "number") throw new Error(`route ${sub} has no ${key}`);
  if (value.gate !== "password" && value.gate !== "none") throw new Error(`route ${sub} has no gate`);
  if (typeof value.upstream !== "string" || !LEGACY_UPSTREAM.test(value.upstream)) throw new Error(`route ${sub} has a bad upstream`);
  if (value.gate === "password" && (typeof value.password_hash !== "string" || !PASSWORD_HASH.test(value.password_hash))) throw new Error(`route ${sub} has no password hash`);
  return {
    sub,
    owner: checkOwner(value.owner),
    upstream: value.upstream,
    gate: value.gate,
    ...(value.gate === "password" ? { password_hash: value.password_hash as string } : {}),
    created_at: value.created_at as number,
    expires_at: value.expires_at as number,
    cap_at: value.cap_at as number,
    generation: value.generation as number,
    last_view_at: typeof value.last_view_at === "number" ? value.last_view_at : null,
  };
}

export function parseState(text: string): RelaydState {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw) || raw.version !== 1 || !isObject(raw.routes) || !isObject(raw.revoked) || !isObject(raw.kill)) throw new Error("state file is malformed");
  const routes = table<Route>();
  for (const [sub, value] of Object.entries(raw.routes)) routes[sub] = checkRoute(sub, value);
  const revoked = table<Tombstone>();
  for (const [sub, value] of Object.entries(raw.revoked)) {
    if (!isObject(value) || typeof value.revoked_at !== "number" || !["admin", "kill", "expired"].includes(String(value.reason))) throw new Error(`tombstone ${sub} is malformed`);
    revoked[sub] = { sub, owner: checkOwner(value.owner), revoked_at: value.revoked_at, reason: value.reason as Tombstone["reason"] };
  }
  const nodes: KillFlags["nodes"] = table();
  const rawNodes = isObject(raw.kill.nodes) ? raw.kill.nodes : {};
  for (const [id, value] of Object.entries(rawNodes)) {
    if (!isObject(value) || typeof value.at !== "number") throw new Error(`kill flag ${id} is malformed`);
    nodes[id] = { at: value.at, name: typeof value.name === "string" ? value.name : id };
  }
  const all = isObject(raw.kill.all) && typeof raw.kill.all.at === "number" ? { at: raw.kill.all.at } : null;
  return { version: 1, routes, revoked, kill: { all, nodes } };
}

export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, BASE_BUDGET)
    .replace(/-+$/, "");
}

export function reservedName(base: string): boolean {
  const first = base.split("-")[0] ?? "";
  return RESERVED_NAMES.has(base) || RESERVED_NAMES.has(first) || base.startsWith("xn--");
}

export function renderRoute(route: Route, domain: string): string {
  if (!SUB.test(route.sub) || !DOMAIN.test(domain) || !LEGACY_UPSTREAM.test(route.upstream)) throw new Error(`refusing to render route ${route.sub}`);
  const lines = [
    "# nectar-relayd route — do not edit by hand",
    `# expires ${Math.floor(route.expires_at / 1000)}`,
    `# upstream ${route.upstream}`,
    `# owner ${route.owner.node_id}`,
    `@${route.sub} host ${route.sub}.${domain}`,
    `handle @${route.sub} {`,
  ];
  if (route.gate === "password") {
    if (route.password_hash === undefined || !PASSWORD_HASH.test(route.password_hash)) throw new Error(`refusing to render route ${route.sub} without a password hash`);
    lines.push("    basic_auth {", `        reviewer ${route.password_hash}`, "    }");
  }
  lines.push(`    reverse_proxy ${route.upstream} {`);
  if (route.gate === "password") lines.push("        header_up -Authorization");
  lines.push("        transport http {", "            tls", "        }", "    }", "}", "");
  return lines.join("\n");
}

export function parseLegacyRoute(sub: string, text: string, now: number): Route | undefined {
  if (!SUB.test(sub)) return undefined;
  const expires = /^# expires (\d{1,12})$/m.exec(text)?.[1];
  const upstream = /^# upstream (\S+)$/m.exec(text)?.[1];
  if (expires === undefined || upstream === undefined || !LEGACY_UPSTREAM.test(upstream)) return undefined;
  const hash = /^\s*reviewer (\S+)\s*$/m.exec(text)?.[1];
  if (hash !== undefined && !PASSWORD_HASH.test(hash)) return undefined;
  const expiresAt = Number(expires) * 1000;
  return {
    sub,
    owner: { node_id: ADMIN_NODE, node_name: "legacy" },
    upstream,
    gate: hash === undefined ? "none" : "password",
    ...(hash === undefined ? {} : { password_hash: hash }),
    created_at: now,
    expires_at: expiresAt,
    cap_at: Math.max(expiresAt, now),
    generation: 1,
    last_view_at: null,
  };
}

export function publicRoute(route: Route, domain: string): Record<string, unknown> {
  return {
    sub: route.sub,
    url: `https://${route.sub}.${domain}`,
    gate: route.gate,
    upstream: route.upstream,
    expires_at: new Date(route.expires_at).toISOString(),
    cap_at: new Date(route.cap_at).toISOString(),
    created_at: new Date(route.created_at).toISOString(),
    generation: route.generation,
    last_view_at: route.last_view_at === null ? null : new Date(route.last_view_at).toISOString(),
    revoked: false,
  };
}

function tombstoneView(tombstone: Tombstone, domain: string): Record<string, unknown> {
  return {
    sub: tombstone.sub,
    url: `https://${tombstone.sub}.${domain}`,
    revoked: true,
    revoked_at: new Date(tombstone.revoked_at).toISOString(),
    reason: tombstone.reason,
  };
}

function runArgv(command: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = command;
    const child = execFile(bin ?? "", args, { timeout: 30_000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" } }, (error, stdout) => {
      if (error) reject(new Error(`${path.basename(bin ?? "")} failed: ${errorCode(error)}`));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

export async function caddyHash(command: string[], password: string): Promise<string> {
  const out = (await runArgv(command, `${password}\n`)).trim();
  if (!PASSWORD_HASH.test(out)) throw new Error("the password hasher printed no usable hash");
  return out;
}

export interface RelaydDeps {
  whois: (address: string) => Promise<WhoIsResult>;
  status: () => Promise<StatusRead>;
  hash: (password: string) => Promise<string>;
  now: () => number;
  log: (event: Record<string, unknown>) => void;
  random: (bytes: number) => Buffer;
  bind?: string;
}

export interface Relayd {
  control: { address: string; port: number } | null;
  verify: { address: string; port: number };
  admin: string;
  state: () => RelaydState;
  prune: () => Promise<number>;
  close: () => Promise<void>;
}

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RelaydError(413, "E_USAGE", "request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RelaydError(400, "E_USAGE", "request body must be JSON");
  }
  if (!isObject(parsed)) throw new RelaydError(400, "E_USAGE", "request body must be a JSON object");
  return parsed;
}

function only(body: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(body)) if (!keys.includes(key)) throw new RelaydError(400, "E_USAGE", `unknown field '${key}'`);
}

function send(response: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
  response.end(`${JSON.stringify(body)}\n`);
}

function failure(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof RelaydError) return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message, ...error.details } } };
  return { status: 500, body: { ok: false, error: { code: "E_INTERNAL", message: "relayd hit an internal error" } } };
}

function password(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < MIN_PASSWORD || value.length > MAX_PASSWORD || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RelaydError(400, "E_USAGE", `password must be ${MIN_PASSWORD}–${MAX_PASSWORD} characters with no control characters`);
  }
  return value;
}

function epochSeconds(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new RelaydError(400, "E_USAGE", `${key} must be a unix epoch in seconds`);
  return value * 1000;
}

export function upstreamFor(peer: Peer, value: unknown): string {
  if (typeof value !== "string") throw new RelaydError(400, "E_USAGE", "upstream must be https://<your MagicDNS name>:<port>");
  const match = /^https:\/\/([a-z0-9.-]+):(\d{1,5})\/?$/.exec(value.toLowerCase());
  const host = match?.[1];
  const portNumber = Number(match?.[2]);
  if (host === undefined || host !== peer.dns_name || !DNS_NAME.test(host)) {
    throw new RelaydError(403, "E_FORBIDDEN", `upstream must be on your own MagicDNS name (${peer.dns_name})`, { rule: "upstream_host" });
  }
  if (!Number.isInteger(portNumber) || portNumber < PREVIEW_PORT_MIN || portNumber > PREVIEW_PORT_MAX) {
    throw new RelaydError(403, "E_FORBIDDEN", `upstream port must be a Nectar preview port (${PREVIEW_PORT_MIN}–${PREVIEW_PORT_MAX})`, { rule: "upstream_port" });
  }
  return `https://${host}:${portNumber}`;
}

export function peerFromWhoIs(found: WhoIsResult): Peer | string {
  if (found.peer === undefined) return found.reason;
  const dns = found.peer.dnsName.toLowerCase().replace(/\.$/, "");
  if (found.peer.nodeId === "" || !DNS_NAME.test(dns)) return "tailscaled named no stable node ID or MagicDNS name";
  return { node_id: found.peer.nodeId, node_name: (found.peer.nodeName || dns.split(".")[0] || "").toLowerCase(), dns_name: dns };
}

export async function startRelayd(configFile: string, overrides: Partial<RelaydDeps> = {}): Promise<Relayd> {
  const config = await loadConfig(configFile);
  const deps: RelaydDeps = {
    whois: localWhoIs,
    status: readStatus,
    hash: (secret) => caddyHash(config.hash, secret),
    now: () => Date.now(),
    log: (event) => process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`),
    random: (bytes) => crypto.randomBytes(bytes),
    ...overrides,
  };
  const stateFile = path.join(config.state_dir, "state.json");
  await mkdir(config.state_dir, { recursive: true, mode: 0o700 });
  await mkdir(config.routes_dir, { recursive: true, mode: 0o750 });
  let state: RelaydState;
  try {
    state = parseState(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw new Error(`relayd will not start on an unreadable state file ${stateFile}: ${error instanceof Error ? error.message : String(error)}`);
    state = emptyState();
  }

  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const save = async (): Promise<void> => {
    const temp = `${stateFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, stateFile);
  };
  const routeFile = (sub: string): string => path.join(config.routes_dir, `${sub}.caddy`);
  const writeRoute = async (route: Route): Promise<void> => {
    const temp = path.join(config.routes_dir, `.${route.sub}.${crypto.randomBytes(4).toString("hex")}`);
    await writeFile(temp, renderRoute(route, config.domain), { mode: 0o640 });
    await rename(temp, routeFile(route.sub));
  };
  const reload = async (): Promise<void> => {
    if ("argv" in config.reload) await runArgv(config.reload.argv);
    else if ("stamp" in config.reload) await writeFile(config.reload.stamp, `${deps.now()}\n`, { mode: 0o640 });
  };
  const reloadOrLog = async (why: string): Promise<boolean> => {
    try {
      await reload();
      return true;
    } catch (error) {
      deps.log({ event: "reload_failed", why, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  const importLegacy = async (): Promise<number> => {
    let imported = 0;
    for (const name of await readdir(config.routes_dir)) {
      if (!name.endsWith(".caddy")) continue;
      const sub = name.slice(0, -".caddy".length);
      if (state.routes[sub] !== undefined) continue;
      const file = routeFile(sub);
      const info = await lstat(file);
      if (!info.isFile()) continue;
      const route = parseLegacyRoute(sub, await readFile(file, "utf8"), deps.now());
      if (route === undefined) {
        deps.log({ event: "legacy_skipped", sub });
        continue;
      }
      state.routes[sub] = route;
      imported += 1;
    }
    return imported;
  };
  const converge = async (): Promise<void> => {
    for (const route of Object.values(state.routes)) await writeRoute(route);
    for (const name of await readdir(config.routes_dir)) {
      const sub = name.endsWith(".caddy") ? name.slice(0, -".caddy".length) : undefined;
      if (sub !== undefined && state.routes[sub] === undefined) await rm(routeFile(sub), { force: true });
      else if (name.startsWith(".") && !name.startsWith("..")) await rm(path.join(config.routes_dir, name), { force: true });
    }
  };

  const revoke = (route: Route, reason: Tombstone["reason"]): void => {
    delete state.routes[route.sub];
    state.revoked[route.sub] = { sub: route.sub, owner: route.owner, revoked_at: deps.now(), reason };
  };
  const removeFiles = async (subs: string[]): Promise<void> => {
    for (const sub of subs) await rm(routeFile(sub), { force: true });
  };

  const pruneNow = (): Promise<number> =>
    serialized(async () => {
      const now = deps.now();
      const expired = Object.values(state.routes).filter((route) => route.expires_at <= now || route.cap_at <= now);
      for (const route of expired) revoke(route, "expired");
      let dropped = 0;
      for (const tombstone of Object.values(state.revoked)) {
        if (now - tombstone.revoked_at > TOMBSTONE_MS) {
          delete state.revoked[tombstone.sub];
          dropped += 1;
        }
      }
      if (expired.length === 0 && dropped === 0) return 0;
      await save();
      await removeFiles(expired.map((route) => route.sub));
      if (expired.length > 0) await reloadOrLog("prune");
      deps.log({ event: "prune", removed: expired.map((route) => route.sub), tombstones_dropped: dropped });
      return expired.length;
    });

  const imported = await importLegacy();
  await save();
  await converge();
  if (imported > 0) deps.log({ event: "legacy_imported", routes: imported });
  await reloadOrLog("start");
  await pruneNow();

  const mintSub = (base: string): string => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sub = `${base}-${deps.random(SUFFIX_BYTES).toString("hex")}`;
      if (state.routes[sub] === undefined && state.revoked[sub] === undefined) return sub;
    }
    throw new RelaydError(503, "E_BUSY", "could not mint a free name; try again");
  };

  const access = async (): Promise<{ allow: NodeEntry[]; ungated: NodeEntry[] }> => {
    try {
      const current = await loadConfig(configFile);
      if (current.domain !== config.domain) throw new Error("domain changed; restart relayd");
      return { allow: current.allow, ungated: current.ungated };
    } catch (error) {
      deps.log({ event: "config_unreadable", message: error instanceof Error ? error.message : String(error) });
      throw new RelaydError(403, "E_FORBIDDEN", "relayd cannot read its allowlist, so it refuses every caller", { rule: "config" });
    }
  };

  const live = (route: Route | undefined): Route | undefined => (route !== undefined && route.expires_at > deps.now() && route.cap_at > deps.now() ? route : undefined);

  const owned = (sub: string, peer: Peer): Route => {
    if (!SUB.test(sub)) throw new RelaydError(400, "E_USAGE", "not a route name");
    const route = live(state.routes[sub]);
    if (route === undefined) {
      const tombstone = state.revoked[sub];
      throw new RelaydError(404, "E_NOT_FOUND", `no live route ${sub}`, tombstone !== undefined && tombstone.owner.node_id === peer.node_id ? { revoked: true, reason: tombstone.reason } : {});
    }
    if (route.owner.node_id !== peer.node_id) throw new RelaydError(403, "E_FORBIDDEN", `${sub} belongs to another node`, { rule: "not_owner" });
    return route;
  };

  const capFor = (gate: Gate): number => (gate === "none" ? UNGATED_CAP_MS : GATED_CAP_MS);

  const gateFor = async (gate: unknown, peer: Peer, ungated: NodeEntry[], given: unknown): Promise<{ gate: Gate; hash?: string; password?: string }> => {
    if (gate !== "password" && gate !== "none") throw new RelaydError(400, "E_USAGE", "gate must be 'password' or 'none'");
    if (gate === "none") {
      if (given !== undefined) throw new RelaydError(400, "E_USAGE", "an ungated route takes no password");
      if (!ungated.some((entry) => entry.node_id === peer.node_id)) {
        throw new RelaydError(403, "E_FORBIDDEN", "this relay does not allow ungated routes from your node", { rule: "ungated" });
      }
      return { gate };
    }
    const secret = password(given) ?? deps.random(12).toString("base64url");
    let hash: string;
    try {
      hash = await deps.hash(secret);
    } catch (error) {
      deps.log({ event: "hash_failed", message: error instanceof Error ? error.message : String(error) });
      throw new RelaydError(502, "E_INTERNAL", "relayd could not hash the password");
    }
    return { gate, hash, ...(given === undefined ? { password: secret } : {}) };
  };

  const create = (peer: Peer, body: Record<string, unknown>, ungated: NodeEntry[]): Promise<Record<string, unknown>> => {
    only(body, ["name", "upstream", "expires_at", "gate", "password"]);
    if (typeof body.name !== "string" || body.name.length > 200) throw new RelaydError(400, "E_USAGE", "name must be <app>-<branch>");
    const base = sanitizeName(body.name);
    if (base === "") throw new RelaydError(400, "E_USAGE", "name has no usable characters");
    if (reservedName(base)) throw new RelaydError(403, "E_FORBIDDEN", `'${base}' is a reserved name`, { rule: "reserved" });
    const upstream = upstreamFor(peer, body.upstream);
    const requested = epochSeconds(body.expires_at, "expires_at");
    return serialized(async () => {
      if (state.kill.all !== null) throw new RelaydError(403, "E_KILLED", "the relay is disabled; new routes are refused until an operator lifts it", { rule: "killed" });
      if (state.kill.nodes[peer.node_id] !== undefined) throw new RelaydError(403, "E_KILLED", "routes from your node are disabled on this relay until an operator lifts it", { rule: "killed" });
      const now = deps.now();
      if (requested <= now) throw new RelaydError(400, "E_USAGE", "expires_at is in the past");
      const all = Object.values(state.routes);
      if (all.length >= config.max_routes) throw new RelaydError(429, "E_QUOTA", `the relay holds its maximum of ${config.max_routes} routes`);
      if (all.filter((route) => route.owner.node_id === peer.node_id).length >= config.max_routes_per_node) {
        throw new RelaydError(429, "E_QUOTA", `your node holds its maximum of ${config.max_routes_per_node} routes`);
      }
      const gate = await gateFor(body.gate, peer, ungated, body.password);
      const sub = mintSub(base);
      const cap = now + capFor(gate.gate);
      const route: Route = {
        sub,
        owner: { node_id: peer.node_id, node_name: peer.node_name },
        upstream,
        gate: gate.gate,
        ...(gate.hash === undefined ? {} : { password_hash: gate.hash }),
        created_at: now,
        expires_at: Math.min(requested, cap),
        cap_at: cap,
        generation: 1,
        last_view_at: null,
      };
      state.routes[sub] = route;
      try {
        await writeRoute(route);
        await reload();
      } catch (error) {
        delete state.routes[sub];
        await rm(routeFile(sub), { force: true });
        await reloadOrLog("revert");
        deps.log({ event: "create_failed", sub, message: error instanceof Error ? error.message : String(error) });
        throw new RelaydError(502, "E_RELOAD", "the relay could not load the new route");
      }
      await save();
      deps.log({ event: "route_created", sub, node_id: peer.node_id, node_name: peer.node_name, gate: route.gate, expires_at: new Date(route.expires_at).toISOString() });
      return { ...publicRoute(route, config.domain), ...(gate.password === undefined ? {} : { password: gate.password }) };
    });
  };

  const update = (peer: Peer, sub: string, body: Record<string, unknown>, ungated: NodeEntry[]): Promise<Record<string, unknown>> => {
    only(body, ["expires_at", "gate", "password"]);
    return serialized(async () => {
      const route = owned(sub, peer);
      const next: Route = { ...route };
      let minted: string | undefined;
      if (body.gate !== undefined && body.gate !== route.gate) {
        const gate = await gateFor(body.gate, peer, ungated, body.password);
        next.gate = gate.gate;
        if (gate.hash === undefined) delete next.password_hash;
        else next.password_hash = gate.hash;
        next.cap_at = Math.min(route.cap_at, route.created_at + capFor(gate.gate));
        next.generation += 1;
        minted = gate.password;
      } else if (body.password !== undefined) {
        throw new RelaydError(400, "E_USAGE", "change a password with rotate");
      }
      if (body.expires_at !== undefined) {
        const requested = epochSeconds(body.expires_at, "expires_at");
        if (requested <= deps.now()) throw new RelaydError(400, "E_USAGE", "expires_at is in the past");
        next.expires_at = requested;
      }
      next.expires_at = Math.min(next.expires_at, next.cap_at);
      state.routes[sub] = next;
      try {
        await writeRoute(next);
        await reload();
      } catch (error) {
        state.routes[sub] = route;
        await writeRoute(route).catch(() => undefined);
        await reloadOrLog("revert");
        deps.log({ event: "update_failed", sub, message: error instanceof Error ? error.message : String(error) });
        throw new RelaydError(502, "E_RELOAD", "the relay could not load the updated route");
      }
      await save();
      deps.log({ event: "route_updated", sub, node_id: peer.node_id, gate: next.gate, expires_at: new Date(next.expires_at).toISOString() });
      return { ...publicRoute(next, config.domain), ...(minted === undefined ? {} : { password: minted }) };
    });
  };

  const rotate = (peer: Peer, sub: string): Promise<Record<string, unknown>> =>
    serialized(async () => {
      const route = owned(sub, peer);
      if (route.gate !== "password") throw new RelaydError(409, "E_USAGE", `${sub} is ungated; there is nothing to rotate`);
      const secret = deps.random(12).toString("base64url");
      let hash: string;
      try {
        hash = await deps.hash(secret);
      } catch {
        throw new RelaydError(502, "E_INTERNAL", "relayd could not hash the password");
      }
      const next: Route = { ...route, password_hash: hash, generation: route.generation + 1 };
      state.routes[sub] = next;
      try {
        await writeRoute(next);
        await reload();
      } catch {
        state.routes[sub] = route;
        await writeRoute(route).catch(() => undefined);
        await reloadOrLog("revert");
        throw new RelaydError(502, "E_RELOAD", "the relay could not load the rotated route");
      }
      await save();
      deps.log({ event: "route_rotated", sub, node_id: peer.node_id, generation: next.generation });
      return { ...publicRoute(next, config.domain), password: secret };
    });

  const remove = (peer: Peer, sub: string): Promise<Record<string, unknown>> =>
    serialized(async () => {
      owned(sub, peer);
      delete state.routes[sub];
      await save();
      await removeFiles([sub]);
      const reloaded = await reloadOrLog("delete");
      deps.log({ event: "route_deleted", sub, node_id: peer.node_id });
      return { sub, removed: true, ...(reloaded ? {} : { reload: "failed" }) };
    });

  const mine = (peer: Peer): Record<string, unknown> => ({
    node_id: peer.node_id,
    routes: [
      ...Object.values(state.routes)
        .filter((route) => route.owner.node_id === peer.node_id)
        .map((route) => (live(route) === undefined ? { ...tombstoneView({ sub: route.sub, owner: route.owner, revoked_at: route.expires_at, reason: "expired" }, config.domain) } : publicRoute(route, config.domain))),
      ...Object.values(state.revoked)
        .filter((tombstone) => tombstone.owner.node_id === peer.node_id)
        .map((tombstone) => tombstoneView(tombstone, config.domain)),
    ],
    killed: state.kill.all !== null || state.kill.nodes[peer.node_id] !== undefined,
  });

  const status = await deps.status();
  const self = status.ok ? status.status.Self : undefined;
  const selfIps = new Set(self?.TailscaleIPs ?? []);
  let selfId = self?.ID;

  const identify = async (request: http.IncomingMessage): Promise<Peer> => {
    const raw = (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (selfIps.has(raw)) throw new RelaydError(403, "E_FORBIDDEN", "callers on the relay itself use nectar-relay, not the tailnet listener", { rule: "self" });
    const address = net.isIPv6(raw) ? `[${raw}]:${request.socket.remotePort}` : `${raw}:${request.socket.remotePort}`;
    let found: WhoIsResult;
    try {
      found = await withDeadline(deps.whois(address), WHOIS_DEADLINE_MS, { reason: "tailscaled WhoIs did not answer in time", notFound: false });
    } catch (error) {
      found = { reason: `tailscaled WhoIs failed: ${error instanceof Error ? error.message : String(error)}`, notFound: false };
    }
    const peer = peerFromWhoIs(found);
    if (typeof peer === "string") throw new RelaydError(403, "E_FORBIDDEN", "relayd serves only nodes tailscaled can identify", { rule: "whois", whois: peer });
    if (selfId !== undefined && peer.node_id === selfId) throw new RelaydError(403, "E_FORBIDDEN", "callers on the relay itself use nectar-relay, not the tailnet listener", { rule: "self" });
    return peer;
  };

  const controlServer = http.createServer((request, response) => {
    let peer: Peer | undefined;
    const url = new URL(request.url ?? "/", "http://relayd");
    const handle = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
      peer = await identify(request);
      const { allow, ungated } = await access();
      if (!allow.some((entry) => entry.node_id === peer?.node_id)) {
        throw new RelaydError(403, "E_FORBIDDEN", `${peer.node_name} (${peer.node_id}) is not on this relay's allowlist`, { rule: "not_allowed", node_id: peer.node_id });
      }
      const parts = url.pathname.split("/").filter((part) => part !== "");
      if (parts[0] !== "routes" || parts.length > 3) throw new RelaydError(404, "E_NOT_FOUND", `no ${request.method ?? ""} ${url.pathname}`);
      const sub = parts[1];
      if (request.method === "GET" && sub === undefined) {
        if (url.searchParams.get("mine") !== "1") throw new RelaydError(400, "E_USAGE", "list your own routes with GET /routes?mine=1");
        return { status: 200, body: { ok: true, ...mine(peer) } };
      }
      if (request.method === "PUT" && sub === undefined) return { status: 201, body: { ok: true, ...(await create(peer, await readBody(request), ungated)) } };
      if (sub !== undefined && parts.length === 2 && request.method === "PATCH") return { status: 200, body: { ok: true, ...(await update(peer, sub, await readBody(request), ungated)) } };
      if (sub !== undefined && parts.length === 2 && request.method === "DELETE") return { status: 200, body: { ok: true, ...(await remove(peer, sub)) } };
      if (sub !== undefined && parts[2] === "rotate" && request.method === "POST") return { status: 200, body: { ok: true, ...(await rotate(peer, sub)) } };
      throw new RelaydError(405, "E_USAGE", `no ${request.method ?? ""} ${url.pathname}`);
    };
    void handle()
      .catch(failure)
      .then(({ status, body }) => {
        const error = isObject(body.error) ? body.error : undefined;
        deps.log({
          event: "control",
          method: request.method,
          path: url.pathname,
          status,
          node_id: peer?.node_id ?? null,
          node_name: peer?.node_name ?? null,
          ...(error === undefined ? {} : { code: error.code, rule: error.rule ?? null, ...(typeof error.whois === "string" ? { whois: error.whois } : {}) }),
        });
        if (error !== undefined) delete error.whois;
        send(response, status, body);
        if (!request.complete) response.once("finish", () => request.destroy());
      });
  });
  controlServer.requestTimeout = REQUEST_TIMEOUT_MS;
  controlServer.headersTimeout = HEADERS_TIMEOUT_MS;
  controlServer.maxConnections = MAX_CONNECTIONS;
  const perPeer = new Map<string, number>();
  controlServer.on("connection", (socket: net.Socket) => {
    const peer = socket.remoteAddress ?? "";
    const open = (perPeer.get(peer) ?? 0) + 1;
    if (open > MAX_CONNECTIONS_PER_PEER) {
      socket.destroy();
      return;
    }
    perPeer.set(peer, open);
    socket.once("close", () => {
      const left = (perPeer.get(peer) ?? 1) - 1;
      if (left <= 0) perPeer.delete(peer);
      else perPeer.set(peer, left);
    });
  });

  const verifyServer = http.createServer((request, response) => {
    const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    const suffix = `.${config.domain}`;
    const sub = host.endsWith(suffix) ? host.slice(0, -suffix.length) : "";
    const route = SUB.test(sub) ? live(state.routes[sub]) : undefined;
    response.writeHead(route !== undefined ? 204 : 404, { "cache-control": "no-store", connection: "close" });
    response.end();
  });

  const resolveNode = (given: string, allow: NodeEntry[]): { node_id: string; name: string } => {
    const wanted = given.toLowerCase();
    const fromAllow = allow.find((entry) => entry.node_id === given || entry.name?.toLowerCase() === wanted);
    if (fromAllow !== undefined) return { node_id: fromAllow.node_id, name: fromAllow.name ?? fromAllow.node_id };
    const owners = [...Object.values(state.routes).map((route) => route.owner), ...Object.values(state.revoked).map((tombstone) => tombstone.owner)];
    const owner = owners.find((entry) => entry.node_id === given || entry.node_name === wanted);
    if (owner !== undefined) return { node_id: owner.node_id, name: owner.node_name };
    if (state.kill.nodes[given] !== undefined) return { node_id: given, name: state.kill.nodes[given]?.name ?? given };
    const named = Object.entries(state.kill.nodes).find(([, flag]) => flag.name === wanted);
    if (named !== undefined) return { node_id: named[0], name: named[1].name };
    throw new RelaydError(404, "E_NOT_FOUND", `no node '${given}' in the allowlist, the routes or the kill flags; pass its stable node ID from the allowlist`);
  };

  const adminAdd = (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    only(body, ["sub", "upstream", "expires_at", "gate", "password", "password_hash"]);
    const sub = typeof body.sub === "string" ? body.sub : "";
    if (!SUB.test(sub)) throw new RelaydError(400, "E_USAGE", "sub must be a DNS label");
    const upstream = typeof body.upstream === "string" && LEGACY_UPSTREAM.test(body.upstream) ? body.upstream : undefined;
    if (upstream === undefined) throw new RelaydError(400, "E_USAGE", "upstream must be an https:// tailnet URL");
    const requested = epochSeconds(body.expires_at, "expires_at");
    return serialized(async () => {
      const existing = state.routes[sub];
      if (existing !== undefined && existing.owner.node_id !== ADMIN_NODE) throw new RelaydError(409, "E_USAGE", `${sub} belongs to node ${existing.owner.node_name}; remove it first`);
      let hash: string | undefined;
      if (body.gate === "password") {
        if (typeof body.password_hash === "string") {
          if (!PASSWORD_HASH.test(body.password_hash)) throw new RelaydError(400, "E_USAGE", "password_hash is not a hash");
          hash = body.password_hash;
        } else {
          const secret = password(body.password);
          if (secret === undefined) throw new RelaydError(400, "E_USAGE", "a gated route needs a password or password_hash");
          hash = await deps.hash(secret).catch(() => {
            throw new RelaydError(502, "E_INTERNAL", "relayd could not hash the password");
          });
        }
      } else if (body.gate !== "none") throw new RelaydError(400, "E_USAGE", "gate must be 'password' or 'none'");
      const now = deps.now();
      const cap = now + capFor(body.gate);
      const route: Route = {
        sub,
        owner: { node_id: ADMIN_NODE, node_name: "operator" },
        upstream,
        gate: body.gate,
        ...(hash === undefined ? {} : { password_hash: hash }),
        created_at: existing?.created_at ?? now,
        expires_at: Math.min(requested, cap),
        cap_at: cap,
        generation: (existing?.generation ?? 0) + 1,
        last_view_at: null,
      };
      state.routes[sub] = route;
      delete state.revoked[sub];
      try {
        await writeRoute(route);
        await reload();
      } catch {
        if (existing === undefined) delete state.routes[sub];
        else state.routes[sub] = existing;
        if (existing === undefined) await rm(routeFile(sub), { force: true });
        else await writeRoute(existing).catch(() => undefined);
        await reloadOrLog("revert");
        throw new RelaydError(502, "E_RELOAD", "the relay could not load the route");
      }
      await save();
      deps.log({ event: "admin_add", sub, gate: route.gate });
      return publicRoute(route, config.domain);
    });
  };

  const adminRemove = (sub: string): Promise<Record<string, unknown>> =>
    serialized(async () => {
      const route = SUB.test(sub) ? state.routes[sub] : undefined;
      if (route === undefined) throw new RelaydError(404, "E_NOT_FOUND", `no live route ${sub}`);
      revoke(route, "admin");
      await save();
      await removeFiles([sub]);
      const reloaded = await reloadOrLog("admin_rm");
      deps.log({ event: "admin_rm", sub, owner: route.owner.node_id });
      return { sub, removed: true, ...(reloaded ? {} : { reload: "failed" }) };
    });

  const kill = (body: Record<string, unknown>, on: boolean): Promise<Record<string, unknown>> => {
    only(body, ["node"]);
    if (body.node !== undefined && (typeof body.node !== "string" || body.node === "")) throw new RelaydError(400, "E_USAGE", "node must be a node name or stable ID");
    return serialized(async () => {
      const allow = (await loadConfig(configFile).catch(() => config)).allow;
      const node = typeof body.node === "string" ? resolveNode(body.node, allow) : undefined;
      if (!on) {
        if (node === undefined) state.kill.all = null;
        else delete state.kill.nodes[node.node_id];
        await save();
        deps.log({ event: "kill_lifted", node_id: node?.node_id ?? null });
        return { lifted: true, node: node ?? null, kill: state.kill };
      }
      const now = deps.now();
      if (node === undefined) state.kill.all = { at: now };
      else state.kill.nodes[node.node_id] = { at: now, name: node.name };
      const doomed = Object.values(state.routes).filter((route) => node === undefined || route.owner.node_id === node.node_id);
      for (const route of doomed) revoke(route, "kill");
      await save();
      await removeFiles(doomed.map((route) => route.sub));
      const reloaded = doomed.length === 0 || (await reloadOrLog("kill"));
      deps.log({ event: "kill", node_id: node?.node_id ?? null, removed: doomed.map((route) => route.sub) });
      return { disabled: true, node: node ?? null, removed: doomed.map((route) => route.sub), ...(reloaded ? {} : { reload: "failed" }) };
    });
  };

  const adminServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://relayd-admin");
    const parts = url.pathname.split("/").filter((part) => part !== "");
    const handle = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
      if (parts[0] !== "admin") throw new RelaydError(404, "E_NOT_FOUND", "no such admin path");
      const what = parts[1];
      if (what === "routes" && parts.length === 2 && request.method === "GET") {
        return {
          status: 200,
          body: {
            ok: true,
            domain: config.domain,
            routes: Object.values(state.routes).map((route) => ({ ...publicRoute(route, config.domain), owner: route.owner })),
            revoked: Object.values(state.revoked).map((tombstone) => ({ ...tombstoneView(tombstone, config.domain), owner: tombstone.owner })),
            kill: state.kill,
          },
        };
      }
      if (what === "routes" && parts.length === 2 && request.method === "POST") return { status: 201, body: { ok: true, ...(await adminAdd(await readBody(request))) } };
      if (what === "routes" && parts.length === 3 && request.method === "DELETE") return { status: 200, body: { ok: true, ...(await adminRemove(parts[2] ?? "")) } };
      if (what === "kill" && parts.length === 2 && (request.method === "POST" || request.method === "DELETE")) {
        return { status: 200, body: { ok: true, ...(await kill(await readBody(request), request.method === "POST")) } };
      }
      if (what === "prune" && parts.length === 2 && request.method === "POST") return { status: 200, body: { ok: true, pruned: await pruneNow() } };
      if (what === "health" && parts.length === 2 && request.method === "GET") {
        return {
          status: 200,
          body: {
            ok: true,
            relayd: "active",
            domain: config.domain,
            routes: Object.keys(state.routes).length,
            killed: { all: state.kill.all !== null, nodes: Object.keys(state.kill.nodes).length },
            control: controlBound === null ? null : `${controlBound.address}:${controlBound.port}`,
            verify: `127.0.0.1:${verifyPort}`,
          },
        };
      }
      throw new RelaydError(405, "E_USAGE", `no ${request.method ?? ""} ${url.pathname}`);
    };
    void handle()
      .catch(failure)
      .then(({ status, body }) => send(response, status, body));
  });

  const listen = (server: http.Server, ...args: [number, string] | [string]): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      const done = (): void => {
        server.off("error", reject);
        resolve();
      };
      if (args.length === 2) server.listen(args[0], args[1], done);
      else server.listen(args[0], done);
    });

  const adminDir = path.dirname(config.admin_socket);
  await mkdir(adminDir, { recursive: true, mode: 0o700 });
  const adminInfo = await lstat(adminDir);
  if (!adminInfo.isDirectory() || adminInfo.uid !== process.getuid?.() || (adminInfo.mode & 0o077) !== 0) {
    throw new Error(`relayd keeps its admin socket only in a directory it owns with mode 0700; ${adminDir} is not`);
  }
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(config.admin_socket);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
  if (alive) throw new Error(`another relayd answers on ${config.admin_socket}`);
  await unlink(config.admin_socket).catch(() => undefined);
  await listen(adminServer, config.admin_socket);
  await chmod(config.admin_socket, 0o600);

  await listen(verifyServer, config.verify.port, "127.0.0.1");
  const verifyAddress = verifyServer.address();
  const verifyPort = typeof verifyAddress === "object" && verifyAddress !== null ? verifyAddress.port : config.verify.port;

  let controlBound: { address: string; port: number } | null = null;
  let closed = false;
  let retry: NodeJS.Timeout | undefined;
  const bindControl = async (): Promise<void> => {
    if (closed) return;
    const read = await deps.status();
    const ips = read.ok ? (read.status.Self?.TailscaleIPs ?? []) : [];
    const address = deps.bind ?? config.control.address ?? ips.find((ip) => net.isIPv4(ip));
    const problem =
      address === undefined
        ? `tailscale reports no IPv4 address here${read.ok ? "" : ` (${read.reason})`}`
        : !net.isIPv4(address) || address === "0.0.0.0"
          ? `relayd binds one Tailscale IPv4 address, never ${address}`
          : deps.bind === undefined && !ips.includes(address)
          ? `${address} is not one of this node's Tailscale addresses (${ips.join(", ") || "none"})`
          : undefined;
    if (problem !== undefined || address === undefined) {
      deps.log({ event: "control_unbound", reason: problem, retry_in_ms: BIND_RETRY_MS });
      retry = setTimeout(() => void bindControl(), BIND_RETRY_MS);
      return;
    }
    try {
      await listen(controlServer, config.control.port, address);
    } catch (error) {
      deps.log({ event: "control_unbound", reason: `cannot bind ${address}:${config.control.port}: ${errorCode(error)}`, retry_in_ms: BIND_RETRY_MS });
      retry = setTimeout(() => void bindControl(), BIND_RETRY_MS);
      return;
    }
    const bound = controlServer.address();
    controlBound = { address, port: typeof bound === "object" && bound !== null ? bound.port : config.control.port };
    for (const ip of read.ok ? (read.status.Self?.TailscaleIPs ?? []) : []) selfIps.add(ip);
    if (read.ok && read.status.Self?.ID !== undefined) selfId = read.status.Self.ID;
    deps.log({ event: "control_listen", address, port: controlBound.port, verify: `127.0.0.1:${verifyPort}`, admin: config.admin_socket, routes: Object.keys(state.routes).length });
  };
  await bindControl();
  const pruner = setInterval(() => void pruneNow().catch((error: unknown) => deps.log({ event: "prune_failed", message: error instanceof Error ? error.message : String(error) })), PRUNE_INTERVAL_MS);
  pruner.unref();

  const closeServer = (server: http.Server): Promise<void> =>
    new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });

  return {
    get control() {
      return controlBound;
    },
    verify: { address: "127.0.0.1", port: verifyPort },
    admin: config.admin_socket,
    state: () => structuredClone(state),
    prune: pruneNow,
    close: async () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(pruner);
      await Promise.all([closeServer(controlServer), closeServer(verifyServer), closeServer(adminServer)]);
      await unlink(config.admin_socket).catch(() => undefined);
    },
  };
}

export function adminRequest(socket: string, method: string, apiPath: string, body?: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(
      { socketPath: socket, method, path: apiPath, headers: { "content-type": "application/json", ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }) }, timeout: 60_000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            resolve({ status: response.statusCode ?? 0, body: isObject(parsed) ? parsed : {} });
          } catch {
            reject(new Error(`relayd answered ${response.statusCode ?? 0} with no JSON`));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("relayd did not answer within 60s")));
    request.on("error", (error) => reject(new Error(`relayd is not answering on ${socket}: ${errorCode(error)}`)));
    request.end(payload);
  });
}
