import net from "node:net";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allocatePort, portAvailable } from "../src/ports.js";

const servers: net.Server[] = [];
const assigned = Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
  (addresses ?? []).map((address) => ({
    host: address.family === "IPv6" && address.scopeid !== 0 && !address.address.includes("%") ? `${address.address}%${name}` : address.address,
    ipv6Only: address.family === "IPv6",
    reusePort: false,
  })),
);

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function occupy(port: number): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  servers.push(server);
  return server;
}

// An ephemeral base keeps this suite from contending with anything else on the
// machine; each test carves its own window.
async function freeBase(span: number): Promise<number> {
  const probe = net.createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen({ host: "127.0.0.1", port: 0 }, () => resolve((probe.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  for (let base = port; ; base += span + 1) {
    let clear = true;
    for (let offset = 0; offset <= span; offset += 1) {
      if (!(await portAvailable(base + offset))) {
        clear = false;
        break;
      }
    }
    if (clear) return base;
  }
}

describe("port allocator (F5)", () => {
  it.each([
    { host: "0.0.0.0", ipv6Only: false, reusePort: false },
    { host: "127.0.0.1", ipv6Only: false, reusePort: false },
    ...assigned.filter((address) => address.host !== "127.0.0.1" && address.host !== "::1"),
    { host: "::", ipv6Only: true, reusePort: false },
    { host: "::1", ipv6Only: true, reusePort: false },
    { host: "::", ipv6Only: false, reusePort: false },
    { host: "0.0.0.0", ipv6Only: false, reusePort: true },
    { host: "127.0.0.1", ipv6Only: false, reusePort: true },
    { host: "::", ipv6Only: true, reusePort: true },
    { host: "::1", ipv6Only: true, reusePort: true },
  ].filter((options) => (!options.reusePort || process.platform === "linux") && assigned.some((address) => options.host === "0.0.0.0" || options.host === "::" ? net.isIPv6(address.host) === net.isIPv6(options.host) : address.host === options.host)))("skips an occupied candidate without connecting: %j", async (options) => {
    const connected = vi.fn((socket: net.Socket) => socket.destroy());
    const server = net.createServer(connected);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ ...options, port: 0 }, resolve);
    });
    servers.push(server);
    const base = (server.address() as AddressInfo).port;
    const connect = vi.spyOn(net, "createConnection").mockImplementation(() => {
      throw new Error("Availability must not connect");
    });
    try {
      expect(await portAvailable(base)).toBe(false);
      await expect(allocatePort({ start: base, end: base, reserved: new Set(), preferred: base })).rejects.toMatchObject({ code: "E_PORTS" });
      expect(connect).not.toHaveBeenCalled();
      expect(connected).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });

  it("allocates on an IPv4-only host", async () => {
    const server = await occupy(0);
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const interfaces = vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo: [{ address: "127.0.0.1", family: "IPv4", netmask: "255.0.0.0", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
    });
    try {
      expect(await allocatePort({ start: port, end: port, reserved: new Set() })).toBe(port);
    } finally {
      interfaces.mockRestore();
    }
  });

  it.runIf(process.platform === "darwin")("reports that Node reusePort is unavailable on macOS", async () => {
    const server = net.createServer();
    await expect(new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, reusePort: true }, () => {
        servers.push(server);
        resolve();
      });
    })).rejects.toMatchObject({ code: "ENOTSUP" });
  });

  it("skips occupied and reserved ports and honors a free preferred port", async () => {
    const base = await freeBase(4);
    await occupy(base);
    expect(await allocatePort({ start: base, end: base + 4, reserved: new Set([base + 1]) })).toBe(base + 2);
    expect(await allocatePort({ start: base, end: base + 4, reserved: new Set(), preferred: base + 3 })).toBe(base + 3);
    // A preferred port that is occupied or out of range falls back to the scan.
    expect(await allocatePort({ start: base, end: base + 4, reserved: new Set(), preferred: base })).toBe(base + 1);
    expect(await allocatePort({ start: base, end: base + 4, reserved: new Set(), preferred: base - 10 })).toBe(base + 1);
  });

  it("throws E_PORTS when the range is exhausted", async () => {
    const base = await freeBase(1);
    await occupy(base);
    await occupy(base + 1);
    await expect(allocatePort({ start: base, end: base + 1, reserved: new Set() })).rejects.toMatchObject({ code: "E_PORTS" });
    await expect(allocatePort({ start: base, end: base - 1, reserved: new Set() })).rejects.toMatchObject({ code: "E_PORTS" });
  });
});
