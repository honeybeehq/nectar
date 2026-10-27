import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopProcessGroup } from "../src/commands.js";
import { PostgresProviders, redactedDeps } from "../src/deps.js";
import {
  chooseInstall,
  createDatabaseSql,
  dropDatabaseSql,
  findPgInstalls,
  pgIdentifier,
  quoteIdent,
  quoteLiteral,
  clusterMajors,
  clusterFiles,
} from "../src/pg-local.js";
import { loadRecipe } from "../src/recipe.js";
import { NectarService } from "../src/service.js";
import type { PostgresDepRecipe } from "../src/types.js";
import { fakeActiveOwner, fakeDocker, fakeExecutable, fakeTailscale, initGitRepo, tempDir } from "./helpers.js";

const services: Array<{ service: NectarService; envs: string[] }> = [];

afterEach(async () => {
  for (const item of services.splice(0)) {
    for (const env of item.envs) {
      const record = await item.service.store.maybeEnv(env).catch(() => undefined);
      if (record?.serve !== undefined) await stopProcessGroup(record.serve.pgid).catch(() => undefined);
    }
    for (const major of await clusterMajors(item.service.paths.root)) {
      const files = clusterFiles(item.service.paths.root, major);
      const pid = Number(await readFile(path.join(files.data, "postmaster.pid"), "utf8").catch(() => ""));
      if (pid > 1) await stopProcessGroup(pid).catch(() => undefined);
    }
    const config = await item.service.store.readConfig().catch(() => undefined);
    if (config?.pack_server_pgid !== undefined) await stopProcessGroup(config.pack_server_pgid).catch(() => undefined);
  }
  vi.unstubAllEnvs();
});

async function fakePg(directory: string, major: number, log: string, tools = ["initdb", "pg_ctl", "postgres", "psql"]): Promise<string> {
  const bindir = path.join(directory, `pg${major}`, "bin");
  await mkdir(bindir, { recursive: true });
  const dataArg = `D=""; prev=""; for arg in "$@"; do [ "$prev" = "-D" ] && D="$arg"; prev="$arg"; done`;
  const scripts: Record<string, string> = {
    postgres: `echo "postgres (PostgreSQL) ${major}.4"`,
    initdb: `${dataArg}\nmkdir -p "$D" && echo ${major} > "$D/PG_VERSION" && touch "$D/postgresql.conf"\necho "initdb ${major} $*" >> ${log}`,
    pg_ctl: `${dataArg}\ncase "$1" in\n  status) [ -f "$D/fake-running" ] ;;\n  start) ${process.execPath} -e 'const{spawn}=require("node:child_process");const{writeFileSync}=require("node:fs");const c=spawn("sleep",["300"],{detached:true,stdio:"ignore"});writeFileSync(process.argv[1]+"/postmaster.pid",String(c.pid));c.unref();' "$D"; touch "$D/fake-running"; echo "pg_ctl start ${major}" >> ${log} ;;\n  stop) kill "$(cat "$D/postmaster.pid")"; rm -f "$D/fake-running"; echo "pg_ctl stop ${major}" >> ${log} ;;\nesac`,
    psql: `port=""; prev=""; for arg in "$@"; do [ "$prev" = "-p" ] && port="$arg"; prev="$arg"; done\nsql=$(cat)\nprintf 'psql ${major} port=%s\\n%s\\n' "$port" "$sql" >> ${log}\ncase "$(cat ${log}.fail 2>/dev/null):$sql" in\n  1:*"CREATE ROLE"*) printf 'ERROR: boom as %s\\nLINE 3: %s\\n' "$PGPASSWORD" "$sql" >&2; exit 3 ;;\nesac`,
  };
  for (const tool of tools) await fakeExecutable(bindir, tool, scripts[tool] ?? "");
  return bindir;
}

