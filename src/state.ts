import crypto from "node:crypto";
import path from "node:path";
import { link, open, readFile, readdir, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { pidAlive } from "./commands.js";
import { NectarError } from "./errors.js";
import { ensureLayout, type NectarPaths } from "./paths.js";
import { validateEnvName } from "./refs.js";
import type { EnvRecord, MachineConfig } from "./types.js";
import { servingCapacity } from "./capacity.js";

const lockAcquisitions = new Map<string, Promise<FileHandle>>();

export const DEFAULT_CONFIG: MachineConfig = {
  upstream_port_start: 4100,
  upstream_port_end: 65535,
  tailnet_port_start: 8443,
  tailnet_port_end: 65535,
  serving_web_limit: servingCapacity(),
  // One streamed simulator per host: starting a second serve-sim instance kills the
  // first one's encoder (observed on 0.1.45). Raise once upstream multi-instance works.
  serving_sim_limit: 1,
  idle_stop_ms: 45 * 60 * 1_000,
  worktree_cache_allowlist: ["node_modules/", ".vite/", "out/"],
  pack_quota_bytes: 10 * 1024 * 1024 * 1024,
  evidence_quota_bytes: 500 * 1024 * 1024,
  log_max_bytes: 10 * 1024 * 1024,
  pack_server_port: 4099,
};

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class StateStore {
  constructor(readonly paths: NectarPaths) {}

  async init(): Promise<void> {
    await ensureLayout(this.paths);
  }

  envFile(name: string): string {
    return path.join(this.paths.envs, `${validateEnvName(name)}.json`);
  }

  async readEnv(name: string): Promise<EnvRecord> {
    try {
      return JSON.parse(await readFile(this.envFile(name), "utf8")) as EnvRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new NectarError("E_NOT_FOUND", `Environment '${name}' was not found on this machine`);
      }
      throw error;
    }
  }

  async maybeEnv(name: string): Promise<EnvRecord | undefined> {
    try {
      return await this.readEnv(name);
    } catch (error) {
      if (error instanceof NectarError && error.code === "E_NOT_FOUND") return undefined;
      throw error;
    }
  }

  async writeEnv(record: EnvRecord): Promise<void> {
    await this.init();
    await atomicJson(this.envFile(record.name), record);
  }

  async listEnvs(): Promise<EnvRecord[]> {
    await this.init();
    const files = (await readdir(this.paths.envs)).filter((file) => file.endsWith(".json")).sort();
    const records = await Promise.all(
      files.map(async (file): Promise<EnvRecord | undefined> => {
        try {
          return JSON.parse(await readFile(path.join(this.paths.envs, file), "utf8")) as EnvRecord;
        } catch {
          // One corrupt record must not brick ls/gc/publish; the file stays on
          // disk for manual inspection.
          return undefined;
        }
      }),
    );
    return records.filter((record): record is EnvRecord => record !== undefined);
  }

  async deleteEnvFile(name: string): Promise<void> {
    await unlink(this.envFile(name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async readConfig(): Promise<MachineConfig> {
    await this.init();
    try {
      const stored = JSON.parse(await readFile(this.paths.config, "utf8")) as Partial<MachineConfig>;
      const config = { ...DEFAULT_CONFIG, ...stored };
      if (config.upstream_port_start === 4100 && config.upstream_port_end === 4199) config.upstream_port_end = DEFAULT_CONFIG.upstream_port_end;
      if (config.tailnet_port_start === 8443 && config.tailnet_port_end === 8542) config.tailnet_port_end = DEFAULT_CONFIG.tailnet_port_end;
      if (config.serving_web_limit === 12) config.serving_web_limit = DEFAULT_CONFIG.serving_web_limit;
      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
      throw error;
    }
  }

  async writeConfig(config: MachineConfig): Promise<void> {
    await this.init();
    await atomicJson(this.paths.config, config);
  }

  private async acquireLock(lockPath: string): Promise<FileHandle> {
    const previous = lockAcquisitions.get(lockPath) ?? Promise.resolve();
    const acquiring = previous.catch(() => undefined).then(() => this.tryAcquireLock(lockPath));
    lockAcquisitions.set(lockPath, acquiring);
    try {
      return await acquiring;
    } finally {
      if (lockAcquisitions.get(lockPath) === acquiring) lockAcquisitions.delete(lockPath);
    }
  }

  private async tryAcquireLock(lockPath: string): Promise<FileHandle> {
    const create = async (): Promise<FileHandle> => {
      const temporary = `${lockPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
        await link(temporary, lockPath);
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    };
    try {
      return await create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // A lock left behind by a killed process would wedge this env forever; steal
    // it when the recorded holder is gone (or the file predates a generous bound).
    const stale = await readFile(lockPath, "utf8")
      .then((content) => {
        const pid = Number(content.trim());
        return !Number.isInteger(pid) || pid <= 1 || !pidAlive(pid);
      })
      .catch(() => false);
    if (stale) {
      await unlink(lockPath).catch(() => undefined);
      try {
        return await create();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new NectarError("E_BUSY", `Environment '${path.basename(lockPath, ".lock")}' is busy; retry shortly`, { lock: path.basename(lockPath, ".lock") });
  }

  async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    await this.init();
    const lockPath = path.resolve(this.paths.locks, `${validateEnvName(name)}.lock`);
    const deadline = performance.now() + 30_000;
    let handle: FileHandle;
    for (;;) {
      try {
        handle = await this.acquireLock(lockPath);
        break;
      } catch (error) {
        if (name !== "machine--ports" || !(error instanceof NectarError) || error.code !== "E_BUSY") throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new NectarError("E_BUSY", "Timed out after 30000ms waiting for the machine port lock; another publish, wake, or recovery is still using it", { lock: name, timeout_ms: 30_000 });
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
      }
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  // Locked read-modify-write: the only safe way to mutate a record outside a
  // publish. `bestEffort` callers (touch-on-resolve, liveness flips) skip
  // silently when a publish holds the lock — the env is clearly active anyway.
  async updateEnv(
    name: string,
    mutate: (record: EnvRecord) => void | Promise<void>,
    options: { bestEffort?: boolean } = {},
  ): Promise<EnvRecord | undefined> {
    try {
      return await this.withLock(name, async () => {
        const record = await this.readEnv(name);
        await mutate(record);
        await this.writeEnv(record);
        return record;
      });
    } catch (error) {
      if (options.bestEffort === true && error instanceof NectarError && error.code === "E_BUSY") return undefined;
      throw error;
    }
  }
}
