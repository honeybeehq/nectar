import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/commands.js";
import { tempDir } from "./helpers.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntry = path.join(repoRoot, "dist", "cli.js");
const isRoot = process.getuid?.() === 0;
let daemon: ChildProcess | undefined;
let home: string;
let cell: string;
let site: string;
let env: NodeJS.ProcessEnv;

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HIVE_") && !key.startsWith("NECTAR_")));
  return { ...inherited, NECTAR_TAILSCALE_BIN: "/bin/false", ...extra };
}

async function cli(environment: NodeJS.ProcessEnv, ...args: string[]): Promise<{ exitCode: number; envelope: Record<string, unknown> }> {
  const result = await runCommand(process.execPath, [cliEntry, ...args, "--json"], { env: environment, cwd: cell, timeoutMs: 30_000 });
  return { exitCode: result.exitCode, envelope: JSON.parse(result.stdout) as Record<string, unknown> };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function unshareWorks(): Promise<boolean> {
  const probe = await tempDir("cli-daemon-probe");
  const result = await runCommand("unshare", ["-rm", "sh", "-c", `mount --bind ${probe} ${probe} && mount -o remount,bind,ro ${probe} && unshare --user --map-user=${process.getuid?.()} --map-group=${process.getgid?.()} true`]).catch(() => undefined);
  return result?.exitCode === 0;
}

beforeAll(async () => {
  const built = await runCommand("pnpm", ["build"], { cwd: repoRoot, timeoutMs: 120_000 });
  if (built.exitCode !== 0) throw new Error(`build failed: ${built.stderr}`);
  home = await tempDir("cli-daemon-home");
  const cells = await tempDir("cli-daemon-cells");
  cell = path.join(cells, "job-1");
  site = path.join(cell, "site");
  await mkdir(site, { recursive: true });
  await writeFile(path.join(site, "index.html"), "<h1>cell</h1>");
  const run = await tempDir("cli-daemon-run");
  env = baseEnv({ NECTAR_HOME: home, NECTAR_SOCKET: path.join(run, "nectard.sock"), NECTAR_CELL: cell, NECTAR_CELLS_ROOT: cells, HIVE_BEE: "cli-bee", HIVE_BEE_ID: "bee-cli-id" });
}, 120_000);

afterAll(async () => {
  await cli(env, "rm", "routed--static--web", "--force", "--direct").catch(() => undefined);
  if (daemon?.pid !== undefined) {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon?.once("exit", resolve));
  }
});

describe("CLI with a read-only NECTAR_HOME", () => {
  it.skipIf(isRoot)("fails with E_DAEMON and the install hint when nectard is not running", async () => {
    const readOnly = await tempDir("cli-daemon-ro");
    await chmod(readOnly, 0o555);
    const roEnv = { ...env, NECTAR_HOME: readOnly };
    for (const args of [["publish", site], ["ls"], ["rm", "x--y--web"], ["expose", "x--y--web", "--to", "site"]]) {
      const result = await cli(roEnv, ...args);
      expect(result.exitCode).toBe(1);
      expect(result.envelope).toMatchObject({ ok: false, command: args[0], error: { code: "E_DAEMON", hint: "nectar daemon install" } });
    }
    const direct = await cli(roEnv, "ls", "--direct");
    expect(direct.envelope).toMatchObject({ ok: false });
    expect((direct.envelope.error as { code: string }).code).not.toBe("E_DAEMON");
    await chmod(readOnly, 0o755);
  });

  it("routes to a running nectard, stamps the caller, and --direct bypasses it", async () => {
    daemon = spawn(process.execPath, [cliEntry, "daemon", "run"], { env, stdio: "ignore" });
    await waitFor(async () => (await lstat(String(env.NECTAR_SOCKET)).catch(() => undefined))?.isSocket() === true);

    const status = await cli(env, "daemon", "status");
    expect(status.envelope).toMatchObject({ ok: true, result: { socket: env.NECTAR_SOCKET, control: { nectar_home: home, pid: daemon.pid } } });

    const published = await cli(env, "publish", "site", "--name", "routed");
    expect(published.envelope).toMatchObject({ ok: true, command: "publish", result: { env: "routed--static--web", source: site } });
    const shown = await cli(env, "show", "routed--static--web");
    expect(shown.envelope).toMatchObject({ ok: true, result: { env: { publisher: { via: "nectard", cell, hive_bee: "cli-bee", hive_session: "bee-cli-id" } } } });

    const outside = await tempDir("cli-daemon-outside");
    if (!outside.startsWith(os.homedir())) {
      await writeFile(path.join(outside, "index.html"), "<h1>outside</h1>");
      const fallback = await cli(env, "publish", outside, "--name", "outside", "--dry-run");
      expect(fallback.envelope).toMatchObject({ ok: true, result: { dry_run: true, repo: outside } });
    }

    const direct = await cli(env, "publish", "site", "--name", "routed", "--direct");
    expect(direct.envelope).toMatchObject({ ok: true });
    const shownDirect = await cli(env, "show", "routed--static--web", "--direct");
    expect((shownDirect.envelope.result as { env: { publisher: Record<string, unknown> } }).env.publisher).not.toHaveProperty("via");
  });

  it.skipIf(isRoot)("publishes, lists, shows, resolves and removes through nectard from a read-only bind of the same home", async () => {
    if (daemon === undefined || !(await unshareWorks())) return;
    const script = [
      `mount --bind '${home}' '${home}'`,
      `mount -o remount,bind,ro '${home}'`,
      `exec unshare --user --map-user=${process.getuid?.()} --map-group=${process.getgid?.()} '${process.execPath}' '${cliEntry}' "$@"`,
    ].join(" && ");
    const inCell = async (...args: string[]): Promise<Record<string, unknown>> => {
      const result = await runCommand("unshare", ["-rm", "sh", "-c", script, "sh", ...args, "--json"], { env, cwd: cell, timeoutMs: 30_000 });
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    expect(await inCell("publish", site, "--name", "robind")).toMatchObject({ ok: true, result: { env: "robind--static--web" } });
    expect(await inCell("ls")).toMatchObject({ ok: true });
    expect(await inCell("show", "robind--static--web")).toMatchObject({ ok: true, result: { env: { publisher: { via: "nectard" } } } });
    expect(await inCell("resolve", "robind--static--web")).toMatchObject({ ok: true, result: { env: "robind--static--web" } });
    expect(await inCell("rm", "robind--static--web", "--force")).toMatchObject({ ok: true, result: { removed: true } });
    expect(await inCell("expose", "routed--static--web", "--to", "site")).toMatchObject({ ok: false, error: { code: "E_DAEMON" } });
    expect(await inCell("rm", "routed--static--web", "--force")).toMatchObject({ ok: true });
  });
});
