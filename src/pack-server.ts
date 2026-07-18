import path from "node:path";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import http, { type Server } from "node:http";
import { pathToFileURL } from "node:url";

class UnsafePathError extends Error {}

function send(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message),
    "x-content-type-options": "nosniff",
  });
  response.end(message);
}

async function safeFile(root: string, relative: string): Promise<{ file: string; size: number }> {
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new UnsafePathError("outside pack root");
  const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index] ?? "");
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new UnsafePathError("symlink refused");
    if (index < parts.length - 1 && !info.isDirectory()) throw new UnsafePathError("non-directory path component");
    if (index === parts.length - 1) {
      if (!info.isFile()) throw new UnsafePathError("not a file");
      return { file: cursor, size: info.size };
    }
  }
  throw new UnsafePathError("directory listing refused");
}

export async function startPackServer(rootInput: string, port: number): Promise<Server> {
  const root = await realpath(rootInput);
  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      send(response, 405, "method not allowed\n");
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname).replace(/^\/+/, "");
    } catch {
      send(response, 400, "bad path\n");
      return;
    }
    if (!relative || relative.includes("\0")) {
      send(response, 404, "not found\n");
      return;
    }
    try {
      const file = await safeFile(root, relative);
      response.writeHead(200, {
        "content-type": file.file.endsWith(".zip") ? "application/zip" : "application/octet-stream",
        "content-length": file.size,
        "cache-control": "private, max-age=60",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(file.file).pipe(response);
    } catch (error) {
      if (error instanceof UnsafePathError) send(response, 404, "not found\n");
      else if ((error as NodeJS.ErrnoException).code === "ENOENT") send(response, 404, "not found\n");
      else send(response, 500, "internal error\n");
    }
  };
  const server = http.createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

const invoked = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const root = process.argv[2];
  const port = Number(process.argv[3]);
  if (root === undefined || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    process.stderr.write("usage: pack-server <root> <port>\n");
    process.exitCode = 2;
  } else {
    const server = await startPackServer(root, port);
    const stop = (): void => {
      server.close(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    process.stdout.write(`serving ${root} on 127.0.0.1:${port}\n`);
  }
}
