import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pidAlive, spawnDetached, stopProcessGroup } from "../src/commands.js";
import { probeLiveness } from "../src/liveness.js";
import { NectarService } from "../src/service.js";
import type { ServeRecord } from "../src/types.js";
import { record, tempDir } from "./helpers.js";

const groups: number[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  for (const pgid of groups.splice(0)) await stopProcessGroup(pgid).catch(() => undefined);
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function listen(port = 0): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, port: (server.address() as net.AddressInfo).port };
}

async function closedPort(): Promise<number> {
  const { server, port } = await listen();
  servers.splice(servers.indexOf(server), 1);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function sleeper(command = "sleep 30"): Promise<{ pid: number; pgid: number }> {
  const dir = await tempDir("liveness-proc");
  const spawned = spawnDetached(command, dir, process.env, path.join(dir, "serve.log"));
  groups.push(spawned.pgid);
  return spawned;
}

async function deadProcess(): Promise<{ pid: number; pgid: number }> {
  const spawned = await sleeper("exit 0");
  for (let attempt = 0; attempt < 50 && pidAlive(spawned.pid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return spawned;
}

function serve(processIds: { pid: number; pgid: number }, port: number): ServeRecord {
  return { cmd: "test", ...processIds, upstream_port: port };
}

describe("probeLiveness", () => {
  it("tolerates a port that misses the first probe", async () => {
    const port = await closedPort();
    const processIds = await sleeper();
    setTimeout(() => void listen(port), 150);
    const liveness = await probeLiveness(serve(processIds, port), { timeoutsMs: [50, 300, 600], backoffMs: 200 });
    expect(liveness).toMatchObject({ state: "serving", reason: "port_open", pid_alive: true, port_open: true });
  });

  it("reports a live process with a silent port as unhealthy, not crashed", async () => {
    const liveness = await probeLiveness(serve(await sleeper(), await closedPort()), { timeoutsMs: [50, 50], backoffMs: 10 });
    expect(liveness).toMatchObject({ state: "unhealthy", reason: "port_unresponsive", pid_alive: true, port_open: false });
  });

  it("reports a dead pid with a silent port as crashed", async () => {
    const liveness = await probeLiveness(serve(await deadProcess(), await closedPort()));
    expect(liveness).toMatchObject({ state: "crashed", reason: "process_exited", pid_alive: false, port_open: false });
    expect(Date.parse(liveness.checked_at)).not.toBeNaN();
  });

  it("treats an answering port as serving even when the recorded pid is gone", async () => {
    const { port } = await listen();
    const liveness = await probeLiveness(serve(await deadProcess(), port));
    expect(liveness).toMatchObject({ state: "serving", reason: "port_open", pid_alive: false });
  });

  it("falls back to the process when no upstream port is recorded", async () => {
    const processIds = await sleeper();
    expect(await probeLiveness({ cmd: "test", ...processIds })).toMatchObject({ state: "serving", reason: "process_alive", port_open: null });
  });
});

describe("liveness on read", () => {
  async function service(): Promise<NectarService> {
    return new NectarService(await tempDir("liveness-state"));
  }

  it("recovers a record stuck at crashed once its port answers", async () => {
    const nectar = await service();
    const { port } = await listen();
    await nectar.store.writeEnv(record({ status: "crashed", serve: serve(await sleeper(), port) }));

    const listed = (await nectar.list()).envs as Array<{ status: string; liveness: { reason: string } }>;
    expect(listed[0]).toMatchObject({ status: "serving", liveness: { reason: "port_open" } });
    expect(await nectar.store.readEnv("demo--main--web")).toMatchObject({ status: "serving", liveness: { state: "serving" } });
    expect(await nectar.show("demo--main--web")).not.toHaveProperty("log_tail");
  });

  it("show returns the record view at the top level: serve, pid, pgid, ports, urls, liveness, expiry", async () => {
    const nectar = await service();
    const { port } = await listen();
    const processIds = await sleeper();
    const stored = record({ status: "serving", serve: serve(processIds, port) });
    await nectar.store.writeEnv(stored);

    const shown = await nectar.show("demo--main--web");
    expect(shown).toMatchObject({
      name: "demo--main--web",
      mode: "web",
      status: "serving",
      serve: { pid: processIds.pid, upstream_port: port },
      pid: processIds.pid,
      pgid: processIds.pgid,
      ports: { upstream: port, tailnet: null },
      urls: stored.urls,
      liveness: { state: "serving", reason: "port_open" },
      failure: null,
      env: { name: "demo--main--web", serve: { pid: processIds.pid } },
    });
    expect(shown.expires_at).toBe((await nectar.store.readEnv("demo--main--web")).expires_at);
    expect(shown.expires_in).toEqual(expect.stringMatching(/\d/));
  });

  it("marks a serving env crashed when its process is gone and recovers it when the port returns", async () => {
    const nectar = await service();
    const port = await closedPort();
    await nectar.store.writeEnv(record({ status: "serving", serve: serve(await deadProcess(), port) }));

    const shown = await nectar.show("demo--main--web");
    expect(shown).toMatchObject({ env: { status: "crashed", liveness: { reason: "process_exited" } } });
    expect(shown).toHaveProperty("log_tail");
    expect(await nectar.store.readEnv("demo--main--web")).toMatchObject({ status: "crashed" });

    await listen(port);
    expect(await nectar.show("demo--main--web")).toMatchObject({ env: { status: "serving", liveness: { reason: "port_open" } } });
    expect(await nectar.store.readEnv("demo--main--web")).toMatchObject({ status: "serving" });
  });

  it.each(["E_PORTS", "E_CRASH_LOOP"])("keeps a %s env crashed even when a stranger answers on its port", async (code) => {
    const nectar = await service();
    const { port } = await listen();
    const failure = { code, message: "given up", failed_at: "2026-10-14T00:00:00.000Z", log_tail: [] };
    await nectar.store.writeEnv(record({ status: "crashed", failure, urls: { local: null, mesh: null }, serve: serve(await deadProcess(), port) }));

    const listed = (await nectar.list()).envs as Array<Record<string, unknown>>;
    expect(listed[0]).toMatchObject({ status: "crashed", failure: code, liveness: { reason: "port_open" } });
    expect(await nectar.show("demo--main--web")).toMatchObject({ env: { status: "crashed", failure: { code } } });
    const stored = await nectar.store.readEnv("demo--main--web");
    expect(stored).toMatchObject({ status: "crashed", failure: { code } });
    expect(stored.liveness).toBeUndefined();
  });

  it("leaves stopped and expired envs alone", async () => {
    const nectar = await service();
    const { port } = await listen();
    await nectar.store.writeEnv(record({ status: "stopped", serve: serve(await sleeper(), port) }));
    expect(((await nectar.list()).envs as Array<{ status: string }>)[0]?.status).toBe("stopped");
  });
});
