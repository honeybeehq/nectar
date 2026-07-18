import { describe, expect, it } from "vitest";
import { errorEnvelope, successEnvelope } from "../src/envelope.js";
import { NectarError } from "../src/errors.js";

describe("envelope contract", () => {
  it("emits exactly ok, command, result on success", () => {
    const value = successEnvelope("publish", { env: "demo--main--web" });
    expect(Object.keys(value)).toEqual(["ok", "command", "result"]);
    expect(value).toEqual({ ok: true, command: "publish", result: { env: "demo--main--web" } });
  });

  it("emits exactly ok, command, error with structured failure details", () => {
    const value = errorEnvelope("publish", new NectarError("E_SERVE_TIMEOUT", "not ready", { log_tail: ["boom"] }));
    expect(Object.keys(value)).toEqual(["ok", "command", "error"]);
    expect(value).toEqual({
      ok: false,
      command: "publish",
      error: { code: "E_SERVE_TIMEOUT", message: "not ready", log_tail: ["boom"] },
    });
  });
});
