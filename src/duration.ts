import { NectarError, type ErrorCode } from "./errors.js";

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(value: string, label = "duration", code: ErrorCode = "E_USAGE"): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new NectarError(code, `Invalid ${label} '${value}'; expected e.g. 90s, 12h, or 7d`);
  }
  const amount = Number(match[1]);
  const unit = UNITS[match[2] ?? ""];
  if (!Number.isSafeInteger(amount) || amount <= 0 || unit === undefined) {
    throw new NectarError(code, `Invalid ${label} '${value}'`);
  }
  return amount * unit;
}

export function expiresAt(now: Date, ttlMs: number): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

export function formatRemaining(iso: string, now = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return "expired";
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.ceil(ms / 3_600_000)}h`;
  return `${Math.ceil(ms / 86_400_000)}d`;
}