async function harness(options: { dockerDown?: boolean } = {}): Promise<{ service: NectarService; state: string; log: string; bin18: string; bin16: string }> {
  const state = await tempDir("pg-state");
  const fakeDir = await tempDir("pg-bin");
  const log = path.join(fakeDir, "pg.log");
  await writeFile(log, "");
  const tailscale = await fakeTailscale(fakeDir);
  const docker = await fakeDocker(fakeDir);
  const trash = await fakeExecutable(fakeDir, "trash", `for target in "$@"; do mv "$target" "$target.trash.$$"; done`);
  const packServer = path.join(fakeDir, "pack-server.mjs");
  await writeFile(packServer, `import http from "node:http"; http.createServer((_q, r) => { r.writeHead(404); r.end(); }).listen(Number(process.argv[3]), "127.0.0.1");`);
  await writeFile(
    path.join(state, "nectar.json"),
    JSON.stringify({ upstream_port_start: 4900, upstream_port_end: 4949, pack_server_port: 4950, tailnet_port_start: 8970, tailnet_port_end: 8989 }),
  );
  const bin16 = await fakePg(fakeDir, 16, log);
  const bin18 = await fakePg(fakeDir, 18, log);
  vi.stubEnv("NECTAR_HOME", state);
  vi.stubEnv("NECTAR_TAILSCALE_BIN", tailscale.binary);
  vi.stubEnv("FAKE_TS_LOG", tailscale.log);
  vi.stubEnv("NECTAR_TRASH_BIN", trash);
  vi.stubEnv("NECTAR_PACK_SERVER_ENTRY", packServer);
  vi.stubEnv("NECTAR_DOCKER_BIN", docker.binary);
  vi.stubEnv("NECTAR_PG_BIN", `${bin18}${path.delimiter}${bin16}`);
  if (options.dockerDown !== false) vi.stubEnv("FAKE_DOCKER_DOWN", "1");
  const service = new NectarService(state);
  await fakeActiveOwner(fakeDir);
  services.push({ service, envs: [] });
  return { service, state, log, bin18, bin16 };
}

