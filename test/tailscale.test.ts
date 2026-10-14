import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unitSpec } from "../src/daemon-unit.js";
import { getPaths } from "../src/paths.js";
import { debugEnabled, MAC_APP_TAILSCALE, resolveTailscale, runTailscale, tailnetStatus, tailscaleEnvironment, traceTailscale } from "../src/tailscale.js";
import { fakeExecutable, tempDir } from "./helpers.js";

function only(...present: string[]): (file: string) => boolean {
  return (file) => present.includes(file);
}

describe("resolveTailscale", () => {
  const PATH = ["/usr/bin", "/bin"].join(path.delimiter);

  it("prefers NECTAR_TAILSCALE_BIN over everything else", () => {
    expect(resolveTailscale({ env: { PATH, NECTAR_TAILSCALE_BIN: "/custom/tailscale" }, executable: only("/usr/bin/tailscale", MAC_APP_TAILSCALE) })).toEqual({
      path: "/custom/tailscale",
      source: "env",
      searched: [],
    });
  });

  it("uses tailscale on PATH before the app bundle", () => {
    expect(resolveTailscale({ env: { PATH }, executable: only("/bin/tailscale", MAC_APP_TAILSCALE) })).toMatchObject({ path: "/bin/tailscale", source: "path" });
  });

  it("falls back to the macOS app bundle when tailscale is not on PATH", () => {
    const found = resolveTailscale({ env: { PATH }, executable: only(MAC_APP_TAILSCALE, "/opt/homebrew/bin/tailscale") });
    expect(found).toEqual({
      path: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      source: "app-bundle",
      searched: ["/usr/bin/tailscale", "/bin/tailscale", MAC_APP_TAILSCALE],
    });
  });

  it("then tries Homebrew and the standalone install, in that order", () => {
    expect(resolveTailscale({ env: { PATH }, executable: only("/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale") })).toMatchObject({
      path: "/opt/homebrew/bin/tailscale",
      source: "homebrew",
    });
    expect(resolveTailscale({ env: { PATH }, executable: only("/usr/local/bin/tailscale") })).toMatchObject({ path: "/usr/local/bin/tailscale", source: "standalone" });
  });

  it("reports none with a bare command name when nothing is found", () => {
    expect(resolveTailscale({ env: {}, executable: only() })).toEqual({
      path: "tailscale",
      source: "none",
      searched: [MAC_APP_TAILSCALE, "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"],
    });
  });

  it("ignores an empty NECTAR_TAILSCALE_BIN", () => {
    expect(resolveTailscale({ env: { PATH, NECTAR_TAILSCALE_BIN: "" }, executable: only(MAC_APP_TAILSCALE) })).toMatchObject({ source: "app-bundle" });
  });
});

describe("daemon unit tailscale pin", () => {
  const paths = getPaths("/home/u/.nectar");

  it("pins NECTAR_TAILSCALE_BIN to the app bundle when tailscale is not on PATH", () => {
    const spec = unitSpec(paths, "darwin", { env: { PATH: "/usr/bin" }, executable: only(MAC_APP_TAILSCALE) });
    expect(spec.env.NECTAR_TAILSCALE_BIN).toBe(MAC_APP_TAILSCALE);
  });

  it("leaves NECTAR_TAILSCALE_BIN unset when tailscale is on PATH", () => {
    const spec = unitSpec(paths, "darwin", { env: { PATH: "/usr/bin" }, executable: only("/usr/bin/tailscale", MAC_APP_TAILSCALE) });
    expect(spec.env).not.toHaveProperty("NECTAR_TAILSCALE_BIN");
  });
});

describe("tailscale calls", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    traceTailscale(undefined);
  });

  async function fake(source: string): Promise<string> {
    const binary = await fakeExecutable(await tempDir("tailscale-call"), "tailscale", source);
    vi.stubEnv("NECTAR_TAILSCALE_BIN", binary);
    return binary;
  }

  it("reports a call that outlives its budget as a timeout killed by SIGKILL", async () => {
    const binary = await fake("exec sleep 5");
    const events: Array<Record<string, unknown>> = [];
    traceTailscale((event) => events.push(event));
    const run = await runTailscale(["status", "--json"], 200);
    expect(run).toMatchObject({ ok: false, cause: `tailscale status --json via ${binary} (env) timed out after 200ms` });
    expect(events).toEqual([expect.objectContaining({ ok: false, exit_code: null, signal: "SIGKILL", argv: ["status", "--json"] })]);
  });

  it("says why the tailnet is unusable instead of 'unavailable or logged out'", async () => {
    await fake(`printf 'Warning: client version differs\\n{"BackendState":"Running"}\\n'`);
    expect((await tailnetStatus()).reason).toMatch(/printed no status JSON: "Warning: client version differs/);
    await fake(`printf '{"BackendState":"NeedsLogin"}\\n'`);
    expect((await tailnetStatus()).reason).toMatch(/Tailscale is NeedsLogin, not Running/);
    await fake(`printf '{"BackendState":"Running","Self":{}}\\n'`);
    expect((await tailnetStatus()).reason).toMatch(/status JSON has no Self.DNSName/);
    await fake(`printf '{"BackendState":"Running","Self":{"DNSName":"mini03.tail0.ts.net."}}\\n'`);
    expect(await tailnetStatus()).toEqual({ identity: { host: "mini03", dnsName: "mini03.tail0.ts.net" }, api: "cli" });
  });

  it("logs failures always and every call only at debug level", async () => {
    await fake("exit 0");
    const events: Array<Record<string, unknown>> = [];
    traceTailscale((event) => events.push(event));
    await runTailscale(["serve", "--https=8443", "off"], 5_000);
    expect(events).toEqual([]);
    traceTailscale((event) => events.push(event), { all: true });
    await runTailscale(["serve", "--https=8443", "off"], 5_000);
    expect(events).toEqual([expect.objectContaining({ ok: true, exit_code: 0, signal: null, stderr: "" })]);
    expect(debugEnabled({ NECTAR_DEBUG: "1" })).toBe(true);
    expect(debugEnabled({ NECTAR_DEBUG: "0" })).toBe(false);
    expect(debugEnabled({})).toBe(false);
  });

  it("runs the CLI without launchd's job identity and keeps everything else", () => {
    expect(tailscaleEnvironment({ HOME: "/Users/q", PATH: "/usr/bin", XPC_SERVICE_NAME: "com.honeybeehq.nectard", XPC_FLAGS: "0x0", NECTAR_TAILSCALE_BIN: "/x" })).toEqual({
      HOME: "/Users/q",
      PATH: "/usr/bin",
      NECTAR_TAILSCALE_BIN: "/x",
    });
  });
});
