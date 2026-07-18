import { describe, expect, it } from "vitest";
import { branchSlug, envBaseName, envName, formatRef, parseRef } from "../src/refs.js";

describe("Nectar refs", () => {
  it("normalizes branch and mode-qualified storage identities", () => {
    expect(branchSlug("Agent/Coupons_stack")).toBe("agent-coupons-stack");
    expect(envBaseName("Kontiki", "Agent/Coupons_stack")).toBe("kontiki--agent-coupons-stack");
    expect(envName("Kontiki", "Agent/Coupons_stack", "desktop")).toBe("kontiki--agent-coupons-stack--desktop");
  });

  it("round-trips a mode-qualified ref", () => {
    const ref = formatRef("Trmd-Metal-1", "kontiki--agent-coupons--web");
    expect(ref).toBe("nectar://trmd-metal-1/kontiki--agent-coupons--web");
    expect(parseRef(ref)).toEqual({ host: "trmd-metal-1", env: "kontiki--agent-coupons--web" });
  });

  it.each([
    "https://host/app--branch--web",
    "nectar://host/app",
    "nectar://host/app--branch--web/extra",
    "nectar://host/app--branch--web?x=1",
  ])("rejects malformed ref %s", (value) => {
    expect(() => parseRef(value)).toThrow(/Invalid nectar ref/);
  });
});
