import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pidAlive, runCommand, scrubbedEnvironment, spawnDetachedExecutable, stopProcessGroup } from "./commands.js";
import { NectarError } from "./errors.js";
import { getPaths } from "./paths.js";
import { allocatePort, portAvailable } from "./ports.js";
import { atomicJson, StateStore } from "./state.js";
import { previewProofState } from "./proofs.js";
import { serveStatic } from "./static-server.js";
import { serveEntries, rootMount, serveStatus, serveWeb, statusPorts } from "./tailscale.js";

interface SharedStatic {
  pid: number;
  port: number;
  secret: string;
  tailnetPort?: number;
  tailnetTarget?: string;
}

function metadataFile(store: StateStore): string {
  return path.join(store.paths.root, "shared-static.json");
}

async function metadata(store: StateStore): Promise<SharedStatic | undefined> {
  return readFile(metadataFile(store), "utf8").then((text) => JSON.parse(text) as SharedStatic).catch(() => undefined);
}

export function staticPrefix(name: string, token: string): string {
  return `/s/${name}/${token}/`;
}

async function healthy(info: SharedStatic, timeoutMs = 1_000): Promise<boolean> {
  if (!pidAlive(info.pid)) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/_nectar/${info.secret}`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.status === 200 && await response.text() === info.secret;
  } catch {
    return false;
  }
}

export async function ensureSharedStatic(store: StateStore, dnsName?: string): Promise<{ local: string; mesh: string | null; error: string | null }> {
  const ensure = async (): Promise<{ local: string; mesh: string | null; error: string | null }> => store.withLock("machine--static", async () => {
    let info = await metadata(store);
    let responsive = info !== undefined && await healthy(info);
    if (info !== undefined && pidAlive(info.pid) && !responsive) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        responsive = await healthy(info, 3_000);
        if (responsive) break;
      }
    }
    if (info === undefined || !responsive) {
      if (info !== undefined && pidAlive(info.pid)) {
        const current = await metadata(store);
        if (current?.pid !== info.pid || current.secret !== info.secret) throw new NectarError("E_BUSY", "Shared static server changed during recovery");
        const command = await runCommand("ps", ["-o", "args=", "-p", String(info.pid)], { timeoutMs: 2_000 });
        if (!command.stdout.includes(info.secret) || !command.stdout.includes("shared-static.") || !command.stdout.includes(store.paths.root)) {
          throw new NectarError("E_SERVE_TIMEOUT", "Shared static server PID no longer identifies Nectar's process; left alone");
        }
        await stopProcessGroup(info.pid);
        for (let attempt = 0; attempt < 20 && pidAlive(info.pid); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const secret = crypto.randomBytes(16).toString("hex");
      const entry = process.env.NECTAR_SHARED_STATIC_ENTRY ?? fileURLToPath(new URL("./shared-static.js", import.meta.url));
      const child = spawnDetachedExecutable(process.execPath, [entry, store.paths.root, String(info !== undefined && await portAvailable(info.port) ? info.port : 0), secret], store.paths.root,
        scrubbedEnvironment(process.env.NECTAR_PROOF_LOOKUP === undefined ? {} : { NECTAR_PROOF_LOOKUP: process.env.NECTAR_PROOF_LOOKUP }), path.join(store.paths.logs, "shared-static.log"));
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const current = await metadata(store);
        if (current?.pid === child.pid && await healthy(current)) {
          info = current;
          break;
        }
        if (!pidAlive(child.pid)) throw new NectarError("E_SERVE_TIMEOUT", `Shared static server exited: ${await readFile(path.join(store.paths.logs, "shared-static.log"), "utf8").catch(() => "see logs/shared-static.log")}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (info?.pid !== child.pid) throw new NectarError("E_SERVE_TIMEOUT", "Shared static server did not become ready");
    }
    const local = `http://127.0.0.1:${info.port}`;
    if (dnsName === undefined) return { local, mesh: null, error: "Tailscale is offline" };
    if (info.tailnetPort === undefined) {
      const config = await store.readConfig();
      const reserved = statusPorts(await serveStatus());
      for (let port = config.tailnet_port_start; port <= config.tailnet_port_end; port += 1) reserved.add(port);
      for (let port = config.upstream_port_start; port <= config.upstream_port_end; port += 1) reserved.add(port);
      reserved.add(config.pack_server_port);
      reserved.add(info.port);
      info.tailnetPort = await allocatePort({ start: 10240, end: 65535, reserved });
      await atomicJson(metadataFile(store), info);
    }
    const entries = serveEntries(await serveStatus()).filter((entry) => entry.tailnetPort === info.tailnetPort);
    if (entries.some((entry) => !rootMount(entry) || entry.target !== local && entry.target !== info?.tailnetTarget)) {
      return { local, mesh: null, error: `Shared static tailnet port ${info.tailnetPort} is owned by another service; left alone` };
    }
    if (entries.length > 0 && entries.every((entry) => rootMount(entry) && entry.target === local)) {
      return { local, mesh: `https://${dnsName}:${info.tailnetPort}`, error: null };
    }
    const result = await serveWeb(info.tailnetPort, local);
    if (result.ok) {
      info.tailnetTarget = local;
      await atomicJson(metadataFile(store), info);
    }
    return { local, mesh: result.ok ? `https://${dnsName}:${info.tailnetPort}` : null, error: result.ok ? null : result.message };
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await ensure();
    } catch (error) {
      if (!(error instanceof NectarError) || error.code !== "E_BUSY" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function run(root: string, port: number, secret: string): Promise<void> {
  const store = new StateStore(getPaths(root));
  const previous = await metadata(store);
  const reply = (response: http.ServerResponse, status: number, message: string): void => {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(message);
  };
  const server = http.createServer((request, response) => {
    const handle = async (): Promise<void> => {
      const rawPath = (request.url ?? "/").split("?")[0]!;
      if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|\\|%2f|%5c/i.test(rawPath)) return reply(response, 400, "Invalid static preview path.\n");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === `/_nectar/${secret}`) return reply(response, 200, secret);
      const match = /^\/s\/([a-z0-9-]+)\/([a-f0-9]{32})(\/.*)?$/.exec(url.pathname);
      if (match === null) return reply(response, 404, "Static preview not found.\n");
      const record = await store.maybeEnv(match[1]!);
      if (record === undefined || record.static_route !== match[2]) return reply(response, 404, "Static preview not found.\n");
      if (record.status === "expired" || record.status === "cold" || (Date.parse(record.expires_at) <= Date.now() && (await previewProofState(record)).state === "unlinked")) {
        return reply(response, 410, "This static preview has expired. Publish it again to renew it.\n");
      }
      if (record.status !== "serving") return reply(response, 410, "This static preview is stopped. Publish it again to restart it.\n");
      if (match[3] === undefined) {
        response.writeHead(301, { location: `${url.pathname}/${url.search}` });
        response.end();
        return;
      }
      request.url = `${match[3].replace(/^\/+/, "/")}${url.search}`;
      await serveStatic(record.static_root ?? record.worktree, request, response, staticPrefix(record.name, record.static_route!).slice(0, -1));
    };
    handle().catch(() => {
      if (!response.headersSent) reply(response, 500, "Static preview unavailable.\n");
      else response.destroy();
    });
  });
  const config = await store.readConfig();
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const bound = server.address();
    if (bound === null || typeof bound === "string") throw new Error("Missing shared static listener");
    const inRange = (start: number, end: number): boolean => bound.port >= start && bound.port <= end;
    if (port !== 0 || (!inRange(config.upstream_port_start, config.upstream_port_end) && !inRange(config.tailnet_port_start, config.tailnet_port_end) && bound.port !== config.pack_server_port)) break;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing shared static listener");
  await atomicJson(metadataFile(store), { pid: process.pid, port: address.port, secret, ...(previous?.tailnetPort === undefined ? {} : { tailnetPort: previous.tailnetPort }), ...(previous?.tailnetTarget === undefined ? {} : { tailnetTarget: previous.tailnetTarget }) });
  process.stdout.write(`shared static server pid=${process.pid} port=${address.port}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await run(process.argv[2]!, Number(process.argv[3]), process.argv[4]!);
}
