import { groupAlive, pidAlive } from "./commands.js";
import { portOpen } from "./ports.js";
import type { EnvRecord, EnvStatus, Liveness, ServeRecord } from "./types.js";

export interface ProbeOptions {
  timeoutsMs?: number[];
  backoffMs?: number;
}

export const DEFAULT_PROBE_TIMEOUTS_MS = [300, 600, 1_200];
const DEFAULT_BACKOFF_MS = 150;

const PROBED_STATUSES: ReadonlySet<EnvStatus> = new Set(["serving", "unhealthy", "crashed"]);

export function hasProbeableServe(record: EnvRecord): record is EnvRecord & { serve: ServeRecord } {
  return record.serve !== undefined && PROBED_STATUSES.has(record.status);
}

const GIVEN_UP_CODES: ReadonlySet<string> = new Set(["E_CRASH_LOOP", "E_PORTS"]);

export function givenUp(record: EnvRecord): boolean {
  return record.status !== "warm" && GIVEN_UP_CODES.has(record.failure?.code ?? "");
}

export function holdsRuntime(status: EnvStatus): boolean {
  return status === "serving" || status === "unhealthy";
}

export function processAlive(serve: Pick<ServeRecord, "pid" | "pgid">): boolean {
  return pidAlive(serve.pid) || groupAlive(serve.pgid);
}

export async function portAnswers(port: number, options: ProbeOptions = {}): Promise<boolean> {
  const timeouts = options.timeoutsMs ?? DEFAULT_PROBE_TIMEOUTS_MS;
  for (const [attempt, timeoutMs] of timeouts.entries()) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, options.backoffMs ?? DEFAULT_BACKOFF_MS));
    if (await portOpen(port, timeoutMs)) return true;
  }
  return false;
}

export async function probeLiveness(serve: ServeRecord, options: ProbeOptions = {}): Promise<Liveness> {
  const alive = processAlive(serve);
  const checkedAt = (): string => new Date().toISOString();
  if (serve.upstream_port === undefined) {
    return alive
      ? { state: "serving", reason: "process_alive", checked_at: checkedAt(), pid_alive: true, port_open: null }
      : { state: "crashed", reason: "process_exited", checked_at: checkedAt(), pid_alive: false, port_open: null };
  }
  const timeouts = options.timeoutsMs ?? DEFAULT_PROBE_TIMEOUTS_MS;
  const open = await portAnswers(serve.upstream_port, alive ? options : { ...options, timeoutsMs: timeouts.slice(0, 1) });
  if (open) return { state: "serving", reason: "port_open", checked_at: checkedAt(), pid_alive: alive, port_open: true };
  return alive
    ? { state: "unhealthy", reason: "port_unresponsive", checked_at: checkedAt(), pid_alive: true, port_open: false }
    : { state: "crashed", reason: "process_exited", checked_at: checkedAt(), pid_alive: false, port_open: false };
}
