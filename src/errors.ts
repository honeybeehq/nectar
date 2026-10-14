export type ErrorCode =
  | "E_NO_RECIPE"
  | "E_NO_MODE"
  | "E_CHECKOUT"
  | "E_INSTALL"
  | "E_SERVE_TIMEOUT"
  | "E_SMOKE_FAILED"
  | "E_PORTS"
  | "E_TAILNET_DOWN"
  | "E_PLATFORM"
  | "E_NOT_FOUND"
  | "E_QUOTA"
  | "E_SIM"
  | "E_BUSY"
  | "E_USAGE"
  | "E_VERIFY"
  | "E_INTERNAL"
  | "E_EXPOSE"
  | "E_DAEMON"
  | "E_DEPS"
  | "E_SEED";

const CODES = new Set<string>([
  "E_NO_RECIPE", "E_NO_MODE", "E_CHECKOUT", "E_INSTALL", "E_SERVE_TIMEOUT", "E_SMOKE_FAILED",
  "E_PORTS", "E_TAILNET_DOWN", "E_PLATFORM", "E_NOT_FOUND", "E_QUOTA", "E_SIM",
  "E_BUSY", "E_USAGE", "E_VERIFY", "E_INTERNAL", "E_EXPOSE", "E_DAEMON", "E_DEPS", "E_SEED",
]);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && CODES.has(value);
}

export class NectarError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "NectarError";
    this.code = code;
    this.details = details;
  }
}

export function asNectarError(error: unknown): NectarError {
  if (error instanceof NectarError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NectarError("E_INTERNAL", message, { unexpected: true });
}
