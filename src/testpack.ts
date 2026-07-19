import crypto from "node:crypto";
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { access, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import archiver from "archiver";
import extract from "extract-zip";
import { runCommand } from "./commands.js";
import { NectarError } from "./errors.js";
import { trashPaths } from "./files.js";
import type { NectarPaths } from "./paths.js";
import type { TestpackManifest } from "./types.js";

export function currentPlatform(): string {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  if (process.platform !== "darwin") {
    throw new NectarError("E_PLATFORM", `Nectar v0 launches testpacks only on darwin (this host is ${process.platform}-${arch})`);
  }
  return `darwin-${arch}`;
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function createTestpackZip(packRoot: string, output: string, archiveRoot: string): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const target = createWriteStream(output, { mode: 0o600 });
    const archive = archiver("zip", { zlib: { level: 9 } });
    target.once("close", resolve);
    target.once("error", reject);
    archive.once("error", reject);
    archive.pipe(target);
    archive.directory(packRoot, archiveRoot);
    void archive.finalize();
  });
}

export async function extractTestpack(zip: string, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true });
  await extract(zip, { dir: destination });
  const entries = await import("node:fs/promises").then(({ readdir }) => readdir(destination, { withFileTypes: true }));
  const roots = entries.filter((entry) => entry.isDirectory());
  const candidates = [destination, ...roots.map((entry) => path.join(destination, entry.name))];
  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "testpack.json"))) return candidate;
  }
  throw new NectarError("E_VERIFY", "Testpack zip does not contain testpack.json");
}

export async function readAndValidateManifest(packRoot: string): Promise<TestpackManifest> {
  let manifest: TestpackManifest;
  try {
    manifest = JSON.parse(await readFile(path.join(packRoot, "testpack.json"), "utf8")) as TestpackManifest;
  } catch (error) {
    throw new NectarError("E_VERIFY", `Invalid testpack.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.testpack !== 1) throw new NectarError("E_VERIFY", `Unsupported testpack format '${String(manifest.testpack)}'`);
  if (typeof manifest.entry !== "string" || path.isAbsolute(manifest.entry) || manifest.entry.split(/[\\/]/).includes("..")) {
    throw new NectarError("E_VERIFY", "testpack.json entry must be a safe relative path");
  }
  const entry = path.resolve(packRoot, manifest.entry);
  if (!entry.startsWith(`${path.resolve(packRoot)}${path.sep}`) || !(await pathExists(entry))) {
    throw new NectarError("E_VERIFY", `Testpack entry '${manifest.entry}' does not exist`);
  }
  // The lexical check above is satisfied by a symlink inside the pack pointing
  // outside it — and what we launch/install must be covered by the digest. The
  // extract library blocks symlink *writes* escaping the root, not symlink entries.
  const [realEntry, realRoot] = await Promise.all([realpath(entry).catch(() => undefined), realpath(packRoot)]);
  if (realEntry === undefined || !realEntry.startsWith(`${realRoot}${path.sep}`)) {
    throw new NectarError("E_VERIFY", `Testpack entry '${manifest.entry}' escapes the verified pack`);
  }
  return manifest;
}

export async function writeManifest(packRoot: string, manifest: TestpackManifest): Promise<void> {
  await writeFile(path.join(packRoot, "testpack.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export async function fetchVerified(options: {
  url: string;
  expectedSha256: string;
  paths: NectarPaths;
  localSource?: string;
}): Promise<{ zip: string; cacheHit: boolean }> {
  const cacheDir = path.join(options.paths.packs, ".cache");
  const cached = path.join(cacheDir, `${options.expectedSha256}.testpack.zip`);
  await mkdir(cacheDir, { recursive: true });
  if (await pathExists(cached)) {
    if ((await sha256(cached)) === options.expectedSha256) return { zip: cached, cacheHit: true };
    await trashPaths([cached], options.paths.root);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temporary = `${cached}.${process.pid}.${attempt}.download`;
    if (options.localSource !== undefined) {
      await copyFile(options.localSource, temporary);
    } else {
      // Stream to disk — buffering a multi-GB pack in memory OOMs `open`, and an
      // unresponsive pack server must not hang it forever.
      const response = await fetch(options.url, { signal: AbortSignal.timeout(600_000) });
      if (!response.ok || response.body === null) {
        throw new NectarError("E_NOT_FOUND", `Testpack fetch failed: HTTP ${response.status}`);
      }
      await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(temporary, { mode: 0o600 }));
    }
    if ((await sha256(temporary)) === options.expectedSha256) {
      await rename(temporary, cached);
      return { zip: cached, cacheHit: false };
    }
    await trashPaths([temporary], options.paths.root);
  }
  throw new NectarError("E_VERIFY", "Testpack sha256 mismatch after one retry; refusing to launch");
}

export async function extractVerified(options: {
  zip: string;
  sha: string;
  expectedPlatform: string;
  expectedEntry: string;
  paths: NectarPaths;
}): Promise<{ packRoot: string; manifest: TestpackManifest; entry: string }> {
  const destination = path.join(options.paths.packs, ".cache", options.sha);
  let packRoot: string;
  if (await pathExists(destination)) {
    const roots = await import("node:fs/promises").then(({ readdir }) => readdir(destination, { withFileTypes: true }));
    packRoot = roots.length === 1 && roots[0]?.isDirectory() ? path.join(destination, roots[0].name) : destination;
  } else {
    packRoot = await extractTestpack(options.zip, destination);
  }
  const manifest = await readAndValidateManifest(packRoot);
  if (manifest.platform !== options.expectedPlatform || manifest.entry !== options.expectedEntry) {
    throw new NectarError("E_VERIFY", "Resolved testpack metadata does not match its manifest");
  }
  await runCommand("xattr", ["-dr", "com.apple.quarantine", packRoot]).catch(() => undefined);
  return { packRoot, manifest, entry: path.join(packRoot, manifest.entry) };
}

export async function extractAndLaunch(options: {
  zip: string;
  sha: string;
  expectedPlatform: string;
  expectedEntry: string;
  paths: NectarPaths;
}): Promise<string> {
  const platform = currentPlatform();
  if (platform !== options.expectedPlatform) {
    throw new NectarError("E_PLATFORM", `Testpack is ${options.expectedPlatform}; this machine is ${platform}`);
  }
  const { entry } = await extractVerified(options);
  const launcher = process.env.NECTAR_LAUNCH_BIN ?? "open";
  const result = await runCommand(launcher, [entry]);
  if (result.exitCode !== 0) throw new NectarError("E_INTERNAL", result.stderr.trim() || `Could not launch ${entry}`);
  return entry;
}

export async function fileSize(file: string): Promise<number> {
  return (await stat(file)).size;
}
