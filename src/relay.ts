import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { runCommand } from "./commands.js";
import { NectarError } from "./errors.js";
import { readStatus } from "./localapi.js";
import { branchSlug } from "./refs.js";
import { tailscaleBinary } from "./tailscale.js";
import type { EnvRecord, ExposureTarget } from "./types.js";

// The nctr.site relay control paths. With `control: "relayd"` (D35) publishers call
// nectar-relayd's control port on the relay's tailnet address; relayd identifies them
// by tailscaled WhoIs, mints the name and owns the route. The older path (D21) shells
// `nectar-relay` on the VM over Tailscale SSH and stays for relays without relayd.

// The control invocation: `tailscale ssh <dest> nectar-relay …` (default, keyless) or
// `ssh <dest> nectar-relay …` for hosts with a system ssh key already trusted.
function controlCommand(target: ExposureTarget, dest: string): { bin: string; prefix: string[] } {
  if (target.control === "ssh") {
    return { bin: process.env.NECTAR_SSH_BIN ?? "ssh", prefix: [dest] };
  }
  return { bin: tailscaleBinary(), prefix: ["ssh", dest] };
}

// A DNS label: <app>-<branch>-<eid>, sanitized and length-capped at 63. --public
// routes get an unguessable suffix so the subdomain itself can't be guessed from the
// (public, via Certificate Transparency) branch name.
export function exposureSub(record: EnvRecord, isPublic: boolean): string {
  const base = `${branchSlug(record.app)}-${branchSlug(record.branch)}-${record.eid}`
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const suffix = isPublic ? `-${crypto.randomBytes(4).toString("hex")}` : "";
  const budget = 63 - suffix.length;
  return `${base.length > budget ? base.slice(0, budget).replace(/-$/, "") : base}${suffix}`;
}

