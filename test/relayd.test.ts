import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, parseLegacyRoute, renderRoute, reservedName, sanitizeName, type Route } from "../src/relayd.js";
import { RELAY_SELF, testHash, testRelayd, type TestRelayd } from "./helpers.js";

const A = { nodeId: "nAAAAAAA1CNTRL", dnsName: "trmd-metal-2.tail1234.ts.net" };
const B = { nodeId: "nBBBBBBB1CNTRL", dnsName: "trmd-metal-3.tail1234.ts.net" };
const STRANGER = { nodeId: "nSTRANGER1CNTRL", dnsName: "someone-else.tail1234.ts.net" };
const running: TestRelayd[] = [];

afterEach(async () => {
  for (const item of running.splice(0)) await item.relayd.close();
});

async function relay(config: Record<string, unknown> = {}, deps: Parameters<typeof testRelayd>[1] = {}): Promise<TestRelayd> {
  const started = await testRelayd({ allow: [{ node_id: A.nodeId, name: "trmd-metal-2" }, { node_id: B.nodeId, name: "trmd-metal-3" }], ...config }, deps);
  running.push(started);
  return started;
}

function epoch(relayd: TestRelayd, ms: number): number {
  return Math.floor((relayd.clock.now + ms) / 1000);
}

async function create(relayd: TestRelayd, extra: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  relayd.as(A);
  return relayd.call("PUT", "/routes", { name: "web-main", upstream: `https://${A.dnsName}:8443`, expires_at: epoch(relayd, 3_600_000), gate: "password", ...extra });
}

describe("relayd authentication", () => {
  it("refuses every request when tailscaled WhoIs fails, throws or names no node, and refuses the relay itself", async () => {
    const relayd = await relay();
    relayd.as("is not a tailnet peer");
    expect(await relayd.call("GET", "/routes?mine=1")).toMatchObject({ status: 403, body: { ok: false, error: { code: "E_FORBIDDEN", rule: "whois" } } });
    relayd.as(new Error("socket closed"));
    expect(await relayd.call("PUT", "/routes", { name: "x" })).toMatchObject({ status: 403, body: { error: { rule: "whois" } } });
    relayd.as({ nodeId: "", dnsName: A.dnsName });
    expect((await relayd.call("GET", "/routes?mine=1")).status).toBe(403);
    relayd.as({ nodeId: A.nodeId, dnsName: "" });
    expect((await relayd.call("GET", "/routes?mine=1")).status).toBe(403);
    relayd.as({ nodeId: RELAY_SELF.nodeId, dnsName: "trmd-vps01.tail1234.ts.net" });
    expect(await relayd.call("GET", "/routes?mine=1")).toMatchObject({ status: 403, body: { error: { rule: "self" } } });
    const refused = relayd.logs.filter((event) => event.event === "control" && event.status === 403);
    expect(refused.length).toBe(5);
    expect(JSON.stringify((await relayd.call("GET", "/routes?mine=1")).body)).not.toContain("whois");
  });

  it("refuses nodes off the stable-node-ID allowlist, even with an allowed node's name", async () => {
    const relayd = await relay();
    relayd.as(STRANGER);
    expect(await relayd.call("GET", "/routes?mine=1")).toMatchObject({ status: 403, body: { error: { rule: "not_allowed", node_id: STRANGER.nodeId } } });
    relayd.as({ nodeId: STRANGER.nodeId, dnsName: A.dnsName });
    expect((await relayd.call("PUT", "/routes", { name: "web-main", upstream: `https://${A.dnsName}:8443`, expires_at: epoch(relayd, 60_000), gate: "password" })).status).toBe(403);
    expect(Object.keys(relayd.relayd.state().routes)).toEqual([]);
  });

  it("refuses everyone when the allowlist cannot be read", async () => {
    const relayd = await relay();
    await writeFile(relayd.configFile, "{ not json");
    relayd.as(A);
    expect(await relayd.call("GET", "/routes?mine=1")).toMatchObject({ status: 403, body: { error: { rule: "config" } } });
  });

  it("binds the verify listener on loopback only and answers for live routes", async () => {
    const relayd = await relay();
    const made = await create(relayd);
    expect(relayd.relayd.verify.address).toBe("127.0.0.1");
    const ask = (host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: relayd.relayd.verify.port, path: "/verify", headers: { "x-forwarded-host": host } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }).on("error", reject);
      });
    expect(await ask(`${String(made.body.sub)}.nctr.site`)).toBe(204);
    expect(await ask("nothing-here.nctr.site")).toBe(404);
  });
});

