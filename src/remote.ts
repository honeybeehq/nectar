import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { mkdir, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { extractTar, MAX_ENTRIES, MAX_TREE_BYTES } from "./archive.js";
import { currentPublisher } from "./commands.js";
import { daemonLogFile } from "./daemon.js";
import type { DoctorCheck } from "./doctor.js";
import { errorEnvelope, successEnvelope, type ErrorEnvelope, type SuccessEnvelope } from "./envelope.js";
import { asNectarError, isErrorCode, NectarError } from "./errors.js";
import { commitTree } from "./git.js";
import type { NectarPaths } from "./paths.js";
import { validateEnvName } from "./refs.js";
import { NectarService } from "./service.js";
import { StateStore } from "./state.js";
import { daemonHello, type Hello } from "./control.js";
import { hostReport } from "./pool.js";
import { describeDiscovery, describeEndpoint, discoveryReport, readStatus, type DiscoveryReport, whoIs as askWhoIs, type LocalApiEndpoint, type StatusJson, type StatusNodeJson, type StatusRead, type TailnetPeer } from "./localapi.js";
import type { DepRecord, EnvRecord, MachineConfig, Publisher, RemoteConfig } from "./types.js";

export const REMOTE_API = 1;
export const REMOTE_PORT = 8441;
export const REMOTE_OPS = ["publish", "ls", "show", "resolve", "touch", "stop", "rm"] as const;
export type RemoteOp = (typeof REMOTE_OPS)[number];
export const REMOTE_INSTALL_HINT = "nectar daemon install --remote";
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const REQUEST_HEADER = "x-nectar-request";
const CALL_TIMEOUT_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 30 * 60_000;
const RETRY_MS = 30_000;
const STATUS_DEADLINE_MS = 20_000;
const REPEAT_LOG_EVERY = 20;
const REFUSAL_WINDOW_MS = 24 * 60 * 60_000;
const RECEIVE_TIMEOUT_MS = 10 * 60_000;
const HEADERS_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 32;
const PROBE_TIMEOUT_MS = 3_000;
const HELLO_TIMEOUT_MS = 8_000;

export type Identity = { peer: TailnetPeer; reason?: undefined } | { peer?: undefined; reason: string };

export interface RemoteCaller {
  node_id: string;
  node_name: string;
  login: string | null;
  operator: boolean;
}

export interface RemoteRequest {
  args: Record<string, unknown>;
  caller: { hive_bee?: string; hive_session?: string };
}

export function remotePort(): number {
  const pinned = Number(process.env.NECTAR_REMOTE_PORT);
  return Number.isInteger(pinned) && pinned > 0 && pinned < 65_536 ? pinned : REMOTE_PORT;
}

function isRemoteOp(value: string): value is RemoteOp {
  return (REMOTE_OPS as readonly string[]).includes(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function localStatus(): Promise<StatusJson | undefined> {
  const read = await readStatus();
  return read.ok ? read.status : undefined;
}

export async function whoIs(address: string): Promise<Identity> {
  try {
    const found = await askWhoIs(address);
    return found.peer === undefined ? { reason: found.reason } : { peer: found.peer };
  } catch (error) {
    return { reason: `Tailscale LocalAPI whois failed: ${asNectarError(error).message}` };
  }
}

function nodeName(dnsName: string | undefined, fallback: string | undefined): string {
  return (dnsName?.replace(/\.$/, "").split(".")[0] ?? fallback ?? "").toLowerCase();
}

function ipv4(node: StatusNodeJson | undefined): string | undefined {
  return node?.TailscaleIPs?.find((address) => net.isIPv4(address));
}

export async function peerAddress(host: string): Promise<string> {
  const status = await localStatus();
  if (status?.Self === undefined) {
    throw new NectarError("E_TAILNET_DOWN", `Cannot reach ${host}: tailscale is not running here`, { host, transport: true });
  }
  const wanted = host.toLowerCase();
  const nodes = [status.Self, ...Object.values(status.Peer ?? {})];
  const match = nodes.find((node) => {
    const dns = node.DNSName?.replace(/\.$/, "").toLowerCase();
    return dns === wanted || nodeName(node.DNSName, undefined) === wanted || node.HostName?.toLowerCase() === wanted;
  });
  const address = ipv4(match);
  if (address === undefined) throw new NectarError("E_NOT_FOUND", `No node named '${host}' on this tailnet`, { host, transport: true });
  return address;
}

function forbidden(rule: string, message: string, details: Record<string, unknown> = {}): NectarError {
  return new NectarError("E_FORBIDDEN", message, { ...details, rule });
}

function refusalRule(peer: TailnetPeer, allow: unknown, owner: number | undefined, login: string | null): string {
  if (allow === undefined) {
    if (peer.tags.length > 0) return "tagged";
    if (login === null) return "no_login";
    if (owner === undefined || owner <= 0) return "owner_unknown";
    return "not_owner";
  }
  if (!Array.isArray(allow)) return "allow_malformed";
  return allow.length === 0 ? "allow_empty" : "not_in_allow";
}

export function authorize(peer: TailnetPeer, remote: RemoteConfig | undefined, owner: number | undefined): RemoteCaller {
  const tagged = peer.tags.length > 0;
  const login = tagged || peer.loginName === "" ? null : peer.loginName;
  const operator = owner !== undefined && owner > 0 && login !== null && peer.userId === owner && peer.nodeUserId === owner;
  const caller: RemoteCaller = { node_id: peer.nodeId, node_name: nodeName(peer.dnsName, peer.nodeName), login, operator };
  const allow = remote?.allow;
  let allowed: boolean;
  if (allow === undefined) allowed = operator;
  else if (!Array.isArray(allow)) allowed = false;
  else {
    allowed = allow.some((entry: unknown) => {
      if (!isObject(entry)) return false;
      if (typeof entry.node_id === "string" && entry.node_id !== "" && entry.node_id === caller.node_id) return true;
      return typeof entry.login === "string" && entry.login !== "" && login !== null && entry.login.toLowerCase() === login.toLowerCase();
    });
  }
  if (!allowed) {
    throw forbidden(refusalRule(peer, allow, owner, login), `${caller.node_name || "this node"} (${caller.node_id}${login === null ? "" : `, ${login}`}) may not use nectard here`, {
      node_id: caller.node_id,
      hint: `add {"node_id": "${caller.node_id}"} to remote.allow in the target's nectar.json`,
    });
  }
  return caller;
}

type ArgSpec = Record<string, "string" | "boolean">;

const ARG_SPECS: Record<RemoteOp, { spec: ArgSpec; required: string[] }> = {
  publish: {
    spec: {
      kind: "string", source: "string", dir: "string", entry: "string", commit: "string", branch: "string", mode: "string",
      ttl: "string", packet: "string", verify: "boolean", name: "string", dry_run: "boolean", fresh: "boolean", path: "string", public: "boolean",
    },
    required: ["kind", "source", "dir", "branch"],
  },
  ls: { spec: { mode: "string", status: "string" }, required: [] },
  show: { spec: { target: "string" }, required: ["target"] },
  resolve: { spec: { target: "string" }, required: ["target"] },
  touch: { spec: { target: "string", ttl: "string" }, required: ["target"] },
  stop: { spec: { env: "string" }, required: ["env"] },
  rm: { spec: { env: "string", force: "boolean" }, required: ["env"] },
};

function checkArgs(op: RemoteOp, args: unknown): Record<string, string | boolean> {
  if (!isObject(args)) throw new NectarError("E_USAGE", "args must be an object");
  const { spec, required } = ARG_SPECS[op];
  const checked: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const type = Object.hasOwn(spec, key) ? spec[key] : undefined;
    if (type === undefined) throw new NectarError("E_USAGE", `nectar ${op} over the tailnet does not take '${key}'`);
    if (typeof value !== type) throw new NectarError("E_USAGE", `'${key}' must be a ${type}`);
    if (typeof value === "string" && value.length > 4096) throw new NectarError("E_USAGE", `'${key}' is too long`);
    checked[key] = value as string | boolean;
  }
  for (const key of required) {
    if (checked[key] === undefined) throw new NectarError("E_USAGE", `nectar ${op} needs '${key}'`);
  }
  return checked;
}

function checkBees(caller: unknown): { hive_bee?: string; hive_session?: string } {
  if (!isObject(caller)) return {};
  const bees: { hive_bee?: string; hive_session?: string } = {};
  for (const key of ["hive_bee", "hive_session"] as const) {
    const value = caller[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 256) bees[key] = value;
  }
  return bees;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function inner(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parts = value.split("/");
  if (parts.length > 32 || parts.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git" || part.length > 255 || /[\0\\]/.test(part))) {
    throw new NectarError("E_USAGE", `path '${value}' must be a plain relative path inside the shipped tree`);
  }
  return parts.join("/");
}

export function sourceDir(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 100);
  return cleaned === "" ? "source" : cleaned;
}

async function foreignEnv(store: StateStore, name: string, caller: RemoteCaller, exact: boolean): Promise<string | undefined> {
  if (caller.operator) return undefined;
  const target = validateEnvName(name);
  const matched = (await store.listEnvs()).filter((record) => record.name === target || (!exact && record.name.startsWith(`${target}--`)));
  return matched.find((record) => record.publisher.node !== caller.node_id)?.name;
}

async function owns(store: StateStore, name: string, caller: RemoteCaller, exact: boolean): Promise<void> {
  const foreign = await foreignEnv(store, name, caller, exact);
  if (foreign !== undefined) throw forbidden("not_publisher", `${foreign} was not published by ${caller.node_name || caller.node_id}; only its publisher or the node owner may change it`);
}

async function* capped(source: AsyncIterable<unknown>, max: number): AsyncGenerator<Buffer> {
  let size = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > max) throw new NectarError("E_USAGE", `Archive refused: the upload is larger than ${max} bytes`, { refused: "archive" });
    yield buffer;
  }
}

