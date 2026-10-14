#!/usr/bin/env node
import { execFile } from "node:child_process";
import { adminRequest, loadConfig, startRelayd } from "./relayd.js";

const DEFAULT_CONFIG = "/etc/nectar-relayd.json";
const USAGE = `usage:
  nectar-relayd serve [--config <file>]
  nectar-relayd admin <command> [--config <file>]   (nectar-relay is this, on the relay)

admin commands:
  ls [--json]
  rm <sub>
  disable-all [--node <name-or-id>]
  enable-all [--node <name-or-id>]
  prune
  health [--json]
  add <sub> <upstream> <expires-epoch> [--domain <d>] [--password <p> | --password-hash <h> | --public]
`;

class UsageError extends Error {}

function take(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
  args.splice(at, 2);
  return value;
}

function has(args: string[], flag: string): boolean {
  const at = args.indexOf(flag);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
}

function caddyState(): Promise<string> {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-active", "caddy"], { timeout: 10_000 }, (_error, stdout) => resolve(stdout.trim() || "unknown"));
  });
}

function fail(body: Record<string, unknown>, status: number): never {
  const error = typeof body.error === "object" && body.error !== null ? (body.error as Record<string, unknown>) : {};
  throw new Error(`${typeof error.code === "string" ? error.code : `HTTP ${status}`}: ${typeof error.message === "string" ? error.message : "relayd refused"}`);
}

async function admin(args: string[], configFile: string): Promise<void> {
  const config = await loadConfig(configFile);
  const socket = config.admin_socket;
  const call = async (method: string, apiPath: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const reply = await adminRequest(socket, method, apiPath, body);
    if (reply.body.ok !== true) fail(reply.body, reply.status);
    return reply.body;
  };
  const command = args.shift();
  const json = has(args, "--json");
  const node = take(args, "--node");
  switch (command) {
    case "ls": {
      const body = await call("GET", "/admin/routes");
      if (json) {
        process.stdout.write(`${JSON.stringify(body.routes)}\n`);
        return;
      }
      for (const route of body.routes as Array<Record<string, unknown>>) {
        const owner = route.owner as { node_name: string; node_id: string };
        process.stdout.write(`${String(route.url).padEnd(48)} expires=${String(route.expires_at)} gate=${String(route.gate)} owner=${owner.node_name}(${owner.node_id}) upstream=${String(route.upstream)}\n`);
      }
      const kill = body.kill as { all: unknown; nodes: Record<string, { name: string }> };
      if (kill.all !== null) process.stdout.write("relay-wide kill flag is ON: new routes are refused (nectar-relay enable-all lifts it)\n");
      for (const [id, flag] of Object.entries(kill.nodes)) process.stdout.write(`kill flag ON for ${flag.name} (${id})\n`);
      return;
    }
    case "rm": {
      const sub = args.shift();
      if (sub === undefined) throw new UsageError("rm <sub>");
      await call("DELETE", `/admin/routes/${encodeURIComponent(sub)}`);
      process.stdout.write(`removed ${sub}\n`);
      return;
    }
    case "disable-all":
    case "enable-all": {
      const body = await call(command === "disable-all" ? "POST" : "DELETE", "/admin/kill", node === undefined ? {} : { node });
      const who = body.node === null ? "relay-wide" : `for ${(body.node as { name: string }).name}`;
      if (command === "disable-all") process.stdout.write(`disabled ${who}; removed ${(body.removed as string[]).length} route(s); new routes are refused until enable-all\n`);
      else process.stdout.write(`lifted the kill flag ${who}\n`);
      return;
    }
    case "prune": {
      const body = await call("POST", "/admin/prune");
      process.stdout.write(`pruned ${String(body.pruned)} expired route(s)\n`);
      return;
    }
    case "health": {
      const caddy = await caddyState();
      let body: Record<string, unknown>;
      try {
        body = await call("GET", "/admin/health");
      } catch (error) {
        if (json) process.stdout.write(`${JSON.stringify({ caddy, relayd: "down", routes: 0, domain: config.domain })}\n`);
        throw error;
      }
      const summary = { caddy, relayd: body.relayd, routes: body.routes, domain: body.domain, killed: body.killed, control: body.control, verify: body.verify };
      process.stdout.write(json ? `${JSON.stringify(summary)}\n` : `caddy=${caddy} relayd=${String(body.relayd)} routes=${String(body.routes)} domain=${String(body.domain)} control=${String(body.control)}\n`);
      if (caddy !== "active") process.exitCode = 1;
      return;
    }
    case "add": {
      const domain = take(args, "--domain");
      const password = take(args, "--password");
      const passwordHash = take(args, "--password-hash");
      const open = has(args, "--public");
      const [sub, upstream, expires] = args;
      if (sub === undefined || upstream === undefined || expires === undefined || !/^\d+$/.test(expires)) throw new UsageError("add <sub> <upstream> <expires-epoch> [--domain d] [--password p | --password-hash h | --public]");
      if (domain !== undefined && domain !== config.domain) throw new Error(`this relay serves ${config.domain}, not ${domain}`);
      if (!open && password === undefined && passwordHash === undefined) throw new Error("add: require --password, --password-hash or --public (gated by default)");
      const body = await call("POST", "/admin/routes", {
        sub,
        upstream,
        expires_at: Number(expires),
        gate: open ? "none" : "password",
        ...(password === undefined ? {} : { password }),
        ...(passwordHash === undefined ? {} : { password_hash: passwordHash }),
      });
      process.stdout.write(`${String(body.url)}\n`);
      return;
    }
    default:
      throw new UsageError(USAGE);
  }
}

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  const configFile = take(args, "--config") ?? process.env.NECTAR_RELAYD_CONFIG ?? DEFAULT_CONFIG;
  const mode = args.shift();
  if (mode === "serve") {
    const relayd = await startRelayd(configFile);
    const stop = (): void => {
      void relayd.close().finally(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    return;
  }
  if (mode === "admin") {
    await admin(args, configFile);
    return;
  }
  throw new UsageError(USAGE);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(error instanceof UsageError ? `${error.message}\n` : `nectar-relay: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