describe("relayd authorization", () => {
  it("creates a route with a relay-minted name, records its owner and renders the Caddy file", async () => {
    const relayd = await relay();
    const made = await create(relayd);
    expect(made.status).toBe(201);
    const sub = String(made.body.sub);
    expect(sub).toMatch(/^web-main-[0-9a-f]{8}$/);
    expect(made.body.url).toBe(`https://${sub}.nctr.site`);
    expect(typeof made.body.password).toBe("string");
    const route = relayd.relayd.state().routes[sub];
    expect(route?.owner).toEqual({ node_id: A.nodeId, node_name: "trmd-metal-2" });
    expect(route?.upstream).toBe(`https://${A.dnsName}:8443`);
    const file = await readFile(path.join(relayd.routesDir, `${sub}.caddy`), "utf8");
    expect(file).toBe(
      [
        "# nectar-relayd route — do not edit by hand",
        `# expires ${epoch(relayd, 3_600_000)}`,
        `# upstream https://${A.dnsName}:8443`,
        `# owner ${A.nodeId}`,
        `@${sub} host ${sub}.nctr.site`,
        `handle @${sub} {`,
        "    basic_auth {",
        `        reviewer ${testHash(String(made.body.password))}`,
        "    }",
        `    reverse_proxy https://${A.dnsName}:8443 {`,
        "        header_up -Authorization",
        "        transport http {",
        "            tls",
        "        }",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    expect(file).not.toContain(String(made.body.password));
    expect(JSON.stringify(relayd.relayd.state())).not.toContain(String(made.body.password));
    expect(JSON.stringify(relayd.logs)).not.toContain(String(made.body.password));
    expect(existsSync(path.join(relayd.dir, "reload.stamp"))).toBe(true);
  });

  it("refuses an upstream on another host, a non-preview port, plain http, userinfo or a path", async () => {
    const relayd = await relay();
    relayd.as(A);
    const put = (upstream: string): Promise<{ status: number; body: Record<string, unknown> }> =>
      relayd.call("PUT", "/routes", { name: "evil-main", upstream, expires_at: epoch(relayd, 60_000), gate: "password" });
    expect(await put(`https://${B.dnsName}:8443`)).toMatchObject({ status: 403, body: { error: { rule: "upstream_host" } } });
    expect(await put(`https://${A.dnsName}:22`)).toMatchObject({ status: 403, body: { error: { rule: "upstream_port" } } });
    expect(await put(`https://${A.dnsName}:8442`)).toMatchObject({ status: 403, body: { error: { rule: "upstream_port" } } });
    expect(await put(`https://${A.dnsName}:8543`)).toMatchObject({ status: 403, body: { error: { rule: "upstream_port" } } });
    for (const upstream of [`http://${A.dnsName}:8443`, `https://x@${A.dnsName}:8443`, `https://${A.dnsName}:8443/admin`, `https://${A.dnsName}`, "https://100.64.0.2:8443", `https://${A.dnsName}.evil.com:8443`]) {
      expect((await put(upstream)).status).toBe(403);
    }
    expect(Object.keys(relayd.relayd.state().routes)).toEqual([]);
    expect(await readdir(relayd.routesDir)).toEqual([]);
  });

  it("mints its own names: no chosen sub, no reserved or punycode names, no takeover of an existing URL", async () => {
    const relayd = await relay();
    relayd.as(A);
    const put = (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> =>
      relayd.call("PUT", "/routes", { upstream: `https://${A.dnsName}:8443`, expires_at: epoch(relayd, 60_000), gate: "password", ...body });
    for (const name of ["www", "admin-panel", "Login", "api-main", "---"]) {
      expect((await put({ name })).status).toBeGreaterThanOrEqual(400);
    }
    expect(String((await put({ name: "xn--80ak6aa92e-main" })).body.sub)).toMatch(/^xn-80ak6aa92e-main-[0-9a-f]{8}$/);
    expect((await put({ name: "web-main", sub: "web-main" })).status).toBe(400);
    const first = await put({ name: "web-main" });
    const second = await put({ name: "web-main" });
    expect(first.body.sub).not.toBe(second.body.sub);
    relayd.as(B);
    const squat = await relayd.call("PUT", "/routes", { name: String(first.body.sub), upstream: `https://${B.dnsName}:8443`, expires_at: epoch(relayd, 60_000), gate: "password" });
    expect(squat.status).toBe(201);
    expect(squat.body.sub).not.toBe(first.body.sub);
    expect(relayd.relayd.state().routes[String(first.body.sub)]?.owner.node_id).toBe(A.nodeId);
    expect(sanitizeName("Agent/Coupons_Fix!!")).toBe("agent-coupons-fix");
    expect(sanitizeName("a".repeat(80)).length).toBeLessThanOrEqual(54);
    expect(reservedName("www")).toBe(true);
    expect(reservedName("shop-main")).toBe(false);
  });

  it("lets only the owner PATCH, DELETE or rotate a route", async () => {
    const relayd = await relay();
    const made = await create(relayd);
    const sub = String(made.body.sub);
    relayd.as(B);
    expect(await relayd.call("PATCH", `/routes/${sub}`, { expires_at: epoch(relayd, 7_200_000) })).toMatchObject({ status: 403, body: { error: { rule: "not_owner" } } });
    expect((await relayd.call("DELETE", `/routes/${sub}`)).status).toBe(403);
    expect((await relayd.call("POST", `/routes/${sub}/rotate`)).status).toBe(403);
    expect((await relayd.call("GET", "/routes?mine=1")).body.routes).toEqual([]);
    expect((await relayd.call("GET", "/routes")).status).toBe(400);
    expect(relayd.relayd.state().routes[sub]?.generation).toBe(1);
    relayd.as(A);
    const rotated = await relayd.call("POST", `/routes/${sub}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.password).not.toBe(made.body.password);
    expect(rotated.body.generation).toBe(2);
    expect(await readFile(path.join(relayd.routesDir, `${sub}.caddy`), "utf8")).toContain(testHash(String(rotated.body.password)));
    expect((await relayd.call("GET", "/routes?mine=1")).body.routes).toMatchObject([{ sub, revoked: false, last_view_at: null }]);
    expect(await relayd.call("DELETE", `/routes/${sub}`)).toMatchObject({ status: 200, body: { removed: true } });
    expect(existsSync(path.join(relayd.routesDir, `${sub}.caddy`))).toBe(false);
  });

  it("allows ungated routes only for nodes on the ungated list, and caps them at 7 days", async () => {
    const relayd = await relay();
    expect(await create(relayd, { gate: "none" })).toMatchObject({ status: 403, body: { error: { rule: "ungated" } } });
    await relayd.rewrite({ ungated: [{ node_id: A.nodeId }] });
    const open = await create(relayd, { gate: "none", expires_at: epoch(relayd, 90 * 86_400_000) });
    expect(open.status).toBe(201);
    expect(open.body.password).toBeUndefined();
    expect(Date.parse(String(open.body.expires_at))).toBe(relayd.clock.now + 7 * 86_400_000);
    const gated = await create(relayd, { expires_at: epoch(relayd, 90 * 86_400_000) });
    expect(Date.parse(String(gated.body.expires_at))).toBe(relayd.clock.now + 30 * 86_400_000);
    relayd.as(A);
    const patched = await relayd.call("PATCH", `/routes/${String(gated.body.sub)}`, { expires_at: epoch(relayd, 365 * 86_400_000) });
    expect(Date.parse(String(patched.body.expires_at))).toBe(relayd.clock.now + 30 * 86_400_000);
    const file = await readFile(path.join(relayd.routesDir, `${String(open.body.sub)}.caddy`), "utf8");
    expect(file).not.toContain("basic_auth");
  });

  it("PATCH updates in place and never recreates a removed or revoked route", async () => {
    const relayd = await relay();
    const made = await create(relayd);
    const sub = String(made.body.sub);
    relayd.as(A);
    const later = epoch(relayd, 5 * 3_600_000);
    expect(await relayd.call("PATCH", `/routes/${sub}`, { expires_at: later })).toMatchObject({ status: 200, body: { sub, expires_at: new Date(later * 1000).toISOString() } });
    expect(await readFile(path.join(relayd.routesDir, `${sub}.caddy`), "utf8")).toContain(`# expires ${later}`);
    await relayd.call("DELETE", `/routes/${sub}`);
    expect((await relayd.call("PATCH", `/routes/${sub}`, { expires_at: later })).status).toBe(404);
    const again = await create(relayd);
    const other = String(again.body.sub);
    expect(await relayd.admin("DELETE", `/admin/routes/${other}`)).toMatchObject({ status: 200, body: { removed: true } });
    relayd.as(A);
    expect(await relayd.call("PATCH", `/routes/${other}`, { expires_at: later })).toMatchObject({ status: 404, body: { error: { revoked: true, reason: "admin" } } });
    expect((await relayd.call("GET", "/routes?mine=1")).body.routes).toEqual([expect.objectContaining({ sub: other, revoked: true, reason: "admin" })]);
    expect(relayd.relayd.state().routes).toEqual({});
    expect(await readdir(relayd.routesDir)).toEqual([]);
  });
});

describe("relayd kill switch and prune", () => {
  it("disable-all removes every route and refuses new ones until lifted; per node too", async () => {
    const relayd = await relay();
    const first = await create(relayd);
    relayd.as(B);
    await relayd.call("PUT", "/routes", { name: "b-main", upstream: `https://${B.dnsName}:8450`, expires_at: epoch(relayd, 60_000), gate: "password" });
    expect(await relayd.admin("POST", "/admin/kill", {})).toMatchObject({ status: 200, body: { disabled: true } });
    expect(await readdir(relayd.routesDir)).toEqual([]);
    expect(await create(relayd)).toMatchObject({ status: 403, body: { error: { code: "E_KILLED" } } });
    relayd.as(A);
    expect((await relayd.call("GET", "/routes?mine=1")).body).toMatchObject({ killed: true, routes: [{ sub: first.body.sub, revoked: true, reason: "kill" }] });
    await relayd.admin("DELETE", "/admin/kill", {});
    expect((await create(relayd)).status).toBe(201);

    expect(await relayd.admin("POST", "/admin/kill", { node: "trmd-metal-2" })).toMatchObject({ status: 200, body: { node: { node_id: A.nodeId } } });
    expect(await create(relayd)).toMatchObject({ status: 403, body: { error: { code: "E_KILLED" } } });
    relayd.as(B);
    expect((await relayd.call("PUT", "/routes", { name: "b-main", upstream: `https://${B.dnsName}:8443`, expires_at: epoch(relayd, 60_000), gate: "password" })).status).toBe(201);
    expect((await relayd.admin("POST", "/admin/kill", { node: "no-such-node" })).status).toBe(404);
    await relayd.admin("DELETE", "/admin/kill", { node: A.nodeId });
    expect((await create(relayd)).status).toBe(201);
  });

  it("prune removes expired routes, keeps a tombstone, and survives a restart of relayd", async () => {
    const relayd = await relay();
    const made = await create(relayd, { expires_at: epoch(relayd, 60_000) });
    relayd.clock.now += 120_000;
    expect(await relayd.relayd.prune()).toBe(1);
    expect(await readdir(relayd.routesDir)).toEqual([]);
    relayd.as(A);
    expect((await relayd.call("GET", "/routes?mine=1")).body.routes).toEqual([expect.objectContaining({ sub: made.body.sub, revoked: true, reason: "expired" })]);
    const kept = await create(relayd);
    await relayd.relayd.close();
    running.splice(running.indexOf(relayd), 1);
    const again = await testRelayd({ ...relayd.config }, {});
    running.push(again);
    expect(Object.keys(again.relayd.state().routes)).toEqual([kept.body.sub]);
  });

  it("refuses a route the reload rejects and leaves no file behind", async () => {
    const relayd = await relay({ reload: { argv: ["false"] } });
    expect(await create(relayd)).toMatchObject({ status: 502, body: { error: { code: "E_RELOAD" } } });
    expect(relayd.relayd.state().routes).toEqual({});
    expect(await readdir(relayd.routesDir)).toEqual([]);
  });

  it("imports routes the old nectar-relay wrote, and serves the old ssh path's add/rm through the admin socket", async () => {
    const legacy = [
      "# nectar-relay route — do not edit by hand",
      "# expires 1999999999",
      "# upstream https://trmd-studio.tail1234.ts.net:8443",
      "@studio-main-e7f3 host studio-main-e7f3.nctr.site",
      "handle @studio-main-e7f3 {",
      "    basic_auth {",
      `        reviewer ${testHash("legacy-password")}`,
      "    }",
      "}",
    ].join("\n");
    const relayd = await testRelayd({}, {});
    await relayd.relayd.close();
    await writeFile(path.join(relayd.routesDir, "studio-main-e7f3.caddy"), legacy);
    const again = await testRelayd({ ...relayd.config }, {});
    running.push(again);
    expect(again.relayd.state().routes["studio-main-e7f3"]).toMatchObject({ owner: { node_id: "admin" }, gate: "password", expires_at: 1999999999000 });
    expect(await readFile(path.join(again.routesDir, "studio-main-e7f3.caddy"), "utf8")).toContain("# owner admin");
    const added = await again.admin("POST", "/admin/routes", { sub: "studio-other-1234", upstream: "https://trmd-studio.tail1234.ts.net:8444", expires_at: 1999999999, gate: "password", password: "a-long-enough-password" });
    expect(added).toMatchObject({ status: 201, body: { url: "https://studio-other-1234.nctr.site" } });
    expect((await again.admin("GET", "/admin/routes")).body.routes).toHaveLength(2);
    expect(await again.admin("DELETE", "/admin/routes/studio-other-1234")).toMatchObject({ status: 200 });
    expect(parseLegacyRoute("Bad_Sub", legacy, 0)).toBeUndefined();
  });
});

describe("relayd config and rendering", () => {
  it("rejects malformed config and refuses to render unsafe routes", () => {
    expect(() => parseConfig(JSON.stringify({ domain: "nctr.site" }))).toThrow(/state_dir/);
    expect(() => parseConfig(JSON.stringify({ domain: "NCTR site", state_dir: "/s", routes_dir: "/r", admin_socket: "/a" }))).toThrow(/domain/);
    expect(() => parseConfig(JSON.stringify({ domain: "nctr.site", state_dir: "/s", routes_dir: "/r", admin_socket: "/a", allow: [{ name: "x" }] }))).toThrow(/node_id/);
    expect(() => parseConfig(JSON.stringify({ domain: "nctr.site", state_dir: "/s", routes_dir: "/r", admin_socket: "/a", control: { address: "0.0.0.0:1" } }))).toThrow(/address/);
    const route: Route = {
      sub: "ok-main-01020304",
      owner: { node_id: "n1", node_name: "a" },
      upstream: "https://a.b.ts.net:8443",
      gate: "password",
      password_hash: "x\n}\nimport /etc/passwd",
      created_at: 0,
      expires_at: 1000,
      cap_at: 1000,
      generation: 1,
      last_view_at: null,
    };
    expect(() => renderRoute(route, "nctr.site")).toThrow();
    expect(() => renderRoute({ ...route, gate: "none", upstream: "https://a.b.ts.net:8443 {\n}" }, "nctr.site")).toThrow();
    expect(() => renderRoute({ ...route, gate: "none", sub: "../etc" }, "nctr.site")).toThrow();
  });

  it("refuses to bind the control listener on a wildcard address", async () => {
    const relayd = await testRelayd({}, { bind: "0.0.0.0" });
    running.push(relayd);
    expect(relayd.relayd.control).toBeNull();
    expect(relayd.logs).toContainEqual(expect.objectContaining({ event: "control_unbound" }));
  });
});
