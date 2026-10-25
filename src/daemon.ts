import os from "node:os";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { appendFile, open, readFile, unlink } from "node:fs/promises";
import { pidAlive } from "./commands.js";
import { asNectarError, NectarError } from "./errors.js";
import { givenUp, hasProbeableServe, probeLiveness } from "./liveness.js";
import { rotateLog } from "./logs.js";
import type { NectarPaths } from "./paths.js";
import { DEFAULT_TOUCH_EVERY_MS, EnvProxy, upstreamOf } from "./proxy.js";
import type { NectarService, ReviveResult } from "./service.js";
import type { EnvRecord, Liveness, ServeRecord } from "./types.js";

export interface SupervisorOptions {
  intervalMs?: number;
  gcIntervalMs?: number;
  unhealthyRestartAfter?: number;
  maxRevives?: number;
  reviveWindowMs?: number;
  backoffBaseMs?: number;
  bootTimeMs?: number;
  probe?: (serve: ServeRecord) => Promise<Liveness>;
  log?: (event: Record<string, unknown>) => void;
  front?: boolean;
  touchEveryMs?: number;
}

export const DEFAULT_INTERVAL_MS = 30_000;
export const DEFAULT_GC_INTERVAL_MS = 60 * 60_000;

interface Watch {
  revives: number[];
  unhealthyStreak: number;
}

type SupervisedRecord = EnvRecord & { serve: ServeRecord };
type FrontedRecord = SupervisedRecord & { serve: { tailnet_port: number } };

export function fronted(record: EnvRecord): record is FrontedRecord {
  return (
    record.mode === "web" &&
    record.serve !== undefined &&
    (hasProbeableServe(record) || record.status === "warm" || (record.status === "publishing" && record.serve.proxy_port !== undefined)) &&
    !givenUp(record) &&
    record.serve.tailnet_port !== undefined
  );
}

type FrontingService = Pick<NectarService, "assignProxyPort" | "releaseProxyPort" | "unfront" | "touchView"> & Partial<Pick<NectarService, "wakeWeb" | "store">>;

export class ProxyHub {
  private readonly proxies = new Map<string, EnvProxy>();
  private readonly touchedAt = new Map<string, number>();
  private readonly viewedAt = new Map<string, number>();
  private syncing: Promise<string[]> = Promise.resolve([]);

  constructor(
    private readonly service: FrontingService,
    private readonly touchEveryMs: number,
    private readonly log: (event: Record<string, unknown>) => void,
  ) {}

  views(): ReadonlyMap<string, number> {
    return this.viewedAt;
  }

  activity(name: string): { active: boolean; viewedAt?: number; known: boolean } {
    return { known: this.proxies.has(name), active: this.proxies.get(name)?.busy ?? true, ...(this.viewedAt.has(name) ? { viewedAt: this.viewedAt.get(name)! } : {}) };
  }

  ports(): Map<string, number> {
    return new Map([...this.proxies].map(([name, proxy]) => [name, proxy.port]));
  }

  sync(records: EnvRecord[]): Promise<string[]> {
    this.syncing = this.syncing.catch(() => []).then(async () => this.reconcile(await this.service.store?.listEnvs() ?? records));
    return this.syncing;
  }

  private async reconcile(records: EnvRecord[]): Promise<string[]> {
    const wanted = new Map(records.filter(fronted).map((record) => [record.name, record]));
    for (const [name, proxy] of this.proxies) {
      if (wanted.has(name)) continue;
      this.proxies.delete(name);
      this.touchedAt.delete(name);
      this.viewedAt.delete(name);
      await proxy.close();
      this.log({ event: "proxy_closed", env: name, port: proxy.port });
    }
    const opened: string[] = [];
    await Promise.all(
      [...wanted.values()].map(async (record) => {
        try {
          if (await this.ensure(record)) opened.push(record.name);
        } catch (error) {
          this.log({ event: "error", phase: "proxy", env: record.name, message: asNectarError(error).message });
        }
      }),
    );
    return opened;
  }

