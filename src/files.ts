import path from "node:path";
import os from "node:os";
import { access, mkdir, rename } from "node:fs/promises";
import { runCommand } from "./commands.js";

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function trashPaths(targets: string[], allowedRoot: string): Promise<void> {
  const root = path.resolve(allowedRoot);
  const safe = targets.map((target) => path.resolve(target)).filter((target) => target.startsWith(`${root}${path.sep}`));
  if (safe.length !== targets.length || safe.some((target) => target === root || target === os.homedir() || target === "/")) {
    throw new Error("Refusing to trash a path outside the Nectar state root");
  }
  const present: string[] = [];
  for (const target of safe) if (await exists(target)) present.push(target);
  if (present.length === 0) return;

  const trashBin = process.env.NECTAR_TRASH_BIN ?? (process.platform === "darwin" ? "/usr/bin/trash" : "gio");
  const args = process.platform === "darwin" || process.env.NECTAR_TRASH_BIN !== undefined ? present : ["trash", ...present];
  try {
    const result = await runCommand(trashBin, args);
    if (result.exitCode === 0) return;
  } catch {
    // Fall through to a recoverable state-local trash directory.
  }
  const fallback = path.join(root, ".trash");
  await mkdir(fallback, { recursive: true });
  for (const target of present) {
    await rename(target, path.join(fallback, `${path.basename(target)}-${Date.now()}-${Math.random().toString(16).slice(2)}`));
  }
}
