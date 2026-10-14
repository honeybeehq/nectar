import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "../src/commands.js";
import { fakeExecutable, fakeTailscale, initGitRepo, tempDir } from "./helpers.js";

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

async function cliWith(extra: NodeJS.ProcessEnv, ...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runCommand(process.execPath, [cliEntry, ...args], { env: { ...env, ...extra }, cwd: repoRoot, timeoutMs: 30_000 });
}

async function staticSite(): Promise<string> {
  const site = await tempDir("cli-site");
  await writeFile(path.join(site, "index.html"), "<h1>proof</h1>\n");
  return site;
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

  it("accepts dev publish mode and emits the dev packet reference", async () => {
    const repo = await initGitRepo({
      "nectar.toml": `name = "cli-dev"\n[dev]\nrun = "node dev.mjs"\nkind = "electron"\n`,
      "dev.mjs": `setInterval(() => {}, 1000);\n`,
    });
    const result = await cli("--repo", repo, "publish", "--mode", "dev", "--json");
    expect(result.exitCode).toBe(0);
    expect(envelope(result.stdout)).toMatchObject({
      ok: true,
      command: "publish",
      result: {
        env: "cli-dev--main--dev",
        mode: "dev",
        status: "warm",
        packet_fields: {
          preview_url: null,
          testpack_ref: null,
          dev_ref: "nectar://fixture/cli-dev--main--dev",
          shell_recipe: null,
        },
      },
    });
  });

  it("resolve carries publish's ref, packet_fields and expiry under stable names", async () => {
    const published = envelope((await cli("publish", await staticSite(), "--name", "cli-resolve", "--json")).stdout).result as Record<string, unknown>;
    const name = published.env as string;
    try {
      const resolved = await cli("resolve", name, "--json");
      expect(resolved.exitCode).toBe(0);
      const result = envelope(resolved.stdout).result as Record<string, unknown>;
      expect(Object.keys(result).sort()).toEqual(
        [
          "env",
          "ref",
          "mode",
          "commit",
          "current_commit",
          "stale",
          "is_self",
          "urls",
          "testpack_url",
          "sha256",
          "size_bytes",
          "platform",
          "entry",
          "bundle_id",
          "ax_url",
          "host",
          "status",
          "liveness",
          "packet_fields",
          "expires_at",
          "expires_in",
        ].sort(),
      );
      expect(Object.keys(result.packet_fields as object).sort()).toEqual(["dev_ref", "preview_url", "public_url", "shell_recipe", "testpack_ref"]);
      expect(result.ref).toBe(published.ref);
      expect(result.packet_fields).toEqual(published.packet_fields);
      expect(result.packet_fields).toMatchObject({ preview_url: (published.urls as { mesh: string }).mesh, public_url: null });
      expect(Date.parse(result.expires_at as string)).toBeGreaterThanOrEqual(Date.parse(published.expires_at as string));
      expect(result.expires_in).toMatch(/^\d+[dhms]/);
    } finally {
      await cli("rm", name, "--force", "--json");
    }
  });

  it("quotes tailscale's serve denial in the warning and mesh_error instead of blaming a logged-out tailnet", async () => {
    const fakeDir = await tempDir("cli-denied");
    const denied = await fakeExecutable(
      fakeDir,
      "tailscale",
      `if [ "$1" = "status" ]; then printf '{"BackendState":"Running","Self":{"DNSName":"fixture.tailtest.ts.net."}}\\n'; exit 0; fi
if [ "$1" = "serve" ] && [ "$2" = "status" ]; then printf '{}\\n'; exit 0; fi
if [ "$1" = "serve" ]; then
  printf 'sending serve config: Access denied: serve config denied\\n\\nUse '"'"'sudo tailscale serve %s'"'"'.\\nTo not require root, use '"'"'sudo tailscale set --operator=$USER'"'"' once.\\n' "$*" >&2
  exit 1
fi
exit 0`,
    );
    const published = await cliWith({ NECTAR_TAILSCALE_BIN: denied }, "publish", await staticSite(), "--name", "cli-denied", "--json");
    const result = envelope(published.stdout).result as { env: string; urls: { mesh: string | null }; mesh_error: string; warnings: string[] };
    try {
      expect(published.exitCode).toBe(0);
      expect(result.urls.mesh).toBeNull();
      expect(result.mesh_error).toContain("Access denied: serve config denied");
      const warning = result.warnings.find((line) => line.startsWith("tailscale serve was denied"));
      expect(warning).toContain("sudo tailscale set --operator=$USER");
      expect(result.warnings.join("\n")).not.toContain("logged out");
    } finally {
      await cliWith({ NECTAR_TAILSCALE_BIN: denied }, "rm", result.env, "--force", "--json");
    }
  });

  it("recognizes open --target/--keep and publish --verify as contract flags", async () => {
    const missing = await cli("open", "missing--main--dev", "--target", "review:settings", "--keep", "--json");
    expect(missing.exitCode).not.toBe(0);
    expect(envelope(missing.stdout)).toMatchObject({
      ok: false,
      command: "open",
      error: { code: "E_NOT_FOUND" },
    });

    const help = await cli("open", "--help", "--json");
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--target <string>");
    expect(help.stdout).toContain("--keep");

    const webRepo = await initGitRepo({
      "package.json": JSON.stringify({ name: "verify-web", scripts: { dev: "node server.mjs" } }),
      "server.mjs": `setInterval(() => {}, 1000);\n`,
    });
    const invalidVerify = await cli("--repo", webRepo, "publish", "--verify", "--json");
    expect(invalidVerify.exitCode).not.toBe(0);
    expect(envelope(invalidVerify.stdout)).toMatchObject({
      ok: false,
      command: "publish",
      error: { code: "E_USAGE" },
    });
  });
});
