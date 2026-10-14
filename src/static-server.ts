import path from "node:path";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import http, { type Server } from "node:http";
import { pathToFileURL } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

type Target = { kind: "file"; file: string; size: number } | { kind: "directory" } | { kind: "missing" };

function send(response: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(message),
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(message);
}

async function locate(root: string, relative: string): Promise<Target> {
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return { kind: "missing" };
  const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch {
      return { kind: "missing" };
    }
    if (info.isSymbolicLink()) return { kind: "missing" };
    if (cursor === candidate) {
      if (info.isFile()) return { kind: "file", file: cursor, size: info.size };
      return info.isDirectory() ? { kind: "directory" } : { kind: "missing" };
    }
    if (!info.isDirectory()) return { kind: "missing" };
  }
  return { kind: "directory" };
}

export async function startStaticServer(rootInput: string, port: number, host = "127.0.0.1"): Promise<Server> {
  const root = await realpath(rootInput);
  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "method not allowed\n", { allow: "GET, HEAD" });
      return;
    }
    let url: URL;
    let relative: string;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
      relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch {
      send(response, 400, "bad path\n");
      return;
    }
    if (relative.includes("\0")) {
      send(response, 404, "not found\n");
      return;
    }
    let target = await locate(root, relative);
    if (target.kind === "directory") {
      if (relative !== "" && !url.pathname.endsWith("/")) {
        send(response, 301, "moved\n", { location: `${url.pathname}/${url.search}` });
        return;
      }
      target = await locate(root, path.join(relative, "index.html"));
    }
    if (target.kind !== "file") {
      send(response, 404, "not found\n");
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[path.extname(target.file).toLowerCase()] ?? "application/octet-stream",
      "content-length": target.size,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(target.file).on("error", () => response.destroy()).pipe(response);
  };
  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, "internal error\n");
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
}

const invoked = process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const root = process.argv[2] ?? process.cwd();
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    process.stderr.write("usage: PORT=<port> static-server [root]\n");
    process.exitCode = 2;
  } else {
    const server = await startStaticServer(root, port);
    const stop = (): void => {
      server.close(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    process.stdout.write(`serving ${root} on 127.0.0.1:${port}\n`);
  }
}
