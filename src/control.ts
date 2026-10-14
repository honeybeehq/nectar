import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { access, chmod, lstat, mkdir, realpath, stat, unlink } from "node:fs/promises";
import { currentPublisher } from "./commands.js";
import { errorEnvelope, successEnvelope, type ErrorEnvelope, type SuccessEnvelope } from "./envelope.js";
import { asNectarError, isErrorCode, NectarError } from "./errors.js";
import type { NectarPaths } from "./paths.js";
import { NectarService } from "./service.js";
import type { ListenerState } from "./remote.js";
import type { Publisher } from "./types.js";

export const CONTROL_API = 1;
export const CONTROL_OPS = ["publish", "ls", "show", "resolve", "touch", "stop", "rm", "expose", "unexpose"] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

export const DAEMON_HINT = "nectar daemon install";
const MAX_BODY_BYTES = 64 * 1024;
const HELLO_TIMEOUT_MS = 2_000;
const SECRET_DIRS = [".ssh", ".gnupg", ".aws", path.join("Library", "Keychains")];
const DRAIN_MS = 15_000;

export interface Caller {
  cell?: string;
  hive_bee?: string;
  hive_session?: string;
}

export interface ControlRequest {
  nectar_home: string;
  caller: Caller;
  args: Record<string, unknown>;
}

export interface Hello {
  api: number;
  ops: string[];
  nectar_home: string;
  pid: number;
  program?: string;
  remote?: ListenerState | null;
}

export type Envelope = SuccessEnvelope<unknown> | ErrorEnvelope;

export function socketPath(): string {
  return process.env.NECTAR_SOCKET ?? path.join(os.homedir(), ".config", "nectar", "nectard.sock");
}

export function isControlOp(value: string): value is ControlOp {
  return (CONTROL_OPS as readonly string[]).includes(value);
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

type ArgSpec = Record<string, "string" | "boolean">;

const ARG_SPECS: Record<ControlOp, { spec: ArgSpec; required: string[] }> = {
  publish: {
    spec: { path: "string", mode: "string", branch: "string", ttl: "string", worktree: "string", packet: "string", verify: "boolean", name: "string", dry_run: "boolean", fresh: "boolean", host: "string", local: "boolean", public: "boolean" },
    required: ["path"],
  },
  ls: { spec: { mode: "string", status: "string", host: "string" }, required: [] },
  show: { spec: { target: "string" }, required: ["target"] },
  resolve: { spec: { target: "string" }, required: ["target"] },
  touch: { spec: { target: "string", ttl: "string" }, required: ["target"] },
  stop: { spec: { env: "string" }, required: ["env"] },
  rm: { spec: { env: "string", force: "boolean" }, required: ["env"] },
  expose: {
    spec: { env: "string", to: "string", gate: "string", password: "string", public: "boolean", ttl: "string", expose_interactive: "boolean", rotate: "boolean" },
    required: ["env"],
  },
  unexpose: { spec: { env: "string" }, required: ["env"] },
};

function checkArgs(op: ControlOp, args: unknown): Record<string, string | boolean> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new NectarError("E_USAGE", "args must be an object");
  const { spec, required } = ARG_SPECS[op];
  const checked: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const type = Object.hasOwn(spec, key) ? spec[key] : undefined;
    if (type === undefined) throw new NectarError("E_USAGE", `nectar ${op} through nectard does not take '${key}'`);
    if (typeof value !== type) throw new NectarError("E_USAGE", `'${key}' must be a ${type}`);
    checked[key] = value as string | boolean;
  }
  for (const key of required) {
    if (checked[key] === undefined) throw new NectarError("E_USAGE", `nectar ${op} needs '${key}'`);
  }
  return checked;
}

function checkCaller(caller: unknown): Caller {
  if (caller === undefined || caller === null) return {};
  if (typeof caller !== "object" || Array.isArray(caller)) throw new NectarError("E_USAGE", "caller must be an object");
  const checked: Caller = {};
  for (const [key, value] of Object.entries(caller)) {
    if (value === undefined || value === null) continue;
    if (key !== "cell" && key !== "hive_bee" && key !== "hive_session") throw new NectarError("E_USAGE", `Unknown caller field '${key}'`);
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new NectarError("E_USAGE", `caller.${key} must be a non-empty string`);
    checked[key] = value;
  }
  return checked;
}

export function cellsRoot(): string {
  return process.env.NECTAR_CELLS_ROOT ?? path.join(process.env.HIVE_V2_DATA_DIR ?? path.join(os.homedir(), ".hive", "v2"), "cells");
}

