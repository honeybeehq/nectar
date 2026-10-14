import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmod, lstat, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizePath,
  callDaemon,
  cellFromCwd,
  CONTROL_API,
  CONTROL_OPS,
  daemonHello,
  handleRequest,
  selectRoute,
  startControlServer,
  type ControlServer,
  type Hello,
} from "../src/control.js";
import { NectarError } from "../src/errors.js";
import { getPaths } from "../src/paths.js";
import { stopProcessGroup } from "../src/commands.js";
import { tempDir } from "./helpers.js";

const servers: ControlServer[] = [];
const pgids: number[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const pgid of pgids.splice(0)) await stopProcessGroup(pgid);
  vi.unstubAllEnvs();
});

async function setup(): Promise<{ home: string; socket: string; cell: string; site: string }> {
  vi.stubEnv("NECTAR_TAILSCALE_BIN", "/bin/false");
  vi.stubEnv("NECTAR_STATIC_SERVER_ENTRY", fileURLToPath(new URL("../src/static-server.ts", import.meta.url)));
  const home = await tempDir("control-home");
  const run = await tempDir("control-run");
  const cells = await tempDir("control-cells");
  vi.stubEnv("NECTAR_CELLS_ROOT", cells);
  const cell = path.join(cells, "job-1");
  const site = path.join(cell, "site");
  await mkdir(site, { recursive: true });
  await writeFile(path.join(site, "index.html"), "<h1>from the cell</h1>");
  const server = await startControlServer(getPaths(home), { socket: path.join(run, "nectard.sock") });
  servers.push(server);
  return { home, socket: server.socket, cell, site };
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof NectarError ? error.code : String(error);
  }
}

