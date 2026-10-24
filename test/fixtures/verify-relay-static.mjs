import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { startRelayd } from '../../dist/relayd.js';
import { readStatus } from '../../dist/localapi.js';
import { stopServe } from '../../dist/tailscale.js';
const exec = promisify(execFile);
const root = process.cwd();
const run = await mkdtemp(path.join(root, '.audit/relay-static-'));
const state = path.join(run, 'nectar');
const routes = path.join(run, 'routes');
const caddy = path.resolve(process.env.T10_CADDY ?? '.audit/bin/caddy');
const free = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const publicPort = await free();
const adminPort = await free();
for (const dir of [state, routes, path.join(run, 'fixture/nested'), path.join(run, 'bin')]) await mkdir(dir, {recursive:true});
await writeFile(path.join(run, 'fixture/index.html'), '<h1>T10 static body</h1><script src="./asset.js"></script>');
await writeFile(path.join(run, 'fixture/asset.js'), 'T10 relative asset');
await writeFile(path.join(run, 'fixture/nested/index.html'), 'T10 nested body');
await writeFile(path.join(run, 'bin/hive'), '#!/bin/sh\necho \'[{"id":"t10-owner","status":"running"}]\'\n', {mode:0o700});
const sock = await mkdtemp(path.join(os.tmpdir(), 'nectar-t10-'));
const env = {...process.env, PATH:`${run}/bin:${process.env.PATH}`, HIVE_BEE:'t10-owner', HIVE_SESSION:'t10-owner', NECTAR_HOME:state, NECTAR_SOCKET:path.join(sock,'d.sock')};
const status = await readStatus();
if (!status.ok) throw new Error('tailscale unavailable');
const dns = status.status.Self.DNSName.replace(/\.$/, '').toLowerCase();
const nodeId = 'nT10FIXTURE1CNTRL';
const configFile = path.join(run,'relayd.json');
const caddyFile = path.join(run,'Caddyfile');
await writeFile(caddyFile, `{\n admin 127.0.0.1:${adminPort}\n auto_https off\n}\nhttp://:${publicPort} {\n bind 127.0.0.1\n import ${routes}/*.caddy\n}\n`);
await writeFile(configFile, JSON.stringify({domain:'t10.invalid', allow:[{node_id:nodeId}], ungated:[{node_id:nodeId}], state_dir:path.join(run,'relay-state'),routes_dir:routes, admin_socket:path.join(sock,'r.sock'),control:{port:0},verify:{port:0},hash:[caddy,'hash-password'],reload:{argv:[caddy,'reload','--config',caddyFile,'--address',`127.0.0.1:${adminPort}`]}}));
const cp = spawn(caddy,['run','--config',caddyFile],{env:{...process.env,XDG_DATA_HOME:path.join(run,'caddy-data'),XDG_CONFIG_HOME:path.join(run,'caddy-config')},stdio:'ignore'});
const daemon = spawn(process.execPath,[path.join(root,'dist/cli.js'),'daemon','run','--interval','2s','--gc-interval','1h'],{env,stdio:'ignore'});
let relay;
let shared;
const owned=[];
const cli = async (...args) => { const {stdout}=await exec(process.execPath,[path.join(root,'dist/cli.js'),...args,'--json'],{env});const e=JSON.parse(stdout);if(!e.ok)throw new Error(stdout);return e.result; };
const log = (s) => process.stdout.write(`${s}\n`);
try {
 for(let i=0;i<100;i++){if(await readFile(path.join(state,'nectard.pid'),'utf8').catch(()=>''))break;await new Promise(r=>setTimeout(r,100));}
 await new Promise(r=>setTimeout(r,500));
 const openRelay = () => startRelayd(configFile,{bind:'127.0.0.1',whois:async()=>({peer:{nodeId,dnsName:dns,nodeName:'t10',loginName:'fixture',displayName:'fixture',userId:1,nodeUserId:1,tailscaleIPs:['100.64.0.2'],tags:[]}}), status:async()=>({...status,status:{...status.status,Self:{ID:'t10-isolated-relay',TailscaleIPs:['100.64.0.1']}}}),log:()=>{}});
 relay = await openRelay();
 await writeFile(path.join(state,'nectar.json'),JSON.stringify({upstream_port_start:30000,upstream_port_end:30100,tailnet_port_start:31000,tailnet_port_end:31100,exposures:{site:{kind:'relay',host:'127.0.0.1',port:relay.control.port,domain:'t10.invalid',control:'relayd',default:true}}}));
 log(`Isolated nectard PID=${daemon.pid}, Caddy PID=${cp.pid}, relayd control=${relay.control.port}, public HTTP=${publicPort}; private state=${run}`);
 log('Relayd uses the test-supported injected publisher identity for loopback control; upstream traffic uses real tailnet HTTPS and real Caddy.');
 const pub=await cli('publish',path.join(run,'fixture'),'--mode','static','--name','t10-static','--branch','fixture','--local','--public');
 owned.push(pub.env);if(pub.via!=='nectard')throw new Error('daemon bypass');
 shared=JSON.parse(await readFile(path.join(state,'shared-static.json'),'utf8'));
 const record=JSON.parse(await readFile(path.join(state,'envs',`${pub.env}.json`),'utf8'));
 const exposed={...record.exposure,password:pub.public?.password};
 if(!exposed)throw new Error('publish --public did not expose');
 const host=new URL(exposed.url).host;
 const curl=async (p,auth=true)=> (await exec('curl',['--max-time','20','--silent','--show-error','--fail',...(auth?['-u',`reviewer:${exposed.password}`]:[]),'-H',`Host: ${host}`,`http://127.0.0.1:${publicPort}${p}`])).stdout;
 log(`Published via nectard: ${record.urls.mesh}; exposed ${exposed.url}`);

 for(const [p,expected] of [['/','T10 static body'],['/asset.js','T10 relative asset'],['/nested/','T10 nested body']]){const body=await curl(p);if(!body.includes(expected))throw new Error(body);log(`PASS public ${p}: ${body}`);}
 const redirect=await exec('curl',['-sS','-D','-','-o','/dev/null','-u',`reviewer:${exposed.password}`,'-H',`Host: ${host}`,`http://127.0.0.1:${publicPort}/nested`]);
 if(!/location: \/nested\//i.test(redirect.stdout))throw new Error(redirect.stdout);log(`PASS directory redirect: ${redirect.stdout.trim()}`);
 const denied=await exec('curl',['-sS','-o','/dev/null','-w','%{http_code}','-H',`Host: ${host}`,`http://127.0.0.1:${publicPort}/`]);if(denied.stdout!=='401')throw new Error('gate bypass');log('PASS password gate: unauthenticated HTTP 401');
 await relay.close();relay=await openRelay();
 const updatedConfig=JSON.parse(await readFile(path.join(state,'nectar.json'),'utf8'));updatedConfig.exposures.site.port=relay.control.port;await writeFile(path.join(state,'nectar.json'),JSON.stringify(updatedConfig));
 if(!(await curl('/')).includes('T10 static body'))throw new Error('persisted route failed');
 log('PASS relayd restart reloads persisted static route and serves through Caddy');
 const siblingFixture=path.join(run,'sibling');await mkdir(siblingFixture);await writeFile(path.join(siblingFixture,'index.html'),'T10 sibling private body');
 const sibling=await cli('publish',siblingFixture,'--mode','static','--name','t10-sibling','--branch','fixture','--local');owned.push(sibling.env);
 const siblingPath=new URL(sibling.urls.mesh).pathname;
 for(const attack of [`/../../${siblingPath.slice(3)}`,`/%2e%2e/%2e%2e/${siblingPath.slice(3)}`,`/..%5c..%5c${siblingPath.slice(3)}`,`/..\\..\\${siblingPath.slice(3)}`,`/%2E./.%2e/${siblingPath.slice(3)}`]){
  const out=await exec('curl',['--max-time','20','-sS','-w','\n%{http_code}','--path-as-is','-u',`reviewer:${exposed.password}`,'-H',`Host: ${host}`,`http://127.0.0.1:${publicPort}${attack}`]);
  if(out.stdout.includes('T10 sibling private body'))throw new Error(`Public route escaped static prefix: ${attack}`);
  if(!out.stdout.endsWith('400'))throw new Error(`Traversal was not refused: ${out.stdout}`);
  log(`PASS public request cannot escape prefix (HTTP 400): ${attack}`);
 }
 const api=async(body)=>{const res=await fetch(`http://127.0.0.1:${relay.control.port}/routes`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:'t10-forged',expires_at:Math.floor(Date.now()/1000)+3600,gate:'none',...body})});return {status:res.status,body:await res.json()};};
 for(const upstream of [`https://other.ts.net:31000`,...[443,8440,8441,8450,8451].map(p=>`https://${dns}:${p}`),`${record.urls.mesh}../`,`${record.urls.mesh}%2e%2e/`,`https://${dns}:31000/s/../${'a'.repeat(32)}/`]){const r=await api({upstream});if(r.status!==403)throw new Error(JSON.stringify(r));log(`PASS refused ${upstream}: ${JSON.stringify(r)}`);}
 for(const name of ['constructor','__proto__','prototype','toString','hasOwnProperty']){const r=await api({name,upstream:record.urls.mesh});if(r.status<400)throw new Error('prototype accepted');log(`PASS refused name ${name}: HTTP ${r.status}`);}
 const dev=path.join(run,'dev');await mkdir(dev);
 await writeFile(path.join(dev,'nectar.toml'),'name="t10-dynamic"\n[web]\nserve="exec node server.mjs"\n');
 await writeFile(path.join(dev,'server.mjs'),`import http from 'node:http';http.createServer((q,s)=>s.end('T10 dynamic body')).listen(Number(process.env.PORT),'127.0.0.1');`);
 for(const args of [['init','-q',dev],['-C',dev,'add','.'],['-C',dev,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture']])await exec('git',args);
 const dynamic=await cli('publish',dev,'--local');owned.push(dynamic.env);
 await cli('expose',dynamic.env,'--public','--gate','none');
 const dr=JSON.parse(await readFile(path.join(state,'envs',`${dynamic.env}.json`),'utf8'));
 const body=(await exec('curl',['-fsS','-H',`Host: ${new URL(dr.exposure.url).host}`,`http://127.0.0.1:${publicPort}/`])).stdout;
 if(body!=='T10 dynamic body')throw new Error(body);log(`PASS dynamic ${dr.urls.mesh} -> ${dr.exposure.url}: ${body}`);
 for(const p of [8543,65535]){const r=await api({upstream:`https://${dns}:${p}`});if(r.status!==201)throw new Error(JSON.stringify(r));log(`PASS widened port ${p}: HTTP 201`);}
 log('PASS all checks');
} finally {
 for(const name of owned)await cli('stop',name).catch(e=>log(`cleanup ${e.message}`));
 if(!shared) shared=await readFile(path.join(state,'shared-static.json'),'utf8').then(JSON.parse).catch(()=>undefined);
 if(shared) { process.kill(shared.pid,'SIGTERM'); if(shared.tailnetPort) await stopServe(shared.tailnetPort); }
 daemon.kill('SIGTERM');await relay?.close();cp.kill('SIGTERM');
 log('Stopped only owned previews and fixture processes; production relay untouched.');
}