async function cellRoot(cell: string | undefined): Promise<string | undefined> {
  if (cell === undefined || !path.isAbsolute(cell)) return undefined;
  const real = await realpath(cell).catch(() => undefined);
  const anchor = await realpath(cellsRoot()).catch(() => undefined);
  if (real === undefined || anchor === undefined || real === anchor || !isInside(real, anchor)) return undefined;
  const info = await stat(real).catch(() => undefined);
  if (info === undefined || !info.isDirectory() || info.uid !== process.getuid?.()) return undefined;
  return real;
}

export async function authorizePath(input: string, label: string, caller: Caller, paths: NectarPaths, socket: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new NectarError("E_USAGE", `${label} must be an absolute path on this host: ${input}`);
  const real = await realpath(input).catch(() => undefined);
  if (real === undefined) {
    throw new NectarError(
      "E_USAGE",
      `${label} ${input} does not exist on this host as nectard sees it; Cells have a private /tmp, so publish from your Cell checkout or your home directory`,
      { refused: "path" },
    );
  }
  const home = await realpath(os.homedir());
  const cell = await cellRoot(caller.cell);
  const roots = cell === undefined ? [home] : [home, cell];
  if (!roots.some((root) => isInside(real, root))) {
    throw new NectarError("E_USAGE", `${label} ${real} is outside your home directory${cell === undefined ? "" : ` and your Cell (${cell})`}; nectard publishes only from there`, {
      refused: "path",
    });
  }
  const scope = (await stat(real)).isDirectory() ? real : path.dirname(real);
  const denied = [paths.root, path.dirname(socket), ...SECRET_DIRS.map((entry) => path.join(home, entry))];
  for (const entry of denied) {
    const resolved = await realpath(entry).catch(() => path.resolve(entry));
    if (isInside(real, resolved) || isInside(resolved, scope)) {
      throw new NectarError("E_USAGE", `nectard refuses to publish ${scope}: it is or contains ${resolved}`, { refused: "path" });
    }
  }
  return real;
}

async function dispatch(op: ControlOp, args: Record<string, string | boolean>, caller: Caller, paths: NectarPaths, socket: string): Promise<unknown> {
  const publisher: Publisher = { ...caller, user: currentPublisher().user, via: "nectard" };
  const service = new NectarService(paths.root, { publisher });
  const text = (key: string): string | undefined => (typeof args[key] === "string" ? args[key] : undefined);
  const flag = (key: string): boolean | undefined => (typeof args[key] === "boolean" ? args[key] : undefined);
  const target = text("target") ?? text("env") ?? "";
  switch (op) {
    case "publish": {
      const repo = await authorizePath(text("path") ?? "", "Source path", caller, paths, socket);
      const worktree = text("worktree");
      const borrowed = worktree === undefined ? undefined : await authorizePath(worktree, "Worktree", caller, paths, socket);
      const options = {
        repo,
        mode: text("mode"),
        branch: text("branch"),
        ttl: text("ttl"),
        worktree: borrowed,
        packet: text("packet"),
        verify: flag("verify"),
        name: text("name"),
        dryRun: flag("dry_run"),
        fresh: flag("fresh"),
        host: text("host"),
        local: flag("local"),
        public: flag("public"),
      };
      return { ...(await service.publish(Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)))), via: "nectard" };
    }
    case "ls":
      return service.list(Object.fromEntries(Object.entries({ mode: text("mode"), status: text("status"), host: text("host") }).filter(([, value]) => value !== undefined)));
    case "show":
      return service.show(target);
    case "resolve":
      return service.resolve(target);
    case "touch":
      return service.touch(target, text("ttl"));
    case "stop":
      return service.stop(target);
    case "rm":
      return service.remove(target, flag("force") ?? false);
    case "expose": {
      const gate = text("gate");
      if (gate !== undefined && gate !== "password" && gate !== "none") throw new NectarError("E_USAGE", "gate must be 'password' or 'none'");
      const to = text("to");
      const password = text("password");
      const ttl = text("ttl");
      const open = flag("public");
      const interactive = flag("expose_interactive");
      const rotate = flag("rotate");
      return service.expose(target, {
        ...(to === undefined ? {} : { to }),
        ...(gate === undefined ? {} : { gate }),
        ...(password === undefined ? {} : { password }),
        ...(open === undefined ? {} : { public: open }),
        ...(ttl === undefined ? {} : { ttl }),
        ...(interactive === undefined ? {} : { exposeInteractive: interactive }),
        ...(rotate === undefined ? {} : { rotate }),
      });
    }
    case "unexpose":
      return service.unexpose(target);
  }
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new NectarError("E_USAGE", "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new NectarError("E_USAGE", "Request body is not JSON");
  }
}

