import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NectarService } from "../src/service.js";
import { exposureSub } from "../src/relay.js";
import { fakeExecutable, initGitRepo, record, tempDir, testRelayd, type TestRelayd } from "./helpers.js";

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

    // The relay was driven over `tailscale ssh` with the target's domain and a password
    // (hashed on the relay).
    const calls = await readFile(relayLog, "utf8");
    expect(calls).toMatch(/^add fixture-exp-main-\S+ https:\/\/\S+ \d+ --domain nctr\.site --password /m);

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

describe("expose through relayd", () => {
  const FIXTURE = { nodeId: "nFIXTURE1CNTRL", dnsName: "fixture.tailtest.ts.net" };
  const relays: TestRelayd[] = [];

  afterEach(async () => {
    for (const relay of relays.splice(0)) await relay.relayd.close();
  });

  async function relaydHarness(): Promise<{ service: NectarService; relay: TestRelayd; state: string; repo: string }> {
    const relay = await testRelayd({ allow: [{ node_id: FIXTURE.nodeId, name: "fixture" }] }, { now: () => Date.now() });
    relays.push(relay);
    relay.as(FIXTURE);
    const state = await tempDir("expose-relayd-state");
    const dir = await tempDir("expose-relayd-bin");
    const ts = await fakeTailscaleWithRelay(dir);
    await writeFile(
      path.join(state, "nectar.json"),
      JSON.stringify({
        upstream_port_start: 4800,
        upstream_port_end: 4899,
        pack_server_port: 4798,
        tailnet_port_start: 8500,
        tailnet_port_end: 8540,
        exposures: { site: { kind: "relay", host: "127.0.0.1", port: relay.relayd.control?.port, domain: "nctr.site", control: "relayd", gate: "password", default: true } },
      }),
    );
    vi.stubEnv("NECTAR_HOME", state);
    vi.stubEnv("NECTAR_TAILSCALE_BIN", ts.binary);
    vi.stubEnv("FAKE_TS_LOG", ts.log);
    vi.stubEnv("FAKE_RELAY_LOG", ts.relayLog);
    const service = new NectarService(state);
    services.push({ service, envs: [] });
    const repo = await initGitRepo({
      "package.json": JSON.stringify({ name: "fixture-rel", scripts: { dev: "node server.mjs" } }),
      "server.mjs": webServer,
    });
    return { service, relay, state, repo };
  }

  it("publish --public creates a relay-minted, owner-checked route and keeps the secret out of url", async () => {
    const { service, relay, repo } = await relaydHarness();
    const published = await service.publish({ repo, ttl: "1h", public: true });
    const env = published.env as string;
    services.find((item) => item.service === service)?.envs.push(env);
    const url = published.url as string;
    const sub = /^https:\/\/([a-z0-9-]+)\.nctr\.site$/.exec(url)?.[1] ?? "";
    expect(sub).toMatch(/^fixture-rel-main-[0-9a-f]{8}$/);
    const details = published.public as { password: string; share_note: string; gate: string; target: string };
    expect(details).toMatchObject({ target: "site", gate: "password" });
    expect(published.share_url).toBe(url);
    expect(published.secret).toEqual(["share_url", "public.share_note", "public.password", "public.credentials"]);
    expect(details.share_note).toContain(details.password);
    expect((published.packet_fields as { public_url: string }).public_url).toBe(url);
    expect((published.urls as { public: string }).public).toBe(url);
    const visible = JSON.stringify({ url, packet_fields: published.packet_fields, urls: published.urls, record: (await service.show(env)).env });
    expect(visible).not.toContain(details.password);
    expect(url).not.toMatch(/[@?#]/);
    expect(relay.relayd.state().routes[sub]).toMatchObject({ owner: { node_id: FIXTURE.nodeId }, upstream: expect.stringMatching(/^https:\/\/fixture\.tailtest\.ts\.net:85\d\d$/) as string });
    expect(await readFile(path.join(relay.routesDir, `${sub}.caddy`), "utf8")).toContain(`@${sub} host ${sub}.nctr.site`);

    const again = await service.expose(env, {});
    expect(again).toMatchObject({ url, reused: true, password_unchanged: true });
    expect(again.password).toBeUndefined();
    const rotated = await service.expose(env, { rotate: true });
    expect(rotated).toMatchObject({ url, reused: true });
    expect(rotated.password).not.toBe(details.password);

    expect(await service.unexpose(env)).toMatchObject({ env, unexposed: true, was: url });
    expect(relay.relayd.state().routes[sub]).toBeUndefined();
  });

  it("nectard's hourly sync PATCHes the expiry, never recreates, and marks a removed route revoked", async () => {
    const { service, relay, repo } = await relaydHarness();
    const published = await service.publish({ repo, ttl: "1h" });
    const env = published.env as string;
    services.find((item) => item.service === service)?.envs.push(env);
    const exposed = await service.expose(env, {});
    const sub = /^https:\/\/([a-z0-9-]+)\./.exec(exposed.url as string)?.[1] ?? "";

    await service.touch(env, "3h");
    const synced = await service.gc();
    expect(synced.exposures).toEqual([expect.objectContaining({ env, action: "patched" })]);
    const record = (await service.show(env)).env as { expires_at: string; exposure: { expires_at: string } };
    expect(Math.abs(Date.parse(record.exposure.expires_at) - Date.parse(record.expires_at))).toBeLessThan(1_000);
    expect(relay.relayd.state().routes[sub]?.expires_at).toBe(Math.floor(Date.parse(record.expires_at) / 1000) * 1000);
    expect((await service.gc()).exposures).toEqual([expect.objectContaining({ env, action: "unchanged" })]);

    await relay.admin("DELETE", `/admin/routes/${sub}`);
    expect((await service.gc()).exposures).toEqual([expect.objectContaining({ env, action: "revoked", reason: "admin" })]);
    expect(relay.relayd.state().routes).toEqual({});
    const revoked = await service.show(env);
    expect((revoked.env as { exposure: { revoked_at?: string }; urls: { public: unknown } }).exposure.revoked_at).toBeDefined();
    expect((revoked.env as { urls: { public: unknown } }).urls.public).toBeNull();
    expect(((await service.resolve(env)) as { packet_fields: { public_url: unknown } }).packet_fields.public_url).toBeNull();
    const republished = await service.publish({ repo, ttl: "1h" });
    expect((republished.packet_fields as { public_url: unknown }).public_url).toBeNull();
    expect((republished.urls as { public: unknown }).public).toBeNull();
    expect((await service.gc()).exposures).toEqual([]);
    expect(relay.logs.filter((event) => event.event === "control" && event.method === "PUT")).toHaveLength(1);
    expect(await service.unexpose(env)).toMatchObject({ unexposed: true, already_revoked: true });
  });

  it("reports the relay's refusals: kill switch and another node's route", async () => {
    const { service, relay, repo } = await relaydHarness();
    const published = await service.publish({ repo, ttl: "1h" });
    const env = published.env as string;
    services.find((item) => item.service === service)?.envs.push(env);
    await relay.admin("POST", "/admin/kill", {});
    await expect(service.expose(env, {})).rejects.toMatchObject({ code: "E_FORBIDDEN", details: { relay_code: "E_KILLED" } });
    await expect(service.publish({ repo, ttl: "1h", public: true })).rejects.toMatchObject({ code: "E_FORBIDDEN", message: expect.stringContaining("but exposing it publicly failed") as string });
    await relay.admin("DELETE", "/admin/kill", {});
    const exposed = await service.expose(env, {});
    const sub = /^https:\/\/([a-z0-9-]+)\./.exec(exposed.url as string)?.[1] ?? "";
    relay.as({ nodeId: "nOTHER1CNTRL", dnsName: "other.tailtest.ts.net" });
    await relay.rewrite({ allow: [{ node_id: FIXTURE.nodeId }, { node_id: "nOTHER1CNTRL" }] });
    await expect(service.unexpose(env)).rejects.toMatchObject({ code: "E_FORBIDDEN", details: { rule: "not_owner" } });
    expect(relay.relayd.state().routes[sub]).toBeDefined();
  });
});