async function receive(
  request: http.IncomingMessage,
  args: Record<string, string | boolean>,
  caller: RemoteCaller,
  paths: NectarPaths,
  service: NectarService,
): Promise<unknown> {
  const text = (key: string): string | undefined => (typeof args[key] === "string" ? args[key] : undefined);
  const flag = (key: string): boolean | undefined => (typeof args[key] === "boolean" ? args[key] : undefined);
  const kind = text("kind");
  if (kind !== "git" && kind !== "static") throw new NectarError("E_USAGE", "kind must be 'git' or 'static'");
  const dir = text("dir") ?? "";
  if (!SAFE_NAME.test(dir)) throw new NectarError("E_USAGE", `'${dir}' is not a usable directory name`);
  const entry = text("entry");
  if (entry !== undefined && (kind !== "static" || !SAFE_NAME.test(entry) || !/\.html?$/i.test(entry))) {
    throw new NectarError("E_USAGE", "entry must be an .html file name of a static publish");
  }
  const within = inner(text("path"));
  if (within !== undefined && kind !== "git") throw new NectarError("E_USAGE", "path applies only to a shipped repo");
  if (request.headers["content-encoding"] !== "gzip") throw new NectarError("E_USAGE", "publish over the tailnet takes a gzip tar body");
  const key = crypto.createHash("sha256").update(`${caller.node_id}\0${text("source") ?? ""}`).digest("hex").slice(0, 16);
  const store = new StateStore(paths);
  return store.withLock(`inbox--${key}`, async () => {
    const base = path.join(paths.root, "inbox", key);
    const tree = path.join(base, dir);
    const staging = path.join(base, `.incoming-${crypto.randomBytes(4).toString("hex")}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const gunzip = zlib.createGunzip();
      const feeding = pipeline(capped(request, MAX_ARCHIVE_BYTES), gunzip);
      try {
        await extractTar(gunzip, staging, { maxBytes: MAX_TREE_BYTES, maxEntries: MAX_ENTRIES });
        await feeding;
      } catch (error) {
        gunzip.destroy();
        await feeding.catch(() => undefined);
        throw error instanceof NectarError ? error : new NectarError("E_USAGE", `Archive refused: ${asNectarError(error).message}`, { refused: "archive" });
      }
      if (kind === "static") {
        await rm(tree, { recursive: true, force: true });
        await rename(staging, tree);
      } else {
        await mkdir(tree, { recursive: true });
        for (const name of await readdir(tree)) if (name !== ".git") await rm(path.join(tree, name), { recursive: true, force: true });
        for (const name of await readdir(staging)) await rename(path.join(staging, name), path.join(tree, name));
        await commitTree(tree, text("branch") ?? "", `nectar: ${text("commit") ?? "archive"} from ${caller.node_name || caller.node_id}`);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rmdir(base).catch(() => undefined);
    }
    const options = {
      repo: entry === undefined ? path.join(tree, ...(within?.split("/") ?? [])) : path.join(tree, entry),
      mode: kind === "static" ? "static" : text("mode"),
      branch: text("branch"),
      ttl: text("ttl"),
      packet: text("packet"),
      verify: flag("verify"),
      name: text("name"),
      dryRun: flag("dry_run"),
      fresh: flag("fresh"),
      public: flag("public"),
      received: true,
    };
    return service.publish(Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)));
  });
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of capped(request, MAX_JSON_BYTES)) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new NectarError("E_USAGE", "Request body is not JSON");
  }
}

function requestHeader(request: http.IncomingMessage): unknown {
  const value = request.headers[REQUEST_HEADER];
  if (typeof value !== "string") throw new NectarError("E_USAGE", `publish over the tailnet needs the ${REQUEST_HEADER} header`);
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new NectarError("E_USAGE", `${REQUEST_HEADER} is not base64url JSON`);
  }
}

function pick(source: object, keys: string[]): Record<string, unknown> {
  const values = source as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => values[key] !== undefined).map((key) => [key, values[key]]));
}

function depKinds(deps: unknown): Record<string, { kind: DepRecord["kind"] }> | null {
  if (!isObject(deps)) return null;
  return Object.fromEntries(Object.entries(deps).map(([name, dep]) => [name, { kind: (dep as DepRecord).kind }]));
}

function peerRecord(record: EnvRecord): Record<string, unknown> {
  return {
    ...pick(record, ["eid", "name", "mode", "app", "branch", "commit", "status", "urls", "ref", "published_at", "expires_at", "last_touched_at", "ttl_ms", "pinned", "last_opened_at"]),
    publisher: pick(record.publisher, ["via", "node_name"]),
    ...(record.testpack === undefined ? {} : { testpack: pick(record.testpack, ["sha256", "size_bytes", "platform", "entry", "url", "bundle_id"]) }),
    ...(record.exposure === undefined ? {} : { exposure: pick(record.exposure, ["url", "gate", "expires_at"]) }),
    ...(record.failure === undefined ? {} : { failure: pick(record.failure, ["code", "failed_at"]) }),
    ...(record.deps === undefined ? {} : { deps: depKinds(record.deps) }),
  };
}

const ABSOLUTE_PATH = /(?<![\w:/.~-])(?:~|file:\/\/)?\/[^\s'",;)\]]+/g;

function scrub(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.split(root).join("$NECTAR_HOME").replace(ABSOLUTE_PATH, "<path>");
  if (Array.isArray(value)) return value.map((item) => scrub(item, root));
  return value;
}

function peerResolution(resolution: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(resolution).filter(([key]) => key !== "log_tail"));
}

export function peerView(op: RemoteOp, result: unknown, root: string): unknown {
  if (!isObject(result)) return result;
  switch (op) {
    case "ls":
      return {
        envs: (Array.isArray(result.envs) ? result.envs : []).map((env: object) =>
          pick(env, ["name", "mode", "status", "mesh_url", "expires_at", "expires_in", "liveness", "failure"]),
        ),
      };
    case "show": {
      const record = result.env as EnvRecord;
      const ports = isObject(result.ports) ? result.ports : {};
      return {
        env: peerRecord(record),
        ...pick(result, ["name", "mode", "status", "ref", "urls", "liveness", "expires_at", "expires_in", "touched", "touch_skipped"]),
        ports: { tailnet: ports.tailnet ?? null },
        deps: depKinds(result.deps),
        failure: isObject(result.failure) ? pick(result.failure, ["code", "failed_at"]) : null,
      };
    }
    case "resolve":
      return Array.isArray(result.resolutions)
        ? { ...result, resolutions: result.resolutions.map((resolution: Record<string, unknown>) => peerResolution(resolution)) }
        : peerResolution(result);
    case "publish":
      if (result.dry_run === true) {
        return { ...pick(result, ["dry_run", "name", "mode", "stack", "build", "serve", "ready_path", "requires", "missing", "seed"]), deps: depKinds(result.deps) };
      }
      return {
        ...pick(result, ["eid", "env", "mode", "branch", "commit", "ref", "urls", "packet_fields", "expires_at", "url", "share_url", "public", "secret"]),
        warnings: scrub(result.warnings ?? [], root),
        mesh_error: scrub(result.mesh_error ?? null, root),
        deps: depKinds(result.deps),
      };
    default:
      return result;
  }
}

const PEER_DETAILS = ["hint", "refused", "node_id"];

function peerError(command: string, error: NectarError, root: string): NectarError {
  const keep = command === "publish" ? [...PEER_DETAILS, "log_tail"] : PEER_DETAILS;
  const details = Object.fromEntries(Object.entries(pick(error.details, keep)).map(([key, value]) => [key, scrub(value, root)]));
  const known = Object.values(error.details).filter((value): value is string => typeof value === "string" && path.isAbsolute(value));
  const message = known.reduce((text, value) => text.split(value).join("<path>"), error.message);
  return new NectarError(error.code, scrub(message, root) as string, details);
}

async function remoteDispatch(
  op: RemoteOp,
  args: Record<string, string | boolean>,
  bees: { hive_bee?: string; hive_session?: string },
  caller: RemoteCaller,
  request: http.IncomingMessage,
  paths: NectarPaths,
): Promise<unknown> {
  const publisher: Publisher = {
    user: currentPublisher().user,
    via: "tailnet",
    node: caller.node_id,
    ...(caller.node_name === "" ? {} : { node_name: caller.node_name }),
    ...(caller.login === null ? {} : { login: caller.login }),
    ...bees,
  };
  const service = new NectarService(paths.root, { publisher });
  const text = (key: string): string | undefined => (typeof args[key] === "string" ? args[key] : undefined);
  const target = (): string => validateEnvName(text("target") ?? text("env") ?? "");
  const viewer = async (): Promise<NectarService> =>
    (await foreignEnv(service.store, target(), caller, false)) === undefined
      ? service
      : new NectarService(paths.root, { publisher, readOnly: "only the env's publisher or the node owner extends its lifetime by viewing it" });
  switch (op) {
    case "publish":
      return receive(request, args, caller, paths, service);
    case "ls":
      return service.list(Object.fromEntries(Object.entries({ mode: text("mode"), status: text("status") }).filter(([, value]) => value !== undefined)));
    case "show":
      return (await viewer()).show(target());
    case "resolve":
      return (await viewer()).resolve(target());
    case "touch":
      await owns(service.store, target(), caller, false);
      return service.touch(target(), text("ttl"));
    case "stop":
      await owns(service.store, target(), caller, true);
      return service.stop(target());
    case "rm":
      await owns(service.store, target(), caller, true);
      return service.remove(target(), args.force === true);
  }
}

async function strictConfig(paths: NectarPaths): Promise<MachineConfig> {
  try {
    return await new StateStore(paths).readConfig();
  } catch (error) {
    throw forbidden("config_unreadable", `nectar.json on this node is unreadable, so nectard refuses every tailnet caller: ${asNectarError(error).message}`);
  }
}

type Envelope = SuccessEnvelope<unknown> | ErrorEnvelope;

export interface RemoteServer {
  address: string;
  port: number;
  close: () => Promise<void>;
}

export interface ListenerState {
  listen: boolean;
  listening: boolean;
  address: string | null;
  port: number;
  last_error: string | null;
  last_reason?: string | null;
  whois: string | null;
  since: string | null;
  discovery?: DiscoveryReport | null;
}

export type TailnetAddress =
  | { ok: true; address: string; endpoint: LocalApiEndpoint; status: StatusJson }
  | { ok: false; reason: string; message: string; details: Record<string, unknown> };

function tailnetSummary(endpoint: LocalApiEndpoint, status: StatusJson): Record<string, unknown> {
  return { endpoint: describeEndpoint(endpoint), backend_state: status.BackendState ?? null, ips: status.Self?.TailscaleIPs ?? [] };
}

export function tailnetAddress(read: StatusRead, pinned?: string): TailnetAddress {
  if (!read.ok) {
    return {
      ok: false,
      reason: read.reachable ? "status_error" : "localapi_unreachable",
      message: `nectard cannot read this node's tailnet status, so it does not listen: ${read.reason}`,
      details: read.endpoint === undefined ? {} : { endpoint: describeEndpoint(read.endpoint) },
    };
  }
  const details = tailnetSummary(read.endpoint, read.status);
  if (read.status.BackendState !== "Running") {
    return { ok: false, reason: "not_running", message: `tailscale is ${read.status.BackendState ?? "in no known state"} here, not Running, so nectard has no tailnet address to listen on yet`, details };
  }
  const address = pinned ?? ipv4(read.status.Self);
  if (address !== undefined) return { ok: true, address, endpoint: read.endpoint, status: read.status };
  const ips = read.status.Self?.TailscaleIPs ?? [];
  if (ips.some((ip) => net.isIPv6(ip))) {
    return { ok: false, reason: "ipv6_only", message: `this node has only IPv6 tailnet addresses (${ips.join(", ")}), and nectard listens on its Tailscale IPv4 address`, details };
  }
  return { ok: false, reason: "no_tailnet_ip", message: "tailscale reports no tailnet address for this node", details };
}

const BIND_HINTS: Record<string, string> = {
  EADDRINUSE: "another process holds that port",
  EADDRNOTAVAIL: "that address is on no interface of this host (Tailscale is not up yet, or tailscaled runs in userspace-networking mode)",
  EACCES: "this user may not bind that port",
};

function refusal(op: string, address: string, who: Identity | undefined, failure: NectarError, owner: number | undefined): Record<string, unknown> {
  const rule = failure.details.rule;
  const peer = who?.peer;
  return {
    event: rule === "self" ? "remote_self_check" : "remote_refused",
    op,
    rule,
    code: failure.code,
    peer_address: address.replace(/^::ffff:/, ""),
    node_name: peer === undefined ? null : nodeName(peer.dnsName, peer.nodeName) || null,
    node_id: peer?.nodeId ?? null,
    login: peer?.loginName || null,
    tags: peer?.tags ?? [],
    ...(peer === undefined ? {} : { user_id: peer.userId, node_user_id: peer.nodeUserId, owner: owner ?? null }),
    ...(who?.reason === undefined ? {} : { whois: who.reason }),
    message: failure.message,
  };
}

export async function startRemoteServer(
  paths: NectarPaths,
  options: {
    address?: string;
    port?: number;
    log?: (event: Record<string, unknown>) => void;
    status?: StatusRead;
    onError?: (error: NodeJS.ErrnoException) => void;
  } = {},
): Promise<RemoteServer> {
  const log = options.log ?? (() => undefined);
  const found = tailnetAddress(options.status ?? (await readStatus()), options.address);
  if (!found.ok) throw new NectarError("E_TAILNET_DOWN", found.message, { reason: found.reason, ...found.details });
  const { address, status } = found;
  if (!net.isIP(address) || address === "0.0.0.0" || address === "::") throw new NectarError("E_USAGE", `nectard listens only on a tailnet address, not ${address}`, { reason: "address", address });
  const owner = status.Self?.UserID;
  const port = options.port ?? remotePort();
  const host = nodeName(status.Self?.DNSName, status.Self?.HostName);
  const selfId = status.Self?.ID;
  const selfAddresses = new Set(status.Self?.TailscaleIPs ?? []);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://nectard");
    const match = /^\/v1\/([a-z]+)$/.exec(url.pathname);
    const op = match?.[1] ?? "";
    const command = isRemoteOp(op) ? op : "nectar";
    let caller: RemoteCaller | undefined;
    let who: Identity | undefined;
    const handle = async (): Promise<unknown> => {
      const peer = request.socket.remoteAddress ?? "";
      who = await whoIs(net.isIPv6(peer) ? `[${peer}]:${request.socket.remotePort}` : `${peer}:${request.socket.remotePort}`);
      if (who.peer === undefined) throw forbidden("whois_failed", `tailscaled could not identify ${peer}; nectard serves only known tailnet nodes`, { refused: "whois" });
      if (selfAddresses.has(peer.replace(/^::ffff:/, "")) || (selfId !== undefined && who.peer.nodeId === selfId)) {
        throw forbidden("self", "A caller on this node uses the control socket, not the tailnet listener", { refused: "self" });
      }
      const config = await strictConfig(paths);
      if (config.remote?.listen !== true) throw new NectarError("E_REMOTE", "The tailnet listener is turned off on this node", { hint: REMOTE_INSTALL_HINT, rule: "listener_off" });
      caller = authorize(who.peer, config.remote, owner);
      if (request.method === "GET" && url.pathname === "/v1/hello") return { api: REMOTE_API, ops: [...REMOTE_OPS], host, caller: caller.node_name, ...(await hostReport(paths, process.pid)) };
      if (request.method !== "POST" || !isRemoteOp(op)) throw new NectarError("E_USAGE", `nectard has no ${request.method ?? ""} ${url.pathname}`);
      const body = op === "publish" ? requestHeader(request) : await readJson(request);
      if (!isObject(body)) throw new NectarError("E_USAGE", "Request must be a JSON object");
      const args = checkArgs(op, body.args ?? {});
      const result = await remoteDispatch(op, args, checkBees(body.caller), caller, request, paths);
      return peerView(op, result, paths.root);
    };
    let failure: NectarError | undefined;
    void handle()
      .then((result): Envelope => successEnvelope(command, result))
      .catch((error: unknown): Envelope => {
        failure = asNectarError(error);
        return errorEnvelope(command, peerError(command, failure, paths.root));
      })
      .then((envelope) => {
        if (typeof failure?.details.rule === "string") log(refusal(op, request.socket.remoteAddress ?? "", who, failure, owner));
        log({
          event: "remote",
          op,
          node: who?.peer?.nodeId ?? null,
          login: who?.peer?.loginName || null,
          ...(who?.reason === undefined ? {} : { whois: who.reason }),
          ok: envelope.ok,
          ...(envelope.ok ? {} : { code: envelope.error.code }),
        });
        const statusCode = !envelope.ok && envelope.error.code === "E_FORBIDDEN" ? 403 : 200;
        response.writeHead(statusCode, { "content-type": "application/json", connection: "close" });
        response.end(`${JSON.stringify(envelope)}\n`);
        if (!request.complete) response.once("finish", () => request.destroy());
      });
  });
  server.requestTimeout = RECEIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, address, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? asNectarError(error).message;
    const hint = BIND_HINTS[code];
    throw new NectarError("E_REMOTE", `nectard cannot bind ${address}:${port}: ${code}${hint === undefined ? "" : `; ${hint}`}`, { reason: "bind", code, address, port });
  }
  server.on("error", (error: NodeJS.ErrnoException) => options.onError?.(error));
  const bound = server.address();
  const actual = typeof bound === "object" && bound !== null ? bound.port : port;
  return {
    address,
    port: actual,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

export interface RemoteListener {
  state: () => ListenerState;
  close: () => Promise<void>;
}

export interface ListenerOptions {
  listen?: boolean;
  address?: string;
  port?: number;
  retryMs?: number;
  deadlineMs?: number;
}

const TIMED_OUT = Symbol("timed out");

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function startRemoteListener(paths: NectarPaths, log: (event: Record<string, unknown>) => void, options: ListenerOptions = {}): RemoteListener {
  const retryMs = options.retryMs ?? RETRY_MS;
  const deadlineMs = options.deadlineMs ?? STATUS_DEADLINE_MS;
  const state: ListenerState = {
    listen: options.listen ?? true,
    listening: false,
    address: null,
    port: options.port ?? remotePort(),
    last_error: null,
    last_reason: null,
    whois: null,
    since: null,
  };
  const startedAt = Date.now();
  const snapshot = (): ListenerState => {
    const discovery = discoveryReport();
    const waiting =
      state.listen && !state.listening && state.last_error === null
        ? `nectard has not finished its first tailnet status read (${Math.round((Date.now() - startedAt) / 1000)}s so far; ${describeDiscovery(discovery)})`
        : state.last_error;
    return { ...state, last_error: waiting, discovery };
  };
  if (!state.listen) {
    log({ event: "remote_listen_off", config: paths.config, message: "remote.listen was not true in nectar.json when nectard started, so it does not listen on the tailnet" });
    return { state: snapshot, close: () => Promise.resolve() };
  }
  let server: RemoteServer | undefined;
  let selfId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let attempts = 0;
  let repeats = 0;
  let lastFailure = "";
  let lastStatus = "";
  let pending: Promise<StatusRead> | undefined;
  const now = (): string => new Date().toISOString();

  const status = async (): Promise<StatusRead | typeof TIMED_OUT> => {
    pending ??= readStatus().finally(() => {
      pending = undefined;
    });
    return withDeadline(pending, deadlineMs);
  };
  const noteStatus = (read: StatusRead): void => {
    if (!read.ok) return;
    const summary = { ...tailnetSummary(read.endpoint, read.status), ipv4: ipv4(read.status.Self) ?? null };
    const key = JSON.stringify(summary);
    if (key === lastStatus) return;
    lastStatus = key;
    log({ event: "remote_status", api: "localapi", ...summary });
  };
  const schedule = (ms: number): void => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void guard(state.listening ? watch : attempt), ms);
  };
  const fail = (reason: string, message: string, details: Record<string, unknown>): void => {
    Object.assign(state, { listening: false, last_error: message, last_reason: reason, whois: null, since: now() });
    const key = `${reason}\0${message}`;
    repeats = key === lastFailure ? repeats + 1 : 0;
    lastFailure = key;
    if (repeats % REPEAT_LOG_EVERY === 0) {
      log({ event: "remote_listen_failed", reason, message, port: state.port, ...details, attempt: attempts, ...(repeats === 0 ? {} : { repeats }), retry_in_ms: retryMs });
    }
    schedule(retryMs);
  };
  const readiness = async (address: string): Promise<string | null> => {
    const who = await withDeadline(whoIs(address), deadlineMs);
    if (who === TIMED_OUT) return `the Tailscale LocalAPI WhoIs did not answer within ${deadlineMs / 1000}s`;
    if (who.peer === undefined) return who.reason;
    return selfId === undefined || who.peer.nodeId === selfId ? null : `WhoIs of ${address} named ${who.peer.nodeId}, not this node (${selfId})`;
  };
  const shut = async (reason: string, message: string, details: Record<string, unknown>, delay: number): Promise<void> => {
    const old = server;
    server = undefined;
    Object.assign(state, { listening: false, last_error: message, last_reason: reason, since: now() });
    await old?.close().catch(() => undefined);
    log({ event: "remote_listen_closed", reason, message, address: state.address, port: state.port, ...details, restart_in_ms: delay });
    schedule(delay);
  };
  const attempt = async (): Promise<void> => {
    attempts += 1;
    const read = await status();
    if (closed) return;
    if (read === TIMED_OUT) {
      const discovery = discoveryReport();
      fail(
        "status_timeout",
        `the Tailscale LocalAPI status read did not finish within ${deadlineMs / 1000}s, so nectard does not know its tailnet address yet (${describeDiscovery(discovery)})`,
        { discovery },
      );
      return;
    }
    noteStatus(read);
    const found = tailnetAddress(read, options.address);
    if (!found.ok) {
      fail(found.reason, found.message, found.reason === "localapi_unreachable" ? { ...found.details, discovery: discoveryReport() } : found.details);
      return;
    }
    let started: RemoteServer;
    try {
      started = await startRemoteServer(paths, {
        address: found.address,
        port: state.port,
        log,
        status: read,
        onError: (error) => void shut("server_error", `the tailnet listener failed: ${error.code ?? error.message}`, { code: error.code ?? null }, retryMs),
      });
    } catch (error) {
      const failure = asNectarError(error);
      fail(typeof failure.details.reason === "string" ? failure.details.reason : "start", failure.message, pick(failure.details, ["code", "address", "port"]));
      return;
    }
    if (closed) {
      await started.close();
      return;
    }
    server = started;
    selfId = found.status.Self?.ID;
    lastFailure = "";
    repeats = 0;
    const whois = await readiness(started.address);
    if (closed || server !== started) return;
    Object.assign(state, {
      listening: true,
      address: started.address,
      port: started.port,
      whois,
      last_error: whois === null ? null : `WhoIs does not work inside nectard, so it refuses every caller: ${whois}`,
      last_reason: whois === null ? null : "whois",
      since: now(),
    });
    log({ event: "remote_listen", address: started.address, port: started.port, api: "localapi", endpoint: describeEndpoint(found.endpoint), attempt: attempts, whois: whois ?? "ready", discovery: describeDiscovery(discoveryReport()) });
    schedule(retryMs);
  };
  const watch = async (): Promise<void> => {
    const read = await status();
    if (closed || server === undefined) return;
    if (read !== TIMED_OUT) {
      noteStatus(read);
      const found = tailnetAddress(read, options.address);
      if (found.ok && found.address !== state.address) {
        await shut("address_changed", `this node's tailnet address changed from ${state.address ?? "none"} to ${found.address}`, { to: found.address }, 0);
        return;
      }
    }
    if (state.whois !== null && state.address !== null) {
      const whois = await readiness(state.address);
      if (whois !== state.whois) {
        log(whois === null ? { event: "remote_whois_ready", address: state.address } : { event: "remote_whois_failed", address: state.address, reason: whois });
        Object.assign(state, { whois, last_error: whois === null ? null : `WhoIs does not work inside nectard, so it refuses every caller: ${whois}`, last_reason: whois === null ? null : "whois" });
      }
    }
    schedule(retryMs);
  };
  const guard = async (step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      const old = server;
      server = undefined;
      await old?.close().catch(() => undefined);
      fail("internal", `the tailnet listener hit an unexpected error: ${asNectarError(error).message}`, {});
    }
  };
  void guard(attempt);
  return {
    state: snapshot,
    close: async () => {
      closed = true;
      clearTimeout(timer);
      const old = server;
      server = undefined;
      state.listening = false;
      if (old === undefined) return;
      await old.close();
      log({ event: "remote_listen_closed", reason: "shutdown", address: state.address, port: state.port });
    },
  };
}

