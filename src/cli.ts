#!/usr/bin/env node
import path from "node:path";
import { Command, CommanderError, Option } from "commander";
import { asNectarError, NectarError } from "./errors.js";
import { errorEnvelope, successEnvelope } from "./envelope.js";
import { NectarService } from "./service.js";
import { claimPidFile, daemonLogger, DEFAULT_GC_INTERVAL_MS, DEFAULT_INTERVAL_MS, Supervisor } from "./daemon.js";
import { installUnit, uninstallUnit, unitStatus } from "./daemon-unit.js";
import { parseDuration } from "./duration.js";
import { callDaemon, callerFromEnv, homeWritable, isControlOp, selectRoute, startControlServer, type ControlOp } from "./control.js";
import { getPaths } from "./paths.js";
import { DEFAULT_CONFIG } from "./state.js";
import { debugEnabled, traceTailscale } from "./tailscale.js";
import { isRef } from "./refs.js";
import { setDiscoveryMode } from "./localapi.js";
import { remoteStatus, startRemoteListener } from "./remote.js";

const argv = process.argv.slice(2);
const jsonRequested = argv.includes("--json");
const knownCommands = ["publish", "ls", "show", "open", "resolve", "touch", "stop", "rm", "gc", "doctor", "expose", "unexpose", "daemon", "pool"];
const requestedCommand = argv.find((arg) => knownCommands.includes(arg)) ?? "nectar";

