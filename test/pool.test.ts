import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand, stopProcessGroup } from "../src/commands.js";
import { NectarError } from "../src/errors.js";
import { getPaths } from "../src/paths.js";
import { pinLocalApi } from "../src/localapi.js";
import { choosePoolHost, poolSettings, type PoolProbe } from "../src/pool.js";
import { startRemoteServer, type RemoteServer } from "../src/remote.js";
import { NectarService } from "../src/service.js";
import { fakeLocalApi, tempDir } from "./helpers.js";

const OWNER = 1001;
const servers: Array<{ close: () => Promise<void> }> = [];
const pgids: number[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const pgid of pgids.splice(0)) await stopProcessGroup(pgid);
  pinLocalApi(undefined);
  vi.unstubAllEnvs();
});

function report(overrides: Record<string, unknown> = {}): NonNullable<PoolProbe["report"]> {
  const base: Record<string, unknown> = {
    version: "0.0.0+abc",
    nectard: { ok: true, pid: 10 },
    mesh: "ok",
    deps: "none",
    envs: { total: 1, serving: 1 },
    load: { load1: 1, cpus: 4, per_cpu: 0.25 },
  };
  return { ...base, ...overrides };
}

function probe(host: string, overrides: Record<string, unknown> = {}, error?: string): PoolProbe {
  return error === undefined ? { host, local: false, report: report(overrides) } : { host, local: false, error: { code: "E_REMOTE", message: error } };
}

describe("pool settings", () => {
  it("is off without hosts and defaults to web and static, first-healthy", () => {
    expect(poolSettings({} as never)).toBeUndefined();
    expect(poolSettings({ pool: { hosts: [] } } as never)).toBeUndefined();
    expect(poolSettings({ pool: { hosts: ["Mini03", "mini03", "metal-3"] } } as never)).toEqual({
      hosts: ["mini03", "metal-3"],
      default_for: ["web", "static"],
      prefer: "first-healthy",
    });
  });

  it("refuses desktop, ios or dev in default_for, an unknown policy and malformed hosts", () => {
    for (const pool of [{ hosts: ["a"], default_for: ["desktop"] }, { hosts: ["a"], prefer: "random" }, { hosts: "a" }, { hosts: [""] }, ["a"]]) {
      expect(() => poolSettings({ pool } as never)).toThrow(NectarError);
    }
  });
});

describe("pool selection", () => {
  it("takes the first healthy host in pool order, skipping unreachable, stopped and mesh-denied hosts", () => {
    const choice = choosePoolHost(
      [probe("a", {}, "nectard on a does not answer"), probe("b", { nectard: { ok: false, pid: null } }), probe("c", { mesh: "denied" }), probe("d"), probe("e")],
      { postgres: false },
      "first-healthy",
    );
    expect(choice.host).toBe("d");
    expect(choice.skipped.map((entry) => entry.host)).toEqual(["a", "b", "c"]);
    expect(choice.reason).toContain("first healthy");
    expect(choice.reason).toContain("c (mesh denied");
  });

  it("takes the least loaded host per CPU, then the one serving fewer envs, then pool order", () => {
    const busy = probe("busy", { load: { load1: 6, cpus: 4, per_cpu: 1.5 } });
    const idle = probe("idle", { load: { load1: 0.4, cpus: 8, per_cpu: 0.05 } });
    expect(choosePoolHost([busy, idle], { postgres: false }, "least-loaded").host).toBe("idle");
    expect(choosePoolHost([busy, idle], { postgres: false }, "first-healthy").host).toBe("busy");
    const many = probe("many", { envs: { total: 9, serving: 9 } });
    const few = probe("few", { envs: { total: 2, serving: 2 } });
    expect(choosePoolHost([many, few], { postgres: false }, "least-loaded").host).toBe("few");
    expect(choosePoolHost([probe("x"), probe("y")], { postgres: false }, "least-loaded").host).toBe("x");
    expect(choosePoolHost([busy, idle], { postgres: false }, "least-loaded").reason).toContain("least loaded (load 0.05 per CPU");
  });

  it("puts a [deps] postgres env on a Docker host first, then a local provider, never on a host without one", () => {
    const none = probe("none", { load: { load1: 0, cpus: 4, per_cpu: 0 } });
    const local = probe("local", { deps: "local" });
    const docker = probe("docker", { deps: "docker", load: { load1: 8, cpus: 4, per_cpu: 2 } });
    expect(choosePoolHost([none, local, docker], { postgres: true }, "least-loaded").host).toBe("docker");
    const fallback = choosePoolHost([none, local], { postgres: true }, "first-healthy");
    expect(fallback.host).toBe("local");
    expect(fallback.reason).toContain("local server");
    expect(choosePoolHost([none], { postgres: true }, "first-healthy")).toMatchObject({ host: undefined, skipped: [{ host: "none", why: "no [deps] postgres provider" }] });
    expect(choosePoolHost([none], { postgres: false }, "first-healthy").host).toBe("none");
  });

  it("uses a host on an older nectard that reports nothing but sorts it last by load", () => {
    const old: PoolProbe = { host: "old", local: false, report: {} };
    expect(choosePoolHost([old], { postgres: false }, "first-healthy").host).toBe("old");
    expect(choosePoolHost([old, probe("new")], { postgres: false }, "least-loaded").host).toBe("new");
  });

  it("names every skipped host when none is usable", () => {
    const choice = choosePoolHost([probe("a", { mesh: "denied" }), probe("b", {}, "connection refused")], { postgres: false }, "first-healthy");
    expect(choice.host).toBeUndefined();
    expect(choice.reason).toMatch(/^no usable pool host; skipped a \(mesh denied.*\), b \(unhealthy: connection refused\)$/);
  });
});