async function sameHome(a: string, b: string): Promise<boolean> {
  const real = async (value: string): Promise<string> => realpath(value).catch(() => path.resolve(value));
  return (await real(a)) === (await real(b));
}

export async function handleRequest(op: string, body: unknown, paths: NectarPaths, socket: string): Promise<Envelope> {
  const command = isControlOp(op) ? op : "nectar";
  try {
    if (!isControlOp(op)) throw new NectarError("E_USAGE", `nectard does not serve '${op}'`);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new NectarError("E_USAGE", "Request body must be a JSON object");
    const request = body as Partial<ControlRequest>;
    if (typeof request.nectar_home !== "string" || !(await sameHome(request.nectar_home, paths.root))) {
      throw new NectarError("E_DAEMON", `nectard serves NECTAR_HOME ${paths.root}, not ${String(request.nectar_home)}`, { hint: DAEMON_HINT });
    }
    const caller = checkCaller(request.caller);
    const args = checkArgs(op, request.args ?? {});
    return successEnvelope(command, await dispatch(op, args, caller, paths, socket));
  } catch (error) {
    return errorEnvelope(command, asNectarError(error));
  }
}

export interface ControlServer {
  socket: string;
  close: () => Promise<void>;
}

async function socketAnswers(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(file);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

async function prepareSocketDir(file: string): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) {
    throw new NectarError("E_DAEMON", `${directory} must be a directory owned by you to hold the nectard socket`);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new NectarError("E_DAEMON", `${directory} is writable by other users; nectard will not put its socket there`);
  }
  const existing = await lstat(file).catch(() => undefined);
  if (existing === undefined) return;
  if (!existing.isSocket()) throw new NectarError("E_DAEMON", `${file} exists and is not a socket`);
  if (await socketAnswers(file)) throw new NectarError("E_BUSY", `Another nectard already listens on ${file}`);
  await unlink(file);
}

export async function startControlServer(
  paths: NectarPaths,
  options: { socket?: string; log?: (event: Record<string, unknown>) => void; remote?: () => ListenerState } = {},
): Promise<ControlServer> {
  const socket = options.socket ?? socketPath();
  const log = options.log ?? (() => undefined);
  await prepareSocketDir(socket);
  const hello = (): Hello => ({
    api: CONTROL_API,
    ops: [...CONTROL_OPS],
    nectar_home: paths.root,
    pid: process.pid,
    ...(process.argv[1] === undefined ? {} : { program: process.argv[1] }),
    ...(options.remote === undefined ? {} : { remote: options.remote() }),
  });
  const server = http.createServer((request, response) => {
    const reply = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(`${JSON.stringify(value)}\n`);
    };
    const url = new URL(request.url ?? "/", "http://nectard");
    if (request.method === "GET" && url.pathname === "/v1/hello") {
      reply(200, hello());
      return;
    }
    const match = /^\/v1\/([a-z]+)$/.exec(url.pathname);
    if (request.method !== "POST" || match === null) {
      reply(404, errorEnvelope("nectar", new NectarError("E_USAGE", `nectard has no ${request.method ?? ""} ${url.pathname}`)));
      return;
    }
    const op = match[1] ?? "";
    void readBody(request)
      .then(async (body) => handleRequest(op, body, paths, socket))
      .catch((error: unknown) => errorEnvelope(isControlOp(op) ? op : "nectar", asNectarError(error)))
      .then((envelope) => {
        if (!envelope.ok || ["publish", "rm", "stop", "touch"].includes(op)) {
          log({ event: "control", op, ok: envelope.ok, ...(envelope.ok ? {} : { code: envelope.error.code }) });
        }
        reply(200, envelope);
      });
  });
  server.requestTimeout = 0;
  const previous = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(previous);
  }
  await chmod(socket, 0o600);
  const inode = (await lstat(socket)).ino;
  log({ event: "control_listen", socket });
  return {
    socket,
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([closed, new Promise<void>((resolve) => (timer = setTimeout(resolve, DRAIN_MS)))]);
      clearTimeout(timer);
      server.closeAllConnections();
      const current = await lstat(socket).catch(() => undefined);
      if (current?.ino === inode) await unlink(socket).catch(() => undefined);
    },
  };
}

