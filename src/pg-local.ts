import crypto from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { runCommand, readProcessIdentity, ownershipRefusal, type ProcessIdentity, type CommandResult } from "./commands.js";
import { NectarError } from "./errors.js";
import { portAvailable } from "./ports.js";

export const PG_SUPERUSER = "nectar";
export const MIN_LOCAL_MAJOR = 13;
export const PG_TOOLS = ["initdb", "pg_ctl", "postgres", "psql"] as const;

export const LOCAL_PG_HINT =
  "Either make Docker with Compose reachable for this user, or install Postgres binaries yourself (Postgres.app, Homebrew postgresql@<major>, or your distribution's postgresql package) so initdb, pg_ctl, postgres and psql are on PATH or in a standard location; NECTAR_PG_BIN names the bin directories to use. Nectar never installs Postgres";

const IDENTIFIER = /^nectar_[a-z0-9_]{1,56}$/;
const PASSWORD = /^[A-Za-z0-9_-]{16,128}$/;
const START_TIMEOUT_S = 60;

export interface PgInstall {
  major: number;
  version: string;
  bindir: string;
}

export function pgSearchPatterns(): string[] {
  return [
    "/opt/homebrew/opt/postgresql@*/bin",
    "/opt/homebrew/opt/postgresql/bin",
    "/usr/local/opt/postgresql@*/bin",
    "/usr/local/opt/postgresql/bin",
    "/Applications/Postgres.app/Contents/Versions/*/bin",
    "/usr/lib/postgresql/*/bin",
    "/usr/pgsql-*/bin",
  ];
}

async function expand(pattern: string): Promise<string[]> {
  const parts = pattern.split("/");
  const index = parts.findIndex((part) => part.includes("*"));
  if (index < 0) return [pattern];
  const parent = parts.slice(0, index).join("/") || "/";
  const [prefix = "", suffix = ""] = (parts[index] ?? "").split("*");
  const entries = await readdir(parent).catch(() => []);
  return entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix) && entry.length >= prefix.length + suffix.length)
    .map((entry) => [parent, entry, ...parts.slice(index + 1)].join("/").replace(/^\/\//, "/"));
}

async function executable(file: string): Promise<boolean> {
  return access(file, constants.X_OK).then(
    () => true,
    () => false,
  );
}

async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const file = path.join(directory, name);
    if (await executable(file)) return file;
  }
  return undefined;
}

export async function candidateBindirs(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const pinned = env.NECTAR_PG_BIN;
  if (pinned !== undefined && pinned !== "") return pinned.split(path.delimiter).filter(Boolean);
  const found: string[] = [];
  const initdb = await onPath("initdb", env);
  if (initdb !== undefined) found.push(path.dirname(await realpath(initdb).catch(() => initdb)));
  for (const pattern of pgSearchPatterns()) found.push(...(await expand(pattern)));
  return found;
}

export async function probeInstall(bindir: string, env: NodeJS.ProcessEnv = process.env): Promise<PgInstall | undefined> {
  for (const tool of PG_TOOLS) if (!(await executable(path.join(bindir, tool)))) return undefined;
  const result = await runCommand(path.join(bindir, "postgres"), ["--version"], { timeoutMs: 10_000, env: toolEnvironment(env) }).catch(() => undefined);
  const match = result?.exitCode === 0 ? /\(PostgreSQL\)\s+((\d+)[^\s]*)/.exec(result.stdout) : null;
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return { major: Number(match[2]), version: match[1], bindir };
}

export async function findPgInstalls(env: NodeJS.ProcessEnv = process.env): Promise<PgInstall[]> {
  const seen = new Set<string>();
  const installs: PgInstall[] = [];
  for (const candidate of await candidateBindirs(env)) {
    const real = await realpath(candidate).catch(() => undefined);
    if (real === undefined || seen.has(real)) continue;
    seen.add(real);
    const install = await probeInstall(candidate, env);
    if (install !== undefined && install.major >= MIN_LOCAL_MAJOR && !installs.some((item) => item.major === install.major)) installs.push(install);
  }
  return installs.sort((a, b) => b.major - a.major);
}

export function pinnedMajor(image: string): number | undefined {
  const major = Number.parseInt(image.slice(image.indexOf(":") + 1), 10);
  return Number.isFinite(major) ? major : undefined;
}

export function chooseInstall(installs: PgInstall[], image: string, label: string): { install: PgInstall; warning?: string } {
  const newest = installs[0];
  if (newest === undefined) {
    throw new NectarError("E_PLATFORM", `${label} postgres has no local Postgres ${MIN_LOCAL_MAJOR}+ binaries (initdb, pg_ctl, postgres, psql) on this host`, {
      hint: LOCAL_PG_HINT,
    });
  }
  const pin = pinnedMajor(image);
  const exact = installs.find((item) => item.major === pin);
  if (exact !== undefined) return { install: exact };
  return {
    install: newest,
    warning: `${label} pins ${image}, but this host has no local Postgres ${pin ?? "?"}; using local Postgres ${newest.version} from ${newest.bindir} (set provider = "docker" to require the pinned image)`,
  };
}

