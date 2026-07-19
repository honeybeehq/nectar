import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { allocatePort, portAvailable } from "../src/ports.js";

const servers: net.Server[] = [];

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