interface Mesh {
  a: string;
  b: string;
  c: string;
  servers: Record<"nodeb" | "nodec", RemoteServer>;
}

async function mesh(options: { meshDenied?: boolean } = {}): Promise<Mesh> {
  vi.stubEnv("NECTAR_TAILSCALE_BIN", "/bin/false");
  vi.stubEnv("NECTAR_DOCKER_BIN", "/bin/false");
  vi.stubEnv("NECTAR_PG_BIN", await tempDir("pool-no-pg"));
  vi.stubEnv("NECTAR_STATIC_SERVER_ENTRY", fileURLToPath(new URL("../src/static-server.ts", import.meta.url)));
  const api = await fakeLocalApi(
    { socket: path.join(await tempDir("pool-localapi"), "tailscaled.sock") },
    {
      status: {
        BackendState: "Running",
        Self: { ID: "nSELF", HostName: "nodea", TailscaleIPs: ["127.0.0.3"], UserID: OWNER },
        Peer: {
          b: { HostName: "nodeb", DNSName: "nodeb.tail.ts.net.", TailscaleIPs: ["127.0.0.1"] },
          c: { HostName: "nodec", DNSName: "nodec.tail.ts.net.", TailscaleIPs: ["127.0.0.2"] },
        },
      },
      ...(options.meshDenied === true ? { postStatus: 403, postBody: "serve config denied" } : {}),
      whois: () => ({
        Node: { StableID: "nCLIENT", Name: "nodea.tail.ts.net.", User: OWNER, Addresses: ["127.0.0.3/32"] },
        UserProfile: { ID: OWNER, LoginName: "owner@example.com", DisplayName: "Owner" },
      }),
    },
  );
  servers.push(api);
  vi.stubEnv("NECTAR_TAILSCALE_SOCKET", api.socket ?? "");
  const a = await tempDir("pool-a");
  const b = await tempDir("pool-b");
  const c = await tempDir("pool-c");
  await writeFile(path.join(a, "nectar.json"), JSON.stringify({ tailnet_host: "nodea", upstream_port_start: 5100, upstream_port_end: 5149, tailnet_port_start: 9600, tailnet_port_end: 9649 }));
  await writeFile(path.join(b, "nectar.json"), JSON.stringify({ tailnet_host: "nodeb", upstream_port_start: 5150, upstream_port_end: 5199, tailnet_port_start: 9650, tailnet_port_end: 9699, remote: { listen: true } }));
  await writeFile(path.join(c, "nectar.json"), JSON.stringify({ tailnet_host: "nodec", upstream_port_start: 5200, upstream_port_end: 5249, tailnet_port_start: 9700, tailnet_port_end: 9749, remote: { listen: true } }));
  const nodeb = await startRemoteServer(getPaths(b), { address: "127.0.0.1", port: 0 });
  servers.push(nodeb);
  const nodec = await startRemoteServer(getPaths(c), { address: "127.0.0.2", port: nodeb.port });
  servers.push(nodec);
  vi.stubEnv("NECTAR_REMOTE_PORT", String(nodeb.port));
  return { a, b, c, servers: { nodeb, nodec } };
}