describe("nectard control socket", () => {
  it("listens on a 0600 socket and says which home it serves", async () => {
    const { home, socket } = await setup();
    expect((await lstat(socket)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(socket))).mode & 0o077).toBe(0);
    const hello = await daemonHello(socket);
    expect(hello).toEqual({ api: CONTROL_API, ops: [...CONTROL_OPS], nectar_home: home, pid: process.pid });
  });

  it("never steals a live socket, replaces a stale one, and refuses a shared directory", async () => {
    const { home, socket } = await setup();
    await expect(startControlServer(getPaths(home), { socket })).rejects.toMatchObject({ code: "E_BUSY" });

    const staleDir = await tempDir("control-stale");
    const stale = path.join(staleDir, "nectard.sock");
    const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(stale)}, () => console.log("up"))`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise((resolve) => child.stdout.once("data", resolve));
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect((await lstat(stale)).isSocket()).toBe(true);
    const replaced = await startControlServer(getPaths(home), { socket: stale });
    servers.push(replaced);
    expect((await daemonHello(stale))?.nectar_home).toBe(home);

    const shared = await tempDir("control-shared");
    await chmod(shared, 0o777);
    await expect(startControlServer(getPaths(home), { socket: path.join(shared, "nectard.sock") })).rejects.toMatchObject({ code: "E_DAEMON" });
  });

  it("publishes a Cell's static dir into its own work dir, stamps the caller, and keeps serving after the source is gone", async () => {
    const { home, socket, cell, site } = await setup();
    const result = (await callDaemon(socket, "publish", {
      nectar_home: home,
      caller: { cell, hive_bee: "bee-123", hive_session: "session-9" },
      args: { path: site, name: "cellsite" },
    })) as { env: string; urls: { local: string }; source: string };
    expect(result.env).toBe("cellsite--static--web");
    expect(result.source).toBe(site);

    const shown = (await callDaemon(socket, "show", { nectar_home: home, caller: {}, args: { target: result.env } })) as {
      env: { worktree: string; publisher: Record<string, unknown> };
    };
    expect(shown.env.worktree.startsWith(path.join(home, "work"))).toBe(true);
    expect(shown.env.publisher).toMatchObject({ cell, hive_bee: "bee-123", hive_session: "session-9", via: "nectard", user: os.userInfo().username });
    const record = JSON.parse(await readFile(path.join(home, "envs", `${result.env}.json`), "utf8")) as { serve: { pgid: number } };
    pgids.push(record.serve.pgid);

    await rm(site, { recursive: true, force: true });
    expect(await get(result.urls.local)).toEqual({ status: 200, body: "<h1>from the cell</h1>" });

    const listed = (await callDaemon(socket, "ls", { nectar_home: home, caller: {}, args: {} })) as { envs: Array<{ name: string }> };
    expect(listed.envs.map((env) => env.name)).toEqual([result.env]);
    const resolved = (await callDaemon(socket, "resolve", { nectar_home: home, caller: {}, args: { target: result.env } })) as { env: string };
    expect(resolved.env).toBe(result.env);
    const touched = (await callDaemon(socket, "touch", { nectar_home: home, caller: {}, args: { target: result.env, ttl: "2d" } })) as { envs: string[] };
    expect(touched.envs).toEqual([result.env]);
    await expect(callDaemon(socket, "rm", { nectar_home: home, caller: {}, args: { env: result.env } })).rejects.toMatchObject({ code: "E_USAGE" });
    expect(await callDaemon(socket, "rm", { nectar_home: home, caller: {}, args: { env: result.env, force: true } })).toMatchObject({ removed: true });
  });

  it("refuses sources outside the home and the Cell, through symlinks, and inside Nectar's own state", async () => {
    const { home, socket, cell } = await setup();
    const outside = await tempDir("control-outside");
    await writeFile(path.join(outside, "index.html"), "<h1>secret</h1>");
    await symlink(outside, path.join(cell, "escape"));
    await mkdir(path.join(home, "work", "x"), { recursive: true });
    await writeFile(path.join(home, "work", "x", "index.html"), "x");
    const publish = (args: Record<string, unknown>, caller: Record<string, unknown> = { cell }): Promise<unknown> =>
      callDaemon(socket, "publish", { nectar_home: home, caller, args });

    const inHome = os.homedir().startsWith(outside) || outside.startsWith(os.homedir());
    if (!inHome) {
      await expect(publish({ path: outside })).rejects.toMatchObject({ code: "E_USAGE", message: expect.stringContaining("outside your home") as string });
      await expect(publish({ path: path.join(cell, "escape") })).rejects.toMatchObject({ code: "E_USAGE" });
      await expect(publish({ path: path.join(cell, "site") }, { cell: "/" })).rejects.toMatchObject({ code: "E_USAGE" });
    }
    if (!inHome) {
      const mine = await tempDir("control-mine");
      await writeFile(path.join(mine, "index.html"), "x");
      await expect(publish({ path: mine }, { cell: mine })).rejects.toMatchObject({ code: "E_USAGE", details: { refused: "path" } });
    }
    const nested = getPaths(path.join(cell, "state"));
    await mkdir(path.join(nested.work, "x"), { recursive: true });
    await writeFile(path.join(nested.work, "x", "index.html"), "x");
    await expect(authorizePath(path.join(nested.work, "x"), "Source path", { cell }, nested, socket)).rejects.toMatchObject({
      code: "E_USAGE",
      message: expect.stringContaining("refuses") as string,
    });
    await expect(authorizePath(path.join(cell, "site"), "Source path", { cell }, nested, socket)).resolves.toBe(path.join(cell, "site"));
    await writeFile(path.join(cell, "page.html"), "x");
    await expect(authorizePath(path.join(cell, "page.html"), "Source path", { cell }, nested, socket)).rejects.toMatchObject({
      code: "E_USAGE",
      message: expect.stringContaining("contains") as string,
    });
    await expect(publish({ path: path.join(cell, "missing") })).rejects.toMatchObject({ code: "E_USAGE", message: expect.stringContaining("private /tmp") as string });
    await expect(publish({ path: "relative/site" })).rejects.toMatchObject({ code: "E_USAGE" });
    await expect(publish({ path: path.join(cell, "site"), worktree: outside })).rejects.toMatchObject({ code: inHome ? "E_CHECKOUT" : "E_USAGE" });
  });

  it("serves only Nectar's own operations with checked arguments and the same NECTAR_HOME", async () => {
    const { home, socket } = await setup();
    expect(await handleRequest("doctor", { nectar_home: home, args: {} }, getPaths(home), socket)).toMatchObject({ ok: false, error: { code: "E_USAGE" } });
    expect(await handleRequest("ls", { nectar_home: home, args: { cmd: "id" } }, getPaths(home), socket)).toMatchObject({ ok: false, error: { code: "E_USAGE" } });
    expect(await handleRequest("ls", { nectar_home: home, args: JSON.parse('{"__proto__":{}}') as unknown }, getPaths(home), socket)).toMatchObject({
      ok: false,
      error: { code: "E_USAGE", message: "nectar ls through nectard does not take '__proto__'" },
    });
    expect(await handleRequest("rm", { nectar_home: home, args: { env: "x--y--web", force: "yes" } }, getPaths(home), socket)).toMatchObject({
      ok: false,
      error: { code: "E_USAGE" },
    });
    expect(await handleRequest("ls", { nectar_home: home, caller: { evil: "x" }, args: {} }, getPaths(home), socket)).toMatchObject({ ok: false });
    expect(await handleRequest("ls", { nectar_home: "/elsewhere", args: {} }, getPaths(home), socket)).toMatchObject({
      ok: false,
      command: "ls",
      error: { code: "E_DAEMON", hint: "nectar daemon install" },
    });
    const notFound = await new Promise<number>((resolve, reject) => {
      http.request({ socketPath: socket, method: "GET", path: "/v1/ls" }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }).on("error", reject).end();
    });
    expect(notFound).toBe(404);
  });
});

describe("route selection", () => {
  const paths = getPaths("/srv/nectar");
  const hello = (home: string, ops: string[] = [...CONTROL_OPS]): (() => Promise<Hello>) => () => Promise.resolve({ api: CONTROL_API, ops, nectar_home: home, pid: 7 });
  const none = (): Promise<undefined> => Promise.resolve(undefined);
  const writable = (): Promise<boolean> => Promise.resolve(true);
  const readOnly = (): Promise<boolean> => Promise.resolve(false);

  it("prefers a running nectard for the same home and honours --direct", async () => {
    expect(await selectRoute("publish", paths, { socket: "/s", hello: hello("/srv/nectar"), writable })).toEqual({ kind: "daemon", socket: "/s" });
    expect(await selectRoute("publish", paths, { direct: true, socket: "/s", hello: hello("/srv/nectar"), writable: readOnly })).toEqual({ kind: "direct" });
    expect(await selectRoute("ls", paths, { socket: "/s", hello: none, writable })).toEqual({ kind: "direct" });
    expect(await selectRoute("ls", paths, { socket: "/s", hello: hello("/other"), writable })).toEqual({ kind: "direct" });
  });

  it("fails with E_DAEMON and the install hint when the home is read-only and nectard cannot help", async () => {
    const failures = [
      () => selectRoute("publish", paths, { socket: "/s", hello: none, writable: readOnly }),
      () => selectRoute("ls", paths, { socket: "/s", hello: hello("/other"), writable: readOnly }),
      () => selectRoute("rm", paths, { socket: "/s", hello: hello("/srv/nectar", ["ls"]), writable: readOnly }),
      () => selectRoute("expose", paths, { socket: "/s", hello: hello("/srv/nectar"), writable: readOnly }),
    ];
    for (const failure of failures) {
      await expect(failure()).rejects.toMatchObject({ code: "E_DAEMON", details: { hint: "nectar daemon install" } });
    }
    expect(await codeOf(selectRoute("expose", paths, { writable }))).toBe("ok");
  });

  it("finds the Cell root from the working directory", () => {
    expect(cellFromCwd("/home/u/.hive/v2/cells/job-1/space-abc/sub/dir", "space-abc")).toBe("/home/u/.hive/v2/cells/job-1");
    expect(cellFromCwd("/work/repo", "space-abc")).toBe("/work/repo");
    expect(cellFromCwd("/work/repo", undefined)).toBe("/work/repo");
  });
});
