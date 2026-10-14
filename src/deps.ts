import crypto from "node:crypto";
import path from "node:path";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { runCommand, type CommandResult } from "./commands.js";
import { NectarError } from "./errors.js";
import { chooseInstall, findPgInstalls, LOCAL_PG_HINT, MIN_LOCAL_MAJOR, type PgInstall } from "./pg-local.js";
import type { DepRecord, PostgresDepRecipe, PostgresProvider } from "./types.js";

export const ENV_LABEL = "dev.nectar.env";
export const HOME_LABEL = "dev.nectar.home";
export const DEP_LABEL = "dev.nectar.dep";

export const DOCKER_HINT =
  "Nectar needs this user to reach Docker on the host: membership in the docker group (root-equivalent) or rootless Docker with DOCKER_HOST set. Nectar never changes Docker access itself";

const UP_TIMEOUT_S = 180;

export function dockerBinary(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env.NECTAR_DOCKER_BIN;
  return pinned !== undefined && pinned !== "" ? pinned : "docker";
}

export function composeProject(env: string): string {
  return `nectar-${env}`;
}

export function depsDir(work: string, env: string): string {
  return path.join(work, `${env}.deps`);
}

export function composeFile(work: string, env: string): string {
  return path.join(depsDir(work, env), "compose.json");
}

export function nectarLabels(env: string, home: string, dep?: string): Record<string, string> {
  return { [ENV_LABEL]: env, [HOME_LABEL]: home, ...(dep === undefined ? {} : { [DEP_LABEL]: dep }) };
}

export function postgresDataMount(image: string): string {
  const major = Number.parseInt(image.slice(image.indexOf(":") + 1), 10);
  return Number.isFinite(major) && major < 18 ? "/var/lib/postgresql/data" : "/var/lib/postgresql";
}

export interface PostgresService {
  recipe: PostgresDepRecipe;
  port: number;
  password: string;
}

export function composeSpec(env: string, home: string, services: Record<string, PostgresService>): Record<string, unknown> {
  const spec: { name: string; services: Record<string, unknown>; volumes: Record<string, unknown>; networks: Record<string, unknown> } = {
    name: composeProject(env),
    services: {},
    volumes: {},
    networks: { default: { labels: nectarLabels(env, home) } },
  };
  for (const [name, service] of Object.entries(services)) {
    const { recipe } = service;
    const volume = `${name}-data`;
    spec.services[name] = {
      image: recipe.image,
      labels: nectarLabels(env, home, name),
      environment: {
        POSTGRES_DB: recipe.database,
        POSTGRES_USER: recipe.user,
        POSTGRES_PASSWORD: service.password,
      },
      ports: [`127.0.0.1:${service.port}:5432`],
      volumes: [`${volume}:${postgresDataMount(recipe.image)}`],
      healthcheck: {
        test: ["CMD-SHELL", `pg_isready -h 127.0.0.1 -U ${recipe.user} -d ${recipe.database}`],
        interval: "1s",
        timeout: "3s",
        retries: 120,
      },
    };
    spec.volumes[volume] = { labels: nectarLabels(env, home, name) };
  }
  return spec;
}

export function postgresServices(deps: Record<string, DepRecord> | undefined, secrets: Record<string, string>): Record<string, PostgresService> {
  const services: Record<string, PostgresService> = {};
  for (const [name, dep] of Object.entries(deps ?? {})) {
    if (dep.kind !== "postgres" || dep.provider === "local" || dep.port === undefined) continue;
    services[name] = {
      recipe: { kind: "postgres", image: dep.image ?? "", env: dep.env, database: dep.database ?? "", user: dep.user ?? "" },
      port: dep.port,
      password: secrets[name] ?? "",
    };
  }
  return services;
}

export function newPassword(): string {
  return crypto.randomBytes(18).toString("base64url");
}

function postgresUrl(dep: DepRecord, password: string): string {
  return `postgresql://${dep.user ?? ""}:${encodeURIComponent(password)}@127.0.0.1:${dep.port ?? 0}/${dep.database ?? ""}`;
}

export function depEnvironment(deps: Record<string, DepRecord> | undefined, secrets: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const postgres = Object.entries(deps ?? {}).filter(([, dep]) => dep.kind === "postgres");
  for (const [name, dep] of Object.entries(deps ?? {})) {
    if (dep.kind === "postgres") env[dep.env] = postgresUrl(dep, secrets[name] ?? "");
    else if (dep.file !== undefined) env[dep.env] = dep.file;
  }
  const only = postgres.length === 1 ? postgres[0] : undefined;
  if (only !== undefined) {
    const [name, dep] = only;
    Object.assign(env, {
      PGHOST: "127.0.0.1",
      PGPORT: String(dep.port ?? ""),
      PGUSER: dep.user ?? "",
      PGPASSWORD: secrets[name] ?? "",
      PGDATABASE: dep.database ?? "",
    });
  }
  return env;
}

