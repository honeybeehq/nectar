import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, appendFile, chmod, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execFile);
const root = process.cwd();
const run = path.join(root, '.audit', `static-${Date.now()}`);
const state = path.join(run, 'state');
const fixture = path.join(run, 'fixture');
await mkdir(run, { recursive: true, mode: 0o700 });
await chmod(run, 0o700);
await mkdir(fixture, { recursive: true });
await mkdir(state, { recursive: true });
await mkdir(path.join(fixture, 'nested'));
await writeFile(path.join(fixture, 'index.html'), '<!doctype html><title>Shared static fixture</title><script src="./asset.js"></script><h1>shared-static-ok</h1>');
await writeFile(path.join(fixture, 'asset.js'), 'window.sharedStatic = true;');
await writeFile(path.join(fixture, 'nested', 'index.html'), 'nested-static-ok');
await mkdir(path.join(run, "bin"));
await writeFile(path.join(run, "bin", "hive"), '#!/bin/sh\necho \'[{"id":"static-verification-owner","status":"running"}]\'\n', { mode: 0o700 });
const lookup = path.join(run, 'proof-lookup');
await writeFile(lookup, `#!${process.execPath}\nfor await (const chunk of process.stdin) {}\nconsole.log(JSON.stringify({state:'unlinked'}));\n`, {mode:0o700});
const socketDir = await mkdtemp(path.join(os.tmpdir(), "nectar-t2-"));
const env = { ...process.env, NECTAR_PROOF_LOOKUP:lookup, PATH: `${path.join(run, "bin")}:${process.env.PATH}`, HIVE_BEE: "static-verification-owner", HIVE_SESSION: "static-verification-owner", NECTAR_HOME: state, NECTAR_SOCKET: path.join(socketDir, "nectard.sock") };
const log = path.join(run, 'evidence.log');
const output = async (text) => { process.stdout.write(`${text}\n`); await appendFile(log, `${text}\n`); };
const cli = async (...args) => {
  for (let attempt=0;attempt<100;attempt++) {
    const result=await exec(process.execPath,[path.join(root,'dist/cli.js'),...args,'--json'],{env,maxBuffer:10*1024*1024}).catch(error=>({stdout:error.stdout}));
    const envelope=JSON.parse(result.stdout);
    if(envelope.ok)return envelope.result;
    if(envelope.error?.code!=='E_BUSY'||attempt===99)throw new Error(result.stdout);
    await output(`RETRY E_BUSY command=${args.join(' ')} attempt=${attempt+1} waitMs=100`);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
};
const daemon = spawn(process.execPath, [path.join(root, 'dist/cli.js'), 'daemon', 'run', '--interval', '2s', '--gc-interval', '1h'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let daemonLog = '';
daemon.stdout.on('data', (chunk) => { daemonLog += chunk; });
daemon.stderr.on('data', (chunk) => { daemonLog += chunk; });
let shared;
let legacyEnv;
let recipeEnv;
try {
  for (let n = 0; n < 100; n++) {
    if (daemon.exitCode !== null) throw new Error(daemonLog);
    if (await readFile(path.join(state, 'nectard.pid'), 'utf8').catch(() => '') !== '') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (daemonLog.includes("control_unavailable")) throw new Error(daemonLog);
  await output(`Isolated NECTAR_HOME=${state}; nectard PID=${daemon.pid}`);
  const previews = [];
  for (let n = 0; n < 32; n++) {
    const result = await cli('publish', fixture, '--mode', 'static', '--name', `shared-fixture-${n}`, '--branch', 'static', '--local');
    if (result.via !== "nectard") throw new Error("Publish bypassed isolated nectard");
    const url = result.urls.local;
    const response = await exec('curl', ['--fail', '--silent', '--show-error', url]);
    if (!response.stdout.includes('shared-static-ok')) throw new Error(`Wrong preview: ${url}`);
    const asset = await exec('curl', ['--fail', '--silent', '--show-error', new URL('./asset.js', url).href]);
    if (!asset.stdout.includes('window.sharedStatic')) throw new Error('Relative asset failed');
    const nested = await exec('curl', ['--fail', '--silent', '--show-error', '--location', new URL('./nested', url).href]);
    if (!nested.stdout.includes('nested-static-ok')) throw new Error('Nested directory redirect failed');
    previews.push(result);
    await output(`PASS ${n + 1}/32 curl ${url} (HTML, relative JS, nested redirect); preview_url=${result.packet_fields.preview_url}`);
  }
  shared = JSON.parse(await readFile(path.join(state, 'shared-static.json'), 'utf8'));
  const records = await Promise.all(previews.map((result) => readFile(path.join(state, 'envs', `${result.env}.json`), 'utf8').then(JSON.parse)));
  if (records.some((record) => record.serve !== undefined)) throw new Error('Per-preview runtime found');
  if (new Set(previews.map((result) => new URL(result.urls.local).port)).size !== 1) throw new Error('Multiple listener ports');
  await output(`PASS 32 records, 0 per-preview processes/ports, 1 shared listener, 32 unique URLs=${new Set(previews.map((p) => p.urls.local)).size}`);
  await output((await exec('ps', ['-o', 'pid,ppid,args', '-p', String(shared.pid)])).stdout.trim());
  const before = previews[0];
  const republished = await cli('publish', fixture, '--mode', 'static', '--name', 'shared-fixture-0', '--branch', 'static', '--local');
  if (republished.urls.local !== before.urls.local) throw new Error('Republish changed URL');
  await output('PASS republish keeps the same URL');
  await cli('stop', previews[1].env);
  const stopped = await exec('curl', ['--silent', '--output', '-', '--write-out', '\n%{http_code}', previews[1].urls.local]);
  if (!stopped.stdout.endsWith('410')) throw new Error('Stopped preview still served');
  await exec('curl', ['--fail', '--silent', previews[2].urls.local]);
  await output(`PASS stop affects only one preview: ${stopped.stdout.trim()}`);
  const expiring = await cli('publish', fixture, '--mode', 'static', '--name', 'shared-fixture-expired', '--branch', 'static', '--ttl', '1s', '--local');
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const expired = await exec('curl', ['--silent', '--output', '-', '--write-out', '\n%{http_code}', expiring.urls.local]);
  if (!expired.stdout.endsWith('410') || !expired.stdout.includes('expired')) throw new Error('Expired preview still served');
  await output(`PASS expiry before GC: ${expired.stdout.trim()}`);
  await cli('gc');
  const expiredRecord = JSON.parse(await readFile(path.join(state, 'envs', `${expiring.env}.json`), 'utf8'));
  if (expiredRecord.status !== 'expired') throw new Error(`GC failed: ${expiredRecord.status}`);
  await output('PASS real GC transitions expired fixture to expired');
  process.kill(shared.pid, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const recovered = JSON.parse(await readFile(path.join(state, 'shared-static.json'), 'utf8'));
  if (recovered.pid === shared.pid) throw new Error('Daemon did not restore shared server');
  shared = recovered;
  await exec('curl', ['--fail', '--silent', previews[0].urls.local]);
  await output(`PASS nectard restored shared server PID=${shared.pid} on same port=${shared.port}; original URL serves`);
  const healthyPid = shared.pid;
  process.kill(healthyPid, 'SIGSTOP');
  for (let attempt = 0; attempt < 250; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = JSON.parse(await readFile(path.join(state, 'shared-static.json'), 'utf8'));
    if (current.pid !== healthyPid) { shared = current; break; }
  }
  if (shared.pid === healthyPid) throw new Error('Daemon did not recover hung shared server');
  let restored;
  for (let attempt = 0; attempt < 100; attempt++) {
    restored = await cli('resolve', previews[0].env);
    try {
      await exec('curl', ['--fail', '--silent', restored.urls.local]);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (restored.urls.mesh !== previews[0].urls.mesh) throw new Error('Hung recovery changed canonical preview URL');
  await exec('curl', ['--fail', '--silent', restored.urls.local]);
  await output(`PASS nectard recovered hung owned server after repeated probes, PID=${shared.pid}; original preview_url preserved`);
  await output(`Mesh URL from envelope: ${previews[0].packet_fields.preview_url}`);
  const legacy = await cli('publish', fixture, '--mode', 'static', '--name', 'legacy-fixture', '--branch', 'static', '--local');
  legacyEnv = legacy.env;
  const { StateStore } = await import('../dist/state.js');
  const { getPaths } = await import('../dist/paths.js');
  const { allocatePort } = await import('../dist/ports.js');
  const { scrubbedEnvironment, spawnDetachedExecutable } = await import('../dist/commands.js');
  const { serveStatus, statusPorts, serveWeb } = await import('../dist/tailscale.js');
  const store = new StateStore(getPaths(state));
  let record = await store.readEnv(legacyEnv);
  const reserved = statusPorts(await serveStatus());
  const upstream = await allocatePort({ start: 4100, end: 4199, reserved });
  const tailnet = await allocatePort({ start: 8443, end: 8542, reserved });
  const entry = path.join(root, 'dist/static-server.js');
  const child = spawnDetachedExecutable(process.execPath, [entry], record.worktree,
    scrubbedEnvironment({ PORT: String(upstream), NECTAR_ENV: record.name }), path.join(state, 'logs', 'legacy-fixture.log'));
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  record.serve = { ...child, cmd: `exec ${quote(process.execPath)} ${quote(entry)}`, upstream_port: upstream, tailnet_port: tailnet };
  delete record.static_route;
  record.urls.local = `http://127.0.0.1:${upstream}`;
  record.urls.mesh = `https://${new URL(previews[0].urls.mesh).hostname}:${tailnet}`;
  await store.writeEnv(record);
  const served = await serveWeb(tailnet, record.urls.local);
  if (!served.ok) throw new Error(served.message);
  for(let attempt=0;attempt<100;attempt++){const current=await store.readEnv(legacyEnv);if(current.serve?.proxy_port!==undefined){record=current;break;}await new Promise(resolve=>setTimeout(resolve,100));}
  await store.withLock('machine--ports',async()=>{});
  const republishedLegacy = await cli('publish', fixture, '--mode', 'static', '--name', 'legacy-fixture', '--branch', 'static', '--local');
  if (republishedLegacy.urls.mesh !== record.urls.mesh) throw new Error('Legacy republish changed URL');
  await exec('curl', ['--fail', '--silent', republishedLegacy.urls.local]);
  await output(`PASS pre-upgrade static fixture retains mesh URL on republish; local URL uses daemon proxy: ${record.urls.mesh}`);
  const recipeRepo = path.join(run, 'recipe-fixture');
  await mkdir(path.join(recipeRepo, 'src'), { recursive: true });
  await mkdir(path.join(recipeRepo, 'dist'));
  await writeFile(path.join(recipeRepo, 'index.html'), 'wrong-root');
  await writeFile(path.join(recipeRepo, 'dist/index.html'), 'recipe-static-dist-ok');
  await writeFile(path.join(recipeRepo, 'src/static-server.ts'), await readFile(path.join(root, 'src/static-server.ts')));
  await writeFile(path.join(recipeRepo, 'nectar.toml'), 'name = "recipe-static-fixture"\n[web]\nserve = "node src/static-server.ts dist"\nready_path = "/"\n');
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'fixture@example.test'], ['config', 'user.name', 'Static Fixture'], ['add', '.'], ['commit', '-m', 'static recipe fixture']]) {
    await exec('git', args, { cwd: recipeRepo });
  }
  const recipe = await cli('publish', recipeRepo, '--local');
  recipeEnv = recipe.env;
  if ((await store.readEnv(recipeEnv)).serve !== undefined) throw new Error('Static recipe started a per-preview process');
  const recipeBody = await exec('curl', ['--fail', '--silent', recipe.urls.local]);
  if (recipeBody.stdout !== 'recipe-static-dist-ok') throw new Error('Static recipe root argument was lost');
  await output('PASS recipe node src/static-server.ts dist uses shared server and serves the requested built root');
  await output('PASS verification complete');
} finally {
  if (legacyEnv !== undefined) await cli('stop', legacyEnv);
  if (recipeEnv !== undefined) await cli('stop', recipeEnv);
  if (shared === undefined) shared = JSON.parse(await readFile(path.join(state, 'shared-static.json'), 'utf8').catch(() => 'null'));
  daemon.kill('SIGTERM');
  await new Promise(resolve=>daemon.once('exit',resolve));
  shared=JSON.parse(await readFile(path.join(state,'shared-static.json'),'utf8').catch(()=>'null'));
  if(shared)try{process.kill(shared.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
  if (shared?.tailnetPort !== undefined) {
    const { stopServe } = await import('../dist/tailscale.js');
    await stopServe(shared.tailnetPort);
  }
  await writeFile(path.join(run, 'daemon.log'), daemonLog);
  await output(`Evidence: ${log}`);
}
