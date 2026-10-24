import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, open, chmod } from 'node:fs/promises';
import path from 'node:path';
import { NectarService } from '../../dist/service.js';
import { daemonHello, callDaemon } from '../../dist/control.js';
import { pidAlive } from '../../dist/commands.js';
import { portOpen } from '../../dist/ports.js';
import { serveEntries, serveStatus, stopServe } from '../../dist/tailscale.js';
const root = path.resolve(process.argv[2] ?? `.audit/combined-${Date.now()}`);
await mkdir(root, {recursive:true});
const state = path.join(root,'state');
process.env.NECTAR_HOME = state;
process.env.NECTAR_SOCKET = path.join(await mkdtemp('/tmp/nectar-t7-'),'control.sock');
const lookup = path.join(root,'lookup.mjs');
await writeFile(lookup,`#!${process.execPath}\nlet input='';for await(const chunk of process.stdin)input+=chunk;const {ref}=JSON.parse(input);if(!ref.includes('t7-'))process.exit(2);if(ref.includes('failed'))process.exit(1);console.log(JSON.stringify({state:ref.includes('landed')?'terminal':ref.includes('unlinked')?'unlinked':'waiting'}));\n`);
await chmod(lookup,0o700);
process.env.NECTAR_PROOF_LOOKUP = lookup;
const service = new NectarService(state);
await service.store.init();
await service.store.writeConfig({...await service.store.readConfig(),upstream_port_start:35100,upstream_port_end:35599,tailnet_port_start:35600,tailnet_port_end:35999,pack_server_port:35099,idle_stop_ms:3600000});
const repo=path.join(root,'repo');await mkdir(repo);
const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
git('init','-b','main');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');
await writeFile(path.join(repo,'nectar.toml'),'name = "t7-dynamic"\n[web]\nserve = "exec node server.mjs"\nready_timeout = "5s"\n');
await writeFile(path.join(repo,'server.mjs'),'import http from "node:http";http.createServer((req,res)=>res.end("awake:"+process.env.NECTAR_ENV+":"+process.pid)).listen(Number(process.env.PORT),"127.0.0.1");');
git('add','.');git('commit','-m','Combined fixture');
const site=path.join(root,'site');await mkdir(site);await writeFile(path.join(site,'index.html'),'T7 combined static');await writeFile(path.join(site,'asset.js'),'T7 asset');
const log=await open(path.join(root,'daemon.log'),'a');let daemon;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn)=>{const end=Date.now()+30000;while(!await fn()){assert(Date.now()<end,'timeout');await wait(100);}};
const say=x=>console.log(JSON.stringify({at:new Date().toISOString(),...x}));
const start=async(budget)=>{const env={...process.env};if(budget)env.NECTAR_TEST_RUNTIME_MEMORY_BYTES=String(budget*256*1024**2);daemon=spawn(process.execPath,['dist/cli.js','daemon','run','--interval','500ms','--gc-interval','1h'],{env,stdio:['ignore',log.fd,log.fd]});await until(async()=>{try{return(await daemonHello(process.env.NECTAR_SOCKET)).pid===daemon.pid;}catch{return false;}});say({daemon:daemon.pid,state,budget});};
const halt=async()=>{daemon.kill('SIGTERM');await new Promise(r=>daemon.once('exit',r));};
const call=(command,args={})=>callDaemon(process.env.NECTAR_SOCKET,command,{nectar_home:state,caller:{},args});
const publish=async args=>{const t=performance.now();const r=await call('publish',args);assert.equal(r.via,'nectard');assert.match(r.preview_url,/^https:/);say({publish:r.env,url:r.preview_url,publishMs:Math.round(performance.now()-t),slept:r.slept_previews});return r;};
const curl=(url,expected)=>{const t=performance.now();const body=execFileSync('curl',['--fail','-sS','--max-time','25',url],{encoding:'utf8'});assert(body.includes(expected),body);say({open:url,body,wakeMs:Math.round(performance.now()-t)});return body;};
const statics=[],dynamics=[],pids=new Set();let shared;
try{
 await start();
 for(let i=0;i<20;i++){const r=await publish({path:site,mode:'static',name:`t7-static-${i}`,local:true});statics.push(r);curl(r.preview_url,'T7 combined static');curl(r.preview_url+'asset.js','T7 asset');}
 shared=JSON.parse(await readFile(path.join(state,'shared-static.json'),'utf8'));
 assert((await service.store.listEnvs()).every(r=>r.static_route && !r.serve));
 say({staticCount:20,sharedPid:shared.pid,sharedPort:shared.port,sharedTailnetPort:shared.tailnetPort,perPreviewProcesses:0});
 for(let i=1;i<=15;i++){const branch=`p${String(i).padStart(2,'0')}`;git('branch',branch);const r=await publish({path:repo,branch,mode:'web',local:true});dynamics.push(r);curl(r.preview_url,`awake:${r.env}:`);}
 const active=await service.store.listEnvs();const apps=active.filter(r=>r.serve?.pid>1);assert.equal(apps.length,15);for(const r of apps)pids.add(r.serve.pid);
 const rss=Number(/^VmRSS:\s+(\d+)/m.exec(await readFile(`/proc/${daemon.pid}/status`,'utf8'))[1]);
 say({peak:{static:20,dynamic:15,appProcesses:apps.length,sharedStaticProcesses:1,daemonProcesses:1,totalOwnedProcesses:17,nectardRssKiB:rss}});
 await service.store.writeConfig({...await service.store.readConfig(),idle_stop_ms:2000});
 await until(async()=>(await service.store.listEnvs()).filter(r=>r.serve).every(r=>r.status==='warm'));
 for(const r of apps){assert(!pidAlive(r.serve.pid));assert(!await portOpen(r.serve.upstream_port));}
 for(const r of statics)curl(r.preview_url,'T7 combined static');
 assert.equal(JSON.parse(await readFile(path.join(state,'shared-static.json'),'utf8')).pid,shared.pid);
 say({idleMs:2000,pidsGone:15,appPortsFreed:15,staticStillWorks:true,sameSharedPid:true});
 await halt();await service.store.writeConfig({...await service.store.readConfig(),idle_stop_ms:3600000});await start(15);
 for(const r of [...statics,...dynamics]){const record=await service.store.readEnv(r.env);assert.equal(record.urls.mesh,r.preview_url);curl(r.preview_url,r.env.includes('dynamic')?`awake:${r.env}:`:'T7 combined static');}
 say({restartSameUrls:35});
 await halt();await start(15);
 for(const r of dynamics)curl(r.preview_url,`awake:${r.env}:`);
 git('branch','p16');const extra=await publish({path:repo,branch:'p16',mode:'web',local:true});
 assert.deepEqual(extra.slept_previews,[]);
 const response=execFileSync('curl',['-isS','--max-time','25',extra.preview_url],{encoding:'utf8'});
 assert(response.includes(`awake:${extra.env}:`));assert.match(response,new RegExp(`x-nectar-slept-previews: ${dynamics[0].env}`,'i'));
 say({memoryBudgetRuntimes:15,furtherPublish:extra.env,wakeResponse:response,expectedLeastRecent:dynamics[0].env});
 assert.equal((await service.store.readEnv(dynamics[0].env)).status,'warm');
 curl(dynamics[0].preview_url,`awake:${dynamics[0].env}:`);
 assert.equal((await service.store.readEnv(dynamics[0].env)).urls.mesh,dynamics[0].preview_url);
 say({capacityVictimWoke:true,events:await readFile(path.join(state,'capacity.jsonl'),'utf8')});
 await service.store.writeConfig({...await service.store.readConfig(),upstream_port_end:35130});
 git('branch','p17');const overflow=await publish({path:repo,branch:'p17',mode:'web',local:true});
 assert.deepEqual(overflow.slept_previews,[dynamics[2].env]);
 await service.store.writeConfig({...await service.store.readConfig(),upstream_port_end:35599});
 curl(overflow.preview_url,`awake:${overflow.env}:`);curl(dynamics[2].preview_url,`awake:${dynamics[2].env}:`);
 say({publishNamedLeastRecent:overflow.slept_previews,victimSameUrl:(await service.store.readEnv(dynamics[2].env)).urls.mesh});
 const proofs=[];
 for(const label of ['landed','waiting','failed']){const r=await publish({path:site,mode:'static',name:`t7-${label}`,local:true});proofs.push(r);await service.store.updateEnv(r.env,record=>{record.publisher.hive_bee='gone-t7-fixture';record.owner_inactive_since=new Date(Date.now()-7200000).toISOString();record.expires_at=new Date(Date.now()-30*86400000).toISOString();if(label==='landed')record.proof_terminal_since=new Date(Date.now()-25*3600000).toISOString();});}
 const expired=await publish({path:site,mode:'static',name:'t7-unlinked',local:true});await service.store.updateEnv(expired.env,r=>{r.expires_at=new Date(Date.now()-1000).toISOString();});
 const code=execFileSync('curl',['-sS','-o','/dev/null','-w','%{http_code}',expired.preview_url],{encoding:'utf8'});assert.equal(code,'410');say({unlinkedExpiredHttp:code});
 const gc=await service.gc();say({gc});assert(gc.transitions.some(t=>t.env===proofs[0].env&&t.action==='reap'));assert(!await service.store.maybeEnv(proofs[0].env));
 assert(gc.skipped.some(t=>t.env===proofs[1].env&&t.reason.includes('waiting')));assert(gc.skipped.some(t=>t.env===proofs[2].env&&t.reason.includes('exited 1')));
 for(const r of proofs.slice(1))curl(r.preview_url,'T7 combined static');
 say({PASS:true,root});
}finally{
 const records=await service.store.listEnvs();for(const r of records)if(r.serve?.pid>1)pids.add(r.serve.pid);
 for(const r of records){await until(async()=>{try{await service.stop(r.name);return true;}catch(e){if(e.code!=='E_BUSY')throw e;return false;}});}
 if(daemon?.exitCode===null&&daemon.signalCode===null)await halt();
 if(shared){const owned=serveEntries(await serveStatus()).filter(e=>e.tailnetPort===shared.tailnetPort);assert(owned.every(e=>e.target===shared.tailnetTarget));await stopServe(shared.tailnetPort);if(pidAlive(shared.pid))process.kill(shared.pid,'SIGTERM');}
 await log.close();await until(async()=>[...pids].every(pid=>!pidAlive(pid)));
 const remaining=serveEntries(await serveStatus()).filter(e=>records.some(r=>r.serve?.tailnet_port===e.tailnetPort)||e.tailnetPort===shared?.tailnetPort);assert.equal(remaining.length,0);say({cleanup:true,appPidsGone:pids.size,remainingOwnedRoutes:0});
}