function output(value: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function directRequested(): boolean {
  return program.opts<{ direct?: boolean }>().direct === true;
}

async function routed(command: ControlOp, args: Record<string, unknown>, local: (service: NectarService) => Promise<unknown>, remote = false): Promise<unknown> {
  const paths = getPaths();
  const route = await selectRoute(command, paths, { direct: directRequested(), ...(remote ? { writable: () => Promise.resolve(true) } : {}) });
  if (route.kind === "direct") {
    if (remote && !(await homeWritable(paths.root))) return local(new NectarService(undefined, { readOnly: "NECTAR_HOME is read-only here and nectard is not reachable" }));
    return local(new NectarService());
  }
  if (route.kind === "readonly") return local(new NectarService(undefined, { readOnly: route.reason }));
  try {
    return await callDaemon(route.socket, command, { nectar_home: path.resolve(paths.root), caller: callerFromEnv(), args });
  } catch (error) {
    if (error instanceof NectarError && error.details.refused === "path" && (await homeWritable(paths.root))) return local(new NectarService());
    throw error;
  }
}

async function execute<T>(command: string, action: () => Promise<T>, text?: (result: T) => string): Promise<void> {
  const json = program.opts<{ json?: boolean }>().json === true || jsonRequested;
  if (debugEnabled()) {
    const log = daemonLogger(getPaths(), DEFAULT_CONFIG.log_max_bytes, () => undefined);
    traceTailscale((event) => log({ ...event, by: "cli", pid: process.pid }), { all: true });
  }
  try {
    if (command !== "daemon" && command !== "pool" && !isControlOp(command)) await selectRoute(command, getPaths(), { direct: directRequested() });
    const result = await action();
    if (!json && text !== undefined) process.stdout.write(text(result));
    else output(json ? successEnvelope(command, result) : result, json);
  } catch (error) {
    const nectarError = asNectarError(error);
    if (json) output(errorEnvelope(command, nectarError), true);
    else process.stderr.write(`${nectarError.code}: ${nectarError.message}\n`);
    process.exitCode = 1;
  }
}

const program = new Command();
const explicitHelp = argv.some((arg) => arg === "--help" || arg === "-h") || argv[0] === "help";

program
  .name("nectar")
  .description("Taste review-ready branches on the mesh")
  .version("0.0.0")
  .option("--json", "emit the exact JSON envelope")
  .option("--repo <path>", "repository path", process.cwd())
  .option("--direct", "use NECTAR_HOME directly, never the local nectard")
  .showSuggestionAfterError()
  .exitOverride()
  .configureOutput({
    writeErr: (text) => {
      if (!jsonRequested) process.stderr.write(text);
    },
    // Auto-displayed help (bare `nectar --json`) must not pollute the envelope stream.
    writeOut: (text) => {
      if (!jsonRequested || explicitHelp) process.stdout.write(text);
    },
  });

program
  .command("publish [path]")
  .description("publish a web, desktop, ios, or crystallized dev review environment, or a static HTML site")
  .addOption(new Option("--mode <mode>", "web, desktop, ios, dev, or static"))
  .option("--branch <branch>", "branch to publish")
  .option("--ttl <duration>", "time to live (default 7d)")
  .option("--worktree <path>", "borrow an existing clean worktree")
  .option("--packet <hint>", "optional packet lineage hint")
  .option("--verify", "launch a dev env through readiness, then return it to warm")
  .option("--name <app>", "app name for the env (default: the recipe name, or the directory or file name)")
  .option("--dry-run", "print the detected recipe source, build and serve commands without publishing")
  .option("--fresh", "drop and recreate the env's [deps] databases (and re-run the seed)")
  .option("--host <node>", "ship the committed tree (or static dir) to another node's nectard and publish there")
  .option("--local", "publish on this host even when a pool is configured")
  .action(
    async (
      target: string | undefined,
      options: { mode?: string; branch?: string; ttl?: string; worktree?: string; packet?: string; verify?: boolean; name?: string; dryRun?: boolean; fresh?: boolean; host?: string; local?: boolean },
    ) =>
      execute("publish", async () => {
        const globals = program.opts<{ repo: string }>();
        const source = path.resolve(target ?? globals.repo);
        const worktree = options.worktree === undefined ? undefined : path.resolve(options.worktree);
        const args = {
          path: source,
          mode: options.mode,
          branch: options.branch,
          ttl: options.ttl,
          worktree,
          packet: options.packet,
          verify: options.verify,
          name: options.name,
          dry_run: options.dryRun,
          fresh: options.fresh,
          host: options.host,
          local: options.local,
        };
        return routed("publish", args, async (service) => service.publish({
          repo: source,
          ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
          ...(options.mode === undefined ? {} : { mode: options.mode }),
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          ...(worktree === undefined ? {} : { worktree }),
          ...(options.packet === undefined ? {} : { packet: options.packet }),
          ...(options.verify === undefined ? {} : { verify: options.verify }),
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
          ...(options.host === undefined ? {} : { host: options.host }),
          ...(options.local === undefined ? {} : { local: options.local }),
        }), options.host !== undefined);
      }),
  );

program
  .command("ls")
  .description("list this machine's environments")
  .option("--mode <mode>")
  .option("--status <status>")
  .option("--host <node>", "list another node's environments over the tailnet")
  .action(async (options: { mode?: string; status?: string; host?: string }) =>
    execute("ls", async () => routed("ls", options, async (service) => service.list(options), options.host !== undefined)),
  );

program
  .command("show <env-or-ref>")
  .description("show a full environment record")
  .action(async (input: string) => execute("show", async () => routed("show", { target: input }, async (service) => service.show(input))));

program
  .command("open <env-or-ref>")
  .description("open a web env, verified pack, ios stream, or launch-on-open dev env")
  .option("--no-ax", "skip starting the desktop AX bridge")
  .option("--target <string>", "deliver a consumer-defined target to a dev env")
  .option("--keep", "pin a dev instance so idle GC does not stop it")
  .action(async (input: string, options: { ax?: boolean; target?: string; keep?: boolean }) =>
    execute("open", async () =>
      new NectarService().open(input, {
        noAx: options.ax === false,
        ...(options.target === undefined ? {} : { target: options.target }),
        ...(options.keep === undefined ? {} : { keep: options.keep }),
      }),
    ),
  );

program
  .command("resolve <env-or-ref>")
  .description("resolve a Nectar ref to concrete consumables")
  .action(async (input: string) => execute("resolve", async () => routed("resolve", { target: input }, async (service) => service.resolve(input))));

program
  .command("touch <env-or-ref>")
  .description("reset an environment's TTL")
  .option("--ttl <duration>", "time to live (default: the env's own TTL)")
  .action(async (input: string, options: { ttl?: string }) =>
    execute("touch", async () => routed("touch", { target: input, ttl: options.ttl }, async (service) => service.touch(input, options.ttl), isRef(input))),
  );

program
  .command("stop <env-or-ref>")
  .description("stop serving and retain environment files")
  .action(async (input: string) => execute("stop", async () => routed("stop", { env: input }, async (service) => service.stop(input), isRef(input))));

program
  .command("rm <env-or-ref>")
  .description("stop and trash an environment")
  .option("--force", "confirm removal of a serving environment")
  .action(async (input: string, options: { force?: boolean }) =>
    execute("rm", async () => routed("rm", { env: input, force: options.force }, async (service) => service.remove(input, options.force ?? false), isRef(input))),
  );

program
  .command("expose <env-or-ref>")
  .description("expose a serving env on the public internet through a configured relay")
  .requiredOption("--to <target>", "exposures.<name> from machine config (e.g. site)")
  .addOption(new Option("--gate <gate>", "password or none").choices(["password", "none"]))
  .option("--password <password>", "explicit gate password (default: generated)")
  .option("--public", "confirm an ungated (--gate none) exposure")
  .option("--ttl <duration>", "route lifetime (default: the env's own expiry)")
  .option("--expose-interactive", "allow exposing an interactive iOS stream")
  .action(async (input: string, options: { to: string; gate?: "password" | "none"; password?: string; public?: boolean; ttl?: string; exposeInteractive?: boolean }) =>
    execute("expose", async () =>
      new NectarService().expose(input, {
        to: options.to,
        ...(options.gate === undefined ? {} : { gate: options.gate }),
        ...(options.password === undefined ? {} : { password: options.password }),
        ...(options.public === undefined ? {} : { public: options.public }),
        ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
        ...(options.exposeInteractive === undefined ? {} : { exposeInteractive: options.exposeInteractive }),
      }),
    ),
  );

program
  .command("unexpose <env-or-ref>")
  .description("remove an env's public route")
  .action(async (input: string) => execute("unexpose", async () => new NectarService().unexpose(input)));

program
  .command("gc")
  .description("expire, cool, reap, and quota-prune environments")
  .option("--dry-run", "report without changing state")
  .action(async (options: { dryRun?: boolean }) =>
    execute("gc", async () => new NectarService().gc({ dryRun: options.dryRun ?? false })),
  );

program
  .command("doctor")
  .description("check nectard, gc, env resources, serve entries, PATH tools, ports, and the pack store")
  .option("--fix", "run gc, remove orphaned Nectar Serve entries, install nectard, and repair the :8440 pack-store chain")
  .option("--dry-run", "with --fix: list the repairs without making them")
  .option("--no-daemon", "never install or restart nectard; its check is info only")
  .option("--save", "with --no-daemon: remember it in nectar.json until `nectar daemon install`")
  .action(async (options: { fix?: boolean; dryRun?: boolean; daemon: boolean; save?: boolean }) =>
    execute("doctor", async () =>
      new NectarService().doctor({ fix: options.fix ?? false, dryRun: options.dryRun ?? false, noDaemon: !options.daemon, save: options.save ?? false }),
    ),
  );

async function poolService(): Promise<NectarService> {
  const paths = getPaths();
  return (await homeWritable(paths.root)) ? new NectarService() : new NectarService(undefined, { readOnly: "NECTAR_HOME is read-only here; change the pool from a shell outside the Cell" });
}

function list(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function poolTable(result: Record<string, unknown>): string {
  const hosts = Array.isArray(result.hosts) ? (result.hosts as Array<Record<string, unknown>>) : [];
  if (hosts.length === 0) return `${typeof result.note === "string" ? result.note : "The pool is empty"}\n`;
  const columns = ["host", "healthy", "version", "nectard", "mesh", "deps", "envs", "serving", "load"];
  const cell = (row: Record<string, unknown>, column: string): string => {
    const value = row[column];
    if (column === "host" && row.excluded === true) return `${String(value)} (this host, excluded)`;
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "-";
  };
  const rows = [columns, ...hosts.map((row) => columns.map((column) => cell(row, column)))];
  const widths = columns.map((_, index) => Math.max(...rows.map((row) => (row[index] ?? "").length)));
  const lines = rows.map((row) => row.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  ").trimEnd());
  const errors = hosts.filter((row) => row.error !== undefined).map((row) => `${String(row.host)}: ${(row.error as { message?: string }).message ?? ""}`);
  const next = result.next as { web?: string | null; postgres?: string | null; reason?: string } | undefined;
  const summary = next === undefined ? [] : [`next web/static publish: ${next.web ?? "this host (no usable pool host)"}; next [deps] postgres publish: ${next.postgres ?? "this host"}`, next.reason ?? ""];
  const note = typeof result.note === "string" ? result.note : "";
  return `${[...lines, ...errors, note, ...summary].filter(Boolean).join("\n")}\n`;
}

const pool = program.command("pool").description("the hosts that take web and static publishes when no --host is given");

pool
  .command("ls")
  .description("show the pool and the placements made from this host")
  .action(async () => execute("pool", async () => (await poolService()).poolList()));

pool
  .command("add <hosts...>")
  .description("add nodes to the pool (in order of preference)")
  .option("--prefer <policy>", "first-healthy or least-loaded")
  .option("--for <categories>", "what the pool takes: web,static", list)
  .action(async (hosts: string[], options: { prefer?: string; for?: string[] }) =>
    execute("pool", async () =>
      (await poolService()).poolChange({ add: hosts, ...(options.prefer === undefined ? {} : { prefer: options.prefer }), ...(options.for === undefined ? {} : { defaultFor: options.for }) }),
    ),
  );

pool
  .command("rm <hosts...>")
  .description("remove nodes from the pool")
  .action(async (hosts: string[]) => execute("pool", async () => (await poolService()).poolChange({ remove: hosts })));

pool
  .command("check")
  .description("ask each pool host's nectard for its health, mesh, deps provider and load")
  .action(async () => execute("pool", async () => (await poolService()).poolCheck(), poolTable));

const daemon = program.command("daemon").description("nectard: revive crashed envs, restore them after reboot, run gc hourly");

daemon
  .command("run")
  .description("run the supervisor in the foreground (what the service unit starts)")
  .option("--interval <duration>", "liveness probe interval", `${DEFAULT_INTERVAL_MS / 1_000}s`)
  .option("--gc-interval <duration>", "gc interval", `${DEFAULT_GC_INTERVAL_MS / 3_600_000}h`)
  .action(async (options: { interval: string; gcInterval: string }) => {
    try {
      const intervalMs = parseDuration(options.interval, "interval");
      const gcIntervalMs = parseDuration(options.gcInterval, "gc-interval");
      const service = new NectarService();
      await service.store.init();
      const config = await service.store.readConfig();
      const release = await claimPidFile(service.paths);
      const log = daemonLogger(service.paths, config.log_max_bytes, (line) => process.stdout.write(line));
      traceTailscale(log, { all: debugEnabled() });
      setDiscoveryMode("service");
      const supervisor = new Supervisor(service, { intervalMs, gcIntervalMs, log, front: true });
      const remote = startRemoteListener(service.paths, log, { listen: config.remote?.listen === true });
      const control = await startControlServer(service.paths, { log, remote: remote.state }).catch((error: unknown) => {
        log({ event: "control_unavailable", message: asNectarError(error).message });
        return undefined;
      });
      const shutdown = async (): Promise<void> => {
        await remote.close();
        await control?.close();
        await supervisor.stop();
        await release();
        process.exit(0);
      };
      process.once("SIGTERM", () => void shutdown());
      process.once("SIGINT", () => void shutdown());
      await supervisor.start();
    } catch (error) {
      const nectarError = asNectarError(error);
      process.stderr.write(`${nectarError.code}: ${nectarError.message}\n`);
      process.exitCode = 1;
    }
  });

daemon
  .command("install")
  .description("install and start nectard as a launchd user agent (macOS) or systemd --user unit (Linux)")
  .option("--remote", "also serve the control API on this node's tailnet address (port 8441)")
  .option("--no-remote", "turn the tailnet listener off")
  .action(async (options: { remote?: boolean }) =>
    execute("daemon", async () => {
      const service = new NectarService();
      if (options.remote !== undefined) await service.setRemoteListen(options.remote);
      const installed = await installUnit(service.paths);
      await service.enableDaemon();
      return { ...installed, remote: { listen: (await service.store.readConfig()).remote?.listen === true } };
    }),
  );

daemon
  .command("uninstall")
  .description("stop nectard and remove its unit; envs keep running")
  .action(async () => execute("daemon", async () => uninstallUnit(new NectarService().paths)));

daemon
  .command("status")
  .description("show whether nectard is installed and running")
  .action(async () =>
    execute("daemon", async () => {
      const service = new NectarService();
      const config = await service.store.readConfig().catch(() => undefined);
      const status = await unitStatus(service.paths);
      return { ...status, remote: remoteStatus(config, status.control) };
    }),
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const commanderCode = error instanceof CommanderError ? error.code : undefined;
  const helpShown = commanderCode === "commander.helpDisplayed" || commanderCode === "commander.help";
  if (commanderCode === "commander.version" || (helpShown && explicitHelp)) {
    process.exitCode = 0;
  } else {
    // Argv-level failures are usage errors, not mode/checkout problems — a bee
    // must be told to fix its invocation, not follow F-table remediation.
    const nectarError =
      error instanceof NectarError
        ? error
        : helpShown
          ? new NectarError("E_USAGE", "No command given; run nectar --help for the command list")
          : new NectarError("E_USAGE", error instanceof Error ? error.message : String(error));
    if (jsonRequested) output(errorEnvelope(requestedCommand, nectarError), true);
    else process.stderr.write(`${nectarError.code}: ${nectarError.message}\n`);
    process.exitCode = 1;
  }
}
