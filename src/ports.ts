import net from "node:net";
import os from "node:os";
import { NectarError } from "./errors.js";

export const RESERVED_SERVICE_PORTS: ReadonlySet<number> = new Set([443, 8440, 8441, 8450, 8451]);

async function portAvailableOnHost(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function portAvailable(port: number): Promise<boolean> {
  // macOS can allow a second bind beside a wildcard listener (for example a
  // process using SO_REUSEPORT), so bind-only probing can call an actively
  // served port "free". A successful connection is definitive occupancy.
  if (await portOpen(port)) return false;
  const interfaces = Object.values(os.networkInterfaces()).flatMap((addresses) => addresses ?? []);
  const addresses = [...new Set(interfaces.filter((address) => !address.internal).map((address) => address.address))];
  if ((await Promise.all(addresses.map((address) => portOpenOnHost(port, address)))).some(Boolean)) return false;
  const [ipv4, ipv6] = await Promise.all([
    portAvailableOnHost(port, "127.0.0.1"),
    portAvailableOnHost(port, "::1"),
  ]);
  return ipv4 && ipv6;
}

export async function portOpenOnHost(port: number, host: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function portOpen(port: number, timeoutMs = 300): Promise<boolean> {
  const results = await Promise.all([
    portOpenOnHost(port, "127.0.0.1", timeoutMs),
    portOpenOnHost(port, "::1", timeoutMs),
  ]);
  return results.some(Boolean);
}

export async function allocatePort(options: {
  start: number;
  end: number;
  reserved: Set<number>;
  preferred?: number;
}): Promise<number> {
  const candidates: number[] = [];
  if (options.preferred !== undefined) candidates.push(options.preferred);
  for (let port = options.start; port <= options.end; port += 1) {
    if (port !== options.preferred) candidates.push(port);
  }
  for (const port of candidates) {
    if (port < options.start || port > options.end || options.reserved.has(port) || RESERVED_SERVICE_PORTS.has(port) || port > 65535) continue;
    if (await portAvailable(port)) return port;
  }
  throw new NectarError("E_PORTS", `No available TCP port in configured range ${options.start}-${options.end}; widen custom port bounds or publish with --host <host>`);
}
