import path from "node:path";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import type { EnvRecord } from "./types.js";

export type GcTransition = "idle-stop" | "expire" | "cold" | "reap";

const SIX_HOURS = 6 * 60 * 60 * 1_000;
const ONE_DAY = 24 * 60 * 60 * 1_000;
const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1_000;
export const DEFAULT_DEV_IDLE_STOP_MS = 45 * 60 * 1_000;

export function gcTransition(
  record: EnvRecord,
  now: Date,
  devIdleStopMs = DEFAULT_DEV_IDLE_STOP_MS,
): GcTransition | undefined {
  const nowMs = now.getTime();
  const touched = new Date(record.last_touched_at).getTime();
  const published = new Date(record.published_at).getTime();
  const expiry = new Date(record.expires_at).getTime();
  // The initial record stamps both fields equally. Grace is for a reviewer touch,
  // not an implicit six-hour minimum TTL that would make --ttl 1m meaningless.
  if (nowMs >= expiry + ONE_DAY + FOURTEEN_DAYS) return "reap";
  if (nowMs >= expiry + ONE_DAY && record.status !== "cold") return "cold";
  const recentlyTouched = touched > published && nowMs - touched < SIX_HOURS;
  if (nowMs >= expiry && !recentlyTouched && record.status !== "expired" && record.status !== "cold") return "expire";
  // Resolve/touch may keep the record alive, but only an explicit open keeps a
  // dev process alive. The process clock therefore deliberately ignores touch.
  if (
    (record.mode === "dev" || (record.mode === "web" && record.serve?.proxy_port !== undefined && !record.serve.cmd.includes("static-server.js"))) &&
    record.status === "serving" &&
    record.pinned !== true &&
    (record.mode !== "dev" || record.last_opened_at !== undefined) &&
    nowMs - new Date(record.last_opened_at ?? record.published_at).getTime() >= devIdleStopMs
  ) {
    return "idle-stop";
  }
  if (recentlyTouched) return undefined;
  return undefined;
}

export interface PackCandidate {
  path: string;
  size: number;
  atimeMs: number;
  protected: boolean;
}

export function selectPackPrunes(candidates: PackCandidate[], quotaBytes: number): PackCandidate[] {
  let total = candidates.reduce((sum, file) => sum + file.size, 0);
  if (total <= quotaBytes) return [];
  const removable = candidates
    .filter((file) => !file.protected)
    .sort((a, b) => a.atimeMs - b.atimeMs || a.path.localeCompare(b.path));
  const selected: PackCandidate[] = [];
  for (const file of removable) {
    if (total <= quotaBytes || candidates.length - selected.length <= 1) break;
    selected.push(file);
    total -= file.size;
  }
  return selected;
}

async function walk(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && entry.name.endsWith(".testpack.zip") ? [full] : [];
    }),
  );
  return nested.flat();
}

export async function packCandidates(packRoot: string, protectedFiles: Set<string>): Promise<PackCandidate[]> {
  const files = await walk(packRoot);
  return Promise.all(
    files.map(async (file) => {
      const info = await stat(file);
      return { path: file, size: info.size, atimeMs: info.atimeMs, protected: protectedFiles.has(file) };
    }),
  );
}

async function listDirectories(root: string): Promise<Dirent[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// `.staging-<pid>-<rand>` trees are trashed by their publish, but a killed
// publish leaves them behind — extracted app bundles invisible to the zip-only
// quota walk. Sweep any older than the cutoff.
export async function findStaleStaging(packRoot: string, olderThanMs: number): Promise<string[]> {
  const stale: string[] = [];
  for (const envDir of await listDirectories(packRoot)) {
    const full = path.join(packRoot, envDir.name);
    for (const entry of await listDirectories(full)) {
      if (!entry.name.startsWith(".staging-")) continue;
      const dir = path.join(full, entry.name);
      const info = await stat(dir).catch(() => undefined);
      if (info !== undefined && info.mtimeMs < olderThanMs) stale.push(dir);
    }
  }
  return stale;
}

async function walkFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(full) : entry.isFile() ? [full] : [];
    }),
  );
  return nested.flat();
}

// SPEC §10.1: evidence is quota'd per env; prune oldest files until under.
export async function selectEvidencePrunes(evidenceRoot: string, quotaBytes: number): Promise<string[]> {
  const prunes: string[] = [];
  for (const envDir of await listDirectories(evidenceRoot)) {
    const files = await Promise.all(
      (await walkFiles(path.join(evidenceRoot, envDir.name))).map(async (file) => {
        const info = await stat(file);
        return { path: file, size: info.size, mtimeMs: info.mtimeMs };
      }),
    );
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path))) {
      if (total <= quotaBytes) break;
      prunes.push(file.path);
      total -= file.size;
    }
  }
  return prunes;
}