  private async ensure(record: FrontedRecord): Promise<boolean> {
    const upstream = record.serve.upstream_host === undefined ? upstreamOf(record.urls.local === `http://127.0.0.1:${record.serve.proxy_port}` ? null : record.urls.local, record.serve.upstream_port ?? 0) : { host: record.serve.upstream_host, port: record.serve.upstream_port ?? 0 };
    const existing = this.proxies.get(record.name);
    if (existing !== undefined && (record.serve.proxy_port === undefined || existing.port === record.serve.proxy_port)) {
      const moved = existing.upstream.port !== upstream.port || existing.upstream.host !== upstream.host;
      existing.upstream = upstream;
      return moved;
    }
    const port = record.serve.proxy_port ?? (await this.service.assignProxyPort(record.name));
    if (port === undefined) return false;
    if (existing !== undefined) {
      this.proxies.delete(record.name);
      await existing.close();
    }
    const proxy = new EnvProxy(record.name, port, upstream, () => this.viewed(record.name), this.service.wakeWeb === undefined ? undefined : () => this.service.wakeWeb!(record.name));
    try {
      await proxy.listen();
    } catch (error) {
      this.log({ event: "proxy_port_taken", env: record.name, port, message: asNectarError(error).message });
      await this.service.releaseProxyPort(record.name, port);
      return false;
    }
    this.proxies.set(record.name, proxy);
    this.log({ event: "proxy", env: record.name, port, upstream: upstream.port });
    return true;
  }

  private viewed(name: string): void {
    const nowMs = Date.now();
    this.viewedAt.set(name, nowMs);
    const last = this.touchedAt.get(name);
    if (last !== undefined && nowMs - last < this.touchEveryMs) return;
    this.touchedAt.set(name, nowMs);
    this.service
      .touchView(name)
      .then((expiresAt) => {
        if (expiresAt !== undefined) this.log({ event: "touch", env: name, expires_at: expiresAt });
        else if (this.touchedAt.get(name) === nowMs) this.touchedAt.delete(name);
      })
      .catch(() => { if (this.touchedAt.get(name) === nowMs) this.touchedAt.delete(name); });
  }

  async close(): Promise<void> {
    for (const proxy of this.proxies.values()) {
      const restored = await this.service.unfront(proxy.env).catch(() => false);
      await proxy.close();
      this.log({ event: "proxy_closed", env: proxy.env, port: proxy.port, direct: restored });
    }
    this.proxies.clear();
  }
}

export function supervised(record: EnvRecord, nowMs: number): record is SupervisedRecord {
  return (
    record.mode === "web" &&
    hasProbeableServe(record) &&
    !givenUp(record) &&
    Date.parse(record.expires_at) > nowMs
  );
}

export class Supervisor {
  readonly intervalMs: number;
  readonly gcIntervalMs: number;
  private readonly unhealthyRestartAfter: number;
  private readonly maxRevives: number;
  private readonly reviveWindowMs: number;
  private readonly backoffBaseMs: number;
  private readonly bootTimeMs: number;
  private readonly probe: (serve: ServeRecord) => Promise<Liveness>;
  private readonly log: (event: Record<string, unknown>) => void;
  private readonly watches = new Map<string, Watch>();
  private readonly pendingMesh = new Set<string>();
  readonly hub: ProxyHub | undefined;
  private timer: NodeJS.Timeout | undefined;
  private cycling: Promise<void> | undefined;
  private lastGcAt = 0;
  private stopped = false;
  private watcher: FSWatcher | undefined;
  private frontSync: Promise<void> | undefined;
  private frontDirty = false;

  constructor(
    readonly service: NectarService,
    options: SupervisorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.gcIntervalMs = options.gcIntervalMs ?? DEFAULT_GC_INTERVAL_MS;
    this.unhealthyRestartAfter = options.unhealthyRestartAfter ?? 3;
    this.maxRevives = options.maxRevives ?? 3;
    this.reviveWindowMs = options.reviveWindowMs ?? 10 * 60_000;
    this.backoffBaseMs = options.backoffBaseMs ?? 10_000;
    this.bootTimeMs = options.bootTimeMs ?? Date.now() - os.uptime() * 1_000;
    this.probe = options.probe ?? (async (serve) => probeLiveness(serve));
    this.log = options.log ?? (() => undefined);
    this.hub = options.front === true ? new ProxyHub(service, options.touchEveryMs ?? DEFAULT_TOUCH_EVERY_MS, this.log) : undefined;
    if (this.hub !== undefined) service.setCapacityActivity?.((name) => this.hub!.activity(name));
  }

