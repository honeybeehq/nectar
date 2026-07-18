import net from "node:net";
import { NectarError } from "./errors.js";

export async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function portOpen(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
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
    if (port < options.start || port > options.end || options.reserved.has(port)) continue;
    if (await portAvailable(port)) return port;
  }
  throw new NectarError("E_PORTS", `No free port in ${options.start}-${options.end}`);
}
