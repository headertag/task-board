import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { BoardService } from '../lib/service.ts';
import { nextOccurrence, samples,validateTask,inputOf,taskSchema } from '../lib/model.ts';
import { execute,toolDefinitions } from '../lib/operations.ts';
import { hash,stable } from '../lib/safety.ts';
const sqlite=new DatabaseSync(':memory:');for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')))sqlite.exec(readFileSync('drizzle/'+f,'utf8'));
class Prepared{constructor(query,args=[]){this.query=query;this.args=args}bind(...args){return new Prepared(this.query,args)}async first(){return sqlite.prepare(this.query).get(...this.args)??null}async all(){return {results:sqlite.prepare(this.query).all(...this.args)}}}
const db={prepare:q=>new Prepared(q),batch:async statements=>{sqlite.exec('BEGIN');try{const r=statements.map(s=>/^SELECT/i.test(s.query)?{results:sqlite.prepare(s.query).all(...s.args)}:sqlite.prepare(s.query).run(...s.args));sqlite.exec('COMMIT');return r}catch(e){sqlite.exec('ROLLBACK');throw e}}};
const a=new BoardService(db,'alice'),b=new BoardService(db,'bob');
assert.throws(()=>new BoardService(db,''),/Sign in/);
await a.seed();await a.seed();assert.equal((await a.list()).length,3);assert.equal((await b.list()).length,0);
let t=(await a.list()).find(t=>t.recurrence);assert.equal(t.timezone,'Etc/UTC');
await assert.rejects(()=>b.get(t.id),e=>e.status===404);
await assert.rejects(()=>a.mutate('update',{requestKey:'stale-001',id:t.id,expectedRevision:99,patch:{title:'changed'}}),e=>e.code==='revision_conflict');
let done=await a.mutate('complete',{requestKey:'complete-001',id:t.id,expectedRevision:t.revision});assert.equal(done.dueDate,'2026-11-29');assert.equal(done.status,'ToDo');assert.deepEqual(done.recurrence,t.recurrence);assert.equal(done.timezone,'Etc/UTC');
assert.deepEqual(await a.mutate('complete',{requestKey:'complete-001',id:t.id,expectedRevision:t.revision}),done);
assert.equal((await a.history(t.id)).filter(h=>h.action==='complete').length,1);
for(const [from,want] of [['2027-01-29','2027-02-28'],['2027-02-28','2027-03-29'],['2028-01-29','2028-02-29'],['2026-02-28','2026-03-29'],['2026-10-29','2026-11-29']])assert.equal(nextOccurrence(from,{frequency:'monthly',interval:1,anchorDay:29}),want);
const args={requestKey:'create-repeat-001',task:{...samples[1],title:'Duplicate retry test'}};let c=await a.mutate('create',args);assert.deepEqual(await a.mutate('create',args),c);assert.equal((await a.list()).filter(t=>t.title==='Duplicate retry test').length,1);
await assert.rejects(()=>a.mutate('create',{...args,task:{...args.task,title:'Different'}}),e=>e.code==='idempotency_conflict');
const moves=['InProgress','OnHold','Canceled','Reference','ToDo'];for(const status of moves){c=await a.mutate('update',{requestKey:'move-'+status,id:c.id,expectedRevision:c.revision,patch:{status}});assert.equal(c.status,status)}
await assert.rejects(()=>execute(a,'update_task',{id:c.id,expectedRevision:c.revision,requestKey:'invalid-owner',patch:{owner:'bob'}}));
await assert.rejects(()=>a.mutate('create',{requestKey:'invalid-date',task:{...samples[0],dueDate:'2026-02-30'}}));
await assert.rejects(()=>a.mutate('create',{requestKey:'invalid-tz00',task:{...samples[0],timezone:'fake/time'}}));
await assert.rejects(()=>a.mutate('create',{requestKey:'invalid-recu',task:{...samples[0],timezone:null}}));
await assert.rejects(()=>a.mutate('create',{requestKey:'invalid-url0',task:{...samples[0],sourceUrl:'javascript:alert(1)'}}));
c=await a.mutate('archive',{requestKey:'archive-001',id:c.id,expectedRevision:c.revision});assert.equal(c.archived,true);assert.equal((await a.list(true)).length,1);assert.equal((await b.list(true)).length,0);
c=await a.mutate('restore',{requestKey:'restore-001',id:c.id,expectedRevision:c.revision});assert.equal(c.archived,false);
const exported=await a.export();assert.equal(exported.tasks.length,4);assert.ok(exported.history.length>=11);const p=await b.preview(exported);assert.equal(p.summary.taskCount,4);
await assert.rejects(()=>b.preview({...exported,version:999}),e=>e.code==='invalid_import');await assert.rejects(()=>b.preview({...exported,tasks:[{...exported.tasks[0],owner:'alice'}]}),e=>e.code==='invalid_import');
await assert.rejects(()=>b.import(exported,'wrong','import-test-01'),e=>e.code==='preview_changed');assert.equal((await b.list()).length,0);
let imp=await b.import(exported,p.digest,'import-test-01');assert.equal(imp.createdIds.length,4);assert.equal((await b.list()).length,4);await b.import(exported,p.digest,'import-test-01');assert.equal((await b.list()).length,4);assert.equal((await b.snapshots()).length,2);
await assert.rejects(()=>a.snapshot(imp.snapshotId),e=>e.code==='not_found');const pre=await b.snapshot(imp.snapshotId);assert.equal(pre.tasks.length,0);const source=await b.snapshot('source:import-test-01');assert.deepEqual(source,exported);
const empty={...exported,tasks:[],history:[]};const emptyPreview=await b.preview(empty);await assert.rejects(()=>b.import(empty,emptyPreview.digest,'import-test-01'),e=>e.code==='idempotency_conflict');
const aReload=new BoardService(db,'alice');assert.equal((await aReload.get(done.id)).dueDate,done.dueDate);
const q=sqlite.prepare('EXPLAIN QUERY PLAN SELECT payload FROM tasks WHERE owner=? AND archived=?').all('alice',0);assert.ok(q.some(x=>/idx_tasks_owner_archived_status/.test(x.detail)));
console.log('PASS: CRUD, all status moves, completion history, monthly day-29/DST-safe dates, idempotency, revision conflicts, validation, isolation, Trash, export/import preview, snapshots and recovery.');

