import { spawn } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
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
const BODY_EXCERPT = 300;

export function describeEndpoint(endpoint: LocalApiEndpoint): string {
  return endpoint.kind === "socket" ? `unix:${endpoint.socket}` : `127.0.0.1:${endpoint.port} (${endpoint.source} sameuserproof)`;
}

export type DiscoveryStepName = "env" | "lsof" | "group-container" | "macsys" | "socket";
export type DiscoveryOutcome = "found" | "none" | "failed" | "timeout" | "stuck" | "skipped";
export type DiscoveryMode = "interactive" | "service";

export interface DiscoveryStep {
  step: DiscoveryStepName;
  outcome: DiscoveryOutcome;
  ms: number;
  found: number;
  note?: string;
}

export interface Discovery {
  endpoints: LocalApiEndpoint[];
  notes: string[];
  steps: DiscoveryStep[];
  mode: DiscoveryMode;
}

export interface DiscoveryFs {
  readdir: (directory: string) => Promise<string[]>;
  readlink: (file: string) => Promise<string>;
  readFile: (file: string) => Promise<string>;
}

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  macsysDir?: string;
  sockets?: string[];
  lsof?: () => Promise<string>;
  fs?: Partial<DiscoveryFs>;
  mode?: DiscoveryMode;
  stepTimeoutMs?: number;
  budgetMs?: number;
  progress?: (steps: DiscoveryStep[], running: DiscoveryStepName | null) => void;
}

export const DISCOVERY_STEP_TIMEOUT_MS = 3_000;
export const DISCOVERY_BUDGET_MS = 10_000;
export const REDISCOVER_MIN_MS = 30_000;
export const REDISCOVER_MAX_MS = 300_000;

const LS_ERRORS: Array<[RegExp, string]> = [
  [/Operation not permitted/, "EPERM"],
  [/Permission denied/, "EACCES"],
  [/No such file or directory/, "ENOENT"],
  [/Not a directory/, "ENOTDIR"],
];

function listInChild(binary: string, directory: string, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["-1A", directory], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.unref();
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal !== null) {
        reject(Object.assign(new Error(`ls was killed by ${signal}`), { code: `killed by ${signal}` }));
        return;
      }
      if (code === 0) {
        resolve(Buffer.concat(out).toString().split("\n").filter((name) => name !== ""));
        return;
      }
      const stderr = Buffer.concat(err).toString().trim();
      const known = LS_ERRORS.find(([pattern]) => pattern.test(stderr));
      reject(Object.assign(new Error(stderr || `ls exited ${code ?? "on a signal"}`), { code: known?.[1] ?? `ls exited ${code ?? "on a signal"}: ${stderr}` }));
    });
  });
}

let defaultMode: DiscoveryMode = "interactive";

