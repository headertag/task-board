import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { BoardService } from '../lib/service.ts';
import { nextOccurrence, samples } from '../lib/model.ts';
import { execute } from '../lib/operations.ts';
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
