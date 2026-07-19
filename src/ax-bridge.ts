import path from "node:path";
import http, { type Server, type ServerResponse } from "node:http";
import readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

// Loopback SSE bridge between an AX helper (NDJSON snapshots on stdout) and the
// desk/composer: GET /ax streams `data: <snapshot>` events in serve-sim's schema,
// GET /health reports liveness. Exits when the watched app (and thus the helper) dies.
export interface AxBridge {
  server: Server;
  child: ChildProcess;
}

export async function startAxBridge(options: {
  pid: number;
  port: number;
  helper: string;
  intervalMs?: number;
  onExit?: () => void;
}): Promise<AxBridge> {
  const clients = new Set<ServerResponse>();
  let latest: string | undefined;
  let helperError: string | undefined;

  const child = spawn(options.helper, [String(options.pid), String(options.intervalMs ?? 1_000)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as { error?: string };
      if (parsed.error !== undefined) helperError = trimmed;
    } catch {
      return; // Non-JSON helper noise never reaches clients.
    }
    latest = trimmed;
    for (const client of clients) client.write(`data: ${trimmed}\n\n`);
  });

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (url === "/health") {
      const body = JSON.stringify({ ok: helperError === undefined, pid: options.pid, clients: clients.size, error: helperError ?? null });
      response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    if (url === "/ax") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      if (latest !== undefined) response.write(`data: ${latest}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
  });

  child.on("exit", () => {
    setTimeout(() => {
      for (const client of clients) client.end();
      server.close(() => options.onExit?.());
    }, 100).unref();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  return { server, child };
}

const invoked = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const pid = Number(process.argv[2]);
  const port = Number(process.argv[3]);
  const helper = process.argv[4];
  if (!Number.isInteger(pid) || pid <= 1 || !Number.isInteger(port) || port <= 0 || helper === undefined) {
    process.stderr.write("usage: ax-bridge <app-pid> <port> <helper> \n");
    process.exitCode = 2;
  } else {
    const bridge = await startAxBridge({ pid, port, helper, onExit: () => process.exit(0) });
    const stop = (): void => {
      bridge.child.kill("SIGTERM");
      bridge.server.close(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    process.stdout.write(`ax bridge for pid ${pid} on 127.0.0.1:${port}\n`);
  }
}
