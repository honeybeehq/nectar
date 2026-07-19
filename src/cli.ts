#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import { asNectarError, NectarError } from "./errors.js";
import { errorEnvelope, successEnvelope } from "./envelope.js";
import { NectarService } from "./service.js";

const argv = process.argv.slice(2);
const jsonRequested = argv.includes("--json");
const knownCommands = ["publish", "ls", "show", "open", "resolve", "touch", "stop", "rm", "gc", "doctor"];
const requestedCommand = argv.find((arg) => knownCommands.includes(arg)) ?? "nectar";

function output(value: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function execute<T>(command: string, action: () => Promise<T>): Promise<void> {
  const json = program.opts<{ json?: boolean }>().json === true || jsonRequested;
  try {
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
program
  .name("nectar")
  .description("Taste review-ready branches on the mesh")
  .version("0.0.0")
  .option("--json", "emit the exact JSON envelope")
  .option("--repo <path>", "repository path", process.cwd())
  .showSuggestionAfterError()
  .exitOverride()
  .configureOutput({
    writeErr: (text) => {
      if (!jsonRequested) process.stderr.write(text);
    },
  });

program
  .command("publish")
  .description("publish a web, desktop, or ios review environment")
  .addOption(new Option("--mode <mode>", "web, desktop, or ios"))
  .option("--branch <branch>", "branch to publish")
  .option("--ttl <duration>", "time to live", "72h")
  .option("--worktree <path>", "borrow an existing clean worktree")
  .option("--packet <hint>", "optional packet lineage hint")
  .action(async (options: { mode?: string; branch?: string; ttl: string; worktree?: string; packet?: string }) =>
    execute("publish", async () => {
      const globals = program.opts<{ repo: string }>();
      return new NectarService().publish({
        repo: globals.repo,
        ttl: options.ttl,
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.branch === undefined ? {} : { branch: options.branch }),
        ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
        ...(options.packet === undefined ? {} : { packet: options.packet }),
      });
    }),
  );

program
  .command("ls")
  .description("list this machine's environments")
  .option("--mode <mode>")
  .option("--status <status>")
  .action(async (options: { mode?: string; status?: string }) =>
    execute("ls", async () => new NectarService().list(options)),
  );

program
  .command("show <env-or-ref>")
  .description("show a full environment record")
  .action(async (input: string) => execute("show", async () => new NectarService().show(input)));

program
  .command("open <env-or-ref>")
  .description("open a web environment, verified testpack, or ios simpack/stream")
  .option("--no-ax", "skip starting the desktop AX bridge")
  .action(async (input: string, options: { ax?: boolean }) =>
    execute("open", async () => new NectarService().open(input, { noAx: options.ax === false })),
  );

program
  .command("resolve <env-or-ref>")
  .description("resolve a Nectar ref to concrete consumables")
  .action(async (input: string) => execute("resolve", async () => new NectarService().resolve(input)));

program
  .command("touch <env-or-ref>")
  .description("reset an environment's TTL")
  .option("--ttl <duration>", "time to live", "72h")
  .action(async (input: string, options: { ttl: string }) =>
    execute("touch", async () => new NectarService().touch(input, options.ttl)),
  );

program
  .command("stop <env>")
  .description("stop serving and retain environment files")
  .action(async (input: string) => execute("stop", async () => new NectarService().stop(input)));

program
  .command("rm <env>")
  .description("stop and trash an environment")
  .option("--force", "confirm removal of a serving environment")
  .action(async (input: string, options: { force?: boolean }) =>
    execute("rm", async () => new NectarService().remove(input, options.force ?? false)),
  );

program
  .command("gc")
  .description("expire, cool, reap, and quota-prune environments")
  .option("--dry-run", "report without changing state")
  .action(async (options: { dryRun?: boolean }) =>
    execute("gc", async () => new NectarService().gc({ dryRun: options.dryRun ?? false })),
  );

program
  .command("doctor")
  .description("check local dependencies, serve entries, ports, and quotas")
  .option("--fix", "configure only the mechanical :8440 pack-store serve entry")
  .action(async (options: { fix?: boolean }) =>
    execute("doctor", async () => new NectarService().doctor({ fix: options.fix ?? false })),
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && (error.code === "commander.helpDisplayed" || error.code === "commander.version")) {
    process.exitCode = 0;
  } else {
    const nectarError =
      error instanceof NectarError
        ? error
        : new NectarError("E_NO_MODE", error instanceof Error ? error.message : String(error));
    if (jsonRequested) output(errorEnvelope(requestedCommand, nectarError), true);
    else process.stderr.write(`${nectarError.code}: ${nectarError.message}\n`);
    process.exitCode = 1;
  }
}
