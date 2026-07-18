import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";

export interface NectarPaths {
  root: string;
  envs: string;
  work: string;
  packs: string;
  evidence: string;
  logs: string;
  locks: string;
  config: string;
}

export function getPaths(root = process.env.NECTAR_HOME ?? path.join(os.homedir(), ".nectar")): NectarPaths {
  return {
    root,
    envs: path.join(root, "envs"),
    work: path.join(root, "work"),
    packs: path.join(root, "packs"),
    evidence: path.join(root, "evidence"),
    logs: path.join(root, "logs"),
    locks: path.join(root, "locks"),
    config: path.join(root, "nectar.json"),
  };
}

export async function ensureLayout(paths: NectarPaths): Promise<void> {
  await Promise.all(
    [paths.root, paths.envs, paths.work, paths.packs, paths.evidence, paths.logs, paths.locks].map(
      async (directory) => mkdir(directory, { recursive: true }),
    ),
  );
}