function unreachable(host: string, address: string, port: number, reason: string): NectarError {
  return new NectarError(
    "E_REMOTE",
    `nectard on ${host} does not answer on the tailnet (${address}:${port}): ${reason}. It is not installed, not running, or its tailnet listener is off`,
    { host, hint: `on ${host}: ${REMOTE_INSTALL_HINT}`, transport: true },
  );
}

export async function callRemote(host: string, op: RemoteOp, payload: RemoteRequest, archive?: Buffer): Promise<unknown> {
  const address = await peerAddress(host);
  const port = remotePort();
  const json = JSON.stringify(payload);
  const body = archive ?? Buffer.from(json);
  const headers: http.OutgoingHttpHeaders =
    archive === undefined
      ? { "content-type": "application/json", "content-length": body.length }
      : {
          "content-type": "application/x-tar",
          "content-encoding": "gzip",
          "content-length": body.length,
          [REQUEST_HEADER]: Buffer.from(json).toString("base64url"),
        };
  const timeoutMs = archive === undefined ? CALL_TIMEOUT_MS : PUBLISH_TIMEOUT_MS;
  const reply = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const outgoing = http.request({ host: address, port, method: "POST", path: `/v1/${op}`, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", (error) => reject(unreachable(host, address, port, error.message)));
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error(`no answer within ${timeoutMs / 1000}s`)));
    outgoing.on("error", (error) => reject(unreachable(host, address, port, error.message)));
    outgoing.end(body);
  });
  return replyResult(host, port, reply);
}