const manifest=await b.backupPage(null,2);let pages=[manifest],cursor=manifest.nextCursor;
// A later write must not appear in this capture's bounded history.
await b.mutate('create',{requestKey:'after-backup-capture',task:{title:'Later synthetic task'}});
while(cursor){const page=await b.backupPage(cursor,2);assert.equal(page.backupId,manifest.backupId);pages.push(page);cursor=page.nextCursor;}
assert.equal(pages.at(-1).complete,true);assert.equal(manifest.tasks.length,manifest.counts.tasks);assert.equal(pages.flatMap(p=>p.history).length,manifest.counts.history);assert.equal(pages.flatMap(p=>p.snapshots).length,manifest.counts.snapshots);assert.ok(!pages.flatMap(p=>p.history).some(h=>h.requestKey==='after-backup-capture'));
await assert.rejects(()=>a.backupPage(manifest.nextCursor,2),e=>e.code==='invalid_cursor');
await assert.rejects(()=>b.backupPage('broken',2),e=>e.code==='invalid_cursor');
console.log('PASS: paginated backup has complete bounded history/snapshots, manifest counts, stable capture ID, and owner-bound cursor.');

let timed=await a.mutate('create',{requestKey:'timed-create-test',task:{title:'Generic monthly timing test',dueDate:'2026-09-29',dueTime:'10:00',timezone:'America/Toronto',recurrence:{frequency:'monthly',interval:1,anchorDay:29}}});
timed=await a.mutate('complete',{requestKey:'timed-complete-test',id:timed.id,expectedRevision:timed.revision});assert.equal(timed.dueTime,'10:00');assert.equal(timed.timezone,'America/Toronto');assert.equal(timed.dueDate,'2026-10-29');
await assert.rejects(()=>a.mutate('create',{requestKey:'invalid-time-test',task:{title:'Invalid time',dueDate:'2026-09-29',dueTime:'25:00',timezone:'UTC'}}));
await assert.rejects(()=>a.mutate('create',{requestKey:'time-without-zone',task:{title:'No zone',dueDate:'2026-09-29',dueTime:'10:00'}}));
console.log('PASS: local due time survives monthly completion and invalid/missing-zone times are rejected.');