export function pgIdentifier(env: string, dep: string): string {
  const hash = crypto.createHash("sha256").update(`${env}\0${dep}`).digest("hex").slice(0, 8);
  const readable = `${env}_${dep}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 63 - "nectar_".length - 1 - hash.length)
    .replace(/^_+|_+$/g, "");
  return `nectar_${readable}_${hash}`;
}

export function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) throw new NectarError("E_INTERNAL", `Refusing SQL identifier '${name}'`);
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  if (value.includes("\0")) throw new NectarError("E_INTERNAL", "Refusing a SQL literal with a NUL byte");
  return `'${value.replaceAll("'", "''")}'`;
}

function assertPassword(password: string): void {
  if (!PASSWORD.test(password)) throw new NectarError("E_INTERNAL", "Refusing a database password that Nectar did not generate");
}

export function createDatabaseSql(name: string, password: string): string {
  const ident = quoteIdent(name);
  const literal = quoteLiteral(name);
  assertPassword(password);
  return [
    `SELECT ${quoteLiteral(`CREATE ROLE ${ident} LOGIN`)} WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal})`,
    "\\gexec",
    `ALTER ROLE ${ident} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${quoteLiteral(password)};`,
    `SELECT ${quoteLiteral(`CREATE DATABASE ${ident} OWNER ${ident}`)} WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = ${literal})`,
    "\\gexec",
    `REVOKE ALL ON DATABASE ${ident} FROM PUBLIC;`,
    "",
  ].join("\n");
}

export function dropDatabaseSql(name: string): string {
  const ident = quoteIdent(name);
  return [`DROP DATABASE IF EXISTS ${ident} WITH (FORCE);`, `DROP ROLE IF EXISTS ${ident};`, ""].join("\n");
}

export const HARDEN_SQL = ["REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;", "REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;", ""].join("\n");

export const PG_HBA = "host all all 127.0.0.1/32 scram-sha-256\n";

export function clusterConf(port: number): string {
  return [`listen_addresses = '127.0.0.1'`, `port = ${port}`, `unix_socket_directories = ''`, `password_encryption = 'scram-sha-256'`, `log_min_error_statement = panic`, ""].join("\n");
}

export interface ClusterFiles {
  dir: string;
  data: string;
  password: string;
  state: string;
  log: string;
}

export function clusterFiles(root: string, major: number): ClusterFiles {
  const dir = path.join(root, "pg", String(major));
  return {
    dir,
    data: path.join(dir, "data"),
    password: path.join(dir, "superuser.password"),
    state: path.join(dir, "cluster.json"),
    log: path.join(dir, "server.log"),
  };
}

export async function clusterMajors(root: string): Promise<number[]> {
  const entries = await readdir(path.join(root, "pg")).catch(() => []);
  return entries.filter((entry) => /^\d+$/.test(entry)).map(Number);
}

function toolEnvironment(env: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) if (env[key] !== undefined) result[key] = env[key];
  return { ...result, ...extra };
}

function tail(result: CommandResult): string[] {
  return [...result.stdout.split("\n"), ...result.stderr.split("\n")].filter(Boolean).slice(-40);
}

async function logTail(file: string): Promise<string[]> {
  return (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).slice(-40);
}

