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
  | "E_QUOTA";

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
  return new NectarError("E_CHECKOUT", message);
}
