import path from "node:path";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { trashPaths } from "./files.js";
import type { NectarPaths } from "./paths.js";

export function serveLog(paths: NectarPaths, name: string): string {
  return path.join(paths.logs, name, "serve.log");
}

export async function prepareLog(paths: NectarPaths, name: string, maxBytes: number): Promise<string> {
  const file = serveLog(paths, name);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const info = await stat(file);
    if (info.size >= maxBytes) {
      const first = `${file}.1`;
      const second = `${file}.2`;
      await trashPaths([second], paths.root);
      try {
        await rename(first, second);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(file, first);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}

export async function logTail(paths: NectarPaths, name: string, lines = 40): Promise<string[]> {
  try {
    return (await readFile(serveLog(paths, name), "utf8")).split("\n").filter(Boolean).slice(-lines);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
