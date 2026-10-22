import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { NectarService } from "../../dist/service.js";
import { previewMemoryAvailable, servingCapacity } from "../../dist/capacity.js";
import { ownerState } from "../../dist/owner.js";
import { pidAlive, stopProcessGroup } from "../../dist/commands.js";

assert.ok(process.env.HOME.startsWith(process.cwd() + path.sep));
assert.ok(os.tmpdir().startsWith(process.cwd() + path.sep));
const root = await mkdtemp(path.join(os.tmpdir(), "session-capacity-"));
const bin = path.join(root, "bin");
await mkdir(bin);
async function executable(name, body) {
  const file = path.join(bin, name);
  await writeFile(file, `#!${process.execPath}\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}
const owners = path.join(root, "owners.json");
const processes = path.join(root, "processes.json");
const owned = [];
await writeFile(processes, "[]");
await executable("ps", `
import { readFileSync } from 'node:fs';
const rows = JSON.parse(readFileSync(${JSON.stringify(processes)}, 'utf8'));
const args = process.argv.slice(2);
if (args.includes('eww')) {
  const row = rows.find(row => row.pid === Number(args.at(-1)));
  if (row) console.log('NECTAR_ENV=' + row.name);
} else for (const row of rows) console.log(row.pid + ' ' + row.pid);
`);
await writeFile(owners, JSON.stringify([
  { id: "done", status: "done" },
  { id: "active", state: "running" },
  { id: "archived", archivedAt: new Date().toISOString() },
  { id: "unknown", state: "unrecognized" },
]));
await executable("hive", `import { readFileSync } from 'node:fs'; console.log(readFileSync(${JSON.stringify(owners)}, 'utf8'));`);
const tailscale = await executable("tailscale", `
const args = process.argv.slice(2);
if (args[0] === 'status') console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'fixture.tailtest.ts.net.'}}));
else if (args[0] === 'serve' && args[1] === 'status') console.log('{}');
else if (args[0] === 'ssh') { console.error('fixture remote unavailable'); process.exitCode = 1; }
`);
process.env.PATH = bin + path.delimiter + process.env.PATH;
await executable("vm_stat", "console.log('Mach Virtual Memory Statistics: (page size of 16384 bytes)\\nPages free: 131072.\\nPages inactive: 0.\\nPages speculative: 0.');");
process.env.NECTAR_TAILSCALE_BIN = tailscale;
process.env.NECTAR_TAILSCALE_SOCKET = path.join(root, "no-tailscale.sock");
process.env.NECTAR_LAUNCHCTL_BIN = await executable("launchctl", "process.exitCode = 1;");
process.env.NECTAR_SYSTEMCTL_BIN = await executable("systemctl", "process.exitCode = 1;");
process.env.NECTAR_TRASH_BIN = await executable("trash", "process.exitCode = 1;");
const service = new NectarService(path.join(root, "state"), { publisher: { user: "fixture", hive_bee: "active" } });
await service.store.init();
await service.store.writeConfig({
  ...await service.store.readConfig(), daemon: "disabled", serving_web_limit: 12,
  upstream_port_start: 26400, upstream_port_end: 26499,
  tailnet_port_start: 26500, tailnet_port_end: 26599,
});
const source = path.join(root, "source");
await mkdir(source);
await writeFile(path.join(source, "index.html"), "<h1>fixture preview</h1>");
const names = [];
try {
  for (let i = 0; i < 13; i++) {
    const result = await service.publish({ repo: source, mode: "static", name: `fixture-${i}`, ttl: "7d" });
    names.push(result.env);
    const record = await service.store.readEnv(result.env);
    owned.push({ pid: record.serve.pgid, name: record.name });
    await writeFile(processes, JSON.stringify(owned));
    assert.equal(await fetch(result.urls.local).then(r => r.text()), "<h1>fixture preview</h1>");
  }
  console.log("PASS: 13 serving previews published, including with stored quota 12; every local URL answers");
  await executable("vm_stat", "console.log('Mach Virtual Memory Statistics: (page size of 16384 bytes)\\nPages free: 0.\\nPages inactive: 0.\\nPages speculative: 0.');");
  if (process.platform === "darwin") {
    await assert.rejects(service.publish({ repo: source, mode: "static", name: "low-memory", ttl: "7d" }), { code: "E_QUOTA" });
    console.log("PASS: publishing refuses when fixture available memory is exhausted");
  }
  await executable("vm_stat", "console.log('Mach Virtual Memory Statistics: (page size of 16384 bytes)\\nPages free: 131072.\\nPages inactive: 0.\\nPages speculative: 0.');");
  const [done, active, unknown, archived, gone, pinned, bench, recent, remote] = names;
  for (const [name, id] of [[done, "done"], [unknown, "unknown"], [archived, "archived"], [gone, "gone"], [pinned, "done"], [bench, "done"], [recent, "done"], [remote, "done"]]) {
    const record = await service.store.readEnv(name);
    record.publisher.hive_bee = id;
    record.owner_inactive_since = new Date(Date.now() - 61 * 60_000).toISOString();
    if (name === pinned) record.pinned = true;
    if (name === bench) { record.app = "bench"; record.branch = "main"; }
    if (name === recent) delete record.owner_inactive_since;
    if (name === remote) record.publisher.node_name = "unreachable-fixture";
    await service.store.writeEnv(record);
  }
  const oldActive = await service.store.readEnv(active);
  oldActive.owner_inactive_since = new Date(Date.now() - 61 * 60_000).toISOString();
  await service.store.writeEnv(oldActive);
  const doneRecord = await service.store.readEnv(done);
  assert.equal(await ownerState(doneRecord), "inactive");
  const preview = await service.gc({ dryRun: true });
  assert.equal((await service.store.readEnv(recent)).owner_inactive_since, undefined);
  assert.deepEqual(preview.transitions.map(t => t.env).sort(), [done, archived, gone].sort());
  const report = await service.gc();
  assert.deepEqual(report.transitions.map(t => t.env).sort(), [done, archived, gone].sort());
  for (const name of [done, archived, gone]) assert.equal(await service.store.maybeEnv(name), undefined);
  assert.equal(pidAlive(doneRecord.serve.pid), false);
  await assert.rejects(fetch(doneRecord.urls.local));
  for (const name of [active, unknown, pinned, bench, recent, remote]) {
    const record = await service.store.readEnv(name);
    assert.equal(record.status, "serving");
    assert.equal(await fetch(record.urls.local).then(r => r.text()), "<h1>fixture preview</h1>");
  }
  assert.equal((await service.store.readEnv(active)).owner_inactive_since, undefined);
  assert.ok((await service.store.readEnv(recent)).owner_inactive_since);
  assert.deepEqual(report.skipped.map(r => r.env).sort(), [unknown, remote].sort());
  console.log("PASS: done, archived and gone owners reaped; process stopped, URL closed, records removed");
  console.log("PASS: active, unknown, pinned, main bench, recent done and unreachable remote owners kept");
  assert.equal(servingCapacity(16 * 1024 ** 3), 32);
  assert.equal(servingCapacity(32 * 1024 ** 3), 64);
  assert.equal(servingCapacity(64 * 1024 ** 3), 128);
  assert.equal(previewMemoryAvailable(128 * 1024 ** 2, 16 * 1024 ** 3), false);
  assert.equal(previewMemoryAvailable(2 * 1024 ** 3, 16 * 1024 ** 3), true);
  console.log(`PASS: capacity 16/32/64 GiB -> 32/64/128; this host ${Math.round(os.totalmem() / 1024 ** 3)} GiB -> ${servingCapacity()}; low-memory admission refused`);
  console.log("not checked on real data");
} finally {
  for (const name of names) if (await service.store.maybeEnv(name)) await service.stop(name);
  for (const row of owned) await stopProcessGroup(row.pid);
}
