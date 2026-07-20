import crypto from "node:crypto";
import { runCommand } from "./commands.js";
import { NectarError } from "./errors.js";
import { branchSlug } from "./refs.js";
import type { EnvRecord, ExposureTarget } from "./types.js";

// The nctr.site relay control path (DECISIONS D21). Publishing machines drive the
// relay over Tailscale SSH — the same adapter remote refs already use — so they hold
// no relay credentials and run no daemon. Everything here just shells `nectar-relay`
// on the configured VM.

function tailscaleBin(): string {
  return process.env.NECTAR_TAILSCALE_BIN ?? "tailscale";
}

// The control invocation: `tailscale ssh <dest> nectar-relay …` (default, keyless) or
// `ssh <dest> nectar-relay …` for hosts with a system ssh key already trusted.
function controlCommand(target: ExposureTarget, dest: string): { bin: string; prefix: string[] } {
  if (target.control === "ssh") {
    return { bin: process.env.NECTAR_SSH_BIN ?? "ssh", prefix: [dest] };
  }
  return { bin: tailscaleBin(), prefix: ["ssh", dest] };
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
  try {
    const out = await relayExec(target, ["health", "--json"]);
    const parsed = JSON.parse(out) as { caddy?: string; routes?: number };
    return { ok: parsed.caddy === "active", detail: out };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
