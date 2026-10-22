import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand, stopProcessGroup } from "../src/commands.js";
import { composeSpec, depEnvironment, postgresDataMount, redactedDeps } from "../src/deps.js";
import { loadRecipe, seedScenario } from "../src/recipe.js";
import { NectarService } from "../src/service.js";
import type { PostgresDepRecipe } from "../src/types.js";
import { fakeActiveOwner, fakeDocker, fakeExecutable, fakeTailscale, initGitRepo, tempDir, type FakeDockerState } from "./helpers.js";

const services: Array<{ service: NectarService; envs: string[] }> = [];

afterEach(async () => {
  for (const item of services.splice(0)) {
    for (const env of item.envs) {
      const record = await item.service.store.maybeEnv(env).catch(() => undefined);
      if (record?.serve !== undefined) await stopProcessGroup(record.serve.pgid).catch(() => undefined);
    }
    const config = await item.service.store.readConfig().catch(() => undefined);
    if (config?.pack_server_pgid !== undefined) await stopProcessGroup(config.pack_server_pgid).catch(() => undefined);
  }
  vi.unstubAllEnvs();
});

const FOREIGN: FakeDockerState = {
  containers: [
    { id: "ci-runner", name: "github-runner-1", labels: { "com.docker.compose.project": "ci" }, running: true },
    { id: "other-home", name: "other-nectar-db", labels: { "dev.nectar.env": "shop--main--web", "dev.nectar.home": "/elsewhere" }, running: true },
  ],
  volumes: [
    { name: "ci_cache", labels: {} },
    { name: "nectar-elsewhere_db-data", labels: { "dev.nectar.env": "shop--main--web", "dev.nectar.home": "/elsewhere" } },
  ],
  networks: [{ id: "ci-net", name: "ci_default", labels: {} }],
};

async function harness(): Promise<{ service: NectarService; state: string; docker: Awaited<ReturnType<typeof fakeDocker>> }> {
  const state = await tempDir("deps-state");
  const fakeDir = await tempDir("deps-bin");
  const tailscale = await fakeTailscale(fakeDir);
  const docker = await fakeDocker(fakeDir, structuredClone(FOREIGN));
  const trash = await fakeExecutable(fakeDir, "trash", `for target in "$@"; do mv "$target" "$target.trash.$$"; done`);
  const packServer = path.join(fakeDir, "pack-server.mjs");
  await writeFile(packServer, `import http from "node:http"; http.createServer((_q, r) => { r.writeHead(404); r.end(); }).listen(Number(process.argv[3]), "127.0.0.1");`);
  await writeFile(
    path.join(state, "nectar.json"),
    JSON.stringify({ upstream_port_start: 4800, upstream_port_end: 4849, pack_server_port: 4850, tailnet_port_start: 8950, tailnet_port_end: 8969 }),
  );
  vi.stubEnv("NECTAR_HOME", state);
  vi.stubEnv("NECTAR_TAILSCALE_BIN", tailscale.binary);
  vi.stubEnv("FAKE_TS_LOG", tailscale.log);
  vi.stubEnv("NECTAR_TRASH_BIN", trash);
  vi.stubEnv("NECTAR_PACK_SERVER_ENTRY", packServer);
  vi.stubEnv("NECTAR_DOCKER_BIN", docker.binary);
  vi.stubEnv("NECTAR_PG_BIN", path.join(fakeDir, "no-local-postgres"));
  const service = new NectarService(state);
  await fakeActiveOwner(fakeDir);
  services.push({ service, envs: [] });
  return { service, state, docker };
}

function track(service: NectarService, ...envs: string[]): void {
  services.find((item) => item.service === service)?.envs.push(...envs);
}

const app = `
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  const file = process.env.DATABASE_PATH;
  response.end(JSON.stringify({
    url: process.env.DATABASE_URL ?? null,
    pgport: process.env.PGPORT ?? null,
    sqlite: file ?? null,
    sqliteBody: file && existsSync(file) ? readFileSync(file, "utf8") : null,
  }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

async function depsRepo(seedLog: string, extra = ""): Promise<string> {
  return initGitRepo({
    "nectar.toml": `name = "shop"
