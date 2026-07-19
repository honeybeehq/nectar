import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseDevices,
  parseDeviceTypes,
  parseRuntimes,
  selectDeviceType,
  selectRuntime,
  serveSimCommand,
  SERVE_SIM_VERSION,
} from "../src/sim.js";

afterEach(() => vi.unstubAllEnvs());

const runtimesJson = JSON.stringify({
  runtimes: [
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-1", version: "26.1", name: "iOS 26.1", isAvailable: true },
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", version: "26.5", name: "iOS 26.5", isAvailable: true },
    { identifier: "com.apple.CoreSimulator.SimRuntime.iOS-18-2", version: "18.2", name: "iOS 18.2", isAvailable: false },
    { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-0", version: "26.0", name: "watchOS 26.0", isAvailable: true },
  ],
});

describe("simctl parsing and selection", () => {
  it("selects the newest available iOS runtime for 'latest' and honors pins", () => {
    const runtimes = parseRuntimes(runtimesJson);
    expect(runtimes).toHaveLength(3); // watchOS filtered out
    expect(selectRuntime(runtimes, "latest").version).toBe("26.5");
    expect(selectRuntime(runtimes, "26.1").version).toBe("26.1");
    expect(selectRuntime(runtimes, "iOS 26.1").version).toBe("26.1");
    expect(() => selectRuntime(runtimes, "18.2")).toThrow(/not installed/);
    expect(() => selectRuntime([], "latest")).toThrow(/downloadPlatform/);
  });

  it("selects device types by name or identifier", () => {
    const types = parseDeviceTypes(
      JSON.stringify({
        devicetypes: [
          { name: "iPhone 17", identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" },
          { name: "iPad (A16)", identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-A16" },
        ],
      }),
    );
    expect(selectDeviceType(types, "iPhone 17").identifier).toContain("iPhone-17");
    expect(selectDeviceType(types, "com.apple.CoreSimulator.SimDeviceType.iPad-A16").name).toBe("iPad (A16)");
    expect(() => selectDeviceType(types, "iPhone 3G")).toThrow(/not available/);
  });

  it("flattens the per-runtime device map", () => {
    const devices = parseDevices(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
            { udid: "AAA", name: "nectar-demo--main--ios", state: "Booted", isAvailable: true },
          ],
          "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [
            { udid: "BBB", name: "iPhone 17", state: "Shutdown", isAvailable: true },
          ],
        },
      }),
    );
    expect(devices.map((device) => device.udid).sort()).toEqual(["AAA", "BBB"]);
  });

  it("pins the serve-sim version and quotes device names", () => {
    expect(serveSimCommand("nectar-app--main--ios", 4101)).toBe(
      `npx -y serve-sim@${SERVE_SIM_VERSION} 'nectar-app--main--ios' -p 4101`,
    );
    vi.stubEnv("NECTAR_SERVE_SIM_BIN", "node /tmp/fake-serve-sim.mjs");
    expect(serveSimCommand("it's odd", 4102)).toBe(`node /tmp/fake-serve-sim.mjs 'it'\\''s odd' -p 4102`);
  });
});
