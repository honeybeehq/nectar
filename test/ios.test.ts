import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NectarService } from "../src/service.js";
import { extractTestpack } from "../src/testpack.js";
import { fakeExecutable, fakeTailscale, initGitRepo, tempDir } from "./helpers.js";

const services: Array<{ service: NectarService; envs: string[] }> = [];

afterEach(async () => {
  for (const item of services.splice(0)) {
    for (const env of item.envs) await item.service.stop(env).catch(() => undefined);
  }
  vi.unstubAllEnvs();
});

async function harness(): Promise<{ service: NectarService; state: string; fakeDir: string; simLog: string; launchLog: string }> {
  const state = await tempDir("ios-state");
  const fakeDir = await tempDir("ios-bin");
  const tailscale = await fakeTailscale(fakeDir);
  const simLog = path.join(fakeDir, "sim.log");
  const launchLog = path.join(fakeDir, "launch.log");
  const xcrun = await fakeExecutable(
    fakeDir,
    "xcrun",
    `
[ "$1" = "simctl" ] || exit 1
shift
printf 'simctl %s\\n' "$*" >> "$FAKE_SIM_LOG"
case "$1" in
  list)
    case "$2" in
      runtimes) printf '{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-5","version":"26.5","name":"iOS 26.5","isAvailable":true}]}\\n';;
      devicetypes) printf '{"devicetypes":[{"name":"iPhone 17","identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"}]}\\n';;
      devices) printf '{"devices":{}}\\n';;
    esac
    ;;
  create) printf 'FAKE-UDID-0001\\n';;
esac
exit 0
`,
  );
  // The backgrounded subshell forks with the launcher's argv (which includes the
  // entry path), so findAppPid's pgrep -f can discover it like a real app process.
  const launcher = await fakeExecutable(
    fakeDir,
    "launch",
    `printf '%s\\n' "$*" >> "$FAKE_LAUNCH_LOG"\n( sleep 5; : ) >/dev/null 2>&1 &`,
  );
  const trash = await fakeExecutable(fakeDir, "trash", `for target in "$@"; do mv "$target" "$target.trash.$$"; done`);
  const serveSim = path.join(fakeDir, "fake-serve-sim.mjs");
  await writeFile(
    serveSim,
    `
import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("sim-stream");
}).listen(port, "127.0.0.1");
`,
  );
  // Own port range so this suite never contends with integration.test's 4099-41xx.
  await writeFile(
    path.join(state, "nectar.json"),
    JSON.stringify({ upstream_port_start: 4300, upstream_port_end: 4399, pack_server_port: 4299 }),
  );
  vi.stubEnv("NECTAR_HOME", state);
  vi.stubEnv("NECTAR_TAILSCALE_BIN", tailscale.binary);
  vi.stubEnv("FAKE_TS_LOG", tailscale.log);
  vi.stubEnv("NECTAR_XCRUN_BIN", xcrun);
  vi.stubEnv("FAKE_SIM_LOG", simLog);
  vi.stubEnv("NECTAR_LAUNCH_BIN", launcher);
  vi.stubEnv("FAKE_LAUNCH_LOG", launchLog);
  vi.stubEnv("NECTAR_TRASH_BIN", trash);
  vi.stubEnv("NECTAR_SERVE_SIM_BIN", `node ${serveSim}`);
  vi.stubEnv("NECTAR_AX_PID_TIMEOUT_MS", "2000");
  const service = new NectarService(state);
  services.push({ service, envs: [] });
  return { service, state, fakeDir, simLog, launchLog };
}

function track(service: NectarService, ...envs: string[]): void {
  services.find((item) => item.service === service)?.envs.push(...envs);
}

const packScript = `
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const root = process.env.NECTAR_PACK_OUT;
await mkdir(path.join(root, "app", "Dummy.app"), { recursive: true });
await writeFile(path.join(root, "app", "Dummy.app", "binary"), "fake");
await writeFile(path.join(root, "testpack.json"), JSON.stringify({ testpack: 1, entry: "app/Dummy.app" }));
`;

const iosToml = (extra = ""): string => `
name = "fixture-ios"
[ios]
pack = "node pack.mjs"
bundle_id = "no.trmd.dummy"
${extra}
`;

