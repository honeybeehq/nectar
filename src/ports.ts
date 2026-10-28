import net from "node:net";
import os from "node:os";
import { NectarError } from "./errors.js";

export const RESERVED_SERVICE_PORTS: ReadonlySet<number> = new Set([443, 8440, 8441, 8450, 8451]);
const BLOCKED_HTTP_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

async function portAvailableOnHost(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true, ipv6Only: net.isIPv6(host) }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function portAvailable(port: number): Promise<boolean> {
  const interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? []).map((address) => address.family === "IPv6" && address.scopeid !== 0 && !address.address.includes("%") ? `${address.address}%${name}` : address.address),
  );
  if (interfaces.length === 0) return false;
  const addresses = new Set([...interfaces.map((address) => net.isIPv6(address) ? "::" : "0.0.0.0"), ...interfaces]);
  for (const address of addresses) {
    if (!(await portAvailableOnHost(port, address))) return false;
  }
  return true;
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
    if (port < options.start || port > options.end || options.reserved.has(port) || RESERVED_SERVICE_PORTS.has(port) || BLOCKED_HTTP_PORTS.has(port) || port > 65535) continue;
    if (await portAvailable(port)) return port;
  }
  throw new NectarError("E_PORTS", `No available TCP port in configured range ${options.start}-${options.end}; widen custom port bounds or publish with --host <host>`);
}