function replyResult(host: string, port: number, reply: { status: number; text: string }): unknown {
  let envelope: { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; [key: string]: unknown } };
  try {
    envelope = JSON.parse(reply.text) as typeof envelope;
  } catch {
    throw new NectarError("E_REMOTE", `Something other than nectard answered on ${host}:${port} (HTTP ${reply.status})`, { host, transport: true });
  }
  if (envelope.ok === true) return envelope.result;
  const failure = envelope.error;
  if (envelope.ok !== false || failure === undefined) throw new NectarError("E_REMOTE", `nectard on ${host} sent an unexpected reply`, { host });
  const { code, message, ...details } = failure;
  throw new NectarError(isErrorCode(code) ? code : "E_REMOTE", typeof message === "string" ? `${host}: ${message}` : `nectard on ${host} failed`, { ...details, host });
}

export async function helloRemote(host: string, timeoutMs = HELLO_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const address = await peerAddress(host);
  const port = remotePort();
  const reply = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const outgoing = http.get({ host: address, port, path: "/v1/hello" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", (error) => reject(unreachable(host, address, port, error.message)));
    });
    outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error(`no answer within ${timeoutMs / 1000}s`)));
    outgoing.on("error", (error) => reject(unreachable(host, address, port, error.message)));
  });
  const result = replyResult(host, port, reply);
  if (!isObject(result) || result.api !== REMOTE_API) throw new NectarError("E_REMOTE", `nectard on ${host} speaks another listener API`, { host });
  return result;
}