describe("ios publish", () => {
  it("packs a simpack, drives simctl, streams via serve-sim, and exposes ax_url", async () => {
    const { service, state, simLog } = await harness();
    const repo = await initGitRepo({ "nectar.toml": iosToml(), "pack.mjs": packScript });

    const result = await service.publish({ repo, ttl: "1h" });
    const env = "fixture-ios--main--ios";
    track(service, env);
    expect(result.env).toBe(env);
    expect(result.packet_fields).toEqual({
      preview_url: "https://fixture.tailtest.ts.net:8443",
      testpack_ref: `nectar://fixture/${env}`,
      shell_recipe: null,
    });
    expect(result.sim_udid).toBe("FAKE-UDID-0001");
    expect(result.ax_url).toBe("https://fixture.tailtest.ts.net:8443/ax");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    // Fetch whatever upstream port the allocator picked — asserting a fixed port races
    // against anything else on the machine holding the low end of the range.
    const published = (await service.show(env)).env as { serve: { upstream_port: number } };
    expect(await fetch(`http://127.0.0.1:${published.serve.upstream_port}/`).then(async (response) => response.text())).toBe("sim-stream");

    const sim = await readFile(simLog, "utf8");
    expect(sim).toContain("simctl create nectar-fixture-ios--main--ios com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-5");
    expect(sim).toContain("simctl bootstatus FAKE-UDID-0001 -b");
    expect(sim).toMatch(/simctl install FAKE-UDID-0001 .*app\/Dummy\.app/);
    expect(sim).toContain("simctl launch FAKE-UDID-0001 no.trmd.dummy");

    const resolved = await service.resolve(`nectar://fixture/${env}`);
    expect(resolved).toMatchObject({
      mode: "ios",
      bundle_id: "no.trmd.dummy",
      is_self: true,
      ax_url: "http://127.0.0.1:4300/ax",
      platform: "ios-sim-arm64",
    });

    const record = (await service.show(env)).env as { testpack: { file: string } };
    const extracted = await extractTestpack(path.join(state, "packs", env, record.testpack.file), await tempDir("simpack"));
    const manifest = JSON.parse(await readFile(path.join(extracted, "testpack.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      testpack: 1,
      kind: "ios-sim",
      platform: "ios-sim-arm64",
      bundle_id: "no.trmd.dummy",
      entry: "app/Dummy.app",
    });

    await service.stop(env);
    expect(await readFile(simLog, "utf8")).toContain("simctl shutdown FAKE-UDID-0001");
    await service.remove(env);
    expect(await readFile(simLog, "utf8")).toContain("simctl delete FAKE-UDID-0001");
  });

  it("degrades to simpack-only when serve-sim fails (F12)", async () => {
    const { service, fakeDir, simLog } = await harness();
    const broken = await fakeExecutable(fakeDir, "serve-sim-broken", "exit 1");
    vi.stubEnv("NECTAR_SERVE_SIM_BIN", broken);
    const repo = await initGitRepo({
      "nectar.toml": iosToml(`ready_timeout = "300ms"`),
      "pack.mjs": packScript,
    });
    const result = await service.publish({ repo, ttl: "1h" });
    const env = "fixture-ios--main--ios";
    track(service, env);
    expect(result.packet_fields).toMatchObject({ preview_url: null, testpack_ref: `nectar://fixture/${env}` });
    expect(result.ax_url).toBeNull();
    expect(result.warnings).toEqual([expect.stringContaining("degraded to simpack-only")]);
    const record = (await service.show(env)).env as { status: string; serve?: unknown };
    expect(record.status).toBe("serving");
    expect(record.serve).toBeUndefined();
    // The app still got installed and launched into the simulator before the stream failed.
    expect(await readFile(simLog, "utf8")).toContain("simctl launch FAKE-UDID-0001 no.trmd.dummy");
  });

  it("opens an ios env into a scratch simulator on a sim-capable host", async () => {
    const { service, simLog } = await harness();
    const repo = await initGitRepo({ "nectar.toml": iosToml(), "pack.mjs": packScript });
    const result = await service.publish({ repo, ttl: "1h" });
    track(service, result.env as string);
    const opened = await service.open(result.ref as string);
    expect(opened).toMatchObject({ surface: "simulator", sim_udid: "FAKE-UDID-0001", cache_hit: false });
    expect(await readFile(simLog, "utf8")).toContain("simctl create nectar-open");
    const streamed = await (async () => {
      vi.stubEnv("NECTAR_IOS_OPEN", "stream");
      return service.open(result.ref as string);
    })();
    expect(streamed).toMatchObject({ surface: "stream", opened: "http://127.0.0.1:4300" });
  });
});

describe("desktop open ax bridge", () => {
  it("starts the AX bridge and returns ax_url", async () => {
    const { service, fakeDir } = await harness();
    const helper = await fakeExecutable(
      fakeDir,
      "ax-helper",
      `printf '{"screen":{"width":1,"height":1},"elements":[]}\\n'\nwhile :; do sleep 1; done`,
    );
    // Like the real bridge, the fake must die with the watched app pid — otherwise it
    // outlives the test run and squats on the upstream port range for the next one.
    const bridgeEntry = path.join(fakeDir, "fake-bridge.mjs");
    await writeFile(
      bridgeEntry,
      `
import http from "node:http";
const [pid, port] = [Number(process.argv[2]), Number(process.argv[3])];
http.createServer((_request, response) => { response.writeHead(200); response.end("bridge"); }).listen(port, "127.0.0.1");
setInterval(() => { try { process.kill(pid, 0); } catch { process.exit(0); } }, 250);
`,
    );
    vi.stubEnv("NECTAR_AX_HELPER", helper);
    vi.stubEnv("NECTAR_AX_BRIDGE_ENTRY", bridgeEntry);
    const repo = await initGitRepo({
      "nectar.toml": `name = "fixture-axd"\n[desktop]\npack = "node pack.mjs"\nkind = "electron"\n`,
      "pack.mjs": packScript,
    });
    const result = await service.publish({ repo, mode: "desktop", ttl: "1h" });
    const env = "fixture-axd--main--desktop";
    track(service, env);
    const opened = await service.open(result.ref as string);
    expect(opened.ax_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ax$/);
    const url = new URL(opened.ax_url as string);
    expect(await fetch(`http://127.0.0.1:${url.port}/`).then(async (response) => response.text())).toBe("bridge");
    const noAx = await service.open(result.ref as string, { noAx: true });
    expect(noAx.ax_url).toBeUndefined();
    expect(opened.ax_pid).toBeGreaterThan(1);
    try {
      process.kill(-(opened.ax_pid as number), "SIGKILL");
    } catch {
      // Already exited with the fake app.
    }
  });
});