  async start(onRestored?: () => Promise<void>): Promise<void> {
    this.log({ event: "start", interval_ms: this.intervalMs, gc_interval_ms: this.gcIntervalMs, boot_at: new Date(this.bootTimeMs).toISOString() });
    if (this.hub !== undefined) {
      this.watcher = watch(this.service.paths.envs, () => this.syncFront());
      this.watcher.on("error", (error) => this.log({ event: "error", phase: "front_watch", message: error.message }));
    }
    if (this.hub === undefined) await this.sweep(true);
    else {
      const records = await this.service.store.listEnvs();
      for (const name of await this.hub.sync(records)) this.pendingMesh.add(name);
      await Promise.all(records.filter(fronted).map(async (record) => this.reassertMesh(record)));
    }
    if (this.stopped) return;
    await onRestored?.();
    if (this.hub !== undefined) await this.sweep(false);
    await this.gc();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    await this.frontSync;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.cycling;
    await this.hub?.close();
    this.log({ event: "stop" });
  }

  private syncFront(): void {
    this.frontDirty = true;
    if (this.frontSync !== undefined || this.stopped) return;
    this.frontSync = (async () => {
      while (this.frontDirty && !this.stopped) {
        this.frontDirty = false;
        const records = await this.service.store.listEnvs();
        for (const name of await this.hub?.sync(records) ?? []) this.pendingMesh.add(name);
      }
    })().catch((error: unknown) => this.log({ event: "error", phase: "front_sync", message: asNectarError(error).message }))
      .finally(() => { this.frontSync = undefined; });
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.cycling = this.cycle().finally(() => {
        this.cycling = undefined;
        this.schedule();
      });
    }, this.intervalMs);
  }

  private async cycle(): Promise<void> {
    await this.sweep(false);
    if (Date.now() - this.lastGcAt >= this.gcIntervalMs) await this.gc();
    else await this.service.idleStop(this.hub?.views());
  }

  async sweep(restore: boolean): Promise<void> {
    let records: EnvRecord[];
    try {
      records = await this.service.store.listEnvs();
    } catch (error) {
      this.log({ event: "error", phase: "sweep", message: asNectarError(error).message });
      return;
    }
    if (records.some((record) => record.static_route !== undefined)) await this.service.restoreSharedStatic().catch((error: unknown) => this.log({ event: "error", phase: "shared_static", message: asNectarError(error).message }));
    const nowMs = Date.now();
    const names = new Set(records.map((record) => record.name));
    for (const name of this.watches.keys()) if (!names.has(name)) this.watches.delete(name);
    if (this.hub !== undefined) for (const name of await this.hub.sync(records)) this.pendingMesh.add(name);
    await Promise.all(
      records.map(async (record) => {
        try {
          await this.inspect(record, restore, nowMs);
        } catch (error) {
          this.log({ event: "error", env: record.name, message: asNectarError(error).message });
        }
      }),
    );
  }

  private watchFor(name: string): Watch {
    let watch = this.watches.get(name);
    if (watch === undefined) {
      watch = { revives: [], unhealthyStreak: 0 };
      this.watches.set(name, watch);
    }
    return watch;
  }

  private async inspect(record: EnvRecord, restore: boolean, nowMs: number): Promise<void> {
    if (record.status === "warm" && record.mode === "web" && record.serve !== undefined && (restore || this.pendingMesh.has(record.name))) await this.reassertMesh(record as SupervisedRecord);
    if (!supervised(record, nowMs)) {
      this.watches.delete(record.name);
      if (record.status !== "warm") this.pendingMesh.delete(record.name);
      return;
    }
    if (Date.parse(record.serve.started_at ?? record.published_at) < this.bootTimeMs) {
      await this.revive(record, false, "restore_after_boot");
      return;
    }
    const liveness = await this.probe(record.serve);
    const watch = this.watchFor(record.name);
    if (liveness.state === "serving" && !liveness.pid_alive) {
      const message = `Upstream port ${record.serve.upstream_port} answers but the process Nectar started is gone; another process holds it`;
      if (await this.service.giveUp(record.name, record.serve.pid, "E_PORTS", message)) {
        this.log({ event: "port_taken", env: record.name, port: record.serve.upstream_port ?? null });
      }
      this.forget(record.name);
      return;
    }
    if (liveness.state === "serving") {
      watch.unhealthyStreak = 0;
      if (restore || this.pendingMesh.has(record.name)) await this.reassertMesh(record);
      return;
    }
    if (liveness.state === "unhealthy") {
      watch.unhealthyStreak += 1;
      if (watch.unhealthyStreak >= this.unhealthyRestartAfter) await this.revive(record, true, "unhealthy");
      return;
    }
    await this.revive(record, false, liveness.reason);
  }

  private forget(name: string): void {
    this.watches.delete(name);
    this.pendingMesh.delete(name);
  }

  private async reassertMesh(record: SupervisedRecord): Promise<void> {
    if (record.urls.mesh === null || record.serve.tailnet_port === undefined) return;
    if (await this.service.reassertMesh(record.name)) {
      this.pendingMesh.delete(record.name);
      this.log({ event: "mesh", env: record.name, tailnet_port: record.serve.tailnet_port });
    } else {
      this.pendingMesh.add(record.name);
    }
  }

  private async revive(record: SupervisedRecord, kill: boolean, cause: string): Promise<void> {
    const watch = this.watchFor(record.name);
    const nowMs = Date.now();
    watch.revives = watch.revives.filter((at) => nowMs - at < this.reviveWindowMs);
    if (watch.revives.length >= this.maxRevives) {
      const message = `Revived ${watch.revives.length} times within ${Math.round(this.reviveWindowMs / 1_000)}s and it still dies; republish to retry`;
      const marked = await this.service.giveUp(record.name, record.serve.pid, "E_CRASH_LOOP", message);
      this.forget(record.name);
      if (marked) this.log({ event: "crash_loop", env: record.name, revives: watch.revives.length, cause });
      return;
    }
    const last = watch.revives.at(-1);
    if (last !== undefined && nowMs - last < this.backoffBaseMs * 2 ** (watch.revives.length - 1)) return;
    watch.revives.push(nowMs);
    watch.unhealthyStreak = 0;
    const result: ReviveResult = await this.service
      .revive(record.name, { expectPid: record.serve.pid, kill })
      .catch((error: unknown) => ({ revived: false, reason: asNectarError(error).code }));
    if (result.reason === "record_changed" || result.reason === "E_BUSY") {
      watch.revives.pop();
      return;
    }
    if (result.reason === "E_PORTS") {
      this.forget(record.name);
      this.log({ event: "port_taken", env: record.name, cause, port: record.serve.upstream_port ?? null });
      return;
    }
    if (result.revived && result.mesh !== true && record.urls.mesh !== null && record.serve.tailnet_port !== undefined) {
      this.pendingMesh.add(record.name);
    }
    if (result.mesh === true) this.pendingMesh.delete(record.name);
    this.log({
      event: result.revived ? "revived" : "revive_failed",
      env: record.name,
      cause,
      reason: result.reason,
      attempt: watch.revives.length,
      port: record.serve.upstream_port ?? null,
      ...(result.pid === undefined ? {} : { pid: result.pid }),
      ...(result.mesh === undefined ? {} : { mesh: result.mesh }),
    });
  }

  async gc(): Promise<void> {
    this.lastGcAt = Date.now();
    try {
      const views = this.hub?.views();
      const report = await this.service.gc(views === undefined ? {} : { viewedAt: views });
      this.log({ event: "gc", transitions: report.transitions, serve_orphans: report.serve_orphans, skipped: report.skipped, exposures: report.exposures });
    } catch (error) {
      this.log({ event: "error", phase: "gc", message: asNectarError(error).message });
    }
  }
}