async function relayExec(target: ExposureTarget, args: string[]): Promise<string> {
  if (target.host === undefined) throw new NectarError("E_EXPOSE", "Exposure target has no host");
  const dest = `${target.user ?? "root"}@${target.host}`;
  const { bin, prefix } = controlCommand(target, dest);
  const result = await runCommand(bin, [...prefix, "nectar-relay", ...args], { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new NectarError("E_EXPOSE", `relay ${args[0]} failed on ${target.host}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

export interface RelayAddResult {
  url: string;
  sub: string;
}

export async function relayAdd(options: {
  target: ExposureTarget;
  sub: string;
  upstream: string;
  expiresEpoch: number;
  gate: "password" | "none";
  password?: string;
}): Promise<RelayAddResult> {
  const gateArgs =
    options.gate === "password"
      ? ["--password", options.password ?? ""]
      : ["--public"];
  // Pass the target's configured domain so one relay box can front any domain its
  // wildcard cert covers, and the returned URL is always on the right domain.
  const domainArgs = options.target.domain === undefined ? [] : ["--domain", options.target.domain];
  const url = await relayExec(options.target, [
    "add",
    options.sub,
    options.upstream,
    String(options.expiresEpoch),
    ...domainArgs,
    ...gateArgs,
  ]);
  return { url, sub: options.sub };
}

export async function relayRm(target: ExposureTarget, sub: string): Promise<void> {
  await relayExec(target, ["rm", sub]);
}

export async function relayHealth(target: ExposureTarget): Promise<{ ok: boolean; detail: string }> {
  if (usesRelayd(target)) {
    try {
      const listing = await relaydMine(target);
      return { ok: !listing.killed, detail: `relayd answers; ${listing.live.size} live route(s) of this node${listing.killed ? "; new routes from this node are disabled" : ""}` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  try {
    const out = await relayExec(target, ["health", "--json"]);
    const parsed = JSON.parse(out) as { caddy?: string; routes?: number };
    return { ok: parsed.caddy === "active", detail: out };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export const RELAYD_PORT = 8450;
const RELAYD_TIMEOUT_MS = 30_000;
const PUBLIC_URL = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function usesRelayd(target: ExposureTarget): boolean {
  return target.control === "relayd";
}

export function relaydName(record: EnvRecord): string {
  return `${branchSlug(record.app)}-${branchSlug(record.branch)}`;
}

async function relaydAddress(target: ExposureTarget): Promise<string> {
  const host = target.host;
  if (host === undefined) throw new NectarError("E_EXPOSE", "Exposure target has no host");
  if (net.isIP(host) !== 0) return host;
  const read = await readStatus();
  if (!read.ok) throw new NectarError("E_TAILNET_DOWN", `Cannot reach relay ${host}: ${read.reason}`);
  const wanted = host.toLowerCase();
  const nodes = [read.status.Self, ...Object.values(read.status.Peer ?? {})];
  const match = nodes.find((node) => {
    const dns = node?.DNSName?.replace(/\.$/, "").toLowerCase();
    return dns === wanted || dns?.split(".")[0] === wanted;
  });
  const address = match?.TailscaleIPs?.find((ip) => net.isIPv4(ip));
  if (address === undefined) throw new NectarError("E_EXPOSE", `No tailnet node named '${host}' for the relay`);
  return address;
}

export interface RelaydReply {
  status: number;
  body: Record<string, unknown>;
}

export async function relaydRequest(target: ExposureTarget, method: string, apiPath: string, body?: Record<string, unknown>): Promise<RelaydReply> {
  const address = await relaydAddress(target);
  const port = target.port ?? RELAYD_PORT;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: address,
        port,
        method,
        path: apiPath,
        headers: { "content-type": "application/json", ...(payload === undefined ? {} : { "content-length": Buffer.byteLength(payload) }) },
        timeout: RELAYD_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new NectarError("E_EXPOSE", `relayd on ${target.host ?? address} answered ${response.statusCode ?? 0} with no JSON`));
            return;
          }
          resolve({ status: response.statusCode ?? 0, body: typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {} });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error(`no answer within ${RELAYD_TIMEOUT_MS / 1000}s`)));
    request.on("error", (error) => reject(new NectarError("E_EXPOSE", `relayd on ${target.host ?? address}:${port} is not reachable: ${error.message}`, { transport: true })));
    request.end(payload);
  });
}

function refused(target: ExposureTarget, reply: RelaydReply, what: string): NectarError {
  const error = typeof reply.body.error === "object" && reply.body.error !== null ? (reply.body.error as Record<string, unknown>) : {};
  const message = typeof error.message === "string" ? error.message : `HTTP ${reply.status}`;
  const details = {
    status: reply.status,
    ...(typeof error.code === "string" ? { relay_code: error.code } : {}),
    ...(typeof error.rule === "string" ? { rule: error.rule } : {}),
    ...(typeof error.node_id === "string" ? { node_id: error.node_id } : {}),
  };
  return new NectarError(reply.status === 403 ? "E_FORBIDDEN" : "E_EXPOSE", `relayd on ${target.host ?? "the relay"} refused ${what}: ${message}`, details);
}

export interface RelaydRoute {
  sub: string;
  url: string;
  gate: "password" | "none";
  expires_at: string;
  cap_at: string;
  last_view_at: string | null;
  password?: string;
}

function route(target: ExposureTarget, body: Record<string, unknown>): RelaydRoute {
  const url = typeof body.url === "string" ? body.url : "";
  const sub = typeof body.sub === "string" ? body.sub : "";
  const expected = target.domain === undefined ? PUBLIC_URL.test(url) && url.startsWith(`https://${sub}.`) : url === `https://${sub}.${target.domain.toLowerCase()}`;
  if (sub === "" || !expected || !PUBLIC_URL.test(url) || typeof body.expires_at !== "string" || typeof body.cap_at !== "string") {
    throw new NectarError("E_EXPOSE", `relayd on ${target.host ?? "the relay"} answered without a usable route`);
  }
  return {
    sub,
    url,
    gate: body.gate === "none" ? "none" : "password",
    expires_at: body.expires_at,
    cap_at: body.cap_at,
    last_view_at: typeof body.last_view_at === "string" ? body.last_view_at : null,
    ...(typeof body.password === "string" ? { password: body.password } : {}),
  };
}

export async function relaydCreate(
  target: ExposureTarget,
  options: { name: string; upstream: string; expiresEpoch: number; gate: "password" | "none"; password?: string },
): Promise<RelaydRoute> {
  const reply = await relaydRequest(target, "PUT", "/routes", {
    name: options.name,
    upstream: options.upstream,
    expires_at: options.expiresEpoch,
    gate: options.gate,
    ...(options.password === undefined ? {} : { password: options.password }),
  });
  if (reply.status !== 201) throw refused(target, reply, "the route");
  return route(target, reply.body);
}

export async function relaydUpdate(target: ExposureTarget, sub: string, change: { expiresEpoch?: number; gate?: "password" | "none" }): Promise<RelaydRoute | "gone"> {
  const reply = await relaydRequest(target, "PATCH", `/routes/${encodeURIComponent(sub)}`, {
    ...(change.expiresEpoch === undefined ? {} : { expires_at: change.expiresEpoch }),
    ...(change.gate === undefined ? {} : { gate: change.gate }),
  });
  if (reply.status === 404) return "gone";
  if (reply.status !== 200) throw refused(target, reply, `the update of ${sub}`);
  return route(target, reply.body);
}

export async function relaydRotate(target: ExposureTarget, sub: string): Promise<RelaydRoute | "gone"> {
  const reply = await relaydRequest(target, "POST", `/routes/${encodeURIComponent(sub)}/rotate`);
  if (reply.status === 404) return "gone";
  if (reply.status !== 200) throw refused(target, reply, `the rotation of ${sub}`);
  return route(target, reply.body);
}

export async function relaydDelete(target: ExposureTarget, sub: string): Promise<"removed" | "gone"> {
  const reply = await relaydRequest(target, "DELETE", `/routes/${encodeURIComponent(sub)}`);
  if (reply.status === 404) return "gone";
  if (reply.status !== 200) throw refused(target, reply, `the removal of ${sub}`);
  return "removed";
}

export interface RelaydListing {
  live: Map<string, RelaydRoute>;
  revoked: Map<string, string>;
  killed: boolean;
}

export async function relaydMine(target: ExposureTarget): Promise<RelaydListing> {
  const reply = await relaydRequest(target, "GET", "/routes?mine=1");
  if (reply.status !== 200) throw refused(target, reply, "the listing");
  const live = new Map<string, RelaydRoute>();
  const revoked = new Map<string, string>();
  for (const entry of Array.isArray(reply.body.routes) ? (reply.body.routes as unknown[]) : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.sub !== "string") continue;
    if (item.revoked === true) revoked.set(item.sub, typeof item.reason === "string" ? item.reason : "revoked");
    else live.set(item.sub, route(target, item));
  }
  return { live, revoked, killed: reply.body.killed === true };
}
