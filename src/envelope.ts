import type { NectarError } from "./errors.js";

export interface SuccessEnvelope<T> {
  ok: true;
  command: string;
  result: T;
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
}

export function successEnvelope<T>(command: string, result: T): SuccessEnvelope<T> {
  return { ok: true, command, result };
}

export function errorEnvelope(command: string, error: NectarError): ErrorEnvelope {
  return {
    ok: false,
    command,
    error: { code: error.code, message: error.message, ...error.details },
  };
}
