import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { NectarService } from '../../dist/service.js';
import { daemonHello, callDaemon } from '../../dist/control.js';
import { serveEntries, serveStatus } from '../../dist/tailscale.js';
import { pidAlive } from '../../dist/commands.js';

const baseline = process.argv.includes('--baseline');
const root = await mkdtemp(path.resolve('.audit/t14-'));
const state = path.join(root, 'state');
process.env.NECTAR_HOME = state;
process.env.NECTAR_SOCKET = path.join(await mkdtemp('/tmp/nectar-t14-'), 'control.sock');
process.env.NECTAR_TEST_RUNTIME_MEMORY_BYTES = String(3 * 256 * 1024 ** 2);
const service = new NectarService(state);
await service.store.init();
await service.store.writeConfig({ ...await service.store.readConfig(), upstream_port_start: 46100, upstream_port_end: 46114, tailnet_port_start: 46200, tailnet_port_end: 46299, pack_server_port: 46099, idle_stop_ms: 3600000 });
const repo = path.join(root, 'repo');
await mkdir(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
await writeFile(path.join(repo, 'nectar.toml'), 'name = "t14"\n[web]\nserve = "exec node server.mjs"\nready_timeout = "5s"\n');
await writeFile(path.join(repo, 'server.mjs'), 'import http from "node:http";http.createServer((q,s)=>s.end("awake:"+process.env.NECTAR_ENV)).listen(Number(process.env.PORT),"127.0.0.1");');
git('add', '.'); git('commit', '-m', 'Port contention fixture');
const log = await open(path.join(root, 'daemon.log'), 'a');
if (!baseline) {
  assert(!pidAlive(4194304));
  await writeFile(path.join(service.paths.locks, 'machine--ports.lock'), '4194304\n');
  let holders = 0;
  let peak = 0;
  let completed = 0;
  await Promise.all(Array.from({ length: 8 }, () => new NectarService(state).store.withLock('machine--ports', async () => {
    holders++;
    peak = Math.max(peak, holders);
    await new Promise(r => setTimeout(r, 20));
    holders--;
    completed++;
  })));
  assert.equal(peak, 1);
  assert.equal(completed, 8);
  console.log(JSON.stringify({ phase: 'dead-holder-recovery', peak, completed }));
}
const daemon = spawn(process.execPath, ['dist/cli.js', 'daemon', 'run', '--interval', '100ms', '--gc-interval', '1h'], { env: process.env, stdio: ['ignore', log.fd, log.fd] });
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async fn => { const end = Date.now() + 30000; while (!await fn()) { assert(Date.now() < end, 'timeout'); await wait(50); } };
const say = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
const call = (command, args = {}) => callDaemon(process.env.NECTAR_SOCKET, command, { nectar_home: state, caller: {}, args });
const publish = async branch => { git('branch', branch); const r = await call('publish', { path: repo, branch, mode: 'web', local: true }); assert.equal(r.via, 'nectard'); return r; };
const openPreview = async r => { const record = await service.store.readEnv(r.env); const response = await fetch(`http://127.0.0.1:${record.serve.proxy_port}`, { signal: AbortSignal.timeout(70000) }); assert.equal(response.status, 200); assert.equal(await response.text(), `awake:${r.env}`); };
const uniquePorts = async () => {
  const records = await service.store.listEnvs();
  const claimed = new Map();
  for (const record of records) {
    for (const port of [record.serve?.upstream_port, record.serve?.proxy_port, record.serve?.tailnet_port]) {
      if (port === undefined) continue;
      assert(!claimed.has(port), `port ${port}: ${claimed.get(port)} and ${record.name}`);
      claimed.set(port, record.name);
    }
  }
  const entries = serveEntries(await serveStatus());
  for (const record of records) {
    if (record.serve?.tailnet_port === undefined) continue;
    const matches = entries.filter(e => e.tailnetPort === record.serve.tailnet_port);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].target, record.urls.local);
  }
  say({ phase: 'unique-ports', records: records.length, uniqueClaims: claimed.size });
};
const results = [];
try {
  await until(async () => { try { return (await daemonHello(process.env.NECTAR_SOCKET)).pid === daemon.pid; } catch { return false; } });
  say({ root, daemon: daemon.pid, baseline });
  const warm = await publish('warm');
  await until(async () => (await service.store.readEnv(warm.env)).serve.proxy_port !== undefined);
  let release;
  let held;
  const acquired = new Promise(r => { held = r; });
  const holding = service.store.withLock('machine--ports', async () => { held(); await new Promise(r => { release = r; }); });
  await acquired;
  const start = Date.now();
  const pending = Promise.allSettled([publish('held-a'), publish('held-b'), openPreview(warm)]);
  await wait(1500); release(); await holding;
  const first = await pending;
  for (const [i, r] of first.entries()) say({ phase: 'held-lock', operation: i, elapsedMs: Date.now() - start, status: r.status, ...(r.status === 'rejected' ? { code: r.reason.code, message: r.reason.message, details: r.reason.details } : { env: r.value?.env, awake: i === 2 }) });
  if (baseline) { assert(first.some(r => r.status === 'rejected' && r.reason.code === 'E_BUSY' && r.reason.details.lock === 'machine--ports')); say({ reproduced: true }); }
  else {
    assert(first.every(r => r.status === 'fulfilled'));
    await until(async () => (await service.store.listEnvs()).every(r => r.serve?.proxy_port !== undefined));
    for (let round = 0; round < 5; round++) {
      const existing = (await service.store.listEnvs()).filter(r => r.status === 'warm').slice(0, 2);
      const run = await Promise.allSettled([publish(`r${round}-a`), publish(`r${round}-b`), ...existing.map(r => openPreview({ env: r.name }))]);
      say({ phase: 'concurrent', round, statuses: run.map(r => r.status), errors: run.filter(r => r.status === 'rejected').map(r => ({ code: r.reason.code, message: r.reason.message })) });
      assert(run.every(r => r.status === 'fulfilled'));
      results.push(...run.slice(0, 2).map(r => r.value));
      await until(async () => (await service.store.listEnvs()).every(r => r.serve?.proxy_port !== undefined));
      for (const r of results.slice(-2)) await openPreview(r);
      await uniquePorts();
    }
    const events = (await import('node:fs/promises').then(fs => fs.readFile(path.join(state, 'capacity.jsonl'), 'utf8'))).trim().split('\n').map(line => JSON.parse(line));
    const recoveries = events.filter(e => e.event === 'capacity_recovery');
    say({ phase: 'recovery', portRecoveries: recoveries.filter(e => e.code === 'E_PORTS').length, memoryRecoveries: recoveries.filter(e => e.code === 'E_QUOTA').length, eventLog: path.join(state, 'capacity.jsonl') });
    assert(recoveries.some(e => e.code === 'E_PORTS'));
    assert(recoveries.some(e => e.code === 'E_QUOTA'));
    if (process.argv.includes('--timeout')) {
      const sleeping = (await service.store.listEnvs()).find(r => r.status === 'warm');
      assert(sleeping);
      await service.store.withLock('machine--ports', async () => {
        const start = Date.now();
        await Promise.all([
          assert.rejects(publish('timeout'), error => { say({ phase: 'timeout-publish', elapsedMs: Date.now() - start, code: error.code, message: error.message, details: error.details }); return error.code === 'E_BUSY' && /Timed out.*30000ms/.test(error.message); }),
          (async () => { const response = await fetch(`http://127.0.0.1:${sleeping.serve.proxy_port}`, { signal: AbortSignal.timeout(40000) }); const body = await response.text(); const elapsedMs = Date.now() - start; say({ phase: 'timeout-wake', elapsedMs, status: response.status, body }); assert.equal(response.status, 503); assert.match(body, /Timed out after 30000ms waiting for the machine port lock/); assert(elapsedMs < 35000); })(),
        ]);
      });
    }
    say({ PASS: true, rounds: 5 });
  }
} finally {
  for (const r of await service.store.listEnvs()) await until(async () => { try { await service.stop(r.name); return true; } catch (e) { if (e.code !== 'E_BUSY') throw e; return false; } });
  daemon.kill('SIGTERM'); await new Promise(r => daemon.once('exit', r)); await log.close();
  say({ cleanup: true });
}