export function redactedDeps(deps: Record<string, DepRecord> | undefined): Record<string, DepRecord & { url?: string }> | null {
  if (deps === undefined || Object.keys(deps).length === 0) return null;
  return Object.fromEntries(
    Object.entries(deps).map(([name, dep]) => [name, dep.kind === "postgres" ? { ...dep, url: postgresUrl(dep, "***") } : dep]),
  );
}

export async function readSecrets(directory: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path.join(directory, "secrets.json"), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

async function docker(args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return runCommand(dockerBinary(), args, { timeoutMs });
}

function missingBinary(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function tail(result: CommandResult): string[] {
  return [...result.stdout.split("\n"), ...result.stderr.split("\n")].filter(Boolean).slice(-40);
}

export interface DockerProbe {
  ok: boolean;
  binary: string;
  message: string;
  version?: string;
}

export async function probeDocker(): Promise<DockerProbe> {
  const binary = dockerBinary();
  let server: CommandResult;
  try {
    server = await docker(["version", "--format", "{{.Server.Version}}"], 10_000);
  } catch (error) {
    if (missingBinary(error)) return { ok: false, binary, message: `Docker is not installed here (no '${binary}' on PATH or in NECTAR_DOCKER_BIN)` };
    return { ok: false, binary, message: `Could not run ${binary}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (server.exitCode !== 0) {
    const reason = (server.stderr.trim() || server.stdout.trim()).split("\n").at(-1) ?? "";
    return { ok: false, binary, message: `${binary} cannot reach the Docker daemon as ${process.env.USER ?? "this user"}: ${reason}` };
  }
  const compose = await docker(["compose", "version"], 10_000).catch(() => undefined);
  if (compose?.exitCode !== 0) return { ok: false, binary, message: `${binary} has no Compose v2 plugin ('${binary} compose version' failed)` };
  const version = server.stdout.trim();
  return { ok: true, binary, version, message: `Docker ${version} with Compose is reachable via ${binary}` };
}

function dockerUnreachable(probe: DockerProbe): NectarError {
  return new NectarError("E_PLATFORM", `[deps] postgres needs Docker with Compose: ${probe.message}`, { hint: DOCKER_HINT });
}

export async function assertDocker(): Promise<void> {
  const probe = await probeDocker();
  if (!probe.ok) throw dockerUnreachable(probe);
}

export function usesLocalPostgres(dep: DepRecord): boolean {
  return dep.kind === "postgres" && dep.provider === "local";
}

export function usesDockerPostgres(dep: DepRecord): boolean {
  return dep.kind === "postgres" && dep.provider !== "local";
}

export interface PostgresChoice {
  provider: PostgresProvider;
  install?: PgInstall;
  warning?: string;
}

export class PostgresProviders {
  private docker: Promise<DockerProbe> | undefined;
  private installs: Promise<PgInstall[]> | undefined;

  dockerProbe(): Promise<DockerProbe> {
    this.docker ??= probeDocker();
    return this.docker;
  }

  localInstalls(): Promise<PgInstall[]> {
    this.installs ??= findPgInstalls();
    return this.installs;
  }

  async auto(): Promise<PostgresProvider | undefined> {
    if ((await this.dockerProbe()).ok) return "docker";
    return (await this.localInstalls()).length > 0 ? "local" : undefined;
  }

  async choose(name: string, recipe: PostgresDepRecipe, prior?: DepRecord): Promise<PostgresChoice> {
    const label = `[deps.${name}]`;
    const kept = prior?.kind === "postgres" ? (prior.provider ?? "docker") : undefined;
    if (recipe.provider !== undefined && kept !== undefined && recipe.provider !== kept) {
      throw new NectarError(
        "E_DEPS",
        `${label} was created with provider "${kept}"; republish with --fresh to move it to "${recipe.provider}", which drops its data`,
      );
    }
    const provider = recipe.provider ?? kept ?? (await this.auto());
    if (provider === undefined) {
      const docker = await this.dockerProbe();
      throw new NectarError(
        "E_PLATFORM",
        `[deps] postgres needs Docker with Compose or local Postgres ${MIN_LOCAL_MAJOR}+ binaries, and this host has neither: ${docker.message}; no initdb, pg_ctl, postgres and psql found`,
        { hint: `${DOCKER_HINT}. ${LOCAL_PG_HINT}` },
      );
    }
    if (provider === "docker") {
      const docker = await this.dockerProbe();
      if (!docker.ok) throw dockerUnreachable(docker);
      return { provider };
    }
    const installs = await this.localInstalls();
    if (prior?.provider === "local" && prior.major !== undefined) {
      const same = installs.find((install) => install.major === prior.major);
      if (same === undefined) {
        throw new NectarError(
          "E_PLATFORM",
          `${label} lives in the local Postgres ${prior.major} cluster, but no Postgres ${prior.major} binaries are found on this host now; restore them, or republish with --fresh to recreate it on another major`,
          { hint: LOCAL_PG_HINT },
        );
      }
      return { provider, install: same };
    }
    return { provider, ...chooseInstall(installs, recipe.image, label) };
  }
}

export async function assertProjectOwned(project: string, home: string): Promise<void> {
  const filter = ["--filter", `label=com.docker.compose.project=${project}`, "--format", `{{.Label "${HOME_LABEL}"}}`];
  const homes = [
    ...(await listed(["ps", "-a", ...filter])),
    ...(await listed(["volume", "ls", ...filter])),
    ...(await listed(["network", "ls", ...filter])),
  ];
  const foreign = homes.filter((owner) => owner !== home);
  if (foreign.length > 0) {
    throw new NectarError(
      "E_DEPS",
      `Compose project ${project} already holds containers or volumes that are not this Nectar home's (${[...new Set(foreign.map((owner) => owner || "no dev.nectar.home label"))].join(", ")}); Nectar leaves them alone. Publish with --name to use another project`,
    );
  }
}

export async function composeUp(file: string, project: string): Promise<void> {
  const result = await docker(
    ["compose", "-p", project, "-f", file, "up", "-d", "--wait", "--wait-timeout", String(UP_TIMEOUT_S)],
    (UP_TIMEOUT_S + 600) * 1_000,
  );
  if (result.exitCode !== 0) {
    throw new NectarError("E_DEPS", `docker compose up for ${project} failed or did not turn healthy within ${UP_TIMEOUT_S}s`, {
      log_tail: tail(result),
    });
  }
}

function labelFilters(env: string, home: string, dep?: string): string[] {
  return [
    "--filter",
    `label=${ENV_LABEL}=${env}`,
    "--filter",
    `label=${HOME_LABEL}=${home}`,
    ...(dep === undefined ? [] : ["--filter", `label=${DEP_LABEL}=${dep}`]),
  ];
}

async function listed(args: string[]): Promise<string[]> {
  const result = await docker(args);
  if (result.exitCode !== 0) throw new NectarError("E_DEPS", `${dockerBinary()} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function act(args: string[]): Promise<void> {
  const result = await docker(args, 120_000);
  if (result.exitCode !== 0) throw new NectarError("E_DEPS", `${dockerBinary()} ${args.join(" ")} failed: ${result.stderr.trim()}`);
}

export interface Labelled {
  containers: string[];
  volumes: string[];
  networks: string[];
}

export async function stopLabelled(env: string, home: string): Promise<string[]> {
  let running: string[];
  try {
    running = await listed(["ps", "-q", ...labelFilters(env, home)]);
  } catch (error) {
    if (missingBinary(error)) return [];
    throw error;
  }
  if (running.length > 0) await act(["stop", ...running]);
  return running;
}

export async function removeLabelled(env: string, home: string, deps?: string[]): Promise<Labelled> {
  if (deps !== undefined) {
    const removed: Labelled = { containers: [], volumes: [], networks: [] };
    for (const dep of deps) {
      const one = await removeMatching(labelFilters(env, home, dep), false);
      removed.containers.push(...one.containers);
      removed.volumes.push(...one.volumes);
    }
    return removed;
  }
  return removeMatching(labelFilters(env, home), true);
}

async function removeMatching(filters: string[], withNetworks: boolean): Promise<Labelled> {
  let containers: string[];
  try {
    containers = await listed(["ps", "-a", "-q", ...filters]);
  } catch (error) {
    if (!missingBinary(error)) throw error;
    throw new NectarError("E_PLATFORM", `No '${dockerBinary()}' binary to remove this env's labelled containers and volumes; set NECTAR_DOCKER_BIN or PATH and retry`, {
      hint: DOCKER_HINT,
    });
  }
  if (containers.length > 0) await act(["rm", "-f", "-v", ...containers]);
  const networks = withNetworks ? await listed(["network", "ls", "-q", ...filters]) : [];
  if (networks.length > 0) await act(["network", "rm", ...networks]);
  const volumes = (await listed(["volume", "ls", "-q", ...filters])).filter((name) => name.startsWith("nectar-"));
  if (volumes.length > 0) await act(["volume", "rm", ...volumes]);
  return { containers, volumes, networks };
}
