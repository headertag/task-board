import {loopbackUrl} from './loopback.mjs';
import {syntheticCredentials,credentialHeaders} from './synthetic-credentials.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const url=loopbackUrl(process.env.TEST_URL);const credentials=syntheticCredentials();
const headers=credentialHeaders(credentials),readHeaders=credentialHeaders(credentials,'read'),otherHeaders=credentialHeaders(credentials,'other');
async function rest(name,args={},h=headers){const r=await fetch(url+'/api/board',{method:'POST',headers:h,body:JSON.stringify({name,args})});return {status:r.status,data:await r.json()}}
async function mcp(method,params={},h=headers){const r=await fetch(url+'/mcp',{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return {status:r.status,data:await r.json()}}
assert.equal((await rest('list_tasks',{}, {'content-type':'application/json'})).status,401);
assert.equal((await mcp('tools/call',{name:'list_tasks',arguments:{}},{'content-type':'application/json'})).status,401);
let discovery=await mcp('tools/list',{}, {'content-type':'application/json'});assert.equal(discovery.status,401);
discovery=await mcp('tools/list');assert.equal(discovery.status,200);assert.equal(discovery.data.result.tools.length,19,'Primary credentials need an approved custom write scope');
const readDiscovery=await mcp('tools/list',{},readHeaders);assert.equal(readDiscovery.status,200);assert.equal(readDiscovery.data.result.tools.length,9);assert.ok(!readDiscovery.data.result.tools.some(tool=>tool.name==='create_task'));
assert.equal((await mcp('initialize')).data.result.serverInfo.name,'yet-another-task-board');
assert.equal((await rest('list_tasks',{}, {...headers,origin:'https://evil.invalid'})).status,403);
for(const custom of [headers,otherHeaders]){for(const archived of [false,true]){const initial=await rest('list_tasks',{archived},custom);assert.equal(initial.status,200);assert.equal(initial.data.tasks.length,0,'Use dedicated empty synthetic owners for this suite');}}
assert.equal((await rest('seed_samples')).status,200);assert.equal((await rest('list_tasks')).data.tasks.length,3);
let tasks=JSON.parse((await mcp('tools/call',{name:'list_tasks',arguments:{}})).data.result.content[0].text).tasks;assert.equal(tasks.length,3);
const args={requestKey:'http-create-001',task:{title:'SAMPLE HTTP persistence probe',sample:true}};
let a=await rest('create_task',args);assert.equal(a.status,200);assert.equal((await rest('create_task',args)).data.task.id,a.data.task.id);let t=a.data.task;
assert.equal((await rest('get_task',{id:t.id},readHeaders)).data.task.id,t.id,'Read and write clients must resolve to the same synthetic record IDs');
assert.equal((await rest('create_task',{requestKey:'http-readonly-denied',task:{title:'SAMPLE rejected read-only mutation',sample:true}},readHeaders)).status,403);
assert.equal((await mcp('tools/call',{name:'create_task',arguments:{requestKey:'mcp-readonly-denied',task:{title:'SAMPLE rejected read-only mutation',sample:true}}},readHeaders)).status,403);
const update={id:t.id,expectedRevision:t.revision,requestKey:'http-update-001',patch:{status:'InProgress'}};
let r=await mcp('tools/call',{name:'update_task',arguments:update});assert.equal(r.data.result.isError,false);let changed=JSON.parse(r.data.result.content[0].text).task;assert.equal(changed.status,'InProgress');assert.equal((await rest('get_task',{id:t.id})).data.task.revision,2);
assert.equal((await rest('update_task',{...update,requestKey:'http-stale-001'})).status,409);
assert.equal((await rest('get_task',{id:t.id},otherHeaders)).status,404);
assert.equal((await rest('create_task',{requestKey:'http-bad-001',task:{title:'',owner:'not-me'}})).status,400);
let unauthed=await fetch(url+'/',{redirect:'manual'});if(unauthed.status!==503){assert.ok([302,303,307,308].includes(unauthed.status));assert.match(unauthed.headers.get('location'),/\/auth\/signin/);}
mkdirSync('.sites-runtime',{recursive:true});writeFileSync('.sites-runtime/persistence-probe.json',JSON.stringify({version:2,synthetic:true,url,ownerId:credentials.ownerId,id:t.id}),{mode:0o600});
console.log('PASS: built Worker REST/MCP shared records; authenticated discovery; anonymous denial; read-only consent; foreign-origin denial; mapped-owner isolation; retries; revisions; validation; browser sign-in gating. Credential-free persistence probe saved for restart.');

const backupResult=await mcp('tools/call',{name:'export_backup_page',arguments:{pageSize:2}});assert.equal(backupResult.data.result.isError,false);const manifest=JSON.parse(backupResult.data.result.content[0].text);assert.equal(manifest.format,'task-board-backup-page');assert.equal(manifest.tasks.length,4);let allHistory=[],allSnapshots=[],cursor=manifest.nextCursor;while(cursor){const r=await mcp('tools/call',{name:'export_backup_page',arguments:{cursor,pageSize:2}});assert.equal(r.data.result.isError,false);const p=JSON.parse(r.data.result.content[0].text);assert.equal(p.backupId,manifest.backupId);allHistory.push(...p.history);allSnapshots.push(...p.snapshots);cursor=p.nextCursor;}assert.equal(allHistory.length,manifest.counts.history);assert.equal(allSnapshots.length,manifest.counts.snapshots);
const portable=(await rest('export_tasks')).data;const preview=await mcp('tools/call',{name:'preview_import',arguments:{data:portable}});assert.equal(preview.data.result.isError,false);assert.equal(JSON.parse(preview.data.result.content[0].text).summary.taskCount,4);
console.log('PASS: remote MCP backup pagination, complete counts, and import preview use authenticated shared service.');
