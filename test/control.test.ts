import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
import { runCommand, stopProcessGroup } from "../src/commands.js";
import { traceTailscale } from "../src/tailscale.js";
import { fakeExecutable, tempDir } from "./helpers.js";

const servers: ControlServer[] = [];
const pgids: number[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const pgid of pgids.splice(0)) await stopProcessGroup(pgid);
  vi.unstubAllEnvs();
  traceTailscale(undefined);
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

  it("gets a mesh URL from a tailscale CLI that refuses to act as the CLI inside nectard's launchd job", async () => {
    const { home, socket, cell, site } = await setup();
    const fakes = await tempDir("control-tailscale");
    const appCli = await fakeExecutable(
      fakes,
      "Tailscale",
      `if [ -n "$XPC_SERVICE_NAME" ] && [ "$XPC_SERVICE_NAME" != "0" ]; then echo "started as the app for $XPC_SERVICE_NAME, not as the CLI" >&2; exit 1; fi
case "$1 $2" in
  "status --json") printf '{"BackendState":"Running","Self":{"DNSName":"mini03.tailtest.ts.net."}}\\n' ;;
  "serve status") printf '{}\\n' ;;
esac
exit 0`,
    );
    vi.stubEnv("NECTAR_TAILSCALE_BIN", appCli);
    vi.stubEnv("XPC_SERVICE_NAME", "com.honeybeehq.nectard");
    vi.stubEnv("XPC_FLAGS", "0x0");
    const result = (await callDaemon(socket, "publish", { nectar_home: home, caller: { cell }, args: { path: site, name: "launchd" } })) as {
      env: string;
      urls: { mesh: string | null };
      mesh_error: string | null;
      via: string;
    };
    const record = JSON.parse(await readFile(path.join(home, "envs", `${result.env}.json`), "utf8")) as { serve: { pgid: number } };
    pgids.push(record.serve.pgid);
    expect(result.urls.mesh).toMatch(/^https:\/\/mini03\.tailtest\.ts\.net:\d+$/);
    expect(result).toMatchObject({ mesh_error: null, via: "nectard" });
  });

  it("names the real tailscale failure in the publish warning and logs the call as one JSON line", async () => {
    const { home, socket, cell, site } = await setup();
    const fakes = await tempDir("control-tailscale");
    const broken = await fakeExecutable(fakes, "tailscale", `echo "failed to connect to local Tailscale service; is Tailscale running?" >&2\nexit 1`);
    vi.stubEnv("NECTAR_TAILSCALE_BIN", broken);
    const events: Array<Record<string, unknown>> = [];
    traceTailscale((event) => events.push(event));
    const result = (await callDaemon(socket, "publish", { nectar_home: home, caller: { cell }, args: { path: site, name: "broken" } })) as {
      env: string;
      urls: { mesh: string | null };
      warnings: string[];
      mesh_error: string | null;
    };
    const record = JSON.parse(await readFile(path.join(home, "envs", `${result.env}.json`), "utf8")) as { serve: { pgid: number } };
    pgids.push(record.serve.pgid);
    const cause = `tailscale status --json via ${broken} (env) exited 1: "failed to connect to local Tailscale service; is Tailscale running?"`;
    expect(result.urls.mesh).toBeNull();
    expect(result.mesh_error).toBe(cause);
    expect(result.warnings).toContainEqual(expect.stringContaining(`tailscale unavailable: ${cause} — mesh URL unavailable`));
    expect(result.warnings.join("\n")).not.toContain("logged out");
    expect(events[0]).toMatchObject({
      event: "tailscale",
      ok: false,
      binary: broken,
      source: "env",
      argv: ["status", "--json"],
      exit_code: 1,
      signal: null,
      stderr: "failed to connect to local Tailscale service; is Tailscale running?",
      cause,
    });
    expect(typeof events[0]?.duration_ms).toBe("number");
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
    const { home, socket, cell, site } = await setup();
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
    expect(await handleRequest("publish", { nectar_home: home, caller: { cell }, args: { path: site, fresh: "yes" } }, getPaths(home), socket)).toMatchObject({
      ok: false,
      error: { code: "E_USAGE" },
    });
    expect(await handleRequest("publish", { nectar_home: home, caller: { cell }, args: { path: site, fresh: true, dry_run: true } }, getPaths(home), socket)).toMatchObject({
      ok: true,
      result: { dry_run: true },
    });
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
  it("never runs hooks, fsmonitor or filter drivers planted in a Cell repo's git config", async () => {
    const { home, socket, cell } = await setup();
    const repo = path.join(cell, "planted");
    const markers = path.join(cell, "markers");
    await mkdir(markers, { recursive: true });
    const git = async (...args: string[]): Promise<void> => {
      const result = await runCommand("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    };
    await mkdir(repo, { recursive: true });
    await git("init", "-q", "-b", "main");
    await writeFile(path.join(repo, "nectar.toml"), 'name = "planted"\n\n[web]\nserve = "exec node server.mjs"\nready_path = "/"\n');
    await writeFile(
      path.join(repo, "server.mjs"),
      'import http from "node:http";\nimport { readFileSync } from "node:fs";\nhttp.createServer((q, r) => r.end(readFileSync("page.txt", "utf8"))).listen(Number(process.env.PORT), "127.0.0.1");\n',
    );
    await writeFile(path.join(repo, "page.txt"), "plain page\n");
    await writeFile(path.join(repo, "equals.txt"), "e\n");
    await writeFile(path.join(repo, "global.txt"), "g\n");
    await writeFile(path.join(repo, ".gitattributes"), "page.txt filter=evil\nserver.mjs filter=inc\nequals.txt filter=a=b\nglobal.txt filter=glob\n");
    await git("add", "-A");
    await git("commit", "-qm", "planted");
    const plant = (name: string): string => `sh -c 'touch ${path.join(markers, name)}; cat'`;
    await git("config", "filter.evil.smudge", plant("smudge"));
    await git("config", "filter.evil.clean", plant("clean"));
    await git("config", "filter.evil.process", `sh -c 'touch ${path.join(markers, "process")}'`);
    await git("config", "filter.evil.required", "true");
    await writeFile(path.join(cell, "included.cfg"), `[filter "inc"]\n\tsmudge = ${plant("included")}\n`);
    await git("config", "include.path", path.join(cell, "included.cfg"));
    await git("config", "filter.a=b.smudge", plant("equals"));
    const xdg = path.join(cell, "xdg");
    await mkdir(path.join(xdg, "git"), { recursive: true });
    await writeFile(path.join(xdg, "git", "config"), `[filter "glob"]\n\tsmudge = ${plant("global")}\n`);
    vi.stubEnv("XDG_CONFIG_HOME", xdg);
    const script = async (file: string, name: string): Promise<void> => {
      await writeFile(file, `#!/bin/sh\ntouch ${path.join(markers, name)}\n`);
      await chmod(file, 0o755);
    };
    await script(path.join(cell, "fsmonitor.sh"), "fsmonitor");
    await git("config", "core.fsmonitor", path.join(cell, "fsmonitor.sh"));
    for (const hook of ["post-checkout", "reference-transaction", "pre-auto-gc", "post-index-change"]) {
      await script(path.join(repo, ".git", "hooks", hook), hook);
    }

    const publish = async (args: Record<string, unknown>): Promise<{ env: string; urls: { local: string } }> =>
      (await callDaemon(socket, "publish", { nectar_home: home, caller: { cell }, args })) as { env: string; urls: { local: string } };
    const first = await publish({ path: repo });
    const record = (): Promise<{ serve: { pgid: number } }> =>
      readFile(path.join(home, "envs", `${first.env}.json`), "utf8").then((text) => JSON.parse(text) as { serve: { pgid: number } });
    pgids.push((await record()).serve.pgid);
    expect(await get(first.urls.local)).toEqual({ status: 200, body: "plain page\n" });
    const again = await publish({ path: repo });
    pgids.push((await record()).serve.pgid);
    expect(await get(again.urls.local)).toEqual({ status: 200, body: "plain page\n" });
    await callDaemon(socket, "rm", { nectar_home: home, caller: {}, args: { env: first.env, force: true } });
    const borrowed = await publish({ path: repo, worktree: repo, name: undefined });
    pgids.push((await record()).serve.pgid);
    expect(borrowed.env).toBe(first.env);
    await callDaemon(socket, "rm", { nectar_home: home, caller: {}, args: { env: first.env, force: true } });
    expect(await readdir(markers)).toEqual([]);
  });

  it("refuses a partial clone so a planted promisor remote is never fetched from", async () => {
    const { home, socket, cell } = await setup();
    const source = path.join(cell, "source");
    const clone = path.join(cell, "partial");
    const marker = path.join(cell, "lazy-fetch");
    await mkdir(source, { recursive: true });
    const run = async (cwd: string, ...args: string[]): Promise<void> => {
      const result = await runCommand("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    };
    await run(source, "init", "-q", "-b", "main");
    await writeFile(path.join(source, "nectar.toml"), 'name = "partial"\n\n[web]\nserve = "exec node server.mjs"\n');
    await writeFile(path.join(source, "server.mjs"), "export {};\n");
    await run(source, "add", "-A");
    await run(source, "commit", "-qm", "source");
    await run(source, "config", "uploadpack.allowFilter", "true");
    await run(source, "config", "uploadpack.allowAnySHA1InWant", "true");
    await run(cell, "clone", "-q", "--no-local", "--filter=blob:none", "--no-checkout", `file://${source}`, clone);
    const missing = await runCommand("git", ["rev-list", "--objects", "--missing=print", "HEAD"], { cwd: clone });
    expect(missing.stdout).toMatch(/^\?/m);
    await run(clone, "config", "remote.origin.url", `ext::sh -c touch% ${marker}`);
    await run(clone, "config", "protocol.ext.allow", "always");
    await writeFile(path.join(clone, "nectar.toml"), 'name = "partial"\n\n[web]\nserve = "exec node server.mjs"\n');
    await writeFile(path.join(clone, "server.mjs"), "");
    await expect(callDaemon(socket, "publish", { nectar_home: home, caller: { cell }, args: { path: clone } })).rejects.toMatchObject({
      code: "E_CHECKOUT",
      message: expect.stringContaining("partial clone") as string,
    });
    expect(await stat(marker).then(() => true, () => false)).toBe(false);
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
      () => selectRoute("touch", paths, { socket: "/s", hello: hello("/other"), writable: readOnly }),
      () => selectRoute("rm", paths, { socket: "/s", hello: hello("/srv/nectar", ["ls"]), writable: readOnly }),
      () => selectRoute("expose", paths, { socket: "/s", hello: hello("/srv/nectar"), writable: readOnly }),
    ];
    for (const failure of failures) {
      await expect(failure()).rejects.toMatchObject({ code: "E_DAEMON", details: { hint: "nectar daemon install" } });
    }
    expect(await codeOf(selectRoute("expose", paths, { writable }))).toBe("ok");
    for (const view of ["ls", "show", "resolve"]) {
      expect(await selectRoute(view, paths, { socket: "/s", hello: none, writable: readOnly })).toMatchObject({
        kind: "readonly",
        reason: expect.stringContaining("not installed, not running") as string,
      });
    }
  });

  it("finds the Cell root from the working directory", () => {
    expect(cellFromCwd("/home/u/.hive/v2/cells/job-1/space-abc/sub/dir", "space-abc")).toBe("/home/u/.hive/v2/cells/job-1");
    expect(cellFromCwd("/work/repo", "space-abc")).toBe("/work/repo");
    expect(cellFromCwd("/work/repo", undefined)).toBe("/work/repo");
  });
});
