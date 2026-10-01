import {loopbackUrl} from './loopback.mjs';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const url=loopbackUrl(process.env.TEST_URL);const user='pilot-test-'+Date.now();
const headers={'content-type':'application/json','oai-authenticated-user-id':user,'oai-authenticated-user-email':'synthetic@sites.test'};
async function rest(name,args={},h=headers){const r=await fetch(url+'/api/board',{method:'POST',headers:h,body:JSON.stringify({name,args})});return {status:r.status,data:await r.json()}}
async function mcp(method,params={},h=headers){const r=await fetch(url+'/mcp',{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return {status:r.status,data:await r.json()}}
assert.equal((await rest('list_tasks',{}, {'content-type':'application/json'})).status,401);
assert.equal((await mcp('tools/call',{name:'list_tasks',arguments:{}},{'content-type':'application/json'})).status,401);
let discovery=await mcp('tools/list',{}, {'content-type':'application/json'});assert.equal(discovery.status,200);assert.equal(discovery.data.result.tools.length,19);
assert.equal((await mcp('initialize')).data.result.serverInfo.name,'private-task-board');
assert.equal((await rest('list_tasks',{}, {...headers,origin:'https://evil.invalid'})).status,403);
assert.equal((await rest('seed_samples')).status,200);assert.equal((await rest('list_tasks')).data.tasks.length,3);
let tasks=JSON.parse((await mcp('tools/call',{name:'list_tasks',arguments:{}})).data.result.content[0].text).tasks;assert.equal(tasks.length,3);
const args={requestKey:'http-create-001',task:{title:'SAMPLE HTTP persistence probe',sample:true}};
let a=await rest('create_task',args);assert.equal(a.status,200);assert.equal((await rest('create_task',args)).data.task.id,a.data.task.id);let t=a.data.task;
const update={id:t.id,expectedRevision:t.revision,requestKey:'http-update-001',patch:{status:'InProgress'}};
let r=await mcp('tools/call',{name:'update_task',arguments:update});assert.equal(r.data.result.isError,false);let changed=JSON.parse(r.data.result.content[0].text).task;assert.equal(changed.status,'InProgress');assert.equal((await rest('get_task',{id:t.id})).data.task.revision,2);
assert.equal((await rest('update_task',{...update,requestKey:'http-stale-001'})).status,409);
assert.equal((await rest('get_task',{id:t.id},{...headers,'oai-authenticated-user-id':'different-user'})).status,404);
assert.equal((await rest('create_task',{requestKey:'http-bad-001',task:{title:'',owner:'not-me'}})).status,400);
let unauthed=await fetch(url+'/',{redirect:'manual'});assert.ok([302,303,307,308].includes(unauthed.status));assert.match(unauthed.headers.get('location'),/signin-with-chatgpt/);
let page=await fetch(url+'/',{headers});assert.equal(page.status,200);const html=await page.text();assert.match(html,/Task board/);assert.match(html,/New task/);assert.doesNotMatch(html,/Try the board with three/);
writeFileSync('.sites-runtime/persistence-probe.json',JSON.stringify({url,user,id:t.id}));
console.log('PASS: built Worker REST/MCP shared records; anonymous denial; discovery; foreign-origin denial; user isolation; create retry; revision conflict; validation; SSR sign-in gating. Persistence probe saved for process restart.');

const backupResult=await mcp('tools/call',{name:'export_backup_page',arguments:{pageSize:2}});assert.equal(backupResult.data.result.isError,false);const manifest=JSON.parse(backupResult.data.result.content[0].text);assert.equal(manifest.format,'task-board-backup-page');assert.equal(manifest.tasks.length,4);let allHistory=[],allSnapshots=[],cursor=manifest.nextCursor;while(cursor){const r=await mcp('tools/call',{name:'export_backup_page',arguments:{cursor,pageSize:2}});assert.equal(r.data.result.isError,false);const p=JSON.parse(r.data.result.content[0].text);assert.equal(p.backupId,manifest.backupId);allHistory.push(...p.history);allSnapshots.push(...p.snapshots);cursor=p.nextCursor;}assert.equal(allHistory.length,manifest.counts.history);assert.equal(allSnapshots.length,manifest.counts.snapshots);
const portable=(await rest('export_tasks')).data;const preview=await mcp('tools/call',{name:'preview_import',arguments:{data:portable}});assert.equal(preview.data.result.isError,false);assert.equal(JSON.parse(preview.data.result.content[0].text).summary.taskCount,4);
console.log('PASS: remote MCP backup pagination, complete counts, and import preview use authenticated shared service.');
