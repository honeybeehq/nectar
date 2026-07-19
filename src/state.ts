import crypto from "node:crypto";
import path from "node:path";
import { open, readFile, readdir, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { pidAlive } from "./commands.js";
import { NectarError } from "./errors.js";
import { ensureLayout, type NectarPaths } from "./paths.js";
import { validateEnvName } from "./refs.js";
import type { EnvRecord, MachineConfig } from "./types.js";

export const DEFAULT_CONFIG: MachineConfig = {
  upstream_port_start: 4100,
  upstream_port_end: 4199,
  tailnet_port_start: 8443,
  tailnet_port_end: 8542,
  serving_web_limit: 12,
  // One streamed simulator per host: starting a second serve-sim instance kills the
  // first one's encoder (observed on 0.1.45). Raise once upstream multi-instance works.
  serving_sim_limit: 1,
  pack_quota_bytes: 10 * 1024 * 1024 * 1024,
  evidence_quota_bytes: 500 * 1024 * 1024,
  log_max_bytes: 10 * 1024 * 1024,
  pack_server_port: 4099,
};

async function atomicJson(file: string, value: unknown): Promise<void> {
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
      return { ...DEFAULT_CONFIG, ...stored };
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
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return handle;
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
      .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT");
    if (stale) {
      await unlink(lockPath).catch(() => undefined);
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`);
        return handle;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new NectarError("E_BUSY", `Environment '${path.basename(lockPath, ".lock")}' is busy; retry shortly`);
  }

  async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    await this.init();
    const lockPath = path.join(this.paths.locks, `${validateEnvName(name)}.lock`);
    const handle = await this.acquireLock(lockPath);
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
