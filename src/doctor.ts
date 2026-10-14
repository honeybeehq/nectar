import { holdsRuntime } from "./liveness.js";
import { loopbackProxy, rootMount, type ServeEntry } from "./tailscale.js";
import type { EnvRecord, MachineConfig, PostgresProvider } from "./types.js";

export const PACK_STORE_TAILNET_PORT = 8440;

export type ServeEntryClass = "owned" | "orphan" | "foreign" | "ambiguous";

export interface ClassifiedServeEntry extends ServeEntry {
  class: ServeEntryClass;
  reason: string;
  env?: string;
  direct?: string;
  upstreamHost?: string;
  upstreamPort?: number;
}

export interface ServeEntryProbe {
  answering: boolean;
  ownerAlive: boolean;
  appAnswers?: boolean;
}

export type CheckStatus = "pass" | "info" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  hint?: string;
  details?: unknown[];
  fixed?: boolean;
  binary?: string | null;
  binary_source?: string;
  api?: "localapi" | "cli";
  localapi?: string | null;
  listener?: "off" | "listening" | "failed";
  address?: string;
  provider?: PostgresProvider | null;
}

export interface DoctorAction {
  action: string;
  target: string;
  reason: string;
  status: "planned" | "done" | "failed" | "skipped";
  before: unknown;
  after: unknown;
  error?: string;
}

export function inTailnetRange(port: number, config: MachineConfig): boolean {
  return port >= config.tailnet_port_start && port <= config.tailnet_port_end && port !== PACK_STORE_TAILNET_PORT;
}

export function serveEntryOwner(entry: ServeEntry, records: EnvRecord[]): EnvRecord | undefined {
  return records.find((record) => record.serve?.tailnet_port === entry.tailnetPort);
}

export function nectarUpstream(port: number, records: EnvRecord[], config: MachineConfig): boolean {
  return (
    (port >= config.upstream_port_start && port <= config.upstream_port_end) ||
    records.some((record) => record.serve?.upstream_port === port || record.serve?.proxy_port === port)
  );
}

export function classifyServeEntry(
  entry: ServeEntry,
  records: EnvRecord[],
  config: MachineConfig,
  probe: ServeEntryProbe,
): ClassifiedServeEntry {
  if (entry.service !== undefined) {
    return { ...entry, class: "foreign", reason: `belongs to Tailscale Service ${entry.service}; Nectar never creates Services` };
  }
  const upstream = loopbackProxy(entry.target);
  if (upstream === undefined) {
    return { ...entry, class: "foreign", reason: "target is not a loopback HTTP proxy, so Nectar did not create it" };
  }
  const base = { ...entry, upstreamHost: upstream.upstreamHost, upstreamPort: upstream.upstreamPort };
  if (!nectarUpstream(upstream.upstreamPort, records, config)) {
    return {
      ...base,
      class: "foreign",
      reason: `upstream port ${upstream.upstreamPort} is outside Nectar's upstream range and no env record allocated it`,
    };
  }
  const owner = serveEntryOwner(entry, records);
  const env = owner === undefined ? {} : { env: owner.name };
  if (owner !== undefined && owner.serve?.upstream_port !== upstream.upstreamPort && owner.serve?.proxy_port !== upstream.upstreamPort) {
    return {
      ...base,
      ...env,
      class: "ambiguous",
      reason: `env ${owner.name} holds :${entry.tailnetPort} but upstream ${owner.serve?.upstream_port ?? "none"}, not ${upstream.upstreamPort}`,
    };
  }
  if (owner !== undefined && !probe.answering && probe.appAnswers === true && owner.urls.local !== null) {
    return {
      ...base,
      ...env,
      class: "orphan",
      direct: owner.urls.local,
      reason: `env ${owner.name}'s proxy on ${upstream.upstreamPort} is down but its app answers; re-point at ${owner.urls.local}`,
    };
  }
  if (owner !== undefined && probe.ownerAlive) {
    return { ...base, ...env, class: "owned", reason: `env ${owner.name}'s own process still runs` };
  }
  if (probe.answering) {
    if (owner !== undefined && holdsRuntime(owner.status)) {
      return { ...base, ...env, class: "owned", reason: `env ${owner.name} is ${owner.status} and its upstream answers` };
    }
    return {
      ...base,
      ...env,
      class: "ambiguous",
      reason: `something answers on ${upstream.upstreamPort} but no live Nectar env owns it`,
    };
  }
  return {
    ...base,
    ...env,
    class: "orphan",
    reason:
      owner === undefined
        ? `nothing listens on Nectar upstream ${upstream.upstreamPort} and no env record holds :${entry.tailnetPort}`
        : `env ${owner.name} is ${owner.status} and nothing listens on its upstream ${upstream.upstreamPort}`,
  };
}

export function guardSharedPorts(entries: ClassifiedServeEntry[]): ClassifiedServeEntry[] {
  return entries.map((entry) => {
    if (entry.class !== "orphan") return entry;
    const sharing = entries.filter((other) => other !== entry && other.tailnetPort === entry.tailnetPort).length;
    if (rootMount(entry) && sharing === 0) return entry;
    return {
      ...entry,
      class: "ambiguous",
      reason:
        sharing > 0
          ? `dead Nectar target, but :${entry.tailnetPort} also serves ${sharing} other handler${sharing === 1 ? "" : "s"} that turning the port off would remove`
          : `dead Nectar target mounted at ${entry.mount ?? "/"}, where Nectar never mounts`,
    };
  });
}

const SHELL_WORDS = new Set(["cd", "exec", "export", "set", "true", "false", ":", "[", "test", "echo", "env", "unset"]);

export function commandTools(command: string): string[] {
  const tools = command.split(/&&|\|\||;|\||\n/).flatMap((segment) => {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < words.length && (words[index] === "exec" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? ""))) index += 1;
    const word = words[index]?.replace(/^['"]|['"]$/g, "");
    if (word === undefined || word.length === 0 || SHELL_WORDS.has(word) || /[/$`(){}<>]/.test(word)) return [];
    return [word];
  });
  return [...new Set(tools)];
}
