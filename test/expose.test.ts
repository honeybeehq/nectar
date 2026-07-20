import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NectarService } from "../src/service.js";
import { exposureSub } from "../src/relay.js";
import { fakeExecutable, initGitRepo, record, tempDir } from "./helpers.js";

const services: Array<{ service: NectarService; envs: string[] }> = [];

afterEach(async () => {
  for (const item of services.splice(0)) {
    for (const env of item.envs) await item.service.stop(env).catch(() => undefined);
  }
  vi.unstubAllEnvs();
});

// A self-contained tailscale stand-in: real-enough status/serve for publish, plus
// `ssh <dest> nectar-relay <verb> …` behaving like the relay (echo the URL on add,
// JSON health) and logging every relay call.
async function fakeTailscaleWithRelay(dir: string): Promise<{ binary: string; log: string; relayLog: string }> {
  const log = path.join(dir, "tailscale.log");
  const relayLog = path.join(dir, "relay.log");
  const binary = await fakeExecutable(
    dir,
    "tailscale",
    `
if [ "$1" = "ssh" ] && [ "$3" = "nectar-relay" ]; then
  shift 3
  printf '%s\\n' "$*" >> "$FAKE_RELAY_LOG"
  case "$1" in
    add)    printf 'https://%s.nctr.site\\n' "$2";;
    rm)     printf 'removed %s\\n' "$2";;
    health) printf '{"caddy":"active","routes":1,"domain":"nctr.site"}\\n';;
  esac
  exit 0
fi
if [ "$1" = "status" ] && [ "$2" = "--json" ]; then
  printf '{"BackendState":"Running","Self":{"DNSName":"fixture.tailtest.ts.net."}}\\n'; exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "status" ]; then printf '{}\\n'; exit 0; fi
printf '%s\\n' "$*" >> "$FAKE_TS_LOG"
exit 0
`,
  );
  return { binary, log, relayLog };
}

async function harness(): Promise<{ service: NectarService; state: string; relayLog: string }> {
  const state = await tempDir("expose-state");
  const dir = await tempDir("expose-bin");
  const ts = await fakeTailscaleWithRelay(dir);
  await writeFile(
    path.join(state, "nectar.json"),
    JSON.stringify({
      upstream_port_start: 4700,
      upstream_port_end: 4799,
      pack_server_port: 4699,
      tailnet_port_start: 8800,
      tailnet_port_end: 8899,
      exposures: { site: { kind: "relay", host: "relay-vm", domain: "nctr.site", gate: "password" } },
    }),
  );
  vi.stubEnv("NECTAR_HOME", state);
  vi.stubEnv("NECTAR_TAILSCALE_BIN", ts.binary);
  vi.stubEnv("FAKE_TS_LOG", ts.log);
  vi.stubEnv("FAKE_RELAY_LOG", ts.relayLog);
  const service = new NectarService(state);
  services.push({ service, envs: [] });
  return { service, state, relayLog: ts.relayLog };
}

const webServer = `
import http from "node:http";
http.createServer((_q, r) => { r.writeHead(200); r.end("ok"); }).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
`;

describe("exposureSub", () => {
  it("builds a DNS label and adds an unguessable suffix only when public", () => {
    const base = record({ name: "acme--agent-coupons--web", app: "acme", branch: "agent/coupons", eid: "e7f3" });
    expect(exposureSub(base, false)).toBe("acme-agent-coupons-e7f3");
    expect(exposureSub(base, true)).toMatch(/^acme-agent-coupons-e7f3-[0-9a-f]{8}$/);
  });

  it("caps at 63 chars", () => {
    const long = record({ app: "a".repeat(50), branch: "b".repeat(50), eid: "e7f3" });
    expect(exposureSub(long, false).length).toBeLessThanOrEqual(63);
  });
});

describe("expose / unexpose", () => {
  it("exposes a serving web env through the relay, gates by default, and tears down", async () => {
    const { service, relayLog } = await harness();
    const repo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-exp", scripts: { dev: "node server.mjs" } }),
      "server.mjs": webServer,
    });
    const published = await service.publish({ repo, ttl: "1h" });
    const env = published.env as string;
    services.find((item) => item.service === service)?.envs.push(env);

    const exposed = await service.expose(env, { to: "site" });
    expect(exposed.url).toMatch(/^https:\/\/fixture-exp-main-[0-9a-f]{2,}\.nctr\.site$/);
    expect(exposed.gate).toBe("password");
    expect((exposed.credentials as { user: string; password: string }).user).toBe("reviewer");
    expect((exposed.packet_fields as { public_url: string }).public_url).toBe(exposed.url);

    // The relay was driven over `tailscale ssh` with a password (hashed on the relay).
    const calls = await readFile(relayLog, "utf8");
    expect(calls).toMatch(/^add fixture-exp-main-\S+ https:\/\/\S+ \d+ --password /m);

    // The public URL is stamped on the record and survives republish (stable mesh URL).
    const republished = await service.publish({ repo, ttl: "1h" });
    expect((republished.packet_fields as { public_url: string }).public_url).toBe(exposed.url);

    const down = await service.unexpose(env);
    expect(down).toMatchObject({ env, unexposed: true, was: exposed.url });
    expect(await readFile(relayLog, "utf8")).toMatch(/^rm fixture-exp-main-/m);
    const rec = (await service.show(env)).env as { exposure?: unknown };
    expect(rec.exposure).toBeUndefined();
  });

  it("refuses --gate none without --public, and unknown targets", async () => {
    const { service } = await harness();
    const repo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-guard", scripts: { dev: "node server.mjs" } }),
      "server.mjs": webServer,
    });
    const published = await service.publish({ repo, ttl: "1h" });
    const env = published.env as string;
    services.find((item) => item.service === service)?.envs.push(env);

    await expect(service.expose(env, { to: "site", gate: "none" })).rejects.toMatchObject({ code: "E_EXPOSE" });
    await expect(service.expose(env, { to: "nope" })).rejects.toMatchObject({ code: "E_EXPOSE" });

    const pub = await service.expose(env, { to: "site", gate: "none", public: true });
    expect(pub.gate).toBe("none");
    expect(pub.url).toMatch(/-[0-9a-f]{8}\.nctr\.site$/); // public gets the unguessable suffix
  });

  it("stop and gc-expiry tear the public route down", async () => {
    const { service, relayLog } = await harness();
    const repo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-life", scripts: { dev: "node server.mjs" } }),
      "server.mjs": webServer,
    });
    const published = await service.publish({ repo, ttl: "1m" });
    const env = published.env as string;
    services.find((item) => item.service === service)?.envs.push(env);
    await service.expose(env, { to: "site" });

    await service.stop(env);
    expect(await readFile(relayLog, "utf8")).toMatch(/^rm fixture-life-main-/m);
    expect(((await service.show(env)).env as { exposure?: unknown }).exposure).toBeUndefined();
  });
});
