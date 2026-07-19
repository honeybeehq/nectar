import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { runCommand } from "./commands.js";
import { NectarError } from "./errors.js";
import { pathExists } from "./testpack.js";
import type { NectarPaths } from "./paths.js";

// Compiles assets/ax-dump.swift on demand, cached by source hash under ~/.nectar/bin.
export async function ensureAxHelper(paths: NectarPaths): Promise<string> {
  const override = process.env.NECTAR_AX_HELPER;
  if (override !== undefined) return override;
  const source = fileURLToPath(new URL("../assets/ax-dump.swift", import.meta.url));
  const contents = await readFile(source, "utf8");
  const hash = crypto.createHash("sha256").update(contents).digest("hex").slice(0, 8);
  const binDir = path.join(paths.root, "bin");
  const target = path.join(binDir, `ax-dump-${hash}`);
  if (await pathExists(target)) return target;
  await mkdir(binDir, { recursive: true });
  const result = await runCommand("xcrun", ["-sdk", "macosx", "swiftc", "-O", "-o", target, source], {
    timeoutMs: 180_000,
  });
  if (result.exitCode !== 0) {
    throw new NectarError("E_PLATFORM", "Could not compile the AX helper (is Xcode installed?)", {
      log_tail: result.stderr.split("\n").filter(Boolean).slice(-20),
    });
  }
  return target;
}

// The `open` launcher returns before the app process exists; poll pgrep for the
// bundle path. pgrep prints ascending pids, so the first match is the main process.
export async function findAppPid(
  entry: string,
  timeoutMs = Number(process.env.NECTAR_AX_PID_TIMEOUT_MS ?? 10_000),
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runCommand("pgrep", ["-f", entry]).catch(() => undefined);
    const pid = result?.stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .find((value) => Number.isInteger(value) && value > 1);
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}
