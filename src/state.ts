import crypto from "node:crypto";
import path from "node:path";
import { open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
    return Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(this.paths.envs, file), "utf8")) as EnvRecord));
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

  async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    await this.init();
    const lockPath = path.join(this.paths.locks, `${validateEnvName(name)}.lock`);
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new NectarError("E_CHECKOUT", `Environment '${name}' is busy; retry shortly`);
      }
      throw error;
    }
    try {
      return await action();
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }
}
