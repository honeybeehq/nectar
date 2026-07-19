import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/commands.js";
import { fakeTailscale, tempDir } from "./helpers.js";

// The --json envelope + exit code IS the product contract for agents, so this
// suite drives the real built CLI, not NectarService.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliEntry = path.join(repoRoot, "dist", "cli.js");
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  const built = await runCommand("pnpm", ["build"], { cwd: repoRoot, timeoutMs: 120_000 });
  if (built.exitCode !== 0) throw new Error(`build failed: ${built.stderr}`);
  const state = await tempDir("cli-state");
  const fakeDir = await tempDir("cli-bin");
  const tailscale = await fakeTailscale(fakeDir);
  env = {
    ...process.env,
    NECTAR_HOME: state,
    NECTAR_TAILSCALE_BIN: tailscale.binary,
    FAKE_TS_LOG: tailscale.log,
  };
}, 120_000);

async function cli(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runCommand(process.execPath, [cliEntry, ...args], { env, cwd: repoRoot, timeoutMs: 30_000 });
}

function envelope(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  const keys = Object.keys(parsed).sort();
  expect([["command", "error", "ok"], ["command", "ok", "result"]]).toContainEqual(keys);
  return parsed;
}

describe("cli --json contract", () => {
  it("emits a success envelope with exit 0", async () => {
    const result = await cli("ls", "--json");
    expect(result.exitCode).toBe(0);
    expect(envelope(result.stdout)).toMatchObject({ ok: true, command: "ls", result: { envs: [] } });
  });

  it("emits an error envelope with exit 1 for a missing env", async () => {
    const result = await cli("show", "missing--env--web", "--json");
    expect(result.exitCode).not.toBe(0);
    expect(envelope(result.stdout)).toMatchObject({ ok: false, command: "show", error: { code: "E_NOT_FOUND" } });
  });

  it("maps argv-level failures to E_USAGE envelopes", async () => {
    const unknownCommand = await cli("bogus", "--json");
    expect(unknownCommand.exitCode).not.toBe(0);
    expect(envelope(unknownCommand.stdout)).toMatchObject({ ok: false, error: { code: "E_USAGE" } });

    const unknownOption = await cli("ls", "--wat", "--json");
    expect(unknownOption.exitCode).not.toBe(0);
    expect(envelope(unknownOption.stdout)).toMatchObject({ ok: false, command: "ls", error: { code: "E_USAGE" } });

    const badTtl = await cli("publish", "--ttl", "bogus", "--json");
    expect(badTtl.exitCode).not.toBe(0);
    expect(envelope(badTtl.stdout)).toMatchObject({ ok: false, command: "publish", error: { code: "E_USAGE" } });
  });

  it("answers bare `nectar --json` with a clean E_USAGE envelope, not help text", async () => {
    const result = await cli("--json");
    expect(result.exitCode).not.toBe(0);
    const parsed = envelope(result.stdout);
    expect(parsed).toMatchObject({ ok: false, error: { code: "E_USAGE" } });
    expect((parsed.error as { message: string }).message).toContain("No command");
  });

  it("keeps explicit --help human-readable with exit 0", async () => {
    const result = await cli("--help", "--json");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage");
  });
});
