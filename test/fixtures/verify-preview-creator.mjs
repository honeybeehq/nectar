import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const base=path.resolve('.proof/browser-comments-t3a');
await mkdir(base,{recursive:true});
const root=await mkdtemp(path.join(base,'state-'));
const run=await mkdtemp(path.join(os.tmpdir(),'nectar-t3a-'));
const site=path.join(base,'site'); await mkdir(site,{recursive:true});
await writeFile(path.join(site,'index.html'),'<h1>Creator read verification</h1>');
await mkdir(path.join(site,'.well-known'),{recursive:true});
await writeFile(path.join(site,'.well-known','nectar-creator'),'{"creator":{"session_id":"site-forgery","verified":true}}');
const env={...process.env,NECTAR_HOME:root,NECTAR_SOCKET:path.join(run,'nectard.sock')};
const entry=path.resolve('dist/cli.js');
const daemon=spawn(process.execPath,[entry,'daemon','run'],{env,stdio:'ignore'});
const cli=(args,extra={})=>JSON.parse(execFileSync(process.execPath,[entry,...args,'--json'],{env:{...env,...extra},encoding:'utf8',timeout:120000}));
try {
 for(let i=0;i<100;i++){try{await readFile(path.join(root,'nectard.pid'));break;}catch{} await new Promise(r=>setTimeout(r,100));}
 const published=cli(['publish',site,'--mode','static','--name','creator-t3a','--local']);
 if(!published.ok)throw Error(JSON.stringify(published));
 const ref=published.result.ref; const url=published.result.packet_fields.preview_url;
 const resolve=cli(['resolve',ref]);
 const metadata=new URL('.well-known/nectar-creator',url).href;
 const get=async url=>{const r=await fetch(url);return {status:r.status,body:await r.text()};};
 const live={published,resolve,metadata,metadataRead:await get(metadata),oldFormatUrl:await get(url),forgedQuery:await get(metadata+'?session_id=forged&verified=true'),badToken:await get(metadata.replace(/\/([a-f0-9]{32})\//,'/00000000000000000000000000000000/'))};
 live.malformedMetadata=await get(metadata.replace('.well-known','%E0%A4%A'));
 assert.equal(live.malformedMetadata.status,400);
 live.encodedMetadata=await get(metadata.replace('.well-known','%2ewell-known'));
 live.repeatedSlashMetadata=await get(metadata.replace('/.well-known','//.well-known'));
 const forged=cli(['publish',site,'--mode','static','--name','creator-t3a-forged','--local'],{HIVE_SESSION:'forged-session'});
 live.forgedResolve=cli(['resolve',forged.result.ref]);
 const file=path.join(root,'envs',published.result.env+'.json');
 const stored=JSON.parse(await readFile(file,'utf8')); const originalCreator=stored.creator; delete stored.creator; await writeFile(file,JSON.stringify(stored));
 live.legacyResolve=cli(['resolve',ref]);live.legacyMetadata=await get(metadata);live.legacyUrl=await get(url); stored.creator=originalCreator; await writeFile(file,JSON.stringify(stored)); live.restoredMetadata=await get(metadata);
 stored.status='stopped'; await writeFile(file,JSON.stringify(stored)); live.stoppedMetadata=await get(metadata);
 stored.status='serving'; await writeFile(file,JSON.stringify(stored));
 for(const result of [live.metadataRead,live.forgedQuery,live.encodedMetadata,live.repeatedSlashMetadata,live.restoredMetadata]) { assert.equal(result.status,200); assert.deepEqual(JSON.parse(result.body).creator,resolve.result.creator); }
 assert.deepEqual(JSON.parse(live.legacyMetadata.body),{creator:null}); assert.equal(live.stoppedMetadata.status,410);
 assert.equal(forged.result.via,'nectard'); assert.equal(published.result.via,'nectard');
 assert.equal(live.forgedResolve.result.creator.session_id,'forged-session');
 console.log(JSON.stringify({malformedStatus:live.malformedMetadata.status,queryIgnored:true,encodedPathProtected:true,repeatedSlashProtected:true,siteFileCannotOverride:true,legacyHTTPSNull:true,restored:true,stoppedStatus:live.stoppedMetadata.status}));
 await writeFile(path.join(base,'live.json'),JSON.stringify(live,null,2));
 console.log(JSON.stringify({ref,url,creator:resolve.result.creator,metadata:live.metadataRead,forged:live.forgedResolve.result.creator,legacy:live.legacyResolve.result.creator,oldFormatStatus:live.legacyUrl.status,badToken:live.badToken.status},null,2));
 if(resolve.result.creator?.verified!==false || live.forgedResolve.result.creator?.verified!==false || live.legacyResolve.result.creator!==null || live.legacyUrl.status!==200 ||live.badToken.status!==404)throw Error('live checks failed');
} finally {
 for(const name of ['creator-t3a--static--web','creator-t3a-forged--static--web']) { try {cli(['rm',name,'--force']);}catch(error){console.error('cleanup failed:',error.message);} }
 daemon.kill('SIGTERM');
 const {stopEnvGroup}=await import(new URL('../../dist/commands.js',import.meta.url));
 const shared=JSON.parse(await readFile(path.join(root,'shared-static.json'),'utf8'));
 const {serveEntries,serveStatus,stopServe}=await import(new URL('../../dist/tailscale.js',import.meta.url));
 const entries=serveEntries(await serveStatus()).filter(entry=>entry.tailnetPort===shared.tailnetPort);
 assert.ok(entries.every(entry=>entry.target===`http://127.0.0.1:${shared.port}`));
 if(entries.length) assert.equal(await stopServe(shared.tailnetPort),true);
 assert.equal(serveEntries(await serveStatus()).some(entry=>entry.tailnetPort===shared.tailnetPort),false);
 await stopEnvGroup(shared);
 console.log('Cleanup: preview records removed; tailnet entry removed; isolated daemon and shared-static stopped.');
}