async function setPool(home: string, pool: Record<string, unknown>): Promise<void> {
  const file = path.join(home, "nectar.json");
  const config = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...config, pool }));
}

async function track(home: string, env: string): Promise<void> {
  const record = JSON.parse(await readFile(path.join(home, "envs", `${env}.json`), "utf8")) as { serve?: { pgid: number } };
  if (record.serve !== undefined) pgids.push(record.serve.pgid);
}

async function site(text: string, name = "demo"): Promise<string> {
  const dir = path.join(await tempDir("pool-site"), name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), text);
  return dir;
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

async function envs(home: string): Promise<string[]> {
  return (await readdir(path.join(home, "envs")).catch(() => [])).map((file) => file.replace(/\.json$/, ""));
}

async function repo(files: Record<string, string>, name = "webapp"): Promise<{ dir: string; git: (...args: string[]) => Promise<void> }> {
  const dir = path.join(await tempDir("pool-repo"), name);
  await mkdir(dir, { recursive: true });
  const git = async (...args: string[]): Promise<void> => {
    const result = await runCommand("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: dir });
    if (result.exitCode !== 0) throw new Error(result.stderr);
  };
  await git("init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  await git("add", "-A");
  await git("commit", "-qm", "first");
  return { dir, git };
}

describe("pool placement", () => {
  it("publishes locally, as before, when no pool is configured", async () => {
    const { a, b } = await mesh();
    const published = await new NectarService(a).publish({ repo: await site("<h1>here</h1>"), branch: "main" });
    await track(a, published.env as string);
    expect(published).not.toHaveProperty("placed_on");
    expect(await envs(a)).toEqual(["demo--main--web"]);
    expect(await envs(b)).toEqual([]);
  });

  it("places on the first healthy host, sticks on republish, moves when that host goes down, and stays here with --local", async () => {
    const { a, b, c, servers: nodes } = await mesh();
    await setPool(a, { hosts: ["nodeb", "nodec"] });
    const client = new NectarService(a);
    const dir = await site("<h1>pooled</h1>");
    const plan = await client.publish({ repo: dir, branch: "main", dryRun: true });
    expect(plan).toMatchObject({ dry_run: true, name: "demo--main--web", placed_on: "nodeb" });
    expect(await envs(b)).toEqual([]);

    const first = await client.publish({ repo: dir, branch: "main" });
    await track(b, first.env as string);
    expect(first).toMatchObject({ env: "demo--main--web", ref: "nectar://nodeb/demo--main--web", placed_on: "nodeb" });
    expect(first.placement_reason).toContain("first healthy pool host");
    expect(await get((first.urls as { local: string }).local)).toEqual({ status: 200, body: "<h1>pooled</h1>" });
    expect(Object.values(JSON.parse(await readFile(path.join(a, "placements.json"), "utf8")) as object)).toMatchObject([{ host: "nodeb", env: "demo--main--web" }]);

    await setPool(a, { hosts: ["nodec", "nodeb"] });
    const again = await client.publish({ repo: dir, branch: "main" });
    await track(b, again.env as string);
    expect(again).toMatchObject({ placed_on: "nodeb", env: "demo--main--web" });
    expect(again.placement_reason).toMatch(/^sticky: demo--main--web already lives on nodeb/);
    expect(await envs(c)).toEqual([]);

    await nodes.nodeb.close();
    servers.splice(servers.indexOf(nodes.nodeb), 1);
    const moved = await client.publish({ repo: dir, branch: "main" });
    await track(c, moved.env as string);
    expect(moved).toMatchObject({ placed_on: "nodec", ref: "nectar://nodec/demo--main--web" });
    expect(moved.placement_reason).toContain("lived on nodeb, which is unhealthy");

    const here = await client.publish({ repo: dir, branch: "main", local: true });
    await track(a, here.env as string);
    expect(here).toMatchObject({ env: "demo--main--web", placement_reason: "--local keeps it on this host" });
    expect(await envs(a)).toEqual(["demo--main--web"]);
    const stays = await client.publish({ repo: dir, branch: "main" });
    await track(a, stays.env as string);
    expect(stays.placement_reason).toBe("demo--main--web already lives on this host");

    await expect(client.publish({ repo: dir, host: "nodec", local: true })).rejects.toMatchObject({ code: "E_USAGE" });
    expect(await client.remove("nectar://nodec/demo--main--web", true)).toMatchObject({ removed: true });
    expect(Object.values(JSON.parse(await readFile(path.join(a, "placements.json"), "utf8")) as object)).toEqual([]);
  });

  it("takes the least loaded host when asked, keeps desktop envs and default_for exclusions local", async () => {
    const { a, b, c } = await mesh();
    await setPool(a, { hosts: ["nodeb", "nodec"], prefer: "least-loaded" });
    await mkdir(path.join(b, "envs"), { recursive: true });
    await writeFile(path.join(b, "envs", "busy--main--web.json"), JSON.stringify({ name: "busy--main--web", status: "serving" }));
    const client = new NectarService(a);
    const plan = await client.publish({ repo: await site("x"), branch: "main", dryRun: true });
    expect(plan).toMatchObject({ placed_on: "nodec" });
    expect(plan.placement_reason).toContain("least loaded");

    const { dir } = await repo({ "nectar.toml": '[desktop]\nkind = "native"\npack = "true"\n' }, "deskapp");
    const desktop = await client.publish({ repo: dir, dryRun: true });
    expect(desktop).toMatchObject({ mode: "desktop", placement_reason: "desktop envs always stay on this host" });

    await setPool(a, { hosts: ["nodeb", "nodec"], default_for: ["web"] });
    const excluded = await client.publish({ repo: await site("y"), branch: "main", dryRun: true });
    expect(excluded.placement_reason).toBe("pool.default_for does not include static, so it stays on this host");
    expect(await envs(c)).toEqual([]);
  });

  it("skips mesh-denied hosts and publishes here, saying why", async () => {
    const { a, b } = await mesh({ meshDenied: true });
    await setPool(a, { hosts: ["nodeb", "nodec"] });
    const client = new NectarService(a);
    const plan = await client.publish({ repo: await site("z"), branch: "main", dryRun: true });
    expect(plan.placed_on).toBe("nodea");
    expect(plan.placement_reason).toMatch(/^no usable pool host; skipped nodeb \(mesh denied.*nodec \(mesh denied.*; published on this host$/);
    expect(await envs(b)).toEqual([]);
    const checked = await client.poolCheck();
    expect(checked).toMatchObject({ hosts: [{ host: "nodeb", healthy: true, nectard: "ok", mesh: "denied", deps: "none", envs: 0 }, { host: "nodec", mesh: "denied" }], next: { web: null } });
    expect((checked.hosts as Array<{ version: string }>)[0]?.version).toMatch(/^0\.0\.0/);
  });

  it("changes the pool with add and rm and reports an unreachable host in check", async () => {
    const { a, servers: nodes } = await mesh();
    const client = new NectarService(a);
    await client.poolChange({ add: ["nodeb", "NodeC"], prefer: "least-loaded" });
    expect(await client.poolList()).toMatchObject({ pool: { hosts: ["nodeb", "nodec"], prefer: "least-loaded", default_for: ["web", "static"] } });
    await expect(client.poolChange({ prefer: "random" })).rejects.toMatchObject({ code: "E_USAGE" });
    await expect(client.poolChange({ defaultFor: ["ios"] })).rejects.toMatchObject({ code: "E_USAGE" });
    await expect(client.poolChange({ remove: ["nodez"] })).rejects.toMatchObject({ code: "E_NOT_FOUND" });
    await nodes.nodec.close();
    servers.splice(servers.indexOf(nodes.nodec), 1);
    const checked = await client.poolCheck();
    expect(checked).toMatchObject({ hosts: [{ host: "nodeb", healthy: true, mesh: "ok" }, { host: "nodec", healthy: false, nectard: "unreachable", error: { code: "E_REMOTE" } }], next: { web: "nodeb" } });
    expect(await client.poolChange({ remove: ["nodeb", "nodec"] })).toMatchObject({ pool: null });
  });
});

describe("the own host in the pool", () => {
  it("refuses to add this host, in short or full form, and writes nothing", async () => {
    const { a } = await mesh();
    const client = new NectarService(a);
    for (const own of ["nodea", "NodeA.tail.ts.net."]) {
      const refused = await client.poolChange({ add: ["nodeb", own] }).catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: "E_USAGE" });
      expect((refused as Error).message).toMatch(/is this host/);
    }
    expect(await client.poolList()).toMatchObject({ pool: null });
  });

  it("shows a listed own host as excluded, never places on it, and removes it with rm in any form", async () => {
    const { a, b } = await mesh();
    await setPool(a, { hosts: ["nodea", "nodeb.tail.ts.net"] });
    const client = new NectarService(a);
    expect(await client.poolList()).toMatchObject({ pool: { hosts: ["nodea", "nodeb.tail.ts.net"] }, excluded: ["nodea"], note: expect.stringContaining("nectar pool rm nodea") as string });
    const checked = await client.poolCheck();
    expect(checked).toMatchObject({ excluded: ["nodea"], hosts: [{ host: "nodea", local: true, excluded: true }, { host: "nodeb.tail.ts.net", healthy: true }], next: { web: "nodeb.tail.ts.net" } });
    const plan = await client.publish({ repo: await site("<h1>skip self</h1>"), branch: "main", dryRun: true });
    expect(plan).toMatchObject({ placed_on: "nodeb.tail.ts.net" });
    expect(await envs(b)).toEqual([]);
    expect(await client.poolChange({ remove: ["NODEA.tail.ts.net."] })).toMatchObject({ pool: { hosts: ["nodeb.tail.ts.net"] } });
    expect(await client.poolList()).not.toHaveProperty("excluded");
    await client.poolChange({ add: ["nodeb"] });
    expect(await client.poolList()).toMatchObject({ pool: { hosts: ["nodeb.tail.ts.net"] } });
    expect(await client.poolChange({ remove: ["nodeb"] })).toMatchObject({ pool: null });
  });
});

describe("pool placement edges", () => {
  it("keeps a static page with uncommitted changes in a repo here and places it once committed", async () => {
    const { a, b } = await mesh();
    await setPool(a, { hosts: ["nodeb"] });
    const { dir, git } = await repo({ "index.html": "<h1>committed</h1>" }, "proto");
    await writeFile(path.join(dir, "index.html"), "<h1>edited</h1>");
    const client = new NectarService(a);
    const edited = await client.publish({ repo: dir, dryRun: true });
    expect(edited).toMatchObject({ placed_on: "nodea" });
    expect(edited.placement_reason).toContain("the repo has uncommitted changes");
    await writeFile(path.join(dir, "new.html"), "<h1>new</h1>");
    const fresh = await client.publish({ repo: path.join(dir, "new.html"), dryRun: true });
    expect(fresh.placement_reason).toBe("new.html has uncommitted changes and a pool host gets only the commit, so it stays on this host; commit to let the pool take it");
    await git("add", "-A");
    await git("commit", "-qm", "edit");
    expect(await client.publish({ repo: dir, dryRun: true })).toMatchObject({ placed_on: "nodeb" });
    expect(await envs(b)).toEqual([]);
  });

  it("keeps a static page with a leaking symlink here, naming the link, places it once the link is gone, and refuses it with --host", async () => {
    const { a, b } = await mesh();
    await setPool(a, { hosts: ["nodeb"] });
    const { dir, git } = await repo({ "site/index.html": "<h1>kit</h1>", "content/skill.md": "x" }, "kit");
    await symlink("../content/skill.md", path.join(dir, "site", "skill.md"));
    await git("add", "-A");
    await git("commit", "-qm", "leak");
    const client = new NectarService(a);
    const site = path.join(dir, "site");
    const plan = await client.publish({ repo: site, dryRun: true });
    expect(plan).toMatchObject({ dry_run: true, name: "site--main--web", placed_on: "nodea" });
    expect(plan.placement_reason).toMatch(/^not shipped to nodeb: Symlink 'site\/skill.md' \(-> \.\.\/content\/skill.md\) points outside site; .*; published on this host$/);
    const published = await client.publish({ repo: site });
    await track(a, published.env as string);
    expect(published).toMatchObject({ env: "site--main--web", ref: "nectar://nodea/site--main--web", placed_on: "nodea", placement_reason: plan.placement_reason });
    expect(await envs(a)).toEqual(["site--main--web"]);
    expect(await envs(b)).toEqual([]);
    const refused = await client.publish({ repo: site, host: "nodeb", dryRun: true }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "E_USAGE", details: { refused: "symlink", links: ["site/skill.md"] } });
    await client.remove("site--main--web", true);

    await git("rm", "-q", "site/skill.md");
    await git("commit", "-qm", "no leak");
    const placed = await client.publish({ repo: site, dryRun: true });
    expect(placed).toMatchObject({ placed_on: "nodeb" });
    expect(placed.placement_reason).toContain("first healthy pool host");
  });

  it("keeps a recipe publish with a symlink leaving the repo here and refuses it with --host", async () => {
    const { a } = await mesh();
    await setPool(a, { hosts: ["nodeb"] });
    const { dir, git } = await repo({ "package.json": JSON.stringify({ name: "linky", scripts: { dev: "vite" } }), "index.html": "<h1>app</h1>" }, "linky");
    await symlink("../../elsewhere", path.join(dir, "shared"));
    await git("add", "-A");
    await git("commit", "-qm", "link");
    const client = new NectarService(a);
    const plan = await client.publish({ repo: dir, dryRun: true });
    expect(plan).toMatchObject({ dry_run: true, placed_on: "nodea" });
    expect(plan.placement_reason).toContain("not shipped to nodeb: Symlink 'shared' (-> ../../elsewhere) points outside the repo");
    await expect(client.publish({ repo: dir, host: "nodeb", dryRun: true })).rejects.toMatchObject({ code: "E_USAGE", details: { links: ["shared"] } });
  });

  it("re-places an env whose host left the pool even while that host still answers", async () => {
    const { a, b, c } = await mesh();
    await setPool(a, { hosts: ["nodeb", "nodec"] });
    const client = new NectarService(a);
    const dir = await site("<h1>moves</h1>");
    const first = await client.publish({ repo: dir, branch: "main" });
    await track(b, first.env as string);
    expect(first.placed_on).toBe("nodeb");
    await client.poolChange({ remove: ["nodeb"] });
    const moved = await client.publish({ repo: dir, branch: "main" });
    await track(c, moved.env as string);
    expect(moved).toMatchObject({ placed_on: "nodec" });
    expect(moved.placement_reason).toMatch(/^demo--main--web lived on nodeb, which is no longer in the pool; pool: nodec/);
    await client.remove("nectar://nodeb/demo--main--web", true);
    await client.remove("nectar://nodec/demo--main--web", true);
  });

  it("never places a publish it received from another node, and says nothing about placement", async () => {
    const { a, b } = await mesh();
    await setPool(b, { hosts: ["nodec"] });
    const published = await new NectarService(a).publish({ repo: await site("<h1>received</h1>"), host: "nodeb", branch: "main" });
    await track(b, published.env as string);
    expect(published).toMatchObject({ ref: "nectar://nodeb/demo--main--web" });
    expect(published).not.toHaveProperty("placed_on");
    expect(published).not.toHaveProperty("placement_reason");
    expect(await envs(b)).toEqual(["demo--main--web"]);
  });

  it("reports the deps provider as unknown instead of stalling the hello on a slow Docker", async () => {
    const bin = await tempDir("pool-slow-docker");
    const docker = path.join(bin, "docker");
    await writeFile(docker, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    vi.stubEnv("NECTAR_DOCKER_BIN", docker);
    vi.stubEnv("NECTAR_PG_BIN", await tempDir("pool-no-pg"));
    vi.resetModules();
    const { depsProvider } = await import("../src/pool.js");
    const started = Date.now();
    expect(await depsProvider(200)).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("publish --host of a repo", () => {
  it("ships the committed tree of a repo without nectar.toml and lets the target detect its recipe", async () => {
    const { a, b } = await mesh();
    const { dir } = await repo({ "package.json": JSON.stringify({ name: "viteapp", scripts: { dev: "vite" } }), "index.html": "<h1>committed</h1>" });
    await writeFile(path.join(dir, "index.html"), "<h1>uncommitted edit</h1>");
    const client = new NectarService(a);
    const plan = await client.publish({ repo: dir, host: "nodeb", dryRun: true });
    expect(plan).toMatchObject({ dry_run: true, name: "viteapp--main--web", stack: "node", serve: "npm run dev" });
    const [key] = await readdir(path.join(b, "inbox"));
    expect(await readFile(path.join(b, "inbox", key ?? "", "webapp", "index.html"), "utf8")).toBe("<h1>committed</h1>");
  });

  it("serves a static repo from its commit, not the working tree, and keeps subdirectories and ignored build output", async () => {
    const { a, b } = await mesh();
    const { dir, git } = await repo({ "index.html": "<h1>committed</h1>", "docs/index.html": "<h1>docs</h1>", ".gitignore": "dist/\n" });
    await writeFile(path.join(dir, "index.html"), "<h1>uncommitted edit</h1>");
    const client = new NectarService(a);
    const root = await client.publish({ repo: dir, host: "nodeb" });
    await track(b, root.env as string);
    expect(root).toMatchObject({ env: "webapp--main--web" });
    expect(await get((root.urls as { local: string }).local)).toEqual({ status: 200, body: "<h1>committed</h1>" });

    const docs = await client.publish({ repo: path.join(dir, "docs"), host: "nodeb" });
    await track(b, docs.env as string);
    expect(docs).toMatchObject({ env: "docs--main--web" });
    expect(await get((docs.urls as { local: string }).local)).toEqual({ status: 200, body: "<h1>docs</h1>" });

    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "dist", "index.html"), "<h1>built</h1>");
    const built = await client.publish({ repo: path.join(dir, "dist"), host: "nodeb" });
    await track(b, built.env as string);
    expect(await get((built.urls as { local: string }).local)).toEqual({ status: 200, body: "<h1>built</h1>" });

    await mkdir(path.join(dir, "draft"));
    await writeFile(path.join(dir, "draft", "index.html"), "<h1>draft</h1>");
    const draft = await client.publish({ repo: path.join(dir, "draft"), host: "nodeb" }).catch((error: unknown) => error);
    expect(draft).toMatchObject({ code: "E_USAGE" });
    expect((draft as Error).message).toContain("commit it first");
    await git("add", "draft");
    await git("commit", "-qm", "draft");
    expect(await client.publish({ repo: path.join(dir, "draft"), host: "nodeb", dryRun: true })).toMatchObject({ name: "draft--main--web", stack: "static" });
  });

  it("ships only the static subdirectory, so out-of-tree symlinks elsewhere in the repo do not matter", async () => {
    const { a, b } = await mesh();
    const { dir, git } = await repo({ "site/index.html": "<h1>subtree</h1>", "site/about.html": "<p>about</p>", "other/readme.md": "x" }, "kit");
    await symlink("../../../outside-the-repo", path.join(dir, "other", "escape"));
    await symlink("about.html", path.join(dir, "site", "alias.html"));
    await git("add", "-A");
    await git("commit", "-qm", "links");
    const client = new NectarService(a);
    const published = await client.publish({ repo: path.join(dir, "site"), host: "nodeb" });
    await track(b, published.env as string);
    expect(published).toMatchObject({ env: "site--main--web" });
    expect(await get((published.urls as { local: string }).local)).toEqual({ status: 200, body: "<h1>subtree</h1>" });
    const [key] = await readdir(path.join(b, "inbox"));
    expect((await readdir(path.join(b, "inbox", key ?? "", "kit"))).sort()).toEqual([".git", "site"]);

    await symlink("../other/readme.md", path.join(dir, "site", "leak.md"));
    await git("add", "-A");
    await git("commit", "-qm", "leak");
    const refused = await client.publish({ repo: path.join(dir, "site"), host: "nodeb", dryRun: true }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "E_USAGE", details: { refused: "symlink", links: ["site/leak.md"] } });
    expect((refused as Error).message).toContain("'site/leak.md' (-> ../other/readme.md) points outside site");
  });

  it("refuses a static root that is a symlink to elsewhere in the repo, naming it", async () => {
    const { a } = await mesh();
    const { dir, git } = await repo({ "build/out/index.html": "<h1>built</h1>" }, "linked");
    await symlink("build/out", path.join(dir, "public"));
    await git("add", "-A");
    await git("commit", "-qm", "public link");
    const refused = await new NectarService(a).publish({ repo: dir, host: "nodeb", dryRun: true }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "E_USAGE", details: { refused: "symlink", links: ["public"] } });
    expect((refused as Error).message).toContain("'public' (-> build/out) points outside public");
  });

  it("refuses a whole-repo publish whose tree has a symlink leaving the repo, naming the link", async () => {
    const { a } = await mesh();
    const { dir, git } = await repo({ "package.json": JSON.stringify({ name: "linky", scripts: { dev: "vite" } }), "index.html": "<h1>app</h1>" }, "linky");
    await symlink("../../elsewhere", path.join(dir, "shared"));
    await git("add", "-A");
    await git("commit", "-qm", "link");
    const refused = await new NectarService(a).publish({ repo: dir, host: "nodeb", dryRun: true }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "E_USAGE", details: { refused: "symlink", links: ["shared"] } });
    expect((refused as Error).message).toContain("'shared' (-> ../../elsewhere) points outside the repo");
  });
});