const app = `
import http from "node:http";
http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ url: process.env.DATABASE_URL ?? null, pgport: process.env.PGPORT ?? null, pgdatabase: process.env.PGDATABASE ?? null }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

async function localRepo(seedLog: string, dep = 'kind = "postgres:15"'): Promise<string> {
  return initGitRepo({
    "nectar.toml": `name = "shop"\n[web]\nserve = "node server.mjs"\n[deps.db]\n${dep}\n[scenarios.review]\nseed = "echo \\"$PGDATABASE\\" >> ${seedLog}"\n`,
    "server.mjs": app,
  });
}

async function body(url: string): Promise<{ url: string | null; pgport: string | null; pgdatabase: string | null }> {
  return (await fetch(url)).json() as Promise<{ url: string | null; pgport: string | null; pgdatabase: string | null }>;
}

const lines = async (log: string): Promise<string[]> => (await readFile(log, "utf8")).split("\n").filter(Boolean);
const count = async (log: string, pattern: RegExp): Promise<number> => (await lines(log)).filter((line) => pattern.test(line)).length;

describe("local postgres naming and quoting", () => {
  it("names one role and database per env and dep, unique and within 63 bytes", () => {
    expect(pgIdentifier("shop--main--web", "db")).toMatch(/^nectar_shop_main_web_db_[0-9a-f]{8}$/);
    expect(pgIdentifier("x--a", "web_db")).not.toBe(pgIdentifier("x--a-web", "db"));
    expect(pgIdentifier("shop--main--web", "a-b")).not.toBe(pgIdentifier("shop--main--web", "a_b"));
    const long = pgIdentifier(`${"very-long-app-name".repeat(6)}--main--web`, "db");
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toMatch(/^nectar_[a-z0-9_]+_[0-9a-f]{8}$/);
    expect(pgIdentifier('evil"; DROP DATABASE postgres; --', "db")).toMatch(/^nectar_[a-z0-9_]+$/);
  });

  it("quotes identifiers and literals and refuses anything Nectar did not generate", () => {
    expect(quoteIdent("nectar_shop_db_0123abcd")).toBe('"nectar_shop_db_0123abcd"');
    for (const bad of ['nectar_x"; DROP ROLE nectar; --', "postgres", "nectar_", "NECTAR_X", `nectar_${"a".repeat(60)}`]) {
      expect(() => quoteIdent(bad)).toThrow("Refusing SQL identifier");
    }
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(() => quoteLiteral("a\0b")).toThrow("NUL");
    expect(() => createDatabaseSql("nectar_shop_db_0123abcd", "x'; DROP ROLE nectar; --")).toThrow("did not generate");
  });

  it("creates idempotently, revokes PUBLIC and drops with FORCE", () => {
    const name = "nectar_shop_db_0123abcd";
    expect(createDatabaseSql(name, "pw_0123456789abcdef")).toBe(
      [
        `SELECT 'CREATE ROLE "${name}" LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${name}')`,
        "\\gexec",
        `ALTER ROLE "${name}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'pw_0123456789abcdef';`,
        `SELECT 'CREATE DATABASE "${name}" OWNER "${name}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${name}')`,
        "\\gexec",
        `REVOKE ALL ON DATABASE "${name}" FROM PUBLIC;`,
        "",
      ].join("\n"),
    );
    expect(dropDatabaseSql(name)).toBe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE);\nDROP ROLE IF EXISTS "${name}";\n`);
  });
});

describe("local postgres discovery and provider selection", () => {
  it("finds complete bin dirs, newest first, and skips incomplete or too-old ones", async () => {
    const dir = await tempDir("pg-find");
    const log = path.join(dir, "pg.log");
    const bin16 = await fakePg(dir, 16, log);
    const bin18 = await fakePg(dir, 18, log);
    const bin12 = await fakePg(dir, 12, log);
    const broken = await fakePg(dir, 17, log, ["initdb", "pg_ctl", "postgres"]);
    const installs = await findPgInstalls({ PATH: process.env.PATH, NECTAR_PG_BIN: [bin16, broken, bin12, bin18, bin16].join(path.delimiter) });
    expect(installs).toEqual([
      { major: 18, version: "18.4", bindir: bin18 },
      { major: 16, version: "16.4", bindir: bin16 },
    ]);
  });

  it("honours the pinned major, else uses the newest with a warning, else refuses with both options", () => {
    const installs = [
      { major: 18, version: "18.4", bindir: "/b18" },
      { major: 16, version: "16.4", bindir: "/b16" },
    ];
    expect(chooseInstall(installs, "postgres:16", "[deps.db]")).toEqual({ install: installs[1] });
    expect(chooseInstall(installs, "postgres:16-alpine", "[deps.db]")).toEqual({ install: installs[1] });
    const fallback = chooseInstall(installs, "postgres:15", "[deps.db]");
    expect(fallback.install).toBe(installs[0]);
    expect(fallback.warning).toContain("pins postgres:15, but this host has no local Postgres 15; using local Postgres 18.4 from /b18");
    expect(() => chooseInstall([], "postgres:16", "[deps.db]")).toThrow("no local Postgres 13+ binaries");
  });

  it("picks docker when reachable, local otherwise, honours an explicit provider and keeps a recorded one", async () => {
    const { bin16 } = await harness({ dockerDown: false });
    const db: PostgresDepRecipe = { kind: "postgres", image: "postgres:16", env: "DATABASE_URL", database: "app", user: "nectar" };
    expect(await new PostgresProviders().choose("db", db)).toEqual({ provider: "docker" });
    expect(await new PostgresProviders().choose("db", { ...db, provider: "local" })).toEqual({ provider: "local", install: { major: 16, version: "16.4", bindir: bin16 } });
    const recorded = { kind: "postgres" as const, env: "DATABASE_URL", created_at: "", provider: "local" as const, major: 18 };
    expect((await new PostgresProviders().choose("db", db, recorded)).install?.major).toBe(18);
    await expect(new PostgresProviders().choose("db", { ...db, provider: "docker" }, recorded)).rejects.toThrow('created with provider "local"; republish with --fresh');
    vi.stubEnv("FAKE_DOCKER_DOWN", "1");
    expect((await new PostgresProviders().choose("db", db)).provider).toBe("local");
    await expect(new PostgresProviders().choose("db", { ...db, provider: "docker" })).rejects.toMatchObject({ code: "E_PLATFORM" });
    vi.stubEnv("NECTAR_PG_BIN", path.join(bin16, "missing"));
    const neither = new PostgresProviders().choose("db", db);
    await expect(neither).rejects.toMatchObject({ code: "E_PLATFORM", details: { hint: expect.stringMatching(/docker group.*Postgres\.app.*never installs Postgres/s) as string } });
    await expect(neither).rejects.toThrow("has neither");
    await expect(new PostgresProviders().choose("db", db, recorded)).rejects.toThrow("no Postgres 18 binaries are found");
  });

  it("parses provider and rejects unknown ones", async () => {
    const repo = await tempDir("pg-recipe");
    await writeFile(path.join(repo, "nectar.toml"), `[web]\nserve = "x"\n[deps.db]\nkind = "postgres:16"\nprovider = "local"\n`);
    expect((await loadRecipe(repo)).deps).toEqual({ db: { kind: "postgres", image: "postgres:16", env: "DATABASE_URL", database: "app", user: "nectar", provider: "local" } });
    await writeFile(path.join(repo, "nectar.toml"), `[web]\nserve = "x"\n[deps.db]\nkind = "postgres:16"\nprovider = "podman"\n`);
    await expect(loadRecipe(repo)).rejects.toThrow('must be "docker" or "local"');
  });

  it("doctor names the provider this host would use", async () => {
    const { service } = await harness();
    const report = (await service.doctor()) as unknown as { checks: Array<{ name: string; status: string; provider?: string | null; message: string }> };
    expect(report.checks.find((check) => check.name === "postgres-provider")).toMatchObject({ status: "pass", provider: "local", message: expect.stringContaining("local Postgres 18.4 cluster") as string });
    vi.stubEnv("NECTAR_PG_BIN", path.join(service.paths.root, "missing"));
    const none = (await service.doctor()) as unknown as { checks: Array<{ name: string; status: string; provider?: string | null }> };
    expect(none.checks.find((check) => check.name === "postgres-provider")).toMatchObject({ status: "warn", provider: null });
  });
});

describe("[deps] lifecycle with fake local postgres tools", () => {
  it("creates one database and role per env, keeps them on republish, recreates on --fresh, drops on rm and stops the idle cluster", async () => {
    const { service, state, log } = await harness();
    const seeds = path.join(await tempDir("pg-seeds"), "seeds.log");
    const repo = await localRepo(seeds);

    const first = await service.publish({ repo, ttl: "1h" });
    const env = first.env as string;
    services[0]?.envs.push(env);
    const identifier = pgIdentifier(env, "db");
    const firstBody = await body((first.urls as { local: string }).local);
    expect(firstBody.url).toMatch(new RegExp(`^postgresql://${identifier}:[A-Za-z0-9_-]{24}@127\\.0\\.0\\.1:49\\d\\d/${identifier}$`));
    expect(firstBody.pgdatabase).toBe(identifier);
    expect(first.warnings).toEqual(expect.arrayContaining([expect.stringContaining("[deps.db] pins postgres:15, but this host has no local Postgres 15; using local Postgres 18.4") as string]));
    expect(first.deps).toMatchObject({ db: { provider: "local", major: 18, database: identifier, user: identifier, url: expect.stringContaining(":***@") as string } });
    const password = decodeURIComponent(new URL(firstBody.url ?? "").password);
    expect(JSON.stringify(await service.show(env))).not.toContain(password);
    expect(await readFile(service.store.envFile(env), "utf8")).not.toContain(password);
    expect(await readFile(seeds, "utf8")).toBe(`${identifier}\n`);
    expect(await count(log, /^initdb 18 -D .* -U nectar --pwfile=.*superuser\.password -A scram-sha-256/)).toBe(1);
    expect(await count(log, /^pg_ctl start 18$/)).toBe(1);
    const cluster = path.join(state, "pg", "18");
    expect((await stat(path.join(cluster, "superuser.password"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(cluster, "data", "pg_hba.conf"), "utf8")).toBe("host all all 127.0.0.1/32 scram-sha-256\n");
    expect(await readFile(path.join(cluster, "data", "nectar.conf"), "utf8")).toContain(`listen_addresses = '127.0.0.1'\nport = ${firstBody.pgport}\nunix_socket_directories = ''`);
    expect(await readFile(path.join(cluster, "data", "postgresql.conf"), "utf8")).toContain("include = 'nectar.conf'");
    expect(await readFile(log, "utf8")).toContain(`CREATE DATABASE "${identifier}" OWNER "${identifier}"`);

    const republished = await service.publish({ repo, ttl: "1h" });
    expect((await body((republished.urls as { local: string }).local)).url).toBe(firstBody.url);
    expect(await count(log, /^DROP DATABASE/)).toBe(0);
    expect(await count(log, /^initdb/)).toBe(1);
    expect(await readFile(seeds, "utf8")).toBe(`${identifier}\n`);

    const fresh = await service.publish({ repo, ttl: "1h", fresh: true });
    const freshBody = await body((fresh.urls as { local: string }).local);
    expect(freshBody.url).not.toBe(firstBody.url);
    expect(freshBody.pgport).toBe(firstBody.pgport);
    expect(await readFile(log, "utf8")).toContain(`DROP DATABASE IF EXISTS "${identifier}" WITH (FORCE);\nDROP ROLE IF EXISTS "${identifier}";`);
    expect(await readFile(seeds, "utf8")).toBe(`${identifier}\n${identifier}\n`);

    const twin = await service.publish({ repo, ttl: "1h", name: "shop-two" });
    services[0]?.envs.push(twin.env as string);
    const twinBody = await body((twin.urls as { local: string }).local);
    expect(twinBody.pgport).toBe(firstBody.pgport);
    expect(twinBody.pgdatabase).toBe(pgIdentifier(twin.env as string, "db"));
    expect(twinBody.pgdatabase).not.toBe(identifier);

    await service.remove(env, true);
    expect(await count(log, new RegExp(`^DROP DATABASE IF EXISTS "${identifier}"`))).toBe(2);
    expect(await count(log, /^pg_ctl stop/)).toBe(0);
    await service.remove(twin.env as string, true);
    expect(await count(log, new RegExp(`^DROP ROLE IF EXISTS "${pgIdentifier(twin.env as string, "db")}"`))).toBe(1);
    expect(await count(log, /^pg_ctl stop 18$/)).toBe(1);
    expect(existsSync(path.join(cluster, "data", "fake-running"))).toBe(false);
    expect(existsSync(path.join(state, "work", `${env}.deps`))).toBe(false);
  });

  it("keeps the database on gc expire and drops it on gc cold", async () => {
    const { service, log } = await harness();
    const repo = await localRepo(path.join(await tempDir("pg-seeds"), "seeds.log"));
    const published = await service.publish({ repo, ttl: "1h" });
    const env = published.env as string;
    services[0]?.envs.push(env);
    await service.store.updateEnv(env, (record) => {
      record.expires_at = new Date(Date.now() - 60_000).toISOString();
    });
    expect((await service.gc()).transitions).toEqual([{ env, action: "expire" }]);
    expect(await count(log, /^DROP/)).toBe(0);
    expect((await service.store.readEnv(env)).deps?.db).toMatchObject({ provider: "local" });
    await service.store.updateEnv(env, (record) => {
      record.expires_at = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    });
    expect((await service.gc()).transitions).toEqual([{ env, action: "cold" }]);
    expect(await count(log, new RegExp(`^DROP DATABASE IF EXISTS "${pgIdentifier(env, "db")}"`))).toBe(1);
    expect(await count(log, /^pg_ctl stop 18$/)).toBe(1);
    expect((await service.store.readEnv(env)).deps).toBeUndefined();
  });

  it("starts the cluster before nectard revives the app", async () => {
    const { service, state, log } = await harness();
    const repo = await localRepo(path.join(await tempDir("pg-seeds"), "seeds.log"));
    const published = await service.publish({ repo, ttl: "1h" });
    const env = published.env as string;
    services[0]?.envs.push(env);
    const serve = (await service.store.readEnv(env)).serve;
    if (serve === undefined) throw new Error("published env has no serve");
    process.kill(-serve.pgid, "SIGKILL");
    await rm(path.join(state, "pg", "18", "data", "fake-running"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await service.revive(env, { expectPid: serve.pid, kill: false })).toMatchObject({ revived: true });
    const tail = (await lines(log)).slice(-12).join("\n");
    expect(tail).toContain("pg_ctl start 18");
    expect(tail).toContain(`ALTER ROLE "${pgIdentifier(env, "db")}"`);
    expect((await body((await service.store.readEnv(env)).urls.local ?? "")).pgdatabase).toBe(pgIdentifier(env, "db"));
    await service.remove(env, true);
  });

  it("fails E_DEPS with passwords redacted, drops what it created and leaves no deps record", async () => {
    const { service, state, log } = await harness();
    const repo = await localRepo(path.join(await tempDir("pg-seeds"), "seeds.log"), 'kind = "postgres:18"\nprovider = "local"');
    await writeFile(`${log}.fail`, "1");
    const error = (await service.publish({ repo, ttl: "1h" }).catch((caught: unknown) => caught)) as { code: string; details: { log_tail: string[] } };
    expect(error.code).toBe("E_DEPS");
    const tail = error.details.log_tail.join("\n");
    const superuser = (await readFile(path.join(state, "pg", "18", "superuser.password"), "utf8")).trim();
    expect(tail).toContain("PASSWORD '***'");
    expect(tail).toContain("boom as ***");
    expect(tail).not.toContain(superuser);
    expect(tail).not.toMatch(/PASSWORD '[A-Za-z0-9_-]{8,}'/);
    expect(await count(log, new RegExp(`^DROP DATABASE IF EXISTS "${pgIdentifier("shop--main--web", "db")}"`))).toBe(1);
    expect((await service.store.maybeEnv("shop--main--web"))?.deps).toBeUndefined();
  });

  it("moves a dep whose major's binaries are gone to another major with --fresh, warning about the old database", async () => {
    const { service, bin16, bin18 } = await harness();
    const repo = await localRepo(path.join(await tempDir("pg-seeds"), "seeds.log"), 'kind = "postgres:16"');
    const first = await service.publish({ repo, ttl: "1h" });
    const env = first.env as string;
    services[0]?.envs.push(env);
    expect(first.deps).toMatchObject({ db: { major: 16 } });
    vi.stubEnv("NECTAR_PG_BIN", bin18);
    await expect(service.publish({ repo, ttl: "1h" })).rejects.toThrow("no Postgres 16 binaries are found");
    const fresh = await service.publish({ repo, ttl: "1h", fresh: true });
    expect(fresh.deps).toMatchObject({ db: { major: 18 } });
    expect(fresh.warnings).toEqual(expect.arrayContaining([expect.stringContaining(`could not drop ${pgIdentifier(env, "db")}: no local Postgres 16 binaries`) as string]));
    vi.stubEnv("NECTAR_PG_BIN", `${bin18}${path.delimiter}${bin16}`);
    await service.remove(env, true);
  });

  it("refuses, and never wipes, a cluster whose superuser password file is gone", async () => {
    const { service, state, log } = await harness();
    const repo = await localRepo(path.join(await tempDir("pg-seeds"), "seeds.log"));
    const first = await service.publish({ repo, ttl: "1h" });
    services[0]?.envs.push(first.env as string);
    const cluster = path.join(state, "pg", "18");
    await writeFile(path.join(cluster, "data", "user-data"), "precious");
    await rm(path.join(cluster, "superuser.password"));
    await rm(path.join(cluster, "data", "fake-running"));
    await expect(service.publish({ repo, ttl: "1h", name: "shop-two" })).rejects.toMatchObject({ code: "E_DEPS", message: expect.stringContaining("has data but no") as string });
    expect(await readFile(path.join(cluster, "data", "user-data"), "utf8")).toBe("precious");
    expect(await count(log, /^initdb/)).toBe(1);
  });

  it("stops a cluster it started for a first publish that failed", async () => {
    const { service, log } = await harness();
    await writeFile(`${log}.fail`, "1");
    const repo = await localRepo(path.join(await tempDir("pg-seeds"), "seeds.log"));
    await expect(service.publish({ repo, ttl: "1h" })).rejects.toMatchObject({ code: "E_DEPS" });
    expect(await count(log, /^pg_ctl start 18$/)).toBe(1);
    expect(await count(log, /^pg_ctl stop 18$/)).toBe(1);
  });

  it("redacts a local dep's password in show output", () => {
    const deps = redactedDeps({
      db: { kind: "postgres", env: "DATABASE_URL", provider: "local", major: 18, port: 4900, database: "nectar_a_b_0123abcd", user: "nectar_a_b_0123abcd", created_at: "" },
    });
    expect(deps?.db?.url).toBe("postgresql://nectar_a_b_0123abcd:***@127.0.0.1:4900/nectar_a_b_0123abcd");
  });
});
