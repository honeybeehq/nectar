import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { pipeline } from "node:stream";

export const PROXY_HEADER = "x-nectar-proxy";
const UPSTREAM_HEADER = "x-nectar-upstream";

export const DEFAULT_TOUCH_EVERY_MS = 5 * 60_000;

export interface Upstream {
  protocol?: "https:";
  slept_previews?: string[];
  host: string;
  port: number;
}

export function upstreamOf(origin: string | null, port: number): Upstream {
  if (origin !== null) {
    try {
      const url = new URL(origin);
      return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) || port };
    } catch {
      return { host: "127.0.0.1", port };
    }
  }
  return { host: "127.0.0.1", port };
}

export function isView(request: http.IncomingMessage): boolean {
  if (request.method !== "GET") return false;
  const dest = request.headers["sec-fetch-dest"];
  if (dest !== undefined) return dest === "document" || dest === "iframe";
  return (request.headers.accept ?? "").includes("text/html");
}

function headerBlock(statusCode: number, statusMessage: string, rawHeaders: string[]): string {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export class EnvProxy {
  private readonly server: http.Server;
  private preparing: Promise<Upstream> | undefined;
  private active = 0;

  get busy(): boolean { return this.active > 0; }
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly agent = new http.Agent({ keepAlive: true });

  constructor(
    readonly env: string,
    readonly port: number,
    public upstream: Upstream,
    private readonly onView: () => void,
    private readonly prepare?: () => Promise<Upstream>,
  ) {
    this.server = http.createServer({ requestTimeout: 0 }, (request, response) => { void this.forward(request, response); });
    this.server.on("upgrade", (request: http.IncomingMessage, socket: Socket, head: Buffer) => { void this.tunnel(request, socket, head); });
    this.server.on("clientError", (_error, socket: Socket) => socket.destroy());
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host: "127.0.0.1", port: this.port, exclusive: true }, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.agent.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private track(finished: (done: () => void) => void): void {
    this.active += 1;
    this.heartbeat ??= setInterval(() => this.onView(), 1_000);
    let ended = false;
    finished(() => {
      if (ended) return;
      ended = true;
      this.active -= 1;
      if (this.active === 0 && this.heartbeat !== undefined) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
    });
  }

  private async ready(): Promise<Upstream> {
    this.preparing ??= (async () => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          return await this.prepare!();
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "E_BUSY" || Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    })().finally(() => { this.preparing = undefined; });
    return this.preparing;
  }

  private async forward(request: http.IncomingMessage, response: http.ServerResponse, retried = false): Promise<void> {
    if (request.headers[PROXY_HEADER] !== undefined) {
      response.writeHead(204, { [PROXY_HEADER]: this.env, [UPSTREAM_HEADER]: String(this.upstream.port) });
      response.end();
      return;
    }
    if (!retried) this.track((done) => { response.once("finish", done); response.once("close", done); });
    try {
      if (this.prepare !== undefined) this.upstream = await this.ready();
    } catch (error) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "2" });
      const capacity = error instanceof Error && "code" in error && ["E_QUOTA", "E_PORTS"].includes(String(error.code));
      response.end(capacity ? `Nectar: ${error.message}\n` : `Nectar: ${this.env} could not wake; retry shortly.\n`);
      return;
    }
    if (response.destroyed) return;
    if (this.upstream.slept_previews?.length) response.setHeader("x-nectar-slept-previews", this.upstream.slept_previews.join(","));
    if (!retried && (this.prepare !== undefined || isView(request))) this.onView();
    const outbound = (this.upstream.protocol === "https:" ? https : http).request(
      { ...this.upstream, method: request.method, path: request.url, headers: this.upstream.protocol === "https:" ? { ...request.headers, host: `${this.upstream.host}:${this.upstream.port}` } : request.headers, agent: this.upstream.protocol === "https:" ? false : this.agent },
      (inbound) => {
        response.writeHead(inbound.statusCode ?? 502, inbound.statusMessage, inbound.rawHeaders);
        pipeline(inbound, response, () => undefined);
      },
    );
    outbound.on("error", () => {
      if (this.prepare !== undefined && !retried && !response.headersSent && !response.destroyed && (request.method === "GET" || request.method === "HEAD") && request.headers["content-length"] === undefined && request.headers["transfer-encoding"] === undefined) {
        setTimeout(() => { void this.forward(request, response, true); }, 100);
        return;
      }
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(`Nectar: the preview app for ${this.env} is not answering; it may be restarting.\n`);
    });
    response.on("close", () => {
      if (!response.writableFinished) outbound.destroy();
    });
    if (request.readableEnded) outbound.end();
    else request.pipe(outbound);
  }

  private async tunnel(request: http.IncomingMessage, socket: Socket, head: Buffer, retried = false): Promise<void> {
    socket.on("error", () => socket.destroy());
    if (!retried) this.track((done) => { socket.once("close", done); });
    try {
      if (this.prepare !== undefined) this.upstream = await this.ready();
    } catch {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    if (socket.destroyed) return;
    this.onView();
    const outbound = (this.upstream.protocol === "https:" ? https : http).request({ ...this.upstream, method: request.method, path: request.url, headers: this.upstream.protocol === "https:" ? { ...request.headers, host: `${this.upstream.host}:${this.upstream.port}` } : request.headers, agent: false });
    outbound.on("upgrade", (inbound, upstreamSocket: Socket, upstreamHead: Buffer) => {
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("close", () => upstreamSocket.destroy());
      upstreamSocket.on("close", () => socket.destroy());
      socket.write(headerBlock(inbound.statusCode ?? 101, inbound.statusMessage ?? "Switching Protocols", inbound.rawHeaders));
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    outbound.on("response", (inbound) => {
      socket.write(headerBlock(inbound.statusCode ?? 502, inbound.statusMessage ?? "", inbound.rawHeaders));
      pipeline(inbound, socket, () => undefined);
    });
    outbound.on("error", () => {
      if (!retried && !socket.destroyed) {
        setTimeout(() => { void this.tunnel(request, socket, head, true); }, 100);
        return;
      }
      socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    });
    outbound.end();
  }
}

export async function probeProxy(port: number, env: string, timeoutMs = 1_000): Promise<number | undefined> {
  return new Promise((resolve) => {
    const request = http.request(
      { host: "127.0.0.1", port, method: "GET", path: "/", headers: { [PROXY_HEADER]: "probe" }, agent: false, timeout: timeoutMs },
      (response) => {
        response.resume();
        const upstream = Number(response.headers[UPSTREAM_HEADER]);
        resolve(response.headers[PROXY_HEADER] === env && Number.isInteger(upstream) ? upstream : undefined);
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(undefined));
    request.end();
  });
}
