import os from "node:os";
import { readFile } from "node:fs/promises";
import { runCommand } from "./commands.js";

const GIB = 1024 ** 3;
export const PREVIEW_MEMORY_BYTES = 256 * 1024 ** 2;

export function servingCapacity(memory = os.totalmem()): number {
  return Math.max(1, Math.floor(memory / 2 / PREVIEW_MEMORY_BYTES));
}

export function previewMemoryAvailable(free = os.freemem(), total = os.totalmem()): boolean {
  return free >= Math.min(GIB, total / 8) + PREVIEW_MEMORY_BYTES;
}

export async function availableMemory(): Promise<number> {
  try {
    if (process.platform === "darwin") {
      const result = await runCommand("vm_stat", [], { timeoutMs: 2_000 });
      const page = /page size of (\d+) bytes/.exec(result.stdout)?.[1];
      const counts = ["free", "inactive", "speculative"].map((kind) => new RegExp(`Pages ${kind}:\\s+(\\d+)`).exec(result.stdout)?.[1]);
      if (result.exitCode === 0 && page !== undefined && counts.every((count) => count !== undefined)) {
        return counts.reduce((sum, count) => sum + Number(count), 0) * Number(page);
      }
    } else if (process.platform === "linux") {
      const kb = /^MemAvailable:\s+(\d+) kB/m.exec(await readFile("/proc/meminfo", "utf8"))?.[1];
      if (kb !== undefined) return Number(kb) * 1024;
    }
  } catch {
    return os.freemem();
  }
  return os.freemem();
}