const {safeError}=await import('../lib/operations.ts');
try{await execute(a,'create_task',{task:{title:'Unsafe link test',resources:[{kind:'link',label:'Unsafe',url:'javascript:alert(1)'}]},requestKey:'friendly-validation-test'});assert.fail('Expected unsafe URL rejection')}catch(error){const message=safeError(error).body.message;assert.match(message,/Link or place 1/);assert.ok(!message.includes('task.resources')&&!message.includes('patch.resources'));console.log('PASS validation errors use friendly field labels')}

// Fictional generic lists use the same atomic revision/history paths as task edits.
const lists=new BoardService(db,'checklist-owner'),copies=new BoardService(db,'checklist-copy-owner');
const milk={id:'aaaaaaaa-1111-4111-8111-111111111111',text:'  Milk  ',checked:false},movie={id:'bbbbbbbb-2222-4222-8222-222222222222',text:'A fictional movie',checked:true};
let list=(await execute(lists,'create_task',{requestKey:'checklist-create-001',task:{title:'Fictional shopping and movies',checklist:[milk,movie]}})).task;
assert.deepEqual(list.checklist,[{...milk,text:'Milk'},movie]);assert.deepEqual((await lists.get(list.id)).checklist,list.checklist);
assert.deepEqual((await lists.list())[0].checklist,list.checklist);await assert.rejects(()=>b.get(list.id),e=>e.code==='not_found');
const invalidLists=[null,{},[{...milk,text:'   '}],[{...milk,text:'x'.repeat(501)}],[{...milk,id:'not-a-uuid'}],[{...milk,checked:'true'}],[{id:milk.id,text:'Missing checked'}],[milk,{...movie,id:milk.id}],[milk,{...movie,id:milk.id.toUpperCase()}],[{...milk,extra:'unsupported'}],Array.from({length:101},(_,i)=>({id:crypto.randomUUID(),text:'Fictional '+i,checked:false}))];
for(let i=0;i<invalidLists.length;i++)await assert.rejects(()=>execute(lists,'update_task',{id:list.id,expectedRevision:1,requestKey:'checklist-invalid-'+i,patch:{checklist:invalidLists[i]}}));
assert.equal((await lists.get(list.id)).revision,1);assert.equal((await lists.history(list.id)).length,1);
try{await execute(lists,'update_task',{id:list.id,expectedRevision:1,requestKey:'checklist-friendly-error',patch:{checklist:[{...milk,text:' '}]}});assert.fail('Expected empty item refusal')}catch(error){assert.match(safeError(error).body.message,/Checklist item 1 · Item text/)}
const toggleArgs={id:list.id,expectedRevision:1,requestKey:'checklist-toggle-001',patch:{checklist:[movie,{...milk,text:'Milk',checked:true}]}};
list=(await execute(lists,'update_task',toggleArgs)).task;assert.equal(list.status,'ToDo');assert.equal(list.revision,2);assert.equal(list.checklist[0].id,movie.id);assert.equal(list.checklist[1].checked,true);
assert.deepEqual((await execute(lists,'update_task',toggleArgs)).task,list);
await assert.rejects(()=>execute(lists,'update_task',{...toggleArgs,patch:{checklist:[movie,{...milk,text:'Milk',checked:false}]}}),e=>e.code==='idempotency_conflict');
await assert.rejects(()=>execute(lists,'update_task',{...toggleArgs,requestKey:'checklist-stale-001'}),e=>e.code==='revision_conflict');
const race=await Promise.allSettled([false,true].map((checked,index)=>execute(lists,'update_task',{id:list.id,expectedRevision:2,requestKey:'checklist-race-'+index,patch:{checklist:list.checklist.map((item,i)=>i===0?{...item,checked}:item)}})));
assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.filter(r=>r.status==='rejected'&&r.reason.code==='revision_conflict').length,1);
list=race.find(r=>r.status==='fulfilled').value.task;const kept=list.checklist;
list=(await execute(lists,'update_task',{id:list.id,expectedRevision:list.revision,requestKey:'checklist-title-only',patch:{title:'Fictional watch list'}})).task;assert.deepEqual(list.checklist,kept);
const listExport=await lists.export(),preview=await copies.preview(listExport),copied=await copies.import(listExport,preview.digest,'checklist-import-001');
assert.deepEqual((await copies.get(copied.createdIds[0])).checklist,kept);await copies.import(listExport,preview.digest,'checklist-import-001');assert.equal((await copies.list()).length,1);
for(const action of ['complete','archive','restore']){list=await lists.mutate(action,{id:list.id,expectedRevision:list.revision,requestKey:'checklist-'+action});assert.deepEqual(list.checklist,kept)}
const beforeClear=list;list=(await execute(lists,'update_task',{id:list.id,expectedRevision:list.revision,requestKey:'checklist-clear-001',patch:{checklist:[]}})).task;assert.deepEqual(list.checklist,[]);
const clearHistory=(await lists.history(list.id)).find(event=>event.after.revision===list.revision);assert.deepEqual(clearHistory.before.checklist,beforeClear.checklist);assert.deepEqual(clearHistory.after.checklist,[]);
assert.equal(validateTask({title:'No list'}).checklist.length,0);
const largestList=Array.from({length:100},()=>({id:crypto.randomUUID(),text:'x'.repeat(500),checked:false}));assert.deepEqual(validateTask({title:'Fictional maximum list',checklist:largestList}).checklist,largestList);
for(const name of ['create_task','update_task']){const definition=toolDefinitions.find(t=>t.name===name),fields=definition.inputSchema.properties[name==='create_task'?'task':'patch'].properties;assert.equal(fields.checklist.maxItems,100);assert.deepEqual(fields.checklist.items.required,['id','text','checked']);assert.equal(fields.checklist.items.additionalProperties,false)}
console.log('PASS: checklists validate IDs/text/booleans/limits, preserve order and checked state, use atomic revisions/stable retries, stay owner-scoped, and survive completion/Trash/copy import.');