function probeHello(address: string, port: number): Promise<{ envelope: unknown } | { reason: string }> {
  return new Promise((resolve) => {
    const outgoing = http.get({ host: address, port, path: "/v1/hello" }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_JSON_BYTES) chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve({ envelope: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown });
        } catch {
          resolve({ envelope: undefined });
        }
      });
      response.on("error", (error) => resolve({ reason: error.message }));
    });
    outgoing.setTimeout(PROBE_TIMEOUT_MS, () => outgoing.destroy(new Error(`no answer within ${PROBE_TIMEOUT_MS / 1000}s`)));
    outgoing.on("error", (error) => resolve({ reason: (error as NodeJS.ErrnoException).code ?? error.message }));
  });
}

async function loggedEvents(paths: NectarPaths): Promise<Record<string, unknown>[]> {
  const events: Record<string, unknown>[] = [];
  for (const line of (await readFile(daemonLogFile(paths), "utf8").catch(() => "")).split("\n")) {
    if (!line.includes('"event":"remote')) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (isObject(event)) events.push(event);
    } catch {
      continue;
    }
  }
  return events;
}

const LIFECYCLE = new Set(["remote_listen", "remote_listen_failed", "remote_listen_closed", "remote_listen_off", "remote_unavailable", "remote_whois_ready", "remote_whois_failed"]);