export function daemonLogFile(paths: NectarPaths): string {
  return path.join(paths.logs, "nectard.log");
}

export function pidFile(paths: NectarPaths): string {
  return path.join(paths.root, "nectard.pid");
}

export async function runningDaemonPid(paths: NectarPaths): Promise<number | undefined> {
  const pid = Number((await readFile(pidFile(paths), "utf8").catch(() => "")).trim());
  return Number.isInteger(pid) && pid > 1 && pidAlive(pid) ? pid : undefined;
}

export async function claimPidFile(paths: NectarPaths): Promise<() => Promise<void>> {
  const file = pidFile(paths);
  const holder = await runningDaemonPid(paths);
  if (holder !== undefined && holder !== process.pid) {
    throw new NectarError("E_BUSY", `nectard is already running for ${paths.root} (pid ${holder})`);
  }
  await unlink(file).catch(() => undefined);
  const handle = await open(file, "wx", 0o600);
  await handle.writeFile(`${process.pid}\n`);
  await handle.close();
  return async () => {
    if ((await runningDaemonPid(paths)) === process.pid) await unlink(file).catch(() => undefined);
  };
}

export function daemonLogger(paths: NectarPaths, maxBytes: number, echo: (line: string) => void): (event: Record<string, unknown>) => void {
  const file = daemonLogFile(paths);
  let chain: Promise<void> = Promise.resolve();
  return (event) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    echo(line);
    chain = chain
      .then(async () => {
        if (event.event === "start" || event.event === "gc") await rotateLog(file, maxBytes, paths.root);
        await appendFile(file, line, { mode: 0o600 });
      })
      .catch(() => undefined);
  };
}