// Simulate a pre-feature normalized API create and its existing retry fingerprint.
const legacyService=new BoardService(db,'legacy-checklist-owner'),legacyKey='legacy-create-retry-001';
const {checklist:_empty,...legacyInput}=validateTask({title:'Legacy task without checklist'}),legacyTask={...legacyInput,id:crypto.randomUUID(),revision:1,createdAt:'2026-10-01T12:00:00.000Z',updatedAt:'2026-10-01T12:00:00.000Z',archived:false};
const legacyPayload=JSON.stringify(legacyTask),legacyArgs={task:legacyInput,requestKey:legacyKey};
sqlite.prepare('INSERT INTO tasks(owner,id,payload,status,archived,revision,updated_at,last_mutation) VALUES(?,?,?,?,?,?,?,?)').run('legacy-checklist-owner',legacyTask.id,legacyPayload,legacyTask.status,0,1,legacyTask.updatedAt,legacyKey);
sqlite.prepare('INSERT INTO task_events(owner,request_key,fingerprint,task_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run('legacy-checklist-owner',legacyKey,await hash(stable({action:'create',...legacyArgs})),legacyTask.id,'create',null,legacyPayload,legacyTask.createdAt);
assert.deepEqual(taskSchema.parse(legacyTask),legacyTask);assert.equal(Object.hasOwn(await legacyService.get(legacyTask.id),'checklist'),false);assert.deepEqual(inputOf(legacyTask).checklist,[]);
const legacyExport=await legacyService.export();assert.equal(Object.hasOwn(legacyExport.tasks[0],'checklist'),false);assert.equal(Object.hasOwn(legacyExport.history[0].after,'checklist'),false);
const legacyPreview=await copies.preview(legacyExport);assert.deepEqual(legacyPreview.parsed,legacyExport);assert.equal(legacyPreview.digest,await hash(stable(legacyExport)));
// A completed pre-feature portable copy keeps its snapshot digest and create replay.
const oldCopies=new BoardService(db,'legacy-import-owner'),oldImportKey='legacy-import-retry-001',oldCopy={...legacyTask,id:crypto.randomUUID()},oldCopyPayload=JSON.stringify(oldCopy),oldCopyArgs={task:legacyInput,requestKey:oldImportKey+':0'};
sqlite.prepare('INSERT INTO tasks(owner,id,payload,status,archived,revision,updated_at,last_mutation) VALUES(?,?,?,?,?,?,?,?)').run('legacy-import-owner',oldCopy.id,oldCopyPayload,oldCopy.status,0,1,oldCopy.updatedAt,oldCopyArgs.requestKey);
sqlite.prepare('INSERT INTO task_events(owner,request_key,fingerprint,task_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run('legacy-import-owner',oldCopyArgs.requestKey,await hash(stable({action:'create',...oldCopyArgs})),oldCopy.id,'create',null,oldCopyPayload,oldCopy.createdAt);
sqlite.prepare('INSERT INTO snapshots(owner,id,payload,created_at) VALUES(?,?,?,?)').run('legacy-import-owner','source:'+oldImportKey,JSON.stringify(legacyExport),legacyExport.exportedAt);
assert.deepEqual((await oldCopies.import(legacyExport,legacyPreview.digest,oldImportKey)).createdIds,[oldCopy.id]);assert.equal((await oldCopies.list()).length,1);assert.equal((await oldCopies.history(oldCopy.id)).length,1);
assert.equal(sqlite.prepare('SELECT payload FROM tasks WHERE owner=? AND id=?').get('legacy-import-owner',oldCopy.id).payload,oldCopyPayload);assert.deepEqual(await oldCopies.snapshot('source:'+oldImportKey),legacyExport);
for(const task of [{title:legacyTask.title},{title:legacyTask.title,checklist:[]}])assert.deepEqual((await execute(legacyService,'create_task',{task,requestKey:legacyKey})).task,legacyTask);
assert.equal(sqlite.prepare('SELECT payload FROM tasks WHERE owner=? AND id=?').get('legacy-checklist-owner',legacyTask.id).payload,legacyPayload);
await assert.rejects(()=>execute(legacyService,'create_task',{requestKey:legacyKey,task:{title:legacyTask.title,checklist:[{...milk,text:'Milk'}]}}),e=>e.code==='idempotency_conflict');
const changedLegacy=(await execute(legacyService,'update_task',{id:legacyTask.id,expectedRevision:1,requestKey:'legacy-list-first-edit',patch:{checklist:[{...milk,text:'Milk'}]}})).task;
assert.equal(changedLegacy.revision,2);const legacyHistory=await legacyService.history(legacyTask.id);assert.equal(Object.hasOwn(legacyHistory.find(e=>e.after.revision===2).before,'checklist'),false);assert.deepEqual(changedLegacy.checklist,[{...milk,text:'Milk'}]);
console.log('PASS: legacy JSON/history/export/preview remain unchanged on reads, old normalized create retries replay, and explicit checklist edits retain the original history snapshot.');

const verbose=await a.mutate('create',{requestKey:'compact-list-fixture',task:{title:'Compact summary fixture',nextAction:'N'.repeat(2000),blocker:'B'.repeat(2000),evidenceNote:'E'.repeat(6000),checklist:[{id:crypto.randomUUID(),text:'Only in details',checked:false}]}});
const summaries=await execute(a,'list_tasks',{}),summary=summaries.tasks.find(t=>t.id===verbose.id);
assert.equal(summary.title,verbose.title);assert.equal(summary.revision,verbose.revision);
for(const field of ['nextAction','blocker','evidenceNote','resources','checklist','sourceUrl','sourceChatId'])assert.equal(Object.hasOwn(summary,field),false);
assert.ok(JSON.stringify(summary).length<JSON.stringify(verbose).length/10);
assert.deepEqual((await execute(a,'get_task',{id:verbose.id})).task,verbose);
const trashed=await a.mutate('archive',{id:verbose.id,expectedRevision:verbose.revision,requestKey:'compact-list-archive'});
assert.equal((await execute(a,'list_tasks',{})).tasks.some(t=>t.id===verbose.id),false);
const trashSummary=(await execute(a,'list_tasks',{archived:true})).tasks.find(t=>t.id===verbose.id);
assert.equal(trashSummary.archived,true);assert.equal(trashSummary.revision,trashed.revision);assert.equal(Object.hasOwn(trashSummary,'evidenceNote'),false);
assert.equal((await execute(b,'list_tasks',{})).tasks.some(t=>t.id===verbose.id),false);
console.log('PASS compact lists omit narrative data, preserve revisions/Trash/isolation, and full details remain available');