function lifecycleReason(event: Record<string, unknown> | undefined, said: string): string {
  if (event === undefined || event.event === "remote_listen" || event.event === "remote_whois_ready") return "";
  const text = typeof event.message === "string" ? event.message : typeof event.reason === "string" ? event.reason : "";
  return text === "" || said.includes(text) ? "" : `; nectard logged: ${text}`;
}

export interface RefusalSummary {
  count: number;
  window_hours: number;
  last: { at: string; rule: string; node_name: string | null; node_id: string | null; login: string | null; tags: string[] } | null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function refusals(events: Record<string, unknown>[], nowMs = Date.now()): RefusalSummary {
  const recent = events.filter((event) => event.event === "remote_refused" && typeof event.at === "string" && nowMs - Date.parse(event.at) <= REFUSAL_WINDOW_MS);
  const last = recent.at(-1);
  return {
    count: recent.length,
    window_hours: REFUSAL_WINDOW_MS / 3_600_000,
    last:
      last === undefined
        ? null
        : {
            at: String(last.at),
            rule: textOrNull(last.rule) ?? "unknown",
            node_name: textOrNull(last.node_name),
            node_id: textOrNull(last.node_id),
            login: textOrNull(last.login),
            tags: Array.isArray(last.tags) ? last.tags.filter((tag): tag is string => typeof tag === "string") : [],
          },
  };
}

type DaemonView = Pick<Hello, "pid" | "nectar_home"> & { program?: string | null; remote?: ListenerState | null };

export function daemonListenerProblem(daemon: DaemonView | null | undefined): string | undefined {
  if (daemon === undefined || daemon === null) return "nectard does not answer on its control socket";
  const remote = daemon.remote;
  if (remote === undefined || remote === null) {
    return `nectard (pid ${daemon.pid}${daemon.program === undefined || daemon.program === null ? "" : `, ${daemon.program}`}) does not report a tailnet listener, so it runs an older nectar build than this one; restart it from this build with \`${REMOTE_INSTALL_HINT}\``;
  }
  if (!remote.listen) return `nectard (pid ${daemon.pid}) read remote.listen as off in ${daemon.nectar_home}/nectar.json when it started; restart it with \`${REMOTE_INSTALL_HINT}\``;
  return remote.last_error ?? undefined;
}

export function remoteStatus(config: MachineConfig | undefined, daemon: DaemonView | null): Record<string, unknown> {
  const listen = config?.remote?.listen === true;
  const remote = daemon?.remote ?? undefined;
  return {
    listen,
    port: remote?.port ?? remotePort(),
    listening: remote?.listening === true,
    address: remote?.address ?? null,
    last_error: listen || remote?.listen === true ? (daemonListenerProblem(daemon) ?? null) : null,
    last_reason: remote?.last_reason ?? null,
    discovery: remote?.discovery ?? null,
  };
}

export async function listenerCheck(
  paths: NectarPaths,
  config: MachineConfig,
  options: { hello?: () => Promise<Hello | undefined> } = {},
): Promise<DoctorCheck> {
  const events = await loggedEvents(paths);
  const lifecycle = events.filter((event) => typeof event.event === "string" && LIFECYCLE.has(event.event)).at(-1);
  const refused = refusals(events);
  const logged = { last_event: lifecycle ?? null, refusals: refused };
  if (config.remote?.listen !== true) {
    return {
      name: "remote",
      status: "info",
      listener: "off",
      message: "The tailnet listener is off, so other nodes cannot publish here or resolve this node's refs",
      hint: REMOTE_INSTALL_HINT,
      ...logged,
    };
  }
  const port = remotePort();
  const read = await readStatus();
  const api = { api: "localapi" as const, localapi: read.endpoint === undefined ? null : describeEndpoint(read.endpoint), discovery: discoveryReport() };
  const failed = (message: string, hint: string): DoctorCheck => ({ name: "remote", status: "fail", listener: "failed", message, hint, ...api, ...logged });
  const found = tailnetAddress(read);
  if (!found.ok) {
    const why = found.reason === "localapi_unreachable" ? `the Tailscale LocalAPI does not answer here, so nectard cannot listen or identify callers: ${read.ok ? "" : read.reason}` : found.message;
    return failed(`remote.listen is on, but ${why}${lifecycleReason(lifecycle, why)}`, "Fix the tailscale check first");
  }
  const where = `${found.address}:${port}`;
  const probe = await probeHello(found.address, port);
  if ("reason" in probe) {
    const daemon = await (options.hello ?? daemonHello)();
    const problem = daemonListenerProblem(daemon);
    const said = `remote.listen is on, but nothing answers on ${where} (${probe.reason})${problem === undefined ? "" : `; ${problem}`}`;
    return {
      ...failed(`${said}${lifecycleReason(lifecycle, said)}`, `Check that nectard runs (nectar daemon status), then restart it with \`${REMOTE_INSTALL_HINT}\``),
      last_reason: daemon?.remote?.last_reason ?? null,
      nectard_discovery: daemon?.remote?.discovery ?? null,
    };
  }
  const error = isObject(probe.envelope) && probe.envelope.ok === false && isObject(probe.envelope.error) ? probe.envelope.error : undefined;
  if (error?.code === "E_FORBIDDEN" && error.refused === "self") {
    const last = refused.last;
    const note =
      last === null
        ? ""
        : `; it refused ${refused.count} caller${refused.count === 1 ? "" : "s"} in the last ${refused.window_hours} h, last ${last.node_name ?? last.node_id ?? "an unknown node"} (${last.rule})`;
    const nectardDiscovery = (await (options.hello ?? daemonHello)())?.remote?.discovery ?? null;
    const found = nectardDiscovery === null ? "" : ` (nectard's ${describeDiscovery(nectardDiscovery)})`;
    return {
      name: "remote",
      status: "pass",
      listener: "listening",
      address: where,
      message: `nectard listens on ${where} and identifies callers through the LocalAPI${found}${note}`,
      ...api,
      nectard_discovery: nectardDiscovery,
      ...logged,
    };
  }
  if (error?.code === "E_FORBIDDEN" && error.refused === "whois") {
    const last = events.filter((event) => typeof event.whois === "string" && event.event !== "remote_listen").at(-1);
    return {
      ...failed(
        `nectard listens on ${where}, but tailscaled WhoIs fails inside nectard, so it refuses every caller${typeof last?.whois === "string" ? `: ${last.whois}` : ""}`,
        "nectard reaches tailscaled through the same LocalAPI as the tailscale check; on macOS see the LocalAPI notes in the SPEC",
      ),
      address: where,
    };
  }
  return failed(`Something answers on ${where}, but not as nectard's tailnet listener`, "Find what holds the port; nectard needs it for the tailnet listener");
}
