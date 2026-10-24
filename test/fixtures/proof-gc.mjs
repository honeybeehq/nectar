import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, chmod, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runCommand } from '../../dist/commands.js';
import { DEFAULT_CONFIG } from '../../dist/state.js';

const root = path.resolve(process.argv[2] ?? '.audit/t4/live');
await mkdir(root, { recursive: true });
await chmod(root, 0o700);
const executable = async (name, body) => {
  const file = path.join(root, name);
  await writeFile(file, `#!${process.execPath}\n${body}\n`);
  await chmod(file, 0o700);
  return file;
};
const proofSource = path.join(root, 'proof-state.json');
await writeFile(proofSource, '{}');
const lookup = await executable('proof-lookup', `
import {readFileSync} from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const {ref} = JSON.parse(input);
const states=JSON.parse(readFileSync(${JSON.stringify(proofSource)},'utf8'));
const state=states[ref] ?? (ref.includes('failed') ? 'failed' : ref.includes('waiting') ? 'waiting' : 'terminal');
if(state==='failed') process.exit(1);
console.log(JSON.stringify({state}));
`);
const tailscale = await executable('tailscale', `
const args=process.argv.slice(2);
if(args[0]==='status') console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'fixture.tailtest.ts.net.'}}));
else if(args[0]==='serve' && args[1]==='status') console.log('{}');
`);
const state = path.join(root, 'state');
await mkdir(state, { recursive: true });
await writeFile(path.join(state, 'nectar.json'), JSON.stringify({...DEFAULT_CONFIG, upstream_port_start:27400,upstream_port_end:27419,tailnet_port_start:27500,tailnet_port_end:27519}));
const env = {...process.env, NECTAR_HOME:state, NECTAR_SOCKET:`/tmp/nectar-t4-${process.pid}/nectard.sock`, NECTAR_PROOF_LOOKUP:lookup, NECTAR_TAILSCALE_BIN:tailscale, NECTAR_TAILSCALE_SOCKET:path.join(root,'absent.sock')};
const cli = async (...args) => {
  const result = await runCommand(process.execPath, [path.resolve('dist/cli.js'),...args,'--json'], {env,timeoutMs:120000});
  console.log('nectar', args.join(' '), result.stdout.trim());
  assert.equal(result.exitCode,0,result.stderr);
  return JSON.parse(result.stdout).result;
};
await mkdir(path.dirname(env.NECTAR_SOCKET),{recursive:true,mode:0o700});
const daemon = spawn(process.execPath,['dist/cli.js','daemon','run','--interval','1h','--gc-interval','1h'],{env,stdio:['ignore','pipe','pipe']});
daemon.stdout.on('data', b => process.stdout.write(b));
daemon.stderr.on('data', b => process.stdout.write(b));
const names=[];
try {
  for(let n=0;n<100;n++) {
    if((await readdir(path.dirname(env.NECTAR_SOCKET)).catch(()=>[])).includes('nectard.sock')) break;
    await new Promise(r=>setTimeout(r,100));
  }
  const source=path.join(root,'source'); await mkdir(source,{recursive:true});
  await writeFile(path.join(source,'index.html'),'<h1>T4 proof-aware preview</h1>');
  for(const label of ['landed','waiting','failed']) {
    const result=await cli('publish',source,'--mode','static','--name',`t4-${label}`,'--local');
    names.push(result.env);
    assert.match(await fetch(result.urls.local).then(r=>r.text()),/T4 proof-aware/);
    console.log('URL OPENED',result.urls.local);
    const file=path.join(state,'envs',`${result.env}.json`);
    const record=JSON.parse(await readFile(file,'utf8'));
    record.publisher.hive_bee='gone-fixture';
    record.owner_inactive_since=new Date(Date.now()-2*3600000).toISOString();
    record.expires_at=new Date(Date.now()-30*86400000).toISOString();
    await writeFile(file,JSON.stringify(record));
  }
  await cli('ls');
  env.NECTAR_PROOF_LOOKUP='';
  const unconfigured=await cli('--direct','gc');
  assert.equal(unconfigured.transitions.length,0);
  assert.equal(unconfigured.skipped.filter(row=>row.reason.includes('not configured')).length,3);
  env.NECTAR_PROOF_LOOKUP=lookup;
  const first=await cli('gc');
  assert.equal(first.transitions.length,0);
  const file=path.join(state,'envs',`${names[0]}.json`);
  const record=JSON.parse(await readFile(file,'utf8'));
  assert.ok(record.proof_terminal_since);
  for (const state of ['waiting', 'failed']) {
    record.proof_terminal_since=new Date(Date.now()-25*3600000).toISOString();
    await writeFile(file,JSON.stringify(record));
    await writeFile(proofSource,JSON.stringify({[record.ref]:state}));
    await cli('gc','--dry-run');
    assert.ok(JSON.parse(await readFile(file,'utf8')).proof_terminal_since);
    await cli('gc');
    if (state === 'waiting') assert.equal(JSON.parse(await readFile(file,'utf8')).proof_terminal_since,undefined);
    else assert.equal(JSON.parse(await readFile(file,'utf8')).proof_terminal_since,record.proof_terminal_since);
    await writeFile(proofSource,'{}');
    if (state === 'failed') {
      delete record.proof_terminal_since;
      await writeFile(file,JSON.stringify(record));
    }
    await cli('gc');
    assert.ok(JSON.parse(await readFile(file,'utf8')).proof_terminal_since);
  }
  record.proof_terminal_since=new Date(Date.now()-25*3600000).toISOString();
  await writeFile(file,JSON.stringify(record));
  const report=await cli('gc');
  assert.deepEqual(report.transitions,[{env:names[0],action:'reap'}]);
  assert.ok(report.skipped.some(s=>s.env===names[1] && s.reason.includes('waiting')));
  assert.ok(report.skipped.some(s=>s.env===names[2] && s.reason.includes('exited 1')));
  await assert.rejects(fetch(record.urls.local));
  for (const name of names.slice(1)) {
    const kept=JSON.parse(await readFile(path.join(state,'envs',`${name}.json`),'utf8'));
    assert.match(await fetch(kept.urls.local).then(r=>r.text()),/T4 proof-aware/);
  }
  const remaining=await cli('ls');
  console.log('PASS: terminal reaped after 24h; waiting and failed lookup kept despite gone owner and expired TTL', JSON.stringify(remaining));
} finally {
  for(const name of names) {
    try { await cli('rm',name,'--force'); } catch {}
  }
  daemon.kill('SIGTERM'); await once(daemon,'exit');
}