[web]
serve = "node server.mjs"
[deps.db]
kind = "postgres:16"
[scenarios.review]
seed = "echo \\"$NECTAR_SCENARIO $PGDATABASE\\" >> ${seedLog}"
${extra}`,
    "server.mjs": app,
  });
}

async function body(url: string): Promise<{ url: string | null; pgport: string | null; sqlite: string | null; sqliteBody: string | null }> {
  return (await fetch(url)).json() as Promise<{ url: string | null; pgport: string | null; sqlite: string | null; sqliteBody: string | null }>;
}

describe("[deps] recipe", () => {
  it("parses postgres with defaults and a version pin, sqlite, and a seed scenario", async () => {
    const repo = await tempDir("deps-recipe");
    await writeFile(
      path.join(repo, "nectar.toml"),
      `[web]\nserve = "x"\n[deps.db]\nkind = "postgres:16"\n[deps.cache]\nkind = "postgres"\nenv = "CACHE_URL"\ndatabase = "cache"\nuser = "svc"\n[deps.local]\nkind = "sqlite"\npath = "data/app.db"\n[scenarios.admin]\nseed = "pnpm seed"\ndefault = true\n`,
    );
    const recipe = await loadRecipe(repo);
    expect(recipe.deps).toEqual({
      db: { kind: "postgres", image: "postgres:16", env: "DATABASE_URL", database: "app", user: "nectar" },
      cache: { kind: "postgres", image: "postgres:17", env: "CACHE_URL", database: "cache", user: "svc" },
      local: { kind: "sqlite", path: "data/app.db", env: "DATABASE_PATH" },
    });
    expect(seedScenario(recipe)).toEqual({ name: "admin", seed: "pnpm seed" });
  });

  it.each([
    ['[deps.db]\nkind = "redis:7"', "not supported yet"],
    ['[deps]\ncompose = "x.yml"', "not implemented yet"],
    ['[deps.db]\nprovision = "x"', "provision/teardown"],
    ['[deps.db]\nkind = "postgres:16"\npasword = "x"', "Unknown key 'pasword'"],
    ['[deps.db]\nkind = "sqlite"\npath = "../outside.db"', "inside the repository"],
    ['[deps.a]\nkind = "postgres"\n[deps.b]\nkind = "postgres"', "Two [deps] entries inject DATABASE_URL"],
    ['[deps.db]\nkind = "postgres:16"\nuser = "Robert\'); DROP"', "must match"],
    ['[scenarios.a]\nseed = "x"\nentry = "/admin"', "entry is not implemented yet"],
  ])("rejects %s", async (toml, message) => {
    const repo = await tempDir("deps-recipe-bad");
    await writeFile(path.join(repo, "nectar.toml"), `[web]\nserve = "x"\n${toml}\n`);
    await expect(loadRecipe(repo)).rejects.toThrow(message);
  });
});

describe("compose generation", () => {
  const db: PostgresDepRecipe = { kind: "postgres", image: "postgres:16", env: "DATABASE_URL", database: "app", user: "nectar" };

  it("labels every container, volume and network and binds loopback only", () => {
    const spec = composeSpec("shop--main--web", "/home/u/.nectar", { db: { recipe: db, port: 4810, password: "pw" } });
    const labels = { "dev.nectar.env": "shop--main--web", "dev.nectar.home": "/home/u/.nectar" };
    expect(spec).toEqual({
      name: "nectar-shop--main--web",
      services: {
        db: {
          image: "postgres:16",
          labels: { ...labels, "dev.nectar.dep": "db" },
          environment: { POSTGRES_DB: "app", POSTGRES_USER: "nectar", POSTGRES_PASSWORD: "pw" },
          ports: ["127.0.0.1:4810:5432"],
          volumes: ["db-data:/var/lib/postgresql/data"],
          healthcheck: { test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U nectar -d app"], interval: "1s", timeout: "3s", retries: 120 },
        },
      },
      volumes: { "db-data": { labels: { ...labels, "dev.nectar.dep": "db" } } },
      networks: { default: { labels } },
    });
  });

  it("mounts the postgres 18+ data root and the classic data dir before 18", () => {
    expect(postgresDataMount("postgres:16-alpine")).toBe("/var/lib/postgresql/data");
    expect(postgresDataMount("postgres:18")).toBe("/var/lib/postgresql");
    expect(postgresDataMount("postgres:latest")).toBe("/var/lib/postgresql");
  });

  it("injects DATABASE_URL and PG* vars and redacts the password for show", () => {
    const deps = {
      db: { kind: "postgres" as const, env: "DATABASE_URL", image: "postgres:16", port: 4810, database: "app", user: "nectar", created_at: "t" },
      file: { kind: "sqlite" as const, env: "DATABASE_PATH", file: "/n/work/x.deps/file/app.db", created_at: "t" },
    };
    expect(depEnvironment(deps, { db: "s3cr/t" })).toEqual({
      DATABASE_URL: "postgresql://nectar:s3cr%2Ft@127.0.0.1:4810/app",
      DATABASE_PATH: "/n/work/x.deps/file/app.db",
      PGHOST: "127.0.0.1",
      PGPORT: "4810",
      PGUSER: "nectar",
      PGPASSWORD: "s3cr/t",
      PGDATABASE: "app",
    });
    expect(JSON.stringify(redactedDeps(deps))).not.toContain("s3cr");
    expect(redactedDeps(deps)?.db?.url).toBe("postgresql://nectar:***@127.0.0.1:4810/app");
  });
});

describe("[deps] lifecycle with a fake docker", () => {
  it("provisions per env, reuses on republish, recreates on --fresh, and tears down only its own labels", async () => {
    const { service, state, docker } = await harness();
    const seeds = path.join(await tempDir("deps-seeds"), "seeds.log");
    const repo = await depsRepo(seeds);

    const first = await service.publish({ repo, ttl: "1h" });
    const env = first.env as string;
    track(service, env);
    expect(env).toBe("shop--main--web");
    const firstBody = await body((first.urls as { local: string }).local);
    expect(firstBody.url).toMatch(/^postgresql:\/\/nectar:[^@*]+@127\.0\.0\.1:48\d\d\/app$/);
    expect(first.deps).toMatchObject({ db: { kind: "postgres", project: "nectar-shop--main--web", url: expect.stringContaining(":***@") as string } });
    const shown = await service.show(env);
    expect(JSON.stringify(shown)).not.toContain(firstBody.url?.split(":")[2]?.split("@")[0]);
    expect(shown.deps).toMatchObject({ db: { port: Number(firstBody.pgport), image: "postgres:16" } });
    expect(await readFile(seeds, "utf8")).toBe("review app\n");
    const secrets = path.join(state, "work", `${env}.deps`, "secrets.json");
    expect((await stat(secrets)).mode & 0o777).toBe(0o600);
    expect(await readFile(docker.log, "utf8")).toContain(`compose -p nectar-${env} -f ${path.join(state, "work", `${env}.deps`, "compose.json")} up -d --wait`);

    const republished = await service.publish({ repo, ttl: "1h" });
    expect((await body((republished.urls as { local: string }).local)).url).toBe(firstBody.url);
    expect(await readFile(seeds, "utf8")).toBe("review app\n");
    expect(await readFile(docker.log, "utf8")).not.toMatch(/^(rm|volume rm)/m);

    const fresh = await service.publish({ repo, ttl: "1h", fresh: true });
    const freshBody = await body((fresh.urls as { local: string }).local);
    expect(freshBody.pgport).toBe(firstBody.pgport);
    expect(freshBody.url).not.toBe(firstBody.url);
    expect(await readFile(seeds, "utf8")).toBe("review app\nreview app\n");
    expect(await readFile(docker.log, "utf8")).toMatch(/^volume rm nectar-shop--main--web_db-data$/m);

    const twin = await service.publish({ repo, ttl: "1h", name: "shop-two" });
    track(service, twin.env as string);
    const twinBody = await body((twin.urls as { local: string }).local);
    expect(twinBody.pgport).not.toBe(freshBody.pgport);
    expect((await docker.read()).containers.map((item) => item.name).sort()).toEqual([
      "github-runner-1",
      "nectar-shop--main--web-db-1",
      "nectar-shop-two--main--web-db-1",
      "other-nectar-db",
    ]);

    await service.remove(env, true);
    await service.remove(twin.env as string, true);
    expect(await docker.read()).toEqual(FOREIGN);
    expect(existsSync(path.join(state, "work", `${env}.deps`))).toBe(false);
  });

  it("stops containers on gc expire and removes them with their volume on gc cold", async () => {
    const { service, docker } = await harness();
    const repo = await depsRepo(path.join(await tempDir("deps-seeds"), "seeds.log"));
    const published = await service.publish({ repo, ttl: "1h" });
    const env = published.env as string;
    track(service, env);
    const ours = (state: FakeDockerState): Array<{ running: boolean }> =>
      state.containers.filter((item) => item.labels["dev.nectar.home"] === service.paths.root);

    await service.store.updateEnv(env, (record) => {
      record.expires_at = new Date(Date.now() - 60_000).toISOString();
    });
    expect((await service.gc()).transitions).toEqual([{ env, action: "expire" }]);
    expect(ours(await docker.read())).toEqual([expect.objectContaining({ running: false })]);
    expect((await docker.read()).containers.find((item) => item.id === "ci-runner")?.running).toBe(true);

    await service.store.updateEnv(env, (record) => {
      record.expires_at = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    });
    expect((await service.gc()).transitions).toEqual([{ env, action: "cold" }]);
    expect(await docker.read()).toEqual(FOREIGN);
    expect((await service.store.readEnv(env)).deps).toBeUndefined();

    const revived = await service.publish({ repo, ttl: "1h" });
    expect((await body((revived.urls as { local: string }).local)).url).toMatch(/^postgresql:/);
    await service.remove(env, true);
  });

  it("brings the dep up before nectard revives the app", async () => {
    const { service, docker } = await harness();
    const repo = await depsRepo(path.join(await tempDir("deps-seeds"), "seeds.log"));
    const published = await service.publish({ repo, ttl: "1h" });
    const env = published.env as string;
    track(service, env);
    const serve = (await service.store.readEnv(env)).serve;
    if (serve === undefined) throw new Error("published env has no serve");
    await service.stop(env);
    expect((await docker.read()).containers.filter((item) => item.name.startsWith("nectar-shop--main--web-db") && item.labels["dev.nectar.home"] === service.paths.root)).toEqual([
      expect.objectContaining({ running: false }),
    ]);
    await service.store.updateEnv(env, (record) => {
      record.status = "crashed";
      record.serve = serve;
    });
    const revived = await service.revive(env, { expectPid: serve.pid, kill: false });
    expect(revived).toMatchObject({ revived: true });
    const log = (await readFile(docker.log, "utf8")).trim().split("\n");
    expect(log.at(-1)).toMatch(/^compose -p nectar-shop--main--web .* up -d --wait/);
    expect((await body((await service.store.readEnv(env)).urls.local ?? "")).url).toMatch(/^postgresql:/);
    await service.remove(env, true);
  });

  it("fails fast with E_PLATFORM and no env when Docker is unreachable", async () => {
    const { service, docker } = await harness();
    vi.stubEnv("FAKE_DOCKER_DOWN", "1");
    const repo = await depsRepo(path.join(await tempDir("deps-seeds"), "seeds.log"));
    const failure = service.publish({ repo, ttl: "1h" });
    await expect(failure).rejects.toMatchObject({ code: "E_PLATFORM", details: { hint: expect.stringContaining("docker group") as string } });
    await expect(failure).rejects.toMatchObject({ details: { hint: expect.stringContaining("Postgres.app") as string } });
    await expect(failure).rejects.toThrow("permission denied");
    expect(await service.store.listEnvs()).toEqual([]);
    vi.stubEnv("NECTAR_DOCKER_BIN", path.join(path.dirname(docker.binary), "missing-docker"));
    await expect(service.publish({ repo, ttl: "1h" })).rejects.toThrow("Docker is not installed");
  });

  it("tears down a half-created database when compose up fails", async () => {
    const { service, docker } = await harness();
    vi.stubEnv("FAKE_DOCKER_UP_FAIL", "1");
    const repo = await depsRepo(path.join(await tempDir("deps-seeds"), "seeds.log"));
    await expect(service.publish({ repo, ttl: "1h" })).rejects.toMatchObject({ code: "E_DEPS" });
    expect((await service.store.readEnv("shop--main--web")).status).toBe("crashed");
    expect(await readFile(docker.log, "utf8")).toContain("ps -a -q --filter label=dev.nectar.env=shop--main--web");
    expect(await docker.read()).toEqual(FOREIGN);
  });

  it("keeps the existing database when adding a dep fails on republish", async () => {
    const { service, docker } = await harness();
    const repo = await depsRepo(path.join(await tempDir("deps-seeds"), "seeds.log"));
    const first = await service.publish({ repo, ttl: "1h" });
    const env = first.env as string;
    track(service, env);
    const before = await docker.read();
    await writeFile(path.join(repo, "nectar.toml"), `${await readFile(path.join(repo, "nectar.toml"), "utf8")}\n[deps.analytics]\nkind = "postgres:16"\nenv = "ANALYTICS_URL"\n`);
    await runCommand("git", ["commit", "-qam", "add analytics"], { cwd: repo });
    vi.stubEnv("FAKE_DOCKER_UP_FAIL", "1");
    await expect(service.publish({ repo, ttl: "1h" })).rejects.toMatchObject({ code: "E_DEPS", details: { still_serving: expect.any(String) as string } });
    expect((await docker.read()).volumes).toEqual(before.volumes);
    expect((await docker.read()).containers.map((item) => item.id)).toEqual(before.containers.map((item) => item.id));
    const record = await service.store.readEnv(env);
    expect(Object.keys(record.deps ?? {})).toEqual(["db"]);
    expect((await body(record.urls.local ?? "")).url).toBe((await body((first.urls as { local: string }).local)).url);
    const spec = path.join(service.paths.work, `${env}.deps`, "compose.json");
    expect(Object.keys((JSON.parse(await readFile(spec, "utf8")) as { services: object }).services)).toEqual(["db"]);
    vi.unstubAllEnvs();
    vi.stubEnv("NECTAR_DOCKER_BIN", docker.binary);
    vi.stubEnv("NECTAR_HOME", service.paths.root);
    if (record.serve === undefined) throw new Error("old serve missing");
    process.kill(-record.serve.pgid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await service.revive(env, { expectPid: record.serve.pid, kill: false })).toMatchObject({ revived: true });
    expect((await docker.read()).volumes.map((item) => item.name)).toEqual(before.volumes.map((item) => item.name));
    await service.remove(env, true);
  });

  it("refuses a compose project that holds another Nectar home's containers and leaves them alone", async () => {
    const { service, docker } = await harness();
    const state = await docker.read();
    state.containers.push({
      id: "twin-home",
      name: "nectar-shop--main--web-db-1",
      labels: { "com.docker.compose.project": "nectar-shop--main--web", "dev.nectar.env": "shop--main--web", "dev.nectar.home": "/other/home" },
      running: true,
    });
    await writeFile(docker.stateFile, JSON.stringify(state));
    const repo = await depsRepo(path.join(await tempDir("deps-seeds"), "seeds.log"));
    await expect(service.publish({ repo, ttl: "1h" })).rejects.toThrow("not this Nectar home's (/other/home)");
    expect(await docker.read()).toEqual(state);
    expect(await readFile(docker.log, "utf8")).not.toMatch(/ up -d/);
  });

  it("copies a sqlite file per env, keeps it on republish, and re-copies on --fresh", async () => {
    const { service, state } = await harness();
    const repo = await initGitRepo({
      "nectar.toml": `name = "notes"\n[web]\nserve = "node server.mjs"\n[deps.db]\nkind = "sqlite"\npath = "data/app.db"\n`,
      "data/app.db": "pristine",
      "server.mjs": app,
    });
    const first = await service.publish({ repo, ttl: "1h" });
    const env = first.env as string;
    track(service, env);
    const firstBody = await body((first.urls as { local: string }).local);
    expect(firstBody.sqlite).toBe(path.join(state, "work", `${env}.deps`, "db", "app.db"));
    expect(firstBody.sqliteBody).toBe("pristine");
    expect(firstBody.url).toBeNull();
    await writeFile(firstBody.sqlite ?? "", "written by the app");

    const twin = await service.publish({ repo, ttl: "1h", name: "notes-two" });
    track(service, twin.env as string);
    expect((await body((twin.urls as { local: string }).local)).sqliteBody).toBe("pristine");

    const republished = await service.publish({ repo, ttl: "1h" });
    expect((await body((republished.urls as { local: string }).local)).sqliteBody).toBe("written by the app");
    const fresh = await service.publish({ repo, ttl: "1h", fresh: true });
    expect((await body((fresh.urls as { local: string }).local)).sqliteBody).toBe("pristine");
    expect(await readFile(path.join(repo, "data", "app.db"), "utf8")).toBe("pristine");
    await service.remove(env, true);
    await service.remove(twin.env as string, true);
  });

  it("rejects --fresh outside web mode", async () => {
    const { service } = await harness();
    const repo = await initGitRepo({ "nectar.toml": `[desktop]\npack = "x"\nkind = "native"\n` });
    await expect(service.publish({ repo, mode: "desktop", fresh: true })).rejects.toMatchObject({ code: "E_USAGE" });
    expect((await runCommand("git", ["status", "--short"], { cwd: repo })).stdout).toBe("");
  });
});
