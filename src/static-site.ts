import crypto from "node:crypto";
import path from "node:path";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { NectarError } from "./errors.js";

export const STATIC_ROOTS = [".", "dist", "build", "out", "public", "_site"];
const SKIPPED = new Set(["node_modules"]);
const ALLOWED_DOTFILES = new Set([".well-known"]);
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 20_000;

export interface StaticSite {
  source: string;
  root: string;
  file?: string;
  name: string;
}

export interface StagedSite {
  hash: string;
  files: number;
  bytes: number;
  skippedLinks: number;
}

async function kind(file: string): Promise<"file" | "directory" | undefined> {
  const info = await lstat(file).catch(() => undefined);
  if (info?.isFile() === true) return "file";
  if (info?.isDirectory() === true) return "directory";
  return undefined;
}

export async function findStaticSite(target: string): Promise<StaticSite | undefined> {
  const source = path.resolve(target);
  const found = await kind(source);
  if (found === "file") {
    if (!/\.html?$/i.test(source)) return undefined;
    return { source, root: path.dirname(source), file: source, name: path.basename(source).replace(/\.html?$/i, "") };
  }
  if (found !== "directory") return undefined;
  for (const candidate of STATIC_ROOTS) {
    const root = path.join(source, candidate);
    if ((await kind(path.join(root, "index.html"))) === "file") return { source, root, name: path.basename(source) };
  }
  return undefined;
}

export async function staticFiles(root: string): Promise<{ files: Array<{ relative: string; size: number }>; skippedLinks: number }> {
  const files: Array<{ relative: string; size: number }> = [];
  let skippedLinks = 0;
  let bytes = 0;
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED.has(entry.name) || (entry.name.startsWith(".") && !ALLOWED_DOTFILES.has(entry.name))) continue;
      const child = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) skippedLinks += 1;
      else if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const size = (await lstat(path.join(root, child))).size;
        bytes += size;
        files.push({ relative: child, size });
        if (files.length > MAX_FILES || bytes > MAX_BYTES) {
          throw new NectarError(
            "E_USAGE",
            `Static site at ${root} exceeds ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MiB; publish the built output directory instead`,
          );
        }
      }
    }
  };
  await walk("");
  return { files, skippedLinks };
}

export async function stageStaticSite(site: StaticSite, destination: string): Promise<StagedSite> {
  const suffix = crypto.randomBytes(4).toString("hex");
  const staging = `${destination}.staging-${suffix}`;
  const hash = crypto.createHash("sha256");
  try {
    await mkdir(staging, { recursive: true });
    let files: Array<{ relative: string; size: number }>;
    let skippedLinks = 0;
    if (site.file !== undefined) {
      files = [{ relative: "index.html", size: (await lstat(site.file)).size }];
      await copyFile(site.file, path.join(staging, "index.html"));
    } else {
      ({ files, skippedLinks } = await staticFiles(site.root));
      for (const file of files) {
        await mkdir(path.join(staging, path.dirname(file.relative)), { recursive: true });
        await copyFile(path.join(site.root, file.relative), path.join(staging, file.relative));
      }
    }
    for (const file of files) {
      hash.update(file.relative).update("\0").update(await readFile(path.join(staging, file.relative))).update("\0");
    }
    const previous = `${destination}.old-${suffix}`;
    const hadPrevious = (await kind(destination)) !== undefined;
    if (hadPrevious) await rename(destination, previous);
    await rename(staging, destination);
    if (hadPrevious) await rm(previous, { recursive: true, force: true });
    return {
      hash: hash.digest("hex").slice(0, 8),
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      skippedLinks,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
