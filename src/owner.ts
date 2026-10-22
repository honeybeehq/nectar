import os from "node:os";
import { runCommand } from "./commands.js";
import type { EnvRecord } from "./types.js";

export type OwnerState = "active" | "inactive" | "unknown";

export async function ownerState(record: EnvRecord): Promise<OwnerState> {
  const id = record.publisher.hive_bee ?? record.publisher.hive_session;
  if (id === undefined) return "unknown";
  const host = record.publisher.node_name;
  if (host === undefined && record.publisher.node !== undefined) return "unknown";
  try {
    const remote = host !== undefined && host.split(".")[0] !== os.hostname().split(".")[0];
    if (remote && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) return "unknown";
    const result = await runCommand(remote ? "tailscale" : "hive", remote ? ["ssh", host, "hive", "list", "--all", "--json"] : ["list", "--all", "--json"], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) return "unknown";
    const rows: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(rows) || rows.some((row: unknown) => typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "string")) return "unknown";
    const row = (rows as Array<Record<string, unknown>>).find((row) => row.id === id);
    if (row === undefined) return "inactive";
    const view = typeof row.view === "object" && row.view !== null ? row.view as Record<string, unknown> : undefined;
    const lifecycle = row.lifecycle ?? view?.lifecycle;
    if (row.archived === true || typeof row.archivedAt === "string" || typeof row.archived_at === "string" || row.status === "done" || row.state === "done" || lifecycle === "archived" || lifecycle === "done") return "inactive";
    if (lifecycle === "active" || ["active", "running", "idle", "booting", "stopped", "waiting"].includes(String(row.state ?? row.status))) return "active";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function protectedPreview(record: EnvRecord): boolean {
  return record.pinned === true || record.name === "bench" || record.name === "main-bench" || (record.app === "bench" && record.branch === "main");
}