async function tool(install: PgInstall, name: (typeof PG_TOOLS)[number], args: string[], options: { input?: string; extra?: Record<string, string>; timeoutMs?: number } = {}): Promise<CommandResult> {
  return runCommand(path.join(install.bindir, name), args, {
    env: toolEnvironment(process.env, options.extra),
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
}

async function readState(files: ClusterFiles): Promise<{ port?: number; process?: ProcessIdentity }> {
  try {
    return JSON.parse(await readFile(files.state, "utf8")) as { port?: number; process?: ProcessIdentity };
  } catch {
    return {};
  }
}

async function writePrivate(file: string, text: string): Promise<void> {
  await writeFile(file, text, { mode: 0o600 });
}

export async function clusterRunning(root: string, install: PgInstall): Promise<boolean> {
  const files = clusterFiles(root, install.major);
  if (!existsSync(path.join(files.data, "PG_VERSION"))) return false;
  return (await tool(install, "pg_ctl", ["status", "-D", files.data], { timeoutMs: 30_000 })).exitCode === 0;
}

async function initCluster(files: ClusterFiles, install: PgInstall): Promise<void> {
  await mkdir(files.dir, { recursive: true, mode: 0o700 });
  await rm(files.data, { recursive: true, force: true });
  const password = crypto.randomBytes(24).toString("base64url");
  await writePrivate(files.password, `${password}\n`);
  const result = await tool(install, "initdb", ["-D", files.data, "-U", PG_SUPERUSER, `--pwfile=${files.password}`, "-A", "scram-sha-256", "-E", "UTF8", "--no-locale"]);
  if (result.exitCode !== 0) {
    throw new NectarError("E_DEPS", `initdb for the local Postgres ${install.major} cluster at ${files.data} failed`, { log_tail: tail(result) });
  }
  await writePrivate(path.join(files.data, "pg_hba.conf"), PG_HBA);
  await appendFile(path.join(files.data, "postgresql.conf"), "\ninclude = 'nectar.conf'\n");
}

export interface EnsureOptions {
  referenced: boolean;
  lockPorts: <T>(action: (allocate: () => Promise<number>) => Promise<T>) => Promise<T>;
}

export async function ensureCluster(root: string, install: PgInstall, options: EnsureOptions): Promise<number> {
  const files = clusterFiles(root, install.major);
  if (!existsSync(path.join(files.data, "PG_VERSION"))) await initCluster(files, install);
  else if (!existsSync(files.password)) {
    throw new NectarError("E_DEPS", `The local Postgres ${install.major} cluster at ${files.data} has data but no ${files.password}; Nectar will not touch it`, {
      hint: `Restore the file, or set a new password for the superuser "${PG_SUPERUSER}" yourself (for example with postgres --single) and write it there with mode 0600. Removing ${files.dir} yourself drops every env database in it`,
    });
  }
  const state = await readState(files);
  if (state.port !== undefined && (await clusterRunning(root, install))) return state.port;
  const port = await options.lockPorts(async (allocate) => {
    let chosen = state.port;
    if (chosen === undefined || !(await portAvailable(chosen))) {
      if (chosen !== undefined && options.referenced) {
        throw new NectarError("E_DEPS", `Port ${chosen} of the local Postgres ${install.major} cluster is held by a process Nectar did not start; free it and retry`);
      }
      chosen = await allocate();
    }
    await writePrivate(path.join(files.data, "nectar.conf"), clusterConf(chosen));
    await writePrivate(files.state, `${JSON.stringify({ port: chosen, bindir: install.bindir, version: install.version }, null, 2)}\n`);
    const result = await tool(install, "pg_ctl", ["start", "-D", files.data, "-l", files.log, "-w", "-t", String(START_TIMEOUT_S)], {
      timeoutMs: (START_TIMEOUT_S + 30) * 1_000,
    });
    if (result.exitCode !== 0) {
      throw new NectarError("E_DEPS", `The local Postgres ${install.major} cluster at ${files.data} did not start within ${START_TIMEOUT_S}s`, {
        log_tail: [...tail(result), ...(await logTail(files.log))].slice(-40),
      });
    }
    const pid = Number((await readFile(path.join(files.data, "postmaster.pid"), "utf8").catch(() => "")).split("\n")[0]);
    const identity = readProcessIdentity(pid);
    await writePrivate(files.state, `${JSON.stringify({ port: chosen, bindir: install.bindir, version: install.version, ...(identity === undefined ? {} : { process: { pid, ...identity } }) }, null, 2)}\n`);
    return chosen;
  });
  await superuserSql(root, install, port, HARDEN_SQL);
  return port;
}

export async function stopCluster(root: string, install: PgInstall): Promise<boolean> {
  if (!(await clusterRunning(root, install))) return false;
  const files = clusterFiles(root, install.major);
  const state = await readState(files);
  const currentPid = Number((await readFile(path.join(files.data, "postmaster.pid"), "utf8").catch(() => "")).split("\n")[0]);
  const refusal = state.process !== undefined && currentPid !== state.process.pid ? "process PID differs from record; left alone" : state.process === undefined ? "record has no process start time; left alone" : ownershipRefusal(state.process);
  if (refusal !== undefined) throw new NectarError("E_BUSY", `Local Postgres ownership unknown: ${refusal}`);
  const result = await tool(install, "pg_ctl", ["stop", "-D", files.data, "-m", "fast", "-w", "-t", String(START_TIMEOUT_S)]);
  if (result.exitCode !== 0) throw new NectarError("E_DEPS", `Could not stop the local Postgres ${install.major} cluster at ${files.data}`, { log_tail: tail(result) });
  return true;
}

export async function superuserSql(root: string, install: PgInstall, port: number, sql: string, secrets: string[] = []): Promise<string> {
  const files = clusterFiles(root, install.major);
  const password = (await readFile(files.password, "utf8")).trim();
  const result = await tool(
    install,
    "psql",
    ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(port), "-U", PG_SUPERUSER, "-d", "postgres"],
    { input: sql, extra: { PGPASSWORD: password, PGCONNECT_TIMEOUT: "10" } },
  );
  if (result.exitCode !== 0) {
    const redact = (line: string): string => [password, ...secrets].reduce((text, secret) => text.replaceAll(secret, "***"), line);
    throw new NectarError("E_DEPS", `psql against the local Postgres ${install.major} cluster on port ${port} failed`, { log_tail: tail(result).map(redact) });
  }
  return result.stdout;
}