export function setDiscoveryMode(mode: DiscoveryMode): void {
  defaultMode = mode;
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

function lsofRunner(binary: string, timeoutMs: number): () => Promise<string> {
  return async () => {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const result = await runCommand(binary, ["-n", "-a", `-u${uid}`, "-c", "IPNExtension", "-F", "n"], { timeoutMs });
    return result.stdout;
  };
}

async function lsofProofs(lsof: () => Promise<string>, notes: string[]): Promise<LocalApiEndpoint[]> {
  let found: LocalApiEndpoint[];
  try {
    found = parseLsofProofs(await lsof());
  } catch (error) {
    notes.push(`lsof could not list IPNExtension's files: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  if (found.length === 0) notes.push("lsof found no IPNExtension sameuserproof file");
  return found;
}

async function groupContainerProofs(fs: DiscoveryFs, home: string, notes: string[]): Promise<LocalApiEndpoint[]> {
  const root = path.join(home, "Library", "Group Containers");
  let containers: string[];
  try {
    containers = (await fs.readdir(root)).filter((name) => name.endsWith(APP_STORE_CONTAINER));
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
      for (const name of await fs.readdir(directory)) {
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

async function macsysProof(fs: DiscoveryFs, directory: string, notes: string[]): Promise<LocalApiEndpoint[]> {
  let portText: string;
  try {
    portText = await fs.readlink(path.join(directory, "ipnport"));
  } catch (error) {
    notes.push(errorCode(error) === "ENOENT" ? `no ${path.join(directory, "ipnport")} (the standalone Tailscale app is not installed)` : `cannot read ${path.join(directory, "ipnport")}: ${errorCode(error)}`);
    return [];
  }
  const file = path.join(directory, `sameuserproof-${portText}`);
  try {
    const endpoint = tcpEndpoint(Number(portText), (await fs.readFile(file)).trim(), "macsys");
    if (endpoint !== undefined) return [endpoint];
    notes.push(`${file} holds no usable port and token`);
  } catch (error) {
    notes.push(`cannot read ${file}: ${errorCode(error)} (the standalone Tailscale app lets only the admin group read it)`);
  }
  return [];
}

function socketEndpoints(sockets: string[], notes: string[]): Promise<LocalApiEndpoint[]> {
  const present = sockets.filter((socket) => existsSync(socket));
  if (present.length === 0) notes.push(`no tailscaled socket at ${sockets.join(" or ")}`);
  return Promise.resolve(present.map((socket): LocalApiEndpoint => ({ kind: "socket", socket, source: "default" })));
}

const unsettled = new Map<string, { since: number; call: Promise<unknown> }>();

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

const TIMED_OUT = Symbol("timed out");

async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
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

const SERVICE_SKIPS_CONTAINER =
  "nectard runs as a service (a LaunchAgent), and macOS can only ask a GUI app for another app's group container, so the listing would wait on a prompt nobody can answer";

export async function discoverLocalApi(options: DiscoveryOptions = {}): Promise<Discovery> {
  const env = options.env ?? process.env;
  const mode = options.mode ?? defaultMode;
  const pinned = env.NECTAR_TAILSCALE_SOCKET;
  if (pinned !== undefined && pinned !== "") {
    const steps: DiscoveryStep[] = [{ step: "env", outcome: "found", ms: 0, found: 1 }];
    options.progress?.(steps, null);
    return { endpoints: [{ kind: "socket", socket: pinned, source: "env" }], notes: [], steps, mode };
  }
  const platform = options.platform ?? ((env.NECTAR_TEST_DISCOVERY_PLATFORM || undefined) as NodeJS.Platform | undefined) ?? process.platform;
  const stepMs = options.stepTimeoutMs ?? DISCOVERY_STEP_TIMEOUT_MS;
  const fs: DiscoveryFs = {
    readdir: (directory) => listInChild(env.NECTAR_TEST_LS_BIN || (existsSync("/bin/ls") ? "/bin/ls" : "ls"), directory, stepMs),
    readlink: (file) => readlink(file),
    readFile: (file) => readFile(file, "utf8"),
    ...options.fs,
  };
  const deadline = Date.now() + (options.budgetMs ?? DISCOVERY_BUDGET_MS);
  const hang = new Set((env.NECTAR_TEST_DISCOVERY_HANG ?? "").split(",").filter((step) => step !== ""));
  const endpoints: LocalApiEndpoint[] = [];
  const notes: string[] = [];
  const steps: DiscoveryStep[] = [];
  const record = (step: DiscoveryStep): void => {
    steps.push(step);
    if (step.note !== undefined) notes.push(step.note);
    options.progress?.([...steps], null);
  };
  const run = async (step: DiscoveryStepName, key: string | undefined, work: (stepNotes: string[]) => Promise<LocalApiEndpoint[]>): Promise<void> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      record({ step, outcome: "skipped", ms: 0, found: 0, note: `${step}: skipped, discovery spent its ${seconds(options.budgetMs ?? DISCOVERY_BUDGET_MS)} budget` });
      return;
    }
    const earlier = key === undefined ? undefined : unsettled.get(key);
    if (earlier !== undefined) {
      record({ step, outcome: "stuck", ms: 0, found: 0, note: `${step}: skipped, its call from ${seconds(Date.now() - earlier.since)} ago has not returned yet` });
      return;
    }
    options.progress?.([...steps], step);
    const stepNotes: string[] = [];
    const started = Date.now();
    const call = hang.has(step) ? new Promise<LocalApiEndpoint[]>(() => undefined) : work(stepNotes);
    if (key !== undefined) {
      const entry = { since: started, call };
      unsettled.set(key, entry);
      const settled = (): void => {
        if (unsettled.get(key) === entry) unsettled.delete(key);
      };
      call.then(settled, settled);
    }
    const limit = Math.min(stepMs, remaining);
    let result: LocalApiEndpoint[] | typeof TIMED_OUT;
    try {
      result = await settleWithin(call, limit);
    } catch (error) {
      record({ step, outcome: "failed", ms: Date.now() - started, found: 0, note: `${step}: ${errorCode(error)}` });
      return;
    }
    const ms = Date.now() - started;
    if (result === TIMED_OUT) {
      record({ step, outcome: "timeout", ms, found: 0, note: `${step}: did not finish within ${seconds(limit)}, so it was skipped` });
      return;
    }
    endpoints.push(...result);
    record({ step, outcome: result.length > 0 ? "found" : "none", ms, found: result.length, ...(stepNotes.length === 0 ? {} : { note: stepNotes.join("; ") }) });
  };
  if (platform === "darwin") {
    const lsofBinary = env.NECTAR_TEST_LSOF_BIN || (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof");
    const lsof = options.lsof ?? lsofRunner(lsofBinary, stepMs);
    const macsysDir = options.macsysDir ?? (env.NECTAR_TEST_MACSYS_DIR || MACSYS_SHARED_DIR);
    const home = options.home ?? os.homedir();
    const lsofStep = (): Promise<void> => run("lsof", options.lsof === undefined ? `lsof:${lsofBinary}` : undefined, (stepNotes) => lsofProofs(lsof, stepNotes));
    const macsysStep = (): Promise<void> => run("macsys", `macsys:${macsysDir}`, (stepNotes) => macsysProof(fs, macsysDir, stepNotes));
    if (mode === "service") {
      await macsysStep();
      await lsofStep();
      record({ step: "group-container", outcome: "skipped", ms: 0, found: 0, note: `group-container: skipped; ${SERVICE_SKIPS_CONTAINER}` });
    } else {
      await lsofStep();
      await macsysStep();
      if (endpoints.length === 0) await run("group-container", `group-container:${home}`, (stepNotes) => groupContainerProofs(fs, home, stepNotes));
      else record({ step: "group-container", outcome: "skipped", ms: 0, found: 0 });
    }
  }
  const sockets = options.sockets ?? (platform === "darwin" ? [DARWIN_TAILSCALED_SOCKET] : TAILSCALE_SOCKETS);
  await run("socket", `socket:${sockets.join(",")}`, (stepNotes) => socketEndpoints(sockets, stepNotes));
  return { endpoints, notes, steps, mode };
}

export function discoveryStepOf(discovery: Discovery, index: number): DiscoveryStepName | undefined {
  let seen = 0;
  for (const step of discovery.steps) {
    seen += step.found;
    if (index < seen) return step.step;
  }
  return undefined;
}

export interface DiscoveryReport {
  mode: DiscoveryMode;
  at: string;
  steps: DiscoveryStep[];
  running: DiscoveryStepName | null;
  won: { step: DiscoveryStepName | null; endpoint: string } | null;
  next_discovery_in_ms: number | null;
}

export function describeDiscovery(report: DiscoveryReport | null | undefined): string {
  if (report === null || report === undefined) return "no LocalAPI discovery has run in this process";
  const tried = report.steps.map((step) => {
    const how = step.outcome === "timeout" ? `timed out after ${seconds(step.ms)}` : step.outcome === "found" ? `found ${step.found}` : step.outcome;
    return `${step.step} ${how}${report.won?.step === step.step ? " (answered)" : ""}`;
  });
  if (report.running !== null) tried.push(`${report.running} still running`);
  return `${report.mode} discovery: ${tried.join(", ") || "nothing tried yet"}`;
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
let lastDiscovery: { discovery: Discovery; at: number; validMs: number; backedOff: boolean } | undefined;
let discovering: Promise<Discovery> | undefined;
let rediscoverMs = REDISCOVER_MIN_MS;
let report: DiscoveryReport | undefined;

export function pinLocalApi(endpoint: LocalApiEndpoint | undefined): void {
  pinnedEndpoint = endpoint;
  cachedEndpoint = undefined;
  lastDiscovery = undefined;
  rediscoverMs = REDISCOVER_MIN_MS;
  report = undefined;
}

export function discoveryReport(): DiscoveryReport | null {
  if (report === undefined) return null;
  const next = lastDiscovery === undefined || cachedEndpoint !== undefined ? null : Math.max(0, lastDiscovery.at + lastDiscovery.validMs - Date.now());
  return { ...report, steps: [...report.steps], next_discovery_in_ms: next };
}

type Attempt = { ok: true; response: LocalApiResponse } | { ok: false; failure: string; stale: boolean };

async function attempt(endpoint: LocalApiEndpoint, method: string, apiPath: string, options: LocalApiRequestOptions): Promise<Attempt> {
  try {
    const response = await localApiRequest(endpoint, method, apiPath, options);
    if (endpoint.kind === "tcp" && response.status === 401) return { ok: false, failure: `${describeEndpoint(endpoint)} refused its token (a stale sameuserproof)`, stale: true };
    return { ok: true, response };
  } catch (error) {
    return { ok: false, failure: `${describeEndpoint(endpoint)}: ${error instanceof Error ? error.message : String(error)}`, stale: false };
  }
}

function sameEndpoint(a: LocalApiEndpoint, b: LocalApiEndpoint): boolean {
  if (a.kind === "socket") return b.kind === "socket" && a.socket === b.socket;
  return b.kind === "tcp" && a.port === b.port && a.token === b.token;
}

async function currentDiscovery(envPinned: boolean): Promise<{ discovery: Discovery; cachedFor: number | undefined }> {
  if (!envPinned && lastDiscovery !== undefined && Date.now() - lastDiscovery.at < lastDiscovery.validMs) {
    return { discovery: lastDiscovery.discovery, cachedFor: Date.now() - lastDiscovery.at };
  }
  if (discovering === undefined) {
    const at = new Date().toISOString();
    report = { mode: defaultMode, at, steps: [], running: null, won: null, next_discovery_in_ms: null };
    const live = report;
    discovering = discoverLocalApi({
      progress: (steps, running) => {
        Object.assign(live, { steps, running });
      },
    }).finally(() => {
      discovering = undefined;
    });
  }
  const discovery = await discovering;
  if (!envPinned && lastDiscovery?.discovery !== discovery) lastDiscovery = { discovery, at: Date.now(), validMs: rediscoverMs, backedOff: false };
  return { discovery, cachedFor: undefined };
}

export async function callLocalApi(method: string, apiPath: string, options: LocalApiRequestOptions = {}): Promise<LocalApiCall> {
  const failures: string[] = [];
  const tried: LocalApiEndpoint[] = [];
  let stale = false;
  const envPinned = process.env.NECTAR_TAILSCALE_SOCKET !== undefined && process.env.NECTAR_TAILSCALE_SOCKET !== "";
  const first = pinnedEndpoint ?? (envPinned ? undefined : cachedEndpoint);
  if (first !== undefined) {
    const result = await attempt(first, method, apiPath, options);
    if (result.ok) return { ok: true, endpoint: first, response: result.response };
    if (pinnedEndpoint !== undefined) return { ok: false, reason: `Tailscale LocalAPI unreachable: ${result.failure}` };
    cachedEndpoint = undefined;
    failures.push(result.failure);
    tried.push(first);
    stale = result.stale;
  }
  for (;;) {
    const { discovery, cachedFor } = await currentDiscovery(envPinned);
    for (const [index, endpoint] of discovery.endpoints.entries()) {
      if (tried.some((done) => sameEndpoint(endpoint, done))) continue;
      tried.push(endpoint);
      const result = await attempt(endpoint, method, apiPath, options);
      if (result.ok) {
        cachedEndpoint = endpoint;
        rediscoverMs = REDISCOVER_MIN_MS;
        if (report !== undefined) report.won = { step: discoveryStepOf(discovery, index) ?? null, endpoint: describeEndpoint(endpoint) };
        return { ok: true, endpoint, response: result.response };
      }
      failures.push(result.failure);
      stale ||= result.stale;
    }
    if (stale && cachedFor !== undefined) {
      lastDiscovery = undefined;
      stale = false;
      continue;
    }
    if (lastDiscovery?.discovery === discovery && !lastDiscovery.backedOff) {
      lastDiscovery.backedOff = true;
      rediscoverMs = Math.min(rediscoverMs * 2, REDISCOVER_MAX_MS);
    }
    if (report !== undefined) report.won = null;
    const reused = cachedFor === undefined || lastDiscovery === undefined ? [] : [`endpoints from the discovery ${seconds(cachedFor)} ago; the next discovery runs in ${seconds(Math.max(0, lastDiscovery.validMs - cachedFor))}`];
    return { ok: false, reason: `Tailscale LocalAPI unreachable: ${[...discovery.notes, ...failures, ...reused].join("; ") || "nothing to try"}` };
  }
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
  nodeUserId: number;
  tailscaleIPs: string[];
  tags: string[];
}

export type WhoIsResult = { peer: TailnetPeer; reason?: undefined } | { peer?: undefined; reason: string; notFound: boolean };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function userNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function textList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export async function whoIs(addr: string): Promise<WhoIsResult> {
  const call = await callLocalApi("GET", `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`);
  if (!call.ok) return { reason: call.reason, notFound: false };
  const { status, body } = call.response;
  if (status === 404) return { reason: `${addr} is not a tailnet peer`, notFound: true };
  if (status !== 200) return { reason: `Tailscale LocalAPI whois answered ${status}: "${bodyExcerpt(body)}"`, notFound: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { reason: `Tailscale LocalAPI whois printed no JSON: "${bodyExcerpt(body)}"`, notFound: false };
  }
  const node = record(record(parsed)?.Node);
  const profile = record(record(parsed)?.UserProfile) ?? {};
  const addresses = textList(node?.Addresses);
  const tags = textList(node?.Tags);
  if (node === undefined || text(node.StableID) === "" || addresses === undefined || tags === undefined) {
    return { reason: `Tailscale LocalAPI whois named no well-formed node: "${bodyExcerpt(body)}"`, notFound: false };
  }
  const dnsName = text(node.Name).replace(/\.$/, "");
  return {
    peer: {
      loginName: text(profile.LoginName),
      displayName: text(profile.DisplayName),
      nodeName: text(node.ComputedName) || dnsName.split(".")[0] || "",
      dnsName,
      nodeId: text(node.StableID),
      userId: userNumber(profile.ID),
      nodeUserId: userNumber(node.User),
      tailscaleIPs: addresses.map((prefix) => prefix.replace(/\/\d+$/, "")),
      tags,
    },
  };
}

export interface StatusNodeJson {
  ID?: string;
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
