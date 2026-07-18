import path from "node:path";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import type { EnvRecord } from "./types.js";

export type GcTransition = "expire" | "cold" | "reap";

const SIX_HOURS = 6 * 60 * 60 * 1_000;
const ONE_DAY = 24 * 60 * 60 * 1_000;
const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1_000;

export function gcTransition(record: EnvRecord, now: Date): GcTransition | undefined {
  const nowMs = now.getTime();
  const touched = new Date(record.last_touched_at).getTime();
  const published = new Date(record.published_at).getTime();
  // The initial record stamps both fields equally. Grace is for a reviewer touch,
  // not an implicit six-hour minimum TTL that would make --ttl 1m meaningless.
  if (touched > published && nowMs - touched < SIX_HOURS) return undefined;
  const expiry = new Date(record.expires_at).getTime();
  if (nowMs >= expiry + ONE_DAY + FOURTEEN_DAYS) return "reap";
  if (nowMs >= expiry + ONE_DAY) return "cold";
  if (nowMs >= expiry && record.status !== "expired" && record.status !== "cold") return "expire";
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