async function request<T>(socket: string, method: "GET" | "POST", route: string, body?: unknown, timeoutMs?: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = http.request(
      {
        socketPath: socket,
        method,
        path: route,
        headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
        response.on("error", reject);
      },
    );
    if (timeoutMs !== undefined) {
      outgoing.setTimeout(timeoutMs, () => outgoing.destroy(new Error(`nectard did not answer within ${timeoutMs}ms`)));
    }
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

export async function daemonHello(socket = socketPath()): Promise<Hello | undefined> {
  const hello = await request<Partial<Hello>>(socket, "GET", "/v1/hello", undefined, HELLO_TIMEOUT_MS).catch(() => undefined);
  if (hello === undefined || typeof hello.api !== "number" || typeof hello.nectar_home !== "string" || !Array.isArray(hello.ops)) return undefined;
  return hello as Hello;
}

export function callerFromEnv(cwd = process.cwd()): Caller {
  const publisher = currentPublisher();
  const cell = process.env.NECTAR_CELL ?? (process.env.HIVE_CELL === undefined ? undefined : cellFromCwd(cwd, process.env.HIVE_CELL_SPACE));
  return {
    ...(cell === undefined ? {} : { cell }),
    ...(publisher.hive_bee === undefined ? {} : { hive_bee: publisher.hive_bee }),
    ...(publisher.hive_session === undefined ? {} : { hive_session: publisher.hive_session }),
  };
}

export function cellFromCwd(cwd: string, space: string | undefined): string {
  if (space !== undefined && space.length > 0) {
    let current = path.resolve(cwd);
    while (path.dirname(current) !== current) {
      if (path.basename(current) === space) return path.dirname(current);
      current = path.dirname(current);
    }
  }
  return path.resolve(cwd);
}

export async function callDaemon(socket: string, op: ControlOp, body: ControlRequest): Promise<unknown> {
  let envelope: { ok?: unknown; result?: unknown; error?: { code: string; message: string; [key: string]: unknown } };
  try {
    envelope = await request<typeof envelope>(socket, "POST", `/v1/${op}`, body);
  } catch (error) {
    throw new NectarError("E_DAEMON", `nectard stopped answering on ${socket}: ${error instanceof Error ? error.message : String(error)}`, { hint: DAEMON_HINT, socket });
  }
  if (envelope.ok === true) return envelope.result;
  const failure = envelope.error;
  if (envelope.ok !== false || failure === undefined) throw new NectarError("E_DAEMON", `nectard sent an unexpected reply on ${socket}`, { hint: DAEMON_HINT, socket });
  const { code, message, ...details } = failure;
  throw new NectarError(isErrorCode(code) ? code : "E_INTERNAL", message, details);
}

export async function homeWritable(root: string): Promise<boolean> {
  let current = path.resolve(root);
  for (;;) {
    try {
      await access(current, 2);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(current) === current) return false;
      current = path.dirname(current);
    }
  }
}

export type Route = { kind: "direct" } | { kind: "daemon"; socket: string } | { kind: "readonly"; reason: string };

const READ_ONLY_VIEWS: readonly string[] = ["ls", "show", "resolve"];

export async function selectRoute(
  command: string,
  paths: NectarPaths,
  options: { direct?: boolean; socket?: string; hello?: (socket: string) => Promise<Hello | undefined>; writable?: (root: string) => Promise<boolean> } = {},
): Promise<Route> {
  if (options.direct === true) return { kind: "direct" };
  const socket = options.socket ?? socketPath();
  const writable = options.writable ?? homeWritable;
  if (!isControlOp(command)) {
    if (await writable(paths.root)) return { kind: "direct" };
    throw new NectarError(
      "E_DAEMON",
      `NECTAR_HOME ${paths.root} is read-only here and nectar ${command} is not available through nectard; run it from a shell outside the Cell`,
      { hint: DAEMON_HINT, nectar_home: paths.root },
    );
  }
  const hello = await (options.hello ?? daemonHello)(socket);
  const matches = hello !== undefined && (await sameHome(hello.nectar_home, paths.root));
  if (matches && hello.api === CONTROL_API && hello.ops.includes(command)) return { kind: "daemon", socket };
  if (await writable(paths.root)) return { kind: "direct" };
  const reason =
    hello === undefined
      ? `nectard is not installed, not running, or older than this CLI (no answer on ${socket})`
      : !matches
        ? `nectard on ${socket} serves NECTAR_HOME ${hello.nectar_home}`
        : `nectard on ${socket} is older than this CLI and cannot run nectar ${command}; re-run nectar daemon install`;
  if (READ_ONLY_VIEWS.includes(command)) return { kind: "readonly", reason: `NECTAR_HOME is read-only here and ${reason}` };
  throw new NectarError("E_DAEMON", `NECTAR_HOME ${paths.root} is read-only here and ${reason}. Ask the user to run \`${DAEMON_HINT}\` outside the Cell`, {
    hint: DAEMON_HINT,
    socket,
    nectar_home: paths.root,
  });
}
