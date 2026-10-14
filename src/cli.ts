#!/usr/bin/env node
import path from "node:path";
import { Command, CommanderError, Option } from "commander";
import { asNectarError, NectarError } from "./errors.js";
import { errorEnvelope, successEnvelope } from "./envelope.js";
import { NectarService } from "./service.js";
import { claimPidFile, daemonLogger, DEFAULT_GC_INTERVAL_MS, DEFAULT_INTERVAL_MS, Supervisor } from "./daemon.js";
import { installUnit, uninstallUnit, unitStatus } from "./daemon-unit.js";
import { parseDuration } from "./duration.js";
import { callDaemon, callerFromEnv, isControlOp, selectRoute, startControlServer, type ControlOp } from "./control.js";
import { getPaths } from "./paths.js";

const argv = process.argv.slice(2);
const jsonRequested = argv.includes("--json");
const knownCommands = ["publish", "ls", "show", "open", "resolve", "touch", "stop", "rm", "gc", "doctor", "expose", "unexpose", "daemon"];
const requestedCommand = argv.find((arg) => knownCommands.includes(arg)) ?? "nectar";

function output(value: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function directRequested(): boolean {
  return program.opts<{ direct?: boolean }>().direct === true;
}

async function routed(command: ControlOp, args: Record<string, unknown>, local: () => Promise<unknown>): Promise<unknown> {
  const paths = getPaths();
  const route = await selectRoute(command, paths, { direct: directRequested() });
  if (route.kind === "direct") return local();
  return callDaemon(route.socket, command, { nectar_home: path.resolve(paths.root), caller: callerFromEnv(), args });
}

async function execute<T>(command: string, action: () => Promise<T>): Promise<void> {
  const json = program.opts<{ json?: boolean }>().json === true || jsonRequested;
  try {
    if (command !== "daemon" && !isControlOp(command)) await selectRoute(command, getPaths(), { direct: directRequested() });
    const result = await action();
    output(json ? successEnvelope(command, result) : result, json);
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
  .action(
    async (
      target: string | undefined,
      options: { mode?: string; branch?: string; ttl?: string; worktree?: string; packet?: string; verify?: boolean; name?: string; dryRun?: boolean },
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
        };
        return routed("publish", args, async () => new NectarService().publish({
          repo: source,
          ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
          ...(options.mode === undefined ? {} : { mode: options.mode }),
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          ...(worktree === undefined ? {} : { worktree }),
          ...(options.packet === undefined ? {} : { packet: options.packet }),
          ...(options.verify === undefined ? {} : { verify: options.verify }),
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        }));
      }),
  );

program
  .command("ls")
  .description("list this machine's environments")
  .option("--mode <mode>")
  .option("--status <status>")
  .action(async (options: { mode?: string; status?: string }) =>
    execute("ls", async () => routed("ls", options, async () => new NectarService().list(options))),
  );

program
  .command("show <env-or-ref>")
  .description("show a full environment record")
  .action(async (input: string) => execute("show", async () => routed("show", { target: input }, async () => new NectarService().show(input))));

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
  .action(async (input: string) => execute("resolve", async () => routed("resolve", { target: input }, async () => new NectarService().resolve(input))));

program
  .command("touch <env-or-ref>")
  .description("reset an environment's TTL")
  .option("--ttl <duration>", "time to live (default: the env's own TTL)")
  .action(async (input: string, options: { ttl?: string }) =>
    execute("touch", async () => routed("touch", { target: input, ttl: options.ttl }, async () => new NectarService().touch(input, options.ttl))),
  );

program
  .command("stop <env>")
  .description("stop serving and retain environment files")
  .action(async (input: string) => execute("stop", async () => routed("stop", { env: input }, async () => new NectarService().stop(input))));

program
  .command("rm <env>")
  .description("stop and trash an environment")
  .option("--force", "confirm removal of a serving environment")
  .action(async (input: string, options: { force?: boolean }) =>
    execute("rm", async () => routed("rm", { env: input, force: options.force }, async () => new NectarService().remove(input, options.force ?? false))),
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
      const supervisor = new Supervisor(service, { intervalMs, gcIntervalMs, log, front: true });
      const control = await startControlServer(service.paths, { log }).catch((error: unknown) => {
        log({ event: "control_unavailable", message: asNectarError(error).message });
        return undefined;
      });
      const shutdown = async (): Promise<void> => {
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
  .action(async () =>
    execute("daemon", async () => {
      const service = new NectarService();
      const installed = await installUnit(service.paths);
      await service.enableDaemon();
      return installed;
    }),
  );

daemon
  .command("uninstall")
  .description("stop nectard and remove its unit; envs keep running")
  .action(async () => execute("daemon", async () => uninstallUnit(new NectarService().paths)));

daemon
  .command("status")
  .description("show whether nectard is installed and running")
  .action(async () => execute("daemon", async () => unitStatus(new NectarService().paths)));

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
